import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { mount } from '../page/features/generated-files.js';

// Synchronous fake clock: debounceIdle runs `fn` immediately on each call
// (real debounce timing is platform/clock.js's own test surface, exercised
// in tests/platform-clock.test.js) so these tests can assert reconcile
// effects without sleeping.
function fakeClock() {
  return {
    debounceIdle(fn) {
      const debounced = (...args) => fn(...args);
      debounced.cancel = () => {};
      return debounced;
    },
  };
}

function fakeSettingsStore(initial = { enabled: true, hideGeneratedFiles: false }) {
  const values = { ...initial };
  const listeners = new Map();
  let resolveReady;
  const readyPromise = new Promise((resolve) => { resolveReady = resolve; });
  return {
    resolveReady: () => resolveReady(),
    ready: () => readyPromise,
    get: (key) => values[key],
    subscribe(key, fn) {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
      return () => listeners.get(key)?.delete(fn);
    },
    fireChange(key, value) {
      values[key] = value;
      for (const fn of listeners.get(key) || []) fn(value);
    },
    set() { throw new Error('generated-files must never write settings'); },
  };
}

const rapidDiff = ({ id, mode = 'full', viewer = 'text_inline', path = `${id}.go` }) => {
  const text = mode === 'changes' ? 'Show changes only' : 'Show full file';
  const full = mode === 'changes' ? ',"data-full":true' : '';
  return `
    <diff-file id="${id}" data-testid="rd-diff-file" data-file-data='{"viewer":"${viewer}","new_path":"${path}"}'>
      <article class="rd-diff-file">
        <header class="rd-diff-file-header" data-testid="rd-diff-file-header">
          <h2>${id}.go</h2>
          <div class="rd-diff-file-info">
            <div class="rd-diff-file-options-menu">
              <div data-options-menu>
                <script type="application/json">[{"text":"${text}","extraAttrs":{"data-click":"showFullFile"${full}}}]</script>
              </div>
            </div>
          </div>
        </header>
        <table><tbody><tr><td>changed line</td></tr></tbody></table>
      </article>
    </diff-file>
  `;
};

const legacyDiff = (id, { options = false, path = `${id}.go` } = {}) => `
  <div id="${id}" class="diff-file file-holder" data-path="${path}">
    <div class="file-title" data-testid="file-title-container">
      <strong>${id}.go</strong>
      <div class="file-actions">
        ${options ? '<div class="legacy-options"><button type="button" data-testid="options-dropdown-button">Options</button></div>' : ''}
      </div>
    </div>
    <div class="diff-content"><button type="button" class="js-unfold-all">Expand all lines</button></div>
  </div>
`;

const generatedWarning = `
  <p>Generated files are collapsed by default. To change this behavior, edit the <code>.gitattributes</code> file.
    <a href="/help/user/project/merge_requests/changes.md#collapse-generated-files">Learn more.</a>
  </p>
`;

const rapidGeneratedDiff = (id, path = `${id}.go`) => `
  <diff-file id="${id}" data-testid="rd-diff-file" data-file-data='{"viewer":"no_preview","new_path":"${path}"}'>
    <article class="rd-diff-file">
      <header class="rd-diff-file-header" data-testid="rd-diff-file-header"><h2>${id}.go</h2></header>
      <div class="rd-no-preview">${generatedWarning}</div>
    </article>
  </diff-file>
`;

const legacyGeneratedDiff = (id, path = `${id}.go`) => `
  <div id="${id}" class="diff-file file-holder" data-path="${path}">
    <div class="file-title" data-testid="file-title-container"><strong>${id}.go</strong></div>
    <div class="collapsed-file-warning" data-testid="diff-file-warning">${generatedWarning}</div>
  </div>
`;

