import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('celebrates confirmed review milestones and cache completion', async (t) => {
  const RealDate = globalThis.Date;
  const mondayMorning = new RealDate(2026, 6, 13, 10, 0, 0).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [mondayMorning])); }
    static now() { return mondayMorning; }
  };
  t.after(() => { globalThis.Date = RealDate; });
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42' });
  window.document.write(`
    <!doctype html>
    <html><head><meta name="csrf-token" content="fixture"></head><body>
      <div class="layout-page is-merge-request">
        <div class="ai-panels"><div><nav><div><button>AI</button></div></nav></div></div>
        <button id="approve" type="button" data-testid="approve-button"><span>Approve</span></button>
        <button id="unapprove" type="button" data-testid="unapprove-button">Revoke approval</button>
        <button id="merge" type="button" data-testid="merge-button"><span>Merge</span></button>
        <button id="resolve" type="button" data-testid="resolve-thread"><span>Resolve thread</span></button>
      </div>
    </body></html>
  `);
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;

  let mergeRequestStatus = { state: 'opened', approvers: [] };
  let discussionStatus = { unresolved: 1 };
  let statusRequests = 0;
  globalThis.GoLensGoNavigation = {
    init() {},
    teardown() {},
    async mergeRequestPreloadStatus() { return { status: 'missing' }; },
    async preloadMergeRequest() { return { searchStatus: 'available', coverage: 'related' }; },
    async mergeRequestCelebrationStatus() {
      statusRequests++;
      return { ...mergeRequestStatus, approvers: [...mergeRequestStatus.approvers] };
    },
    async mergeRequestDiscussionStatus() { return { ...discussionStatus }; },
    invalidateCacheState() {},
  };
  globalThis.chrome = {
    storage: {
      sync: { async get(defaults) { return defaults; }, async set() {} },
      local: {
        async get(defaults) { return { ...defaults, golensOnboardingVersion: 5 }; },
        async set() {},
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      getURL(path) { return `chrome-extension://golens/${path}`; },
      onMessage: { addListener() {} },
    },
  };

  await import('../content.js?content-celebrations-test');
  await wait(0);

  assert.ok(statusRequests >= 1, 'the initial MR status was not captured');
  assert.equal(window.document.getElementById('golens-celebration-root'), null, 'an existing MR state must not celebrate on load');

  window.document.getElementById('unapprove').click();
  await wait(20);
  assert.equal(window.document.getElementById('golens-celebration-root'), null, 'revoking an approval must not celebrate');

  window.document.getElementById('approve').addEventListener('click', () => {
    mergeRequestStatus = { state: 'opened', approvers: ['7'] };
  });
  window.document.getElementById('approve').querySelector('span').click();
  await wait(320);

  const approvedHost = window.document.getElementById('golens-celebration-root');
  assert.equal(approvedHost?.dataset.celebration, 'approved');
  assert.match(approvedHost.shadowRoot.querySelector('img').src, /assets\/celebrations\/golens-approved\.png$/);
  assert.equal(approvedHost.shadowRoot.querySelector('[role="status"]').textContent, 'Approval confirmed');
  assert.match(approvedHost.shadowRoot.querySelector('style').textContent, /prefers-reduced-motion:reduce/);

  window.document.getElementById('resolve').addEventListener('click', () => {
    discussionStatus = { unresolved: 0 };
  });
  window.document.getElementById('resolve').querySelector('span').click();
  await wait(320);

  const resolvedHost = window.document.getElementById('golens-celebration-root');
  assert.equal(resolvedHost?.dataset.celebration, 'resolved');
  assert.match(resolvedHost.shadowRoot.querySelector('img').src, /assets\/celebrations\/golens-discussions-resolved\.png$/);
  assert.equal(resolvedHost.shadowRoot.querySelector('[role="status"]').textContent, 'All discussions resolved');

  window.document.getElementById('gitlab-lens-root').shadowRoot.querySelector('[data-action="preload"]').click();
  await wait(0);
  const pitstopHost = window.document.getElementById('golens-celebration-root');
  assert.equal(pitstopHost?.dataset.celebration, 'pitstop');
  assert.match(pitstopHost.shadowRoot.querySelector('img').src, /assets\/celebrations\/golens-pitstop\.png$/);
  assert.equal(pitstopHost.shadowRoot.querySelector('[role="status"]').textContent, 'Source cache ready');

  window.document.getElementById('merge').addEventListener('click', () => {
    mergeRequestStatus = { state: 'merged', approvers: ['7'] };
  });
  window.document.getElementById('merge').querySelector('span').click();
  await wait(320);

  const mergedHost = window.document.getElementById('golens-celebration-root');
  assert.equal(mergedHost?.dataset.celebration, 'merged');
  assert.match(mergedHost.shadowRoot.querySelector('img').src, /assets\/celebrations\/golens-merged\.png$/);
  assert.equal(mergedHost.shadowRoot.querySelector('[role="status"]').textContent, 'Merge confirmed');

  window.happyDOM.setURL('https://gitlab.example/group/project/-/issues');
  window.document.dispatchEvent(new window.Event('turbo:load'));
  await wait(0);
  assert.equal(window.document.getElementById('golens-celebration-root'), null, 'leaving the MR removes an active celebration');
});
