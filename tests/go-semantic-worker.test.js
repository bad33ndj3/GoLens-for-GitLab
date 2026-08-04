import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, test } from 'node:test';

let handler;
let routeMethod;
let nextID = 0;
const pending = new Map();

function sourceFile(path, source) {
  const blobId = createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
  return { path, blobId, source };
}

before(async () => {
  globalThis.self = {
    addEventListener(type, listener) {
      if (type === 'message') handler = listener;
    },
    postMessage(message) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    },
  };
  ({ routeMethod } = await import('../worker/dispatch.js?worker-test'));
});

function request(method, params) {
  const id = ++nextID;
  const response = new Promise((resolve) => pending.set(id, resolve));
  handler({ data: { id, method, params } });
  return response;
}

// routeMethod is the pure routing core `dispatch` uses to decide mutation
// queue sequencing: no I/O, no worker/index/cache instances involved, so
// these run against the plain function with no fixture setup at all.
test('routeMethod classifies storage-only status reads as non-queued queries', () => {
  for (const method of ['projectCacheStatus', 'mergeRequestCacheStatus', 'packageCacheStatus']) {
    assert.deepEqual(routeMethod(method), { kind: 'query', queued: false });
  }
});

test('routeMethod classifies cache/index-mutating methods as queued mutations', () => {
  for (const method of [
    'clearCache', 'cachePackage', 'cacheProject', 'cacheMergeRequest', 'indexPackage', 'indexProject',
    'restorePackage', 'restoreProject', 'restoreMergeRequest', 'disposeProject', 'prepareSources',
  ]) {
    assert.deepEqual(routeMethod(method), { kind: 'mutation', queued: true });
  }
});

test('routeMethod classifies resolution/search queries and unknown or missing methods as queued, non-extending', () => {
  for (const method of ['resolveDefinition', 'resolveHover', 'findReferences', 'findImplementations', 'packageRelations', 'cacheStats']) {
    assert.deepEqual(routeMethod(method), { kind: 'query', queued: true });
  }
  assert.deepEqual(routeMethod('renameSymbol'), { kind: 'query', queued: true });
  assert.deepEqual(routeMethod(undefined), { kind: 'query', queued: true });
});

