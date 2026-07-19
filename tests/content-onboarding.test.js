import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Window } from 'happy-dom';

test('onboarding opens once, is accessible, and can be replayed from settings', async () => {
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

  await import('../shortcut-settings.js?content-onboarding-test');
  await import('../content.js?content-onboarding-test');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const firstHost = window.document.getElementById('golens-onboarding-root');
  assert.ok(firstHost, 'first-run onboarding was not shown');
  const firstDialog = firstHost.shadowRoot.querySelector('[data-onboarding-dialog]');
  assert.equal(firstDialog.getAttribute('role'), 'dialog');
  assert.equal(firstDialog.getAttribute('aria-modal'), 'true');
  assert.equal(firstDialog.dataset.onboardingMode, 'setup');
  assert.equal(firstDialog.querySelector('h1').textContent, 'Make GoLens feel familiar');
  assert.equal(firstDialog.querySelectorAll('[data-setup-panel]').length, 3);
  assert.deepEqual([...firstDialog.querySelectorAll('input[name="keymap"]')].map((input) => input.value), ['golens', 'vscode', 'intellij', 'vim']);
  assert.ok(firstDialog.querySelector('input[name="keymap"][value="golens"]').checked);
  assert.match(firstDialog.textContent, /Shortcuts only, without modes or command sequences/);
  assert.match(firstDialog.querySelector('.mascot').src, /assets\/icons\/golens-128\.png$/);
  const onboardingStyles = firstHost.shadowRoot.querySelector('style').textContent;
  assert.match(onboardingStyles, /var\(--golens-surface-panel\)/);
  assert.match(onboardingStyles, /\.feature-icon \{[^}]*width:40px;[^}]*height:40px;/);
  assert.match(onboardingStyles, /\.feature-icon svg \{[^}]*width:24px;[^}]*height:24px;[^}]*stroke-width:1\.75;/);
  assert.equal(onboardingVersion, 11);
  assert.equal(navigationStarts, 1);

  const nextButton = firstDialog.querySelector('[data-action="next-onboarding"]');
  const previousButton = firstDialog.querySelector('[data-action="previous-onboarding"]');
  firstDialog.querySelector('input[name="keymap"][value="vscode"]').click();
  nextButton.click();
  assert.equal(firstDialog.querySelector('[data-tour-progress]').textContent, '2 of 3 · Diff display');
  assert.equal(previousButton.hidden, false);
  assert.ok(firstDialog.querySelector('input[name="generated-files"][value="show"]').checked);
  firstDialog.querySelector('input[name="generated-files"][value="hide"]').click();
  previousButton.click();
  assert.equal(firstDialog.querySelector('[data-tour-progress]').textContent, '1 of 3 · Keyboard');
  nextButton.click();
  nextButton.click();
  assert.equal(firstDialog.querySelector('[data-tour-progress]').textContent, '3 of 3 · Ready');
  assert.equal(nextButton.textContent, 'Save and start reviewing');
  assert.deepEqual([...firstDialog.querySelectorAll('.essential strong')].map((heading) => heading.textContent), [
    'Use the review controls',
    'Hover for Go insight',
    'Plain-click selects occurrences',
    'Cmd/Ctrl-click follows code',
  ]);
  assert.match(firstDialog.textContent, /complete feature guide stays available in Settings under Help/);

  const controls = window.document.getElementById('gitlab-lens-root').shadowRoot;
  const brandButton = controls.querySelector('[data-action="toggle-enabled"]');
  const focusButton = controls.querySelector('[data-action="focus"]');
  assert.equal(controls.querySelectorAll('button').length, 4);
  assert.match(brandButton.querySelector('img').src, /assets\/icons\/golens-32\.png$/);
  assert.ok(focusButton.querySelector('svg'), 'focus control uses a semantic line icon');
  assert.equal(focusButton.querySelector('img'), null);
  assert.equal(firstDialog.querySelector('[data-feature-icon="brand"] img').src, brandButton.querySelector('img').src, 'setup reuses the page-control mascot');

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
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(window.document.getElementById('golens-onboarding-root'), null);
  assert.equal(savedSettings.length, 1);
  assert.equal(savedSettings[0].hideGeneratedFiles, true);
  assert.equal(savedSettings[0].shortcutBindings.nextOccurrence, 'F3');
  await new Promise((resolve) => setTimeout(resolve, 0));
  const pitstopHost = window.document.getElementById('golens-celebration-root');
  assert.equal(pitstopHost?.dataset.celebration, 'pitstop');
  assert.match(pitstopHost.shadowRoot.querySelector('img').src, /assets\/celebrations\/golens-pitstop\.png$/);

  let response;
  messageListener({ type: 'golens-show-onboarding' }, {}, (value) => { response = value; });
  assert.equal(response.ok, true);
  const replayHost = window.document.getElementById('golens-onboarding-root');
  assert.ok(replayHost, 'popup replay did not reopen onboarding');
  const replayDialog = replayHost.shadowRoot.querySelector('[data-onboarding-dialog]');
  assert.equal(replayDialog.dataset.onboardingMode, undefined);
  assert.equal(replayDialog.querySelector('h1').textContent, 'Welcome to GoLens for GitLab');
  const tourTabs = [...replayDialog.querySelectorAll('[role="tab"]')];
  const tourPanels = [...replayDialog.querySelectorAll('[role="tabpanel"]')];
  assert.deepEqual(tourTabs.map((tab) => tab.lastElementChild.textContent.trim()), ['Page controls', 'Go intelligence', 'Diff helpers', 'Settings']);
  assert.match(replayDialog.textContent, /Keep local MR bookmarks/);
  assert.match(replayDialog.textContent, /Bookmark lines and ranges/);
  assert.match(replayDialog.textContent, /minimal location metadata and context fingerprints/);
  assert.deepEqual([...replayDialog.querySelectorAll('.feature strong')].map((heading) => heading.textContent), [
    'Turn GoLens on or off', 'Enter fullscreen review focus', 'Cache related MR packages', 'Keep local MR bookmarks', 'Mark review milestones',
    'Hover for Go insight', 'Navigate by click or shortcut', 'Select and revisit occurrences', 'Stay in the diff when possible',
    'Retrace semantic jumps', 'Use the small popover tools', 'Check the search scope', 'Search the complete project explicitly',
    'Separate test doubles', 'Use Rapid Diffs automatically', 'Show a full file', 'Reach file search from the keyboard',
    'Move by hunk or file', 'Bookmark lines and ranges', 'Spot Go test files', 'Optionally hide generated files', 'Jump from overview discussions to code',
    'Open the settings overlay', 'Set global review preferences', 'Choose a familiar keymap', 'Approve self-hosted GitLab origins',
    'Cache the full project', 'Inspect or clear the source cache', 'Keep bookmarks private', 'Replay this complete tour', 'Keep repository source local',
  ]);
  const featureIcons = [...replayDialog.querySelectorAll('[data-feature-icon]')];
  assert.equal(featureIcons.length, 31);
  assert.ok(featureIcons.every((icon) => icon.querySelector('svg, img')), 'every reference feature uses a visual icon');
  assert.match(replayDialog.textContent, /Contextual tips retire after successful use/);
  assert.deepEqual(
    [...replayDialog.querySelectorAll('[data-feature-icon="focus"] path')].map((path) => path.getAttribute('d')),
    [...focusButton.querySelectorAll('path')].map((path) => path.getAttribute('d')),
    'reference reuses the fullscreen control icon',
  );
  assert.deepEqual(
    [...replayDialog.querySelector('[data-feature-icon="download"]').querySelectorAll('path')].map((path) => path.getAttribute('d')),
    [...controls.querySelector('.preload-idle').querySelectorAll('path')].map((path) => path.getAttribute('d')),
    'reference reuses the related-cache control icon',
  );
  replayHost.shadowRoot.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(window.document.getElementById('golens-onboarding-root'), null);

  messageListener({ type: 'golens-show-settings' }, {}, (value) => { response = value; });
  assert.equal(response.ok, true);
  const settingsHost = window.document.getElementById('golens-settings-root');
  assert.ok(settingsHost, 'the compact popup did not open the page-level settings overlay');
  const settingsFrame = settingsHost.shadowRoot.querySelector('iframe');
  const settingsDialog = settingsHost.shadowRoot.querySelector('[role="dialog"]');
  assert.equal(settingsDialog.getAttribute('aria-modal'), 'true');
  assert.equal(settingsFrame.title, 'GoLens settings');
  assert.match(settingsFrame.src, /settings\.html$/);
  assert.match(settingsHost.shadowRoot.querySelector('style').textContent, /width:min\(1080px/);
  messageListener({ type: 'golens-close-settings' }, {}, (value) => { response = value; });
  assert.equal(response.ok, true);
  assert.equal(window.document.getElementById('golens-settings-root'), null);
  assert.equal(onboardingVersion, 11);

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

test('setup preserves custom shortcuts and discards staged choices when dismissed', async () => {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/7/diffs' });
  window.document.write(`
    <!doctype html><html><head><meta name="csrf-token" content="fixture"></head><body>
      <div class="layout-page is-merge-request"><div class="ai-panels"><div><nav><div><button>AI</button></div></nav></div></div></div>
    </body></html>
  `);
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;

  let customBindings;
  const savedSettings = [];
  let onboardingVersion = 0;
  globalThis.GoLensGoNavigation = {
    init() {}, teardown() {}, invalidateCacheState() {}, async mergeRequestPreloadStatus() { return { status: 'missing' }; },
  };
  globalThis.chrome = {
    storage: {
      sync: {
        async get(defaults) { return { ...defaults, hideGeneratedFiles: true, shortcutBindings: customBindings }; },
        async set(values) { savedSettings.push(values); },
      },
      local: {
        async get(defaults) { return { ...defaults, golensOnboardingVersion: onboardingVersion }; },
        async set(values) { onboardingVersion = values.golensOnboardingVersion; },
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      getURL(path) { return `chrome-extension://golens/${path}`; },
      onMessage: { addListener() {} },
    },
  };

  await import('../shortcut-settings.js?content-onboarding-custom-shortcuts-test');
  customBindings = { ...globalThis.GoLensShortcuts.defaultBindings(), focusFileSearch: 'Alt+KeyP' };
  await import('../content.js?content-onboarding-custom-test');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const host = window.document.getElementById('golens-onboarding-root');
  const dialog = host.shadowRoot.querySelector('[data-onboarding-dialog]');
  assert.ok(dialog.querySelector('input[name="keymap"][value="custom"]').checked);
  assert.ok(dialog.querySelector('input[name="generated-files"][value="hide"]').checked);
  dialog.querySelector('input[name="keymap"][value="vscode"]').click();
  dialog.querySelector('[data-action="close-onboarding"]').click();
  assert.equal(window.document.getElementById('golens-onboarding-root'), null);
  assert.deepEqual(savedSettings, []);
  assert.equal(onboardingVersion, 11);
});
