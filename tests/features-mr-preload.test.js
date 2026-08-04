import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import {
  dirname,
  isCommitSha,
  planPreload,
  mergeSearchStatus,
  relatedReadyMessage,
  selectRelevantInterfaces,
  implementationSearchTerms,
  relatedLoadingProgress,
  relatedLoadingMessage,
} from '../page/features/mr-preload.internal.js';
import { mount } from '../page/features/mr-preload.js';

before(() => {
  globalThis.location = {
    href: 'https://gitlab.example/group/project/-/merge_requests/42/diffs',
    origin: 'https://gitlab.example',
    pathname: '/group/project/-/merge_requests/42/diffs',
  };
});

// --- pure core (page/features/mr-preload.internal.js) ---------------------

test('dirname(path) returns the path above the final segment, or "" with none', () => {
  assert.equal(dirname('pkg/sub/file.go'), 'pkg/sub');
  assert.equal(dirname('file.go'), '');
});

test('isCommitSha(ref) accepts only a full 40-hex commit, tolerating missing input', () => {
  assert.equal(isCommitSha('a'.repeat(40)), true);
  assert.equal(isCommitSha('A'.repeat(40)), true);
  assert.equal(isCommitSha('main'), false);
  assert.equal(isCommitSha(''), false);
  assert.equal(isCommitSha(undefined), false);
});

test('planPreload({kind:"changed"}) plans the unique, sorted package paths of changed files', () => {
  const plan = planPreload({ kind: 'changed', changedFiles: ['pkg/b/b.go', 'pkg/a/a.go', 'pkg/a/a2.go', 'root.go'] });
  assert.deepEqual(plan, [
    { packagePath: '', action: 'load' },
    { packagePath: 'pkg/a', action: 'load' },
    { packagePath: 'pkg/b', action: 'load' },
  ]);
});

test('planPreload({kind:"dependencies"}) plans unloaded direct imports of the seed packages, sorted for deterministic order', () => {
  const relationsByPackage = new Map([
    ['pkg/a', { imports: ['pkg/z', 'pkg/c', 'pkg/d'] }],
    ['pkg/b', { imports: ['pkg/d'] }],
  ]);
  const plan = planPreload({
    kind: 'dependencies',
    seedPackages: ['pkg/a', 'pkg/b'],
    relationsByPackage,
    loadedPackagePaths: new Set(['pkg/a', 'pkg/b', 'pkg/d']),
  });
  // Discovery order (pkg/z before pkg/c) must not leak into load order.
  assert.deepEqual(plan, [{ packagePath: 'pkg/c', action: 'load' }, { packagePath: 'pkg/z', action: 'load' }]);
});

test('planPreload({kind:"candidates"}) dedupes, sorts, excludes loaded, and bounds to maxCandidates', () => {
  const plan = planPreload({
    kind: 'candidates',
    candidatePackagePaths: ['pkg/z', 'pkg/a', 'pkg/z', 'pkg/m', 'pkg/loaded'],
    loadedPackagePaths: new Set(['pkg/loaded']),
    maxCandidates: 2,
  });
  assert.deepEqual(plan, [{ packagePath: 'pkg/a', action: 'load' }, { packagePath: 'pkg/m', action: 'load' }]);
});

test('planPreload is total: an unknown or missing kind yields []', () => {
  assert.deepEqual(planPreload({ kind: 'bogus' }), []);
  assert.deepEqual(planPreload(undefined), []);
  assert.deepEqual(planPreload(null), []);
});

test('mergeSearchStatus/relatedReadyMessage: preserves the most restrictive optional search coverage state', () => {
  assert.equal(mergeSearchStatus('complete', 'limited'), 'limited');
  assert.equal(mergeSearchStatus('limited', 'complete'), 'limited');
  assert.equal(mergeSearchStatus('limited', 'unavailable'), 'unavailable');
  assert.equal(relatedReadyMessage('unavailable'), 'Related cache ready · code search unavailable');
});

