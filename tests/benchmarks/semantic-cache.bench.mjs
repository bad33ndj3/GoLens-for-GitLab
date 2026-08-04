// Benchmarks for `go-semantic-cache.js`, covering finding #5
// (sequential IDB round-trips + hash-revalidation in `mergeRequestStatus`
// and `packageStatus`) plus the other cache entry points that sit on the
// hot hover/cache path.
//
// Every case runs twice: once against the in-memory `Map` fallback (no
// `indexedDB` supplied, matching most of `tests/go-semantic-cache.test.js`),
// and once against `FakeIndexedDB` (`./fake-indexeddb.mjs`) so the real
// per-request/per-transaction IDB code path is exercised, not just the
// memory path.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { GoSemanticSourceCache } from '../../worker/source-cache.js';
import { FakeIndexedDB } from './fake-indexeddb.mjs';

const SMOKE = process.env.GOLENS_BENCH_SCALE === 'smoke';
const PREPARE_FILE_COUNT = SMOKE ? 20 : 500;
const MERGE_REQUEST_PACKAGE_COUNT = SMOKE ? 3 : 20;

function blobID(source) {
  return createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
}

function sourceFile(path, source) {
  return { path, blobId: blobID(source), source };
}

function makeFiles(count, prefix = 'file') {
  return Array.from({ length: count }, (_, index) => sourceFile(
    `${prefix}${index}/source.go`,
    `package ${prefix}${index}\n\nfunc Run${index}() {}\n`,
  ));
}

function newCache(useIndexedDB) {
  return new GoSemanticSourceCache({ indexedDB: useIndexedDB ? new FakeIndexedDB() : undefined });
}

async function prepareSourcesSetup(useIndexedDB) {
  const cache = newCache(useIndexedDB);
  const files = makeFiles(PREPARE_FILE_COUNT);
  const scope = { origin: 'https://gitlab.example', project: 'group/project', ref: 'a'.repeat(40) };
  // Prime the cache with half the files so prepareSources exercises both
  // the cache-hit hash-revalidation path and the miss path.
  const cached = files.slice(0, Math.floor(files.length / 2));
  for (const file of cached) {
    await cache.writePackage({ ...scope, packagePath: file.path.split('/')[0], files: [file] });
  }
  return { cache, scope, files };
}

async function writeReadRoundTripSetup(useIndexedDB) {
  const cache = newCache(useIndexedDB);
  const scope = {
    origin: 'https://gitlab.example', project: 'group/project', ref: 'b'.repeat(40), packagePath: 'service',
  };
  const file = sourceFile('service/run.go', 'package service\n\nfunc Run() {}\n');
  return { cache, scope, file };
}

async function packageStatusSetup(useIndexedDB) {
  const cache = newCache(useIndexedDB);
  const scope = {
    origin: 'https://gitlab.example', project: 'group/project', ref: 'c'.repeat(40), packagePath: 'service',
  };
  await cache.writePackage({ ...scope, files: [sourceFile('service/run.go', 'package service\n')] });
  const status = await cache.packageStatus(scope);
  assert.equal(status.status, 'complete');
  return { cache, scope };
}

async function mergeRequestStatusSetup(useIndexedDB) {
  const cache = newCache(useIndexedDB);
  const scope = {
    origin: 'https://gitlab.example', project: 'group/related-project', mergeRequest: '42', ref: 'd'.repeat(40),
  };
  const packagePaths = [];
  for (let index = 0; index < MERGE_REQUEST_PACKAGE_COUNT; index++) {
    const packagePath = `pkg${index}`;
    const file = sourceFile(`${packagePath}/run.go`, `package pkg${index}\n\nfunc Run() {}\n`);
    await cache.writePackage({ ...scope, packagePath, files: [file] });
    packagePaths.push(packagePath);
  }
  await cache.writeMergeRequest({ ...scope, packagePaths });
  const status = await cache.mergeRequestStatus(scope);
  assert.equal(status.status, 'complete');
  assert.equal(status.packages, MERGE_REQUEST_PACKAGE_COUNT);
  return { cache, scope };
}

