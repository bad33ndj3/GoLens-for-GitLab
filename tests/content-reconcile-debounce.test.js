import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

// Verifies the whole-document MutationObserver in content.js (which drives
// page reconciliation) is debounced with an idle fallback rather than
// scheduling a reconcile pass per mutation, and that the debounced fn is
// safe to call repeatedly (reconciliation is idempotent, so self-retrigger
// from its own DOM writes cannot run away). Deterministic via the
// injectable clock — no sleeping.
test('debounces page reconciliation across a mutation burst through an idle-deferred single pass', async () => {
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
  globalThis.GoLensGoNavigation = {
    init() {}, teardown() {}, invalidateCacheState() {},
    subscribeBookmarks(listener) { listener({ scope: null, current: [], stale: [] }); return () => {}; },
    async mergeRequestPreloadStatus() { return { status: 'missing' }; },
  };
  globalThis.chrome = {
    storage: {
      sync: { async get(defaults) { return defaults; }, async set() {} },
      local: { async get(defaults) { return { ...(defaults || {}), golensOnboardingVersion: 11 }; }, async set() {} },
      onChanged: { addListener() {} },
    },
    runtime: { getURL(path) { return `chrome-extension://golens/${path}`; }, onMessage: { addListener() {} } },
  };

  await import('../content.js?content-reconcile-debounce-test');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const { schedulePageReconcile, reconcileCount } = globalThis.GoLensContent.__test;
  const countAfterBootstrap = reconcileCount();
  assert.ok(countAfterBootstrap >= 1, 'init() reconciles the page directly, once, on load');

  let timeoutCallback = null;
  let idleCallback = null;
  globalThis.GoLensContent.__test.setClock({
    setTimeout: (fn) => { timeoutCallback = fn; return 1; },
    clearTimeout: () => { timeoutCallback = null; },
    requestIdle: (fn) => { idleCallback = fn; return 1; },
  });

  // Simulates what the MutationObserver callback does on every mutation in
  // a burst: it just calls the debounced scheduler directly.
  for (let index = 0; index < 5; index++) schedulePageReconcile();

  assert.equal(typeof timeoutCallback, 'function', 'expected the debounce timer to be (re)scheduled');
  assert.equal(idleCallback, null, 'no reconcile pass runs before the debounce window elapses');
  assert.equal(reconcileCount(), countAfterBootstrap, 'a burst of scheduling calls does not itself run a reconcile pass');

  timeoutCallback();
  assert.equal(typeof idleCallback, 'function', 'the settled debounce defers the actual reconcile through the idle callback');
  assert.equal(reconcileCount(), countAfterBootstrap, 'the reconcile pass has not run until the idle callback fires');

  idleCallback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reconcileCount(), countAfterBootstrap + 1, 'the burst produced exactly one reconcile pass');

  // Reconciliation's own DOM writes feed back through the same observer;
  // simulate that self-retrigger and confirm it settles rather than
  // compounding — each debounced call still produces exactly one pass.
  timeoutCallback = null;
  idleCallback = null;
  schedulePageReconcile();
  timeoutCallback();
  idleCallback();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(reconcileCount(), countAfterBootstrap + 2, 'a self-retriggered reconcile still runs exactly once, not in a runaway loop');
});
