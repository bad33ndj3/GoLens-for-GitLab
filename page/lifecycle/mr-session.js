// page/lifecycle/mr-session.js — the merge-request activation latch, the SPA
// reconcile loop, the diff-invalidation observer, and the platform-service
// instances every feature's `legacy` capability bag is built from (ticket 22,
// folding in tickets 31/34/36's deferred implementation work — see map.md's
// "Batch 3" section and 22's own file for the full trace).
//
// Carved out of two legacy classic-content-script files, both now deleted:
//   - go-navigation.js's orchestration slice: init()/teardown() (the
//     activation latch — "is GoLens live on *this* merge-request page",
//     distinct from the `enabled` chrome.storage setting page/lifecycle's own
//     settings.subscribe fanout already owns, per ticket 34's answer),
//     state.diffObserver + isBookmarkOnlyMutation, refreshMergeRequestRefs,
//     status()'s `golens-go-status` dispatch, and the gitlab-api/
//     source-loader/toast/rpc-client instances every bridge built.
//   - content.js's SPA-detection layer: reconcilePage()/
//     leaveMergeRequestPage(), the turbo:load/pjax:end/popstate/
//     visibilitychange/body-MutationObserver quintet, and its own debounce
//     (ticket 08's createLegacyDebounceIdle).
//
// Ticket 31's answer: this lives in page/lifecycle (ticket 03 §2 already
// says lifecycle "owns reconcilePage. Not a feature."), not a
// `page/features/mr-page-reconciler.js` — a standalone feature reconciling
// *other* features' mount state would be the forbidden feature -> feature
// edge. `page/lifecycle`'s own `NAV_POLL_MS` poll (ticket 11's inert stub) is
// a *different* mechanism (module-graph remount scheduling) and is untouched
// by this file; this file replaces nothing there, it only starts producing
// real reconcile behavior where none existed while features were unmigrated.
//
// createMrSession(deps) -> session, where deps carries every accessor this
// file cannot construct itself:
//   - clock: overridable {setTimeout, clearTimeout, requestFrame, requestIdle}
//     (test seam only; production omits it and gets the real globals).
//   - getSettings(): the mounted settings-store instance, read lazily since
//     page/main.js constructs it before this file but `reconcilePage`'s first
//     run must still wait on `settings.ready()` (constraint carried over from
//     content.js's init(), which awaited it before constructing controls).
//   - getControlsHandle()/getBookmarksHandle()/getCodeIntelHandle(): late-bound
//     accessors onto page/main.js's other mounted feature handles (batch 1's
//     platform-services decision — accessors, never captured values, since
//     this file is constructed before those features finish mounting).
//
// session.gitlabApi / session.sourceLoader / session.toast — the shared
// platform-service instances (page/main.js hands these to every `legacy`
// bag it builds, instead of the five separate dynamic-`import()` bridges
// go-navigation.js used to run). session.status()/session.workerRPC() are
// the two go-navigation.js used to inject into source-loader/code-intel.
//
// session.activate()/session.deactivate() replace go-navigation.js's former
// init()/teardown() — reached through controls.js's `legacy.init`/
// `legacy.teardown` capabilities (page/main.js wires these directly now, no
// globalThis bridge). session.start()/session.stop() replace content.js's
// former init()/the SPA-listener teardown its own unmount never had (that
// listener set lived for the whole content-script lifetime); page/main.js
// calls stop() from its own unmount() so an SPA-triggered module-graph
// remount (bootstrap.js's NAV_POLL_MS poll) does not leak listeners.
import { createLegacyDebounceIdle } from '../platform/clock.js';
import * as diffDom from '../platform/diff-dom.js';
import { createGitLabApi, projectContext, mapLimit } from '../platform/gitlab-api.js';
import { createSourceLoader } from '../platform/source-loader.js';
import { createToast } from '../platform/toast.js';
import { createRpcClient, methodNamespace } from '../platform/rpc-client.js';

const RECONCILE_DEBOUNCE_MS = 50;

function defaultClock() {
  return {
    setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
    clearTimeout: (id) => globalThis.clearTimeout(id),
    requestFrame: (fn) => (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(fn) : globalThis.setTimeout(fn, 16)),
    requestIdle: (fn) => (globalThis.requestIdleCallback ? globalThis.requestIdleCallback(fn, { timeout: 300 }) : globalThis.setTimeout(fn, 0)),
  };
}

function isGitLab(doc, win) {
  if (win.gon?.gitlab_url) return true;
  const csrf = doc.querySelector('meta[name="csrf-token"]');
  const shell = doc.querySelector('.super-sidebar, [data-testid="super-sidebar"], #js-top-bar, .layout-page, .ai-panels');
  return Boolean(csrf && shell);
}

