// page/features/project-search.internal.js — pure decision core for
// page/features/project-search.js. No DOM, no chrome.*, no timers, no fetch,
// no worker RPC: these functions only turn already-fetched data (a popover
// result/request, blob-search pages, candidate paths) into plans, progress
// numbers, and kind-discriminated domain outcomes. Not part of the module's
// public interface — the dependency rules bar other modules from importing
// this file directly.

// dirname(path) -> the directory portion of a slash-separated path, or ''
// for a root-level path. Byte-identical to go-navigation.js's former
// dirname() and to mr-preload.internal.js's own copy — duplicated per the
// keyboard-nav.internal.js/onboarding.internal.js precedent (a one-line,
// unlikely-to-drift helper isn't worth a shared platform module). Total.
export function dirname(path) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

// Domain-outcome message text, byte-identical to the two strings
// go-navigation.js's former searchCompleteProject() used to throw (and
// which its catch-all rendered verbatim into the progress panel). Kept as
// named constants so the shell and its tests share one source of truth.
export const NO_TERMS_MESSAGE = 'This interface has no searchable methods, so code search cannot prove complete coverage.';
export const INCOMPLETE_MESSAGE = 'GitLab code search could not prove complete coverage for this project.';
export const DEFAULT_FAILURE_MESSAGE = 'Full-project search failed';
export const CANCELLED_MESSAGE = 'Complete project search cancelled. Coverage remains incomplete.';

// canOpen(result) -> whether open() may proceed, mirroring go-navigation.js's
// former openFullSearch() early-return guard (`if (!result.request?.ref)
// return;`) as an explicit kind instead of a silent no-op. Total.
export function canOpen(result) {
  return Boolean(result?.request?.ref);
}

// searchTerms(result) -> the terms searchCompleteProject() must prove
// complete coverage for, mirroring go-navigation.js's former inline
// extraction exactly: `result.request.kind === 'references'` searches for
// the definition's own name; any other request kind (implementations) uses
// `result.searchTerms` — a field on the *result*, sibling to `request`, not
// inside it (easy to misplace; go-navigation.js reads
// `search.result.searchTerms`, not `search.result.request.searchTerms`).
// An empty term list is the 'noTerms' domain outcome (formerly a thrown
// Error) instead of a silent [] the caller must remember to check. Total.
export function searchTerms(result) {
  const terms = result?.request?.kind === 'references'
    ? [result.request.definition?.name].filter(Boolean)
    : result?.searchTerms || [];
  return terms.length ? { kind: 'terms', terms } : { kind: 'noTerms' };
}

// blobPathsComplete(status) -> whether a searchProjectBlobPaths() page
// result proves complete coverage, mirroring the former
// `result.status !== 'complete'` check. Total.
export function blobPathsComplete(status) {
  return status === 'complete';
}

// candidatePackagePaths(paths) -> the sorted, de-duplicated package
// directories implied by a set of matching blob paths, mirroring the former
// `paths.map(dirname).forEach(candidatePackages.add)` plus the later
// `[...candidatePackages].sort()`. Total.
export function candidatePackagePaths(paths) {
  return [...new Set(paths.map(dirname))].sort();
}

// completeProjectScope(packageCount) -> the scope object go-navigation.js's
// showResult()/resultScopeText() consume, byte-identical to
// searchCompleteProject()'s former return value shape. Total.
export function completeProjectScope(packageCount) {
  return {
    kind: 'completeProjectSearch',
    packageCount,
    complete: true,
    searchStatus: 'complete',
    strategy: 'gitlabCodeSearch',
  };
}

// rerunQueryKind(request) -> which legacy resolution function open()'s
// rerun step must call, mirroring go-navigation.js's former
// rerunFullSearchQuery() dispatch (`request.kind === 'references'`). Total.
export function rerunQueryKind(request) {
  return request?.kind === 'references' ? 'references' : 'implementations';
}
