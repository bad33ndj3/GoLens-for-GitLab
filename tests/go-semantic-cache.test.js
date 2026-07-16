import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { GoSemanticSourceCache, isCommitSHA } from '../go-semantic-cache.js';

function blobID(source) {
  return createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
}

function sourceFile(path, source) {
  return { path, blobId: blobID(source), source };
}

test('keeps source snapshots isolated by origin and immutable commit', async () => {
  const cache = new GoSemanticSourceCache({ indexedDB: undefined });
  const base = {
    origin: 'https://gitlab.example',
    project: 'group/project',
    packagePath: 'service',
    modulePath: 'example.com/project',
  };
  const first = 'a'.repeat(40);
  const second = 'b'.repeat(40);
  await cache.writePackage({ ...base, ref: first, files: [sourceFile('service/run.go', 'package service\nfunc First() {}\n')] });
  await cache.writePackage({ ...base, ref: second, files: [sourceFile('service/run.go', 'package service\nfunc Second() {}\n')] });

  assert.match((await cache.readPackage({ ...base, ref: first })).files[0].source, /First/);
  assert.match((await cache.readPackage({ ...base, ref: second })).files[0].source, /Second/);
  assert.equal(await cache.readPackage({ ...base, origin: 'https://other-gitlab.example', ref: first }), null);
});

test('restores a package from a complete project snapshot without a second download', async () => {
  const cache = new GoSemanticSourceCache({ indexedDB: undefined });
  const scope = { origin: 'https://gitlab.example', project: 'group/project', ref: 'c'.repeat(40) };
  await cache.writeProject({
    ...scope,
    modulePath: 'example.com/project',
    files: [
      sourceFile('service/run.go', 'package service\n'),
      sourceFile('other/other.go', 'package other\n'),
    ],
  });
  const snapshot = await cache.readPackage({ ...scope, packagePath: 'service' });
  assert.deepEqual(snapshot.files.map(({ path }) => path), ['service/run.go']);
});

test('accepts only full commit SHAs for durable cache identities', () => {
  assert.equal(isCommitSHA('d'.repeat(40)), true);
  assert.equal(isCommitSHA('main'), false);
  assert.equal(isCommitSHA('deadbeef'), false);
});

test('rejects source that does not match its Git blob ID', async () => {
  const cache = new GoSemanticSourceCache({ indexedDB: undefined });
  const expected = sourceFile('service/run.go', 'package service\nconst Version = 1\n');
  await assert.rejects(
    cache.writePackage({
      origin: 'https://gitlab.example',
      project: 'group/project',
      ref: '4'.repeat(40),
      packagePath: 'service',
      entries: [expected],
      files: [{ ...expected, source: 'package service\nconst Version = 2\n' }],
    }),
    /does not match Git blob/,
  );
});

test('purges corrupted cached source instead of reporting a cache hit', async () => {
  const cache = new GoSemanticSourceCache({ indexedDB: undefined });
  const scope = {
    origin: 'https://gitlab.example', project: 'group/project', ref: '5'.repeat(40), packagePath: 'service',
  };
  const file = sourceFile('service/run.go', 'package service\nfunc Run() {}\n');
  await cache.writePackage({ ...scope, entries: [file], files: [file] });
  const record = cache.memory.sources.values().next().value;
  record.source = 'package service\nfunc Corrupted() {}\n';

  assert.deepEqual(await cache.packageStatus(scope), { status: 'missing' });
  assert.equal(await cache.readPackage(scope), null);
  assert.deepEqual(await cache.prepareSources({ ...scope, files: [file] }), {
    total: 1,
    cached: 0,
    missing: [{ path: file.path, blobId: file.blobId, referencedFiles: 1 }],
  });
});

test('reports cache size and clears every source snapshot', async () => {
  const cache = new GoSemanticSourceCache({ indexedDB: undefined });
  const scope = {
    origin: 'https://gitlab.example',
    project: 'group/project',
    ref: 'e'.repeat(40),
    packagePath: 'service',
  };
  await cache.writePackage({ ...scope, files: [sourceFile('service/run.go', 'package service\n')] });
  const before = await cache.stats();
  assert.equal(before.sources, 1);
  assert.ok(before.bytes > 0);
  assert.equal((await cache.clear()).bytes, before.bytes);
  assert.deepEqual(await cache.stats(), { sources: 0, packages: 0, projects: 0, bytes: 0 });
});

test('reports a project complete only while its full source snapshot is intact', async () => {
  const cache = new GoSemanticSourceCache({ indexedDB: undefined });
  const scope = { origin: 'https://gitlab.example', project: 'group/project', ref: 'f'.repeat(40) };
  assert.equal(await cache.hasProject(scope), false);

  await cache.writeProject({
    ...scope,
    files: [
      sourceFile('service/run.go', 'package service\n'),
      sourceFile('service/run_test.go', 'package service\n'),
    ],
  });
  assert.equal(await cache.hasProject(scope), true);

  cache.memory.sources.delete(cache.memory.sources.keys().next().value);
  assert.equal(await cache.hasProject(scope), false);
});