test('selectRelevantInterfaces collects seed-package interfaces plus referenced-import interfaces', () => {
  const relations = new Map([
    ['pkg/a', { interfaces: [{ identity: 'pkg/a.Reader', name: 'Reader', methodNames: ['Read'] }] }],
    ['pkg/b', { interfaces: [{ identity: 'pkg/b.Writer', name: 'Writer', methodNames: ['Write'] }] }],
  ]);
  const { availableInterfaces, relevantInterfaces } = selectRelevantInterfaces({
    relations,
    seedPackages: ['pkg/a'],
    referencedImports: [{ packagePath: 'pkg/b', name: 'Writer' }],
  });
  assert.deepEqual([...availableInterfaces.keys()].sort(), ['pkg/a.Reader', 'pkg/b.Writer']);
  assert.deepEqual([...relevantInterfaces.keys()].sort(), ['pkg/a.Reader', 'pkg/b.Writer']);
});

test('implementationSearchTerms: uses every required interface method to discover candidate implementations', () => {
  assert.deepEqual(
    implementationSearchTerms({ name: 'ReadCloser', methodNames: ['Read', 'Close'] }),
    ['Close', 'Read'],
  );
});

test('implementationSearchTerms: uses methods inherited from indexed embedded interfaces', () => {
  const reader = { identity: 'contracts.Reader', methodNames: ['Read'], embedded: [] };
  const closer = { identity: 'contracts.Closer', methodNames: ['Close'], embedded: [] };
  const readCloser = {
    identity: 'contracts.ReadCloser',
    methodNames: [],
    embedded: ['contracts.Reader', 'contracts.Closer'],
  };
  assert.deepEqual(
    implementationSearchTerms(readCloser, new Map([[reader.identity, reader], [closer.identity, closer]])),
    ['Close', 'Read'],
  );
});

test('relatedLoadingProgress/relatedLoadingMessage: reports MR-related preload progress in fixed linear package phases', () => {
  const updates = [
    relatedLoadingProgress('discovering'),
    relatedLoadingProgress('changed', 0, 2),
    relatedLoadingProgress('changed', 1, 2),
    relatedLoadingProgress('changed', 2, 2),
    relatedLoadingProgress('dependencies', 0, 1),
    relatedLoadingProgress('dependencies', 1, 1),
    relatedLoadingProgress('searching', 0, 0, { phaseDetail: 'usages' }),
    relatedLoadingProgress('searching', 0, 0, { phaseDetail: 'implementations' }),
    relatedLoadingProgress('candidates', 0, 2),
    relatedLoadingProgress('candidates', 1, 2),
    relatedLoadingProgress('candidates', 2, 2),
    relatedLoadingProgress('saving', 4, 4),
    relatedLoadingProgress('ready', 4, 4),
  ];
  assert.deepEqual(updates.map(({ percentage }) => percentage), [0, 5, 23, 40, 40, 65, 68, 72, 75, 85, 95, 98, 100]);
  assert.equal(updates.every((update, index) => index === 0 || update.percentage >= updates[index - 1].percentage), true);
  assert.equal(
    relatedLoadingMessage(relatedLoadingProgress('candidates', 1, 2)),
    'Caching likely related packages · 85% · 1 / 2 packages',
  );
});

// --- imperative shell (page/features/mr-preload.js) ------------------------

const HEAD_REF = 'a'.repeat(40);

function fakeLegacy(overrides = {}) {
  const workerCalls = [];
  const relationsByPath = overrides.relationsByPath || {};
  const legacy = {
    projectContext: () => ({ project: 'group/project', projectBase: 'https://gitlab.example/group/project' }),
    mergeRequestHeadRef: async () => HEAD_REF,
    mergeRequestIID: () => '42',
    async workerRPC(method, params) {
      workerCalls.push({ method, params });
      if (method === 'projectCacheStatus') {
        return overrides.projectCacheStatus ? overrides.projectCacheStatus(params, workerCalls.length) : { status: 'missing' };
      }
      if (method === 'packageRelations') {
        return relationsByPath[params.packagePath] || { status: 'relations', imports: [], interfaces: [], referencedImports: [] };
      }
      if (method === 'cacheMergeRequest') return { ok: true };
      throw new Error(`fakeLegacy: unexpected workerRPC(${method})`);
    },
    async loadPackage() {
      return { files: 1, downloaded: 1, cached: 0 };
    },
    async loadProject() {
      return { packages: 3 };
    },
    async listMergeRequestChangedFiles() {
      return overrides.changedFiles || ['pkg/a/a.go'];
    },
    async modulePathFor() {
      return '';
    },
    async searchProjectBlobPaths() {
      return { paths: [], status: 'complete' };
    },
    projectLoadingProgress(phase, completed = 0, total = 0, details = {}) {
      return { phase, completed, total, percentage: phase === 'ready' ? 100 : 0, ...details };
    },
    forgetStaleProjectCache() {},
    resetCaches() {},
    ...overrides.legacy,
  };
  return { legacy, workerCalls };
}

