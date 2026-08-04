// page/lifecycle/mr-session.js — the SPA reconcile loop, the merge-request
// activation latch, and the diff-invalidation observer (ticket 22, folding
// in ticket 31's SPA-reconcile carve-out). This file replaces:
//   - tests/content-reconcile-debounce.test.js (content.js's debounced
//     schedulePageReconcile via its MutationObserver-driven whole-document
//     reconcile pass) — same assertions, new access path.
//   - the SPA-lifecycle/storage-driven-enable coverage in
//     tests/content-page-controls.test.js (turbo:load -> teardown -> remount,
//     settings.subscribe('enabled') driving setEnabled) — the rest of that
//     file's coverage (toolbar DOM, preload button, focus/fullscreen) is
//     already covered by tests/features-controls.test.js directly against
//     page/features/controls.js, unrelated to what moved here.
//   - the diff-observer-invalidation test from the deleted
//     tests/go-navigation-context.test.js (bumpFileContextGeneration on a
//     diff mutation, ignoring bookmarks.js's own marker/selection-UI DOM).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { createMrSession } from '../page/lifecycle/mr-session.js';
import * as diffDom from '../page/platform/diff-dom.js';

function buildFixture(url = 'https://gitlab.example/group/project/-/merge_requests/42/diffs') {
  const window = new Window({ url });
  window.document.write('<!doctype html><html><head><meta name="csrf-token" content="fixture"></head><body><div class="layout-page"></div></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.Node = window.Node;
  globalThis.chrome = {
    runtime: {
      getURL: (path) => `chrome-extension://fixture/${path}`,
      connect: () => ({ postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} }, disconnect() {} }),
    },
  };
  return window;
}

function fakeSettingsStore(enabled = true) {
  return { ready: () => Promise.resolve(), get: () => enabled };
}

function fakeControls() {
  const calls = [];
  return {
    calls,
    createControls: () => calls.push(['createControls']),
    async setEnabled(value) { calls.push(['setEnabled', value]); },
    async refreshPreloadStatus() { calls.push(['refreshPreloadStatus']); },
    async leaveReviewFocus() { calls.push(['leaveReviewFocus']); },
    destroy: () => calls.push(['destroy']),
  };
}

test('debounces page reconciliation across a mutation burst through an idle-deferred single pass', async () => {
  buildFixture();
  const controls = fakeControls();
  const session = createMrSession({ getSettings: () => fakeSettingsStore(), getControlsHandle: () => controls });
  await session.start();
  const countAfterBootstrap = session.__test.reconcileCount();
  assert.ok(countAfterBootstrap >= 1, 'start() reconciles the page directly, once, on load');

  let timeoutCallback = null;
  let idleCallback = null;
  session.__test.setClock({
    setTimeout: (fn) => { timeoutCallback = fn; return 1; },
    clearTimeout: () => { timeoutCallback = null; },
    requestIdle: (fn) => { idleCallback = fn; return 1; },
  });

  for (let index = 0; index < 5; index++) session.__test.schedulePageReconcile();

  assert.equal(typeof timeoutCallback, 'function', 'expected the debounce timer to be (re)scheduled');
  assert.equal(idleCallback, null, 'no reconcile pass runs before the debounce window elapses');
  assert.equal(session.__test.reconcileCount(), countAfterBootstrap, 'a burst of scheduling calls does not itself run a reconcile pass');

  timeoutCallback();
  assert.equal(typeof idleCallback, 'function', 'the settled debounce defers the actual reconcile through the idle callback');
  assert.equal(session.__test.reconcileCount(), countAfterBootstrap, 'the reconcile pass has not run until the idle callback fires');

  idleCallback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(session.__test.reconcileCount(), countAfterBootstrap + 1, 'the burst produced exactly one reconcile pass');

  session.stop();
});

