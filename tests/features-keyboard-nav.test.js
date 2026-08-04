import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { mount } from '../page/features/keyboard-nav.js';
import * as shortcutSettings from '../shortcut-settings.js';

function fakeOverlayRegistry() {
  let openCount = 0;
  return {
    isAnyOpen: () => openCount > 0,
    setOpen(count) { openCount = count; },
  };
}

function fakeSettings({ enabled = true, shortcutBindings } = {}) {
  const values = { enabled, shortcutBindings };
  const listeners = new Map();
  return {
    get: (key) => values[key],
    ready: () => Promise.resolve(),
    subscribe(key, fn) {
      if (!listeners.has(key)) listeners.set(key, new Set());
      listeners.get(key).add(fn);
      return () => listeners.get(key)?.delete(fn);
    },
    set(key, value) {
      values[key] = value;
      for (const fn of listeners.get(key) || []) fn(value);
    },
  };
}

function fakeLegacyToast() {
  const messages = [];
  const hints = [];
  let showing = false;
  return {
    message: (text) => { messages.push(text); },
    shortcutHint: (hint) => { hints.push(hint); showing = true; return true; },
    isShowing: () => showing,
    setShowing(value) { showing = value; },
    messages,
    hints,
  };
}

function buildFixture(pathname = '/group/project/-/merge_requests/42/diffs') {
  const window = new Window({ url: `https://gitlab.example${pathname}` });
  window.document.write('<!doctype html><html><body></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 800;
  globalThis.matchMedia = () => ({ matches: false });
  return window;
}

test('offerShortcutCoach: enabled, unblocked, eligible -> renders through legacyToast.shortcutHint with the right message', async () => {
  buildFixture();
  const legacyToast = fakeLegacyToast();
  const shortcutCoach = { consider: async () => ({ actionID: 'semanticJump', displayBinding: 'Ctrl+F12' }) };
  const handle = mount({ overlays: fakeOverlayRegistry(), settings: fakeSettings(), legacyToast, shortcutCoach });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const shown = await handle.offerShortcutCoach('semanticJump');

  assert.equal(shown, true);
  assert.deepEqual(legacyToast.hints, [{ actionID: 'semanticJump', message: 'Open the selected symbol directly from the keyboard.', displayBinding: 'Ctrl+F12' }]);

  handle.unmount();
});

test('offerShortcutCoach: an action with no coach copy never asks shortcutCoach', async () => {
  buildFixture();
  let considered = false;
  const shortcutCoach = { consider: async () => { considered = true; return null; } };
  const legacyToast = fakeLegacyToast();
  const handle = mount({ overlays: fakeOverlayRegistry(), settings: fakeSettings(), legacyToast, shortcutCoach });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const shown = await handle.offerShortcutCoach('previousHunk');

  assert.equal(shown, false);
  assert.equal(considered, false);
  assert.deepEqual(legacyToast.hints, []);

  handle.unmount();
});

test('offerShortcutCoach: blocked when the tab is hidden, an overlay is open, or the toast is already showing', async () => {
  buildFixture();
  const shortcutCoach = { consider: async () => ({ actionID: 'semanticJump', displayBinding: 'Ctrl+F12' }) };
  const overlays = fakeOverlayRegistry();
  const legacyToast = fakeLegacyToast();
  const handle = mount({ overlays, settings: fakeSettings(), legacyToast, shortcutCoach });
  await new Promise((resolve) => setTimeout(resolve, 0));

  overlays.setOpen(1);
  assert.equal(await handle.offerShortcutCoach('semanticJump'), false, 'an open overlay blocks the coach');
  overlays.setOpen(0);

  legacyToast.setShowing(true);
  assert.equal(await handle.offerShortcutCoach('semanticJump'), false, 'an already-showing toast blocks the coach');
  legacyToast.setShowing(false);

  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  assert.equal(await handle.offerShortcutCoach('semanticJump'), false, 'a hidden tab blocks the coach');

  handle.unmount();
});

test('offerShortcutCoach: re-checks blocked after the shortcutCoach.consider() await, not just before it', async () => {
  buildFixture();
  const overlays = fakeOverlayRegistry();
  const legacyToast = fakeLegacyToast();
  const shortcutCoach = {
    consider: async () => {
      // An overlay opens while consider() is awaiting its own storage
      // round trip — the exact race the old shortcutCoachBlocked()
      // re-check inside showShortcutCoachHint() guarded against.
      overlays.setOpen(1);
      return { actionID: 'semanticJump', displayBinding: 'Ctrl+F12' };
    },
  };
  const handle = mount({ overlays, settings: fakeSettings(), legacyToast, shortcutCoach });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const shown = await handle.offerShortcutCoach('semanticJump');

  assert.equal(shown, false, 'blocked state that appeared mid-await must still suppress the hint');
  assert.deepEqual(legacyToast.hints, []);

  handle.unmount();
});

test('offerShortcutCoach: enabled defaults true before settings.ready() resolves, matching content.js\'s old optimistic default', async () => {
  buildFixture();
  const shortcutCoach = { consider: async () => ({ actionID: 'semanticJump', displayBinding: 'Ctrl+F12' }) };
  const legacyToast = fakeLegacyToast();
  const settings = fakeSettings();
  let resolveReady;
  settings.ready = () => new Promise((resolve) => { resolveReady = resolve; });
  const handle = mount({ overlays: fakeOverlayRegistry(), settings, legacyToast, shortcutCoach });

  const shown = await handle.offerShortcutCoach('semanticJump');

  assert.equal(shown, true, 'shortcuts/coach are live before settings.ready() resolves, not inert');
  resolveReady();
  handle.unmount();
});

test('offerShortcutCoach: disabled never asks shortcutCoach', async () => {
  buildFixture();
  let considered = false;
  const shortcutCoach = { consider: async () => { considered = true; return null; } };
  const handle = mount({ overlays: fakeOverlayRegistry(), settings: fakeSettings({ enabled: false }), legacyToast: fakeLegacyToast(), shortcutCoach });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(await handle.offerShortcutCoach('semanticJump'), false);
  assert.equal(considered, false);

  handle.unmount();
});

test('keydown dispatch: file-search shortcuts do not consume input in GitLab editors, hunk/file/history/coach behave identically to the legacy listener', async () => {
  const window = buildFixture();
  window.document.body.innerHTML = `
    <div data-testid="file-browser"><input id="file-search" placeholder="Search (e.g. *.vue)" value="*.go"></div>
    <textarea id="comment-editor"></textarea>
    <div id="rich-editor" contenteditable="true"></div>
    <div id="dialog" role="dialog"><button id="dialog-button">Keep focus</button></div>
  `;
  const navigationActions = [];
  const learnedActions = [];
  const coachedActions = [];
  const shortcutCoach = {
    markShortcutUsed(action) { learnedActions.push(action); return Promise.resolve(true); },
    consider(action) { coachedActions.push(action); return Promise.resolve(null); },
  };

  const handle = mount({
    overlays: fakeOverlayRegistry(),
    settings: fakeSettings({ shortcutBindings: shortcutSettings.defaultBindings() }),
    legacyToast: fakeLegacyToast(),
    runLegacyNavigationAction: (action) => { navigationActions.push(action); return true; },
    shortcutCoach,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const fileSearch = window.document.getElementById('file-search');
  const commentEditor = window.document.getElementById('comment-editor');
  const richEditor = window.document.getElementById('rich-editor');
  const primaryModifier = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '') ? { metaKey: true } : { ctrlKey: true };

  commentEditor.focus();
  const shiftF = new window.KeyboardEvent('keydown', { key: 'F', code: 'KeyF', shiftKey: true, bubbles: true, cancelable: true });
  commentEditor.dispatchEvent(shiftF);
  assert.equal(shiftF.defaultPrevented, false);
  assert.equal(fileSearch.value, '*.go');
  assert.equal(window.document.activeElement, commentEditor);

  const commandP = new window.KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ...primaryModifier, bubbles: true, cancelable: true });
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
  const pageCommandP = new window.KeyboardEvent('keydown', { key: 'p', code: 'KeyP', ...primaryModifier, bubbles: true, cancelable: true });
  window.document.body.dispatchEvent(pageCommandP);
  assert.equal(pageCommandP.defaultPrevented, true);
  assert.equal(window.document.activeElement, fileSearch);

  const dialogButton = window.document.getElementById('dialog-button');
  dialogButton.focus();
  dialogButton.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', altKey: true, ...primaryModifier, bubbles: true, cancelable: true }));
  assert.deepEqual(navigationActions, []);

  window.document.body.focus();
  const nextOccurrence = new window.KeyboardEvent('keydown', { key: 'ArrowDown', code: 'ArrowDown', altKey: true, ...primaryModifier, bubbles: true, cancelable: true });
  window.document.body.dispatchEvent(nextOccurrence);
  assert.equal(nextOccurrence.defaultPrevented, true);
  assert.deepEqual(navigationActions, ['nextOccurrence']);
  assert.deepEqual(learnedActions, ['clearFileSearch', 'focusFileSearch', 'nextOccurrence']);

  const semanticJump = new window.KeyboardEvent('keydown', { key: 'F12', code: 'F12', ...primaryModifier, bubbles: true, cancelable: true });
  window.document.body.dispatchEvent(semanticJump);
  assert.equal(semanticJump.defaultPrevented, true);
  assert.deepEqual(navigationActions, ['nextOccurrence', 'semanticJump']);
  assert.deepEqual(learnedActions, ['clearFileSearch', 'focusFileSearch', 'nextOccurrence', 'semanticJump']);

  handle.unmount();
});

