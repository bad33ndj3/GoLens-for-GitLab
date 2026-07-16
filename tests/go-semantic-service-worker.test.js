import assert from 'node:assert/strict';
import { before, test } from 'node:test';

let connectListener;
let messageListener;
let resolveResponse;

before(async () => {
  globalThis.chrome = {
    runtime: {
      onConnect: {
        addListener(listener) { connectListener = listener; },
      },
    },
  };
  await import('../go-semantic-worker.js?service-worker-test');
  connectListener({
    name: 'golens-go-rpc',
    onMessage: { addListener(listener) { messageListener = listener; } },
    postMessage(message) { resolveResponse?.(message); },
  });
});

function request(method, params) {
  const response = new Promise((resolve) => { resolveResponse = resolve; });
  messageListener({ id: 1, method, params });
  return response;
}

test('Manifest V3 port keeps semantic initialization and response in one channel', async () => {
  const source = 'package sample\nfunc Target() {}\nfunc Use() { Target() }\n';
  const indexed = await request('indexPackage', {
    project: 'group/project',
    ref: 'feedface',
    packagePath: 'sample',
    modulePath: 'example.com/project',
    files: [{ path: 'sample/sample.go', source }],
  });
  assert.equal(indexed.ok, true);
  assert.equal(indexed.result.status, 'indexed');

  const resolved = await request('resolveHover', {
    project: 'group/project',
    ref: 'feedface',
    packagePath: 'sample',
    path: 'sample/sample.go',
    line: 3,
    character: 13,
    identifier: 'Target',
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.result.definition.name, 'Target');
});
