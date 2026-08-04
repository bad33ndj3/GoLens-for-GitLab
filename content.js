(() => {
  const defaults = { enabled: true, shortcutCoachEnabled: true };
  const RECONCILE_DEBOUNCE_MS = 50;
  // Injectable time source (test-only) so debounce tests are deterministic
  // and don't sleep. Mirrors the pattern in `go-navigation.js`.
  function defaultClock() {
    return {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id) => globalThis.clearTimeout(id),
      requestIdle: (fn) => (globalThis.requestIdleCallback ? globalThis.requestIdleCallback(fn, { timeout: 300 }) : globalThis.setTimeout(fn, 0)),
    };
  }
  let clock = defaultClock();
  function setClock(overrides) {
    clock = overrides ? { ...defaultClock(), ...overrides } : defaultClock();
  }

  // debounceIdle's implementation now lives in page/platform/clock.js
  // (ticket 08 dedup — this body was byte-identical to go-navigation.js's
  // copy). It's populated inside init() via loadClockModule() below since
  // `import()` can't resolve synchronously at module top level; `clock`
  // above stays local (test-swappable via setClock, unchanged) and is read
  // dynamically on every debounced call via the getter passed to
  // createLegacyDebounceIdle, so setClock() still affects an
  // already-created debounced function exactly as before.
  let debounceIdle = null;

  // The one seam onto `chrome.storage` (platform/settings-store, ticket 10).
  // Loaded via dynamic `import()` since this file still runs as a classic
  // content script (not an ES module) per manifest.json.
  // `chrome.runtime.getURL` is the production-correct specifier, matching the
  // validated bootstrap-import pattern (ticket 04 §7, `bootstrap.js`); the
  // relative fallback lets `node --test` resolve the real module too, since
  // test doubles for `chrome.runtime.getURL` return non-resolvable
  // `chrome-extension://` URLs that Node can't fetch.
  let settingsStore = null;
  async function loadSettingsStoreModule() {
    try {
      return await import(chrome.runtime.getURL('page/platform/settings-store.js'));
    } catch {
      return await import('./page/platform/settings-store.js');
    }
  }

  // Same dynamic-`import()` bridge as settings-store above, for the
  // debounceIdle algorithm centralized in page/platform/clock.js (ticket 08).
  async function loadClockModule() {
    try {
      return await import(chrome.runtime.getURL('page/platform/clock.js'));
    } catch {
      return await import('./page/platform/clock.js');
    }
  }

  // Same dynamic-`import()` bridge as settings-store/clock above, reaching
  // page/features/celebration.js's module-scope
  // requestMoment() export (ticket 14 — the "pitstop" mascot moment used to
  // fire straight from this file's own showMascotMoment(); that whole
  // feature now lives in its own module, and this is the one remaining
  // trigger content.js still owns). A failed import or a moment requested
  // before/after that module is mounted is a silent no-op, same as every
  // other bridge here.
  async function triggerPitstopMoment() {
    try {
      const { requestMoment } = await (async () => {
        try {
          return await import(chrome.runtime.getURL('page/features/celebration.js'));
        } catch {
          return await import('./page/features/celebration.js');
        }
      })();
      requestMoment('pitstop');
    } catch {
      // See header comment: a dropped pitstop moment is not a failure.
    }
  }

  const state = {
    settings: defaults,
    enabled: true,
    pageKey: '',
    pageActive: false,
    reconcileCount: 0,
  };

  function isGitLab() {
    if (window.gon?.gitlab_url) return true;
    const csrf = document.querySelector('meta[name="csrf-token"]');
    const shell = document.querySelector('.super-sidebar, [data-testid="super-sidebar"], #js-top-bar, .layout-page, .ai-panels');
    return Boolean(csrf && shell);
  }

  function isMergeRequest() {
    return /\/-\/merge_requests\/\d+/.test(location.pathname);
  }

  function mergeRequestPageKey() {
    const match = location.pathname.match(/^(.*?\/-\/merge_requests\/\d+)/);
    return match ? `${location.origin}${match[1]}` : '';
  }

  function isMergeRequestDiff() {
    return /\/-\/merge_requests\/\d+\/diffs(?:$|\/|\?)/.test(location.pathname + location.search);
  }

  function enableRapidDiffs() {
    if (!isMergeRequestDiff()) return false;
    const optIn = [...document.querySelectorAll('button')].find((button) =>
      /^try\s+rapid\s+diffs\b/i.test(button.textContent.trim()) && !button.disabled
    );
    if (!optIn) return false;
    optIn.click();
    return true;
  }

  function watchForRapidDiffs() {
    if (!isMergeRequestDiff() || enableRapidDiffs()) return;
    const observer = new MutationObserver(() => {
      if (!enableRapidDiffs()) return;
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }

  async function disableGoLens() {
    globalThis.GoLensGoNavigation?.teardown();
    await controlsHandle?.leaveReviewFocus();
  }

  // Populated at the top of init() below, once page/features/controls.js
  // loads (ticket 30: toolbar, preload state machine, review-focus/
  // fullscreen, bookmark drawer — all carved out of this file). `legacy`
  // is the capability bag (ticket 03 §3) content.js hands it in place of a
  // new globalThis bridge: every entry is a thin forward onto either this
  // file's own surviving functions (watchForRapidDiffs/enableRapidDiffs
  // stay here per ticket 31, deferred) or `globalThis.GoLensGoNavigation`'s
  // existing methods, late-bound the same way batch 1's platform-services
  // decision bound accessors (never read at bag-construction time).
  let controlsHandle = null;

  async function setEnabled(enabled, opts = {}) {
    state.enabled = enabled;
    state.settings = { ...state.settings, enabled };
    await controlsHandle?.setEnabled(enabled, opts);
  }

  async function leaveMergeRequestPage() {
    if (!state.pageActive) return;
    state.pageActive = false;
    state.pageKey = '';
    // Neither overlay is closed from here any more (ticket 16 for settings,
    // ticket 15 for onboarding): bootstrap.js unmounts and re-mounts the
    // whole page module graph on every location.href change (this one
    // included), and that unmount closes both. Deviation worth knowing: that
    // re-mount fires on *any* href change, where this call site only fired
    // on actually leaving the merge request.
    await disableGoLens();
    controlsHandle?.destroy();
  }

  async function reconcilePage() {
    state.reconcileCount++;
    if (!isGitLab() || !isMergeRequest()) {
      await leaveMergeRequestPage();
      return;
    }

    const pageKey = mergeRequestPageKey();
    if (state.pageActive && state.pageKey !== pageKey) await leaveMergeRequestPage();

    if (!state.pageActive) {
      state.pageActive = true;
      state.pageKey = pageKey;
      controlsHandle?.createControls();
      await setEnabled(state.settings.enabled);
      await controlsHandle?.refreshPreloadStatus();
      return;
    }

    controlsHandle?.createControls();
  }

  // Populated at the top of init() below, once loadClockModule() resolves —
  // `import()` can't resolve synchronously here at module top level (see
  // debounceIdle comment above). __test exports a thunk (further down) so
  // the current value is always used, even though it's read before init()
  // finishes.
  let schedulePageReconcile = null;

  // Same dynamic-`import()` bridge as settings-store/clock/celebration
  // above, reaching page/features/controls.js's mount() (ticket 30).
  async function loadControlsModule() {
    try {
      return await import(chrome.runtime.getURL('page/features/controls.js'));
    } catch {
      return await import('./page/features/controls.js');
    }
  }

  async function init() {
    if (!isGitLab()) return;
    try {
      const { createLegacyDebounceIdle } = await loadClockModule();
      debounceIdle = createLegacyDebounceIdle(() => clock);
      schedulePageReconcile = debounceIdle(() => {
        reconcilePage().catch(() => undefined);
      }, RECONCILE_DEBOUNCE_MS);
    } catch {
      // Both the chrome.runtime.getURL and relative import fallbacks failed
      // (should not happen in production, but init() is fire-and-forget —
      // an unhandled rejection here would leave the whole content script
      // inert). Degrade to an undebounced scheduler rather than never
      // reconciling at all.
      schedulePageReconcile = () => { reconcilePage().catch(() => undefined); };
    }
    try {
      const { createSettingsStore } = await loadSettingsStoreModule();
      settingsStore = createSettingsStore();
      await settingsStore.ready();
      state.settings = {
        enabled: settingsStore.get('enabled'),
        shortcutCoachEnabled: settingsStore.get('shortcutCoachEnabled'),
      };
    } catch {
      settingsStore = null;
      state.settings = defaults;
    }
    state.enabled = state.settings.enabled;
    try {
      const { mount } = await loadControlsModule();
      controlsHandle = mount({
        settings: settingsStore,
        clock: { setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms) },
        legacy: {
          preloadMergeRequest: (...args) => globalThis.GoLensGoNavigation?.preloadMergeRequest?.(...args),
          mergeRequestPreloadStatus: (...args) => globalThis.GoLensGoNavigation?.mergeRequestPreloadStatus?.(...args),
          preloadFullProject: (...args) => globalThis.GoLensGoNavigation?.preloadFullProject?.(...args),
          fullProjectPreloadStatus: (...args) => globalThis.GoLensGoNavigation?.fullProjectPreloadStatus?.(...args),
          invalidateCacheState: () => globalThis.GoLensGoNavigation?.invalidateCacheState?.(),
          init: () => globalThis.GoLensGoNavigation?.init?.(),
          teardown: () => globalThis.GoLensGoNavigation?.teardown?.(),
          bookmarks: () => globalThis.GoLensGoNavigation?.bookmarks,
          enableRapidDiffs: () => enableRapidDiffs(),
          watchForRapidDiffs: () => watchForRapidDiffs(),
          triggerPitstopMoment: () => triggerPitstopMoment(),
          schedulePageReconcile: () => schedulePageReconcile(),
        },
      });
    } catch {
      // Same degrade-not-throw philosophy as the other bridges above: a
      // failed controls.js import leaves the toolbar absent rather than
      // taking down the rest of this content script.
      controlsHandle = null;
    }
    window.addEventListener('popstate', schedulePageReconcile);
    document.addEventListener('turbo:load', schedulePageReconcile);
    document.addEventListener('pjax:end', schedulePageReconcile);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      schedulePageReconcile();
    });
    new MutationObserver(schedulePageReconcile).observe(document.body, { childList: true, subtree: true });
    settingsStore?.subscribe('enabled', (value) => {
      if (value !== state.enabled) setEnabled(value).catch(() => undefined);
    });
    await reconcilePage();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'golens-enabled') setEnabled(message.enabled);
    if (message?.type === 'golens-cache-invalidated') {
      globalThis.GoLensGoNavigation?.invalidateCacheState?.();
      controlsHandle?.invalidatePreloadState();
      sendResponse({ ok: true, result: { invalidated: true } });
    }
    if (message?.type === 'golens-preload-full-project') {
      sendResponse({ ok: true, result: controlsHandle?.startFullProjectPreload() ?? { status: 'unavailable', message: 'GoLens controls unavailable.', progress: null } });
    }
    if (message?.type === 'golens-full-project-status') {
      (controlsHandle?.refreshFullProjectPreloadStatus() ?? Promise.resolve({ status: 'unavailable', message: 'GoLens controls unavailable.', progress: null }))
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    // golens-show-onboarding and golens-show-settings: both overlays now
    // live in page/features/ (settings-overlay.js, ticket 16; onboarding.js,
    // ticket 15) and are answered by bootstrap.js. content.js no longer
    // builds either overlay's DOM and no longer responds to either message —
    // two responders on one message means one of them loses.
  });

  globalThis.GoLensContent = { __test: { setClock, schedulePageReconcile: (...args) => schedulePageReconcile(...args), reconcileCount: () => state.reconcileCount } };

  init();
})();