test('preloadStatus() reads the MR head\'s project cache status', async () => {
  const { legacy } = fakeLegacy({ projectCacheStatus: () => ({ status: 'complete', coverage: 'related', searchStatus: 'complete' }) });
  const handle = mount({ legacy });
  const result = await handle.preloadStatus();
  assert.deepEqual(result, { status: 'complete', coverage: 'related', searchStatus: 'complete', ref: HEAD_REF });
});

test('preloadMergeRequest() returns immediately, without loading packages, when the cache is already complete', async () => {
  const { legacy, workerCalls } = fakeLegacy({ projectCacheStatus: () => ({ status: 'complete', coverage: 'related', searchStatus: 'limited' }) });
  const handle = mount({ legacy });
  const progressCalls = [];
  const result = await handle.preloadMergeRequest({ progress: (message, update) => progressCalls.push({ message, update }) });
  assert.equal(result.status, 'complete');
  assert.equal(result.ref, HEAD_REF);
  assert.equal(workerCalls.filter((call) => call.method === 'packageRelations').length, 0);
  assert.ok(progressCalls.some(({ message }) => message === 'Related cache ready · candidate search limited'));
});

test('preloadMergeRequest() loads changed packages, then their dependencies, then verifies and caches', async () => {
  const { legacy, workerCalls } = fakeLegacy({
    changedFiles: ['pkg/a/a.go'],
    relationsByPath: {
      'pkg/a': { status: 'relations', imports: ['pkg/dep'], interfaces: [], referencedImports: [] },
      'pkg/dep': { status: 'relations', imports: [], interfaces: [], referencedImports: [] },
    },
    projectCacheStatus: (_params, callIndex) => (callIndex === 1 ? { status: 'missing' } : { status: 'complete', coverage: 'related', searchStatus: 'limited' }),
  });
  const handle = mount({ legacy });
  const progressCalls = [];
  const result = await handle.preloadMergeRequest({ progress: (message, update) => progressCalls.push({ message, update }) });

  const loadedPackagePaths = workerCalls.filter((call) => call.method === 'packageRelations').map((call) => call.params.packagePath);
  assert.deepEqual(loadedPackagePaths, ['pkg/a', 'pkg/dep'], 'changed packages load before their dependencies');

  const cacheCall = workerCalls.find((call) => call.method === 'cacheMergeRequest');
  assert.deepEqual(new Set(cacheCall.params.packagePaths), new Set(['pkg/a', 'pkg/dep']));

  assert.equal(result.status, 'complete');
  assert.ok(progressCalls.some(({ message }) => message === 'Related MR cache ready' || /Related cache ready/.test(message)));
});

test('preloadMergeRequest() throws when the verified cache status never reaches "complete"', async () => {
  const { legacy } = fakeLegacy({
    changedFiles: [],
    projectCacheStatus: () => ({ status: 'missing' }),
  });
  const handle = mount({ legacy });
  await assert.rejects(() => handle.preloadMergeRequest(), /not stored in the persistent cache/);
});

test('fullProjectStatus() reads the project (not MR-scoped) cache status', async () => {
  const { legacy, workerCalls } = fakeLegacy({ projectCacheStatus: () => ({ status: 'missing' }) });
  const handle = mount({ legacy });
  const result = await handle.fullProjectStatus();
  assert.equal(result.status, 'missing');
  assert.equal(result.ref, HEAD_REF);
  const call = workerCalls.find((c) => c.method === 'projectCacheStatus');
  assert.equal(call.params.mergeRequest, undefined, 'full-project status must not scope by mergeRequest');
});

