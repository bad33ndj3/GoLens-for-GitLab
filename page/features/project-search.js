// page/features/project-search.js — hides: the "search complete project"
// modal's DOM, its paging/progress state machine, and blob-path search
// (ticket 20; boundary from ticket 03 §2, interface from ticket 04 §3).
// Carved out of go-navigation.js's former searchCompleteProject()/
// openFullSearch()/runFullSearch()/minimizeFullSearch()/restoreFullSearch()/
// cancelFullSearch(). Pure decision core in project-search.internal.js;
// DOM/messaging/paging orchestration in this shell.
//
// mount(ctx) -> { unmount, open(result, pointer), close(opts), minimize() }.
// `minimize` is a 4th method beyond ticket 20's literal `{unmount, open,
// close}` text — see its own doc comment on the returned handle below for
// why go-navigation.js's Escape handler needs it.
//
// Ticket 20's real entanglement, same shape ticket 19 (mr-preload) hit: the
// original functions shared go-navigation.js's blob-path search
// (searchProjectBlobPaths), package loader/cache (loadPackage, itself
// routed through workerRPC -> platform/rpc-client per ticket 09), and the
// popover-rendering functions (showResult/pinPopover/hidePopover/toast) —
// all of which are also used by hover/click resolution, which hasn't
// migrated out of go-navigation.js yet (later ticket). Ticket 03 §3's
// escape hatch applies exactly as it did for mr-preload: `ctx.legacy` is a
// capability bag of go-navigation.js's own bound functions, injected by the
// self-bridge go-navigation.js installs for itself (see its "Bridge onto
// page/features/project-search.js" comment) — not by page/lifecycle, which
// has no access to go-navigation.js's closures. When page/main.js mounts
// this feature for message routing, `ctx` carries no `legacy` bag; every
// method below degrades to an `unavailable`/`not-open` result instead of
// crashing (mirrors mr-preload.js's `legacy` guard).
//
// Modal DOM is entirely private to this module: its own shadow host
// (`#golens-project-search-root`), created lazily on the first open() (not
// eagerly at mount — this module is double-mounted, once inert via
// page/main.js and once functional via go-navigation.js's self-bridge;
// eager host creation would render two modal hosts / two chips on a real
// page). `--golens-*` custom properties reach it via inheritance from the
// document `:root` rule in golens-theme.css (verified: that stylesheet
// already targets `:root`, not just specific host ids, so no CSS file
// change was needed for this ticket).
//
// Fidelity finding, corrected after a first (wrong) read: go-navigation.js's
// document-level Escape handler has an `fullSearchOpen` branch that calls
// minimizeFullSearch(). The guard immediately above it
// (`target?.closest?.('...dialog, [role="dialog"], [aria-modal="true"]')`)
// only suppresses this branch while the dialog *holds focus* — via
// `event.composedPath()`, whose in-shadow entries (the focused button, the
// dialog) match `closest(...)`. It does NOT suppress it once focus has
// moved out of the dialog without closing it (e.g. a click on the
// backdrop, a non-focusable div, blurs to `<body>`): at that point
// `document.activeElement` is `<body>` — note this is the *host* element
// the browser retargets to when checked from outside a shadow root, not
// the actual focused descendant `shadowRoot.activeElement` would give, so
// composing this module's own host into the guard wouldn't help either —
// and `document.activeElement.closest(...)` finds nothing, so the guard
// no longer returns early and go-navigation.js's Escape handler reaches
// the `fullSearchOpen` branch. Real, reachable behavior, kept via the
// `minimize()` handle method above (not deleted, as an earlier pass here
// incorrectly concluded from the focused-button case alone).
import {
  canOpen,
  searchTerms,
  blobSearchPercentage,
  packageIndexPercentage,
  termSearchMessage,
  packageIndexMessage,
  blobPathsComplete,
  candidatePackagePaths,
  completeProjectScope,
  rerunQueryKind,
  focusTargetForStatus,
  chipLabel,
  NO_TERMS_MESSAGE,
  INCOMPLETE_MESSAGE,
  DEFAULT_FAILURE_MESSAGE,
  CANCELLED_MESSAGE,
} from './project-search.internal.js';

