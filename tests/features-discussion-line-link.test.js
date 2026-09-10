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

function fakeReviewStorage() {
  const values = {};
  return {
    get: async () => ({ ...values }),
    set: async (changes) => Object.assign(values, changes),
    remove: async (key) => { delete values[key]; },
  };
}

const lineDiscussion = (id, href, noteID = 7, comment = 'This middleware seems wrong.') => `
  <section id="${id}" class="discussion js-discussion-container" data-testid="discussion-content">
    <div class="discussion-header">
      <div class="timeline-content">
        <div class="note-header-info">
          <a class="js-user-link" data-username="reviewer" href="/reviewer">Reviewer</a>
          <a href="#note_${noteID}">the note</a>
          <a href="${href}">the diff</a>
        </div>
      </div>
    </div>
    <div data-testid="note-body">${comment}</div>
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
  assert.equal(link.textContent, 'View');
  assert.equal(link.href, `https://gitlab.example${target}`);
  assert.equal(link.getAttribute('aria-label'), 'Open commented line in Changes');
  assert.equal(window.document.querySelectorAll('#line-discussion [data-golens-discussion-line-link]').length, 1);
  assert.equal(window.document.querySelector('#general-discussion [data-golens-discussion-line-link]'), null);
  assert.equal(window.document.querySelector('#file-discussion [data-golens-discussion-line-link]'), null);
  assert.ok(window.document.querySelector('#line-discussion [data-golens-discussion-draft]'));

  handle.unmount();
  assert.equal(window.document.querySelector('[data-golens-discussion-line-link]'), null);
  assert.equal(window.document.querySelector('[data-golens-discussion-draft]'), null);
});