function isMergeRequest(win) {
  return /\/-\/merge_requests\/\d+/.test(win.location.pathname);
}

function mergeRequestPageKey(win) {
  const match = win.location.pathname.match(/^(.*?\/-\/merge_requests\/\d+)/);
  return match ? `${win.location.origin}${match[1]}` : '';
}

// Duplicated (not imported) from bookmarks.js's own bookmarkProjectionMutation
// — documented there, and in go-navigation.js's former copy of the same
// guard: both this file's diff observer and bookmarks.js's own separate one
// need to ignore mutations that are only bookmarks' marker/selection-UI DOM,
// or every marker placement would bump fileContextGeneration needlessly.
function isBookmarkOnlyMutation(mutation) {
  const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
  return nodes.length > 0 && nodes.every((node) => node.nodeType === 1 && (
    node.matches?.('[data-golens-bookmark-marker], #golens-bookmark-selection-root')
    || node.querySelector?.('[data-golens-bookmark-marker], #golens-bookmark-selection-root')
  ));
}

export function createMrSession({
  doc = document,
  win = window,
  clock: clockOverrides,
  getSettings = () => null,
  getControlsHandle = () => null,
  getBookmarksHandle = () => null,
  getCodeIntelHandle = () => null,
} = {}) {
  let clock = clockOverrides ? { ...defaultClock(), ...clockOverrides } : defaultClock();
  function setClock(overrides) {
    clock = overrides ? { ...defaultClock(), ...overrides } : defaultClock();
  }

  const active = { enabled: false, abortController: null, diffObserver: null };

  function getSignal() {
    return active.abortController?.signal;
  }

  const gitlabApi = createGitLabApi({ getClock: () => clock, getSignal });
  const sourceLoader = createSourceLoader({
    workerRPC,
    status,
    projectContext,
    listPackageFiles: (...args) => gitlabApi.listPackageFiles(...args),
    listProjectFiles: (...args) => gitlabApi.listProjectFiles(...args),
    fetchBlob: (...args) => gitlabApi.fetchBlob(...args),
    modulePathFor: (...args) => gitlabApi.modulePathFor(...args),
    mapLimit,
  });
  const toastSurface = createToast();

  // status(kind, message, progress) -> dispatches `golens-go-status`
  // synchronously. tests/browser-smoke.mjs:268/:445 depend on this firing
  // without an intervening microtask on activation — this event has nearly
  // been dropped three times during this restructure (see map.md's batch-1
  // notes). session.activate() below calls this as its first statement,
  // before any `await`, and this function itself never awaits anything.
  function status(kind, message, progress) {
    doc.dispatchEvent(new CustomEvent('golens-go-status', {
      detail: { kind, message, ...(progress ? { progress } : {}) },
    }));
  }

  // Lazy rpc-client, same shim shape as go-navigation.js's former
  // ensureRpcClient/workerRPC: dispatch by wire-method-name string so callers
  // don't need to know the namespace split. Framing/port lifecycle/reconnect
  // live in page/platform/rpc-client.js.
  let rpcClient = null;
  let rpcClientPromise = null;
  function ensureRpcClient() {
    if (rpcClient) return Promise.resolve(rpcClient);
    if (!rpcClientPromise) {
      rpcClientPromise = Promise.resolve().then(() => {
        rpcClient = createRpcClient({
          connect: () => chrome.runtime.connect({ name: 'golens-go-rpc' }),
          onDisconnect: () => {
            sourceLoader.clearLoaded();
            gitlabApi.clearModulePaths();
          },
        });
        return rpcClient;
      });
    }
    return rpcClientPromise;
  }
  async function workerRPC(method, params) {
    const client = await ensureRpcClient();
    return client[methodNamespace(method)][method](params);
  }

  function refreshMergeRequestRefs() {
    if (doc.visibilityState === 'visible') gitlabApi.clearMergeRequestRefs();
  }

  // session.activate()/deactivate() — the activation latch. Idempotent, same
  // as go-navigation.js's former init()/teardown(): activate() on an already
  // -active session, or on a page that isn't a merge request, is a no-op.
  function activate() {
    if (active.enabled || !isMergeRequest(win)) return;
    active.enabled = true;
    active.abortController = new AbortController();
    getBookmarksHandle()?.enable();
    getCodeIntelHandle()?.setEnabled(true);
    doc.addEventListener('visibilitychange', refreshMergeRequestRefs, true);
    active.diffObserver = new MutationObserver((mutations) => {
      if (mutations.length && mutations.every(isBookmarkOnlyMutation)) return;
      diffDom.bumpFileContextGeneration();
    });
    const diffObserverRoot = doc.getElementById('diffs') || doc.body;
    active.diffObserver.observe(diffObserverRoot, { childList: true, subtree: true, characterData: true });
    status('idle', 'Go intelligence · hover code to start');
  }

  function deactivate() {
    active.enabled = false;
    active.abortController?.abort();
    active.abortController = null;
    active.diffObserver?.disconnect();
    active.diffObserver = null;
    getCodeIntelHandle()?.setEnabled(false);
    getBookmarksHandle()?.disable();
    doc.removeEventListener('visibilitychange', refreshMergeRequestRefs, true);
    rpcClient?.dispose({ reason: 'Go intelligence request cancelled' });
    sourceLoader.reset();
    gitlabApi.clearModulePaths();
    gitlabApi.clearMergeRequestRefs();
  }

  // --- SPA reconcile loop (ticket 31), carved out of content.js -----------
  const pageState = { active: false, key: '', reconcileCount: 0 };

  async function disableGoLens() {
    deactivate();
    await getControlsHandle()?.leaveReviewFocus();
  }

  async function leaveMergeRequestPage() {
    if (!pageState.active) return;
    pageState.active = false;
    pageState.key = '';
    await disableGoLens();
    getControlsHandle()?.destroy();
  }

  async function reconcilePage() {
    pageState.reconcileCount++;
    if (!isGitLab(doc, win) || !isMergeRequest(win)) {
      await leaveMergeRequestPage();
      return;
    }
    const pageKey = mergeRequestPageKey(win);
    if (pageState.active && pageState.key !== pageKey) await leaveMergeRequestPage();
    if (!pageState.active) {
      pageState.active = true;
      pageState.key = pageKey;
      getControlsHandle()?.createControls();
      const settings = getSettings();
      const enabled = settings ? Boolean(settings.get('enabled')) : true;
      await getControlsHandle()?.setEnabled(enabled);
      await getControlsHandle()?.refreshPreloadStatus();
      return;
    }
    getControlsHandle()?.createControls();
  }

  const debounceIdle = createLegacyDebounceIdle(() => clock);
  const schedulePageReconcile = debounceIdle(() => {
    reconcilePage().catch(() => undefined);
  }, RECONCILE_DEBOUNCE_MS);

  let stopped = true;
  const onVisibilityChange = () => {
    if (doc.visibilityState !== 'visible') return;
    schedulePageReconcile();
  };
  const bodyObserver = new MutationObserver(schedulePageReconcile);

  // start() -> attaches the SPA-detection listeners and runs the first
  // reconcile pass, mirroring content.js's former init(): settings must be
  // ready before the first pass constructs controls (constraint carried
  // over verbatim — content.js awaited settingsStore.ready() before
  // constructing its controls instance).
  async function start() {
    if (!stopped) return;
    stopped = false;
    win.addEventListener('popstate', schedulePageReconcile);
    doc.addEventListener('turbo:load', schedulePageReconcile);
    doc.addEventListener('pjax:end', schedulePageReconcile);
    doc.addEventListener('visibilitychange', onVisibilityChange);
    bodyObserver.observe(doc.body, { childList: true, subtree: true });
    await getSettings()?.ready();
    await reconcilePage();
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    // A module-graph remount (bootstrap's SPA-navigation poll) tears this
    // whole session down; the activation latch must go with it or the
    // previous instance's diffObserver/abortController/rpcClient leak past
    // the remount (AGENTS.md: "cancel in-flight source requests when a page
    // or GoLens session ends"). Idempotent alongside a preceding
    // deactivate() from leaveMergeRequestPage()/legacy.teardown.
    deactivate();
    win.removeEventListener('popstate', schedulePageReconcile);
    doc.removeEventListener('turbo:load', schedulePageReconcile);
    doc.removeEventListener('pjax:end', schedulePageReconcile);
    doc.removeEventListener('visibilitychange', onVisibilityChange);
    bodyObserver.disconnect();
    schedulePageReconcile.cancel();
  }

  return {
    gitlabApi,
    sourceLoader,
    toast: toastSurface,
    status,
    workerRPC,
    getSignal,
    // requestFrame(fn) -> code-intel.js's frame-throttle capability
    // (go-navigation.js's former `requestFrame: (fn) => clock.requestFrame(fn)`).
    // Late-bound onto the current `clock` variable, not a captured value —
    // same reason as `getSignal` above (batch 1's platform-services decision).
    requestFrame: (fn) => clock.requestFrame(fn),
    isActive: () => active.enabled,
    activate,
    deactivate,
    schedulePageReconcile,
    start,
    stop,
    __test: {
      setClock,
      reconcileCount: () => pageState.reconcileCount,
      schedulePageReconcile: (...args) => schedulePageReconcile(...args),
      // reconcilePage() -> Promise<void>, direct (non-debounced) access for
      // tests that need to await a single pass deterministically instead of
      // driving it through the injectable clock.
      reconcilePage: () => reconcilePage(),
    },
  };
}