test('validates and restores only the requested package from a project snapshot', async () => {
  const cache = new GoSemanticSourceCache({ indexedDB: undefined });
  const scope = { origin: 'https://gitlab.example', project: 'group/large-project', ref: '1'.repeat(40) };
  const service = sourceFile('service/run.go', 'package service\n');
  const other = sourceFile('other/other.go', 'package other\n');
  await cache.writeProject({ ...scope, entries: [service, other], files: [service, other] });

  const otherKey = [...cache.memory.sources].find(([, record]) => record.blobId === other.blobId)[0];
  cache.memory.sources.delete(otherKey);
  assert.deepEqual(await cache.projectStatus(scope), { status: 'missing' });
  assert.deepEqual(await cache.packageStatus({ ...scope, packagePath: 'service' }), { status: 'complete', format: 3 });
  assert.deepEqual(await cache.packageStatus({ ...scope, packagePath: 'other' }), { status: 'missing' });
  assert.deepEqual(await cache.readPackage({ ...scope, packagePath: 'service' }), {
    modulePath: '',
    files: [{ path: service.path, source: service.source }],
    format: 3,
  });
});

test('shares unchanged blobs across commits and preserves current paths after renames', async () => {
  const cache = new GoSemanticSourceCache({ indexedDB: undefined });
  const project = { origin: 'https://gitlab.example', project: 'group/project' };
  const first = { ...project, ref: '1'.repeat(40) };
  const second = { ...project, ref: '2'.repeat(40) };
  const sharedSource = 'package old\n';
  const firstChangedSource = 'package service\nconst Version = 1\n';
  const secondChangedSource = 'package service\nconst Version = 2\n';
  const sharedBlob = blobID(sharedSource);
  const changedBlob = blobID(secondChangedSource);

  const firstEntries = [
    { path: 'old/shared.go', blobId: sharedBlob },
    { path: 'service/changed.go', blobId: blobID(firstChangedSource) },
  ];
  await cache.writeProject({
    ...first,
    entries: firstEntries,
    files: [
      { ...firstEntries[0], source: sharedSource },
      { ...firstEntries[1], source: firstChangedSource },
    ],
  });

  const secondEntries = [
    { path: 'new/shared.go', blobId: sharedBlob },
    { path: 'service/changed.go', blobId: changedBlob },
  ];
  const prepared = await cache.prepareSources({ ...second, files: secondEntries });
  assert.equal(prepared.cached, 1);
  assert.deepEqual(prepared.missing.map(({ path }) => path), ['service/changed.go']);
  await cache.writeProject({
    ...second,
    entries: secondEntries,
    files: [{ ...prepared.missing[0], source: secondChangedSource }],
  });

  assert.equal((await cache.stats()).sources, 3);
  const restored = await cache.readProject(second);
  assert.deepEqual(restored.files.map(({ path }) => path), ['new/shared.go', 'service/changed.go']);
  assert.match(restored.files[1].source, /Version = 2/);
});

test('keeps shared blobs isolated by project and repairs only a missing blob', async () => {
  const cache = new GoSemanticSourceCache({ indexedDB: undefined });
  const scope = { origin: 'https://gitlab.example', project: 'group/project', ref: '3'.repeat(40) };
  const files = ['one.go', 'two.go'].map((path) => sourceFile(path, `package sample\n// ${path}\n`));
  const entries = files.map(({ path, blobId }) => ({ path, blobId }));
  await cache.writeProject({
    ...scope,
    entries,
    files,
  });
  const brokenKey = [...cache.memory.sources].find(([, record]) => record.blobId === entries[0].blobId)[0];
  cache.memory.sources.delete(brokenKey);

  const repair = await cache.prepareSources({ ...scope, files: entries });
  assert.equal(repair.cached, 1);
  assert.deepEqual(repair.missing.map(({ path }) => path), ['one.go']);
  assert.equal((await cache.projectStatus(scope)).status, 'missing');
  assert.equal((await cache.prepareSources({ ...scope, project: 'other/project', files: entries })).cached, 0);
});

test('validates related MR manifests against every package and accepts a full project snapshot', async () => {
  const cache = new GoSemanticSourceCache({ indexedDB: undefined });
  const scope = {
    origin: 'https://gitlab.example',
    project: 'group/related-project',
    mergeRequest: '42',
    ref: '8'.repeat(40),
  };
  const contracts = sourceFile('contracts/runner.go', 'package contracts\n');
  const service = sourceFile('service/run.go', 'package service\n');
  await cache.writePackage({ ...scope, packagePath: 'contracts', entries: [contracts], files: [contracts] });
  await cache.writePackage({ ...scope, packagePath: 'service', entries: [service], files: [service] });
  assert.deepEqual(await cache.mergeRequestStatus(scope), { status: 'missing' });

  await cache.writeMergeRequest({ ...scope, packagePaths: ['service', 'contracts'], searchStatus: 'limited' });
  assert.deepEqual(await cache.mergeRequestStatus(scope), {
    status: 'complete', format: 3, coverage: 'related', searchStatus: 'limited', packages: 2,
  });
  assert.deepEqual(await cache.mergeRequestStatus({ ...scope, ref: '9'.repeat(40) }), { status: 'missing' });

  const brokenKey = [...cache.memory.sources].find(([, record]) => record.blobId === service.blobId)[0];
  cache.memory.sources.delete(brokenKey);
  assert.deepEqual(await cache.mergeRequestStatus(scope), { status: 'missing' });

  const fullScope = { ...scope, ref: 'a'.repeat(40), mergeRequest: '99' };
  await cache.writeProject({ ...fullScope, entries: [contracts], files: [contracts] });
  assert.deepEqual(await cache.mergeRequestStatus(fullScope), {
    status: 'complete', format: 3, coverage: 'full', searchStatus: 'complete',
  });
});
