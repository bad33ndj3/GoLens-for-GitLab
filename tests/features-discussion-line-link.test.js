import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { mount } from '../page/features/discussion-line-link.js';

// Synchronous fake clock, same shape as features-generated-files.test.js's:
// debounceIdle runs `fn` immediately so these tests don't sleep for real
// timers (real debounce timing is platform/clock.js's own test surface).
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
    set() { throw new Error('discussion-line-link must never write settings'); },
  };
}

const lineDiscussion = (id, href) => `
  <section id="${id}" class="discussion js-discussion-container" data-testid="discussion-content">
    <div class="discussion-header">
      <div class="timeline-content">
        <div class="note-header-info"><a href="${href}">the diff</a></div>
      </div>
    </div>
    <div class="diff-file file-holder">
      <div class="diff-file-header"><a href="${href}">${id}.go</a></div>
      <table><tbody><tr class="line_holder"><td class="new_line">12</td><td>commented line</td></tr></tbody></table>
    </div>
  </section>
`;

function buildFixture(url, target) {
  const window = new Window({ url });
  window.document.write(`
    <!doctype html>
    <html><head><meta name="csrf-token" content="fixture"></head><body>
      <main id="activity">
        ${lineDiscussion('line-discussion', target)}
        <section id="general-discussion" class="discussion js-discussion-container" data-testid="discussion-content">
          <div class="discussion-header"><div class="note-header-info"><a href="#note_5">thread</a></div></div>
          <p>General merge request comment</p>
        </section>
        <section id="file-discussion" class="discussion js-discussion-container" data-testid="discussion-content">
          <div class="discussion-header"><div class="note-header-info"><a href="${target}">a file</a></div></div>
          <div class="diff-file file-holder"><div class="diff-file-header">file.go</div></div>
        </section>
      </main>
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

test('mount(ctx) adds exact Changes links to overview line discussions; unmount() removes them', async () => {
  const target = '/group/project/-/merge_requests/42/diffs?diff_id=77&start_sha=abc#filehash_0_12';
  const window = buildFixture('https://gitlab.example/group/project/-/merge_requests/42', target);
  const settings = fakeSettingsStore({ enabled: true });
  const clock = fakeClock();
  const handle = mount({ settings, clock });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  const link = window.document.querySelector('#line-discussion [data-golens-discussion-line-link]');
  assert.ok(link);
  assert.equal(link.textContent, 'View in changes');
  assert.equal(link.href, `https://gitlab.example${target}`);
  assert.equal(link.getAttribute('aria-label'), 'Open commented line in Changes');
  assert.equal(window.document.querySelectorAll('#line-discussion [data-golens-discussion-line-link]').length, 1);
  assert.equal(window.document.querySelector('#general-discussion [data-golens-discussion-line-link]'), null);
  assert.equal(window.document.querySelector('#file-discussion [data-golens-discussion-line-link]'), null);

  handle.unmount();
  assert.equal(window.document.querySelector('[data-golens-discussion-line-link]'), null);
});

test('reconciles on DOM mutation, disabling, and re-enabling', async () => {
  const target = '/group/project/-/merge_requests/42/diffs?diff_id=77&start_sha=abc#filehash_0_12';
  const window = buildFixture('https://gitlab.example/group/project/-/merge_requests/42', target);
  const settings = fakeSettingsStore({ enabled: true });
  const clock = fakeClock();
  mount({ settings, clock });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(window.document.querySelector('#line-discussion [data-golens-discussion-line-link]'));

  const streamed = window.document.createElement('div');
  const streamedTarget = '/group/project/-/merge_requests/42/diffs?diff_id=78#otherhash_4_9';
  streamed.innerHTML = lineDiscussion('streamed-discussion', streamedTarget);
  window.document.getElementById('activity').append(streamed.firstElementChild);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    window.document.querySelector('#streamed-discussion [data-golens-discussion-line-link]').href,
    `https://gitlab.example${streamedTarget}`
  );

  settings.fireChange('enabled', false);
  assert.equal(window.document.querySelector('[data-golens-discussion-line-link]'), null);

  settings.fireChange('enabled', true);
  assert.ok(window.document.querySelector('#line-discussion [data-golens-discussion-line-link]'));
});

test('hides links on the Changes tab itself and off the merge-request page', async () => {
  const target = '/group/project/-/merge_requests/42/diffs?diff_id=77&start_sha=abc#filehash_0_12';
  const window = buildFixture('https://gitlab.example/group/project/-/merge_requests/42/diffs', target);
  const settings = fakeSettingsStore({ enabled: true });
  mount({ settings, clock: fakeClock() });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(window.document.querySelector('[data-golens-discussion-line-link]'), null);
});