function buildFixture() {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.write(`
    <!doctype html>
    <html><head><meta name="csrf-token" content="fixture"></head><body>
      <nav id="file-tree">
        <button id="folder-generated" data-testid="file-row" class="folder" title="svc/generated" aria-label="generated" aria-expanded="true">generated</button>
        <button id="folder-mixed" data-testid="file-row" class="folder" title="svc/mixed" aria-label="mixed" aria-expanded="true">mixed</button>
        <a id="tree-rapid-generated" data-file-row="rapid-generated">rapid-generated.go</a>
        <a id="tree-legacy-generated" data-file-row="legacy-generated">legacy-generated.go</a>
        <a id="tree-rapid-large" data-file-row="rapid-large">rapid-large.go</a>
        <a id="tree-generic-collapsed" data-file-row="generic-collapsed-file">generic-collapsed.go</a>
      </nav>
      <header id="mr-header"><span data-testid="diff-stats">+15 -7</span></header>
      <main id="diffs">
        ${rapidDiff({ id: 'rapid-file' })}
        ${legacyDiff('legacy-native', { options: true })}
        ${legacyDiff('legacy-fallback')}
        <diff-file id="binary-file" data-testid="rd-diff-file" data-file-data='{"viewer":"image"}'>
          <article><header data-testid="rd-diff-file-header"><div class="rd-diff-file-info"></div></header></article>
        </diff-file>
        ${rapidGeneratedDiff('rapid-generated', 'svc/mixed/rapid-generated.go')}
        ${legacyGeneratedDiff('legacy-generated', 'svc/generated/legacy-generated.go')}
        <diff-file id="rapid-large" data-testid="rd-diff-file" data-file-data='{"viewer":"no_preview","new_path":"svc/mixed/rapid-large.go"}'>
          <article><header data-testid="rd-diff-file-header"><h2>rapid-large.go</h2></header><div class="rd-no-preview"><p>File size exceeds preview limit.</p></div></article>
        </diff-file>
        <div id="legacy-large" class="diff-file file-holder" data-path="svc/mixed/legacy-large.go">
          <div class="file-title" data-testid="file-title-container"><strong>legacy-large.go</strong></div>
          <div class="collapsed-file-warning" data-testid="diff-file-warning"><p>Files with large changes are collapsed by default.</p></div>
        </div>
        <div id="generic-collapsed-file" class="diff-file file-holder" data-path="svc/mixed/generic-collapsed.go">
          <div class="file-title" data-testid="file-title-container"><div class="file-actions"></div></div>
          <p>Collapsed file without a generated marker</p>
        </div>
        <div id="nodiff-gen" class="diff-file file-holder" data-path="svc/nodiff.gen.go">
          <div class="file-title" data-testid="file-title-container"><strong>nodiff.gen.go</strong><span class="file-stats">+10 -4</span></div>
          <div class="diff-content"><p>Plain diff, only matched by root .gitattributes -diff rules.</p></div>
        </div>
      </main>
    </body></html>
  `);

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;

  for (const folder of window.document.querySelectorAll('[data-testid="file-row"].folder')) {
    folder.addEventListener('click', () => {
      folder.setAttribute('aria-expanded', String(folder.getAttribute('aria-expanded') !== 'true'));
    });
  }

  return window;
}

const delay = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('mount(ctx) hides generated files and mounts full-file buttons; unmount() reverses both', async () => {
  const window = buildFixture();
  const settings = fakeSettingsStore({ enabled: true, hideGeneratedFiles: true });
  const handle = mount({ settings, clock: fakeClock() });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  const rapidRoot = window.document.getElementById('rapid-file');
  const rapidButton = rapidRoot.querySelector('[data-golens-full-file]');
  assert.ok(rapidButton, 'Rapid Diff full-file button was not mounted');
  assert.equal(rapidButton.dataset.click, 'showFullFile');
  assert.equal(rapidRoot.querySelectorAll('[data-golens-full-file]').length, 1);
  assert.equal(window.document.getElementById('binary-file').querySelector('[data-golens-full-file]'), null);
  assert.equal(window.document.getElementById('generic-collapsed-file').querySelector('[data-golens-full-file]'), null);

  assert.ok(window.document.getElementById('rapid-generated').hasAttribute('data-golens-generated-hidden'));
  assert.ok(window.document.getElementById('legacy-generated').hasAttribute('data-golens-generated-hidden'));
  assert.ok(window.document.getElementById('tree-rapid-generated').hasAttribute('data-golens-generated-file-row'));
  assert.ok(window.document.getElementById('tree-legacy-generated').hasAttribute('data-golens-generated-file-row'));
  assert.equal(window.document.getElementById('rapid-large').hasAttribute('data-golens-generated-hidden'), false);
  assert.equal(window.document.getElementById('legacy-large').hasAttribute('data-golens-generated-hidden'), false);
  const generatedFolder = window.document.getElementById('folder-generated');
  const mixedFolder = window.document.getElementById('folder-mixed');
  assert.ok(generatedFolder.hasAttribute('data-golens-generated-folder'));
  assert.equal(generatedFolder.getAttribute('aria-expanded'), 'false', 'a newly-generated-only folder auto-collapses');
  assert.equal(mixedFolder.hasAttribute('data-golens-generated-folder'), false);
  assert.equal(mixedFolder.getAttribute('aria-expanded'), 'true');

  handle.unmount();
  assert.equal(window.document.querySelector('[data-golens-full-file]'), null, 'unmount() removes every full-file button');
  assert.equal(window.document.querySelector('[data-golens-generated-hidden]'), null, 'unmount() restores hidden diffs');
  assert.equal(window.document.querySelector('[data-golens-generated-file-row]'), null);
  assert.equal(window.document.querySelector('[data-golens-generated-folder]'), null);
});

