import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Window } from 'happy-dom';

test('onboarding opens once, is accessible, and can be replayed from the popup', async () => {
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
      sync: { async get(defaults) { return defaults; }, async set() {} },
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

  await import('../content.js?content-onboarding-test');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const firstHost = window.document.getElementById('golens-onboarding-root');
  assert.ok(firstHost, 'first-run onboarding was not shown');
  const firstDialog = firstHost.shadowRoot.querySelector('[data-onboarding-dialog]');
  assert.equal(firstDialog.getAttribute('role'), 'dialog');
  assert.equal(firstDialog.getAttribute('aria-modal'), 'true');
  assert.equal(firstDialog.querySelector('h1').textContent, 'Welcome to GoLens for GitLab');
  assert.match(firstDialog.querySelector('.mascot').src, /assets\/golens-icon\.png$/);
  assert.equal(onboardingVersion, 1);
  assert.equal(navigationStarts, 1);

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

  firstHost.shadowRoot.querySelector('[data-action="dismiss-onboarding"]').click();
  assert.equal(window.document.getElementById('golens-onboarding-root'), null);

  let response;
  messageListener({ type: 'golens-show-onboarding' }, {}, (value) => { response = value; });
  assert.equal(response.ok, true);
  const replayHost = window.document.getElementById('golens-onboarding-root');
  assert.ok(replayHost, 'popup replay did not reopen onboarding');
  replayHost.shadowRoot.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(window.document.getElementById('golens-onboarding-root'), null);
  assert.equal(onboardingVersion, 1);

  let fullscreenElement = null;
  Object.defineProperty(window.document, 'fullscreenElement', { configurable: true, get: () => fullscreenElement });
  window.document.documentElement.requestFullscreen = async () => { fullscreenElement = window.document.documentElement; };
  window.document.exitFullscreen = async () => { fullscreenElement = null; };
  window.document.getElementById('gitlab-lens-root').shadowRoot.querySelector('[data-action="focus"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(window.document.documentElement.classList.contains('gitlab-lens-review-focus'), true);
  fullscreenElement = null;
  window.document.dispatchEvent(new window.Event('fullscreenchange'));
  assert.equal(window.document.documentElement.classList.contains('gitlab-lens-review-focus'), false);

  window.happyDOM.setURL('https://gitlab.example/group/project/-/issues');
  messageListener({ type: 'golens-show-onboarding' }, {}, (value) => { response = value; });
  assert.deepEqual(response, { ok: false, error: 'Open a GitLab merge request first.' });

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
  const controls = window.document.getElementById('gitlab-lens-root').shadowRoot;
  assert.equal(controls.querySelector('[data-action="toggle-enabled"]').getAttribute('aria-pressed'), 'false');
  assert.equal(navigationStops, 2);
});
