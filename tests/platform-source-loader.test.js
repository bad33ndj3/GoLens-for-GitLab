// Ticket 28: page/platform/source-loader.js as a unit. Every dependency is
// injected — no worker, no network, no `document`. `status` is a spy rather
// than a real `golens-go-status` CustomEvent dispatch; that dispatch stays
// in go-navigation.js on purpose (see the module header), and the browser
// smoke is what proves the event still reaches the page.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

import {
  createSourceLoader,
  packageLoadingMessage,
  packageLoadingProgress,
  projectLoadingMessage,
  projectLoadingProgress,
} from '../page/platform/source-loader.js';
import { mapLimit } from '../page/platform/gitlab-api.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

beforeEach(() => {
  globalThis.location = {
    href: 'https://gitlab.example/group/project/-/merge_requests/42/diffs',
    origin: 'https://gitlab.example',
    pathname: '/group/project/-/merge_requests/42/diffs',
  };
});

function harness(overrides = {}) {
  const statusCalls = [];
  const rpcCalls = [];
  const responses = {
    packageCacheStatus: { status: 'missing' },
    restorePackage: { status: 'cacheMiss' },
    restoreProject: { status: 'cacheMiss' },
    prepareSources: null,
    cachePackage: { definitions: 12, files: 2 },
    cacheProject: { packages: 3 },
    ...overrides.rpc,
  };
  const files = overrides.files ?? [
    { path: 'pkg/a.go', blobId: SHA },
    { path: 'pkg/b.go', blobId: OTHER_SHA },
  ];
  const deps = {
    workerRPC: async (method, params) => {
      rpcCalls.push({ method, params });
      if (method === 'prepareSources') {
        return responses.prepareSources
          ?? { total: params.files.length, cached: 0, missing: params.files.map((file) => ({ ...file, referencedFiles: 1 })) };
      }
      return responses[method];
    },
    status: (kind, message, progress) => statusCalls.push({ kind, message, progress }),
    projectContext: () => ({ project: 'group/project', projectBase: 'https://gitlab.example/group/project' }),
    listPackageFiles: async () => files,
    listProjectFiles: async () => files,
    fetchBlob: async (entry) => ({ ...entry, source: `// ${entry.path}` }),
    modulePathFor: async () => 'example.com/m',
    mapLimit,
    ...overrides.deps,
  };
  return { loader: createSourceLoader(deps), statusCalls, rpcCalls, deps };
}

// --- Progress view-models (pure) ------------------------------------------

test('package progress clamps out-of-range counts and caps mid-flight at 90%', () => {
  assert.deepEqual(packageLoadingProgress('discovering'), { phase: 'discovering', completed: 0, total: 0, percentage: 0 });
  assert.deepEqual(packageLoadingProgress('ready', 3, 3), { phase: 'ready', completed: 3, total: 3, percentage: 100 });
  assert.equal(packageLoadingProgress('fetching', 5, 10).percentage, 45);
  // completed can never exceed total, and neither can go negative.
  assert.deepEqual(packageLoadingProgress('fetching', 99, 4), { phase: 'fetching', completed: 4, total: 4, percentage: 90 });
  assert.deepEqual(packageLoadingProgress('fetching', -5, -5), { phase: 'fetching', completed: 0, total: 0, percentage: 90 });
  // A non-finite total is treated as zero rather than producing NaN%.
  assert.equal(packageLoadingProgress('fetching', 1, Number.NaN).percentage, 90);
  assert.equal(packageLoadingProgress('indexing', 1, 10).percentage, 90);
  // Extra details ride along untouched.
  assert.equal(packageLoadingProgress('fetching', 1, 2, { cached: 7 }).cached, 7);
});

test('project progress differs from package progress only in the indexing plateau', () => {
  assert.equal(projectLoadingProgress('indexing', 1, 10).percentage, 95);
  assert.equal(projectLoadingProgress('fetching', 5, 10).percentage, 45);
  assert.equal(projectLoadingProgress('ready').percentage, 100);
});

test('package messages name the root package explicitly', () => {
  assert.equal(packageLoadingMessage('', packageLoadingProgress('discovering')), 'Preparing root package…');
  assert.equal(packageLoadingMessage('svc', packageLoadingProgress('discovering')), 'Preparing svc…');
  assert.match(packageLoadingMessage('svc', packageLoadingProgress('indexing', 4, 4)), /Indexing symbols · 90% · 4 \/ 4 files/);
  assert.match(packageLoadingMessage('svc', packageLoadingProgress('fetching', 2, 4)), /Loading svc · 45% · 2 \/ 4 files/);
});