test('full-file button: clicking a Rapid Diffs button delegates to the native showFullFile action', async () => {
  const window = buildFixture();
  const settings = fakeSettingsStore({ enabled: true, hideGeneratedFiles: false });
  const handle = mount({ settings, clock: fakeClock() });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  const rapidRoot = window.document.getElementById('rapid-file');
  let delegatedClick;
  rapidRoot.addEventListener('click', (event) => {
    const action = event.target.closest('[data-click="showFullFile"]');
    if (action) delegatedClick = { click: action.dataset.click, full: action.dataset.full };
  });
  rapidRoot.querySelector('[data-golens-full-file]').click();
  assert.deepEqual(delegatedClick, { click: 'showFullFile', full: undefined });

  handle.unmount();
});

test('full-file button: legacy native dropdown action toggles mode and disabled state', async () => {
  const window = buildFixture();
  const settings = fakeSettingsStore({ enabled: true, hideGeneratedFiles: false });
  const handle = mount({ settings, clock: fakeClock() });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  const nativeRoot = window.document.getElementById('legacy-native');
  const nativeOptions = nativeRoot.querySelector('[data-testid="options-dropdown-button"]');
  let showingFullFile = false;
  let nativeActionClicks = 0;
  nativeOptions.addEventListener('click', () => {
    nativeRoot.querySelector('[role="menu"]')?.remove();
    const menu = window.document.createElement('div');
    menu.setAttribute('role', 'menu');
    const action = window.document.createElement('button');
    action.textContent = showingFullFile ? 'Show changes only' : 'Show full file';
    action.addEventListener('click', () => {
      nativeActionClicks++;
      showingFullFile = !showingFullFile;
      menu.remove();
    });
    menu.append(action);
    nativeRoot.querySelector('[data-testid="file-title-container"]').append(menu);
  });
  const nativeButton = nativeRoot.querySelector('[data-golens-full-file]');
  nativeButton.click();
  await delay();
  assert.equal(nativeActionClicks, 1);
  assert.equal(nativeButton.dataset.mode, 'changes');
  assert.equal(nativeButton.disabled, false);
  nativeButton.click();
  await delay();
  assert.equal(nativeActionClicks, 2);
  assert.equal(nativeButton.dataset.mode, 'full');

  handle.unmount();
});

test('full-file button: legacy fallback expansion runs once and reaches the complete/disabled state', async () => {
  const window = buildFixture();
  const settings = fakeSettingsStore({ enabled: true, hideGeneratedFiles: false });
  const handle = mount({ settings, clock: fakeClock() });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  const fallbackRoot = window.document.getElementById('legacy-fallback');
  const fallbackControl = fallbackRoot.querySelector('.js-unfold-all');
  let fallbackClicks = 0;
  fallbackControl.addEventListener('click', () => {
    fallbackClicks++;
    fallbackControl.append(window.document.createElement('span'));
    queueMicrotask(() => {
      fallbackControl.replaceWith(window.document.createTextNode('all unchanged lines'));
    });
  });
  const fallbackButton = fallbackRoot.querySelector('[data-golens-full-file]');
  fallbackButton.click();
  fallbackButton.click();
  await delay();
  assert.equal(fallbackClicks, 1);
  assert.equal(fallbackButton.dataset.mode, 'complete');
  assert.equal(fallbackButton.disabled, true);

  handle.unmount();
});