async function statsSetup(useIndexedDB) {
  const cache = newCache(useIndexedDB);
  const files = makeFiles(SMOKE ? 5 : 50, 'stat');
  for (const file of files) {
    await cache.writePackage({
      origin: 'https://gitlab.example', project: 'group/project', ref: 'e'.repeat(40), packagePath: file.path.split('/')[0], files: [file],
    });
  }
  return { cache };
}

// ~20,000 source records, approximating the target repo scale (see
// docs/benchmarks/README.md). `stats()`'s cursor scan is O(all cached
// sources), so this backs the popup's cache-status display cost at real
// scale, not the ~50-record scale above.
//
// Setup seeds the store Maps directly instead of going through
// `writePackage` for each of the 20,000 files: `stats()` never validates
// source content against its Git blob ID (no `gitBlobID`/hash calls in its
// code path), so a realistic seed only needs the fields `stats()` actually
// reads (`source`/`bytes` for the sources store, store size for packages,
// `mergeRequest` presence for projects). Going through `writePackage` per
// file would pay the fake IndexedDB's artificial per-request delay
// thousands of times during setup alone; seeding directly keeps setup fast
// while still exercising the real `stats()` cursor-scan code being
// measured.
const LARGE_SOURCE_COUNT = SMOKE ? 40 : 20000;

function seedLargeSourceRecords(sources, packages) {
  for (let index = 0; index < LARGE_SOURCE_COUNT; index++) {
    const source = `package stat${index}\n\nfunc Run${index}() {}\n`;
    sources.set(`source-${index}`, {
      id: `source-${index}`, blobId: 'f'.repeat(40), source, bytes: source.length, format: 3,
    });
  }
  for (let index = 0; index < Math.ceil(LARGE_SOURCE_COUNT / 20); index++) {
    packages.set(`package-${index}`, { id: `package-${index}`, complete: true });
  }
}

async function largeStatsSetup(useIndexedDB) {
  const cache = newCache(useIndexedDB);
  if (useIndexedDB) {
    const database = await cache.databasePromise;
    seedLargeSourceRecords(database.stores.get('sources'), database.stores.get('packages'));
  } else {
    seedLargeSourceRecords(cache.memory.sources, cache.memory.packages);
  }
  const stats = await cache.stats();
  assert.equal(stats.sources, LARGE_SOURCE_COUNT);
  return { cache };
}

// Sub-millisecond in-memory cases are noisy at the harness's default
// iteration count (medians drifted >20% run-to-run in the 3x stability
// check — see docs/benchmarks/README.md). They are cheap, so a much larger
// sample settles them well under +/-10%. The IndexedDB (fake) variants are
// already 1-2 orders of magnitude slower per call and were stable at the
// default count, so they keep a smaller iteration count to keep the whole
// suite fast.
const IN_MEMORY_ITERATIONS = SMOKE ? 1 : 300;
const IN_MEMORY_WARMUP = SMOKE ? 0 : 30;
const INDEXED_DB_ITERATIONS = SMOKE ? 1 : 30;
const INDEXED_DB_WARMUP = SMOKE ? 0 : 5;

// For operations fast enough that a single call is comparable to
// performance.now()'s own overhead, wrap `run` to perform `batchSize`
// calls per timed sample (like the diff-dom `fileContextFor x1000` case).
// This amortizes per-sample measurement/scheduling jitter; the reported
// medianMs is for the whole batch, so its label carries the count and the
// comparison is still apples-to-apples across baseline/optimized runs.
function batched(run, batchSize) {
  if (batchSize <= 1) return run;
  return async (context) => {
    for (let index = 0; index < batchSize; index++) await run(context);
  };
}

