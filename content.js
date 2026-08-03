(() => {
  const shortcutDefaults = globalThis.GoLensShortcuts?.defaultBindings?.() || {};
  const defaults = { enabled: true, hideGeneratedFiles: false, shortcutCoachEnabled: true, shortcutBindings: shortcutDefaults };
  const ONBOARDING_VERSION = 11;
  const ONBOARDING_STORAGE_KEY = 'golensOnboardingVersion';
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

  // Same dynamic-`import()` bridge as settings-store/clock above, for
  // page/platform/overlay-registry.js (ticket 12 — breaks the ticket 02 §4
  // near-cycle: go-navigation.js used to read `#golens-onboarding-root` /
  // `#golens-settings-root` straight off this file's DOM). content.js owns
  // both overlays, so it's the one that claims while they're open and
  // releases when they close; go-navigation.js only ever reads
  // `isAnyOpen()` through its own import of this same module.
  let overlayRegistry = null;
  async function loadOverlayRegistryModule() {
    try {
      return await import(chrome.runtime.getURL('page/platform/overlay-registry.js'));
    } catch {
      return await import('./page/platform/overlay-registry.js');
    }
  }

  // Same dynamic-`import()` bridge as settings-store/clock/overlay-registry
  // above, reaching page/features/celebration.js's module-scope
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
    ownsFullscreen: false,
    controlsHost: null,
    controlsMounted: false,
    preload: { status: 'idle', message: '', progress: null },
    preloadCheckID: 0,
    preloadRunID: 0,
    fullPreload: { status: 'idle', message: '', progress: null },
    fullPreloadRunID: 0,
    onboardingReturnFocus: null,
    // release() function returned by overlayRegistry.claim(), held here so
    // closeOnboarding() — the sole close path for every onboarding close
    // route (Esc, backdrop click, close button, SPA navigation) — can
    // release exactly the claim showOnboarding() made, and only if one was
    // actually made (see loadOverlayRegistryModule's failure handling). The
    // settings overlay holds its own claim inside
    // page/features/settings-overlay.js (ticket 16).
    onboardingOverlayRelease: null,
    bookmarkSnapshot: { scope: null, current: [], stale: [] },
    bookmarkUnsubscribe: null,
    bookmarkDrawerReturnFocus: null,
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

  function aiPanelsContainer() {
    return document.querySelector('body > div.layout-page.js-page-layout.page-gutter.page-with-super-sidebar.right-sidebar-collapsed.is-merge-request > div.ai-panels')
      || document.querySelector('.layout-page.is-merge-request > .ai-panels')
      || document.querySelector('div.ai-panels');
  }

  function aiPanelsAnchor() {
    return document.querySelector('body > div.layout-page.js-page-layout.page-gutter.page-with-super-sidebar.right-sidebar-collapsed.is-merge-request > div.ai-panels > div > nav > div > button')
      || aiPanelsContainer()?.querySelector(':scope > div > nav > div > button, nav > div > button, nav button');
  }

  function mountControlsInAiPanels(host) {
    const anchor = aiPanelsAnchor();
    if (anchor) {
      anchor.after(host);
      state.controlsMounted = true;
    }
    if (anchor) return;

    // Never fall back to the document body: a misplaced control is worse
    // than waiting for GitLab to render the intended AI-sidebar control.
    const observer = new MutationObserver(() => {
      if (state.controlsHost !== host) {
        observer.disconnect();
        return;
      }
      const lateAnchor = aiPanelsAnchor();
      if (!lateAnchor) return;
      lateAnchor.after(host);
      state.controlsMounted = true;
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      if (state.controlsHost !== host || host.isConnected) return;
      state.controlsHost = null;
      state.controlsMounted = false;
      schedulePageReconcile();
    }, 30000);
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

  // Still used by reconcileGoTestFileRows() below (unrelated feature, out of
  // this ticket's scope); the generated-files-specific callers of this
  // function moved to page/features/generated-files.js (ticket 13), which
  // carries its own copy (small pure helper, cheap to duplicate rather than
  // share across the classic-script/ES-module boundary).
  function normalizeRepositoryPath(path) {
    return (path || '')
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .trim()
      .replace(/\s*\/\s*/g, '/')
      .replace(/^\/+|\/+$/g, '');
  }

  function restoreGoTestFileRows() {
    document.querySelectorAll('[data-golens-go-test-file-row]').forEach((fileRow) => {
      fileRow.removeAttribute('data-golens-go-test-file-row');
    });
  }

  function reconcileGoTestFileRows() {
    if (!state.enabled || !isMergeRequestDiff()) {
      restoreGoTestFileRows();
      return;
    }
    document.querySelectorAll('[data-file-row]').forEach((fileRow) => {
      const labels = [
        fileRow.getAttribute('title'),
        fileRow.getAttribute('aria-label'),
        fileRow.textContent,
      ];
      const isGoTestFile = labels.some((label) =>
        normalizeRepositoryPath(label).endsWith('_test.go')
      );
      fileRow.toggleAttribute('data-golens-go-test-file-row', isGoTestFile);
    });
  }

  function overviewDiscussionLineTarget(discussion) {
    if (!discussion.querySelector('.diff-file tr.line_holder')) return '';
    const pageKey = mergeRequestPageKey();
    if (!pageKey) return '';
    const candidates = discussion.querySelectorAll(
      '.discussion-header .note-header-info a[href], .discussion-header .note-header a[href], .diff-file-header a[href], [data-testid="file-title"] a[href]'
    );
    for (const candidate of candidates) {
      try {
        const url = new URL(candidate.getAttribute('href'), location.href);
        if (`${url.origin}${url.pathname}` === `${pageKey}/diffs` && url.hash) return url.href;
      } catch {
        // Ignore malformed or non-navigation links rendered by third-party GitLab integrations.
      }
    }
    return '';
  }

  function mountOverviewDiscussionLineLink(discussion) {
    if (discussion.querySelector('[data-golens-discussion-line-link]')) return;
    const href = overviewDiscussionLineTarget(discussion);
    const header = discussion.querySelector(
      '.discussion-header .note-header-info, .discussion-header .note-header'
    );
    if (!href || !header) return;
    const link = document.createElement('a');
    link.className = 'gitlab-lens-discussion-line-link';
    link.dataset.golensDiscussionLineLink = '';
    link.href = href;
    link.textContent = 'View in changes';
    link.title = 'Open the commented line in the Changes tab';
    link.setAttribute('aria-label', 'Open commented line in Changes');
    header.append(link);
  }

  function removeOverviewDiscussionLineLinks() {
    document.querySelectorAll('[data-golens-discussion-line-link]').forEach((link) => link.remove());
  }

  function reconcileOverviewDiscussionLineLinks() {
    if (!state.enabled || !isMergeRequest() || isMergeRequestDiff()) {
      removeOverviewDiscussionLineLinks();
      return;
    }
    document.querySelectorAll('[data-testid="discussion-content"].js-discussion-container')
      .forEach(mountOverviewDiscussionLineLink);
  }

  function inReviewFocus() {
    return document.documentElement.classList.contains('gitlab-lens-review-focus');
  }

  async function disableGoLens() {
    globalThis.GoLensGoNavigation?.teardown();
    if (inReviewFocus()) await toggleReviewFocus();
  }

  function createControls() {
    if (state.controlsHost && (state.controlsHost.isConnected || !state.controlsMounted)) return;
    state.controlsHost?.remove();
    const host = document.createElement('aside');
    host.id = 'gitlab-lens-root';
    state.controlsHost = host;
    state.controlsMounted = false;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all:initial; position:relative; display:inline-block; color-scheme:dark; }
        * { box-sizing:border-box; }
        .controls { display:grid; gap:var(--golens-space-1); padding:var(--golens-space-1); border:1px solid var(--golens-border-subtle); border-radius:var(--golens-radius-md); background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-sm); }
        button { position:relative; display:grid; place-items:center; width:32px; height:32px; overflow:hidden; padding:0; border:1px solid transparent; border-radius:var(--golens-radius-sm); background:transparent; color:var(--golens-text-secondary); cursor:pointer; transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),color var(--golens-motion-fast),transform var(--golens-motion-fast),opacity var(--golens-motion-fast); }
        button:hover:not(:disabled) { border-color:var(--golens-border-strong); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
        button:active:not(:disabled) { background:var(--golens-surface-pressed); transform:translateY(1px); }
        button:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:2px; }
        button:disabled { cursor:not-allowed; opacity:.42; }
        button img { grid-area:1 / 1; width:24px; height:24px; border-radius:var(--golens-radius-xs); object-fit:contain; transition:opacity var(--golens-motion-base),transform var(--golens-motion-base); }
        button > svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.75; }
        .golens-toggle[aria-pressed="true"] { border-color:var(--golens-primary); background:var(--golens-primary-soft); color:var(--golens-primary-hover); }
        .golens-toggle:not([aria-pressed="true"]) img { filter:grayscale(1); opacity:.58; }
        .golens-toggle .mascot-focus { opacity:0; transform:scale(.72); }
        .golens-toggle[data-review-focus="true"] .mascot-default { opacity:0; transform:scale(.82); }
        .golens-toggle[data-review-focus="true"] .mascot-focus { opacity:1; transform:scale(1); }
        .focus-toggle { color:var(--golens-info); }
        .focus-toggle[aria-pressed="true"] { border-color:var(--golens-info); background:var(--golens-info-soft); color:var(--golens-info-hover); box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--golens-info) 18%,transparent); }
        .focus-toggle:disabled { filter:grayscale(1); }
        .preload-toggle { color:var(--golens-primary-hover); }
        .preload-toggle svg { display:none; width:18px; height:18px; }
        .preload-toggle[data-state="idle"] .preload-idle, .preload-toggle[data-state="error"] .preload-idle, .preload-toggle[data-state="complete"] .preload-check { display:block; }
        .preload-toggle[data-state="checking"] .preload-progress, .preload-toggle[data-state="busy"] .preload-progress { display:block; }
        .preload-toggle[data-state="complete"] { border-color:var(--golens-success); background:var(--golens-success-soft); color:var(--golens-success); }
        .preload-toggle[data-state="error"] { border-color:var(--golens-error); background:var(--golens-error-soft); color:var(--golens-error); }
        .preload-toggle[data-state="checking"], .preload-toggle[data-state="busy"] { cursor:progress; opacity:1; }
        .preload-toggle:disabled:not([data-state="checking"]):not([data-state="busy"]) { filter:grayscale(1); }
        .preload-progress { position:absolute; inset:0; display:none; overflow:hidden; background:var(--golens-surface-raised); }
        .preload-fill { position:absolute; z-index:2; inset:0 auto 0 0; width:0; overflow:hidden; background:var(--golens-primary); transition:width var(--golens-motion-base); }
        .preload-count, .preload-fill-count { position:absolute; inset:0; display:flex; width:30px; align-items:center; justify-content:center; font:800 9px/1 var(--golens-font-mono); font-variant-numeric:tabular-nums; letter-spacing:-.06em; pointer-events:none; }
        .preload-count { z-index:1; color:var(--golens-text-secondary); }
        .preload-fill-count { color:var(--golens-text-inverse); }
        .preload-count[hidden], .preload-fill-count[hidden] { display:none; }
        .preload-toggle[data-count-size="small"] :is(.preload-count,.preload-fill-count) { font-size:8px; }
        .preload-toggle[data-count-size="tiny"] :is(.preload-count,.preload-fill-count) { font-size:7px; letter-spacing:-.1em; }
        .preload-toggle.is-indeterminate .preload-fill { width:42%; animation:preload-sweep 1s ease-in-out infinite; transition:none; }
        .bookmark-toggle { color:var(--golens-info); overflow:visible; }
        .bookmark-toggle[aria-expanded="true"] { border-color:var(--golens-info); background:var(--golens-info-soft); color:var(--golens-info-hover); }
        .bookmark-count { position:absolute; right:-4px; bottom:-4px; min-width:15px; height:15px; padding:0 3px; border:2px solid var(--golens-surface-panel); border-radius:999px; background:var(--golens-primary); color:var(--golens-text-inverse); font:800 8px/11px var(--golens-font-mono); font-variant-numeric:tabular-nums; }
        .bookmark-count[hidden], .bookmark-stale[hidden] { display:none; }
        .bookmark-stale { position:absolute; top:2px; right:2px; width:7px; height:7px; border:1px solid var(--golens-surface-panel); border-radius:50%; background:var(--golens-warning,#d99530); }
        @keyframes preload-sweep { from { transform:translateX(-110%); } to { transform:translateX(250%); } }
        @media (prefers-reduced-motion:reduce) { button,button img,.preload-fill { transition:none; } button:active:not(:disabled) { transform:none; } .preload-toggle.is-indeterminate .preload-fill { width:100%; animation:none; opacity:.45; } }
      </style>
      <div class="controls">
        <button class="golens-toggle" data-action="toggle-enabled" aria-pressed="false"><img class="mascot-default" src="${chrome.runtime.getURL('assets/icons/golens-32.png')}" alt=""><img class="mascot-focus" src="${chrome.runtime.getURL('assets/celebrations/golens-focus.png')}" alt=""></button>
        <button class="focus-toggle" data-action="focus" title="Full screen mode" aria-label="Full screen mode" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"></path><path d="M8.5 12h7"></path></svg></button>
        <button class="preload-toggle" data-action="preload" data-state="idle" title="Cache related MR packages" aria-label="Cache related MR packages">
          <svg class="preload-idle" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4"></path><path d="M5 17v3h14v-3"></path></svg>
          <span class="preload-progress" role="progressbar" aria-label="Caching related MR packages" aria-valuemin="0" aria-valuemax="100">
            <span class="preload-count" aria-hidden="true" hidden></span>
            <span class="preload-fill" aria-hidden="true"><span class="preload-fill-count" hidden></span></span>
          </span>
          <svg class="preload-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>
        </button>
        <button class="bookmark-toggle" data-action="bookmarks" title="Open MR bookmarks" aria-label="Open MR bookmarks" aria-expanded="false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3.5h12v17l-6-4-6 4z"></path></svg>
          <span class="bookmark-count" aria-hidden="true" hidden></span>
          <span class="bookmark-stale" aria-hidden="true" hidden></span>
        </button>
      </div>
      `;
    mountControlsInAiPanels(host);
    wireControls(shadow);
    ensureBookmarkSubscription();
    renderBookmarkControl(shadow);
  }

  function ensureBookmarkSubscription() {
    if (state.bookmarkUnsubscribe || !globalThis.GoLensGoNavigation?.subscribeBookmarks) return;
    state.bookmarkUnsubscribe = globalThis.GoLensGoNavigation.subscribeBookmarks((snapshot) => {
      state.bookmarkSnapshot = snapshot;
      renderBookmarkControl();
      renderBookmarkDrawer();
    });
  }

  function renderBookmarkControl(shadow = document.getElementById('gitlab-lens-root')?.shadowRoot) {
    const button = shadow?.querySelector('[data-action="bookmarks"]');
    if (!button) return;
    const count = state.bookmarkSnapshot.current.length;
    const stale = state.bookmarkSnapshot.stale.length;
    const badge = button.querySelector('.bookmark-count');
    badge.textContent = count > 99 ? '99+' : String(count);
    badge.hidden = count === 0;
    button.querySelector('.bookmark-stale').hidden = stale === 0;
    button.disabled = !state.enabled;
    const label = `Open MR bookmarks · ${count} current${stale ? `, ${stale} stale` : ''}`;
    button.title = label;
    button.setAttribute('aria-label', label);
  }

  function closeBookmarkDrawer({ restoreFocus = true } = {}) {
    const host = document.getElementById('golens-bookmark-drawer-root');
    if (!host) return;
    host.remove();
    document.getElementById('gitlab-lens-root')?.shadowRoot?.querySelector('[data-action="bookmarks"]')?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) state.bookmarkDrawerReturnFocus?.focus?.();
    state.bookmarkDrawerReturnFocus = null;
  }

  function bookmarkRangeLabel(record) {
    return record.location.startLine === record.location.endLine
      ? `L${record.location.startLine}`
      : `L${record.location.startLine}–${record.location.endLine}`;
  }

  function createBookmarkListItem(record, stale) {
    const item = document.createElement('li');
    item.className = 'bookmark-item';
    item.dataset.stale = String(stale);
    const main = document.createElement('div');
    main.className = 'bookmark-main';
    const path = document.createElement('strong');
    path.textContent = record.location.path;
    path.title = record.location.path;
    const meta = document.createElement('span');
    meta.className = 'bookmark-meta';
    meta.textContent = `${bookmarkRangeLabel(record)} · ${record.location.side} side${stale ? ' · stale' : ''}`;
    const context = document.createElement('span');
    context.className = 'bookmark-context';
    context.textContent = record.label;
    main.append(path, meta, context);
    const actions = document.createElement('div');
    actions.className = 'bookmark-actions';
    if (stale) {
      const recover = document.createElement('button');
      recover.type = 'button';
      recover.dataset.bookmarkAction = 'recover';
      recover.dataset.bookmarkId = record.id;
      recover.textContent = 'Recover';
      actions.append(recover);
    } else {
      const jump = document.createElement('button');
      jump.type = 'button';
      jump.dataset.bookmarkAction = 'jump';
      jump.dataset.bookmarkId = record.id;
      jump.textContent = 'Jump';
      actions.append(jump);
    }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'quiet';
    remove.dataset.bookmarkAction = 'remove';
    remove.dataset.bookmarkId = record.id;
    remove.setAttribute('aria-label', `Remove bookmark ${record.location.path} ${bookmarkRangeLabel(record)}`);
    remove.textContent = 'Remove';
    actions.append(remove);
    item.append(main, actions);
    return item;
  }

  function renderBookmarkSection(shadow, selector, records, stale) {
    const list = shadow.querySelector(selector);
    list.replaceChildren();
    if (!records.length) {
      const empty = document.createElement('li');
      empty.className = 'bookmark-empty';
      empty.textContent = stale ? 'No stale bookmarks.' : 'No bookmarks for this MR head.';
      list.append(empty);
      return;
    }
    records.forEach((record) => list.append(createBookmarkListItem(record, stale)));
  }

  function renderBookmarkDrawer() {
    const shadow = document.getElementById('golens-bookmark-drawer-root')?.shadowRoot;
    if (!shadow) return;
    renderBookmarkSection(shadow, '[data-bookmark-list="current"]', state.bookmarkSnapshot.current, false);
    renderBookmarkSection(shadow, '[data-bookmark-list="stale"]', state.bookmarkSnapshot.stale, true);
    shadow.querySelector('[data-bookmark-section="stale"]').hidden = state.bookmarkSnapshot.stale.length === 0;
    shadow.querySelector('[data-clear="current"]').disabled = state.bookmarkSnapshot.current.length === 0;
    shadow.querySelector('[data-clear="stale"]').disabled = state.bookmarkSnapshot.stale.length === 0;
    shadow.querySelector('[data-clear="all"]').disabled = state.bookmarkSnapshot.current.length + state.bookmarkSnapshot.stale.length === 0;
  }

  function showBookmarkDrawer() {
    const existing = document.getElementById('golens-bookmark-drawer-root');
    if (existing) { closeBookmarkDrawer(); return; }
    const trigger = document.getElementById('gitlab-lens-root')?.shadowRoot?.querySelector('[data-action="bookmarks"]');
    if (!trigger) return;
    state.bookmarkDrawerReturnFocus = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    const bounds = state.controlsHost?.getBoundingClientRect();
    const host = document.createElement('aside');
    host.id = 'golens-bookmark-drawer-root';
    host.style.setProperty('--golens-bookmark-drawer-left', `${Math.max(12, Math.min(innerWidth - 392, (bounds?.left || innerWidth - 420) - 382))}px`);
    host.style.setProperty('--golens-bookmark-drawer-top', `${Math.max(12, Math.min(innerHeight - 520, bounds?.top || 72))}px`);
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all:initial; position:fixed; z-index:var(--golens-z-popover); left:var(--golens-bookmark-drawer-left); top:var(--golens-bookmark-drawer-top); width:min(380px,calc(100vw - 24px)); max-height:min(500px,calc(100vh - 24px)); color-scheme:dark; color:var(--golens-text-primary); font:13px/1.4 var(--golens-font-ui); }
        * { box-sizing:border-box; }
        .drawer { display:flex; max-height:inherit; flex-direction:column; overflow:hidden; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-overlay); background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-overlay); }
        header { display:flex; align-items:center; justify-content:space-between; padding:12px 14px; border-bottom:1px solid var(--golens-border-subtle); }
        h2,h3,p { margin:0; } h2 { font-size:14px; } h3 { padding:10px 14px 6px; color:var(--golens-text-secondary); font-size:11px; letter-spacing:.06em; text-transform:uppercase; }
        .scroll { overflow:auto; padding-bottom:8px; }
        ul { display:grid; gap:6px; margin:0; padding:0 8px; list-style:none; }
        .bookmark-item { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px; align-items:center; padding:9px; border:1px solid var(--golens-border-subtle); border-radius:var(--golens-radius-sm); background:var(--golens-surface-raised); }
        .bookmark-item[data-stale="true"] { border-style:dashed; opacity:.86; }
        .bookmark-main { display:grid; min-width:0; gap:2px; } strong,.bookmark-context { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; } strong { font:650 12px/1.3 var(--golens-font-mono); }
        .bookmark-meta { color:var(--golens-info); font:600 11px/1.3 var(--golens-font-mono); } .bookmark-context { color:var(--golens-text-secondary); font-size:11px; }
        .bookmark-actions { display:flex; gap:4px; }
        button { border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-xs); padding:5px 7px; background:var(--golens-primary-soft); color:var(--golens-primary-hover); font:650 11px/1.2 var(--golens-font-ui); cursor:pointer; }
        button.quiet,header button,.footer button { background:transparent; color:var(--golens-text-secondary); } button:hover:not(:disabled) { border-color:var(--golens-primary); color:var(--golens-text-primary); } button:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:2px; } button:disabled { opacity:.4; cursor:default; }
        .bookmark-empty { padding:12px; color:var(--golens-text-muted); text-align:center; }
        .footer { display:flex; flex-wrap:wrap; gap:6px; padding:10px; border-top:1px solid var(--golens-border-subtle); }
        .status { min-height:18px; padding:0 12px 8px; color:var(--golens-text-secondary); font-size:11px; }
      </style>
      <section class="drawer" role="dialog" aria-label="MR bookmarks">
        <header><h2>MR bookmarks</h2><button type="button" data-action="close" aria-label="Close bookmarks">Close</button></header>
        <div class="scroll">
          <section><h3>Current head</h3><ul data-bookmark-list="current"></ul></section>
          <section data-bookmark-section="stale"><h3>Stale after head change</h3><ul data-bookmark-list="stale"></ul></section>
        </div>
        <p class="status" role="status" aria-live="polite"></p>
        <div class="footer"><button type="button" data-clear="current">Clear current</button><button type="button" data-clear="stale">Clear stale</button><button type="button" data-clear="all">Clear all for MR</button></div>
      </section>`;
    shadow.querySelector('[data-action="close"]').addEventListener('click', () => closeBookmarkDrawer());
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); closeBookmarkDrawer(); }
    });
    shadow.addEventListener('click', async (event) => {
      const action = event.target.closest('[data-bookmark-action]');
      const clear = event.target.closest('[data-clear]');
      const status = shadow.querySelector('.status');
      if (action) {
        const record = [...state.bookmarkSnapshot.current, ...state.bookmarkSnapshot.stale].find((item) => item.id === action.dataset.bookmarkId);
        if (!record) return;
        if (action.dataset.bookmarkAction === 'jump') await globalThis.GoLensGoNavigation.revealBookmark(record);
        if (action.dataset.bookmarkAction === 'remove') await globalThis.GoLensGoNavigation.removeBookmark(record);
        if (action.dataset.bookmarkAction === 'recover') {
          action.disabled = true;
          status.textContent = 'Checking commit-pinned context…';
          const result = await globalThis.GoLensGoNavigation.recoverBookmark(record);
          status.textContent = result.status === 'recovered' ? 'Bookmark recovered.' : result.message || 'Bookmark could not be recovered safely.';
        }
      }
      if (clear) {
        const mode = clear.dataset.clear === 'current' ? 'current' : clear.dataset.clear;
        const count = await globalThis.GoLensGoNavigation.clearBookmarks(mode);
        status.textContent = count ? `Cleared ${count} bookmark${count === 1 ? '' : 's'}.` : 'No matching bookmarks to clear.';
      }
    });
    document.body.append(host);
    renderBookmarkDrawer();
    shadow.querySelector('[data-action="close"]').focus();
  }

  function closeOnboarding() {
    const host = document.getElementById('golens-onboarding-root');
    if (!host) return;
    host.remove();
    state.onboardingOverlayRelease?.();
    state.onboardingOverlayRelease = null;
    state.onboardingReturnFocus?.focus?.();
    state.onboardingReturnFocus = null;
  }

  // The settings overlay's DOM, its settings.html embedding, its
  // ready-handshake and its overlay-registry claim now live in
  // page/features/settings-overlay.js (ticket 16), mounted through
  // page/main.js. This file no longer creates or removes
  // `#golens-settings-root`, and no longer answers the three
  // golens-*-settings messages: bootstrap.js is the responder for those
  // (it can answer truthfully, since it awaits the feature's own outcome).
  // What stays here is onboarding's side of the mutual exclusion, below.

  function onboardingFeatureIcon(name) {
    if (name === 'brand') {
      return `<span class="feature-icon feature-icon-brand" data-feature-icon="brand" aria-hidden="true"><img src="${chrome.runtime.getURL('assets/icons/golens-32.png')}" alt=""></span>`;
    }
    const icons = {
      focus: {
        tone: 'info',
        body: '<path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"></path><path d="M8.5 12h7"></path>',
      },
      download: {
        tone: 'brand',
        body: '<path d="M12 3v11m0 0 4-4m-4 4-4-4"></path><path d="M5 17v3h14v-3"></path>',
      },
      hover: {
        tone: 'info',
        body: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"></path><circle cx="12" cy="12" r="2.5"></circle>',
      },
      navigate: {
        tone: 'info',
        body: '<rect x="6" y="3" width="12" height="18" rx="6"></rect><path d="M12 3v7M6 10h12"></path>',
      },
      inDiff: {
        tone: 'brand',
        viewBox: '0 0 16 16',
        filled: true,
        body: '<path d="M2 2h2v6a3 3 0 0 0 3 3h4.2L9 8.8 10.4 7 15 11.5 10.4 16 9 14.2l2.2-2.2H7a4 4 0 0 1-4-4V2z"></path>',
      },
      copy: {
        tone: 'info',
        viewBox: '0 0 16 16',
        body: '<rect x="5.25" y="5.25" width="8" height="8" rx="1.25"></rect><path d="M10.75 5.25V3.5c0-.7-.55-1.25-1.25-1.25h-6c-.7 0-1.25.55-1.25 1.25v6c0 .7.55 1.25 1.25 1.25h1.75"></path>',
      },
      testDouble: {
        tone: 'success',
        body: '<path d="M9 3h6M10 3v5l-5 8.5A3 3 0 0 0 7.6 21h8.8a3 3 0 0 0 2.6-4.5L14 8V3M8.5 14h7"></path>',
      },
      rapid: {
        tone: 'brand',
        body: '<path d="M13 2 4 14h7v8l9-12h-7z"></path>',
      },
      fullFile: {
        tone: 'neutral',
        viewBox: '0 0 16 16',
        body: '<path d="M3 1.75h10M3 14.25h10M8 3.25v3.5m0-3.5L6.25 5M8 3.25 9.75 5M8 12.75v-3.5m0 3.5L6.25 11M8 12.75 9.75 11"></path>',
      },
      search: {
        tone: 'info',
        body: '<circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4.5 4.5"></path>',
      },
      testFile: {
        tone: 'success',
        body: '<path d="M6 3h7l5 5v13H6zM13 3v5h5"></path><path d="m10 13-2 2 2 2m4-4 2 2-2 2"></path>',
      },
      generated: {
        tone: 'muted',
        body: '<path d="M3 3l18 18"></path><path d="M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 5.3A10.8 10.8 0 0 1 12 5c6 0 9.5 7 9.5 7a15.4 15.4 0 0 1-2.4 3.2M6.6 6.6A16 16 0 0 0 2.5 12s3.5 7 9.5 7a9.7 9.7 0 0 0 3.4-.6"></path>',
      },
      discussion: {
        tone: 'brand',
        body: '<path d="M5 18l-2 3V7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3z"></path><path d="M9 11h7m-3-3 3 3-3 3"></path>',
      },
      bookmark: {
        tone: 'brand',
        body: '<path d="M6 3.5h12v17l-6-4-6 4z"></path>',
      },
      settings: {
        tone: 'neutral',
        body: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"></path><circle cx="16" cy="7" r="2"></circle><circle cx="8" cy="17" r="2"></circle>',
      },
      database: {
        tone: 'info',
        body: '<ellipse cx="12" cy="5" rx="7" ry="3"></ellipse><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7"></path>',
      },
      replay: {
        tone: 'neutral',
        viewBox: '0 0 16 16',
        body: '<path d="M3 8h9m-3.5-3.5L12 8l-3.5 3.5"></path>',
      },
      lock: {
        tone: 'success',
        body: '<rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"></path>',
      },
    };
    const icon = icons[name];
    if (!icon) return '';
    const classes = ['feature-icon', `feature-icon-${icon.tone}`];
    if (icon.filled) classes.push('feature-icon-filled');
    return `<span class="${classes.join(' ')}" data-feature-icon="${name}" aria-hidden="true"><svg viewBox="${icon.viewBox || '0 0 24 24'}">${icon.body}</svg></span>`;
  }

  function showSetupOnboarding() {
    const existing = document.getElementById('golens-onboarding-root');
    if (existing) {
      existing.shadowRoot?.querySelector('input:checked, button')?.focus();
      return;
    }

    const shortcuts = globalThis.GoLensShortcuts;
    const currentBindings = shortcuts?.mergeBindings(state.settings.shortcutBindings) || state.settings.shortcutBindings;
    const currentPreset = shortcuts?.presetForBindings(currentBindings) || 'custom';
    const presetOptions = (shortcuts?.presets || []).map((preset) => `
      <label class="choice-card">
        <input type="radio" name="keymap" value="${preset.id}" ${currentPreset === preset.id ? 'checked' : ''}>
        <span><strong>${preset.label}</strong><small>${preset.description}${preset.id === 'vim' ? '. Shortcuts only, without modes or command sequences.' : ''}</small></span>
      </label>
    `).join('');
    const customOption = currentPreset === 'custom' ? `
      <label class="choice-card">
        <input type="radio" name="keymap" value="custom" checked>
        <span><strong>Keep current shortcuts</strong><small>Your customized bindings will not be replaced.</small></span>
      </label>
    ` : '';

    state.onboardingReturnFocus = document.activeElement;
    const host = document.createElement('div');
    host.id = 'golens-onboarding-root';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all:initial; position:fixed; inset:0; z-index:var(--golens-z-modal); color:var(--golens-text-primary); font:14px/1.45 var(--golens-font-sans); color-scheme:dark; }
        * { box-sizing:border-box; }
        .backdrop { position:absolute; inset:0; display:grid; place-items:center; overflow:auto; padding:var(--golens-space-6); background:rgba(9,10,12,.82); backdrop-filter:blur(4px); }
        .dialog { position:relative; display:grid; grid-template-rows:auto minmax(0,1fr) auto; width:min(680px,calc(100vw - 32px)); max-height:min(680px,calc(100dvh - 32px)); overflow:hidden; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-xl); background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-lg); }
        .hero { display:grid; grid-template-columns:56px minmax(0,1fr); gap:var(--golens-space-4); align-items:center; padding:var(--golens-space-5) var(--golens-space-6); border-bottom:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); }
        .mascot { width:56px; height:56px; object-fit:contain; }
        .eyebrow { margin:0 0 var(--golens-space-1); color:var(--golens-primary-hover); font-size:10px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; }
        h1 { margin:0; color:var(--golens-text-primary); font-size:23px; line-height:1.15; letter-spacing:-.025em; }
        .intro { margin:var(--golens-space-2) 0 0; color:var(--golens-text-secondary); font-size:12px; }
        .close { position:absolute; top:var(--golens-space-3); right:var(--golens-space-3); display:grid; place-items:center; width:32px; height:32px; padding:0; border:1px solid transparent; border-radius:var(--golens-radius-sm); background:transparent; color:var(--golens-text-muted); cursor:pointer; font:22px/1 var(--golens-font-sans); }
        .close:hover { border-color:var(--golens-border-default); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
        .setup-panel { min-height:0; overflow:auto; padding:var(--golens-space-6); }
        .setup-panel[hidden] { display:none; }
        .step-label { margin:0 0 var(--golens-space-1); color:var(--golens-primary-hover); font:800 10px/1.3 var(--golens-font-mono); letter-spacing:.08em; text-transform:uppercase; }
        h2 { margin:0; color:var(--golens-text-primary); font-size:20px; line-height:1.2; letter-spacing:-.015em; }
        .step-intro { max-width:58ch; margin:var(--golens-space-2) 0 var(--golens-space-5); color:var(--golens-text-secondary); font-size:12px; }
        .choice-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--golens-space-3); }
        .choice-card { position:relative; display:grid; grid-template-columns:auto minmax(0,1fr); gap:var(--golens-space-3); align-items:start; min-height:78px; padding:var(--golens-space-4); border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-panel); background:var(--golens-surface-raised); cursor:pointer; }
        .choice-card:hover { border-color:var(--golens-border-strong); background:var(--golens-surface-hover); }
        .choice-card:has(input:checked) { border-color:var(--golens-primary); background:var(--golens-primary-soft); box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--golens-primary) 30%,transparent); }
        .choice-card input { width:16px; height:16px; margin:2px 0 0; accent-color:var(--golens-primary); }
        .choice-card strong { display:block; color:var(--golens-text-primary); font-size:12px; }
        .choice-card small { display:block; margin-top:4px; color:var(--golens-text-muted); font-size:10.5px; line-height:1.45; }
        .essentials { display:grid; gap:var(--golens-space-3); margin:0; padding:0; list-style:none; }
        .essential { display:grid; grid-template-columns:40px minmax(0,1fr); gap:var(--golens-space-3); align-items:center; padding:var(--golens-space-3); border:1px solid var(--golens-border-subtle); border-radius:var(--golens-radius-panel); background:var(--golens-surface-raised); }
        .feature-icon { display:grid; place-items:center; width:40px; height:40px; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-sm); background:var(--golens-surface-inset); color:var(--golens-info-hover); }
        .feature-icon svg { width:24px; height:24px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.75; }
        .feature-icon-filled svg { fill:currentColor; stroke:none; }
        .feature-icon img { width:30px; height:30px; border-radius:var(--golens-radius-xs); object-fit:contain; }
        .essential strong { display:block; color:var(--golens-text-primary); font-size:12px; }
        .essential p { margin:2px 0 0; color:var(--golens-text-secondary); font-size:11px; line-height:1.45; }
        kbd { min-width:24px; padding:2px 6px; border:1px solid var(--golens-border-strong); border-bottom-width:2px; border-radius:var(--golens-radius-xs); background:var(--golens-surface-inset); color:var(--golens-text-primary); font:700 10px/1.4 var(--golens-font-mono); text-align:center; }
        .footer { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:var(--golens-space-3); align-items:center; padding:var(--golens-space-3) var(--golens-space-5); border-top:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); }
        .progress { margin:0; color:var(--golens-text-muted); font:650 10px/1.4 var(--golens-font-mono); text-align:center; }
        .status { min-height:16px; margin:var(--golens-space-3) 0 0; color:var(--golens-error); font-size:11px; }
        .secondary,.primary { min-height:36px; padding:0 var(--golens-space-4); border-radius:var(--golens-radius-sm); cursor:pointer; font:750 12px/1 var(--golens-font-sans); white-space:nowrap; }
        .secondary { border:1px solid var(--golens-border-default); background:transparent; color:var(--golens-text-secondary); }
        .secondary:hover { border-color:var(--golens-border-strong); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
        .secondary[hidden] { visibility:hidden; display:block; }
        .primary { border:1px solid var(--golens-primary); background:var(--golens-primary); color:var(--golens-text-inverse); font-weight:800; }
        .primary:hover { border-color:var(--golens-primary-hover); background:var(--golens-primary-hover); }
        button:focus-visible,input:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:2px; }
        @media (max-width:640px) { .backdrop { padding:var(--golens-space-3); } .dialog { max-height:calc(100dvh - 24px); } .hero { grid-template-columns:44px 1fr; padding:var(--golens-space-4) var(--golens-space-5); } .mascot { width:44px; height:44px; } h1 { padding-right:var(--golens-space-5); font-size:20px; } .setup-panel { padding:var(--golens-space-5); } .choice-grid { grid-template-columns:1fr; } }
        @media (prefers-reduced-motion:reduce) { .backdrop { backdrop-filter:none; } }
      </style>
      <div class="backdrop" data-action="backdrop">
        <section class="dialog" data-onboarding-dialog data-onboarding-mode="setup" role="dialog" aria-modal="true" aria-labelledby="golens-setup-title" aria-describedby="golens-setup-description">
          <button class="close" type="button" data-action="close-onboarding" aria-label="Close setup">×</button>
          <header class="hero">
            <img class="mascot" src="${chrome.runtime.getURL('assets/icons/golens-128.png')}" alt="">
            <div><p class="eyebrow">Quick setup</p><h1 id="golens-setup-title">Make GoLens feel familiar</h1><p class="intro" id="golens-setup-description">Two choices, then the essentials.</p></div>
          </header>
          <section class="setup-panel" data-setup-panel>
            <p class="step-label">Keyboard</p>
            <h2>Which shortcuts should GoLens use?</h2>
            <p class="step-intro">Choose a familiar keymap. You can customize every action later.</p>
            <div class="choice-grid">${customOption}${presetOptions}</div>
          </section>
          <section class="setup-panel" data-setup-panel hidden>
            <p class="step-label">Diff display</p>
            <h2>Hide generated files?</h2>
            <p class="step-intro">GoLens follows GitLab’s <code>.gitattributes</code> generated marker. Large collapsed files remain visible.</p>
            <div class="choice-grid">
              <label class="choice-card"><input type="radio" name="generated-files" value="show" ${state.settings.hideGeneratedFiles ? '' : 'checked'}><span><strong>Show generated files</strong><small>Keep GitLab’s complete changed-file list visible.</small></span></label>
              <label class="choice-card"><input type="radio" name="generated-files" value="hide" ${state.settings.hideGeneratedFiles ? 'checked' : ''}><span><strong>Hide generated files</strong><small>Hide marked files and dim generated-only folders.</small></span></label>
            </div>
          </section>
          <section class="setup-panel" data-setup-panel hidden>
            <p class="step-label">Ready</p>
            <h2>Four things to remember</h2>
            <p class="step-intro">The complete feature guide stays available in Settings under Help.</p>
            <ul class="essentials">
              <li class="essential">${onboardingFeatureIcon('brand')}<div><strong>Use the review controls</strong><p>Toggle GoLens, enter review focus, or cache related packages.</p></div></li>
              <li class="essential">${onboardingFeatureIcon('hover')}<div><strong>Hover for Go insight</strong><p>See signatures, documentation, source locations, and usages.</p></div></li>
              <li class="essential">${onboardingFeatureIcon('search')}<div><strong>Plain-click selects occurrences</strong><p>Move through matching identifiers in the loaded diff.</p></div></li>
              <li class="essential">${onboardingFeatureIcon('navigate')}<div><strong><kbd>Cmd</kbd>/<kbd>Ctrl</kbd>-click follows code</strong><p>Resolve definitions, usages, and interface implementations.</p></div></li>
            </ul>
            <p class="status" data-setup-status role="status" aria-live="polite"></p>
          </section>
          <footer class="footer">
            <button class="secondary" type="button" data-action="previous-onboarding" hidden>Back</button>
            <p class="progress" data-tour-progress aria-live="polite">1 of 3 · Keyboard</p>
            <button class="primary" type="button" data-action="next-onboarding">Continue</button>
          </footer>
        </section>
      </div>
    `;

    const close = () => closeOnboarding();
    const panels = [...shadow.querySelectorAll('[data-setup-panel]')];
    const previousButton = shadow.querySelector('[data-action="previous-onboarding"]');
    const primaryButton = shadow.querySelector('[data-action="next-onboarding"]');
    const progress = shadow.querySelector('[data-tour-progress]');
    const labels = ['Keyboard', 'Diff display', 'Ready'];
    let activePage = 0;
    const showPage = (index) => {
      activePage = Math.max(0, Math.min(panels.length - 1, index));
      panels.forEach((panel, panelIndex) => { panel.hidden = panelIndex !== activePage; });
      previousButton.hidden = activePage === 0;
      primaryButton.textContent = activePage === panels.length - 1 ? 'Save and start reviewing' : 'Continue';
      progress.textContent = `${activePage + 1} of ${panels.length} · ${labels[activePage]}`;
      panels[activePage].querySelector('input:checked, input, button')?.focus();
    };
    const save = async () => {
      const presetID = shadow.querySelector('input[name="keymap"]:checked')?.value || currentPreset;
      const hideGeneratedFiles = shadow.querySelector('input[name="generated-files"]:checked')?.value === 'hide';
      const nextSettings = { hideGeneratedFiles };
      if (presetID !== 'custom') nextSettings.shortcutBindings = shortcuts.presetBindings(presetID);
      primaryButton.disabled = true;
      try {
        await Promise.all(Object.entries(nextSettings).map(([key, value]) => settingsStore.set(key, value)));
        state.settings = { ...state.settings, ...nextSettings };
        close();
      } catch (error) {
        shadow.querySelector('[data-setup-status]').textContent = error.message || 'Unable to save these choices.';
        primaryButton.disabled = false;
      }
    };
    shadow.querySelector('[data-action="close-onboarding"]').addEventListener('click', close);
    shadow.querySelector('[data-action="backdrop"]').addEventListener('click', (event) => { if (event.target === event.currentTarget) close(); });
    previousButton.addEventListener('click', () => showPage(activePage - 1));
    primaryButton.addEventListener('click', () => { if (activePage === panels.length - 1) void save(); else showPage(activePage + 1); });
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'Tab') return;
      const focusable = [...shadow.querySelectorAll('button,input')].filter((element) => !element.disabled && !element.hidden && !element.closest('[hidden]'));
      const index = focusable.indexOf(shadow.activeElement);
      const next = event.shiftKey ? (index <= 0 ? focusable.length - 1 : index - 1) : (index === focusable.length - 1 ? 0 : index + 1);
      event.preventDefault();
      focusable[next].focus();
    });
    document.body.append(host);
    state.onboardingOverlayRelease = overlayRegistry?.claim('onboarding') ?? null;
    showPage(0);
  }

  function showOnboarding() {
    const existing = document.getElementById('golens-onboarding-root');
    if (existing) {
      existing.shadowRoot?.querySelector('[role="tab"][aria-selected="true"]')?.focus();
      return;
    }

    state.onboardingReturnFocus = document.activeElement;
    const host = document.createElement('div');
    host.id = 'golens-onboarding-root';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all:initial; position:fixed; inset:0; z-index:var(--golens-z-modal); color:var(--golens-text-primary); font:14px/1.45 var(--golens-font-sans); color-scheme:dark; }
        * { box-sizing:border-box; }
        .backdrop { position:absolute; inset:0; display:grid; place-items:center; overflow:auto; padding:var(--golens-space-6); background:rgba(9,10,12,.82); backdrop-filter:blur(4px); }
        .dialog { position:relative; display:grid; grid-template-rows:auto minmax(0,1fr) auto; width:min(760px,calc(100vw - 32px)); max-height:min(720px,calc(100dvh - 32px)); overflow:hidden; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-xl); background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-lg); }
        .hero { display:grid; grid-template-columns:64px 1fr; gap:var(--golens-space-4); align-items:center; padding:var(--golens-space-5) var(--golens-space-6); border-bottom:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); }
        .mascot { width:64px; height:64px; object-fit:contain; }
        .eyebrow { margin:0 0 var(--golens-space-1); color:var(--golens-primary-hover); font-size:11px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
        h1 { margin:0; color:var(--golens-text-primary); font-size:24px; line-height:1.15; letter-spacing:-.025em; }
        .intro { max-width:560px; margin:var(--golens-space-2) 0 0; color:var(--golens-text-secondary); text-wrap:pretty; }
        .close { position:absolute; top:var(--golens-space-3); right:var(--golens-space-3); display:grid; place-items:center; width:32px; height:32px; padding:0; border:1px solid transparent; border-radius:var(--golens-radius-sm); background:transparent; color:var(--golens-text-muted); cursor:pointer; font:22px/1 var(--golens-font-sans); transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),color var(--golens-motion-fast),transform var(--golens-motion-fast); }
        .close:hover { border-color:var(--golens-border-default); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
        .close:active { background:var(--golens-surface-pressed); transform:translateY(1px); }
        .tour { display:grid; grid-template-columns:180px minmax(0,1fr); min-height:0; }
        .tour-nav { display:grid; align-content:start; gap:var(--golens-space-1); padding:var(--golens-space-4); border-right:1px solid var(--golens-border-subtle); background:var(--golens-surface-inset); }
        .tour-tab { display:grid; grid-template-columns:28px minmax(0,1fr); gap:var(--golens-space-2); align-items:center; min-height:42px; padding:var(--golens-space-2); border:1px solid transparent; border-radius:var(--golens-radius-sm); background:transparent; color:var(--golens-text-secondary); cursor:pointer; font:650 12px/1.3 var(--golens-font-sans); text-align:left; transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),color var(--golens-motion-fast),transform var(--golens-motion-fast); }
        .tour-tab:hover { border-color:var(--golens-border-default); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
        .tour-tab:active { background:var(--golens-surface-pressed); transform:translateY(1px); }
        .tour-tab[aria-selected="true"] { border-color:color-mix(in srgb,var(--golens-primary) 55%,var(--golens-border-default)); background:var(--golens-primary-soft); color:var(--golens-text-primary); }
        .tab-icon { display:grid; place-items:center; width:28px; height:28px; color:var(--golens-text-muted); }
        .tab-icon svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.75; }
        .tab-icon img { width:24px; height:24px; border-radius:var(--golens-radius-xs); object-fit:contain; filter:grayscale(.5); opacity:.78; }
        .tab-symbol { display:inline-flex; width:auto; min-width:24px; height:20px; align-items:center; justify-content:center; padding:0 3px; border:1px solid currentColor; border-radius:var(--golens-radius-xs); color:var(--golens-info-hover); font:700 9px/1 var(--golens-font-mono); }
        .tour-tab[aria-selected="true"] .tab-icon { color:var(--golens-primary-hover); }
        .tour-tab[aria-selected="true"] .tab-icon img { filter:none; opacity:1; }
        .tour-panels { min-width:0; min-height:0; overflow:hidden; }
        .tour-panel { height:100%; overflow:auto; padding:var(--golens-space-5) var(--golens-space-6) var(--golens-space-6); }
        .tour-panel[hidden] { display:none; }
        .chapter-label { margin:0 0 var(--golens-space-1); color:var(--golens-primary-hover); font-size:10px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; }
        h2 { margin:0; color:var(--golens-text-primary); font-size:19px; line-height:1.2; letter-spacing:-.015em; text-wrap:balance; }
        .chapter-intro { max-width:58ch; margin:var(--golens-space-2) 0 var(--golens-space-4); color:var(--golens-text-secondary); font-size:12px; line-height:1.55; text-wrap:pretty; }
        .feature-list { display:grid; gap:0; margin:0; padding:0; list-style:none; }
        .feature { display:grid; grid-template-columns:40px minmax(0,1fr); gap:var(--golens-space-3); align-items:start; padding:var(--golens-space-3) 0; border-top:1px solid var(--golens-border-subtle); }
        .feature-icon { display:grid; place-items:center; width:40px; height:40px; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-sm); background:var(--golens-surface-raised); color:var(--golens-text-secondary); box-shadow:inset 0 1px 0 color-mix(in srgb,var(--golens-text-primary) 5%,transparent); }
        .feature-icon svg { width:24px; height:24px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.75; }
        .feature-icon-filled svg { fill:currentColor; stroke:none; }
        .feature-icon img { width:30px; height:30px; border-radius:var(--golens-radius-xs); object-fit:contain; }
        .feature-icon-brand { border-color:color-mix(in srgb,var(--golens-primary) 45%,var(--golens-border-default)); background:var(--golens-primary-soft); }
        .feature-icon-info { border-color:color-mix(in srgb,var(--golens-info) 35%,var(--golens-border-default)); background:var(--golens-info-soft); color:var(--golens-info-hover); }
        .feature-icon-success { border-color:color-mix(in srgb,var(--golens-success) 35%,var(--golens-border-default)); background:var(--golens-success-soft); color:var(--golens-success); }
        .feature-icon-muted { color:var(--golens-text-muted); }
        .feature strong { display:block; margin:0 0 2px; color:var(--golens-text-primary); font-size:12px; line-height:1.35; }
        .feature p { max-width:62ch; margin:0; color:var(--golens-text-secondary); font-size:11px; line-height:1.5; text-wrap:pretty; }
        .feature-note { color:var(--golens-text-muted); }
        kbd { min-width:24px; padding:2px 6px; border:1px solid var(--golens-border-strong); border-bottom-width:2px; border-radius:var(--golens-radius-xs); background:var(--golens-surface-inset); color:var(--golens-text-primary); font:700 10px/1.4 var(--golens-font-mono); text-align:center; }
        .footer { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:var(--golens-space-3); align-items:center; padding:var(--golens-space-3) var(--golens-space-5); border-top:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); }
        .tour-progress { margin:0; color:var(--golens-text-muted); font:650 10px/1.4 var(--golens-font-mono); text-align:center; }
        .secondary,.primary { min-height:36px; padding:0 var(--golens-space-4); border-radius:var(--golens-radius-sm); cursor:pointer; font:750 12px/1 var(--golens-font-sans); white-space:nowrap; transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),color var(--golens-motion-fast),transform var(--golens-motion-fast); }
        .secondary { border:1px solid var(--golens-border-default); background:transparent; color:var(--golens-text-secondary); }
        .secondary:hover { border-color:var(--golens-border-strong); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
        .secondary[hidden] { visibility:hidden; display:block; }
        .primary { flex:0 0 auto; min-height:38px; padding:0 var(--golens-space-5); border:1px solid var(--golens-primary); border-radius:var(--golens-radius-sm); background:var(--golens-primary); color:var(--golens-text-inverse); cursor:pointer; font:800 13px/1 var(--golens-font-sans); transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),transform var(--golens-motion-fast); }
        .primary:hover { border-color:var(--golens-primary-hover); background:var(--golens-primary-hover); }
        .secondary:active,.primary:active { transform:translateY(1px); }
        .primary:active { border-color:var(--golens-primary-pressed); background:var(--golens-primary-pressed); }
        button:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:2px; }
        @media (max-width:640px) { .backdrop { padding:var(--golens-space-3); } .dialog { max-height:calc(100dvh - 24px); } .hero { grid-template-columns:48px 1fr; padding:var(--golens-space-4) var(--golens-space-5); } .mascot { width:48px; height:48px; } h1 { padding-right:var(--golens-space-5); font-size:20px; } .tour { grid-template-columns:1fr; grid-template-rows:auto minmax(0,1fr); } .tour-nav { grid-template-columns:repeat(4,minmax(112px,1fr)); overflow-x:auto; padding:var(--golens-space-2) var(--golens-space-3); border-right:0; border-bottom:1px solid var(--golens-border-subtle); } .tour-tab { grid-template-columns:24px minmax(0,1fr); min-height:36px; padding:var(--golens-space-1) var(--golens-space-2); font-size:10px; } .tab-icon { width:24px; height:24px; } .tab-icon svg { width:18px; height:18px; } .tab-icon img { width:22px; height:22px; } .tour-panel { padding:var(--golens-space-4) var(--golens-space-5) var(--golens-space-5); } }
        @media (max-width:420px) { .hero { grid-template-columns:1fr; } .mascot { display:none; } .footer { grid-template-columns:auto 1fr auto; padding-inline:var(--golens-space-3); } .secondary,.primary { padding-inline:var(--golens-space-3); } }
        @media (prefers-reduced-motion:reduce) { .close,.tour-tab,.secondary,.primary { transition:none; } .close:active,.tour-tab:active,.secondary:active,.primary:active { transform:none; } }
      </style>
      <div class="backdrop" data-action="backdrop">
        <section class="dialog" data-onboarding-dialog role="dialog" aria-modal="true" aria-labelledby="golens-onboarding-title" aria-describedby="golens-onboarding-description">
          <button class="close" type="button" data-action="close-onboarding" aria-label="Close quick tour">×</button>
          <header class="hero">
            <img class="mascot" src="${chrome.runtime.getURL('assets/icons/golens-128.png')}" alt="">
            <div>
              <p class="eyebrow">Quick tour</p>
              <h1 id="golens-onboarding-title">Welcome to GoLens for GitLab</h1>
              <p class="intro" id="golens-onboarding-description">A concise reference for every GoLens review tool.</p>
            </div>
          </header>
          <div class="tour">
            <nav class="tour-nav" role="tablist" aria-label="Quick tour chapters">
              <button class="tour-tab" id="golens-tour-tab-controls" type="button" role="tab" aria-selected="true" aria-controls="golens-tour-controls"><span class="tab-icon" aria-hidden="true"><img src="${chrome.runtime.getURL('assets/icons/golens-32.png')}" alt=""></span><span>Page controls</span></button>
              <button class="tour-tab" id="golens-tour-tab-go" type="button" role="tab" aria-selected="false" aria-controls="golens-tour-go" tabindex="-1"><span class="tab-icon" aria-hidden="true"><span class="tab-symbol">Go</span></span><span>Go intelligence</span></button>
              <button class="tour-tab" id="golens-tour-tab-diff" type="button" role="tab" aria-selected="false" aria-controls="golens-tour-diff" tabindex="-1"><span class="tab-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3 1.75h10M3 14.25h10M8 3.25v3.5m0-3.5L6.25 5M8 3.25 9.75 5M8 12.75v-3.5m0 3.5L6.25 11M8 12.75 9.75 11"></path></svg></span><span>Diff helpers</span></button>
              <button class="tour-tab" id="golens-tour-tab-popup" type="button" role="tab" aria-selected="false" aria-controls="golens-tour-popup" tabindex="-1"><span class="tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"></path><circle cx="16" cy="7" r="2"></circle><circle cx="8" cy="17" r="2"></circle></svg></span><span>Settings</span></button>
            </nav>
            <div class="tour-panels">
              <section class="tour-panel" id="golens-tour-controls" role="tabpanel" aria-labelledby="golens-tour-tab-controls" tabindex="0">
                <p class="chapter-label">Always beside GitLab’s AI panel</p>
                <h2>Review controls and celebrations</h2>
                <p class="chapter-intro">The compact strip stays beside GitLab’s AI panel throughout the review.</p>
                <ul class="feature-list">
                  <li class="feature">${onboardingFeatureIcon('brand')}<div><strong>Turn GoLens on or off</strong><p>The logo controls GoLens globally and syncs across open GitLab tabs.</p></div></li>
                    <li class="feature">${onboardingFeatureIcon('focus')}<div><strong>Enter fullscreen review focus</strong><p>Hide GitLab chrome, widen the diff, and leave with <kbd>Esc</kbd> or the focus button.</p></div></li>
                    <li class="feature">${onboardingFeatureIcon('download')}<div><strong>Cache related MR packages</strong><p>Fetch changed and related Go packages at the MR head, with progress and completion states.</p></div></li>
                    <li class="feature">${onboardingFeatureIcon('bookmark')}<div><strong>Keep local MR bookmarks</strong><p>Open the fourth control to revisit marked lines and ranges, clear current or stale entries, and recover only uniquely matched destinations after a head change.</p></div></li>
                    <li class="feature">${onboardingFeatureIcon('brand')}<div><strong>Mark review milestones</strong><p>The mascot marks completed caches, resolved discussions, approvals, merges, and the Friday beer-kart celebration. Reduced motion stays static.</p></div></li>
                </ul>
              </section>
              <section class="tour-panel" id="golens-tour-go" role="tabpanel" aria-labelledby="golens-tour-tab-go" tabindex="0" hidden>
                <p class="chapter-label">Browser-native Go navigation</p>
                <h2>Inspect and follow symbols</h2>
                <p class="chapter-intro">Commit-pinned browser indexing provides safe navigation without speculative results.</p>
                <ul class="feature-list">
                  <li class="feature">${onboardingFeatureIcon('hover')}<div><strong>Hover for Go insight</strong><p>See kind, signature, documentation, location, and usages for definitions. Type references show their complete struct or interface body, with a progressive reveal for long declarations.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('navigate')}<div><strong>Navigate by click or shortcut</strong><p><kbd>Cmd</kbd>/<kbd>Ctrl</kbd>-click or <kbd>Cmd/Ctrl F12</kbd> resolves definitions, usages, and implementations.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('search')}<div><strong>Select and revisit occurrences</strong><p>Plain-click highlights loaded-diff occurrences; configured shortcuts move between them.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('inDiff')}<div><strong>Stay in the diff when possible</strong><p>Loaded targets scroll into view; other sources open at their exact destination.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('navigate')}<div><strong>Retrace semantic jumps</strong><p>Move through in-diff semantic history without changing browser history.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('copy')}<div><strong>Use the small popover tools</strong><p>Pin results, copy <span class="feature-note">file:line:column</span>, expand signatures, choose matches, or close with <kbd>Esc</kbd>.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('search')}<div><strong>Check the search scope</strong><p>Results identify package, indexed-package, or complete-project coverage.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('download')}<div><strong>Search the complete project explicitly</strong><p>Run cancellable commit-pinned search when current coverage is incomplete.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('testDouble')}<div><strong>Separate test doubles</strong><p>Production implementations stay ahead of an expandable test-double group.</p></div></li>
                </ul>
              </section>
              <section class="tour-panel" id="golens-tour-diff" role="tabpanel" aria-labelledby="golens-tour-tab-diff" tabindex="0" hidden>
                <p class="chapter-label">Small helpers across the merge request</p>
                <h2>Move through large diffs faster</h2>
                <p class="chapter-intro">Small GitLab-native helpers keep large reviews moving.</p>
                <ul class="feature-list">
                  <li class="feature">${onboardingFeatureIcon('rapid')}<div><strong>Use Rapid Diffs automatically</strong><p>GoLens enables GitLab’s Rapid Diffs opt-in when it is offered.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('fullFile')}<div><strong>Show a full file</strong><p>Expand a file beyond changed lines, then return to changes-only.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('search')}<div><strong>Reach file search from the keyboard</strong><p><kbd>Cmd/Ctrl P</kbd> focuses file search; <kbd>Shift F</kbd> clears it and returns.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('inDiff')}<div><strong>Move by hunk or file</strong><p>Configured shortcuts move between hunks and files with a brief destination highlight.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('bookmark')}<div><strong>Bookmark lines and ranges</strong><p>Use a gutter marker, select contiguous lines on one diff side, or configure toggle/previous/next bookmark shortcuts. Old and new sides stay distinct.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('testFile')}<div><strong>Spot Go test files</strong><p><span class="feature-note">_test.go</span> files receive a subtle green file-tree label.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('generated')}<div><strong>Optionally hide generated files</strong><p>Hide <span class="feature-note">.gitattributes</span>-marked files while keeping large collapsed files visible.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('discussion')}<div><strong>Jump from overview discussions to code</strong><p><span class="feature-note">View in changes</span> opens the exact commented line.</p></div></li>
                </ul>
              </section>
              <section class="tour-panel" id="golens-tour-popup" role="tabpanel" aria-labelledby="golens-tour-tab-popup" tabindex="0" hidden>
                <p class="chapter-label">Open from the compact browser menu</p>
                <h2>Tabbed settings and cache control</h2>
                <p class="chapter-intro">Manage synchronized preferences, access, caching, and help.</p>
                <ul class="feature-list">
                  <li class="feature">${onboardingFeatureIcon('settings')}<div><strong>Open the settings overlay</strong><p>The browser-menu gear opens settings over the active GitLab page; close with <kbd>Esc</kbd>, the button, or backdrop.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('settings')}<div><strong>Set global review preferences</strong><p>Control global enablement, generated files, and contextual shortcut tips.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('navigate')}<div><strong>Choose a familiar keymap</strong><p>Apply GoLens, VS Code, IntelliJ IDEA, or non-modal Vim-style bindings, then customize them. Contextual tips retire after successful use.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('lock')}<div><strong>Approve self-hosted GitLab origins</strong><p>Add or remove each trusted HTTP(S) origin explicitly; GitLab.com works automatically.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('download')}<div><strong>Cache the full project</strong><p>Broaden navigation beyond related MR packages with visible progress.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('database')}<div><strong>Inspect or clear the source cache</strong><p>Review cache size and record counts, or remove all snapshots.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('bookmark')}<div><strong>Keep bookmarks private</strong><p>Only minimal location metadata and context fingerprints are stored locally. Source excerpts are not stored with bookmarks or synchronized.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('replay')}<div><strong>Replay this complete tour</strong><p>Open this feature guide again from Settings under Help.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('lock')}<div><strong>Keep repository source local</strong><p>Source stays in your browser and signed-in GitLab origin, with commit-pinned same-origin requests.</p></div></li>
                </ul>
              </section>
            </div>
          </div>
          <footer class="footer">
            <button class="secondary" type="button" data-action="previous-onboarding" hidden>Back</button>
            <p class="tour-progress" data-tour-progress aria-live="polite">1 of 4 · Page controls</p>
            <button class="primary" type="button" data-action="next-onboarding">Next</button>
          </footer>
        </section>
      </div>
    `;

    const close = () => closeOnboarding();
    const closeButton = shadow.querySelector('[data-action="close-onboarding"]');
    const tabs = [...shadow.querySelectorAll('[role="tab"]')];
    const panels = [...shadow.querySelectorAll('[role="tabpanel"]')];
    const previousButton = shadow.querySelector('[data-action="previous-onboarding"]');
    const primaryButton = shadow.querySelector('[data-action="next-onboarding"]');
    const progress = shadow.querySelector('[data-tour-progress]');
    let activePage = 0;
    const showPage = (index, { focusTab = false } = {}) => {
      activePage = Math.max(0, Math.min(tabs.length - 1, index));
      tabs.forEach((tab, tabIndex) => {
        const active = tabIndex === activePage;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
      });
      panels.forEach((panel, panelIndex) => { panel.hidden = panelIndex !== activePage; });
      previousButton.hidden = activePage === 0;
      primaryButton.textContent = activePage === tabs.length - 1 ? 'Start reviewing' : 'Next';
      progress.textContent = `${activePage + 1} of ${tabs.length} · ${tabs[activePage].lastElementChild.textContent.trim()}`;
      if (focusTab) tabs[activePage].focus();
    };
    closeButton.addEventListener('click', close);
    tabs.forEach((tab, index) => tab.addEventListener('click', () => showPage(index)));
    previousButton.addEventListener('click', () => showPage(activePage - 1));
    primaryButton.addEventListener('click', () => {
      if (activePage === tabs.length - 1) close();
      else showPage(activePage + 1);
    });
    shadow.querySelector('[data-action="backdrop"]').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) close();
    });
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.target.getAttribute?.('role') === 'tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const nextPage = event.key === 'Home'
          ? 0
          : event.key === 'End'
          ? tabs.length - 1
          : activePage + (event.key === 'ArrowRight' ? 1 : -1);
        showPage((nextPage + tabs.length) % tabs.length, { focusTab: true });
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [closeButton, ...tabs, previousButton, ...panels, primaryButton]
        .filter((element) => !element.disabled && !element.hidden && !element.closest('[hidden]') && element.tabIndex >= 0);
      const index = focusable.indexOf(shadow.activeElement);
      const next = event.shiftKey
        ? (index <= 0 ? focusable.length - 1 : index - 1)
        : (index === focusable.length - 1 ? 0 : index + 1);
      event.preventDefault();
      focusable[next].focus();
    });
    document.body.append(host);
    state.onboardingOverlayRelease = overlayRegistry?.claim('onboarding') ?? null;
    showPage(0);
    primaryButton.focus();
  }

  async function showFirstRunOnboarding() {
    if (!settingsStore) return;
    if (settingsStore.get(ONBOARDING_STORAGE_KEY) >= ONBOARDING_VERSION) return;
    showSetupOnboarding();
    await settingsStore.set(ONBOARDING_STORAGE_KEY, ONBOARDING_VERSION);
  }

  function wireControls(shadow) {
    shadow.querySelector('[data-action="toggle-enabled"]').addEventListener('click', () => setEnabled(!state.enabled, { persist: true }));
    shadow.querySelector('[data-action="focus"]').addEventListener('click', async () => {
      if (!state.enabled) return;
      await toggleReviewFocus();
      renderControlState(shadow);
    });
    shadow.querySelector('[data-action="preload"]').addEventListener('click', preloadMergeRequest);
    shadow.querySelector('[data-action="bookmarks"]').addEventListener('click', showBookmarkDrawer);
  }

  function setPreloadState(status, { message = '', progress = null } = {}) {
    state.preload = { status, message, progress };
    renderControlState();
  }

  function renderPreloadState(shadow, enabled) {
    const button = shadow.querySelector('[data-action="preload"]');
    const progressBar = button.querySelector('.preload-progress');
    const fill = progressBar.querySelector('.preload-fill');
    const count = button.querySelector('.preload-count');
    const fillCount = button.querySelector('.preload-fill-count');
    const { status, message, progress } = state.preload;
    const busy = status === 'checking' || status === 'busy';
    const percentage = Number.isFinite(progress?.percentage) ? Math.max(0, Math.min(100, progress.percentage)) : null;
    const indeterminate = busy && (percentage === null || progress?.phase === 'discovering');
    const visualState = status === 'checking' ? 'checking' : status;
    button.dataset.state = visualState;
    button.disabled = !enabled || busy;
    button.classList.toggle('is-indeterminate', indeterminate);
    button.toggleAttribute('aria-busy', busy);
    if (indeterminate || percentage === null) {
      progressBar.removeAttribute('aria-valuenow');
      fill.style.width = '';
    } else {
      progressBar.setAttribute('aria-valuenow', String(percentage));
      fill.style.width = `${percentage}%`;
    }
    const showCount = busy
      && !indeterminate
      && progress?.unit === 'packages'
      && Number.isFinite(progress.completed)
      && Number.isFinite(progress.total)
      && progress.total > 0;
    const countLabel = showCount ? `${progress.completed}/${progress.total}` : '';
    count.textContent = countLabel;
    fillCount.textContent = countLabel;
    count.hidden = !showCount;
    fillCount.hidden = !showCount;
    const countLength = countLabel.replace('/', '').length;
    button.dataset.countSize = countLength > 6 ? 'tiny' : countLength > 4 ? 'small' : 'normal';

    const label = status === 'complete'
      ? (message || 'Related MR cache ready')
      : status === 'busy' || status === 'checking'
      ? (message || 'Checking MR head cache…')
      : status === 'error'
      ? `Cache related MR packages · ${message || 'previous attempt failed'}`
      : 'Cache related MR packages';
    button.title = label;
    button.setAttribute('aria-label', label);
  }

  function renderControlState(shadow = document.getElementById('gitlab-lens-root')?.shadowRoot) {
    if (!shadow) return;
    const enabled = state.enabled;
    const toggle = shadow.querySelector('[data-action="toggle-enabled"]');
    const focus = shadow.querySelector('[data-action="focus"]');
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.setAttribute('title', enabled ? 'Turn GoLens off' : 'Turn GoLens on');
    toggle.setAttribute('aria-label', enabled ? 'Turn GoLens off' : 'Turn GoLens on');
    toggle.dataset.reviewFocus = String(enabled && inReviewFocus());
    focus.disabled = !enabled;
    focus.setAttribute('aria-pressed', String(enabled && inReviewFocus()));
    renderPreloadState(shadow, enabled);
    renderBookmarkControl(shadow);
  }

  async function preloadMergeRequest() {
    if (!state.enabled || state.preload.status === 'checking' || state.preload.status === 'busy') return;
    const navigation = globalThis.GoLensGoNavigation;
    if (!navigation?.preloadMergeRequest) return;
    const runID = ++state.preloadRunID;
    setPreloadState('busy', { message: 'Preparing MR head cache…' });
    try {
      const result = await navigation.preloadMergeRequest((message, progress) => {
        if (runID === state.preloadRunID) setPreloadState('busy', { message, progress });
      });
      if (runID !== state.preloadRunID) return;
      const message = result.searchStatus === 'unavailable'
        ? 'Related cache ready · code search unavailable'
        : result.searchStatus === 'limited'
        ? 'Related cache ready · candidate search limited'
        : result.coverage === 'full' ? 'Full project cached' : 'Related MR cache ready';
      setPreloadState('complete', { message, progress: { percentage: 100 } });
      triggerPitstopMoment();
    } catch (error) {
      if (runID !== state.preloadRunID) return;
      setPreloadState('error', { message: error.message || 'Preload failed' });
    }
  }

  async function refreshPreloadStatus() {
    const navigation = globalThis.GoLensGoNavigation;
    if (!navigation?.mergeRequestPreloadStatus || state.preload.status === 'busy') return;
    const checkID = ++state.preloadCheckID;
    const wasComplete = state.preload.status === 'complete';
    try {
      const result = await navigation.mergeRequestPreloadStatus();
      if (checkID !== state.preloadCheckID || state.preload.status === 'busy') return;
      if (result.status === 'complete') {
        const message = result.searchStatus === 'unavailable'
          ? 'Related cache ready · code search unavailable'
          : result.searchStatus === 'limited'
          ? 'Related cache ready · candidate search limited'
          : result.coverage === 'full' ? 'Full project cached' : 'Related MR cache ready';
        setPreloadState('complete', { message, progress: { percentage: 100 } });
      } else {
        navigation.invalidateCacheState?.();
        setPreloadState('idle');
      }
    } catch (error) {
      if (checkID !== state.preloadCheckID || wasComplete || state.preload.status === 'busy') return;
      setPreloadState('error', { message: error.message || 'Unable to check cache' });
    }
  }

  async function setEnabled(enabled, { persist = false } = {}) {
    state.enabled = enabled;
    state.settings = { ...state.settings, enabled };
    if (!enabled) {
      state.preloadRunID++;
      state.fullPreloadRunID++;
    }
    renderControlState();
    const persisted = persist && settingsStore ? settingsStore.set('enabled', enabled) : Promise.resolve();
    if (enabled && isMergeRequest()) {
      watchForRapidDiffs();
      globalThis.GoLensGoNavigation?.init();
    } else {
      await disableGoLens();
    }
    reconcileGoTestFileRows();
    reconcileOverviewDiscussionLineLinks();
    renderControlState();
    await persisted;
  }

  function fullPreloadSnapshot() {
    const { status, message, progress } = state.fullPreload;
    return { status, message, progress };
  }

  function startFullProjectPreload() {
    if (state.fullPreload.status === 'busy') return fullPreloadSnapshot();
    const navigation = globalThis.GoLensGoNavigation;
    if (!isMergeRequest() || !navigation?.preloadFullProject) {
      state.fullPreload = { status: 'unavailable', message: 'Open a supported GitLab merge request.', progress: null };
      return fullPreloadSnapshot();
    }
    const runID = ++state.fullPreloadRunID;
    state.fullPreload = { status: 'busy', message: 'Preparing full project cache…', progress: null };
    navigation.preloadFullProject((message, progress) => {
      if (runID === state.fullPreloadRunID) state.fullPreload = { status: 'busy', message, progress };
    }).then(() => {
      if (runID !== state.fullPreloadRunID) return;
      state.fullPreload = { status: 'complete', message: 'Full project cached', progress: { phase: 'ready', percentage: 100 } };
      refreshPreloadStatus();
      triggerPitstopMoment();
    }).catch((error) => {
      if (runID !== state.fullPreloadRunID) return;
      state.fullPreload = { status: 'error', message: error.message || 'Full project cache failed', progress: null };
    });
    return fullPreloadSnapshot();
  }

  async function refreshFullProjectPreloadStatus() {
    if (state.fullPreload.status === 'busy') return fullPreloadSnapshot();
    const navigation = globalThis.GoLensGoNavigation;
    if (!isMergeRequest() || !navigation?.fullProjectPreloadStatus) {
      state.fullPreload = { status: 'unavailable', message: 'Open a supported GitLab merge request.', progress: null };
      return fullPreloadSnapshot();
    }
    try {
      const result = await navigation.fullProjectPreloadStatus();
      state.fullPreload = result.status === 'complete'
        ? { status: 'complete', message: 'Full project cached', progress: { phase: 'ready', percentage: 100 } }
        : { status: 'idle', message: 'Not cached', progress: null };
    } catch (error) {
      state.fullPreload = { status: 'error', message: error.message || 'Unable to check full project cache', progress: null };
    }
    return fullPreloadSnapshot();
  }

  function nativeFileSearch() {
    return document.querySelector('[aria-label="File browser"] input[placeholder]')
      || document.querySelector('[data-testid="file-browser"] input[placeholder]')
      || [...document.querySelectorAll('input[placeholder]')].find((input) => /search\s*\(e\.g\.\s*\*\.vue\)/i.test(input.placeholder));
  }

  function isBlockedShortcutEvent(event) {
    const search = nativeFileSearch();
    const targets = [...event.composedPath(), document.activeElement].filter(Boolean);
    return targets.some((target) => {
      if (target === search) return true;
      const blocked = target?.closest?.('input, textarea, select, [contenteditable], dialog, [role="dialog"], [aria-modal="true"]');
      if (!blocked) return false;
      if (!blocked.matches?.('input, textarea, select, [contenteditable]')) return true;
      return !blocked.disabled && !blocked.readOnly && blocked.getAttribute('contenteditable') !== 'false';
    });
  }

  function focusNativeFileSearch() {
    const search = nativeFileSearch();
    if (!search) return false;
    search.focus();
    search.select();
    return true;
  }

  function closeNativeFileSearch() {
    const search = nativeFileSearch();
    if (!search) return false;
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    search.blur();
    return true;
  }

  function onShortcutCoachManualClick(event) {
    const search = nativeFileSearch();
    if (!state.enabled || !search || !event.composedPath().includes(search)) return;
    void globalThis.GoLensGoNavigation?.offerShortcutCoach?.('focusFileSearch');
  }

  document.addEventListener('keydown', (event) => {
    if (!state.enabled || !isMergeRequest() || event.isComposing || isBlockedShortcutEvent(event)) return;
    const shortcuts = globalThis.GoLensShortcuts;
    const bindings = shortcuts?.mergeBindings(state.settings.shortcutBindings);
    if (!shortcuts || !bindings) return;
    const action = shortcuts.actions.find(({ id }) => shortcuts.matchesEvent(bindings[id], event))?.id;
    if (!action) return;
    let handled = false;
    if (action === 'focusFileSearch') handled = focusNativeFileSearch();
    else if (action === 'clearFileSearch') handled = closeNativeFileSearch();
    else handled = globalThis.GoLensGoNavigation?.runNavigationAction?.(action) === true;
    if (handled) {
      event.preventDefault();
      void globalThis.GoLensShortcutCoach?.markShortcutUsed?.(action);
    }
  }, true);
  document.addEventListener('click', onShortcutCoachManualClick, true);

  async function toggleReviewFocus() {
    const entering = !inReviewFocus();
    document.documentElement.classList.toggle('gitlab-lens-review-focus', entering);
    if (entering && !document.fullscreenElement) {
      enableRapidDiffs();
      // Fullscreen is best-effort: browsers may reject it when a policy forbids it.
      await document.documentElement.requestFullscreen?.().then(() => {
        state.ownsFullscreen = Boolean(document.fullscreenElement);
      }).catch(() => undefined);
    } else if (!entering && document.fullscreenElement) {
      await document.exitFullscreen?.().catch(() => undefined);
      state.ownsFullscreen = false;
    }
  }

  async function leaveMergeRequestPage() {
    if (!state.pageActive) return;
    state.pageActive = false;
    state.pageKey = '';
    state.preloadCheckID++;
    state.preloadRunID++;
    state.fullPreloadRunID++;
    closeOnboarding();
    // The settings overlay is no longer closed from here: bootstrap.js
    // unmounts and re-mounts the whole page module graph on every
    // location.href change (this one included), and that unmount closes it.
    // Deviation worth knowing: that re-mount fires on *any* href change,
    // where this call site only fired on actually leaving the merge request.
    closeBookmarkDrawer({ restoreFocus: false });
    restoreGoTestFileRows();
    removeOverviewDiscussionLineLinks();
    await disableGoLens();
    state.controlsHost?.remove();
    state.controlsHost = null;
    state.controlsMounted = false;
    state.preload = { status: 'idle', message: '', progress: null };
    state.fullPreload = { status: 'idle', message: 'Not cached', progress: null };
    state.bookmarkSnapshot = { scope: null, current: [], stale: [] };
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
      createControls();
      await setEnabled(state.settings.enabled);
      await refreshPreloadStatus();
      await showFirstRunOnboarding();
      return;
    }

    createControls();
    reconcileGoTestFileRows();
    reconcileOverviewDiscussionLineLinks();
  }

  // Populated at the top of init() below, once loadClockModule() resolves —
  // `import()` can't resolve synchronously here at module top level (see
  // debounceIdle comment above). __test exports a thunk (further down) so
  // the current value is always used, even though it's read before init()
  // finishes.
  let schedulePageReconcile = null;

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
        hideGeneratedFiles: settingsStore.get('hideGeneratedFiles'),
        shortcutCoachEnabled: settingsStore.get('shortcutCoachEnabled'),
        shortcutBindings: globalThis.GoLensShortcuts?.mergeBindings(settingsStore.get('shortcutBindings')) || settingsStore.get('shortcutBindings'),
      };
    } catch {
      settingsStore = null;
      state.settings = defaults;
    }
    try {
      const { createOverlayRegistry } = await loadOverlayRegistryModule();
      overlayRegistry = createOverlayRegistry();
    } catch {
      // Both the chrome.runtime.getURL and relative import fallbacks
      // failed (should not happen in production). Leave overlayRegistry
      // null; claim() call sites below already guard on this, so onboarding
      // and the settings overlay keep opening/closing normally, just
      // without publishing to the registry — go-navigation.js's
      // shortcutCoachBlocked() then degrades to "not blocked" from this
      // check (see its own loadOverlayRegistryModule failure handling).
      overlayRegistry = null;
    }
    state.enabled = state.settings.enabled;
    window.addEventListener('focus', refreshPreloadStatus);
    window.addEventListener('popstate', schedulePageReconcile);
    document.addEventListener('turbo:load', schedulePageReconcile);
    document.addEventListener('pjax:end', schedulePageReconcile);
    document.addEventListener('fullscreenchange', () => {
      if (!state.ownsFullscreen || document.fullscreenElement || !inReviewFocus()) return;
      state.ownsFullscreen = false;
      document.documentElement.classList.remove('gitlab-lens-review-focus');
      renderControlState();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      refreshPreloadStatus();
      schedulePageReconcile();
    });
    new MutationObserver(schedulePageReconcile).observe(document.body, { childList: true, subtree: true });
    // Still tracked in state.settings for the onboarding radio's pre-fill
    // (showFirstRunOnboarding reads state.settings.hideGeneratedFiles);
    // the reconcile side effect this used to trigger moved to
    // page/features/generated-files.js's own settings.subscribe (ticket 13).
    settingsStore?.subscribe('hideGeneratedFiles', (value) => {
      state.settings = { ...state.settings, hideGeneratedFiles: value };
    });
    settingsStore?.subscribe('shortcutBindings', (value) => {
      state.settings = { ...state.settings, shortcutBindings: globalThis.GoLensShortcuts?.mergeBindings(value) || value };
    });
    settingsStore?.subscribe('enabled', (value) => {
      if (value !== state.enabled) setEnabled(value).catch(() => undefined);
    });
    await reconcilePage();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'golens-enabled') setEnabled(message.enabled);
    if (message?.type === 'golens-cache-invalidated') {
      globalThis.GoLensGoNavigation?.invalidateCacheState?.();
      state.preloadCheckID++;
      state.preloadRunID++;
      state.fullPreloadRunID++;
      setPreloadState('idle');
      state.fullPreload = { status: 'idle', message: 'Not cached', progress: null };
      sendResponse({ ok: true, result: { invalidated: true } });
    }
    if (message?.type === 'golens-preload-full-project') {
      sendResponse({ ok: true, result: startFullProjectPreload() });
    }
    if (message?.type === 'golens-full-project-status') {
      refreshFullProjectPreloadStatus()
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === 'golens-show-onboarding') {
      if (!isGitLab() || !isMergeRequest()) {
        sendResponse({ ok: false, error: 'Open a GitLab merge request first.' });
        return;
      }
      // Settings closes itself in response to this same message — it listens
      // for it in page/features/settings-overlay.js and applies the identical
      // isGitLab()/isMergeRequest() guard, since a direct feature call from
      // here is a feature->feature dependency (ticket 03 §3).
      showOnboarding();
      sendResponse({ ok: true, result: { shown: true } });
    }
    // golens-show-settings: the overlay itself is opened by
    // page/features/settings-overlay.js and answered by bootstrap.js. The one
    // part that stays here is onboarding's side of the mutual exclusion:
    // onboarding is still this file's, so this file closes it. Deliberately
    // no sendResponse — two responders on one message means one of them loses.
    if (message?.type === 'golens-show-settings' && isGitLab()) {
      closeOnboarding();
    }
  });

  globalThis.GoLensContent = { __test: { setClock, schedulePageReconcile: (...args) => schedulePageReconcile(...args), reconcileCount: () => state.reconcileCount } };

  init();
})();