test('full-file button: an expansion timeout leaves the button re-enabled with an error label', async () => {
  const window = buildFixture();
  const settings = fakeSettingsStore({ enabled: true, hideGeneratedFiles: false });
  const handle = mount({ settings, clock: fakeClock() });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  const failing = window.document.createElement('div');
  failing.innerHTML = legacyDiff('legacy-timeout');
  window.document.getElementById('diffs').append(failing.firstElementChild);
  await delay();
  await delay();
  const failingButton = window.document.getElementById('legacy-timeout').querySelector('[data-golens-full-file]');
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, milliseconds, ...args) => realSetTimeout(callback, Math.min(milliseconds, 20), ...args);
  failingButton.click();
  await new Promise((resolve) => realSetTimeout(resolve, 40));
  globalThis.setTimeout = realSetTimeout;
  assert.equal(failingButton.disabled, false);
  assert.equal(failingButton.getAttribute('aria-label'), 'Could not expand full file');
  assert.match(failingButton.dataset.error, /Timed out/);

  handle.unmount();
});

test('settings.subscribe("hideGeneratedFiles") reacts live, without a remount', async () => {
  const window = buildFixture();
  const settings = fakeSettingsStore({ enabled: true, hideGeneratedFiles: false });
  const handle = mount({ settings, clock: fakeClock() });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(window.document.querySelector('[data-golens-generated-hidden]'), null);
  settings.fireChange('hideGeneratedFiles', true);
  assert.ok(window.document.getElementById('rapid-generated').hasAttribute('data-golens-generated-hidden'));

  settings.fireChange('hideGeneratedFiles', false);
  assert.equal(window.document.querySelector('[data-golens-generated-hidden]'), null);
  assert.equal(window.document.querySelector('[data-golens-generated-file-row]'), null);
  assert.equal(window.document.querySelector('[data-golens-generated-folder]'), null);

  handle.unmount();
});

test('settings.subscribe("enabled") reacts live: disabling removes buttons and unhides files, re-enabling restores them', async () => {
  const window = buildFixture();
  const settings = fakeSettingsStore({ enabled: true, hideGeneratedFiles: true });
  const handle = mount({ settings, clock: fakeClock() });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(window.document.querySelector('[data-golens-full-file]'));
  assert.ok(window.document.querySelector('[data-golens-generated-hidden]'));

  settings.fireChange('enabled', false);
  assert.equal(window.document.querySelector('[data-golens-full-file]'), null);
  assert.equal(window.document.querySelector('[data-golens-generated-hidden]'), null);
  assert.equal(window.document.querySelector('[data-golens-generated-file-row]'), null);
  assert.equal(window.document.querySelector('[data-golens-generated-folder]'), null);

  settings.fireChange('enabled', true);
  assert.ok(window.document.getElementById('rapid-file').querySelector('[data-golens-full-file]'));
  assert.ok(window.document.getElementById('rapid-generated').hasAttribute('data-golens-generated-hidden'));
  assert.ok(window.document.getElementById('folder-generated').hasAttribute('data-golens-generated-folder'));

  handle.unmount();
});

test('a diff-file streamed in later is picked up via the MutationObserver-driven reconcile', async () => {
  const window = buildFixture();
  const settings = fakeSettingsStore({ enabled: true, hideGeneratedFiles: true });
  const handle = mount({ settings, clock: fakeClock() });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  const streamed = window.document.createElement('div');
  streamed.innerHTML = rapidDiff({ id: 'streamed-file' });
  window.document.getElementById('diffs').append(streamed.firstElementChild);
  await delay();
  assert.ok(window.document.getElementById('streamed-file').querySelector('[data-golens-full-file]'));

  const streamedGenerated = window.document.createElement('div');
  streamedGenerated.innerHTML = rapidGeneratedDiff('streamed-generated');
  window.document.getElementById('diffs').append(streamedGenerated.firstElementChild);
  await delay();
  assert.ok(window.document.getElementById('streamed-generated').hasAttribute('data-golens-generated-hidden'));

  handle.unmount();
});

