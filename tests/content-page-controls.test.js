import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

// Renamed from tests/content-onboarding.test.js (ticket 15): onboarding's own
// DOM/flow assertions moved to tests/features-onboarding.test.js, which
// mounts page/features/onboarding.js directly. What remains here is
// content.js's own behavior — page controls, preload progress, review focus,
// SPA teardown/remount, storage-driven enable — plus the ticket 15 regression
// pin that content.js no longer builds the onboarding host or answers its
// message (mirroring ticket 16's equivalent pin for golens-show-settings,
// still present below).
test('page controls render, preload/focus work, and content.js no longer owns onboarding', async () => {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.write(`
    <!doctype html>
    <html><head><meta name="csrf-token" content="fixture"></head><body>
      <div class="layout-page is-merge-request">
        <div class="ai-panels"><div><nav><div><button>AI</button></div></nav></div></div>
      </div>
    </body></html>
  `);
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;

  let onboardingVersion = 0;
  let messageListener;
  let storageListener;
  let navigationStarts = 0;
  let navigationStops = 0;
  let completePreload;
  const savedSettings = [];
  let syncedSettings = {};
  globalThis.GoLensGoNavigation = {
    init() { navigationStarts++; },
    teardown() { navigationStops++; },
    async mergeRequestPreloadStatus() { return { status: 'missing' }; },
    preloadMergeRequest(report) {
      report('Caching changed packages · 50% · 1 / 2 packages', {
        phase: 'changed', percentage: 50, unit: 'packages', completed: 1, total: 2,
      });
      return new Promise((resolve) => { completePreload = () => resolve({ searchStatus: 'limited', coverage: 'related' }); });
    },
    invalidateCacheState() {},
  };
  globalThis.chrome = {
    storage: {
      sync: {
        async get(defaults) { return { ...defaults, ...syncedSettings }; },
        async set(values) { savedSettings.push(values); syncedSettings = { ...syncedSettings, ...values }; },
      },
      local: {
        async get(defaults) { return { ...defaults, golensOnboardingVersion: onboardingVersion }; },
        async set(values) { onboardingVersion = values.golensOnboardingVersion; },
      },
      onChanged: { addListener(listener) { storageListener = listener; } },
    },
    runtime: {
      getURL(path) { return `chrome-extension://golens/${path}`; },
      onMessage: { addListener(listener) { messageListener = listener; } },
    },
  };

  await import('../shortcut-settings.js?content-page-controls-test');
  await import('../content.js?content-page-controls-test');
  globalThis.GoLensContent.__test.setClock({
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    requestIdle: (fn) => { fn(); return 0; },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  // Ticket 15: onboarding (first-run and manual) moved to
  // page/features/onboarding.js (covered by tests/features-onboarding.test.js)
  // and bootstrap.js answers golens-show-onboarding. content.js must not
  // build the onboarding host on first run, and must not answer the message.
  assert.equal(window.document.getElementById('golens-onboarding-root'), null, 'content.js must not build onboarding any more');
  assert.equal(navigationStarts, 1);

  const controls = window.document.getElementById('gitlab-lens-root').shadowRoot;
  const brandButton = controls.querySelector('[data-action="toggle-enabled"]');
  const focusButton = controls.querySelector('[data-action="focus"]');
  assert.equal(controls.querySelectorAll('button').length, 4);
  assert.match(brandButton.querySelector('img').src, /assets\/icons\/golens-32\.png$/);
  assert.ok(focusButton.querySelector('svg'), 'focus control uses a semantic line icon');
  assert.equal(focusButton.querySelector('img'), null);

  const preload = window.document.getElementById('gitlab-lens-root').shadowRoot.querySelector('[data-action="preload"]');
  preload.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const progress = preload.querySelector('[role="progressbar"]');
  assert.equal(progress.getAttribute('aria-valuenow'), '50');
  assert.equal(progress.querySelector('.preload-fill').style.width, '50%');
  assert.equal(progress.querySelector('.preload-count').textContent, '1/2');
  assert.equal(progress.querySelector('.preload-fill-count').textContent, '1/2');
  completePreload();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(preload.dataset.state, 'complete');

  let response;
  messageListener({ type: 'golens-show-onboarding' }, {}, (value) => { response = value; });
  assert.equal(response, undefined, 'content.js must not answer golens-show-onboarding any more');
  assert.equal(window.document.getElementById('golens-onboarding-root'), null, 'content.js must not build onboarding any more');

  // Ticket 16: the settings overlay's DOM, iframe and handshake moved to
  // page/features/settings-overlay.js (covered by
  // tests/features-settings-overlay.test.js) and bootstrap.js answers the
  // message. content.js must no longer build the overlay, and must no longer
  // respond — two responders on one message means one of them loses.
  response = null;
  messageListener({ type: 'golens-show-settings' }, {}, (value) => { response = value; });
  assert.equal(response, null, 'content.js must not answer golens-show-settings any more');
  assert.equal(
    window.document.getElementById('golens-settings-root'),
    null,
    'content.js must not build the settings overlay any more',
  );
  response = null;
  messageListener({ type: 'golens-close-settings' }, {}, (value) => { response = value; });
  assert.equal(response, null, 'content.js must not answer golens-close-settings any more');

  let fullscreenElement = null;
  Object.defineProperty(window.document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  window.document.documentElement.requestFullscreen = async () => { fullscreenElement = window.document.documentElement; };
  window.document.exitFullscreen = async () => { fullscreenElement = null; };
  window.document.getElementById('gitlab-lens-root').shadowRoot.querySelector('[data-action="focus"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(window.document.documentElement.classList.contains('gitlab-lens-review-focus'), true);
  assert.equal(brandButton.dataset.reviewFocus, 'true');
  assert.match(brandButton.querySelector('.mascot-focus').src, /assets\/celebrations\/golens-focus\.png$/);
  fullscreenElement = null;
  window.document.dispatchEvent(new window.Event('fullscreenchange'));
  assert.equal(window.document.documentElement.classList.contains('gitlab-lens-review-focus'), false);
  assert.equal(brandButton.dataset.reviewFocus, 'false');

  window.happyDOM.setURL('https://gitlab.example/group/project/-/issues');
  window.document.dispatchEvent(new window.Event('turbo:load'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(window.document.getElementById('gitlab-lens-root'), null);
  assert.equal(navigationStops, 1);

  window.happyDOM.setURL('https://gitlab.example/group/project/-/merge_requests/43/diffs');
  window.document.dispatchEvent(new window.Event('turbo:load'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(window.document.getElementById('gitlab-lens-root'));
  assert.equal(navigationStarts, 2);

  storageListener({ enabled: { oldValue: true, newValue: false } }, 'sync');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const remountedControls = window.document.getElementById('gitlab-lens-root').shadowRoot;
  assert.equal(remountedControls.querySelector('[data-action="toggle-enabled"]').getAttribute('aria-pressed'), 'false');
  assert.equal(navigationStops, 2);
});
