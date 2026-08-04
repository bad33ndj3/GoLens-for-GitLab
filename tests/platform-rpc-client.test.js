import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRpcClient, RpcUnavailableError, methodNamespace } from '../page/platform/rpc-client.js';

// A minimal fake of a chrome.runtime.Port: records postMessage calls and lets
// the test drive onMessage/onDisconnect deterministically.
function createFakePort() {
  const messageListeners = [];
  const disconnectListeners = [];
  const posted = [];
  let disconnected = false;
  return {
    postMessage: (message) => posted.push(message),
    onMessage: { addListener: (fn) => messageListeners.push(fn) },
    onDisconnect: { addListener: (fn) => disconnectListeners.push(fn) },
    disconnect: () => { disconnected = true; },
    // test hooks, not part of the real chrome.runtime.Port shape
    __posted: posted,
    __respond: (response) => messageListeners.forEach((fn) => fn(response)),
    __fireDisconnect: () => disconnectListeners.forEach((fn) => fn()),
    get __disconnected() { return disconnected; },
  };
}

function withFakeTimeout(run) {
  const real = globalThis.setTimeout;
  const realClear = globalThis.clearTimeout;
  const scheduled = new Map();
  let nextId = 1;
  globalThis.setTimeout = (fn, ms) => {
    const id = nextId++;
    scheduled.set(id, { fn, ms });
    return id;
  };
  globalThis.clearTimeout = (id) => { scheduled.delete(id); };
  try {
    return run({
      fire: (id) => { const entry = scheduled.get(id); scheduled.delete(id); entry.fn(); },
      fireAll: () => { for (const [id, entry] of [...scheduled]) { scheduled.delete(id); entry.fn(); } },
      msFor: (id) => scheduled.get(id)?.ms,
      ids: () => [...scheduled.keys()],
    });
  } finally {
    globalThis.setTimeout = real;
    globalThis.clearTimeout = realClear;
  }
}

test('methodNamespace maps all 20 wire methods to their namespace, 1:1 with the wire contract', () => {
  const query = ['resolveDefinition', 'resolveHover', 'findReferences', 'findImplementations', 'packageRelations'];
  const cache = ['cacheStats', 'projectCacheStatus', 'mergeRequestCacheStatus', 'packageCacheStatus', 'prepareSources', 'clearCache', 'cachePackage', 'cacheProject', 'cacheMergeRequest', 'restorePackage', 'restoreProject', 'restoreMergeRequest'];
  const index = ['indexPackage', 'indexProject', 'disposeProject'];
  assert.equal(query.length + cache.length + index.length, 20);
  for (const method of query) assert.equal(methodNamespace(method), 'query');
  for (const method of cache) assert.equal(methodNamespace(method), 'cache');
  for (const method of index) assert.equal(methodNamespace(method), 'index');
});

test('every namespace method is reachable and frames {id, method, params} on the wire, unchanged', () => {
  const port = createFakePort();
  const client = createRpcClient({ connect: () => port });

  const pending = client.query.resolveDefinition({ file: 'a.go', line: 3 });
  assert.equal(port.__posted.length, 1);
  const [{ id, method, params }] = port.__posted;
  assert.equal(method, 'resolveDefinition');
  assert.deepEqual(params, { file: 'a.go', line: 3 });
  port.__respond({ id, ok: true, result: { kind: 'found' } });
  return pending.then((result) => assert.deepEqual(result, { kind: 'found' }));
});

test('connect() is only invoked lazily, on first call', async () => {
  let connectCalls = 0;
  const port = createFakePort();
  const client = createRpcClient({ connect: () => { connectCalls += 1; return port; } });
  assert.equal(connectCalls, 0);
  const first = client.cache.cacheStats({});
  assert.equal(connectCalls, 1);
  const second = client.cache.projectCacheStatus({});
  assert.equal(connectCalls, 1, 'reuses the same port for subsequent calls');
  for (const { id } of port.__posted) port.__respond({ id, ok: true, result: {} });
  await Promise.all([first, second]);
});

test('a domain kind-result resolves the call; ok:false rejects with RpcUnavailableError, preserving the worker message', async () => {
  const port = createFakePort();
  const client = createRpcClient({ connect: () => port });

  const ambiguous = client.query.resolveHover({});
  const [{ id: okId }] = port.__posted;
  port.__respond({ id: okId, ok: true, result: { kind: 'ambiguous', candidates: [] } });
  assert.deepEqual(await ambiguous, { kind: 'ambiguous', candidates: [] });

  const failing = client.index.indexPackage({});
  const [, { id: failId }] = port.__posted;
  port.__respond({ id: failId, ok: false, error: 'boom' });
  await assert.rejects(failing, (error) => {
    assert.ok(error instanceof RpcUnavailableError);
    assert.equal(error.message, 'boom');
    return true;
  });
});