test('accepts a thread with optional guidance and copies a paste-ready bundle', async () => {
  const target = '/group/project/-/merge_requests/42/diffs?diff_id=77&start_sha=abc#filehash_0_12';
  const window = buildFixture('https://gitlab.example/group/project/-/merge_requests/42', target);
  const settings = fakeSettingsStore({ enabled: true });
  let copied = '';
  const handle = mount({ settings, clock: fakeClock(), copyText: async (text) => { copied = text; } });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  const toggle = window.document.querySelector('#line-discussion .gitlab-lens-discussion-draft-toggle');
  const accept = window.document.querySelector('#line-discussion .gitlab-lens-discussion-accept');
  const editor = window.document.querySelector('#line-discussion .gitlab-lens-discussion-draft');
  const textarea = editor.querySelector('textarea');
  assert.equal(editor.hidden, true);
  toggle.click();
  assert.equal(editor.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  textarea.focus();
  accept.focus();
  assert.equal(editor.hidden, true);
  toggle.click();

  textarea.value = 'Use middleware x.';
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
  assert.equal(handle.snapshot().length, 1);
  assert.equal(accept.textContent, 'Accepted');
  assert.equal(accept.getAttribute('aria-pressed'), 'true');
  assert.equal(toggle.textContent, 'Guided');
  assert.equal(toggle.dataset.hasGuidance, 'true');

  const result = await handle.copyBundle();
  assert.equal(result.kind, 'copied');
  assert.equal(result.count, 1);
  assert.equal(copied, 'line-discussion.go:12 [https://gitlab.example/group/project/-/merge_requests/42#note_7 @reviewer - "This middleware seems wrong."] - Action: Implement exactly what the reviewer requested. Optional guidance: "Use middleware x."');

  settings.fireChange('enabled', false);
  assert.equal(window.document.querySelector('[data-golens-discussion-draft]'), null);
  settings.fireChange('enabled', true);
  assert.equal(window.document.querySelector('textarea').value, 'Use middleware x.');
  assert.equal(window.document.querySelector('.gitlab-lens-discussion-accept').getAttribute('aria-pressed'), 'true');
  handle.unmount();
});

test('restores accepted comments and optional guidance after a refresh', async () => {
  const target = '/group/project/-/merge_requests/42/diffs#filehash_0_12';
  const storage = fakeReviewStorage();
  let window = buildFixture('https://gitlab.example/group/project/-/merge_requests/42', target);
  let settings = fakeSettingsStore({ enabled: true });
  let handle = mount({ settings, clock: fakeClock(), reviewStorage: storage });
  settings.resolveReady();
  await new Promise((resolve) => setImmediate(resolve));
  const textarea = window.document.querySelector('textarea');
  textarea.value = 'Keep the original error wrapping.';
  textarea.dispatchEvent(new window.Event('input'));
  await Promise.resolve();
  handle.unmount();

  window = buildFixture('https://gitlab.example/group/project/-/merge_requests/42', target);
  settings = fakeSettingsStore({ enabled: true });
  handle = mount({ settings, clock: fakeClock(), reviewStorage: storage });
  settings.resolveReady();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(handle.snapshot().length, 1);
  assert.equal(window.document.querySelector('.gitlab-lens-discussion-accept').getAttribute('aria-pressed'), 'true');
  assert.equal(window.document.querySelector('textarea').value, 'Keep the original error wrapping.');
  assert.equal(window.document.querySelector('.gitlab-lens-discussion-draft').hidden, true);
  handle.unmount();
});

test('notifies subscribers when acceptance or optional guidance changes', async () => {
  const target = '/group/project/-/merge_requests/42/diffs#filehash_0_12';
  const window = buildFixture('https://gitlab.example/group/project/-/merge_requests/42', target);
  const settings = fakeSettingsStore({ enabled: true });
  const handle = mount({ settings, clock: fakeClock(), copyText: async () => {} });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();
  const counts = [];
  const unsubscribe = handle.subscribe((records) => counts.push(records.length));
  const textarea = window.document.querySelector('textarea');
  textarea.value = 'Fix it';
  textarea.dispatchEvent(new window.Event('input'));
  textarea.value = '';
  textarea.dispatchEvent(new window.Event('input'));
  const accept = window.document.querySelector('.gitlab-lens-discussion-accept');
  accept.click();
  assert.deepEqual(counts, [1, 1, 0]);
  assert.equal((await handle.copyBundle()).kind, 'empty');
  unsubscribe();
  handle.unmount();
});

test('includes GitLab rendered suggested changes without its apply controls', async () => {
  const target = '/group/project/-/merge_requests/42/diffs#filehash_0_12';
  const suggestion = `Please use this implementation.<div class="md-suggestion"><pre><code>return middlewareX(next);\n  // keep indentation</code></pre><div class="suggestion-actions"><button>Apply suggestion</button></div></div>`;
  const window = buildFixture('https://gitlab.example/group/project/-/merge_requests/42', target);
  window.document.querySelector('[data-testid="note-body"]').innerHTML = suggestion;
  const settings = fakeSettingsStore({ enabled: true });
  let copied = '';
  const handle = mount({ settings, clock: fakeClock(), copyText: async (text) => { copied = text; } });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();
  window.document.querySelector('.gitlab-lens-discussion-accept').click();
  await handle.copyBundle();

  assert.match(copied, /Suggested change:\\nreturn middlewareX\(next\);\\n  \/\/ keep indentation/);
  assert.doesNotMatch(copied, /Apply suggestion/);
  handle.unmount();
});

test('reconciles on DOM mutation, disabling, and re-enabling', async () => {
  const target = '/group/project/-/merge_requests/42/diffs?diff_id=77&start_sha=abc#filehash_0_12';
  const window = buildFixture('https://gitlab.example/group/project/-/merge_requests/42', target);
  const settings = fakeSettingsStore({ enabled: true });
  const clock = fakeClock();
  const handle = mount({ settings, clock });
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();

  assert.ok(window.document.querySelector('#line-discussion [data-golens-discussion-line-link]'));

  const streamed = window.document.createElement('div');
  const streamedTarget = '/group/project/-/merge_requests/42/diffs?diff_id=78#otherhash_4_9';
  streamed.innerHTML = lineDiscussion('streamed-discussion', streamedTarget, 8);
  window.document.getElementById('activity').append(streamed.firstElementChild);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(
    window.document.querySelector('#streamed-discussion [data-golens-discussion-line-link]').href,
    `https://gitlab.example${streamedTarget}`
  );

  window.document.querySelector('.gitlab-lens-discussion-accept').click();
  assert.equal(handle.snapshot().length, 1);
  window.history.pushState({}, '', '/group/project/-/merge_requests/43');
  window.dispatchEvent(new window.Event('popstate'));
  assert.equal(handle.snapshot().length, 0);
  window.history.pushState({}, '', '/group/project/-/merge_requests/42');
  window.dispatchEvent(new window.Event('popstate'));

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