function transportVariants(baseName, category, {
  setup, run, inMemoryIterations = IN_MEMORY_ITERATIONS, inMemoryWarmup = IN_MEMORY_WARMUP,
  indexedDBIterations = INDEXED_DB_ITERATIONS, indexedDBWarmup = INDEXED_DB_WARMUP,
  inMemoryBatch = 1,
}) {
  return [false, true].map((useIndexedDB) => ({
    name: `${baseName} (${useIndexedDB ? 'IndexedDB (fake)' : `in-memory${inMemoryBatch > 1 ? ` x${inMemoryBatch}` : ''}`})`,
    category,
    iterations: useIndexedDB ? indexedDBIterations : inMemoryIterations,
    warmup: useIndexedDB ? indexedDBWarmup : inMemoryWarmup,
    setup: () => setup(useIndexedDB),
    run: useIndexedDB ? run : batched(run, inMemoryBatch),
  }));
}

export const benchmarks = [
  ...transportVariants('prepareSources (500 files, half cached)', 'semantic-cache', {
    setup: prepareSourcesSetup,
    run: async ({ cache, scope, files }) => {
      const result = await cache.prepareSources({ ...scope, files });
      assert.equal(result.total, files.length);
    },
  }),
  ...transportVariants('writePackage + readPackage round trip', 'semantic-cache', {
    setup: writeReadRoundTripSetup,
    inMemoryBatch: 20,
    run: async ({ cache, scope, file }) => {
      await cache.writePackage({ ...scope, files: [file] });
      const read = await cache.readPackage(scope);
      assert.ok(read?.files.length);
    },
  }),
  ...transportVariants('packageStatus (single package)', 'semantic-cache', {
    setup: packageStatusSetup,
    inMemoryBatch: 50,
    run: async ({ cache, scope }) => {
      const status = await cache.packageStatus(scope);
      assert.equal(status.status, 'complete');
    },
  }),
  ...transportVariants('mergeRequestStatus (20 packages, sequential loop)', 'semantic-cache', {
    setup: mergeRequestStatusSetup,
    indexedDBIterations: SMOKE ? 1 : 15,
    indexedDBWarmup: SMOKE ? 0 : 2,
    inMemoryBatch: 10,
    run: async ({ cache, scope }) => {
      const status = await cache.mergeRequestStatus(scope);
      assert.equal(status.status, 'complete');
    },
  }),
  ...transportVariants('stats', 'semantic-cache', {
    setup: statsSetup,
    inMemoryBatch: 300,
    run: async ({ cache }) => {
      const stats = await cache.stats();
      assert.ok(stats.sources > 0);
    },
  }),
  {
    name: `stats [large: ~${LARGE_SOURCE_COUNT} source records, ~20k-file-repo scale] (in-memory x20)`,
    category: 'semantic-cache',
    iterations: SMOKE ? 1 : 30,
    warmup: SMOKE ? 0 : 5,
    setup: () => largeStatsSetup(false),
    run: batched(async ({ cache }) => {
      const stats = await cache.stats();
      assert.equal(stats.sources, LARGE_SOURCE_COUNT);
    }, 20),
  },
  {
    // At this scale a single call already costs ~26s (setTimeout-backed
    // per-cursor-step delay x 20,000 records — see fake-indexeddb.mjs).
    // Per docs/benchmarks/README.md's rule for impractical large-scale
    // cases: this is measured once (iterations:1, no warmup) rather than
    // silently shrunk — an honest slow number, not a smaller fixture.
    name: `stats [large: ~${LARGE_SOURCE_COUNT} source records, ~20k-file-repo scale] (IndexedDB (fake))`,
    category: 'semantic-cache',
    iterations: 1,
    warmup: 0,
    setup: () => largeStatsSetup(true),
    run: async ({ cache }) => {
      const stats = await cache.stats();
      assert.equal(stats.sources, LARGE_SOURCE_COUNT);
    },
  },
];
