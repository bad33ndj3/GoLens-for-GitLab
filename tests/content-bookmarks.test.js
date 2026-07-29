import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Window } from 'happy-dom';

const wait = () => new Promise((resolve) => setTimeout(resolve, 0));

test('moves bookmark markers away from GitLab comment buttons', async () => {
  const css = await readFile(new URL('../gitlab-lens.css', import.meta.url), 'utf8');
  assert.match(css, /:has\(button:not\(\.golens-bookmark-marker\)\) > \.golens-bookmark-marker\s*\{\s*left: 18px;/);
});

test('fourth page control renders current and stale MR bookmarks in an accessible drawer', async () => {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.write(`<!doctype html><html><head><meta name="csrf-token" content="fixture"></head><body>
    <div class="layout-page is-merge-request"><div class="ai-panels"><div><nav><div><button>AI</button></div></nav></div></div></div>
  </body></html>`);
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.Node = window.Node;
  globalThis.innerWidth = 1200;
  globalThis.innerHeight = 800;

  let bookmarkListener;
  const calls = [];
  globalThis.GoLensGoNavigation = {
    init() {}, teardown() {}, invalidateCacheState() {},
    subscribeBookmarks(listener) { bookmarkListener = listener; listener({ scope: null, current: [], stale: [] }); return () => {}; },
    async mergeRequestPreloadStatus() { return { status: 'missing' }; },
    async revealBookmark(record) { calls.push(['jump', record.id]); return true; },
    async removeBookmark(record) { calls.push(['remove', record.id]); },
    async recoverBookmark(record) { calls.push(['recover', record.id]); return { status: 'recovered' }; },
    async clearBookmarks(mode) { calls.push(['clear', mode]); return 1; },
  };
  globalThis.chrome = {
    storage: {
      sync: { async get(defaults) { return defaults; }, async set() {} },
      local: { async get(defaults) { return { ...(defaults || {}), golensOnboardingVersion: 11 }; }, async set() {} },
      onChanged: { addListener() {} },
    },
    runtime: { getURL(path) { return `chrome-extension://golens/${path}`; }, onMessage: { addListener() {} } },
  };
  await import('../shortcut-settings.js?content-bookmarks-test');
  await import('../content.js?content-bookmarks-test');
  await wait();

  const current = {
    id: 'current', label: 'return value', stale: false,
    location: { path: 'pkg/review.go', side: 'new', startLine: 12, endLine: 13 },
  };
  const stale = {
    id: 'stale', label: 'previous handler', stale: true,
    location: { path: 'pkg/old.go', side: 'old', startLine: 7, endLine: 7 },
  };
  bookmarkListener({ scope: { headSha: 'a'.repeat(40) }, current: [current], stale: [stale] });
  const controls = window.document.getElementById('gitlab-lens-root').shadowRoot;
  const trigger = controls.querySelector('[data-action="bookmarks"]');
  assert.equal(controls.querySelectorAll('.controls > button').length, 4);
  assert.equal(trigger.querySelector('.bookmark-count').textContent, '1');
  assert.equal(trigger.querySelector('.bookmark-stale').hidden, false);

  trigger.click();
  const drawerHost = window.document.getElementById('golens-bookmark-drawer-root');
  const drawer = drawerHost.shadowRoot;
  assert.equal(drawer.querySelector('[role="dialog"]').getAttribute('aria-label'), 'MR bookmarks');
  assert.match(drawer.textContent, /pkg\/review.go/);
  assert.match(drawer.textContent, /L12–13 · new side/);
  assert.match(drawer.textContent, /stale after head change/i);

  drawer.querySelector('[data-bookmark-action="jump"]').click();
  await wait();
  drawer.querySelector('[data-bookmark-action="recover"]').click();
  await wait();
  drawer.querySelector('[data-bookmark-action="remove"]').click();
  await wait();
  drawer.querySelector('[data-clear="stale"]').click();
  await wait();
  assert.deepEqual(calls, [['jump', 'current'], ['recover', 'stale'], ['remove', 'current'], ['clear', 'stale']]);

  drawer.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(window.document.getElementById('golens-bookmark-drawer-root'), null);
  assert.equal(trigger.getAttribute('aria-expanded'), 'false');
});
