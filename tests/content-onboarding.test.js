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
  assert.match(firstDialog.textContent, /extra-long beer-kart lap with confetti/);
  assert.match(firstDialog.querySelector('.mascot').src, /assets\/icons\/golens-128\.png$/);
  const tourTabs = [...firstDialog.querySelectorAll('[role="tab"]')];
  const tourPanels = [...firstDialog.querySelectorAll('[role="tabpanel"]')];
  assert.deepEqual(tourTabs.map((tab) => tab.lastElementChild.textContent.trim()), [
    'Page controls',
    'Go intelligence',
    'Diff helpers',
    'Extension menu',
  ]);
  assert.equal(tourTabs[0].getAttribute('aria-selected'), 'true');
  assert.equal(tourPanels[0].hidden, false);
  assert.ok(tourPanels.slice(1).every((panel) => panel.hidden));
  assert.deepEqual([...firstDialog.querySelectorAll('.feature strong')].map((heading) => heading.textContent), [
    'Turn GoLens on or off',
    'Enter fullscreen review focus',
    'Cache related MR packages',
    'Mark review milestones',
    'Hover for Go insight',
    'Modifier-click to navigate',
    'Stay in the diff when possible',
    'Use the small popover tools',
    'Separate test doubles',
    'Use Rapid Diffs automatically',
    'Show a full file',
    'Reach file search from the keyboard',
    'Spot Go test files',
    'Optionally hide generated files',
    'Jump from overview discussions to code',
    'Set global review preferences',
    'Cache the full project',
    'Inspect or clear the source cache',
    'Replay this complete tour',
    'Keep repository source local',
  ]);
  const featureIcons = [...firstDialog.querySelectorAll('[data-feature-icon]')];
  assert.equal(featureIcons.length, 20);
  assert.ok(featureIcons.every((icon) => icon.querySelector('svg, img')), 'every feature uses a visual icon');
  assert.equal(firstDialog.querySelector('.feature-mark'), null, 'legacy text and Unicode markers were removed');
  const onboardingStyles = firstHost.shadowRoot.querySelector('style').textContent;
  assert.match(onboardingStyles, /var\(--golens-surface-panel\)/);
  assert.match(onboardingStyles, /\.feature-icon \{[^}]*width:40px;[^}]*height:40px;/);
  assert.match(onboardingStyles, /\.feature-icon svg \{[^}]*width:24px;[^}]*height:24px;[^}]*stroke-width:1\.75;/);
  assert.equal(onboardingVersion, 4);
  assert.equal(navigationStarts, 1);

  const nextButton = firstDialog.querySelector('[data-action="next-onboarding"]');
  const previousButton = firstDialog.querySelector('[data-action="previous-onboarding"]');
  nextButton.click();
  assert.equal(tourTabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(tourPanels[1].hidden, false);
  assert.equal(firstDialog.querySelector('[data-tour-progress]').textContent, '2 of 4 · Go intelligence');
  assert.equal(previousButton.hidden, false);
  previousButton.click();
  assert.equal(tourTabs[0].getAttribute('aria-selected'), 'true');
  tourTabs[0].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }));
  assert.equal(tourTabs[3].getAttribute('aria-selected'), 'true');
  assert.equal(nextButton.textContent, 'Start reviewing');

  const controls = window.document.getElementById('gitlab-lens-root').shadowRoot;
  const brandButton = controls.querySelector('[data-action="toggle-enabled"]');
  const focusButton = controls.querySelector('[data-action="focus"]');
  assert.match(brandButton.querySelector('img').src, /assets\/icons\/golens-32\.png$/);
  assert.ok(focusButton.querySelector('svg'), 'focus control uses a semantic line icon');
  assert.equal(focusButton.querySelector('img'), null);
  assert.equal(
    firstDialog.querySelector('[data-feature-icon="brand"] img').src,
    brandButton.querySelector('img').src,
    'onboarding reuses the page-control mascot',
  );
  assert.deepEqual(
    [...firstDialog.querySelectorAll('[data-feature-icon="focus"] path')].map((path) => path.getAttribute('d')),
    [...focusButton.querySelectorAll('path')].map((path) => path.getAttribute('d')),
    'onboarding reuses the fullscreen control icon',
  );
  assert.deepEqual(
    [...firstDialog.querySelector('[data-feature-icon="download"]').querySelectorAll('path')].map((path) => path.getAttribute('d')),
    [...controls.querySelector('.preload-idle').querySelectorAll('path')].map((path) => path.getAttribute('d')),
    'onboarding reuses the related-cache control icon',
  );

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
  assert.equal(window.document.getElementById('golens-celebration-root'), null, 'the pitstop waits until onboarding closes');

  nextButton.click();
  assert.equal(window.document.getElementById('golens-onboarding-root'), null);
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pitstopHost = window.document.getElementById('golens-celebration-root');
  assert.equal(pitstopHost?.dataset.celebration, 'pitstop');
  assert.match(pitstopHost.shadowRoot.querySelector('img').src, /assets\/celebrations\/golens-pitstop\.png$/);

  let response;
  messageListener({ type: 'golens-show-onboarding' }, {}, (value) => { response = value; });
  assert.equal(response.ok, true);
  const replayHost = window.document.getElementById('golens-onboarding-root');
  assert.ok(replayHost, 'popup replay did not reopen onboarding');
  replayHost.shadowRoot.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(window.document.getElementById('golens-onboarding-root'), null);
  assert.equal(onboardingVersion, 4);

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
  const remountedControls = window.document.getElementById('gitlab-lens-root').shadowRoot;
  assert.equal(remountedControls.querySelector('[data-action="toggle-enabled"]').getAttribute('aria-pressed'), 'false');
  assert.equal(navigationStops, 2);
});
