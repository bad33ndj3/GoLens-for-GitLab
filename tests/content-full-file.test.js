import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

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

test('adds idempotent full-file controls for Rapid and legacy diffs', async () => {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.write(`
    <!doctype html>
    <html><head><meta name="csrf-token" content="fixture"></head><body>
      <button id="rapid-opt-in">Try Rapid Diffs</button>
      <div class="layout-page is-merge-request">
        <div class="ai-panels"><div><nav><div><button>AI</button></div></nav></div></div>
      </div>
      <nav id="file-tree">
        <button id="folder-generated" data-testid="file-row" class="folder" title="svc/generated" aria-label="generated" aria-expanded="true">generated</button>
        <button id="folder-mixed" data-testid="file-row" class="folder" title="svc/mixed" aria-label="mixed" aria-expanded="true">mixed</button>
        <a id="tree-go-test" data-file-row="go-test">contract_test.go</a>
        <a id="tree-go-source" data-file-row="go-source">contract.go</a>
        <a id="tree-rapid-generated" data-file-row="rapid-generated">rapid-generated.go</a>
        <a id="tree-legacy-generated" data-file-row="legacy-generated">legacy-generated.go</a>
        <a id="tree-rapid-large" data-file-row="rapid-large">rapid-large.go</a>
        <a id="tree-generic-collapsed" data-file-row="generic-collapsed-file">generic-collapsed.go</a>
      </nav>
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

  let storageListener;
  globalThis.GoLensGoNavigation = {
    init() {},
    teardown() {},
    async mergeRequestPreloadStatus() { return { status: 'missing' }; },
    invalidateCacheState() {},
  };
  globalThis.chrome = {
    storage: {
      sync: { async get(defaults) { return defaults; }, async set() {} },
      local: { async get(defaults) { return { ...defaults, golensOnboardingVersion: 7 }; }, async set() {} },
      onChanged: { addListener(listener) { storageListener = listener; } },
    },
    runtime: {
      getURL(path) { return `chrome-extension://golens/${path}`; },
      onMessage: { addListener() {} },
    },
  };

  const delay = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const settle = async () => {
    await delay();
    await delay();
  };
  await import('../content.js?content-full-file-test');
  await settle();

  assert.ok(window.document.getElementById('tree-go-test').hasAttribute('data-golens-go-test-file-row'));
  assert.equal(window.document.getElementById('tree-go-source').hasAttribute('data-golens-go-test-file-row'), false);

  const streamedGoTest = window.document.createElement('a');
  streamedGoTest.dataset.fileRow = 'streamed-go-test';
  streamedGoTest.textContent = 'repository_test.go';
  window.document.getElementById('file-tree').append(streamedGoTest);
  await settle();
  assert.ok(streamedGoTest.hasAttribute('data-golens-go-test-file-row'));

  const rapidRoot = window.document.getElementById('rapid-file');
  let rapidButton = rapidRoot.querySelector('[data-golens-full-file]');
  assert.ok(rapidButton, 'Rapid Diff button was not mounted');
  assert.equal(rapidButton.dataset.click, 'showFullFile');
  assert.equal(rapidButton.getAttribute('aria-label'), 'Show full file');
  assert.equal(rapidRoot.querySelectorAll('[data-golens-full-file]').length, 1);

  let delegatedClick;
  rapidRoot.addEventListener('click', (event) => {
    const action = event.target.closest('[data-click="showFullFile"]');
    if (action) delegatedClick = { click: action.dataset.click, full: action.dataset.full };
  });
  rapidButton.click();
  assert.deepEqual(delegatedClick, { click: 'showFullFile', full: undefined });

  rapidRoot.outerHTML = rapidDiff({ id: 'rapid-file', mode: 'changes' });
  await settle();
  rapidButton = window.document.getElementById('rapid-file').querySelector('[data-golens-full-file]');
  assert.equal(rapidButton.dataset.mode, 'changes');
  assert.equal(rapidButton.dataset.full, 'true');
  assert.equal(rapidButton.getAttribute('aria-label'), 'Show changes only');

  window.document.getElementById('diffs').append(window.document.createElement('span'));
  await settle();
  assert.equal(window.document.getElementById('rapid-file').querySelectorAll('[data-golens-full-file]').length, 1);

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

  const streamed = window.document.createElement('div');
  streamed.innerHTML = rapidDiff({ id: 'streamed-file' });
  window.document.getElementById('diffs').append(streamed.firstElementChild);
  await settle();
  assert.ok(window.document.getElementById('streamed-file').querySelector('[data-golens-full-file]'));
  assert.equal(window.document.getElementById('binary-file').querySelector('[data-golens-full-file]'), null);
  assert.equal(window.document.getElementById('generic-collapsed-file').querySelector('[data-golens-full-file]'), null);

  assert.equal(window.document.querySelector('[data-golens-generated-hidden]'), null);
  storageListener({ hideGeneratedFiles: { oldValue: false, newValue: true } }, 'sync');
  await settle();
  assert.ok(window.document.getElementById('rapid-generated').hasAttribute('data-golens-generated-hidden'));
  assert.ok(window.document.getElementById('legacy-generated').hasAttribute('data-golens-generated-hidden'));
  assert.ok(window.document.getElementById('tree-rapid-generated').hasAttribute('data-golens-generated-file-row'));
  assert.ok(window.document.getElementById('tree-legacy-generated').hasAttribute('data-golens-generated-file-row'));
  assert.equal(window.document.getElementById('rapid-large').hasAttribute('data-golens-generated-hidden'), false);
  assert.equal(window.document.getElementById('legacy-large').hasAttribute('data-golens-generated-hidden'), false);
  assert.equal(window.document.getElementById('generic-collapsed-file').hasAttribute('data-golens-generated-hidden'), false);
  assert.equal(window.document.getElementById('tree-rapid-large').hasAttribute('data-golens-generated-file-row'), false);
  assert.equal(window.document.getElementById('tree-generic-collapsed').hasAttribute('data-golens-generated-file-row'), false);
  const generatedFolder = window.document.getElementById('folder-generated');
  const mixedFolder = window.document.getElementById('folder-mixed');
  assert.ok(generatedFolder.hasAttribute('data-golens-generated-folder'));
  assert.equal(generatedFolder.getAttribute('aria-expanded'), 'false');
  assert.equal(mixedFolder.hasAttribute('data-golens-generated-folder'), false);
  assert.equal(mixedFolder.getAttribute('aria-expanded'), 'true');

  generatedFolder.click();
  assert.equal(generatedFolder.getAttribute('aria-expanded'), 'true');

  const recycledFileRow = window.document.createElement('a');
  recycledFileRow.id = 'tree-recycled-generated';
  recycledFileRow.dataset.fileRow = 'rapid-generated';
  recycledFileRow.textContent = 'rapid-generated.go';
  window.document.getElementById('file-tree').append(recycledFileRow);
  await settle();
  assert.ok(recycledFileRow.hasAttribute('data-golens-generated-file-row'));
  assert.equal(generatedFolder.getAttribute('aria-expanded'), 'true');

  const streamedGenerated = window.document.createElement('div');
  streamedGenerated.innerHTML = rapidGeneratedDiff('streamed-generated');
  window.document.getElementById('diffs').append(streamedGenerated.firstElementChild);
  await settle();
  assert.ok(window.document.getElementById('streamed-generated').hasAttribute('data-golens-generated-hidden'));

  storageListener({ hideGeneratedFiles: { oldValue: true, newValue: false } }, 'sync');
  await settle();
  assert.equal(window.document.querySelector('[data-golens-generated-hidden]'), null);
  assert.equal(window.document.querySelector('[data-golens-generated-file-row]'), null);
  assert.equal(window.document.querySelector('[data-golens-generated-folder]'), null);
  assert.ok(window.document.getElementById('tree-go-test').hasAttribute('data-golens-go-test-file-row'));
  storageListener({ hideGeneratedFiles: { oldValue: false, newValue: true } }, 'sync');
  await settle();
  assert.ok(window.document.getElementById('streamed-generated').hasAttribute('data-golens-generated-hidden'));
  assert.ok(generatedFolder.hasAttribute('data-golens-generated-folder'));
  assert.equal(generatedFolder.getAttribute('aria-expanded'), 'false');

  const failing = window.document.createElement('div');
  failing.innerHTML = legacyDiff('legacy-timeout');
  window.document.getElementById('diffs').append(failing.firstElementChild);
  await settle();
  const failingButton = window.document.getElementById('legacy-timeout').querySelector('[data-golens-full-file]');
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, milliseconds, ...args) => realSetTimeout(callback, Math.min(milliseconds, 20), ...args);
  failingButton.click();
  await new Promise((resolve) => realSetTimeout(resolve, 40));
  globalThis.setTimeout = realSetTimeout;
  assert.equal(failingButton.disabled, false);
  assert.equal(failingButton.getAttribute('aria-label'), 'Could not expand full file');
  assert.match(failingButton.dataset.error, /Timed out/);

  storageListener({ enabled: { oldValue: true, newValue: false } }, 'sync');
  await settle();
  assert.equal(window.document.querySelector('[data-golens-full-file]'), null);
  assert.equal(window.document.querySelector('[data-golens-generated-hidden]'), null);
  assert.equal(window.document.querySelector('[data-golens-generated-file-row]'), null);
  assert.equal(window.document.querySelector('[data-golens-generated-folder]'), null);
  assert.equal(window.document.querySelector('[data-golens-go-test-file-row]'), null);

  storageListener({ enabled: { oldValue: false, newValue: true } }, 'sync');
  await settle();
  assert.ok(window.document.getElementById('rapid-file').querySelector('[data-golens-full-file]'));
  assert.ok(window.document.getElementById('rapid-generated').hasAttribute('data-golens-generated-hidden'));
  assert.ok(window.document.getElementById('tree-rapid-generated').hasAttribute('data-golens-generated-file-row'));
  assert.ok(generatedFolder.hasAttribute('data-golens-generated-folder'));
  assert.ok(window.document.getElementById('tree-go-test').hasAttribute('data-golens-go-test-file-row'));

  window.happyDOM.setURL('https://gitlab.example/group/project/-/issues');
  window.document.dispatchEvent(new window.Event('turbo:load'));
  await settle();
  assert.equal(window.document.querySelector('[data-golens-full-file]'), null);
  assert.equal(window.document.querySelector('[data-golens-generated-hidden]'), null);
  assert.equal(window.document.querySelector('[data-golens-generated-file-row]'), null);
  assert.equal(window.document.querySelector('[data-golens-generated-folder]'), null);
  assert.equal(window.document.querySelector('[data-golens-go-test-file-row]'), null);
});