test('manually clicking the native file search offers the coach, matching the legacy click listener', async () => {
  const window = buildFixture();
  window.document.body.innerHTML = '<div data-testid="file-browser"><input id="file-search" placeholder="Search (e.g. *.vue)"></div>';
  const coachedActions = [];
  const shortcutCoach = { consider: async (action) => { coachedActions.push(action); return null; } };
  const handle = mount({ overlays: fakeOverlayRegistry(), settings: fakeSettings(), legacyToast: fakeLegacyToast(), shortcutCoach });
  await new Promise((resolve) => setTimeout(resolve, 0));

  window.document.getElementById('file-search').click();
  window.document.getElementById('file-search').click();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(coachedActions, ['focusFileSearch', 'focusFileSearch']);

  handle.unmount();
});

test('keydown dispatch: toggleDiffView (Alt+V) calls ctx.toggleDiffView, not runLegacyNavigationAction/navigationAction, and only when it reports true is the shortcut consumed', async () => {
  const window = buildFixture();
  const calls = [];
  const legacyToast = fakeLegacyToast();
  let result = true;
  const handle = mount({
    overlays: fakeOverlayRegistry(),
    settings: fakeSettings({ shortcutBindings: shortcutSettings.defaultBindings() }),
    legacyToast,
    runLegacyNavigationAction: () => { throw new Error('toggleDiffView must not fall through to runLegacyNavigationAction'); },
    navigationAction: () => { throw new Error('toggleDiffView must not fall through to navigationAction'); },
    toggleDiffView: () => { calls.push('toggleDiffView'); return result; },
    shortcutCoach: { consider: async () => null },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  window.document.body.tabIndex = -1;
  window.document.body.focus();
  const first = new window.KeyboardEvent('keydown', { key: 'v', code: 'KeyV', altKey: true, bubbles: true, cancelable: true });
  window.document.body.dispatchEvent(first);
  assert.deepEqual(calls, ['toggleDiffView']);
  assert.equal(first.defaultPrevented, true);

  result = false;
  const second = new window.KeyboardEvent('keydown', { key: 'v', code: 'KeyV', altKey: true, bubbles: true, cancelable: true });
  window.document.body.dispatchEvent(second);
  assert.deepEqual(calls, ['toggleDiffView', 'toggleDiffView']);
  assert.equal(second.defaultPrevented, false, 'toggleDiffView() reporting false leaves the shortcut unconsumed');

  handle.unmount();
});

test('hunk navigation: falls back to scanning changed rows when no explicit hunk markup exists, and reports an empty toast when nothing is loaded', async () => {
  const window = buildFixture();
  window.document.body.innerHTML = `
    <diff-file data-file-path="pkg/a.go">
      <table><tbody>
        <tr class="new" id="row-1"><td>1</td></tr>
        <tr class="new" id="row-2"><td>2</td></tr>
        <tr id="row-3"><td>3</td></tr>
        <tr class="new" id="row-4"><td>4</td></tr>
      </tbody></table>
    </diff-file>
  `;
  for (const row of window.document.querySelectorAll('tr')) {
    row.getBoundingClientRect = () => ({ top: 100 });
  }
  const legacyToast = fakeLegacyToast();
  const shortcutCoach = { consider: async () => null };
  const handle = mount({
    overlays: fakeOverlayRegistry(),
    settings: fakeSettings({ shortcutBindings: shortcutSettings.defaultBindings() }),
    legacyToast,
    runLegacyNavigationAction: () => false,
    shortcutCoach,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));

  const nextHunk = new window.KeyboardEvent('keydown', { key: 'F5', code: 'F5', altKey: true, bubbles: true, cancelable: true });
  window.document.body.dispatchEvent(nextHunk);
  assert.equal(nextHunk.defaultPrevented, true, 'a hunk was found and navigated to');
  assert.equal(window.document.getElementById('row-1').dataset.golensNavigationDestination, '');

  window.document.body.innerHTML = '<div>no diff loaded</div>';
  const nextHunkAgain = new window.KeyboardEvent('keydown', { key: 'F5', code: 'F5', altKey: true, bubbles: true, cancelable: true });
  window.document.body.dispatchEvent(nextHunkAgain);
  assert.equal(nextHunkAgain.defaultPrevented, false, 'nothing to navigate to, so the shortcut is not consumed');
  assert.deepEqual(legacyToast.messages, ['No loaded diff hunks.']);

  handle.unmount();
});

test('unmount() removes both listeners and clears the hunk/file navigation cursor', async () => {
  const window = buildFixture();
  window.document.body.innerHTML = '<div data-testid="file-browser"><input id="file-search" placeholder="Search (e.g. *.vue)"></div>';
  const shortcutCoach = { consider: async () => null };
  const handle = mount({ overlays: fakeOverlayRegistry(), settings: fakeSettings(), legacyToast: fakeLegacyToast(), shortcutCoach });
  await new Promise((resolve) => setTimeout(resolve, 0));

  handle.unmount();

  const search = window.document.getElementById('file-search');
  let handledAfterUnmount = false;
  search.focus = () => { handledAfterUnmount = true; };
  const event = new window.KeyboardEvent('keydown', { key: 'p', ctrlKey: true, bubbles: true, cancelable: true });
  window.document.body.dispatchEvent(event);
  assert.equal(handledAfterUnmount, false, 'the keydown listener must be removed');
  assert.doesNotThrow(() => handle.unmount());
});

test('module-scope offerShortcutCoach() forwards to the currently-mounted instance, mirroring celebration.js\'s requestMoment', async () => {
  const { offerShortcutCoach: moduleOfferShortcutCoach } = await import('../page/features/keyboard-nav.js');
  buildFixture();
  assert.equal(await moduleOfferShortcutCoach('semanticJump'), false, 'nothing mounted yet is a silent no-op');

  const shortcutCoach = { consider: async () => ({ actionID: 'semanticJump', displayBinding: 'Ctrl+F12' }) };
  const legacyToast = fakeLegacyToast();
  const handle = mount({ overlays: fakeOverlayRegistry(), settings: fakeSettings(), legacyToast, shortcutCoach });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(await moduleOfferShortcutCoach('semanticJump'), true);
  assert.equal(legacyToast.hints.length, 1);

  handle.unmount();
  assert.equal(await moduleOfferShortcutCoach('semanticJump'), false, 'no active instance after unmount');
});
