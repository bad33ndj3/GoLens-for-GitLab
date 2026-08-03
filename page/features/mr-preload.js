// page/features/mr-preload.js — hides: which packages/searches to preload
// for the current merge request (and, separately, the whole project) and in
// what order (ticket 03 §2; interface ticket 04 §3, handle:
// `{ unmount, preloadMergeRequest, preloadStatus, preloadFullProject,
// fullProjectStatus, invalidateCache }`). Pure decision core in
// mr-preload.internal.js (`planPreload` plus the progress/status
// view-model and search-term helpers); this shell executes the RPC calls
// and GitLab fetches the plan implies.
//
// Ticket 19's real entanglement: the original five functions
// (preloadMergeRequest/mergeRequestPreloadStatus/preloadFullProject/
// fullProjectPreloadStatus/invalidateCacheState) lived in go-navigation.js
// sharing its worker-RPC dispatch (`workerRPC`), package/project loaders
// (`loadPackage`/`loadProject`), and MR/GitLab-context fetch helpers
// (`projectContext`/`mergeRequestHeadRef`/`mergeRequestIID`/
// `listMergeRequestChangedFiles`/`modulePathFor`/`searchProjectBlobPaths`).
// Those are also used by hover/click resolution, which hasn't migrated out
// of go-navigation.js yet (later ticket) — so they can't move here without
// duplicating GitLab pagination/session logic ticket 03 §3 explicitly
// warns against, and can't be deleted from go-navigation.js either.
// Ticket 03 §3's escape hatch ("capabilities that lifecycle injects at
// mount") is exactly for this: `ctx.legacy` is a capability bag of
// go-navigation.js's own bound functions, injected by the bridge
// go-navigation.js installs for itself (see its "Bridge onto
// page/features/mr-preload.js" comment) — not by page/lifecycle, since
// page/lifecycle has no access to go-navigation.js's closures (that would
// be exactly the forbidden globalThis contract ticket 03 §3 bars). When
// page/main.js mounts this feature through page/lifecycle for message
// routing (`golens-preload-full-project` etc., per FEATURE_ROUTES), `ctx`
// carries no `legacy` bag; every method below degrades to an `unavailable`
// result instead of crashing — see mount()'s `legacy` guard below and the
// ticket's final report for why this instance stays inert today.
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
} from './mr-preload.internal.js';

const RELATED_CACHE_MAX_CANDIDATE_PACKAGES = 10;
const RELATED_CACHE_MAX_SEARCH_QUERIES = 8;
const RELATED_CACHE_SEARCH_PAGES = 2;

function packagePaths(entries) {
  return entries.map((entry) => entry.packagePath);
}

