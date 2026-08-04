import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { mount, requestMoment } from '../page/features/celebration.js';

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

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
  };
}

function fakeOverlayRegistry() {
  let open = false;
  const listeners = new Set();
  return {
    isAnyOpen: () => open,
    setOpen(next) {
      open = next;
      for (const fn of listeners) fn(open);
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

// Scales every real delay down (instead of collapsing them all to the same
// "next tick"), so relative ordering survives: a poll's short retry delay
// still fires before a shown celebration's much longer auto-removal
// duration, the same way it does in production. Collapsing both to 0ms (an
// earlier version of this fake) raced the two against each other and could
// remove the overlay before a test's assertion ever observed it.
function fastClock() {
  return {
    setTimeout(fn, ms = 0) {
      const id = setTimeout(fn, Math.ceil(ms / 20));
      let cancelled = false;
      return () => {
        if (cancelled) return;
        cancelled = true;
        clearTimeout(id);
      };
    },
  };
}

function setupWindow({ path = '/group/project/-/merge_requests/42' } = {}) {
  const window = new Window({ url: `https://gitlab.example${path}` });
  window.document.write(`
    <!doctype html>
    <html><head><meta name="csrf-token" content="fixture"></head><body>
      <div class="layout-page is-merge-request">
        <div class="ai-panels"><div><nav><div><button>AI</button></div></nav></div></div>
        <div id="gitlab-lens-root"></div>
        <button id="approve" type="button" data-testid="approve-button"><span>Approve</span></button>
        <button id="unapprove" type="button" data-testid="unapprove-button">Revoke approval</button>
        <button id="merge" type="button" data-testid="merge-button"><span>Merge</span></button>
        <button id="resolve" type="button" data-testid="resolve-thread"><span>Resolve thread</span></button>
        <a id="create" data-testid="create-merge-request-button" href="/group/project/-/merge_requests/43">Create merge request</a>
      </div>
    </body></html>
  `);
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.chrome = {
    runtime: { getURL(path) { return `chrome-extension://golens/${path}`; } },
  };
  return window;
}

function jsonResponse(body, { nextPage = '' } = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: (name) => (name === 'x-next-page' ? nextPage : null) },
    async json() { return body; },
  };
}

test('celebrates confirmed review milestones and cache completion', async () => {
  const RealDate = globalThis.Date;
  const mondayMorning = new RealDate(2026, 6, 13, 10, 0, 0).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [mondayMorning])); }
    static now() { return mondayMorning; }
  };

  const window = setupWindow();
  let mergeRequestStatus = { state: 'opened', approvers: [] };
  let discussionStatus = { unresolved: 1 };
  let statusRequests = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('/approvals')) {
      statusRequests++;
      return jsonResponse({ state: mergeRequestStatus.state, approved_by: mergeRequestStatus.approvers.map((id) => ({ user: { id } })) });
    }
    if (String(url).includes('/discussions')) {
      return jsonResponse([{ notes: [{ resolvable: true, resolved: discussionStatus.unresolved === 0 }] }]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  };

  const settings = fakeSettingsStore();
  const overlays = fakeOverlayRegistry();
  const handle = mount({ clock: fastClock(), settings, overlays });
  settings.resolveReady();
  await wait(0);

  assert.ok(statusRequests >= 1, 'the initial MR status was not captured');
  assert.equal(window.document.getElementById('golens-celebration-root'), null, 'an existing MR state must not celebrate on load');

  window.document.getElementById('unapprove').click();
  await wait(0);
  assert.equal(window.document.getElementById('golens-celebration-root'), null, 'revoking an approval must not celebrate');

  window.document.getElementById('approve').addEventListener('click', () => {
    mergeRequestStatus = { state: 'opened', approvers: ['7'] };
  });
  window.document.getElementById('approve').querySelector('span').click();
  await wait(50);

  const approvedHost = window.document.getElementById('golens-celebration-root');
  assert.equal(approvedHost?.dataset.celebration, 'approved');
  assert.match(approvedHost.shadowRoot.querySelector('img').src, /assets\/celebrations\/golens-approved\.png$/);
  assert.equal(approvedHost.shadowRoot.querySelector('[role="status"]').textContent, 'Approval confirmed');

  window.document.getElementById('resolve').addEventListener('click', () => {
    discussionStatus = { unresolved: 0 };
  });
  window.document.getElementById('resolve').querySelector('span').click();
  await wait(20);

  const resolvedHost = window.document.getElementById('golens-celebration-root');
  assert.equal(resolvedHost?.dataset.celebration, 'resolved');
  assert.equal(resolvedHost.shadowRoot.querySelector('[role="status"]').textContent, 'All discussions resolved');

  requestMoment('pitstop');
  const pitstopHost = window.document.getElementById('golens-celebration-root');
  assert.equal(pitstopHost?.dataset.celebration, 'pitstop');
  assert.equal(pitstopHost.shadowRoot.querySelector('[role="status"]').textContent, 'Source cache ready');

  window.document.getElementById('merge').addEventListener('click', () => {
    mergeRequestStatus = { state: 'merged', approvers: ['7'] };
  });
  window.document.getElementById('merge').querySelector('span').click();
  await wait(20);

  const mergedHost = window.document.getElementById('golens-celebration-root');
  assert.equal(mergedHost?.dataset.celebration, 'merged');
  assert.equal(mergedHost.shadowRoot.querySelector('[role="status"]').textContent, 'Merge confirmed');

  handle.unmount();
  assert.equal(window.document.getElementById('golens-celebration-root'), null, 'unmount removes an active celebration');
  requestMoment('pitstop');
  assert.equal(window.document.getElementById('golens-celebration-root'), null, 'requestMoment no-ops after unmount');

  globalThis.Date = RealDate;
});

