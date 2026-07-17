import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { before, test } from 'node:test';

let handler;
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
  await import('../go-semantic-worker.js?worker-test');
});

function request(method, params) {
  const id = ++nextID;
  const response = new Promise((resolve) => pending.set(id, resolve));
  handler({ data: { id, method, params } });
  return response;
}

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
  assert.deepEqual((await request('projectCacheStatus', params)).result, { status: 'complete', format: 3 });
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
  assert.deepEqual((await request('projectCacheStatus', { origin, project, ref: secondRef })).result, { status: 'complete', format: 3 });
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
    status: 'complete', format: 3, coverage: 'related', searchStatus: 'unavailable', packages: 1,
  });
  await request('disposeProject', { origin: scope.origin, project: scope.project, ref: scope.ref });
  assert.deepEqual((await request('restoreMergeRequest', scope)).result, {
    status: 'cacheHit', coverage: 'related', searchStatus: 'unavailable', packages: 1, definitions: 3,
  });
});