test('preloadFullProject() skips loadProject when already complete, but still verifies', async () => {
  let loadProjectCalls = 0;
  const { legacy, workerCalls } = fakeLegacy({
    projectCacheStatus: () => ({ status: 'complete' }),
    legacy: { async loadProject() { loadProjectCalls++; return { packages: 1 }; } },
  });
  const handle = mount({ legacy });
  const progressCalls = [];
  const result = await handle.preloadFullProject({ progress: (message) => progressCalls.push(message) });
  assert.equal(loadProjectCalls, 0);
  assert.equal(result.status, 'complete');
  assert.ok(progressCalls.includes('Full project cache ready'));
  assert.equal(workerCalls.filter((c) => c.method === 'projectCacheStatus').length, 2, 'checks once, then verifies once');
});

test('preloadFullProject() forgets a stale cache entry and loads the project when incomplete', async () => {
  let loadProjectCalls = 0;
  let forgetCalls = 0;
  const { legacy } = fakeLegacy({
    projectCacheStatus: (_params, callIndex) => (callIndex === 1 ? { status: 'missing' } : { status: 'complete' }),
    legacy: {
      async loadProject() { loadProjectCalls++; return { packages: 2 }; },
      forgetStaleProjectCache({ origin, project, ref }) {
        forgetCalls++;
        assert.equal(project, 'group/project');
        assert.equal(ref, HEAD_REF);
        assert.ok(origin);
      },
    },
  });
  const handle = mount({ legacy });
  const result = await handle.preloadFullProject();
  assert.equal(forgetCalls, 1);
  assert.equal(loadProjectCalls, 1);
  assert.equal(result.status, 'complete');
});

test('preloadFullProject() rejects a non-commit ref (full-project search requires an immutable commit)', async () => {
  const { legacy } = fakeLegacy();
  const handle = mount({ legacy });
  await assert.rejects(() => handle.preloadFullProject({ ref: 'main' }), /immutable commit/);
});

test('invalidateCache() delegates to the legacy resetCaches capability', async () => {
  let resetCalls = 0;
  const { legacy } = fakeLegacy({ legacy: { resetCaches() { resetCalls++; } } });
  const handle = mount({ legacy });
  handle.invalidateCache();
  assert.equal(resetCalls, 1);
});

// --- lifecycle message routing shape (ticket 19: FEATURE_ROUTES calls
// handle[action](message), a raw chrome.runtime message object, not the
// options object these methods otherwise expect) ---------------------------

test('handle methods tolerate being called with a chrome.runtime message object instead of an options object', async () => {
  const { legacy } = fakeLegacy({ projectCacheStatus: () => ({ status: 'complete' }) });
  const handle = mount({ legacy });
  const message = { type: 'golens-preload-full-project' };
  await assert.doesNotReject(() => handle.preloadFullProject(message));
  await assert.doesNotReject(() => handle.fullProjectStatus(message));
  assert.doesNotThrow(() => handle.invalidateCache(message));
});

// --- capability-less mount (ticket 19: page/lifecycle mounts this feature
// with only {clock, settings} — no `ctx.legacy`, since lifecycle has no
// access to go-navigation.js's closures. Every method must degrade to an
// "unavailable" outcome instead of crashing.) -------------------------------

test('mount(ctx) without ctx.legacy: every status/action method degrades to {status: "unavailable"} instead of throwing', async () => {
  const handle = mount({ clock: {}, settings: {} });
  assert.deepEqual(await handle.preloadStatus(), { status: 'unavailable' });
  assert.deepEqual(await handle.preloadMergeRequest(), { status: 'unavailable' });
  assert.deepEqual(await handle.fullProjectStatus(), { status: 'unavailable' });
  assert.deepEqual(await handle.preloadFullProject(), { status: 'unavailable' });
  assert.doesNotThrow(() => handle.invalidateCache());
  handle.unmount();
});

// --- unmount -----------------------------------------------------------

test('unmount() is idempotent and safe; a second mount() after unmount works from scratch', async () => {
  const { legacy: legacyA } = fakeLegacy({ projectCacheStatus: () => ({ status: 'complete' }) });
  const handleA = mount({ legacy: legacyA });
  handleA.unmount();
  assert.doesNotThrow(() => handleA.unmount());
  assert.deepEqual(await handleA.preloadStatus(), { status: 'unavailable' }, 'post-unmount calls degrade rather than touch a torn-down module');

  const { legacy: legacyB } = fakeLegacy({ projectCacheStatus: () => ({ status: 'complete' }) });
  const handleB = mount({ legacy: legacyB });
  const result = await handleB.preloadStatus();
  assert.equal(result.status, 'complete');
  handleB.unmount();
});
