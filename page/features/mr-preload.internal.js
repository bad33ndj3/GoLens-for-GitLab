// page/features/mr-preload.internal.js — pure decision core for
// page/features/mr-preload.js (ticket 19; contract per ticket 04 §1's
// internal-seam convention, mirrored from generated-files.internal.js). No
// DOM, no chrome.*, no timers, no fetch, no worker RPC: these functions only
// turn already-fetched data (changed files, package relations, search
// results) into plans and progress/status view-models. Not part of the
// module's public interface — the dependency rules bar other modules from
// importing this file directly.
//
// planPreload is ticket 04 §3's named pure core ("planPreload(diffState) ->
// [{ packagePath, action }]"). The real algorithm is inherently incremental
// — which packages to load in the 'dependencies' and 'candidates' phases
// depends on package-relation data the shell can only get by first asking
// the worker to load the 'changed' phase's packages — so planPreload is
// called once per phase with a `diffState.kind`-discriminated input built
// from whatever the shell has learned so far, rather than once up front for
// the whole run. Every entry's `action` is 'load': preloading only ever
// decides *which packages*, never a second kind of action, but the shape
// stays `{ packagePath, action }` per ticket 04 §3 for forward compatibility
// with a future non-load action.

// dirname(path) -> the path with its final '/segment' removed, or '' when
// path has no '/'. Deliberate duplicate of go-navigation.js's own dirname:
// a one-line helper, unlikely to drift (same reasoning as
// generated-files.js's isMergeRequestDiff duplicate), not worth a shared
// platform module for one ticket's sake.
export function dirname(path) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

// isCommitSha(ref) -> true for a full 40-hex-character commit SHA.
// Deliberate duplicate of go-navigation.js's COMMIT_SHA regex test, for the
// same reason as dirname above.
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
export function isCommitSha(ref) {
  return COMMIT_SHA.test(ref || '');
}

// planPreload(diffState) -> [{ packagePath, action: 'load' }]
// diffState is one of:
//   { kind: 'changed', changedFiles }
//     -> the seed packages: unique package paths of changed Go files,
//        sorted for deterministic load order.
//   { kind: 'dependencies', seedPackages, relationsByPackage, loadedPackagePaths }
//     -> the seed packages' direct import dependencies not already loaded,
//        sorted for deterministic load order. `relationsByPackage` is a
//        Map<packagePath, { imports }>, already populated by the shell for
//        every seed package.
//   { kind: 'candidates', candidatePackagePaths, loadedPackagePaths, maxCandidates }
//     -> up to `maxCandidates` (default Infinity) of the given candidate
//        package paths not already loaded, sorted for deterministic order.
// Any other/missing `kind` yields []. Total: never throws.
export function planPreload(diffState) {
  const kind = diffState?.kind;
  if (kind === 'changed') {
    const paths = [...new Set((diffState.changedFiles || []).map(dirname))].sort();
    return paths.map((packagePath) => ({ packagePath, action: 'load' }));
  }
  if (kind === 'dependencies') {
    const loaded = diffState.loadedPackagePaths || new Set();
    const relations = diffState.relationsByPackage || new Map();
    const imports = new Set();
    for (const seedPackagePath of diffState.seedPackages || []) {
      for (const importPath of relations.get(seedPackagePath)?.imports || []) imports.add(importPath);
    }
    return [...imports].filter((packagePath) => !loaded.has(packagePath)).sort().map((packagePath) => ({ packagePath, action: 'load' }));
  }
  if (kind === 'candidates') {
    const loaded = diffState.loadedPackagePaths || new Set();
    const max = Number.isFinite(diffState.maxCandidates) ? diffState.maxCandidates : Infinity;
    const paths = [...new Set(diffState.candidatePackagePaths || [])]
      .filter((packagePath) => !loaded.has(packagePath))
      .sort()
      .slice(0, max);
    return paths.map((packagePath) => ({ packagePath, action: 'load' }));
  }
  return [];
}

// mergeSearchStatus(current, next) -> the more restrictive of two optional
// search-coverage states ('complete' > 'limited' > 'unavailable'). Total.
export function mergeSearchStatus(current, next) {
  if (current === 'unavailable' || next === 'unavailable') return 'unavailable';
  if (current === 'limited' || next === 'limited') return 'limited';
  return 'complete';
}

// relatedReadyMessage(searchStatus) -> the user-facing label for a completed
// MR-related preload, qualified by how thorough the candidate search was.
export function relatedReadyMessage(searchStatus) {
  if (searchStatus === 'unavailable') return 'Related cache ready · code search unavailable';
  if (searchStatus === 'limited') return 'Related cache ready · candidate search limited';
  return 'Related MR cache ready';
}