test('queues a mascot moment while an overlay is open, and flushes it on close', async () => {
  setupWindow();
  globalThis.fetch = async (url) => {
    if (String(url).includes('/approvals')) return jsonResponse({ state: 'opened', approved_by: [] });
    if (String(url).includes('/discussions')) return jsonResponse([]);
    throw new Error(`unexpected fetch: ${url}`);
  };
  const settings = fakeSettingsStore();
  const overlays = fakeOverlayRegistry();
  overlays.setOpen(true);
  const handle = mount({ clock: fastClock(), settings, overlays });
  settings.resolveReady();
  await wait(0);

  requestMoment('pitstop');
  assert.equal(document.getElementById('golens-celebration-root'), null, 'a moment must queue while an overlay is open');

  overlays.setOpen(false);
  await wait(0);
  assert.equal(document.getElementById('golens-celebration-root')?.dataset.celebration, 'pitstop');

  handle.unmount();
});

test('uses the Friday beer kart for MR creation, approval, and merge after 16:00', async () => {
  const RealDate = globalThis.Date;
  const fridayAfternoon = new RealDate(2026, 6, 17, 16, 30, 0).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fridayAfternoon])); }
    static now() { return fridayAfternoon; }
  };

  const window = setupWindow({ path: '/group/project/-/merge_requests/new' });
  let mergeRequestStatus = { state: 'opened', approvers: [] };
  globalThis.fetch = async (url) => {
    if (String(url).includes('/approvals')) {
      return jsonResponse({ state: mergeRequestStatus.state, approved_by: mergeRequestStatus.approvers.map((id) => ({ user: { id } })) });
    }
    if (String(url).includes('/discussions')) return jsonResponse([]);
    throw new Error(`unexpected fetch: ${url}`);
  };

  const settings = fakeSettingsStore();
  const overlays = fakeOverlayRegistry();
  mount({ clock: fastClock(), settings, overlays });
  settings.resolveReady();
  await wait(0);

  window.document.getElementById('create').addEventListener('click', (event) => event.preventDefault());
  window.document.getElementById('create').click();
  await wait(0);
  assert.equal(window.document.getElementById('golens-celebration-root'), null, 'creating an MR must not itself celebrate');
  assert.ok(window.sessionStorage.getItem('golensFridayMergeRequestCreation'), 'Friday MR creation was not remembered');

  globalThis.Date = RealDate;
});

test('a fresh mount on the created MR page consumes the remembered Friday creation', async () => {
  const RealDate = globalThis.Date;
  const fridayAfternoon = new RealDate(2026, 6, 17, 16, 30, 0).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...args) { super(...(args.length ? args : [fridayAfternoon])); }
    static now() { return fridayAfternoon; }
  };

  const window = setupWindow({ path: '/group/project/-/merge_requests/43' });
  window.sessionStorage.setItem('golensFridayMergeRequestCreation', JSON.stringify({
    at: Date.now(),
    projectPath: '/group/project',
  }));
  globalThis.fetch = async (url) => {
    if (String(url).includes('/approvals')) return jsonResponse({ state: 'opened', approved_by: [] });
    if (String(url).includes('/discussions')) return jsonResponse([]);
    throw new Error(`unexpected fetch: ${url}`);
  };

  const settings = fakeSettingsStore();
  const overlays = fakeOverlayRegistry();
  mount({ clock: fastClock(), settings, overlays });
  settings.resolveReady();
  await wait(0);

  const host = window.document.getElementById('golens-celebration-root');
  assert.equal(host?.dataset.celebration, 'friday');
  assert.equal(host.shadowRoot.querySelectorAll('.confetti').length, 48);

  globalThis.Date = RealDate;
});

test('does not fetch or react when disabled', async () => {
  setupWindow();
  let fetchCount = 0;
  globalThis.fetch = async (url) => {
    fetchCount++;
    if (String(url).includes('/approvals')) return jsonResponse({ state: 'opened', approved_by: [] });
    return jsonResponse([]);
  };
  const settings = fakeSettingsStore({ enabled: false });
  const overlays = fakeOverlayRegistry();
  mount({ clock: fastClock(), settings, overlays });
  settings.resolveReady();
  await wait(0);

  assert.equal(fetchCount, 0, 'a disabled mount must not fetch status');
  document.getElementById('approve').querySelector('span').click();
  await wait(0);
  assert.equal(document.getElementById('golens-celebration-root'), null);
});