const MARKUP = `
  <style>
    .full-search-backdrop { position:fixed; inset:0; z-index:var(--golens-z-modal,2147483647); display:grid; place-items:center; padding:20px; background:rgba(0,0,0,.58); pointer-events:auto; }
    .full-search-backdrop[hidden] { display:none; }
    .full-search-dialog { width:min(480px,100%); padding:var(--golens-space-4,16px); border:1px solid var(--golens-border-default,#46515d); border-radius:var(--golens-radius-lg,9px); background:var(--golens-surface-panel,#1d2126); color:var(--golens-text-primary,#f4f1ed); box-shadow:var(--golens-shadow-lg,0 24px 72px rgba(2,12,21,.58)); font:13px/1.5 var(--golens-font-sans,sans-serif); }
    .full-search-header { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--golens-space-3,12px); }
    .full-search-title { margin:0; font-size:15px; }
    .full-search-copy { margin:8px 0 14px; color:var(--golens-text-secondary,#c7c2bb); }
    .full-search-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; }
    .full-search-actions button, .full-search-chip { padding:7px 10px; border:1px solid var(--golens-border-default,#46515d); border-radius:var(--golens-radius-sm,5px); background:var(--golens-surface-raised,#242a31); color:var(--golens-text-primary,#f4f1ed); font:inherit; cursor:pointer; }
    .full-search-actions button:hover, .full-search-chip:hover { border-color:var(--golens-border-strong,#55616e); background:var(--golens-surface-hover,#2c333b); }
    .full-search-actions button[hidden] { display:none; }
    .full-search-chip { position:fixed; right:18px; bottom:18px; z-index:var(--golens-z-modal,2147483647); pointer-events:auto; }
    .full-search-chip[hidden] { display:none; }
    .header-action { display:inline-flex; width:28px; height:28px; align-items:center; justify-content:center; padding:0; border:1px solid transparent; border-radius:var(--golens-radius-sm,5px); background:transparent; color:var(--golens-text-secondary,#c7c2bb); font:inherit; cursor:pointer; }
    .header-action:hover { border-color:var(--golens-border-default,#46515d); background:var(--golens-surface-hover,#2c333b); color:var(--golens-text-primary,#f4f1ed); }
    .header-action:focus-visible { outline:2px solid var(--golens-focus-ring,#68c5e1); outline-offset:1px; }
    .loading-progress { display:grid; gap:var(--golens-space-2,8px); margin:0 0 var(--golens-space-3,12px); padding:var(--golens-space-2,8px) var(--golens-space-3,12px); border:1px solid color-mix(in srgb,var(--golens-primary,#e97840) 35%,var(--golens-border-subtle,#353d46)); border-radius:var(--golens-radius-sm,5px); background:var(--golens-primary-soft,rgba(233,120,64,.12)); }
    .loading-progress-meta { display:flex; justify-content:space-between; gap:var(--golens-space-2,8px); font-size:10px; }
    .loading-progress-phase { overflow:hidden; font-weight:700; text-overflow:ellipsis; white-space:nowrap; }
    .loading-progress-count { flex:0 0 auto; color:var(--golens-primary-hover,#f28a54); font:700 10px/1.45 var(--golens-font-mono,monospace); font-variant-numeric:tabular-nums; }
    .loading-track { height:4px; overflow:hidden; border-radius:999px; background:var(--golens-surface-pressed,#343c45); }
    .loading-track > i { display:block; width:0; height:100%; border-radius:inherit; background:var(--golens-primary,#e97840); transition:width var(--golens-motion-base,180ms); }
    @media (prefers-reduced-motion:reduce) { .loading-track > i { transition:none; } }
  </style>
  <div class="full-search-backdrop" hidden><section class="full-search-dialog" role="dialog" aria-modal="true" aria-labelledby="golens-full-search-title"><div class="full-search-header"><div><h2 id="golens-full-search-title" class="full-search-title">Search complete project</h2><p class="full-search-copy">GoLens searches the complete project at this commit, then downloads only matching Go packages.</p></div><button class="header-action full-search-minimize" type="button" aria-label="Minimize full-project search">−</button></div><div class="loading-progress full-search-progress" role="status" aria-live="polite"><div class="loading-progress-meta"><span class="loading-progress-phase">Preparing project</span><span class="loading-progress-count">0%</span></div><div class="loading-track" role="progressbar" aria-label="Full-project search progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div></div><div class="full-search-actions"><button class="full-search-retry" type="button" hidden>Retry</button><button class="full-search-cancel" type="button">Cancel</button><button class="full-search-dismiss" type="button">Minimize</button></div></section></div>
  <button class="full-search-chip" type="button" hidden>Project search · 0%</button>
`;

