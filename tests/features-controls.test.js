import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { mount } from '../page/features/controls.js';
import { diffViewFromLocation, diffViewToggleView } from '../page/features/controls.internal.js';

test('diffViewFromLocation: prefers the view= URL param over the diff_view cookie, falls back to GitLab\'s inline default', () => {
  assert.equal(diffViewFromLocation({ search: '', cookie: '' }), 'inline');
  assert.equal(diffViewFromLocation({ search: '?view=parallel', cookie: '' }), 'parallel');
  assert.equal(diffViewFromLocation({ search: '', cookie: 'diff_view=parallel' }), 'parallel');
  assert.equal(diffViewFromLocation({ search: '', cookie: 'a=b; diff_view=parallel; c=d' }), 'parallel');
  assert.equal(diffViewFromLocation({ search: '?view=inline', cookie: 'diff_view=parallel' }), 'inline', 'the URL param wins once GitLab has applied it');
  assert.equal(diffViewFromLocation({ search: '?view=bogus', cookie: 'diff_view=parallel' }), 'parallel', 'an unrecognized param value falls through to the cookie');
});

test('diffViewToggleView: disabled only on GoLens off or off a diffs path, never on an unresolved GitLab-control lookup', () => {
  assert.deepEqual(diffViewToggleView({ view: 'inline', enabled: true, isDiffPath: true }), {
    ariaPressed: 'false', disabled: false, label: 'Switch to side-by-side diff view',
  });
  assert.deepEqual(diffViewToggleView({ view: 'parallel', enabled: true, isDiffPath: true }), {
    ariaPressed: 'true', disabled: false, label: 'Switch to inline diff view',
  });
  assert.equal(diffViewToggleView({ view: 'inline', enabled: false, isDiffPath: true }).disabled, true);
  assert.equal(diffViewToggleView({ view: 'inline', enabled: true, isDiffPath: false }).disabled, true);
});

function fakeClock() {
  return { setTimeout: (fn) => { fn(); return () => {}; } };
}

function fakeSettingsStore(initial = { enabled: true }) {
  const values = { ...initial };
  const sets = [];
  return {
    ready: () => Promise.resolve(),
    get: (key) => values[key],
    subscribe: () => () => {},
    set(key, value) { sets.push([key, value]); values[key] = value; return Promise.resolve(); },
    __sets: sets,
  };
}

