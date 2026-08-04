import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { mount } from '../page/features/go-test-file-rows.js';

// Synchronous fake clock, same shape as features-generated-files.test.js's.
function fakeClock() {
  return {
    debounceIdle(fn) {
      const debounced = (...args) => fn(...args);
      debounced.cancel = () => {};
      return debounced;
    },
  };
}

function fakeSettingsStore(initial = { enabled: true }) {
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
    set() { throw new Error('go-test-file-rows must never write settings'); },
  };
}

function buildFixture(url = 'https://gitlab.example/group/project/-/merge_requests/42/diffs') {
  const window = new Window({ url });
  window.document.write(`
    <!doctype html>
    <html><head><meta name="csrf-token" content="fixture"></head><body>
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
  return window;
}

test('mount(ctx) marks _test.go file-tree rows, including rows added after initial mount; unmount() clears them', async () => {
  const window = buildFixture();
  const settings = fakeSettingsStore({ enabled: true });
  const handle = mount({ settings, clock: fakeClock() });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(window.document.getElementById('tree-go-test').hasAttribute('data-golens-go-test-file-row'));
  assert.equal(window.document.getElementById('tree-go-source').hasAttribute('data-golens-go-test-file-row'), false);

  const streamedGoTest = window.document.createElement('a');
  streamedGoTest.dataset.fileRow = 'streamed-go-test';
  streamedGoTest.textContent = 'repository_test.go';
  window.document.getElementById('file-tree').append(streamedGoTest);
  await Promise.resolve();
  await Promise.resolve();
  assert.ok(streamedGoTest.hasAttribute('data-golens-go-test-file-row'));

  handle.unmount();
  assert.equal(window.document.querySelector('[data-golens-go-test-file-row]'), null);
});

test('reconciles on disabling, re-enabling, and leaving the diffs page', async () => {
  const window = buildFixture();
  const settings = fakeSettingsStore({ enabled: true });
  mount({ settings, clock: fakeClock() });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(window.document.getElementById('tree-go-test').hasAttribute('data-golens-go-test-file-row'));

  settings.fireChange('enabled', false);
  assert.equal(window.document.querySelector('[data-golens-go-test-file-row]'), null, 'disabling GoLens clears the markers');

  settings.fireChange('enabled', true);
  assert.ok(window.document.getElementById('tree-go-test').hasAttribute('data-golens-go-test-file-row'), 're-enabling restores the markers');
});

test('does not mark rows off the diffs sub-tab', async () => {
  const window = buildFixture('https://gitlab.example/group/project/-/merge_requests/42');
  const settings = fakeSettingsStore({ enabled: true });
  mount({ settings, clock: fakeClock() });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(window.document.querySelector('[data-golens-go-test-file-row]'), null);
});