export function mount(ctx = {}) {
  const doc = document;
  const legacy = ctx.legacy || null;
  let unmounted = false;
  let host = null;
  let current = null; // { result, pointer, controller, status }

  function unavailable(extra = {}) {
    return { kind: 'unavailable', ...extra };
  }

  // --- DOM (created lazily on first open()) -------------------------------

  function ensureHost() {
    if (host) return host;
    const element = doc.createElement('div');
    element.id = 'golens-project-search-root';
    const shadow = element.attachShadow({ mode: 'open' });
    shadow.innerHTML = MARKUP;
    shadow.querySelector('.full-search-minimize').addEventListener('click', minimize);
    shadow.querySelector('.full-search-dismiss').addEventListener('click', minimize);
    shadow.querySelector('.full-search-chip').addEventListener('click', restore);
    shadow.querySelector('.full-search-retry').addEventListener('click', () => { if (current) runSearch(current); });
    shadow.querySelector('.full-search-cancel').addEventListener('click', () => close());
    doc.body.append(element);
    host = element;
    return host;
  }

  function updateProgress(message, percentage = 0) {
    const shadow = ensureHost().shadowRoot;
    const panel = shadow.querySelector('.full-search-progress');
    panel.querySelector('.loading-progress-phase').textContent = message || 'Preparing project';
    panel.querySelector('.loading-progress-count').textContent = `${percentage}%`;
    panel.querySelector('.loading-track').setAttribute('aria-valuenow', String(percentage));
    panel.querySelector('.loading-track i').style.width = `${percentage}%`;
    shadow.querySelector('.full-search-chip').textContent = chipLabel(percentage);
  }

  function setRetryHidden(hidden) {
    ensureHost().shadowRoot.querySelector('.full-search-retry').hidden = hidden;
  }

  function minimize() {
    if (!current) return { kind: 'not-open' };
    const shadow = ensureHost().shadowRoot;
    shadow.querySelector('.full-search-backdrop').hidden = true;
    const chip = shadow.querySelector('.full-search-chip');
    chip.hidden = false;
    chip.focus();
    return { kind: 'minimized' };
  }

  function restore() {
    if (!current) return { kind: 'not-open' };
    const shadow = ensureHost().shadowRoot;
    shadow.querySelector('.full-search-chip').hidden = true;
    shadow.querySelector('.full-search-backdrop').hidden = false;
    const target = focusTargetForStatus(current.status);
    shadow.querySelector(target === 'retry' ? '.full-search-retry' : '.full-search-minimize').focus();
    return { kind: 'restored' };
  }

  function hideAll() {
    if (!host) return;
    const shadow = host.shadowRoot;
    shadow.querySelector('.full-search-backdrop').hidden = true;
    shadow.querySelector('.full-search-chip').hidden = true;
  }

  // --- search orchestration ------------------------------------------------

  function fail(search, message) {
    search.status = 'error';
    search.controller = null;
    updateProgress(message);
    setRetryHidden(false);
    restore();
  }

  async function searchCompleteProject(search) {
    const parsed = searchTerms(search.result);
    if (parsed.kind === 'noTerms') return { kind: 'noTerms' };
    const terms = parsed.terms;
    const candidatePaths = [];
    for (let index = 0; index < terms.length; index++) {
      updateProgress(termSearchMessage(terms[index]), blobSearchPercentage(index, terms.length));
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
      updateProgress(packageIndexMessage(index, packages.length), packageIndexPercentage(index, packages.length));
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
    setRetryHidden(true);
    updateProgress('Preparing complete project search');
    try {
      const outcome = await searchCompleteProject(search);
      if (current !== search || !legacy.isEnabled()) return;
      if (outcome.kind !== 'complete') {
        fail(search, outcome.kind === 'noTerms' ? NO_TERMS_MESSAGE : INCOMPLETE_MESSAGE);
        return;
      }
      updateProgress('Refreshing semantic result', 100);
      const refreshed = await rerunQuery(search, outcome.scope);
      if (current !== search || !legacy.isEnabled()) return;
      current = null;
      hideAll();
      legacy.showResult(refreshed, search.pointer);
      legacy.pinPopover(search.pointer);
    } catch (error) {
      if (current !== search) return;
      fail(search, error?.message || DEFAULT_FAILURE_MESSAGE);
    }
  }

  // --- public handle ---------------------------------------------------

  // open(result, pointer) -> { kind: 'started', ready } | { kind: 'missingRef' | 'unavailable' }
  // `ready` is the in-flight search's completion promise — production
  // callers (a synchronous popover click handler) never await it, matching
  // go-navigation.js's former fire-and-forget `runFullSearch();` call;
  // exposed only so tests can deterministically await the background
  // search instead of racing it (mirrors the go-navigation.js self-bridge's
  // own __test readiness promises).
  function open(result, pointer) {
    if (unmounted || !legacy) return unavailable();
    if (!canOpen(result)) return { kind: 'missingRef' };
    current?.controller?.abort();
    current = { result, pointer, status: 'idle', controller: null };
    legacy.hidePopover();
    restore();
    const ready = runSearch(current);
    return { kind: 'started', ready };
  }

  // close(opts) -> { kind: 'closed' | 'not-open' | 'unavailable' }
  // `restorePopover: false` is the navigation/unmount cleanup path
  // (go-navigation.js's former teardown() only aborted; it never called
  // showResult/pinPopover/toast, since the popover UI is about to be torn
  // down in the same synchronous call anyway).
  function close({ restorePopover = true } = {}) {
    if (unmounted || !legacy) return unavailable();
    if (!current) return { kind: 'not-open' };
    const search = current;
    search.controller?.abort();
    current = null;
    hideAll();
    if (restorePopover) {
      legacy.showResult(search.result, search.pointer);
      legacy.pinPopover(search.pointer);
      legacy.toast(CANCELLED_MESSAGE);
    }
    return { kind: 'closed' };
  }

  return {
    unmount() {
      if (unmounted) return;
      unmounted = true;
      current?.controller?.abort();
      current = null;
      host?.remove();
      host = null;
    },
    open,
    close,
    // minimize() -> { kind: 'minimized' | 'not-open' | 'unavailable' }. A
    // 4th handle method beyond ticket 20's literal `{unmount, open, close}`
    // text (still inside ticket 04 §1's "~5" budget, same allowance
    // settings-overlay/mr-preload used for options-object deviations): the
    // header −/Dismiss buttons and the chip-restore call the same private
    // minimize()/restore() functions directly, but go-navigation.js's own
    // document-level Escape handler has no other way to reach this
    // module's private DOM/state to reproduce its former
    // `fullSearchOpen` -> minimizeFullSearch() branch (see that handler's
    // own comment for why that branch is real, reachable behavior, not
    // dead code).
    minimize: () => {
      if (unmounted || !legacy) return unavailable();
      return minimize();
    },
  };
}