// selectRelevantInterfaces({ relations, seedPackages, referencedImports }) ->
// { availableInterfaces, relevantInterfaces }, both Map<identity, record>.
// `relations` is a Map<packagePath, { interfaces }>, already populated by
// the shell. `availableInterfaces` is every interface across all fetched
// relations; `relevantInterfaces` is the subset worth searching
// implementations for: every interface declared in a seed package, plus
// every interface referenced (by name) from another loaded package's
// `referencedImports`. Total: never throws on missing/empty input.
export function selectRelevantInterfaces({ relations, seedPackages, referencedImports } = {}) {
  const relationsByPackage = relations || new Map();
  const availableInterfaces = new Map();
  for (const relation of relationsByPackage.values()) {
    for (const interfaceRecord of relation.interfaces || []) availableInterfaces.set(interfaceRecord.identity, interfaceRecord);
  }
  const relevantInterfaces = new Map();
  for (const packagePath of seedPackages || []) {
    for (const interfaceRecord of relationsByPackage.get(packagePath)?.interfaces || []) {
      relevantInterfaces.set(interfaceRecord.identity, interfaceRecord);
    }
  }
  for (const reference of referencedImports || []) {
    const interfaceRecord = relationsByPackage.get(reference.packagePath)?.interfaces?.find(({ name }) => name === reference.name);
    if (interfaceRecord) relevantInterfaces.set(interfaceRecord.identity, interfaceRecord);
  }
  return { availableInterfaces, relevantInterfaces };
}

// implementationSearchTerms(interfaceRecord, interfacesByIdentity) -> the
// sorted, de-duplicated set of method names (including those inherited via
// embedded interfaces) worth searching for as candidate implementations.
// Total: never throws on a missing record or cyclic/missing embedded refs.
export function implementationSearchTerms(interfaceRecord, interfacesByIdentity = new Map()) {
  const terms = new Set();
  const visited = new Set();
  const collect = (record) => {
    if (!record || visited.has(record.identity)) return;
    visited.add(record.identity);
    for (const methodName of record.methodNames || []) {
      if (methodName) terms.add(methodName);
    }
    for (const embeddedIdentity of record.embedded || []) collect(interfacesByIdentity.get(embeddedIdentity));
  };
  collect(interfaceRecord);
  return [...terms].sort();
}

// relatedLoadingProgress(phase, completed, total, details) -> the
// view-model reported while preloading MR-related packages, in fixed linear
// phases (changed 5-40%, dependencies 40-65%, searching 65-75%, candidates
// 75-95%, saving 98%, ready 100%). Total: clamps completed/total to sane
// bounds like generated-files.internal.js's siblings.
export function relatedLoadingProgress(phase, completed = 0, total = 0, details = {}) {
  const ranges = {
    changed: [5, 40],
    dependencies: [40, 65],
    candidates: [75, 95],
  };
  const safeTotal = Math.max(0, Number.isFinite(total) ? Math.floor(total) : 0);
  const safeCompleted = Math.min(safeTotal, Math.max(0, Number.isFinite(completed) ? Math.floor(completed) : 0));
  const fraction = Math.max(0, Math.min(1, Number.isFinite(details.packageFraction) ? details.packageFraction : 0));
  let percentage = 0;
  if (phase === 'ready') percentage = 100;
  else if (phase === 'searching') percentage = details.phaseDetail === 'implementations' ? 72 : 68;
  else if (phase === 'saving') percentage = 98;
  else if (ranges[phase]) {
    const [start, end] = ranges[phase];
    const progress = safeTotal ? (safeCompleted + fraction) / safeTotal : 1;
    percentage = Math.round(start + Math.min(1, progress) * (end - start));
  }
  const { packageFraction: _packageFraction, ...rest } = details;
  return { phase, completed: safeCompleted, total: safeTotal, percentage, unit: 'packages', ...rest };
}

// relatedLoadingMessage(progress) -> the user-facing label for a
// relatedLoadingProgress() view-model.
export function relatedLoadingMessage(progress) {
  if (progress.phase === 'discovering') return 'Discovering changed Go packages…';
  if (progress.phase === 'searching') {
    return progress.phaseDetail === 'implementations'
      ? `Finding likely implementations · ${progress.percentage}%`
      : `Finding likely usages · ${progress.percentage}%`;
  }
  if (progress.phase === 'saving') return `Saving related cache · ${progress.percentage}%`;
  if (progress.phase === 'ready') return 'Related MR cache ready';
  const labels = {
    changed: 'Caching changed packages',
    dependencies: 'Caching direct dependencies',
    candidates: 'Caching likely related packages',
  };
  return `${labels[progress.phase] || 'Caching related packages'} · ${progress.percentage}% · ${progress.completed} / ${progress.total} packages`;
}