test('worker protocol indexes and resolves a definition', async () => {
  const source = 'package sample\nfunc Target() {}\nfunc Use() { Target() }\n';
  const indexed = await request('indexPackage', {
    project: 'group/project',
    ref: 'deadbeef',
    packagePath: 'sample',
    modulePath: 'example.com/project',
    files: [{ path: 'sample/sample.go', source }],
  });
  assert.equal(indexed.ok, true);
  assert.equal(indexed.result.status, 'indexed');

  const resolved = await request('resolveDefinition', {
    project: 'group/project',
    ref: 'deadbeef',
    packagePath: 'sample',
    path: 'sample/sample.go',
    line: 3,
    character: 13,
    identifier: 'Target',
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.result.status, 'resolved');
  assert.equal(resolved.result.definition.line, 2);
  assert.deepEqual(resolved.result.scope, {
    kind: 'currentPackage', packagePath: 'sample', packageCount: 1, complete: true,
  });
});

test('worker protocol indexes a project and finds interface implementations', async () => {
  const interfaceSource = 'package contracts\ntype Runner interface { Run() error }\n';
  const implementationSource = 'package service\ntype Service struct{}\nfunc (*Service) Run() error { return nil }\n';
  const indexed = await request('indexProject', {
    project: 'group/project',
    ref: 'projectref',
    modulePath: 'example.com/project',
    files: [
      { path: 'contracts/runner.go', source: interfaceSource },
      { path: 'service/service.go', source: implementationSource },
    ],
  });
  assert.equal(indexed.ok, true);
  assert.equal(indexed.result.status, 'projectIndexed');

  const resolved = await request('resolveDefinition', {
    project: 'group/project',
    ref: 'projectref',
    packagePath: 'contracts',
    path: 'contracts/runner.go',
    line: 2,
    character: 5,
    identifier: 'Runner',
  });
  const implementations = await request('findImplementations', {
    project: 'group/project',
    ref: 'projectref',
    interfaceDefinition: resolved.result.definition,
  });
  assert.equal(implementations.ok, true);
  assert.deepEqual(implementations.result.candidates.map((candidate) => candidate.displayName), ['*service.Service']);
  assert.deepEqual(implementations.result.scope, {
    kind: 'fullProject', packageCount: 2, complete: true, searchStatus: 'complete',
  });
  const searched = await request('findImplementations', {
    project: 'group/project',
    ref: 'projectref',
    interfaceDefinition: resolved.result.definition,
    scope: { kind: 'completeProjectSearch', complete: true, searchStatus: 'complete', strategy: 'gitlabCodeSearch' },
  });
  assert.deepEqual(searched.result.scope, {
    kind: 'completeProjectSearch', packagePath: '', packageCount: 2, complete: true,
    searchStatus: 'complete', strategy: 'gitlabCodeSearch',
  });
});

test('worker protocol reports unknown methods without crashing', async () => {
  const response = await request('renameSymbol', {});
  assert.equal(response.ok, false);
  assert.match(response.error, /Unknown semantic worker method/);
});

test('worker restores a commit-pinned package after its memory index is disposed', async () => {
  const ref = 'd'.repeat(40);
  const file = sourceFile('sample/sample.go', 'package sample\nfunc Target() {}\nfunc Use() { Target() }\n');
  const params = {
    origin: 'https://gitlab.example',
    project: 'group/project',
    ref,
    packagePath: 'sample',
    modulePath: 'example.com/project',
    files: [file],
  };
  const cached = await request('cachePackage', params);
  assert.equal(cached.ok, true);
  await request('disposeProject', { origin: params.origin, project: params.project, ref });

  const restored = await request('restorePackage', params);
  assert.equal(restored.ok, true);
  assert.equal(restored.result.status, 'cacheHit');

  const resolved = await request('resolveDefinition', {
    origin: params.origin,
    project: params.project,
    ref,
    packagePath: params.packagePath,
    path: 'sample/sample.go',
    line: 3,
    character: 13,
    identifier: 'Target',
  });
  assert.equal(resolved.result.status, 'resolved');
});

test('worker reports package cache status from the in-memory index without a storage round trip', async () => {
  const ref = 'f'.repeat(40);
  const file = sourceFile('sample/sample.go', 'package sample\nfunc Target() {}\n');
  const params = {
    origin: 'https://gitlab.example',
    project: 'group/project',
    ref,
    packagePath: 'sample',
    modulePath: 'example.com/project',
    files: [file],
  };
  await request('cachePackage', params);

  const warm = await request('packageCacheStatus', params);
  assert.equal(warm.ok, true);
  assert.equal(warm.result.status, 'complete');

  await request('disposeProject', { origin: params.origin, project: params.project, ref });

  const cold = await request('packageCacheStatus', params);
  assert.equal(cold.ok, true);
  assert.equal(cold.result.status, 'complete');
});

test('worker reports and clears durable cache contents', async () => {
  const ref = 'e'.repeat(40);
  const file = sourceFile('sample/sample.go', 'package sample\nfunc Target() {}\n');
  await request('cachePackage', {
    origin: 'https://gitlab.example',
    project: 'group/project',
    ref,
    packagePath: 'sample',
    files: [file],
  });
  const stats = await request('cacheStats', {});
  assert.equal(stats.ok, true);
  assert.ok(stats.result.sources > 0);
  assert.ok(stats.result.bytes > 0);

  const cleared = await request('clearCache', {});
  assert.equal(cleared.ok, true);
  assert.ok(cleared.result.sources > 0);
  assert.deepEqual((await request('cacheStats', {})).result, { sources: 0, packages: 0, projects: 0, bytes: 0 });
});

test('worker serializes cache writes with clearing', async () => {
  await request('clearCache');
  const ref = '6'.repeat(40);
  const file = sourceFile('race/race.go', 'package race\nfunc Race() {}\n');
  const write = request('cachePackage', {
    origin: 'https://gitlab.example', project: 'group/race', ref, packagePath: 'race',
    modulePath: 'example.com/race', entries: [file], files: [file],
  });
  const clear = request('clearCache');
  await Promise.all([write, clear]);
  const stats = await request('cacheStats');
  assert.deepEqual(stats.result, { sources: 0, packages: 0, projects: 0, bytes: 0 });
});

test('worker reports durable project cache completion', async () => {
  const ref = 'f'.repeat(40);
  const file = sourceFile('sample/sample.go', 'package sample\nfunc Target() {}\n');
  const params = {
    origin: 'https://gitlab.example',
    project: 'group/project',
    ref,
    files: [file],
  };
  assert.deepEqual((await request('projectCacheStatus', params)).result, { status: 'missing' });
  await request('cacheProject', params);
  assert.deepEqual((await request('projectCacheStatus', params)).result, { status: 'complete', format: 4 });
  await request('clearCache', {});
  assert.deepEqual((await request('projectCacheStatus', params)).result, { status: 'missing' });
});

test('worker indexes a new commit from shared and newly downloaded blobs', async () => {
  const origin = 'https://gitlab.example';
  const project = 'group/shared-project';
  const firstRef = '6'.repeat(40);
  const secondRef = '7'.repeat(40);
  const sharedFile = sourceFile('contracts/runner.go', 'package contracts\ntype Runner interface { Run() error }\n');
  const firstFile = sourceFile('service/version.go', 'package service\nconst Version = 1\n');
  const secondFile = sourceFile('service/version.go', 'package service\nconst Version = 2\n');
  const shared = { path: sharedFile.path, blobId: sharedFile.blobId };
  const firstOnly = { path: firstFile.path, blobId: firstFile.blobId };
  const secondOnly = { path: secondFile.path, blobId: secondFile.blobId };

  await request('cacheProject', {
    origin,
    project,
    ref: firstRef,
    entries: [shared, firstOnly],
    files: [
      sharedFile,
      firstFile,
    ],
  });
  const prepared = await request('prepareSources', {
    origin,
    project,
    ref: secondRef,
    files: [shared, secondOnly],
  });
  assert.equal(prepared.result.cached, 1);
  assert.deepEqual(prepared.result.missing.map(({ blobId }) => blobId), [secondOnly.blobId]);

  const indexed = await request('cacheProject', {
    origin,
    project,
    ref: secondRef,
    entries: [shared, secondOnly],
    files: [secondFile],
  });
  assert.equal(indexed.ok, true);
  assert.equal(indexed.result.packages, 2);
  assert.deepEqual((await request('projectCacheStatus', { origin, project, ref: secondRef })).result, { status: 'complete', format: 4 });
});

test('worker exposes package relations and durable related MR status', async () => {
  const scope = {
    origin: 'https://gitlab.example',
    project: 'group/worker-related',
    mergeRequest: '17',
    ref: '8'.repeat(40),
    packagePath: 'service',
    modulePath: 'example.com/project',
  };
  const source = `package service

import "example.com/project/contracts"

type Local interface { Start() error }
func Use(value contracts.Runner) { _ = value }
`;
  await request('cachePackage', { ...scope, files: [sourceFile('service/run.go', source)] });
  const relations = await request('packageRelations', scope);
  assert.equal(relations.ok, true);
  assert.deepEqual(relations.result.imports, ['contracts']);
  assert.deepEqual(relations.result.referencedImports, [{
    packagePath: 'contracts', importPath: 'example.com/project/contracts', name: 'Runner',
  }]);
  assert.deepEqual(relations.result.interfaces[0].methodNames, ['Start']);

  assert.deepEqual((await request('mergeRequestCacheStatus', scope)).result, { status: 'missing' });
  await request('cacheMergeRequest', { ...scope, packagePaths: ['service'], searchStatus: 'unavailable' });
  assert.deepEqual((await request('mergeRequestCacheStatus', scope)).result, {
    status: 'complete', format: 4, coverage: 'related', searchStatus: 'unavailable', packages: 1,
  });
  await request('disposeProject', { origin: scope.origin, project: scope.project, ref: scope.ref });
  assert.deepEqual((await request('restoreMergeRequest', scope)).result, {
    status: 'cacheHit', coverage: 'related', searchStatus: 'unavailable', packages: 1, definitions: 3,
  });
});

test('worker counts definitions consistently in restoreMergeRequest when some packages are already resident and others are restored from the durable index', async () => {
  const scope = { origin: 'https://gitlab.example', project: 'group/mixed-restore', mergeRequest: '42', ref: 'd'.repeat(40) };
  const alpha = sourceFile('alpha/alpha.go', 'package alpha\nfunc AlphaOne() {}\nfunc AlphaTwo() {}\n');
  const beta = sourceFile('beta/beta.go', 'package beta\nfunc Beta() {}\n');

  await request('cachePackage', { ...scope, packagePath: 'alpha', modulePath: 'example.com/project', files: [alpha] });
  await request('cachePackage', { ...scope, packagePath: 'beta', modulePath: 'example.com/project', files: [beta] });
  await request('cacheMergeRequest', { ...scope, packagePaths: ['alpha', 'beta'], searchStatus: 'unavailable' });

  await request('disposeProject', { origin: scope.origin, project: scope.project, ref: scope.ref });
  // Bring only alpha back into memory (package-scoped durable restore), so
  // beta must still be restored from the durable store inside the
  // restoreMergeRequest call itself — a mix of already-resident and
  // freshly-restored packages in the same call.
  await request('restorePackage', { ...scope, packagePath: 'alpha' });

  const restored = await request('restoreMergeRequest', scope);
  assert.deepEqual(restored.result, {
    status: 'cacheHit', coverage: 'related', searchStatus: 'unavailable', packages: 2, definitions: 3,
  });
});

test('a storage-only cache-status request is not blocked by an in-flight caching job', async () => {
  const ref = '9'.repeat(40);
  const project = {
    origin: 'https://gitlab.example',
    project: 'group/queue-test',
    ref,
    files: Array.from({ length: 25 }, (_, index) => sourceFile(`pkg${index}/file.go`, `package pkg${index}\nfunc F${index}() {}\n`)),
  };
  const order = [];
  const caching = request('cacheProject', project).then((result) => { order.push('caching'); return result; });
  const statusDuring = request('projectCacheStatus', { origin: project.origin, project: project.project, ref })
    .then((result) => { order.push('status'); return result; });
  await Promise.all([caching, statusDuring]);
  assert.deepEqual(order, ['status', 'caching']);
});

test('worker answers a query from a durably persisted index after the in-memory index is disposed, without a fresh reparse leaving results stale', async () => {
  const origin = 'https://gitlab.example';
  const project = 'group/durable-index';
  const ref = 'a'.repeat(40);
  const contracts = sourceFile('contracts/runner.go', 'package contracts\ntype Runner interface { Run() error }\n');
  const service = sourceFile('service/start.go', 'package service\n\nimport "example.com/project/contracts"\n\nfunc Start(value contracts.Runner) error { return value.Run() }\n');

  await request('cacheProject', { origin, project, ref, modulePath: 'example.com/project', files: [contracts, service] });
  const resolvedBefore = await request('resolveDefinition', {
    origin, project, ref, packagePath: 'contracts', path: 'contracts/runner.go', line: 2, character: 5, identifier: 'Runner',
  });
  assert.equal(resolvedBefore.result.status, 'resolved');

  await request('disposeProject', { origin, project, ref });

  const restored = await request('restoreProject', { origin, project, ref });
  assert.equal(restored.result.status, 'cacheHit');

  const references = await request('findReferences', {
    origin, project, ref, packagePath: 'contracts', definition: resolvedBefore.result.definition,
  });
  assert.equal(references.ok, true);
  assert.deepEqual(references.result.locations.map(({ path, line }) => ({ path, line })), [{ path: 'service/start.go', line: 5 }]);
});
