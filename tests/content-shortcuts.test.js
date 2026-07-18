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
        <div id="dialog" role="dialog"><button id="dialog-button">Keep focus</button></div>
      </div>
    </body></html>
  `);
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  const navigationActions = [];
  globalThis.GoLensGoNavigation = {
    init() {},
    teardown() {},
    runNavigationAction(action) { navigationActions.push(action); return true; },
    async mergeRequestPreloadStatus() { return { status: 'missing' }; },
    invalidateCacheState() {},
  };
  globalThis.chrome = {
    storage: {
      sync: { async get(defaults) { return defaults; }, async set() {} },
      local: { async get(defaults) { return { ...defaults, golensOnboardingVersion: 8 }; }, async set() {} },
      onChanged: { addListener() {} },
    },
    runtime: {
      getURL(path) { return `chrome-extension://golens/${path}`; },
      onMessage: { addListener() {} },
    },
  };

  await import('../shortcut-settings.js?content-shortcuts-test');
  await import('../content.js?content-shortcuts-test');
  await wait(0);

  const fileSearch = window.document.getElementById('file-search');
  const commentEditor = window.document.getElementById('comment-editor');
  const richEditor = window.document.getElementById('rich-editor');

  commentEditor.focus();
  const shiftF = new window.KeyboardEvent('keydown', { key: 'F', code: 'KeyF', shiftKey: true, bubbles: true, cancelable: true });
  commentEditor.dispatchEvent(shiftF);
  assert.equal(shiftF.defaultPrevented, false);
  assert.equal(fileSearch.value, '*.go');
  assert.equal(window.document.activeElement, commentEditor);

  const commandP = new window.KeyboardEvent('keydown', { key: 'p', code: 'KeyP', metaKey: true, bubbles: true, cancelable: true });
  richEditor.dispatchEvent(commandP);
  assert.equal(commandP.defaultPrevented, false);
  assert.equal(fileSearch.value, '*.go');

  window.document.body.tabIndex = -1;
  window.document.body.focus();
  const pageShiftF = new window.KeyboardEvent('keydown', { key: 'F', code: 'KeyF', shiftKey: true, bubbles: true, cancelable: true });
  window.document.body.dispatchEvent(pageShiftF);
  assert.equal(pageShiftF.defaultPrevented, true);
  assert.equal(fileSearch.value, '');

  fileSearch.value = '*.go';
  const pageCommandP = new window.KeyboardEvent('keydown', { key: 'p', code: 'KeyP', metaKey: true, bubbles: true, cancelable: true });
  window.document.body.dispatchEvent(pageCommandP);
  assert.equal(pageCommandP.defaultPrevented, true);
  assert.equal(window.document.activeElement, fileSearch);

  fileSearch.value = '*.go';
  const searchShiftF = new window.KeyboardEvent('keydown', { key: 'F', code: 'KeyF', shiftKey: true, bubbles: true, cancelable: true });
  fileSearch.dispatchEvent(searchShiftF);
  assert.equal(searchShiftF.defaultPrevented, false);
  assert.equal(fileSearch.value, '*.go');

  const primaryModifier = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '') ? { metaKey: true } : { ctrlKey: true };
  const dialogButton = window.document.getElementById('dialog-button');
  dialogButton.focus();
  dialogButton.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', altKey: true, ...primaryModifier, bubbles: true, cancelable: true }));
  assert.deepEqual(navigationActions, []);

  window.document.body.focus();
  const nextOccurrence = new window.KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', altKey: true, ...primaryModifier, bubbles: true, cancelable: true });
  window.document.body.dispatchEvent(nextOccurrence);
  assert.equal(nextOccurrence.defaultPrevented, true);
  assert.deepEqual(navigationActions, ['nextOccurrence']);

  const semanticJump = new window.KeyboardEvent('keydown', { key: 'F12', code: 'F12', ...primaryModifier, bubbles: true, cancelable: true });
  window.document.body.dispatchEvent(semanticJump);
  assert.equal(semanticJump.defaultPrevented, true);
  assert.deepEqual(navigationActions, ['nextOccurrence', 'semanticJump']);
});
