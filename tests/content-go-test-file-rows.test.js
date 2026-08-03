import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

// go-test-file-row marking is unrelated to hideGeneratedFiles/full-file (it
// has no ticket-13 migration destination — ticket 03's feature-slice list
// does not name it as its own feature) and stays in content.js. This test
// used to live combined with full-file/generated-files coverage in
// content-full-file.test.js; ticket 13 moved that coverage to
// tests/features-generated-files.test.js (testing
// page/features/generated-files.js's mount(ctx) directly) and left this
// file's assertions here, unweakened.
test('marks _test.go file-tree rows with data-golens-go-test-file-row, including rows added after initial mount', async () => {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.write(`
    <!doctype html>
    <html><head><meta name="csrf-token" content="fixture"></head><body>
      <div class="layout-page is-merge-request">
        <div class="ai-panels"><div><nav><div><button>AI</button></div></nav></div></div>
      </div>
      <nav id="file-tree">
        <a id="tree-go-test" data-file-row="go-test">contract_test.go</a>
        <a id="tree-go-source" data-file-row="go-source">contract.go</a>
      </nav>
      <main id="diffs"></main>
    </body></html>
  `);

  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;

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
      local: { async get(defaults) { return { ...defaults, golensOnboardingVersion: 11 }; }, async set() {} },
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
  await import('../content.js?content-go-test-file-rows-test');
  globalThis.GoLensContent.__test.setClock({
    setTimeout: (fn) => { fn(); return 0; },
    clearTimeout: () => {},
    requestIdle: (fn) => { fn(); return 0; },
  });
  await settle();

  assert.ok(window.document.getElementById('tree-go-test').hasAttribute('data-golens-go-test-file-row'));
  assert.equal(window.document.getElementById('tree-go-source').hasAttribute('data-golens-go-test-file-row'), false);

  const streamedGoTest = window.document.createElement('a');
  streamedGoTest.dataset.fileRow = 'streamed-go-test';
  streamedGoTest.textContent = 'repository_test.go';
  window.document.getElementById('file-tree').append(streamedGoTest);
  await settle();
  assert.ok(streamedGoTest.hasAttribute('data-golens-go-test-file-row'));

  storageListener({ enabled: { oldValue: true, newValue: false } }, 'sync');
  await settle();
  assert.equal(window.document.querySelector('[data-golens-go-test-file-row]'), null, 'disabling GoLens clears the markers');

  storageListener({ enabled: { oldValue: false, newValue: true } }, 'sync');
  await settle();
  assert.ok(window.document.getElementById('tree-go-test').hasAttribute('data-golens-go-test-file-row'), 're-enabling restores the markers');

  window.happyDOM.setURL('https://gitlab.example/group/project/-/issues');
  window.document.dispatchEvent(new window.Event('turbo:load'));
  await settle();
  assert.equal(window.document.querySelector('[data-golens-go-test-file-row]'), null, 'leaving the MR page clears the markers');
});
