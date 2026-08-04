// Ticket 29: page/platform/toast.js as a unit. The shadow host is real
// (happy-dom), the timers are real but never waited out — the auto-hide
// delays are asserted through a stubbed global setTimeout instead, so the
// suite stays instant.
//
// tests/shortcut-coach-ui.test.js still drives the same surface through
// go-navigation.js's wrappers, which is what proves the bridge is wired up.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';

import { createToast } from '../page/platform/toast.js';

let window;
let realSetTimeout;
let realClearTimeout;
let scheduled;

beforeEach(() => {
  window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;

  // Capture what the surface schedules without ever letting it fire.
  scheduled = [];
  realSetTimeout = globalThis.setTimeout;
  realClearTimeout = globalThis.clearTimeout;
  globalThis.setTimeout = (fn, ms) => {
    scheduled.push({ fn, ms });
    return scheduled.length;
  };
  globalThis.clearTimeout = (id) => {
    if (typeof id === 'number' && scheduled[id - 1]) scheduled[id - 1].cleared = true;
  };
});

afterEach(() => {
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  delete globalThis.GoLensShortcutCoach;
});

function toastElement() {
  return document.getElementById('golens-go-toast-root')?.shadowRoot.querySelector('.toast') ?? null;
}

test('creates nothing until something is actually shown', () => {
  createToast();
  assert.equal(document.getElementById('golens-go-toast-root'), null);
});

test('renders a message toast into a shadow host and auto-hides after 2600ms', () => {
  const surface = createToast();
  surface.toast('Go intelligence ready');

  const element = toastElement();
  assert.equal(element.dataset.kind, 'message');
  assert.equal(element.querySelector('.toast-message').textContent, 'Go intelligence ready');
  assert.equal(element.classList.contains('show'), true);
  assert.equal(surface.isToastShowing(), true);
  assert.deepEqual(scheduled.map((entry) => entry.ms), [2600]);
});

test('renders a shortcut hint with its binding and the longer 8000ms timeout', () => {
  const surface = createToast();
  assert.equal(surface.showShortcutCoachHint({ message: 'Jump to the symbol.', displayBinding: 'Ctrl+F12' }), true);

  const element = toastElement();
  assert.equal(element.dataset.kind, 'shortcut');
  assert.equal(element.querySelector('.toast-message').textContent, 'Jump to the symbol.');
  assert.equal(element.querySelector('.toast-binding').textContent, 'Ctrl+F12');
  assert.deepEqual(scheduled.map((entry) => entry.ms), [8000]);
});

test('refuses a hint with no message and renders nothing', () => {
  const surface = createToast();
  assert.equal(surface.showShortcutCoachHint({ displayBinding: 'Ctrl+F12' }), false);
  assert.equal(surface.showShortcutCoachHint(null), false);
  assert.equal(document.getElementById('golens-go-toast-root'), null);
});

test('reuses one host and one element across both renderings', () => {
  const surface = createToast();
  surface.toast('first');
  const first = toastElement();
  surface.showShortcutCoachHint({ message: 'hint', displayBinding: 'X' });
  assert.equal(toastElement(), first, 'the same node is re-dressed, not rebuilt');
  assert.equal(first.dataset.kind, 'shortcut');
  assert.equal(document.querySelectorAll('#golens-go-toast-root').length, 1);
});

test('replaces a pending auto-hide instead of stacking timers', () => {
  const surface = createToast();
  surface.toast('first');
  surface.toast('second');
  assert.equal(scheduled[0].cleared, true, 'the first auto-hide was cancelled');
  assert.equal(toastElement().querySelector('.toast-message').textContent, 'second');
});

test('rebuilds the host after an SPA navigation removed it from the document', () => {
  const surface = createToast();
  surface.toast('before');
  document.getElementById('golens-go-toast-root').remove();
  // Faithful to the pre-ticket-29 behaviour, quirk included: only
  // `ensureUI` checks `isConnected`, so `isToastShowing()` still reports the
  // detached node's class. Nothing depends on the other answer today
  // (keyboard-nav only asks while the page is live), so this stays as it
  // was rather than being quietly "fixed" inside a lift-and-shift ticket.
  assert.equal(surface.isToastShowing(), true);

  // `ensureUI` does notice, and rebuilds rather than writing into a
  // detached tree.
  surface.toast('after');
  assert.equal(toastElement().querySelector('.toast-message').textContent, 'after');
  assert.equal(document.querySelectorAll('#golens-go-toast-root').length, 1);
});

test('hideToast clears the pending timer and reports not-showing', () => {
  const surface = createToast();
  surface.toast('message');
  surface.hideToast();
  assert.equal(toastElement().classList.contains('show'), false);
  assert.equal(surface.isToastShowing(), false);
  assert.equal(scheduled[0].cleared, true);
});

test('hideToast and isToastShowing are safe before anything was ever shown', () => {
  const surface = createToast();
  assert.doesNotThrow(() => surface.hideToast());
  assert.equal(surface.isToastShowing(), false);
});

test('the dismiss button hides the toast', () => {
  const surface = createToast();
  surface.showShortcutCoachHint({ message: 'hint', displayBinding: 'X' });
  const shadow = document.getElementById('golens-go-toast-root').shadowRoot;
  shadow.querySelector('[data-action="shortcut-tip-dismiss"]').click();
  assert.equal(toastElement().classList.contains('show'), false);
});

test('the disable button turns tips off and confirms it', async () => {
  let enabled = true;
  globalThis.GoLensShortcutCoach = { async setEnabled(value) { enabled = value; return true; } };
  const surface = createToast();
  surface.showShortcutCoachHint({ message: 'hint', displayBinding: 'X' });

  document.getElementById('golens-go-toast-root').shadowRoot
    .querySelector('[data-action="shortcut-tip-disable"]').click();
  await new Promise((resolve) => realSetTimeout(resolve, 0));

  assert.equal(enabled, false);
  assert.match(toastElement().querySelector('.toast-message').textContent, /re-enable them in settings/);
});

test('the disable button reports a failure to save rather than claiming success', async () => {
  globalThis.GoLensShortcutCoach = { async setEnabled() { return false; } };
  const surface = createToast();
  surface.showShortcutCoachHint({ message: 'hint', displayBinding: 'X' });

  document.getElementById('golens-go-toast-root').shadowRoot
    .querySelector('[data-action="shortcut-tip-disable"]').click();
  await new Promise((resolve) => realSetTimeout(resolve, 0));

  assert.match(toastElement().querySelector('.toast-message').textContent, /Could not update shortcut tip settings/);
});

test('destroy removes the host and cancels the pending auto-hide', () => {
  const surface = createToast();
  surface.toast('message');
  surface.destroy();
  assert.equal(document.getElementById('golens-go-toast-root'), null);
  assert.equal(scheduled[0].cleared, true);
  assert.equal(surface.isToastShowing(), false);
  // A destroyed surface is reusable — teardown/init cycles depend on it.
  surface.toast('again');
  assert.equal(toastElement().querySelector('.toast-message').textContent, 'again');
});