test('unmount() is idempotent, cancels the debounce, and stops reacting to further settings/DOM changes', async () => {
  const window = buildFixture();
  const settings = fakeSettingsStore({ enabled: true, hideGeneratedFiles: true });
  const handle = mount({ settings, clock: fakeClock() });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  handle.unmount();
  assert.doesNotThrow(() => handle.unmount());

  settings.fireChange('hideGeneratedFiles', false);
  settings.fireChange('enabled', false);
  const streamed = window.document.createElement('div');
  streamed.innerHTML = rapidDiff({ id: 'post-unmount-file' });
  window.document.getElementById('diffs').append(streamed.firstElementChild);
  await delay();
  assert.equal(window.document.getElementById('post-unmount-file').querySelector('[data-golens-full-file]'), null, 'no reconcile should run after unmount()');
});

test('mount-after-unmount is safe: a second mount() re-establishes buttons and hiding from scratch', async () => {
  buildFixture();
  const settingsA = fakeSettingsStore({ enabled: true, hideGeneratedFiles: true });
  const handleA = mount({ settings: settingsA, clock: fakeClock() });
  settingsA.resolveReady();
  await Promise.resolve();
  await Promise.resolve();
  handleA.unmount();

  const settingsB = fakeSettingsStore({ enabled: true, hideGeneratedFiles: true });
  const handleB = mount({ settings: settingsB, clock: fakeClock() });
  settingsB.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(document.querySelector('[data-golens-full-file]'));
  assert.ok(document.getElementById('rapid-generated').hasAttribute('data-golens-generated-hidden'));

  handleB.unmount();
});

function stubGitAttributes(text = '*.gen.go -diff\n') {
  return {
    getHeadRef: async () => 'abc123def456abc123def456abc123def456abcd',
    fetchSource: async (path) => {
      assert.equal(path, '.gitattributes');
      return text;
    },
    getSignal: () => undefined,
  };
}

test('-diff: hides root .gitattributes -diff files and shows the recalculated total beside GitLab\'s', async () => {
  const window = buildFixture();
  const settings = fakeSettingsStore({ enabled: true, hideGeneratedFiles: false, hideNoDiffAttributes: true });
  const handle = mount({ settings, clock: fakeClock(), gitAttributes: stubGitAttributes() });
  settings.resolveReady();
  await delay();
  await delay();
  await delay();

  assert.ok(
    window.document.getElementById('nodiff-gen').hasAttribute('data-golens-generated-hidden'),
    'a non-generated file matched by -diff rules is hidden through the same marker'
  );
  assert.equal(
    window.document.getElementById('rapid-generated').hasAttribute('data-golens-generated-hidden'),
    false,
    'without the generated-files setting, GitLab-marked files stay visible'
  );
  const gitlabTotal = window.document.querySelector('#mr-header [data-testid="diff-stats"]');
  assert.equal(gitlabTotal.textContent, '+15 -7', 'GitLab\'s own total is never overwritten');
  const badge = window.document.querySelector('[data-golens-nodiff-stats]');
  assert.ok(badge, 'the recalculated total badge was not created');
  assert.equal(badge.textContent, '· zonder -diff: 5+ 3-');
  assert.equal(badge.previousElementSibling, gitlabTotal, 'the badge sits directly after GitLab\'s total');
  assert.equal(window.document.querySelectorAll('[data-golens-nodiff-stats]').length, 1);

  handle.unmount();
  assert.equal(window.document.querySelector('[data-golens-generated-hidden]'), null, 'unmount() restores hidden diffs');
  assert.equal(window.document.querySelector('[data-golens-nodiff-stats]'), null, 'unmount() removes the badge');
});

