import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('file-search shortcuts do not consume input in GitLab editors', async () => {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.write(`
    <!doctype html>
    <html><head><meta name="csrf-token" content="fixture"></head><body>
      <div class="layout-page is-merge-request">
        <div class="ai-panels"><div><nav><div><button>AI</button></div></nav></div></div>
        <div data-testid="file-browser"><input id="file-search" placeholder="Search (e.g. *.vue)" value="*.go"></div>
        <textarea id="comment-editor"></textarea>
        <div id="rich-editor" contenteditable="true"></div>
      </div>
    </body></html>
  `);
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.GoLensGoNavigation = {
    init() {},
    teardown() {},
    async mergeRequestPreloadStatus() { return { status: 'missing' }; },
    invalidateCacheState() {},
  };
  globalThis.chrome = {
    storage: {
      sync: { async get(defaults) { return defaults; }, async set() {} },
      local: { async get(defaults) { return { ...defaults, golensOnboardingVersion: 5 }; }, async set() {} },
      onChanged: { addListener() {} },
    },
    runtime: {
      getURL(path) { return `chrome-extension://golens/${path}`; },
      onMessage: { addListener() {} },
    },
  };

  await import('../content.js?content-shortcuts-test');
  await wait(0);

  const fileSearch = window.document.getElementById('file-search');
  const commentEditor = window.document.getElementById('comment-editor');
  const richEditor = window.document.getElementById('rich-editor');

  commentEditor.focus();
  const shiftF = new window.KeyboardEvent('keydown', { key: 'F', shiftKey: true, bubbles: true, cancelable: true });
  commentEditor.dispatchEvent(shiftF);
  assert.equal(shiftF.defaultPrevented, false);
  assert.equal(fileSearch.value, '*.go');
  assert.equal(window.document.activeElement, commentEditor);

  const commandP = new window.KeyboardEvent('keydown', { key: 'p', metaKey: true, bubbles: true, cancelable: true });
  richEditor.dispatchEvent(commandP);
  assert.equal(commandP.defaultPrevented, false);
  assert.equal(fileSearch.value, '*.go');

  const pageShiftF = new window.KeyboardEvent('keydown', { key: 'F', shiftKey: true, bubbles: true, cancelable: true });
  window.document.body.dispatchEvent(pageShiftF);
  assert.equal(pageShiftF.defaultPrevented, true);
  assert.equal(fileSearch.value, '');

  fileSearch.value = '*.go';
  const pageCommandP = new window.KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
  window.document.body.dispatchEvent(pageCommandP);
  assert.equal(pageCommandP.defaultPrevented, true);
  assert.equal(window.document.activeElement, fileSearch);
});
