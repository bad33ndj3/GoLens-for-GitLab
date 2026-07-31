import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Language, Parser } from 'web-tree-sitter';

import { commitSha, repositoryKey, repositoryPath, sourceIdentity } from '../../src/domain.ts';
import { GoIntelligenceCache } from '../../src/go-intelligence/cache.ts';
import { createGoIntelligence } from '../../src/go-intelligence/client.ts';
import { parseWorkerRequest, validWorkerValue } from '../../src/go-intelligence/protocol.ts';
import { createGoIntelligenceWorkerRuntime } from '../../src/go-intelligence/worker-runtime.ts';

const identity = sourceIdentity({ repositoryKey: repositoryKey('gitlab.example/group/project'), commitSha: commitSha('a'.repeat(40)) });
const value = 'package sample\nfunc Target() {}\n';
const sourceFile = {
  path: repositoryPath('sample/main.go'), source: value,
  contentId: createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex'),
};
const coverage = { scope: 'current-package', complete: true, packageCount: 1, packagePaths: ['sample'] };
const manifest = { source: identity, modulePath: 'example.com/project', coverage, files: [{ path: sourceFile.path, contentId: sourceFile.contentId }] };

function request(command, source = identity) {
  return { protocol: 1, clientId: 'client', requestId: crypto.randomUUID(), operationId: crypto.randomUUID(), source, command };
}

async function parser() {
  await Parser.init();
  const result = new Parser();
  result.setLanguage(await Language.load(new URL('../../vendor/tree-sitter-go.wasm', import.meta.url).pathname));
  return result;
}

test('private protocol rejects malformed and unknown commands', () => {
  assert.equal(parseWorkerRequest({ protocol: 2, clientId: 'x', requestId: 'x', operationId: 'x', command: { name: 'query' } }), null);
  assert.equal(parseWorkerRequest({ protocol: 1, clientId: 'x', requestId: 'x', operationId: 'x', command: { name: 'rename-symbol' } }), null);
  assert.equal(validWorkerValue('query', { status: 'resolved', snapshot: 'fake', coverage: {} }), false);
});

test('same-source mutations serialize and clear waits as a barrier', async () => {
  const releases = [];
  const events = [];
  class SlowCache extends GoIntelligenceCache {
    async stage(source, files) {
      events.push('stage:start');
      await new Promise((resolve) => releases.push(resolve));
      await super.stage(source, files);
      events.push('stage:end');
    }
    async clear() {
      events.push('clear');
      return super.clear();
    }
  }
  const runtime = createGoIntelligenceWorkerRuntime({ cache: new SlowCache(undefined), createParser: parser });
  const signal = new AbortController().signal;
  const first = runtime.execute(request({ name: 'store-sources', files: [sourceFile] }), signal);
  const second = runtime.execute(request({ name: 'store-sources', files: [sourceFile] }), signal);
  const clear = runtime.execute(request({ name: 'clear-cache', request: { scope: 'global' } }, undefined), signal);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['stage:start']);
  releases.shift()();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ['stage:start', 'stage:end', 'stage:start']);
  releases.shift()();
  await Promise.all([second, clear]);
  assert.deepEqual(events, ['stage:start', 'stage:end', 'stage:start', 'stage:end', 'clear']);
});

test('cancellation prevents pre-commit publication but does not roll back a crossed commit point', async () => {
  let releasePublish;
  let publishing;
  class PausedCache extends GoIntelligenceCache {
    async publish(value) {
      publishing?.();
      await new Promise((resolve) => { releasePublish = resolve; });
      return super.publish(value);
    }
  }
  const cache = new PausedCache(undefined);
  await cache.stage(identity, [sourceFile]);
  const runtime = createGoIntelligenceWorkerRuntime({ cache, createParser: parser });

  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(runtime.execute(request({ name: 'publish-coverage', manifest }), cancelled.signal), { name: 'AbortError' });
  assert.equal(await cache.restore(identity), null);

  const reachedCommit = new Promise((resolve) => { publishing = resolve; });
  const late = new AbortController();
  const publication = runtime.execute(request({ name: 'publish-coverage', manifest }), late.signal);
  await reachedCommit;
  late.abort();
  releasePublish();
  assert.equal((await publication).status, 'ready');
  assert.ok(await cache.restore(identity));
});

