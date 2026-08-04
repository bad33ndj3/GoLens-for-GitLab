import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { FakeIndexedDB } from './benchmarks/fake-indexeddb.mjs';

// go-semantic-worker.js wires up `self.addEventListener`/`chrome.runtime`
// listeners as an import side effect, so — like tests/go-semantic-worker.test.js
// — `self` must exist before the module is ever evaluated. A dynamic import
// inside `before()` guarantees that ordering; a static import would run the
// module before this file's `before()` hook could set `globalThis.self`.
let GoSemanticIndexStore;

before(async () => {
  globalThis.self ??= { addEventListener() {}, postMessage() {} };
  ({ GoSemanticIndexStore } = await import('../worker/dispatch.js?index-store-test'));
});

// Every behavioural test below runs once against the in-memory `Map`
// fallback and once against the fake IndexedDB storage double, so the real
// storage code path is covered, not only the in-memory fallback — mirroring
// tests/go-semantic-cache.test.js's TRANSPORTS pattern for GoSemanticSourceCache.
const TRANSPORTS = [
  { name: 'in-memory', indexedDB: undefined },
  { name: 'IndexedDB (fake)', indexedDB: () => new FakeIndexedDB() },
];

function newStore(transport) {
  return new GoSemanticIndexStore({ indexedDB: transport.indexedDB ? transport.indexedDB() : undefined });
}

for (const transport of TRANSPORTS) {
  test(`GoSemanticIndexStore reads back a written blob (${transport.name})`, async () => {
    const store = newStore(transport);
    const scope = { origin: 'https://gitlab.example', project: 'group/project', ref: 'a'.repeat(40) };
    assert.equal(await store.read(scope), null);

    const blob = { version: 1, packages: [{ packagePath: 'sample' }] };
    await store.write(scope, blob);
    assert.deepEqual(await store.read(scope), blob);
  });

  test(`GoSemanticIndexStore keeps package-scoped and whole-project blobs separate (${transport.name})`, async () => {
    const store = newStore(transport);
    const projectScope = { origin: 'https://gitlab.example', project: 'group/project', ref: 'b'.repeat(40) };
    const packageScope = { ...projectScope, packagePath: 'sample' };

    await store.write(projectScope, { version: 1, packages: ['project-blob'] });
    await store.write(packageScope, { version: 1, packages: ['package-blob'] });

    assert.deepEqual(await store.read(projectScope), { version: 1, packages: ['project-blob'] });
    assert.deepEqual(await store.read(packageScope), { version: 1, packages: ['package-blob'] });
  });

  test(`GoSemanticIndexStore clear removes every stored blob (${transport.name})`, async () => {
    const store = newStore(transport);
    const scope = { origin: 'https://gitlab.example', project: 'group/project', ref: 'c'.repeat(40) };
    await store.write(scope, { version: 1, packages: ['blob'] });
    assert.notEqual(await store.read(scope), null);

    await store.clear();
    assert.equal(await store.read(scope), null);
  });
}
