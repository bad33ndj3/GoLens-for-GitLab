import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { GoSemanticSourceCache, isCommitSHA } from '../go-semantic-cache.js';
import { FakeIndexedDB } from './benchmarks/fake-indexeddb.mjs';

function blobID(source) {
  return createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
}

function sourceFile(path, source) {
  return { path, blobId: blobID(source), source };
}

// Every behavioural test below runs once against the in-memory `Map`
// fallback and once against the fake IndexedDB storage double from ticket
// 01 (`tests/benchmarks/fake-indexeddb.mjs`), so the real storage code path
// is covered, not only the in-memory fallback the suite used to exercise
// exclusively.
const TRANSPORTS = [
  { name: 'in-memory', indexedDB: undefined },
  { name: 'IndexedDB (fake)', indexedDB: () => new FakeIndexedDB() },
];

function newCache(transport) {
  return new GoSemanticSourceCache({ indexedDB: transport.indexedDB ? transport.indexedDB() : undefined });
}

// Storage-agnostic access to the raw `sources` records, so tests can poke at
// stored records directly (simulate deletion/corruption) regardless of
// which transport is under test. Both transports keep their records in a
// plain `Map` (`cache.memory.sources` in-memory, `database.stores.get(...)`
// for the fake IndexedDB), so the same call shape works for either.
async function sourceStoreFor(cache) {
  if (!cache.databasePromise) return cache.memory.sources;
  const database = await cache.databasePromise;
  return database.stores.get('sources');
}