function buildFixture(url = 'https://gitlab.example/group/project/-/merge_requests/42') {
  const window = new Window({ url });
  window.document.write('<!doctype html><html><body></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.chrome = { runtime: { getURL: (path) => `chrome-extension://fixture/${path}` } };
  return window;
}

function fakeBookmarks(snapshot = { scope: null, current: [], stale: [] }) {
  const listeners = new Set();
  return {
    snapshot: () => snapshot,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    reveal: async () => {},
    remove: async () => {},
    recover: async () => ({ kind: 'recovered' }),
    clear: async () => 0,
    fire: () => listeners.forEach((fn) => fn()),
  };
}

test('mounted without ctx.legacy (the inert second instance registered in page/main.js): every call degrades to a safe no-op, no toolbar renders', async () => {
  buildFixture();
  const handle = mount({ settings: fakeSettingsStore(), clock: fakeClock() });
  handle.createControls();
  assert.equal(document.getElementById('gitlab-lens-root'), null);
  await handle.setEnabled(true, { persist: true });
  await handle.refreshPreloadStatus();
  assert.deepEqual(handle.startFullProjectPreload(), { status: 'unavailable', message: 'Open a supported GitLab merge request.', progress: null });
  await handle.refreshFullProjectPreloadStatus();
  handle.invalidatePreloadState();
  handle.closeBookmarkDrawer();
  handle.unmount();
});

test('createControls() mounts the toolbar shadow host into the ai-panels anchor', () => {
  const window = buildFixture();
  window.document.body.innerHTML = '<div class="ai-panels"><div><nav><div><button>anchor</button></div></nav></div></div>';
  const handle = mount({ settings: fakeSettingsStore(), clock: fakeClock(), legacy: {} });
  handle.createControls();
  const host = window.document.getElementById('gitlab-lens-root');
  assert.ok(host);
  assert.ok(host.shadowRoot.querySelector('[data-action="toggle-enabled"]'));
  handle.unmount();
  assert.equal(window.document.getElementById('gitlab-lens-root'), null);
});

test('setEnabled(true) enables the toggle/focus/preload/bookmark buttons; setEnabled(false) tears down go-navigation and disables them', async () => {
  const window = buildFixture();
  window.document.body.innerHTML = '<div class="ai-panels"><div><nav><div><button>anchor</button></div></nav></div></div>';
  let torndown = 0;
  let initCalls = 0;
  const handle = mount({
    settings: fakeSettingsStore(),
    clock: fakeClock(),
    legacy: { teardown: () => { torndown++; }, init: () => { initCalls++; }, watchForRapidDiffs: () => {} },
  });
  handle.createControls();
  await handle.setEnabled(true);
  const shadow = window.document.getElementById('gitlab-lens-root').shadowRoot;
  assert.equal(shadow.querySelector('[data-action="toggle-enabled"]').getAttribute('aria-pressed'), 'true');
  assert.equal(shadow.querySelector('[data-action="focus"]').disabled, false);
  assert.equal(shadow.querySelector('[data-action="preload"]').disabled, false);
  assert.equal(initCalls, 1);

  await handle.setEnabled(false);
  assert.equal(shadow.querySelector('[data-action="toggle-enabled"]').getAttribute('aria-pressed'), 'false');
  assert.equal(shadow.querySelector('[data-action="focus"]').disabled, true);
  assert.equal(shadow.querySelector('[data-action="preload"]').disabled, true);
  assert.equal(torndown, 1);
  handle.unmount();
});

test('preload button click drives the preload state machine through busy -> complete', async () => {
  const window = buildFixture();
  window.document.body.innerHTML = '<div class="ai-panels"><div><nav><div><button>anchor</button></div></nav></div></div>';
  const handle = mount({
    settings: fakeSettingsStore(),
    clock: fakeClock(),
    legacy: {
      preloadMergeRequest: async (onProgress) => {
        onProgress('Working…', { percentage: 40 });
        return { searchStatus: 'ok', coverage: 'partial' };
      },
    },
  });
  handle.createControls();
  await handle.setEnabled(true);
  const shadow = window.document.getElementById('gitlab-lens-root').shadowRoot;
  const button = shadow.querySelector('[data-action="preload"]');
  button.dispatchEvent(new window.Event('click', { bubbles: true }));
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(button.dataset.state, 'complete');
  assert.equal(button.title, 'Related MR cache ready');
  handle.unmount();
});

test('bookmark drawer renders current/stale bookmarks from legacy.bookmarks() and updates on its subscription callback', async () => {
  const window = buildFixture();
  window.document.body.innerHTML = '<div class="ai-panels"><div><nav><div><button>anchor</button></div></nav></div></div>';
  const record = { id: 'b1', label: 'ctx', location: { path: 'a/b.go', startLine: 3, endLine: 3, side: 'new' } };
  const bookmarks = fakeBookmarks({ scope: 'mr', current: [record], stale: [] });
  const handle = mount({ settings: fakeSettingsStore(), clock: fakeClock(), legacy: { bookmarks: () => bookmarks } });
  handle.createControls();
  await handle.setEnabled(true);
  const shadow = window.document.getElementById('gitlab-lens-root').shadowRoot;
  const trigger = shadow.querySelector('[data-action="bookmarks"]');
  assert.equal(trigger.querySelector('.bookmark-count').textContent, '1');
  trigger.dispatchEvent(new window.Event('click', { bubbles: true }));
  const drawer = window.document.getElementById('golens-bookmark-drawer-root');
  assert.ok(drawer);
  assert.equal(drawer.shadowRoot.querySelectorAll('[data-bookmark-list="current"] .bookmark-item').length, 1);
  handle.closeBookmarkDrawer();
  assert.equal(window.document.getElementById('golens-bookmark-drawer-root'), null);
  handle.unmount();
});

test('diff-view toggle: clicking it opens GitLab\'s own preferences dropdown and selects the opposite view', () => {
  const window = buildFixture('https://gitlab.example/group/project/-/merge_requests/42/diffs');
  window.document.body.innerHTML = '<div class="ai-panels"><div><nav><div><button>anchor</button></div></nav></div></div>';
  const toggleBtn = window.document.createElement('button');
  toggleBtn.className = 'js-show-diff-settings';
  window.document.body.append(toggleBtn);
  const selected = [];
  toggleBtn.addEventListener('click', () => {
    const listbox = window.document.createElement('div');
    listbox.innerHTML = '<span role="option">Inline</span><span role="option">Side-by-side</span>';
    for (const option of listbox.querySelectorAll('[role="option"]')) {
      option.addEventListener('click', () => selected.push(option.textContent.trim()));
    }
    window.document.body.append(listbox);
  });

  const handle = mount({ settings: fakeSettingsStore(), clock: fakeClock(), legacy: {} });
  handle.createControls();
  handle.render();
  const shadow = window.document.getElementById('gitlab-lens-root').shadowRoot;
  const diffViewButton = shadow.querySelector('[data-action="diff-view-toggle"]');
  assert.ok(diffViewButton, 'the fifth control (diff-view toggle) is rendered');
  assert.equal(diffViewButton.getAttribute('aria-pressed'), 'false', 'no view= param or cookie yet, so GitLab\'s default (inline) applies');

  diffViewButton.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.deepEqual(selected, ['Side-by-side'], 'starting from inline, the toggle picks the opposite (side-by-side) option');
  handle.unmount();
});

test('diff-view toggle: aria-pressed reflects GitLab\'s own view= URL param immediately from createControls(), before any explicit render() — the state a remount after a successful toggle relies on', () => {
  const window = buildFixture('https://gitlab.example/group/project/-/merge_requests/42/diffs?view=parallel');
  window.document.body.innerHTML = '<div class="ai-panels"><div><nav><div><button>anchor</button></div></nav></div></div>';
  const handle = mount({ settings: fakeSettingsStore(), clock: fakeClock(), legacy: {} });
  handle.createControls();
  const shadow = window.document.getElementById('gitlab-lens-root').shadowRoot;
  const diffViewButton = shadow.querySelector('[data-action="diff-view-toggle"]');
  assert.equal(diffViewButton.getAttribute('aria-pressed'), 'true');
  assert.equal(diffViewButton.title, 'Switch to inline diff view');
  handle.unmount();
});

test('diff-view toggle: degrades gracefully (toasts, does not throw) when GitLab\'s preferences control is not found', () => {
  const window = buildFixture('https://gitlab.example/group/project/-/merge_requests/42/diffs');
  window.document.body.innerHTML = '<div class="ai-panels"><div><nav><div><button>anchor</button></div></nav></div></div>';
  const toasts = [];
  const handle = mount({ settings: fakeSettingsStore(), clock: fakeClock(), legacy: { toast: (message) => toasts.push(message) } });
  handle.createControls();
  const shadow = window.document.getElementById('gitlab-lens-root').shadowRoot;
  const diffViewButton = shadow.querySelector('[data-action="diff-view-toggle"]');
  assert.doesNotThrow(() => diffViewButton.dispatchEvent(new window.Event('click', { bubbles: true })));
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /preferences control not found/i);
  handle.unmount();
});