test('project messages prefer the cached/remaining phrasing when those counts are known', () => {
  assert.equal(projectLoadingMessage(projectLoadingProgress('discovering')), 'Preparing MR head cache…');
  assert.equal(projectLoadingMessage(projectLoadingProgress('ready')), 'MR head cache ready');
  assert.match(projectLoadingMessage(projectLoadingProgress('indexing', 0, 9)), /Caching and indexing 9 Go files…/);
  assert.match(
    projectLoadingMessage(projectLoadingProgress('fetching', 1, 4, { cached: 1, remaining: 3 })),
    /1 cached · 3 remaining · 23%/,
  );
  assert.match(projectLoadingMessage(projectLoadingProgress('fetching', 1, 4)), /Fetching project Go sources · 23% · 1 \/ 4 files/);
});

// --- loadPackage ----------------------------------------------------------

test('loads a package end to end and reports ready with the symbol count', async () => {
  const { loader, statusCalls, rpcCalls } = harness();
  const result = await loader.loadPackage('pkg', SHA);
  assert.deepEqual(result, { definitions: 12, files: 2, cached: 0, downloaded: 2 });
  assert.deepEqual(rpcCalls.map((call) => call.method), ['packageCacheStatus', 'prepareSources', 'cachePackage']);
  assert.equal(statusCalls.at(0).kind, 'loading');
  assert.equal(statusCalls.at(-1).kind, 'ready');
  assert.match(statusCalls.at(-1).message, /Go intelligence ready · 12 symbols/);
});

test('restores a complete package from the worker cache without listing or downloading', async () => {
  let listed = 0;
  const { loader, statusCalls, rpcCalls } = harness({
    rpc: { packageCacheStatus: { status: 'complete' }, restorePackage: { status: 'cacheHit', definitions: 40, files: 9 } },
    deps: { listPackageFiles: async () => { listed++; return []; } },
  });
  const result = await loader.loadPackage('pkg', SHA);
  assert.deepEqual(result, { status: 'cacheHit', definitions: 40, files: 9, cached: 9, downloaded: 0 });
  assert.equal(listed, 0);
  assert.deepEqual(rpcCalls.map((call) => call.method), ['packageCacheStatus', 'restorePackage']);
  assert.match(statusCalls.at(-1).message, /restored from cache · 40 symbols/);
});

test('falls through to a full load when the worker reports complete but restore misses', async () => {
  const { loader, rpcCalls } = harness({ rpc: { packageCacheStatus: { status: 'complete' } } });
  await loader.loadPackage('pkg', SHA);
  assert.deepEqual(rpcCalls.map((call) => call.method), ['packageCacheStatus', 'restorePackage', 'prepareSources', 'cachePackage']);
});

test('skips the worker cache entirely for a non-commit ref', async () => {
  const { loader, rpcCalls } = harness();
  await loader.loadPackage('pkg', 'main');
  // No packageCacheStatus and no prepareSources: both are commit-pinned only.
  assert.deepEqual(rpcCalls.map((call) => call.method), ['cachePackage']);
});

test('downloads only the sources the worker is missing', async () => {
  const fetched = [];
  const { loader } = harness({
    rpc: { prepareSources: { total: 2, cached: 1, missing: [{ path: 'pkg/b.go', blobId: OTHER_SHA, referencedFiles: 1 }] } },
    deps: { fetchBlob: async (entry) => { fetched.push(entry.path); return { ...entry, source: '' }; } },
  });
  const result = await loader.loadPackage('pkg', SHA);
  assert.deepEqual(fetched, ['pkg/b.go']);
  assert.equal(result.cached, 1);
  assert.equal(result.downloaded, 1);
});

test('de-duplicates concurrent callers for the same package onto one load', async () => {
  let listed = 0;
  const { loader } = harness({ deps: { listPackageFiles: async () => { listed++; return [{ path: 'pkg/a.go', blobId: SHA }]; } } });
  const [first, second] = await Promise.all([loader.loadPackage('pkg', SHA), loader.loadPackage('pkg', SHA)]);
  assert.equal(listed, 1);
  assert.equal(first, second);
});

test('an in-flight project load short-circuits a package load for the same ref', async () => {
  let packageListed = 0;
  const { loader } = harness({ deps: { listPackageFiles: async () => { packageListed++; return []; } } });
  const projectPromise = loader.loadProject(SHA);
  const packageResult = await loader.loadPackage('pkg', SHA);
  assert.equal(packageListed, 0, 'the project load already covers this package');
  assert.equal(packageResult, await projectPromise);
});