for (const transport of TRANSPORTS) {
  test(`[${transport.name}] keeps source snapshots isolated by origin and immutable commit`, async () => {
    const cache = newCache(transport);
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

  test(`[${transport.name}] restores a package from a complete project snapshot without a second download`, async () => {
    const cache = newCache(transport);
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

  test(`[${transport.name}] rejects source that does not match its Git blob ID`, async () => {
    const cache = newCache(transport);
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

  test(`[${transport.name}] trusts the write-time verification marker on read, and prunes only via the mutating prepareSources path`, async () => {
    const cache = newCache(transport);
    const scope = {
      origin: 'https://gitlab.example', project: 'group/project', ref: '5'.repeat(40), packagePath: 'service',
    };
    const file = sourceFile('service/run.go', 'package service\nfunc Run() {}\n');
    await cache.writePackage({ ...scope, entries: [file], files: [file] });
    const store = await sourceStoreFor(cache);
    const record = store.values().next().value;
    record.source = 'package service\nfunc Corrupted() {}\n';

    // Read and status paths trust the `verified` marker recorded at write
    // time; they do not re-hash the record against its Git blob ID, so
    // storage-level tampering that bypasses the write path is invisible to
    // them until something explicitly mutating re-verifies.
    assert.deepEqual(await cache.packageStatus(scope), { status: 'complete', format: 4 });
    assert.match((await cache.readPackage(scope)).files[0].source, /Corrupted/);

    // `prepareSources` is explicitly mutating: it re-verifies against the
    // Git blob ID and prunes what fails, which is where "records whose
    // content does not match their Git blob identity are still rejected"
    // now happens.
    assert.deepEqual(await cache.prepareSources({ ...scope, files: [file] }), {
      total: 1,
      cached: 0,
      missing: [{ path: file.path, blobId: file.blobId, referencedFiles: 1 }],
    });

    // The prune took effect: the record is gone, so a subsequent read/status
    // check now correctly reports it missing too.
    assert.deepEqual(await cache.packageStatus(scope), { status: 'missing' });
    assert.equal(await cache.readPackage(scope), null);
  });

  test(`[${transport.name}] reports cache size and clears every source snapshot`, async () => {
    const cache = newCache(transport);
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

  test(`[${transport.name}] reports a project complete only while its full source snapshot is intact`, async () => {
    const cache = newCache(transport);
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

    const store = await sourceStoreFor(cache);
    store.delete(store.keys().next().value);
    assert.equal(await cache.hasProject(scope), false);
  });

  test(`[${transport.name}] validates and restores only the requested package from a project snapshot`, async () => {
    const cache = newCache(transport);
    const scope = { origin: 'https://gitlab.example', project: 'group/large-project', ref: '1'.repeat(40) };
    const service = sourceFile('service/run.go', 'package service\n');
    const other = sourceFile('other/other.go', 'package other\n');
    await cache.writeProject({ ...scope, entries: [service, other], files: [service, other] });

    const store = await sourceStoreFor(cache);
    const otherKey = [...store].find(([, record]) => record.blobId === other.blobId)[0];
    store.delete(otherKey);
    assert.deepEqual(await cache.projectStatus(scope), { status: 'missing' });
    assert.deepEqual(await cache.packageStatus({ ...scope, packagePath: 'service' }), { status: 'complete', format: 4 });
    assert.deepEqual(await cache.packageStatus({ ...scope, packagePath: 'other' }), { status: 'missing' });
    assert.deepEqual(await cache.readPackage({ ...scope, packagePath: 'service' }), {
      modulePath: '',
      files: [{ path: service.path, source: service.source }],
      format: 4,
    });
  });

  test(`[${transport.name}] shares unchanged blobs across commits and preserves current paths after renames`, async () => {
    const cache = newCache(transport);
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

  test(`[${transport.name}] keeps shared blobs isolated by project and repairs only a missing blob`, async () => {
    const cache = newCache(transport);
    const scope = { origin: 'https://gitlab.example', project: 'group/project', ref: '3'.repeat(40) };
    const files = ['one.go', 'two.go'].map((path) => sourceFile(path, `package sample\n// ${path}\n`));
    const entries = files.map(({ path, blobId }) => ({ path, blobId }));
    await cache.writeProject({
      ...scope,
      entries,
      files,
    });
    const store = await sourceStoreFor(cache);
    const brokenKey = [...store].find(([, record]) => record.blobId === entries[0].blobId)[0];
    store.delete(brokenKey);

    const repair = await cache.prepareSources({ ...scope, files: entries });
    assert.equal(repair.cached, 1);
    assert.deepEqual(repair.missing.map(({ path }) => path), ['one.go']);
    assert.equal((await cache.projectStatus(scope)).status, 'missing');
    assert.equal((await cache.prepareSources({ ...scope, project: 'other/project', files: entries })).cached, 0);
  });

  test(`[${transport.name}] validates related MR manifests against every package and accepts a full project snapshot`, async () => {
    const cache = newCache(transport);
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
      status: 'complete', format: 4, coverage: 'related', searchStatus: 'limited', packages: 2,
    });
    assert.deepEqual(await cache.mergeRequestStatus({ ...scope, ref: '9'.repeat(40) }), { status: 'missing' });

    const store = await sourceStoreFor(cache);
    const brokenKey = [...store].find(([, record]) => record.blobId === service.blobId)[0];
    store.delete(brokenKey);
    assert.deepEqual(await cache.mergeRequestStatus(scope), { status: 'missing' });

    const fullScope = { ...scope, ref: 'a'.repeat(40), mergeRequest: '99' };
    await cache.writeProject({ ...fullScope, entries: [contracts], files: [contracts] });
    assert.deepEqual(await cache.mergeRequestStatus(fullScope), {
      status: 'complete', format: 4, coverage: 'full', searchStatus: 'complete',
    });
  });
}

test('records a write-time verification marker on source records', async () => {
  const cache = new GoSemanticSourceCache({ indexedDB: undefined });
  const scope = { origin: 'https://gitlab.example', project: 'group/project', ref: '1'.repeat(40), packagePath: 'service' };
  const file = sourceFile('service/run.go', 'package service\n');
  await cache.writePackage({ ...scope, entries: [file], files: [file] });
  const record = cache.memory.sources.values().next().value;
  assert.equal(record.verified, true);
  assert.equal(record.format, 4);
});

// Instruments `_readManifests`/`_readSourceRecords` call counts to pin
// "answered without a separate storage round trip per package": the number
// of storage calls a merge-request status check makes must stay flat as the
// package count grows, not scale linearly with it (before this change,
// `mergeRequestStatus` looped a per-package `packageStatus`, each opening
// its own manifest + source transactions).
async function seededMergeRequestCache(packageCount) {
  const cache = new GoSemanticSourceCache({ indexedDB: new FakeIndexedDB() });
  const scope = {
    origin: 'https://gitlab.example', project: 'group/scale-project', mergeRequest: '7', ref: '6'.repeat(40),
  };
  const packagePaths = [];
  for (let index = 0; index < packageCount; index++) {
    const packagePath = `pkg${index}`;
    const file = sourceFile(`${packagePath}/run.go`, `package pkg${index}\n`);
    await cache.writePackage({ ...scope, packagePath, entries: [file], files: [file] });
    packagePaths.push(packagePath);
  }
  await cache.writeMergeRequest({ ...scope, packagePaths });
  return { cache, scope };
}

function countStorageCalls(cache) {
  const counts = { manifestReads: 0, sourceReads: 0 };
  const originalReadManifests = cache._readManifests.bind(cache);
  const originalReadSourceRecords = cache._readSourceRecords.bind(cache);
  cache._readManifests = async (...args) => { counts.manifestReads++; return originalReadManifests(...args); };
  cache._readSourceRecords = async (...args) => { counts.sourceReads++; return originalReadSourceRecords(...args); };
  return counts;
}

test('answers merge-request status with a flat number of storage round trips as package count grows', async () => {
  const { cache: smallCache, scope: smallScope } = await seededMergeRequestCache(3);
  const smallCounts = countStorageCalls(smallCache);
  const smallStatus = await smallCache.mergeRequestStatus(smallScope);
  assert.equal(smallStatus.status, 'complete');
  assert.equal(smallStatus.packages, 3);

  const { cache: largeCache, scope: largeScope } = await seededMergeRequestCache(20);
  const largeCounts = countStorageCalls(largeCache);
  const largeStatus = await largeCache.mergeRequestStatus(largeScope);
  assert.equal(largeStatus.status, 'complete');
  assert.equal(largeStatus.packages, 20);

  // A handful of batched calls regardless of package count (manifest read,
  // batched package-manifest read, batched source-record read) — not one
  // per package.
  assert.ok(smallCounts.manifestReads <= 3, `expected <=3 manifest reads for 3 packages, got ${smallCounts.manifestReads}`);
  assert.ok(smallCounts.sourceReads <= 2, `expected <=2 source reads for 3 packages, got ${smallCounts.sourceReads}`);
  assert.equal(largeCounts.manifestReads, smallCounts.manifestReads);
  assert.equal(largeCounts.sourceReads, smallCounts.sourceReads);
});

test('accepts only full commit SHAs for durable cache identities', () => {
  assert.equal(isCommitSHA('d'.repeat(40)), true);
  assert.equal(isCommitSHA('main'), false);
  assert.equal(isCommitSHA('deadbeef'), false);
});