test('diff-view toggle: exhausts retries and toasts when GitLab\'s dropdown opens but never renders a matching option', () => {
  const window = buildFixture('https://gitlab.example/group/project/-/merge_requests/42/diffs');
  window.document.body.innerHTML = '<div class="ai-panels"><div><nav><div><button>anchor</button></div></nav></div></div>';
  const toggleBtn = window.document.createElement('button');
  toggleBtn.className = 'js-show-diff-settings';
  let toggleClicks = 0;
  toggleBtn.addEventListener('click', () => { toggleClicks++; });
  window.document.body.append(toggleBtn);
  const toasts = [];
  const handle = mount({ settings: fakeSettingsStore(), clock: fakeClock(), legacy: { toast: (message) => toasts.push(message) } });
  handle.createControls();
  const shadow = window.document.getElementById('gitlab-lens-root').shadowRoot;
  const diffViewButton = shadow.querySelector('[data-action="diff-view-toggle"]');
  assert.doesNotThrow(() => diffViewButton.dispatchEvent(new window.Event('click', { bubbles: true })));
  assert.equal(toggleClicks, 2, 'the toggle is clicked once to open and once to close GitLab\'s dropdown after the failed lookup');
  assert.equal(toasts.length, 1);
  assert.match(toasts[0], /did not open as expected/i);
  handle.unmount();
});

