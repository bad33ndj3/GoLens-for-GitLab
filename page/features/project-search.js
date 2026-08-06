// page/features/project-search.js — orchestrates the "search complete
// project" flow: term-by-term blob-path search, package indexing, then a
// rerun of the original query against the now-complete package set. No DOM
// of its own. Carved out of go-navigation.js's former
// searchCompleteProject()/openFullSearch()/runFullSearch(); the fullscreen
// modal, minimize-to-chip, and Escape-guard machinery that used to live
// here have been deleted entirely — clicking "Search complete project" now
// shows a small inline loading state INSIDE the existing code-intel
// popover (owned by code-intel.js), not a separate modal. This module's
// only job is to run the search and report the outcome back through the
// `legacy` bag into that popover.
//
// mount(ctx) -> { unmount, open(result, pointer), close(opts), cancel() }.
//
// The blob-path search (searchProjectBlobPaths), package loader/cache
// (loadPackage), and popover-rendering functions are all go-navigation.js's
// own bound functions, injected via `ctx.legacy` — a capability bag built
// by page/main.js's self-bridge, not by page/lifecycle, which has no access
// to go-navigation.js's closures. When page/main.js mounts this feature for
// message routing, `ctx` carries no `legacy` bag; every method below
// degrades to an `unavailable`/`not-open` result instead of crashing.
import {
  canOpen,
  searchTerms,
  blobPathsComplete,
  candidatePackagePaths,
  completeProjectScope,
  rerunQueryKind,
  NO_TERMS_MESSAGE,
  INCOMPLETE_MESSAGE,
  DEFAULT_FAILURE_MESSAGE,
  CANCELLED_MESSAGE,
} from './project-search.internal.js';

export function mount(ctx = {}) {
  const legacy = ctx.legacy || null;
  let unmounted = false;
  let current = null; // { result, pointer, controller, status }

  function unavailable(extra = {}) {
    return { kind: 'unavailable', ...extra };
  }

  // --- search orchestration ------------------------------------------------

  async function searchCompleteProject(search) {
    const parsed = searchTerms(search.result);
    if (parsed.kind === 'noTerms') return { kind: 'noTerms' };
    const terms = parsed.terms;
    const candidatePaths = [];
    for (let index = 0; index < terms.length; index++) {
      const result = await legacy.searchProjectBlobPaths(terms[index], search.result.request.ref, {
        maxPages: Infinity,
        maxPaths: Infinity,
        searchType: 'basic',
        signal: search.controller.signal,
      });
      if (!blobPathsComplete(result.status)) return { kind: 'incomplete' };
      candidatePaths.push(...result.paths);
    }
    const packages = candidatePackagePaths(candidatePaths);
    for (let index = 0; index < packages.length; index++) {
      await legacy.loadPackage(packages[index], search.result.request.ref, () => {}, search.controller.signal);
    }
    return { kind: 'complete', scope: completeProjectScope(packages.length) };
  }

  async function rerunQuery(search, scope) {
    const request = search.result.request;
    return rerunQueryKind(request) === 'references'
      ? legacy.findReferencesAt(request.target, request.definition, '', scope)
      : legacy.findImplementationsAt(request.target, request.definition, undefined, '', scope);
  }

  async function runSearch(search) {
    if (search.status === 'busy') return;
    search.status = 'busy';
    search.controller = new AbortController();
    try {
      const outcome = await searchCompleteProject(search);
      if (current !== search || !legacy.isEnabled()) return;
      if (outcome.kind !== 'complete') {
        current = null;
        legacy.showResult(search.result, search.pointer);
        legacy.pinPopover(search.pointer);
        legacy.toast(outcome.kind === 'noTerms' ? NO_TERMS_MESSAGE : INCOMPLETE_MESSAGE);
        return;
      }
      const refreshed = await rerunQuery(search, outcome.scope);
      if (current !== search || !legacy.isEnabled()) return;
      current = null;
      legacy.showResult(refreshed, search.pointer);
      legacy.pinPopover(search.pointer);
    } catch (error) {
      if (current !== search) return;
      current = null;
      legacy.showResult(search.result, search.pointer);
      legacy.pinPopover(search.pointer);
      legacy.toast(error?.message || DEFAULT_FAILURE_MESSAGE);
    }
  }

  // --- public handle ---------------------------------------------------

  // open(result, pointer) -> { kind: 'started', ready } | { kind: 'missingRef' | 'unavailable' }
  // `ready` is the in-flight search's completion promise — production
  // callers (a synchronous popover click handler) never await it, matching
  // go-navigation.js's former fire-and-forget `runFullSearch();` call;
  // exposed only so tests can deterministically await the background
  // search instead of racing it.
  function open(result, pointer) {
    if (unmounted || !legacy) return unavailable();
    if (!canOpen(result)) return { kind: 'missingRef' };
    current?.controller?.abort();
    current = { result, pointer, status: 'idle', controller: null };
    legacy.showSearchProgress('Searching complete project…', pointer);
    const ready = runSearch(current);
    return { kind: 'started', ready };
  }

  // close(opts) -> { kind: 'closed' | 'not-open' | 'unavailable' }
  // `restorePopover: false` is the navigation/unmount cleanup path
  // (go-navigation.js's former teardown() only aborted; it never called
  // showResult/pinPopover/toast, since the popover UI is about to be torn
  // down in the same synchronous call anyway). Nothing currently calls this
  // with the default `true` (the old in-dialog Cancel button is gone, and
  // the popover's close button now calls cancel() instead), but the method
  // stays for that cleanup path.
  function close({ restorePopover = true } = {}) {
    if (unmounted || !legacy) return unavailable();
    if (!current) return { kind: 'not-open' };
    const search = current;
    search.controller?.abort();
    current = null;
    if (restorePopover) {
      legacy.showResult(search.result, search.pointer);
      legacy.pinPopover(search.pointer);
      legacy.toast(CANCELLED_MESSAGE);
    }
    return { kind: 'closed' };
  }

  // cancel() -> { kind: 'closed' | 'not-open' | 'unavailable' }. What the
  // code-intel popover's close (X) button calls when a full-project search
  // is in progress. Unlike close(), it does NOT re-show the popover result
  // — the popover is already being closed by the caller — but it still
  // toasts, so the user knows the search was cancelled rather than failed.
  function cancel() {
    if (unmounted || !legacy) return unavailable();
    if (!current) return { kind: 'not-open' };
    current.controller?.abort();
    current = null;
    legacy.toast(CANCELLED_MESSAGE);
    return { kind: 'closed' };
  }

  return {
    unmount() {
      if (unmounted) return;
      unmounted = true;
      current?.controller?.abort();
      current = null;
    },
    open,
    close,
    cancel,
  };
}