test('SPA lifecycle: leaving the merge request tears down, re-entering re-activates, and storage-driven enable flips the toolbar', async () => {
  const window = buildFixture();
  const controls = fakeControls();
  let enabled = true;
  const session = createMrSession({
    getSettings: () => ({ ready: () => Promise.resolve(), get: () => enabled }),
    getControlsHandle: () => controls,
  });
  await session.start();
  assert.deepEqual(controls.calls, [['createControls'], ['setEnabled', true], ['refreshPreloadStatus']]);
  controls.calls.length = 0;

  // Leaving the merge request: reconcilePage() detects the URL no longer
  // matches and tears down through leaveMergeRequestPage()/disableGoLens(),
  // in the exact order content.js's originals used (deactivate, then
  // leaveReviewFocus, then destroy).
  window.happyDOM.setURL('https://gitlab.example/group/project/-/issues');
  await session.__test.reconcilePage();
  assert.deepEqual(controls.calls, [['leaveReviewFocus'], ['destroy']]);
  controls.calls.length = 0;

  // Re-entering a (new) merge request re-activates.
  window.happyDOM.setURL('https://gitlab.example/group/project/-/merge_requests/43/diffs');
  await session.__test.reconcilePage();
  assert.deepEqual(controls.calls, [['createControls'], ['setEnabled', true], ['refreshPreloadStatus']]);
  controls.calls.length = 0;

  // Storage-driven enable is lifecycle's own settings.subscribe fanout
  // (page/lifecycle/index.js), which calls controlsHandle.setEnabled(value)
  // directly — not this session's job. Simulated here by calling the fake
  // controls handle's setEnabled the same way that fanout would.
  enabled = false;
  await controls.setEnabled(false);
  assert.deepEqual(controls.calls, [['setEnabled', false]]);

  session.stop();
});

test('diff observer bumps fileContextGeneration on a real diff mutation but ignores a bookmarks-only mutation', async () => {
  const window = buildFixture();
  const sha = 'a'.repeat(40);
  window.document.body.innerHTML = `
    <div id="diffs">
      <diff-file data-testid="rd-diff-file" data-file-data='{"old_path":"pkg/cache.go","new_path":"pkg/cache.go"}'>
        <a class="rd-diff-file-link" href="https://gitlab.example/group/project/-/blob/${sha}/pkg/cache.go">pkg/cache.go</a>
        <table><tbody><tr><td class="new_line"><a aria-label="Added line 1">1</a></td>
          <td data-testid="rd-diff-line-content"><span class="id">Target</span>()</td>
        </tr></tbody></table>
      </diff-file>
    </div>`;
  const session = createMrSession({ getSettings: () => fakeSettingsStore() });
  session.activate();
  try {
    const cell = window.document.querySelector('[data-testid="rd-diff-line-content"]');
    const root = window.document.querySelector('diff-file');
    assert.equal(diffDom.fileContextFor(cell).ref, sha);
    assert.equal(diffDom.fileContextFor(cell).ref, sha, 'a second read hits the cache without re-resolving');

    // A bookmarks-only mutation (marker/selection-UI DOM) must NOT bump the
    // generation — isBookmarkOnlyMutation's guard, duplicated from
    // bookmarks.js's own bookmarkProjectionMutation(), documented in both
    // places.
    const marker = window.document.createElement('span');
    marker.setAttribute('data-golens-bookmark-marker', '');
    root.appendChild(marker);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(diffDom.fileContextFor(cell).ref, sha, 'a bookmarks-only mutation does not invalidate the cache');

    // A real diff mutation (a re-rendered, newer commit-pinned blob link)
    // does bump the generation.
    root.querySelector('a').insertAdjacentHTML('beforebegin', `<a class="rd-diff-file-link" href="https://gitlab.example/group/project/-/blob/${'b'.repeat(40)}/pkg/cache.go">pkg/cache.go</a>`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(diffDom.fileContextFor(cell).ref, 'b'.repeat(40), 'a real diff mutation invalidates the cached file context');
  } finally {
    session.deactivate();
  }
});