function deferredClock() {
  const pending = [];
  return {
    setTimeout: (fn) => { pending.push(fn); return () => {}; },
    flushOne() { pending.shift()?.(); },
  };
}

test('diff-view toggle: destroy()/unmount() during a pending retry stops the chain instead of clicking a stale option or toasting after the rail is gone', () => {
  const window = buildFixture('https://gitlab.example/group/project/-/merge_requests/42/diffs');
  window.document.body.innerHTML = '<div class="ai-panels"><div><nav><div><button>anchor</button></div></nav></div></div>';
  const toggleBtn = window.document.createElement('button');
  toggleBtn.className = 'js-show-diff-settings';
  window.document.body.append(toggleBtn);
  const toasts = [];
  const clock = deferredClock();
  const handle = mount({ settings: fakeSettingsStore(), clock, legacy: { toast: (message) => toasts.push(message) } });
  handle.createControls();
  const shadow = window.document.getElementById('gitlab-lens-root').shadowRoot;
  const diffViewButton = shadow.querySelector('[data-action="diff-view-toggle"]');
  diffViewButton.dispatchEvent(new window.Event('click', { bubbles: true }));

  handle.destroy();
  // The option only appears now, after destroy() — a stale in-flight retry
  // must not click it or toast once its run has been superseded.
  const listbox = window.document.createElement('div');
  listbox.innerHTML = '<span role="option">Inline</span><span role="option">Side-by-side</span>';
  window.document.body.append(listbox);
  const clicked = [];
  for (const option of listbox.querySelectorAll('[role="option"]')) option.addEventListener('click', () => clicked.push(option.textContent.trim()));

  assert.doesNotThrow(() => clock.flushOne());
  assert.deepEqual(clicked, [], 'destroy() must stop the pending retry chain');
  assert.deepEqual(toasts, []);
  handle.unmount();
});

test('unmount() only ever touches this instance\'s own host, never a same-id host owned by another mount', () => {
  const window = buildFixture();
  window.document.body.innerHTML = '<div class="ai-panels"><div><nav><div><button>anchor</button></div></nav></div></div>';
  const real = mount({ settings: fakeSettingsStore(), clock: fakeClock(), legacy: {} });
  real.createControls();
  assert.ok(window.document.getElementById('gitlab-lens-root'));

  const inert = mount({ settings: fakeSettingsStore(), clock: fakeClock() });
  inert.unmount();
  assert.ok(window.document.getElementById('gitlab-lens-root'), 'the inert instance must not remove the real toolbar');

  real.unmount();
  assert.equal(window.document.getElementById('gitlab-lens-root'), null);
});