test('cancellation during hashing prevents the staged source mutation', async () => {
  let entered;
  let release;
  class PausedStageCache extends GoIntelligenceCache {
    async stage(source, files, signal) {
      entered?.();
      await new Promise((resolve) => { release = resolve; });
      return super.stage(source, files, signal);
    }
  }
  const cache = new PausedStageCache(undefined);
  const runtime = createGoIntelligenceWorkerRuntime({ cache, createParser: parser });
  const started = new Promise((resolve) => { entered = resolve; });
  const controller = new AbortController();
  const staging = runtime.execute(request({ name: 'store-sources', files: [sourceFile] }), controller.signal);
  await started;
  controller.abort();
  release();
  await assert.rejects(staging, { name: 'AbortError' });
  assert.equal((await cache.inspect()).sourceBlobs, 0);
});

test('rejects mismatched Source identities and revisions bind paths and Coverage', async () => {
  const cache = new GoIntelligenceCache(undefined);
  const runtime = createGoIntelligenceWorkerRuntime({ cache, createParser: parser });
  const signal = new AbortController().signal;
  await runtime.execute(request({ name: 'store-sources', files: [sourceFile] }), signal);
  const other = sourceIdentity({ repositoryKey: identity.repositoryKey, commitSha: commitSha('b'.repeat(40)) });
  await assert.rejects(runtime.execute(request({ name: 'publish-coverage', manifest: { ...manifest, source: other } }), signal), /does not match/);

  const first = await runtime.execute(request({ name: 'publish-coverage', manifest }), signal);
  const renamed = {
    ...manifest,
    coverage: { ...coverage, packagePaths: ['renamed'] },
    files: [{ path: repositoryPath('renamed/main.go'), contentId: sourceFile.contentId }],
  };
  const second = await runtime.execute(request({ name: 'publish-coverage', manifest: renamed }), signal);
  assert.notEqual(second.snapshot, first.snapshot);
});

test('published Coverage restores an immutable snapshot after memory disposal', async () => {
  const cache = new GoIntelligenceCache(undefined);
  const runtime = createGoIntelligenceWorkerRuntime({ cache, createParser: parser });
  const signal = new AbortController().signal;
  await runtime.execute(request({ name: 'store-sources', files: [sourceFile] }), signal);
  await runtime.execute(request({ name: 'publish-coverage', manifest }), signal);
  await runtime.execute(request({ name: 'dispose-memory' }), signal);
  const result = await runtime.execute(request({
    name: 'query', query: { operation: 'resolve-symbol', path: sourceFile.path, line: 2, column: 6, identifier: 'Target' },
  }), signal);
  assert.equal(result.status, 'resolved');
});

test('client reconnects once after a worker restart and rejects stale generations', async () => {
  let connections = 0;
  function channel() {
    const listeners = new Set();
    return { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener), emit: (value) => {
      for (const listener of listeners) listener(value);
    } };
  }
  const runtime = {
    connect() {
      connections++;
      const onMessage = channel();
      const onDisconnect = channel();
      return {
        onMessage, onDisconnect,
        postMessage(message) {
          if (connections === 1) return queueMicrotask(() => onDisconnect.emit());
          queueMicrotask(() => onMessage.emit({
            protocol: 1, clientId: message.clientId, requestId: message.requestId, ok: true,
            value: {
              status: 'unavailable', source: identity, snapshot: 'restored', coverage: {
                scope: 'indexed-packages', complete: false, packageCount: 0, packagePaths: [],
              }, reason: 'fixture',
            },
          }));
        },
      };
    },
  };
  const intelligence = createGoIntelligence({ source: identity, reader: {}, runtime });
  const result = await intelligence.query({
    operation: 'resolve-symbol', path: sourceFile.path, line: 2, column: 6, identifier: 'Target',
  }, new AbortController().signal);
  assert.equal(connections, 2);
  assert.deepEqual({ status: result.status, reason: result.reason }, { status: 'unavailable', reason: 'fixture' });
});

test('client rejects a malformed worker response instead of hanging', async () => {
  function channel() {
    const listeners = new Set();
    return { addListener: (listener) => listeners.add(listener), removeListener: (listener) => listeners.delete(listener), emit: (value) => {
      for (const listener of listeners) listener(value);
    } };
  }
  const runtime = {
    connect() {
      const onMessage = channel();
      return {
        onMessage, onDisconnect: channel(),
        postMessage(message) {
          queueMicrotask(() => onMessage.emit({ protocol: 1, clientId: message.clientId, requestId: message.requestId, ok: true }));
        },
      };
    },
  };
  const intelligence = createGoIntelligence({ source: identity, reader: {}, runtime });
  await assert.rejects(intelligence.query({
    operation: 'resolve-symbol', path: sourceFile.path, line: 2, column: 6, identifier: 'Target',
  }, new AbortController().signal), /Malformed worker response/);
});
