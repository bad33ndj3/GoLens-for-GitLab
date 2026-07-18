import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

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

test('adds exact Changes links to overview line discussions', async () => {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42' });
  const target = '/group/project/-/merge_requests/42/diffs?diff_id=77&start_sha=abc#filehash_0_12';
  window.document.write(`
    <!doctype html>
    <html><head><meta name="csrf-token" content="fixture"></head><body>
      <div class="layout-page is-merge-request">
        <div class="ai-panels"><div><nav><div><button>AI</button></div></nav></div></div>
      </div>
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
  let mutationListener;
  globalThis.MutationObserver = class {
    constructor(listener) { mutationListener = listener; }
    observe() {}
    disconnect() {}
  };
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

  const settle = async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 1000;
    while (Date.now() < deadline) {
      if (predicate()) return;
      await settle();
    }
    assert.ok(predicate(), 'timed out waiting for discussion-link reconciliation');
  };
  await import('../content.js?content-discussion-links-test');
  await waitFor(() => window.document.querySelector('#line-discussion [data-golens-discussion-line-link]'));

  const link = window.document.querySelector('#line-discussion [data-golens-discussion-line-link]');
  assert.ok(link);
  assert.equal(link.textContent, 'View in changes');
  assert.equal(link.href, `https://gitlab.example${target}`);
  assert.equal(link.getAttribute('aria-label'), 'Open commented line in Changes');
  assert.equal(window.document.querySelectorAll('#line-discussion [data-golens-discussion-line-link]').length, 1);
  assert.equal(window.document.querySelector('#general-discussion [data-golens-discussion-line-link]'), null);
  assert.equal(window.document.querySelector('#file-discussion [data-golens-discussion-line-link]'), null);

  window.document.getElementById('activity').append(window.document.createElement('span'));
  mutationListener();
  await settle();
  assert.equal(window.document.querySelectorAll('#line-discussion [data-golens-discussion-line-link]').length, 1);

  const streamed = window.document.createElement('div');
  const streamedTarget = '/group/project/-/merge_requests/42/diffs?diff_id=78#otherhash_4_9';
  streamed.innerHTML = lineDiscussion('streamed-discussion', streamedTarget);
  window.document.getElementById('activity').append(streamed.firstElementChild);
  mutationListener();
  await waitFor(() => window.document.querySelector('#streamed-discussion [data-golens-discussion-line-link]'));
  assert.equal(
    window.document.querySelector('#streamed-discussion [data-golens-discussion-line-link]').href,
    `https://gitlab.example${streamedTarget}`
  );

  storageListener({ enabled: { oldValue: true, newValue: false } }, 'sync');
  await waitFor(() => !window.document.querySelector('[data-golens-discussion-line-link]'));
  assert.equal(window.document.querySelector('[data-golens-discussion-line-link]'), null);

  storageListener({ enabled: { oldValue: false, newValue: true } }, 'sync');
  await waitFor(() => window.document.querySelector('#line-discussion [data-golens-discussion-line-link]'));
  assert.ok(window.document.querySelector('#line-discussion [data-golens-discussion-line-link]'));

  window.happyDOM.setURL('https://gitlab.example/group/project/-/merge_requests/42/diffs');
  window.document.dispatchEvent(new window.Event('turbo:load'));
  await waitFor(() => !window.document.querySelector('[data-golens-discussion-line-link]'));
  assert.equal(window.document.querySelector('[data-golens-discussion-line-link]'), null);
});