export function mount(ctx = {}) {
  const legacy = ctx.legacy || null;
  let unmounted = false;

  function unavailable(extra = {}) {
    return { status: 'unavailable', ...extra };
  }

  // --- MR-scoped preload ------------------------------------------------

  async function preloadStatus() {
    if (unmounted || !legacy) return unavailable();
    const context = legacy.projectContext();
    if (!context) throw new Error('GitLab project context is unavailable.');
    const ref = await legacy.mergeRequestHeadRef();
    const mergeRequest = legacy.mergeRequestIID();
    const result = await legacy.workerRPC('projectCacheStatus', { origin: location.origin, project: context.project, mergeRequest, ref });
    return { ...result, ref };
  }

  async function loadPhase({ context, ref, phase, pendingPackagePaths, loaded, relations, tracker, report }) {
    const pending = pendingPackagePaths.filter((packagePath) => !loaded.has(packagePath));
    if (!pending.length) {
      report(relatedLoadingProgress(phase, 0, 0, {
        cached: tracker.cached,
        downloaded: tracker.downloaded,
        remaining: 0,
        packages: loaded.size,
      }));
      return;
    }
    for (let index = 0; index < pending.length; index++) {
      const packagePath = pending[index];
      const label = packagePath || 'root package';
      const result = await legacy.loadPackage(packagePath, ref, (_message, update) => {
        const packageFraction = update.phase === 'discovering' ? 0 : Math.min(1, (update.percentage || 0) / 100);
        report(relatedLoadingProgress(phase, index, pending.length, {
          packageFraction,
          cached: tracker.cached + (update.cached || 0),
          downloaded: tracker.downloaded + (update.downloaded || 0),
          remaining: Math.max(0, (update.total || 0) - (update.completed || 0)),
          packages: loaded.size,
        }));
      });
      const files = result.files || 0;
      const downloaded = result.downloaded || 0;
      tracker.files += files;
      tracker.downloaded += downloaded;
      tracker.cached += Number.isFinite(result.cached) ? result.cached : Math.max(0, files - downloaded);
      const relation = await legacy.workerRPC('packageRelations', { origin: location.origin, project: context.project, ref, packagePath });
      if (relation.status !== 'relations') throw new Error(`Unable to inspect related package ${label}`);
      relations.set(packagePath, relation);
      loaded.add(packagePath);
      report(relatedLoadingProgress(phase, index + 1, pending.length, {
        cached: tracker.cached,
        downloaded: tracker.downloaded,
        remaining: 0,
        packages: loaded.size,
      }));
    }
  }

  async function preloadMergeRequest({ progress = () => {} } = {}) {
    if (unmounted || !legacy) return unavailable();
    const context = legacy.projectContext();
    if (!context) throw new Error('GitLab project context is unavailable.');
    const ref = await legacy.mergeRequestHeadRef();
    const mergeRequest = legacy.mergeRequestIID();
    const scope = { origin: location.origin, project: context.project, mergeRequest, ref };
    const cacheStatus = await legacy.workerRPC('projectCacheStatus', scope);
    if (cacheStatus.status === 'complete') {
      progress(relatedReadyMessage(cacheStatus.searchStatus), legacy.projectLoadingProgress('ready', 0, 0, {
        coverage: cacheStatus.coverage,
        searchStatus: cacheStatus.searchStatus,
      }));
      return { ...cacheStatus, ref };
    }

    const tracker = { files: 0, cached: 0, downloaded: 0 };
    const relations = new Map();
    const loaded = new Set();
    const report = (update, message = relatedLoadingMessage(update)) => progress(message, update);
    const reportDiscovery = (message, details = {}) => report(relatedLoadingProgress('discovering', 0, 0, {
      cached: tracker.cached,
      downloaded: tracker.downloaded,
      remaining: 0,
      packages: loaded.size,
      ...details,
    }), message);

    reportDiscovery('Discovering changed Go packages…');
    const changedFiles = await legacy.listMergeRequestChangedFiles();
    const seedPackages = packagePaths(planPreload({ kind: 'changed', changedFiles }));
    await loadPhase({ context, ref, phase: 'changed', pendingPackagePaths: seedPackages, loaded, relations, tracker, report });

    const directDependencies = packagePaths(planPreload({
      kind: 'dependencies',
      seedPackages,
      relationsByPackage: relations,
      loadedPackagePaths: loaded,
    }));
    await loadPhase({ context, ref, phase: 'dependencies', pendingPackagePaths: directDependencies, loaded, relations, tracker, report });

    // The sidebar intentionally performs a bounded candidate search. Deeper
    // traversal stays lazy, while the popup remains the exhaustive option.
    let searchStatus = 'limited';
    const modulePath = await legacy.modulePathFor(ref);
    const referencedImports = seedPackages.flatMap((packagePath) => relations.get(packagePath)?.referencedImports || []);
    const { availableInterfaces, relevantInterfaces } = selectRelevantInterfaces({ relations, seedPackages, referencedImports });

    const searchCache = new Map();
    let searchQueries = 0;
    const searchCandidates = async (query) => {
      if (!searchCache.has(query)) {
        if (searchQueries >= RELATED_CACHE_MAX_SEARCH_QUERIES) return new Set();
        searchQueries++;
        searchCache.set(query, legacy.searchProjectBlobPaths(query, ref, {
          maxPages: RELATED_CACHE_SEARCH_PAGES,
          maxPaths: RELATED_CACHE_MAX_CANDIDATE_PACKAGES * 2,
        }));
      }
      const result = await searchCache.get(query);
      searchStatus = mergeSearchStatus(searchStatus, result.status);
      return new Set(result.paths.map(dirname));
    };
    const candidates = new Set();
    if (!modulePath) {
      searchStatus = 'limited';
    } else {
      report(relatedLoadingProgress('searching', 0, 0, { phaseDetail: 'usages' }));
      for (const packagePath of seedPackages) {
        const importPath = [modulePath, packagePath].filter(Boolean).join('/');
        for (const candidate of await searchCandidates(importPath)) candidates.add(candidate);
      }

      report(relatedLoadingProgress('searching', 0, 0, { phaseDetail: 'implementations' }));
      for (const interfaceRecord of relevantInterfaces.values()) {
        for (const term of implementationSearchTerms(interfaceRecord, availableInterfaces)) {
          for (const candidate of await searchCandidates(term)) candidates.add(candidate);
        }
      }
    }

    const boundedCandidates = packagePaths(planPreload({
      kind: 'candidates',
      candidatePackagePaths: [...candidates],
      loadedPackagePaths: loaded,
      maxCandidates: RELATED_CACHE_MAX_CANDIDATE_PACKAGES,
    }));
    await loadPhase({ context, ref, phase: 'candidates', pendingPackagePaths: boundedCandidates, loaded, relations, tracker, report });

    const finalProgress = relatedLoadingProgress('saving', loaded.size, loaded.size, {
      cached: tracker.cached,
      downloaded: tracker.downloaded,
      remaining: 0,
      packages: loaded.size,
      searchStatus,
    });
    report(finalProgress, `Saving related cache · ${loaded.size} packages · ${finalProgress.percentage}%`);
    await legacy.workerRPC('cacheMergeRequest', { ...scope, packagePaths: [...loaded], searchStatus });
    const verified = await legacy.workerRPC('projectCacheStatus', scope);
    if (verified.status !== 'complete') throw new Error('Related MR sources were indexed but not stored in the persistent cache.');
    progress(relatedReadyMessage(verified.searchStatus), relatedLoadingProgress('ready', loaded.size, loaded.size, {
      cached: tracker.cached,
      downloaded: tracker.downloaded,
      remaining: 0,
      packages: loaded.size,
      searchStatus: verified.searchStatus,
    }));
    return { ...verified, ref };
  }

  // --- full-project preload ----------------------------------------------

  async function fullProjectStatus() {
    if (unmounted || !legacy) return unavailable();
    const context = legacy.projectContext();
    if (!context) throw new Error('GitLab project context is unavailable.');
    const ref = await legacy.mergeRequestHeadRef();
    const result = await legacy.workerRPC('projectCacheStatus', { origin: location.origin, project: context.project, ref });
    return { ...result, ref };
  }

  async function preloadFullProject({ progress = () => {}, ref: requestedRef = '' } = {}) {
    if (unmounted || !legacy) return unavailable();
    const context = legacy.projectContext();
    if (!context) throw new Error('GitLab project context is unavailable.');
    const ref = (typeof requestedRef === 'string' && requestedRef) || await legacy.mergeRequestHeadRef();
    if (!isCommitSha(ref)) throw new Error('Full-project search requires an immutable commit.');
    const cacheStatus = await legacy.workerRPC('projectCacheStatus', { origin: location.origin, project: context.project, ref });
    if (cacheStatus.status !== 'complete') {
      // Key format (origin/project/ref join) is go-navigation.js's own
      // internal `state.projects`/`state.projectProgressListeners` cache
      // key shape, not this module's concern: the capability takes the raw
      // parts and computes the key itself, so that internal format stays
      // wherever `state` lives.
      legacy.forgetStaleProjectCache({ origin: location.origin, project: context.project, ref });
      await legacy.loadProject(ref, progress);
    } else {
      progress('Full project cache ready', legacy.projectLoadingProgress('ready'));
    }
    const verified = await legacy.workerRPC('projectCacheStatus', { origin: location.origin, project: context.project, ref });
    if (verified.status !== 'complete') throw new Error('Project sources were indexed but not stored in the persistent cache.');
    return { ...verified, ref };
  }

  // --- cache invalidation --------------------------------------------

  function invalidateCache() {
    if (unmounted || !legacy) return;
    legacy.resetCaches();
  }

  return {
    unmount() {
      unmounted = true;
    },
    preloadMergeRequest,
    preloadStatus,
    preloadFullProject,
    fullProjectStatus,
    invalidateCache,
  };
}