test('a failed package load reports the error and is not cached', async () => {
  let attempts = 0;
  const { loader, statusCalls } = harness({
    deps: {
      listPackageFiles: async () => {
        attempts++;
        if (attempts === 1) throw new Error('GitLab source API returned 500');
        return [{ path: 'pkg/a.go', blobId: SHA }];
      },
    },
  });
  await assert.rejects(loader.loadPackage('pkg', SHA), /returned 500/);
  assert.equal(statusCalls.at(-1).kind, 'error');
  assert.match(statusCalls.at(-1).message, /returned 500/);
  // The failed promise was dropped, so a retry actually retries.
  await loader.loadPackage('pkg', SHA);
  assert.equal(attempts, 2);
});

// --- loadProject ----------------------------------------------------------

test('loads a project end to end and reports ready with the package count', async () => {
  const { loader, statusCalls, rpcCalls } = harness();
  const result = await loader.loadProject(SHA);
  assert.deepEqual(result, { packages: 3 });
  assert.deepEqual(rpcCalls.map((call) => call.method), ['restoreProject', 'prepareSources', 'cacheProject']);
  assert.match(statusCalls.at(-1).message, /Go project intelligence ready · 3 packages/);
});

test('restores a cached project without listing files', async () => {
  let listed = 0;
  const { loader, statusCalls } = harness({
    rpc: { restoreProject: { status: 'cacheHit', packages: 7 } },
    deps: { listProjectFiles: async () => { listed++; return []; } },
  });
  assert.deepEqual(await loader.loadProject(SHA), { status: 'cacheHit', packages: 7 });
  assert.equal(listed, 0);
  assert.match(statusCalls.at(-1).message, /restored from cache · 7 packages/);
});

test('fans progress out to every subscriber of an in-flight project load', async () => {
  const first = [];
  const second = [];
  const { loader } = harness();
  const running = loader.loadProject(SHA, (message) => first.push(message));
  // A second caller joins mid-flight and must receive the remaining updates.
  const joined = loader.loadProject(SHA, (message) => second.push(message));
  await Promise.all([running, joined]);
  assert.equal(first.length > 0, true);
  assert.equal(second.length > 0, true);
  assert.equal(first.at(-1), second.at(-1));
});

test('a failed project load reports the error and is not cached', async () => {
  const { loader, statusCalls } = harness({
    deps: { listProjectFiles: async () => { throw new Error('tree unavailable'); } },
  });
  await assert.rejects(loader.loadProject(SHA), /tree unavailable/);
  assert.equal(statusCalls.at(-1).kind, 'error');
});

// --- Cache-reset surface --------------------------------------------------

test('reset() forgets packages and projects so the next call reloads', async () => {
  let listed = 0;
  const { loader } = harness({ deps: { listPackageFiles: async () => { listed++; return [{ path: 'pkg/a.go', blobId: SHA }]; } } });
  await loader.loadPackage('pkg', SHA);
  await loader.loadPackage('pkg', SHA);
  assert.equal(listed, 1);
  loader.reset();
  await loader.loadPackage('pkg', SHA);
  assert.equal(listed, 2);
});

test('clearLoaded() drops cached results but leaves in-flight subscribers attached', async () => {
  const updates = [];
  const { loader } = harness();
  const running = loader.loadProject(SHA, (message) => updates.push(message));
  loader.clearLoaded();
  await running;
  // The listener set was not cleared, so the load it belongs to still
  // reported its final update to the caller that asked for it.
  assert.equal(updates.length > 0, true);
  assert.match(updates.at(-1), /Go project intelligence ready/);
});

test('forgetStaleProject drops a finished project but never one with subscribers', async () => {
  const scope = { origin: 'https://gitlab.example', project: 'group/project', ref: SHA };
  let listed = 0;
  const { loader } = harness({ deps: { listProjectFiles: async () => { listed++; return [{ path: 'a.go', blobId: SHA }]; } } });

  // While a load is running its listener set exists, so it is protected.
  const running = loader.loadProject(SHA);
  loader.forgetStaleProject(scope);
  await running;
  await loader.loadProject(SHA);
  assert.equal(listed, 1, 'still cached — forgetting was correctly refused');

  // Once finished, the same call does drop it.
  loader.forgetStaleProject(scope);
  await loader.loadProject(SHA);
  assert.equal(listed, 2);
});

test('forgetStaleProject ignores a project that was never loaded', () => {
  const { loader } = harness();
  assert.doesNotThrow(() => loader.forgetStaleProject({ origin: 'https://x', project: 'a/b', ref: SHA }));
});