test('-diff: a missing or failing .gitattributes fails closed to current behavior', async () => {
  const window = buildFixture();
  const settings = fakeSettingsStore({ enabled: true, hideGeneratedFiles: false, hideNoDiffAttributes: true });
  const missing = {
    getHeadRef: async () => 'abc123def456abc123def456abc123def456abcd',
    fetchSource: async () => { throw new Error('GitLab returned 404 for .gitattributes'); },
    getSignal: () => undefined,
  };
  const handle = mount({ settings, clock: fakeClock(), gitAttributes: missing });
  settings.resolveReady();
  await delay();
  await delay();
  await delay();

  assert.equal(window.document.querySelector('[data-golens-generated-hidden]'), null, 'nothing is hidden without rules');
  assert.equal(window.document.querySelector('[data-golens-nodiff-stats]'), null, 'no badge without hidden lines');

  handle.unmount();
});

test('-diff: toggling the setting restores files and the badge live, without a remount', async () => {
  const window = buildFixture();
  const settings = fakeSettingsStore({ enabled: true, hideGeneratedFiles: false, hideNoDiffAttributes: true });
  const handle = mount({ settings, clock: fakeClock(), gitAttributes: stubGitAttributes() });
  settings.resolveReady();
  await delay();
  await delay();
  await delay();

  assert.ok(window.document.querySelector('[data-golens-nodiff-stats]'));

  settings.fireChange('hideNoDiffAttributes', false);
  assert.equal(window.document.querySelector('[data-golens-generated-hidden]'), null);
  assert.equal(window.document.querySelector('[data-golens-nodiff-stats]'), null);

  settings.fireChange('hideNoDiffAttributes', true);
  assert.ok(window.document.getElementById('nodiff-gen').hasAttribute('data-golens-generated-hidden'));
  assert.equal(window.document.querySelector('[data-golens-nodiff-stats]').textContent, '· zonder -diff: 5+ 3-');

  handle.unmount();
});

test('-diff: split diff-stats-group markup telt de groene + teller mee in hiddenAdded', async () => {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.write(`
    <!doctype html>
    <html><head></head><body>
      <header id="mr-header">
        <div id="page-total">
          <div class="diff-stats-group gl-flex gl-items-center gl-text-success gl-font-bold"><span>+</span> <span data-testid="js-file-addition-line">2850</span></div>
          <div class="diff-stats-group gl-flex gl-items-center gl-text-danger gl-font-bold"><span>-</span> <span data-testid="js-file-deletion-line">10</span></div>
        </div>
      </header>
      <main id="diffs">
        <div id="nodiff-split" class="diff-file file-holder" data-path="svc/split.gen.go">
          <div class="file-title" data-testid="file-title-container">
            <strong>split.gen.go</strong>
            <div class="diff-stats-group gl-flex gl-items-center gl-text-success gl-font-bold"><span>+</span> <span data-testid="js-file-addition-line">2840</span></div>
            <div class="diff-stats-group gl-flex gl-items-center gl-text-danger gl-font-bold"><span>-</span> <span data-testid="js-file-deletion-line">7</span></div>
          </div>
          <div class="diff-content"><p>Plain diff, only matched by root .gitattributes -diff rules.</p></div>
        </div>
      </main>
    </body></html>
  `);

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;

  const settings = fakeSettingsStore({ enabled: true, hideGeneratedFiles: false, hideNoDiffAttributes: true });
  const handle = mount({ settings, clock: fakeClock(), gitAttributes: stubGitAttributes() });
  settings.resolveReady();
  await delay();
  await delay();
  await delay();

  assert.ok(
    window.document.getElementById('nodiff-split').hasAttribute('data-golens-generated-hidden'),
    'a split-markup file matched by -diff rules is hidden'
  );
  assert.equal(
    window.document.querySelector('#page-total [data-testid="js-file-addition-line"]').textContent,
    '2850',
    "GitLab's own page total is never overwritten"
  );
  const badge = window.document.querySelector('[data-golens-nodiff-stats]');
  assert.ok(badge, 'the recalculated total badge was not created for split markup');
  assert.equal(badge.textContent, '· zonder -diff: 10+ 3-', 'hidden +2840/-7 is subtracted from page +2850/-10');
  assert.equal(badge.previousElementSibling.id, 'page-total', 'the badge sits after the page-total container, never a per-file badge');
  assert.equal(window.document.querySelectorAll('[data-golens-nodiff-stats]').length, 1);

  settings.fireChange('enabled', false);
  assert.equal(window.document.querySelector('[data-golens-generated-hidden]'), null, 'disabling restores hidden diffs');
  assert.equal(window.document.querySelector('[data-golens-nodiff-stats]'), null, 'disabling removes the badge');

  settings.fireChange('enabled', true);
  assert.ok(window.document.getElementById('nodiff-split').hasAttribute('data-golens-generated-hidden'));
  assert.equal(window.document.querySelector('[data-golens-nodiff-stats]').textContent, '· zonder -diff: 10+ 3-');

  handle.unmount();
  assert.equal(window.document.querySelector('[data-golens-generated-hidden]'), null, 'unmount() restores hidden diffs');
  assert.equal(window.document.querySelector('[data-golens-nodiff-stats]'), null, 'unmount() removes the badge');
});

