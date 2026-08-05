// page/features/controls.js — toolbar (enable/focus/preload/bookmarks
// buttons) + preload state machine + review-focus/fullscreen + bookmark
// drawer, carved out of content.js.
//
// One module, not two: the drawer's trigger button lives inside the toolbar's
// own shadow root, one bookmarks.subscribe() callback drives both the toolbar
// badge and the open drawer, and closing the drawer reaches back into the
// toolbar to reset aria-expanded. Splitting them would require a new
// cross-module seam for exactly the kind of coupling the module architecture
// forbids (no new globalThis contracts) — so they stay one feature.
//
// This is now the only mounted instance. `page/main.js` builds a full
// `legacy` bag from its own imports and `page/lifecycle/mr-session.js` — the
// bookmark drawer consumes page/features/bookmarks.js's handle exactly as
// before, through `legacy.bookmarks()` (a late-bound accessor onto
// page/main.js's own `bookmarksHandle` variable). `legacy.init`/`legacy.teardown`
// are `page/lifecycle/mr-session.js`'s `activate`/`deactivate` — the
// merge-request activation latch, a concept distinct from the `enabled`
// chrome.storage setting.
//
// rapid-diffs opt-in (enableRapidDiffs/watchForRapidDiffs) moved into this
// module directly: this is now their only caller, so they no longer need a
// `legacy` capability — see their own definitions below.
//
// Every DOM lookup below goes through the module-scoped `host`/`drawerHost`
// references, never `document.getElementById('gitlab-lens-root')` or
// `#golens-bookmark-drawer-root` the way content.js's originals defaulted —
// this instance's unmount()/destroy() must only ever be able to touch DOM it
// itself created, since page/lifecycle mounts and unmounts it on every SPA
// navigation.
import { createClock } from '../platform/clock.js';
import { diffFileIdentity, diffFileRoots, visibleDiffRootForDefinition } from '../platform/diff-dom.js';
import {
  bookmarkButtonView,
  bookmarkDrawerPosition,
  bookmarkRangeLabel,
  diffViewFromLocation,
  diffViewToggleView,
  isMergeRequestDiffPath,
  isMergeRequestPath,
  preloadButtonView,
  preloadCompleteMessage,
  toggleButtonView,
} from './controls.internal.js';

// GitLab's own diff-preferences dropdown (app/assets/javascripts/diffs/
// components/settings_dropdown.vue) — reused unchanged by both the classic
// diffs app and Rapid Diffs (rapid_diffs/app/view_settings.js mounts the same
// component through diff_app_controls.vue), so one selector chain covers
// both. `js-show-diff-settings` is the component's own `:toggle-class`, a
// long-lived Cypress/RSpec test hook rather than a styling class, which
// makes it the more stable of the two signals across GitLab releases.
const DIFF_SETTINGS_TOGGLE_SELECTOR = '.js-show-diff-settings, [aria-label="Preferences"]';
const DIFF_VIEW_RETRY_MS = 20;
const DIFF_VIEW_MAX_RETRIES = 8;

