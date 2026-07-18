import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

test('uses the Friday beer kart for MR creation, approval, and merge after 16:00', async (t) => {
  const RealDate = globalThis.Date;
  const fridayAfternoon = new RealDate(2026, 6, 17, 16, 30, 0).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fridayAfternoon])); }
    static now() { return fridayAfternoon; }
  };
  t.after(() => { globalThis.Date = RealDate; });

  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/new' });
  window.document.write(`
    <!doctype html>
    <html><head><meta name="csrf-token" content="fixture"></head><body>
      <div class="layout-page is-merge-request">
        <div class="ai-panels"><div><nav><div><button>AI</button></div></nav></div></div>
        <a id="create" data-testid="create-merge-request-button" href="/group/project/-/merge_requests/43">Create merge request</a>
        <button id="approve" type="button" data-testid="approve-button"><span>Approve</span></button>
        <button id="merge" type="button" data-testid="merge-button"><span>Merge</span></button>
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
  globalThis.GoLensGoNavigation = {
    init() {},
    teardown() {},
    async mergeRequestPreloadStatus() { return { status: 'missing' }; },
    async mergeRequestCelebrationStatus() {
      return { ...mergeRequestStatus, approvers: [...mergeRequestStatus.approvers] };
    },
    async mergeRequestDiscussionStatus() { return { unresolved: 0 }; },
    invalidateCacheState() {},
  };
  globalThis.chrome = {
    storage: {
      sync: { async get(defaults) { return defaults; }, async set() {} },
      local: {
        async get(defaults) { return { ...defaults, golensOnboardingVersion: 8 }; },
        async set() {},
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      getURL(path) { return `chrome-extension://golens/${path}`; },
      onMessage: { addListener() {} },
    },
  };

  await import('../content.js?content-friday-test');
  await wait(0);

  window.document.getElementById('create').addEventListener('click', (event) => event.preventDefault());
  window.document.getElementById('create').click();
  window.happyDOM.setURL('https://gitlab.example/group/project/-/merge_requests/43');
  window.document.dispatchEvent(new window.Event('turbo:load'));
  await wait(0);

  const creationHost = window.document.getElementById('golens-celebration-root');
  assert.equal(creationHost?.dataset.celebration, 'friday');
  assert.match(creationHost.shadowRoot.querySelector('img').src, /assets\/celebrations\/golens-friday-beer\.png$/);
  assert.equal(creationHost.shadowRoot.querySelector('[role="status"]').textContent, 'Friday review complete. Cheers!');
  assert.equal(creationHost.shadowRoot.querySelectorAll('.confetti').length, 48);
  assert.match(creationHost.shadowRoot.querySelector('style').textContent, /golens-friday-lap 5500ms/);
  assert.match(creationHost.shadowRoot.querySelector('style').textContent, /\.confetti-field \{ display:none; \}/);

  window.document.getElementById('approve').addEventListener('click', () => {
    mergeRequestStatus = { state: 'opened', approvers: ['7'] };
  });
  window.document.getElementById('approve').querySelector('span').click();
  await wait(320);
  assert.equal(window.document.getElementById('golens-celebration-root')?.dataset.celebration, 'friday');

  window.document.getElementById('merge').addEventListener('click', () => {
    mergeRequestStatus = { state: 'merged', approvers: ['7'] };
  });
  window.document.getElementById('merge').querySelector('span').click();
  await wait(320);
  assert.equal(window.document.getElementById('golens-celebration-root')?.dataset.celebration, 'friday');
});
