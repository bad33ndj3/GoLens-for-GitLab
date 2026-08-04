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
    ownsFullscreen: false,
    controlsHost: null,
    controlsMounted: false,
    preload: { status: 'idle', message: '', progress: null },
    preloadCheckID: 0,
    preloadRunID: 0,
    fullPreload: { status: 'idle', message: '', progress: null },
    fullPreloadRunID: 0,
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

  // The global keydown/click shortcut-dispatch loop (key matching, native
  // file-search helpers, the shortcut-coach manual-click trigger) moved to
  // page/features/keyboard-nav.js (ticket 17; covered by
  // tests/features-keyboard-nav.test.js). This file no longer listens for
  // keydown/click at the document level for shortcuts.

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
    // Neither overlay is closed from here any more (ticket 16 for settings,
    // ticket 15 for onboarding): bootstrap.js unmounts and re-mounts the
    // whole page module graph on every location.href change (this one
    // included), and that unmount closes both. Deviation worth knowing: that
    // re-mount fires on *any* href change, where this call site only fired
    // on actually leaving the merge request.
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
        shortcutCoachEnabled: settingsStore.get('shortcutCoachEnabled'),
      };
    } catch {
      settingsStore = null;
      state.settings = defaults;
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
    // golens-show-onboarding and golens-show-settings: both overlays now
    // live in page/features/ (settings-overlay.js, ticket 16; onboarding.js,
    // ticket 15) and are answered by bootstrap.js. content.js no longer
    // builds either overlay's DOM and no longer responds to either message —
    // two responders on one message means one of them loses.
  });

  globalThis.GoLensContent = { __test: { setClock, schedulePageReconcile: (...args) => schedulePageReconcile(...args), reconcileCount: () => state.reconcileCount } };

  init();
})();