export function mount(ctx) {
  const settings = ctx.settings;
  const clock = ctx.clock || createClock();
  const legacy = ctx.legacy || {};
  const doc = document;
  const win = window;

  let unmounted = false;
  let enabled = true;
  let ownsFullscreen = false;
  let host = null;
  let controlsMounted = false;
  let bookmarkUnsubscribe = null;
  let drawerHost = null;
  let drawerReturnFocus = null;
  let preload = { status: 'idle', message: '', progress: null };
  let preloadCheckID = 0;
  let preloadRunID = 0;
  let fullPreload = { status: 'idle', message: '', progress: null };
  let fullPreloadRunID = 0;
  let diffViewRunID = 0;

  function inReviewFocus() {
    return doc.documentElement.classList.contains('gitlab-lens-review-focus');
  }

  // Rapid-diffs opt-in: byte-identical to content.js's former
  // isMergeRequestDiff()/enableRapidDiffs()/watchForRapidDiffs(). This module
  // is now the only caller, so the two DOM-touching functions live here
  // directly instead of through a `legacy` capability.
  function enableRapidDiffs() {
    if (!isMergeRequestDiffPath(win.location.pathname, win.location.search)) return false;
    const optIn = [...doc.querySelectorAll('button')].find((button) =>
      /^try\s+rapid\s+diffs\b/i.test(button.textContent.trim()) && !button.disabled
    );
    if (!optIn) return false;
    optIn.click();
    return true;
  }

  function watchForRapidDiffs() {
    if (!isMergeRequestDiffPath(win.location.pathname, win.location.search) || enableRapidDiffs()) return;
    const observer = new MutationObserver(() => {
      if (!enableRapidDiffs()) return;
      observer.disconnect();
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }

  function currentBookmarkSnapshot() {
    return legacy.bookmarks?.()?.snapshot() || { scope: null, current: [], stale: [] };
  }

  function aiPanelsContainer() {
    return doc.querySelector('body > div.layout-page.js-page-layout.page-gutter.page-with-super-sidebar.right-sidebar-collapsed.is-merge-request > div.ai-panels')
      || doc.querySelector('.layout-page.is-merge-request > .ai-panels')
      || doc.querySelector('div.ai-panels');
  }

  function aiPanelsAnchor() {
    return doc.querySelector('body > div.layout-page.js-page-layout.page-gutter.page-with-super-sidebar.right-sidebar-collapsed.is-merge-request > div.ai-panels > div > nav > div > button')
      || aiPanelsContainer()?.querySelector(':scope > div > nav > div > button, nav > div > button, nav button');
  }

  function mountControlsInAiPanels(controlsHost) {
    const anchor = aiPanelsAnchor();
    if (anchor) {
      anchor.after(controlsHost);
      controlsMounted = true;
    }
    if (anchor) return;

    // Never fall back to the document body: a misplaced control is worse
    // than waiting for GitLab to render the intended AI-sidebar control.
    const observer = new MutationObserver(() => {
      if (host !== controlsHost) {
        observer.disconnect();
        return;
      }
      const lateAnchor = aiPanelsAnchor();
      if (!lateAnchor) return;
      lateAnchor.after(controlsHost);
      controlsMounted = true;
      observer.disconnect();
    });
    observer.observe(doc.body, { childList: true, subtree: true });
    clock.setTimeout(() => {
      observer.disconnect();
      if (host !== controlsHost || controlsHost.isConnected) return;
      host = null;
      controlsMounted = false;
      legacy.schedulePageReconcile?.();
    }, 30000);
  }

  function createControls() {
    if (host && (host.isConnected || !controlsMounted)) return;
    host?.remove();
    const controlsHost = doc.createElement('aside');
    controlsHost.id = 'gitlab-lens-root';
    host = controlsHost;
    controlsMounted = false;
    const shadow = controlsHost.attachShadow({ mode: 'open' });
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
        .diff-view-toggle { color:var(--golens-info); }
        .diff-view-toggle[aria-pressed="true"] { border-color:var(--golens-info); background:var(--golens-info-soft); color:var(--golens-info-hover); }
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
        <button class="diff-view-toggle" data-action="diff-view-toggle" title="Switch to side-by-side diff view" aria-label="Switch to side-by-side diff view" aria-pressed="false">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4.5" width="7" height="15" rx="1"></rect><rect x="13.5" y="4.5" width="7" height="15" rx="1"></rect></svg>
        </button>
      </div>
      `;
    mountControlsInAiPanels(controlsHost);
    wireControls(shadow);
    ensureBookmarkSubscription();
    renderBookmarkControl(shadow);
    // Read fresh on every createControls() call (including the remount a
    // successful toggle causes via bootstrap.js's location.href poll), not
    // just from later renderControlState() calls — otherwise a freshly
    // (re)mounted rail would show the static aria-pressed="false" baked
    // into the template above regardless of GitLab's actual current view.
    renderDiffViewControl(shadow);
  }

  function ensureBookmarkSubscription() {
    if (bookmarkUnsubscribe || !legacy.bookmarks?.()) return;
    bookmarkUnsubscribe = legacy.bookmarks().subscribe(() => {
      renderBookmarkControl();
      renderBookmarkDrawer();
    });
  }

  function renderBookmarkControl(shadow = host?.shadowRoot) {
    const button = shadow?.querySelector('[data-action="bookmarks"]');
    if (!button) return;
    const snapshot = currentBookmarkSnapshot();
    const view = bookmarkButtonView({ count: snapshot.current.length, stale: snapshot.stale.length, enabled });
    const badge = button.querySelector('.bookmark-count');
    badge.textContent = view.badgeText;
    badge.hidden = view.badgeHidden;
    button.querySelector('.bookmark-stale').hidden = view.staleHidden;
    button.disabled = view.disabled;
    button.title = view.label;
    button.setAttribute('aria-label', view.label);
  }

  function closeBookmarkDrawer({ restoreFocus = true } = {}) {
    if (!drawerHost) return;
    drawerHost.remove();
    drawerHost = null;
    host?.shadowRoot?.querySelector('[data-action="bookmarks"]')?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) drawerReturnFocus?.focus?.();
    drawerReturnFocus = null;
  }

  function createBookmarkListItem(record, stale) {
    const item = doc.createElement('li');
    item.className = 'bookmark-item';
    item.dataset.stale = String(stale);
    const main = doc.createElement('div');
    main.className = 'bookmark-main';
    const path = doc.createElement('strong');
    path.textContent = record.location.path;
    path.title = record.location.path;
    const meta = doc.createElement('span');
    meta.className = 'bookmark-meta';
    meta.textContent = `${bookmarkRangeLabel(record)} · ${record.location.side} side${stale ? ' · stale' : ''}`;
    const context = doc.createElement('span');
    context.className = 'bookmark-context';
    context.textContent = record.label;
    main.append(path, meta, context);
    const actions = doc.createElement('div');
    actions.className = 'bookmark-actions';
    if (stale) {
      const recover = doc.createElement('button');
      recover.type = 'button';
      recover.dataset.bookmarkAction = 'recover';
      recover.dataset.bookmarkId = record.id;
      recover.textContent = 'Recover';
      actions.append(recover);
    } else {
      const jump = doc.createElement('button');
      jump.type = 'button';
      jump.dataset.bookmarkAction = 'jump';
      jump.dataset.bookmarkId = record.id;
      jump.textContent = 'Jump';
      actions.append(jump);
    }
    const remove = doc.createElement('button');
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
      const empty = doc.createElement('li');
      empty.className = 'bookmark-empty';
      empty.textContent = stale ? 'No stale bookmarks.' : 'No bookmarks for this MR head.';
      list.append(empty);
      return;
    }
    records.forEach((record) => list.append(createBookmarkListItem(record, stale)));
  }

  function renderBookmarkDrawer() {
    const shadow = drawerHost?.shadowRoot;
    if (!shadow) return;
    const snapshot = currentBookmarkSnapshot();
    renderBookmarkSection(shadow, '[data-bookmark-list="current"]', snapshot.current, false);
    renderBookmarkSection(shadow, '[data-bookmark-list="stale"]', snapshot.stale, true);
    shadow.querySelector('[data-bookmark-section="stale"]').hidden = snapshot.stale.length === 0;
    shadow.querySelector('[data-clear="current"]').disabled = snapshot.current.length === 0;
    shadow.querySelector('[data-clear="stale"]').disabled = snapshot.stale.length === 0;
    shadow.querySelector('[data-clear="all"]').disabled = snapshot.current.length + snapshot.stale.length === 0;
  }

  function showBookmarkDrawer() {
    if (drawerHost) { closeBookmarkDrawer(); return; }
    const trigger = host?.shadowRoot?.querySelector('[data-action="bookmarks"]');
    if (!trigger) return;
    drawerReturnFocus = trigger;
    trigger.setAttribute('aria-expanded', 'true');
    const bounds = host?.getBoundingClientRect();
    const newDrawerHost = doc.createElement('aside');
    newDrawerHost.id = 'golens-bookmark-drawer-root';
    const position = bookmarkDrawerPosition({ bounds, innerWidth: win.innerWidth, innerHeight: win.innerHeight });
    newDrawerHost.style.setProperty('--golens-bookmark-drawer-left', `${position.left}px`);
    newDrawerHost.style.setProperty('--golens-bookmark-drawer-top', `${position.top}px`);
    const shadow = newDrawerHost.attachShadow({ mode: 'open' });
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
      const bookmarks = legacy.bookmarks?.();
      if (!bookmarks) return;
      if (action) {
        const snapshot = currentBookmarkSnapshot();
        const record = [...snapshot.current, ...snapshot.stale].find((item) => item.id === action.dataset.bookmarkId);
        if (!record) return;
        if (action.dataset.bookmarkAction === 'jump') await bookmarks.reveal(record.id);
        if (action.dataset.bookmarkAction === 'remove') await bookmarks.remove(record.id);
        if (action.dataset.bookmarkAction === 'recover') {
          action.disabled = true;
          status.textContent = 'Checking commit-pinned context…';
          const result = await bookmarks.recover(record.id);
          status.textContent = result.kind === 'recovered' ? 'Bookmark recovered.' : result.message || 'Bookmark could not be recovered safely.';
        }
      }
      if (clear) {
        const mode = clear.dataset.clear === 'current' ? 'current' : clear.dataset.clear;
        const count = await bookmarks.clear(mode);
        status.textContent = count ? `Cleared ${count} bookmark${count === 1 ? '' : 's'}.` : 'No matching bookmarks to clear.';
      }
    });
    drawerHost = newDrawerHost;
    doc.body.append(newDrawerHost);
    renderBookmarkDrawer();
    shadow.querySelector('[data-action="close"]').focus();
  }

  function wireControls(shadow) {
    shadow.querySelector('[data-action="toggle-enabled"]').addEventListener('click', () => handle.setEnabled(!enabled, { persist: true }));
    shadow.querySelector('[data-action="focus"]').addEventListener('click', async () => {
      if (!enabled) return;
      await toggleReviewFocus();
      renderControlState(shadow);
    });
    shadow.querySelector('[data-action="preload"]').addEventListener('click', preloadMergeRequest);
    shadow.querySelector('[data-action="bookmarks"]').addEventListener('click', showBookmarkDrawer);
    shadow.querySelector('[data-action="diff-view-toggle"]').addEventListener('click', () => toggleDiffView());
  }

  // --- diff view toggle (GitHub issue #5) ---------------------------------
  //
  // Drives GitLab's own inline/side-by-side preference through its own
  // preferences dropdown (see DIFF_SETTINGS_TOGGLE_SELECTOR's header
  // comment) rather than forking its diff renderer — DESIGN.md lists owning
  // or rewriting that renderer as an explicit non-goal. GitLab's own
  // setDiffViewType Vuex action then does the rest: it commits the new
  // state (live re-render, no reload), writes the `diff_view` cookie, and
  // pushes a `view=` query param onto the URL via history.pushState —
  // which bootstrap.js's 200ms location.href poll picks up as a navigation
  // and remounts this whole module graph, so the button's aria-pressed
  // recomputes correctly from the new URL on the next createControls() call
  // without this module tracking the outcome itself. A failed lookup (GitLab
  // DOM not in the expected shape) degrades to a toast and leaves GitLab's
  // state untouched — no cookie/URL write of our own, so there is nothing to
  // desync if the click sequence doesn't land.
  function diffSettingsToggleElement() {
    return doc.querySelector(DIFF_SETTINGS_TOGGLE_SELECTOR);
  }

  // Scoped to the toggle's own listbox (GlCollapsibleListbox links the two
  // through aria-controls/aria-owns) when that's resolvable, so a second
  // open listbox elsewhere on the page — the file-browser filter, a
  // reviewer picker, a compare-version dropdown — can never be mistaken for
  // GitLab's diff-preferences menu. Falls back to a document-wide scan for
  // GitLab layouts where that link isn't present.
  function diffViewListboxOption(toggle, targetView) {
    const label = targetView === 'parallel' ? 'side-by-side' : 'inline';
    const listboxID = toggle?.getAttribute('aria-controls') || toggle?.getAttribute('aria-owns');
    const scope = (listboxID && doc.getElementById(listboxID)) || doc;
    return [...scope.querySelectorAll('[role="option"]')]
      .find((option) => option.textContent.trim().toLowerCase() === label);
  }

  function selectDiffViewOption(runID, toggle, targetView, attemptsLeft, anchorIdentity) {
    if (runID !== diffViewRunID) return;
    const option = diffViewListboxOption(toggle, targetView);
    if (option) {
      option.click();
      restoreDiffFileScroll(runID, anchorIdentity, DIFF_VIEW_MAX_RETRIES);
      return;
    }
    if (attemptsLeft <= 0) {
      // Leave GitLab's UI exactly as it was: close the dropdown we opened
      // rather than stranding it open when nothing matched.
      diffSettingsToggleElement()?.click();
      legacy.toast?.('Could not switch diff view — GitLab’s preferences menu did not open as expected.');
      return;
    }
    clock.setTimeout(() => selectDiffViewOption(runID, toggle, targetView, attemptsLeft - 1, anchorIdentity), DIFF_VIEW_RETRY_MS);
  }

  // Inline and parallel render each file at a different height, so switching
  // between them shifts every file below the switch point up or down without
  // GitLab adjusting the (unrelated) scroll position to compensate — the
  // browser keeps the same raw scrollY, which after the shift lines up with
  // different content, in practice usually landing back near the first file.
  // Re-finding the file that was on screen before the switch and re-anchoring
  // to it (repeated across the same retry window as the option click above,
  // since GitLab's re-render isn't necessarily done in one tick) keeps the
  // view stable across GitLab's own re-render.
  function topmostDiffFileRoot() {
    return diffFileRoots().find((root) => root.getBoundingClientRect().bottom > 0) || null;
  }

  function restoreDiffFileScroll(runID, identity, ticksLeft) {
    if (runID !== diffViewRunID || !identity) return;
    visibleDiffRootForDefinition({ path: identity })?.scrollIntoView({ block: 'start' });
    if (ticksLeft <= 0) return;
    clock.setTimeout(() => restoreDiffFileScroll(runID, identity, ticksLeft - 1), DIFF_VIEW_RETRY_MS);
  }

  function toggleDiffView() {
    if (!enabled || !isMergeRequestDiffPath(win.location.pathname, win.location.search)) return false;
    const toggle = diffSettingsToggleElement();
    if (!toggle) {
      legacy.toast?.('Diff view preferences control not found on this GitLab page.');
      return false;
    }
    const currentView = diffViewFromLocation({ search: win.location.search, cookie: doc.cookie });
    const targetView = currentView === 'parallel' ? 'inline' : 'parallel';
    const runID = ++diffViewRunID;
    const anchorIdentity = diffFileIdentity(topmostDiffFileRoot());
    toggle.click();
    selectDiffViewOption(runID, toggle, targetView, DIFF_VIEW_MAX_RETRIES, anchorIdentity);
    return true;
  }

  function setPreloadState(status, { message = '', progress = null } = {}) {
    preload = { status, message, progress };
    renderControlState();
  }

  function renderPreloadState(shadow, isEnabled) {
    const button = shadow.querySelector('[data-action="preload"]');
    const progressBar = button.querySelector('.preload-progress');
    const fill = progressBar.querySelector('.preload-fill');
    const count = button.querySelector('.preload-count');
    const fillCount = button.querySelector('.preload-fill-count');
    const view = preloadButtonView({ status: preload.status, message: preload.message, progress: preload.progress, enabled: isEnabled });
    button.dataset.state = view.dataState;
    button.disabled = view.disabled;
    button.classList.toggle('is-indeterminate', view.indeterminate);
    button.toggleAttribute('aria-busy', view.ariaBusy);
    if (view.ariaValueNow === null) {
      progressBar.removeAttribute('aria-valuenow');
    } else {
      progressBar.setAttribute('aria-valuenow', view.ariaValueNow);
    }
    fill.style.width = view.fillWidth;
    count.textContent = view.countLabel;
    fillCount.textContent = view.countLabel;
    count.hidden = !view.showCount;
    fillCount.hidden = !view.showCount;
    button.dataset.countSize = view.countSize;
    button.title = view.label;
    button.setAttribute('aria-label', view.label);
  }

  function renderControlState(shadow = host?.shadowRoot) {
    if (!shadow) return;
    const toggle = shadow.querySelector('[data-action="toggle-enabled"]');
    const focus = shadow.querySelector('[data-action="focus"]');
    const view = toggleButtonView({ enabled, reviewFocus: inReviewFocus() });
    toggle.setAttribute('aria-pressed', view.toggleAriaPressed);
    toggle.setAttribute('title', view.toggleTitle);
    toggle.setAttribute('aria-label', view.toggleTitle);
    toggle.dataset.reviewFocus = view.toggleReviewFocus;
    focus.disabled = view.focusDisabled;
    focus.setAttribute('aria-pressed', view.focusAriaPressed);
    renderPreloadState(shadow, enabled);
    renderBookmarkControl(shadow);
    renderDiffViewControl(shadow);
  }

  function renderDiffViewControl(shadow) {
    const button = shadow.querySelector('[data-action="diff-view-toggle"]');
    if (!button) return;
    const diffView = diffViewFromLocation({ search: win.location.search, cookie: doc.cookie });
    const isDiffPath = isMergeRequestDiffPath(win.location.pathname, win.location.search);
    const view = diffViewToggleView({ view: diffView, enabled, isDiffPath });
    button.setAttribute('aria-pressed', view.ariaPressed);
    button.disabled = view.disabled;
    button.title = view.label;
    button.setAttribute('aria-label', view.label);
  }

  async function preloadMergeRequest() {
    if (!enabled || preload.status === 'checking' || preload.status === 'busy') return;
    const preloadFn = legacy.preloadMergeRequest;
    if (!preloadFn) return;
    const runID = ++preloadRunID;
    setPreloadState('busy', { message: 'Preparing MR head cache…' });
    try {
      const result = await preloadFn((message, progress) => {
        if (runID === preloadRunID) setPreloadState('busy', { message, progress });
      });
      if (runID !== preloadRunID) return;
      setPreloadState('complete', { message: preloadCompleteMessage(result), progress: { percentage: 100 } });
      legacy.triggerPitstopMoment?.();
    } catch (error) {
      if (runID !== preloadRunID) return;
      setPreloadState('error', { message: error.message || 'Preload failed' });
    }
  }

  async function refreshPreloadStatus() {
    const statusFn = legacy.mergeRequestPreloadStatus;
    if (!statusFn || preload.status === 'busy') return;
    const checkID = ++preloadCheckID;
    const wasComplete = preload.status === 'complete';
    try {
      const result = await statusFn();
      if (checkID !== preloadCheckID || preload.status === 'busy') return;
      if (result.status === 'complete') {
        setPreloadState('complete', { message: preloadCompleteMessage(result), progress: { percentage: 100 } });
      } else {
        legacy.invalidateCacheState?.();
        setPreloadState('idle');
      }
    } catch (error) {
      if (checkID !== preloadCheckID || wasComplete || preload.status === 'busy') return;
      setPreloadState('error', { message: error.message || 'Unable to check cache' });
    }
  }

  function fullPreloadSnapshot() {
    const { status, message, progress } = fullPreload;
    return { status, message, progress };
  }

  function startFullProjectPreload() {
    if (fullPreload.status === 'busy') return fullPreloadSnapshot();
    const preloadFn = legacy.preloadFullProject;
    if (!isMergeRequestPath(win.location.pathname) || !preloadFn) {
      fullPreload = { status: 'unavailable', message: 'Open a supported GitLab merge request.', progress: null };
      return fullPreloadSnapshot();
    }
    const runID = ++fullPreloadRunID;
    fullPreload = { status: 'busy', message: 'Preparing full project cache…', progress: null };
    preloadFn((message, progress) => {
      if (runID === fullPreloadRunID) fullPreload = { status: 'busy', message, progress };
    }).then(() => {
      if (runID !== fullPreloadRunID) return;
      fullPreload = { status: 'complete', message: 'Full project cached', progress: { phase: 'ready', percentage: 100 } };
      refreshPreloadStatus();
      legacy.triggerPitstopMoment?.();
    }).catch((error) => {
      if (runID !== fullPreloadRunID) return;
      fullPreload = { status: 'error', message: error.message || 'Full project cache failed', progress: null };
    });
    return fullPreloadSnapshot();
  }

  async function refreshFullProjectPreloadStatus() {
    if (fullPreload.status === 'busy') return fullPreloadSnapshot();
    const statusFn = legacy.fullProjectPreloadStatus;
    if (!isMergeRequestPath(win.location.pathname) || !statusFn) {
      fullPreload = { status: 'unavailable', message: 'Open a supported GitLab merge request.', progress: null };
      return fullPreloadSnapshot();
    }
    try {
      const result = await statusFn();
      fullPreload = result.status === 'complete'
        ? { status: 'complete', message: 'Full project cached', progress: { phase: 'ready', percentage: 100 } }
        : { status: 'idle', message: 'Not cached', progress: null };
    } catch (error) {
      fullPreload = { status: 'error', message: error.message || 'Unable to check full project cache', progress: null };
    }
    return fullPreloadSnapshot();
  }

  async function toggleReviewFocus() {
    const entering = !inReviewFocus();
    doc.documentElement.classList.toggle('gitlab-lens-review-focus', entering);
    if (entering && !doc.fullscreenElement) {
      enableRapidDiffs();
      // Fullscreen is best-effort: browsers may reject it when a policy forbids it.
      await doc.documentElement.requestFullscreen?.().then(() => {
        ownsFullscreen = Boolean(doc.fullscreenElement);
      }).catch(() => undefined);
    } else if (!entering && doc.fullscreenElement) {
      await doc.exitFullscreen?.().catch(() => undefined);
      ownsFullscreen = false;
    }
  }

  async function leaveReviewFocus() {
    if (inReviewFocus()) await toggleReviewFocus();
  }

  const onFullscreenChange = () => {
    if (!ownsFullscreen || doc.fullscreenElement || !inReviewFocus()) return;
    ownsFullscreen = false;
    doc.documentElement.classList.remove('gitlab-lens-review-focus');
    renderControlState();
  };
  const onFocus = () => { refreshPreloadStatus(); };
  const onVisibilityChange = () => {
    if (doc.visibilityState === 'visible') refreshPreloadStatus();
  };
  doc.addEventListener('fullscreenchange', onFullscreenChange);
  win.addEventListener('focus', onFocus);
  doc.addEventListener('visibilitychange', onVisibilityChange);

  const handle = {
    async setEnabled(nextEnabled, { persist = false } = {}) {
      enabled = nextEnabled;
      if (!nextEnabled) {
        preloadRunID++;
        fullPreloadRunID++;
      }
      renderControlState();
      const persisted = persist && settings ? settings.set('enabled', nextEnabled) : Promise.resolve();
      if (nextEnabled && isMergeRequestPath(win.location.pathname)) {
        watchForRapidDiffs();
        legacy.init?.();
      } else {
        legacy.teardown?.();
        await leaveReviewFocus();
      }
      renderControlState();
      await persisted;
    },
    render: renderControlState,
    leaveReviewFocus,
    createControls,
    refreshPreloadStatus,
    // Reached by page/features/keyboard-nav.js's own `toggleDiffView`
    // shortcut branch through a page/main.js capability, the same
    // feature-can't-reach-feature-directly shape as runLegacyNavigationAction.
    toggleDiffView,
    // Message-routed by bootstrap.js as `golens-cache-invalidated`'s action
    // (ticket 22/35): content.js's old handler for that message called
    // `globalThis.GoLensGoNavigation.invalidateCacheState()` (the real
    // mr-preload cache reset) *then* this method's own UI-state reset, in
    // that order — preserved here since this is now the sole call site.
    // Returns a `kind` (map.md's message-seam rule: every routed action
    // reports a closed-set outcome) though this call never fails.
    invalidatePreloadState() {
      legacy.invalidateCacheState?.();
      preloadCheckID++;
      preloadRunID++;
      fullPreloadRunID++;
      setPreloadState('idle');
      fullPreload = { status: 'idle', message: 'Not cached', progress: null };
      return { kind: 'invalidated' };
    },
    startFullProjectPreload,
    refreshFullProjectPreloadStatus,
    closeBookmarkDrawer,
    destroy() {
      closeBookmarkDrawer({ restoreFocus: false });
      host?.remove();
      host = null;
      controlsMounted = false;
      preload = { status: 'idle', message: '', progress: null };
      fullPreload = { status: 'idle', message: 'Not cached', progress: null };
      diffViewRunID++;
    },
    unmount() {
      if (unmounted) return;
      unmounted = true;
      diffViewRunID++;
      doc.removeEventListener('fullscreenchange', onFullscreenChange);
      win.removeEventListener('focus', onFocus);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      bookmarkUnsubscribe?.();
      bookmarkUnsubscribe = null;
      closeBookmarkDrawer({ restoreFocus: false });
      host?.remove();
      host = null;
      controlsMounted = false;
    },
  };
  return handle;
}