test('-diff: disabling the extension removes -diff hiding and the badge, re-enabling restores them', async () => {
  const window = buildFixture();
  const settings = fakeSettingsStore({ enabled: true, hideGeneratedFiles: false, hideNoDiffAttributes: true });
  const handle = mount({ settings, clock: fakeClock(), gitAttributes: stubGitAttributes() });
  settings.resolveReady();
  await delay();
  await delay();
  await delay();

  assert.ok(window.document.querySelector('[data-golens-nodiff-stats]'));

  settings.fireChange('enabled', false);
  assert.equal(window.document.querySelector('[data-golens-generated-hidden]'), null);
  assert.equal(window.document.querySelector('[data-golens-nodiff-stats]'), null);

  settings.fireChange('enabled', true);
  assert.ok(window.document.getElementById('nodiff-gen').hasAttribute('data-golens-generated-hidden'));
  assert.ok(window.document.querySelector('[data-golens-nodiff-stats]'));

  handle.unmount();
});

function buildAriaLabelFixture({ pageTotal, diffFiles }) {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.write(`
    <!doctype html>
    <html><head></head><body>
      <header id="mr-header">${pageTotal}</header>
      <main id="diffs">${diffFiles}</main>
    </body></html>
  `);

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;

  return window;
}

// The exact structure GitLab renders for its real page total: the outer
// wrapper carries no total-specific selector, only gl-flex + the accessible
// name — the inner split groups are identical to per-file stats.
const ariaLabelPageTotal = (added, deleted) => `
  <div aria-label="Added ${added} lines. Removed ${deleted} lines." class="gl-flex"><div class="diff-stats-group gl-flex gl-items-center gl-text-success gl-font-bold"><span>+</span> <span data-testid="js-file-addition-line">${added}</span></div> <div class="diff-stats-group gl-flex gl-items-center gl-text-danger gl-font-bold"><span>−</span> <span data-testid="js-file-deletion-line">${deleted}</span></div></div>
`;

const noDiffFile = (id, path, stat) => `
  <div id="${id}" class="diff-file file-holder" data-path="${path}">
    <div class="file-title" data-testid="file-title-container"><strong>${id}.go</strong><span class="file-stats">${stat}</span></div>
    <div class="diff-content"><p>Plain diff, only matched by root .gitattributes -diff rules.</p></div>
  </div>
`;

async function mountNoDiff(window) {
  const settings = fakeSettingsStore({ enabled: true, hideGeneratedFiles: false, hideNoDiffAttributes: true });
  const handle = mount({ settings, clock: fakeClock(), gitAttributes: stubGitAttributes() });
  settings.resolveReady();
  await delay();
  await delay();
  await delay();
  return { settings, handle };
}