test('ok:false without an error message falls back to the historic "Go semantic service failed" text', async () => {
  const port = createFakePort();
  const client = createRpcClient({ connect: () => port });
  const call = client.cache.clearCache({});
  const [{ id }] = port.__posted;
  port.__respond({ id, ok: false });
  await assert.rejects(call, { message: 'Go semantic service failed' });
});

test('uses the long timeout only for the historic method set, short timeout otherwise', async () => {
  await withFakeTimeout(async ({ fireAll, ids, msFor }) => {
    const port = createFakePort();
    const client = createRpcClient({ connect: () => port });

    const shortCall = client.query.resolveHover({}); // short-timeout method
    const longCall = client.cache.restoreProject({}); // long-timeout method

    const [shortId, longId] = ids();
    assert.equal(msFor(shortId), 20000);
    assert.equal(msFor(longId), 120000);

    fireAll();
    await assert.rejects(shortCall);
    await assert.rejects(longCall);
  });
});

test('timing out rejects with RpcUnavailableError and the historic message', async () => {
  await withFakeTimeout(async ({ fire, ids }) => {
    const port = createFakePort();
    const client = createRpcClient({ connect: () => port });
    const call = client.query.resolveHover({});
    const [id] = ids();
    fire(id);
    await assert.rejects(call, (error) => {
      assert.ok(error instanceof RpcUnavailableError);
      assert.equal(error.message, 'Go semantic service timed out');
      return true;
    });
  });
});

test('port disconnect rejects all in-flight calls with RpcUnavailableError, then allows lazy reconnect', async () => {
  let connectCalls = 0;
  const ports = [createFakePort(), createFakePort()];
  const client = createRpcClient({ connect: () => ports[connectCalls++] });

  const call = client.query.resolveDefinition({});
  ports[0].__fireDisconnect();
  await assert.rejects(call, (error) => {
    assert.ok(error instanceof RpcUnavailableError);
    assert.equal(error.message, 'Go semantic service disconnected');
    return true;
  });

  // Lazy reconnect: the next call establishes a fresh port.
  const secondCall = client.query.resolveDefinition({});
  assert.equal(connectCalls, 2);
  const [{ id }] = ports[1].__posted;
  ports[1].__respond({ id, ok: true, result: { kind: 'found' } });
  await secondCall;
});

test('onDisconnect fires once per disconnect, after in-flight calls are rejected, and never fires from dispose()', async () => {
  let disconnectCalls = 0;
  const port = createFakePort();
  const client = createRpcClient({ connect: () => port, onDisconnect: () => { disconnectCalls += 1; } });

  const call = client.query.resolveDefinition({});
  port.__fireDisconnect();
  await assert.rejects(call);
  assert.equal(disconnectCalls, 1);

  const port2 = createFakePort();
  const client2 = createRpcClient({ connect: () => port2, onDisconnect: () => { disconnectCalls += 1; } });
  const call2 = client2.query.resolveDefinition({});
  client2.dispose();
  await assert.rejects(call2);
  assert.equal(disconnectCalls, 1, 'dispose() must not trigger onDisconnect');
});

test('dispose() rejects in-flight calls (optionally with a caller-supplied reason) and disconnects the port', async () => {
  const port = createFakePort();
  const client = createRpcClient({ connect: () => port });
  const call = client.query.resolveDefinition({});
  client.dispose({ reason: 'Go intelligence request cancelled' });
  await assert.rejects(call, { message: 'Go intelligence request cancelled' });
  assert.ok(port.__disconnected);
});

test('dispose() without a reason uses the generic disconnected message', async () => {
  const port = createFakePort();
  const client = createRpcClient({ connect: () => port });
  const call = client.query.resolveDefinition({});
  client.dispose();
  await assert.rejects(call, { message: 'Go semantic service disconnected' });
});

test('rpc ids stay monotonic and unique across a reconnect (no collision with a late response)', async () => {
  let connectCalls = 0;
  const ports = [createFakePort(), createFakePort()];
  const client = createRpcClient({ connect: () => ports[connectCalls++] });

  const firstCall = client.query.resolveDefinition({});
  const firstId = ports[0].__posted[0].id;
  ports[0].__fireDisconnect();
  await assert.rejects(firstCall);

  const secondCall = client.query.resolveDefinition({});
  const secondId = ports[1].__posted[0].id;
  assert.notEqual(firstId, secondId);
  assert.ok(secondId > firstId);
  ports[1].__respond({ id: secondId, ok: true, result: {} });
  await secondCall;
});