test('-diff: echte page-totaal wrapper (aria-label) krijgt de badge ERNA, niet tussen + en − in', async () => {
  const window = buildAriaLabelFixture({
    pageTotal: ariaLabelPageTotal(2840, 755),
    diffFiles: noDiffFile('nodiff-exact', 'svc/exact.gen.go', '+10 -4'),
  });
  const { handle } = await mountNoDiff(window);

  assert.ok(
    window.document.getElementById('nodiff-exact').hasAttribute('data-golens-generated-hidden'),
    'the -diff file is hidden'
  );
  const wrapper = window.document.querySelector('#mr-header .gl-flex');
  assert.equal(
    wrapper.querySelector('[data-testid="js-file-addition-line"]').textContent,
    '2840',
    "GitLab's eigen page-totaal wordt nooit overschreven"
  );
  const badge = window.document.querySelector('[data-golens-nodiff-stats]');
  assert.ok(badge, 'de badge verschijnt bij het echte page-totaal');
  assert.equal(badge.textContent, '· zonder -diff: 2830+ 751-', 'hidden +10/-4 is afgetrokken van page +2840/-755');
  assert.equal(badge.previousElementSibling, wrapper, 'de badge staat direct NA de wrapper');
  assert.equal(wrapper.nextElementSibling, badge);
  assert.equal(wrapper.contains(badge), false, 'de badge staat niet tussen + en − in');
  assert.equal(window.document.querySelectorAll('[data-golens-nodiff-stats]').length, 1);

  handle.unmount();
  assert.equal(window.document.querySelector('[data-golens-nodiff-stats]'), null, 'unmount() removes the badge');
});

test('-diff: identieke stat-structuur binnen een diff-file is per-file stat, nooit page-totaal', async () => {
  const window = buildAriaLabelFixture({
    pageTotal: '',
    diffFiles: `
      <div id="nodiff-perfile" class="diff-file file-holder" data-path="svc/perfile.gen.go">
        <div class="file-title" data-testid="file-title-container"><strong>perfile.gen.go</strong>${ariaLabelPageTotal(2840, 755)}</div>
        <div class="diff-content"><p>Plain diff, only matched by root .gitattributes -diff rules.</p></div>
      </div>
    `,
  });
  const { handle } = await mountNoDiff(window);

  const diffFile = window.document.getElementById('nodiff-perfile');
  assert.ok(diffFile.hasAttribute('data-golens-generated-hidden'), 'the -diff file is hidden');
  const perFileWrapper = diffFile.querySelector('.gl-flex');
  const badge = window.document.querySelector('[data-golens-nodiff-stats]');
  assert.ok(badge, 'verborgen regels tonen toch een badge, ook zonder page-totaal');
  assert.equal(
    badge.textContent,
    '· zonder -diff: ≈2840+ 755- verborgen',
    'de per-file +2840/-755 is als hidden stat gelezen'
  );
  assert.equal(
    diffFile.querySelector('[data-golens-nodiff-stats]'),
    null,
    'de per-file stat wordt nooit als page-totaal gebruikt'
  );
  assert.equal(perFileWrapper.contains(badge), false);
  assert.equal(badge.parentNode.id, 'diffs', 'de fallback-badge staat bij #diffs');
  assert.equal(window.document.querySelectorAll('[data-golens-nodiff-stats]').length, 1);

  handle.unmount();
  assert.equal(window.document.querySelector('[data-golens-nodiff-stats]'), null, 'unmount() removes the badge');
});

test('-diff: onparseerbaar page-totaal met verborgen regels toont toch de fallback-badge', async () => {
  const window = buildAriaLabelFixture({
    pageTotal: '<span data-testid="diff-stats">changed files</span>',
    diffFiles: noDiffFile('nodiff-unparsed', 'svc/unparsed.gen.go', '+10 -4'),
  });
  const { handle } = await mountNoDiff(window);

  assert.ok(window.document.getElementById('nodiff-unparsed').hasAttribute('data-golens-generated-hidden'));
  const legacyTotal = window.document.querySelector('#mr-header [data-testid="diff-stats"]');
  assert.equal(legacyTotal.textContent, 'changed files', "GitLab's eigen totaal wordt nooit overschreven");
  const badge = window.document.querySelector('[data-golens-nodiff-stats]');
  assert.ok(badge, 'ook bij een onparseerbaar totaal verschijnt een badge');
  assert.equal(badge.textContent, '· zonder -diff: ≈10+ 4- verborgen');
  assert.equal(badge.parentNode.id, 'diffs', 'de fallback-badge staat bij #diffs');
  assert.equal(window.document.querySelectorAll('[data-golens-nodiff-stats]').length, 1);

  handle.unmount();
  assert.equal(window.document.querySelector('[data-golens-nodiff-stats]'), null, 'unmount() removes the badge');
});
