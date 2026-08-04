// bootstrap.js is a classic content script, so its chrome.runtime.onMessage
// listener exists from the moment the script runs; the module graph behind it
// only exists after an async import(). These tests ensure that messages
// arriving before (or during) a mount are not dropped, and the response
// reflects what the feature actually did.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { routeMessage } from '../page/lifecycle/internal.js';

const source = await readFile(new URL('../bootstrap.js', import.meta.url), 'utf8');

// Loads bootstrap.js into a fresh happy-dom world with a controllable
// `import()` of page/main.js. Returns the seam: a way to send a message, and a
// way to let the mount finish, so a test can order the two deliberately.
function loadBootstrap({ mountResult, failImport = false } = {}) {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.write('<!doctype html><html><head></head><body></body></html>');

  const listeners = [];
  let resolveImport;
  const importGate = new Promise((resolve) => { resolveImport = resolve; });
  const dispatched = [];
  const handle = {
    dispatch(message) {
      dispatched.push(message.type);
      return mountResult ? mountResult(message) : undefined;
    },
    unmount() {},
  };

  const scope = {
    window,
    document: window.document,
    location: window.location,
    setInterval() { return 0; },
    chrome: {
      runtime: {
        getURL: (path) => `chrome-extension://golens/${path}`,
        onMessage: { addListener: (fn) => listeners.push(fn) },
      },
    },
    // The seam: bootstrap.js's `import(...)` is rewritten to this, so the test
    // decides when — and whether — the module graph becomes available.
    __import: async () => {
      await importGate;
      if (failImport) throw new Error('import blew up');
      return { mount: () => handle };
    },
    globalThis: undefined,
  };
  scope.globalThis = scope;

  const rewritten = source.replace('await import(chrome.runtime.getURL(\'page/main.js\'))', 'await __import()');
  assert.notEqual(rewritten, source, 'the import seam in bootstrap.js moved; update this harness');

  const names = Object.keys(scope);
  // eslint-disable-next-line no-new-func
  new Function(...names, rewritten)(...names.map((name) => scope[name]));

  function send(type) {
    let response;
    let responded = false;
    const returned = listeners[0]({ type }, {}, (value) => { response = value; responded = true; });
    return { returned, get response() { return response; }, get responded() { return responded; } };
  }

  return { send, dispatched, finishMount: resolveImport, scope, window };
}

test('bootstrap answers the settings and onboarding messages, and only those', () => {
  const { scope } = loadBootstrap();
  const { RESPONDED_TYPES } = scope.globalThis.GoLensBootstrap.__test;

  // Every claimed type must be a real route to a feature page/main.js mounts.
  // Claiming a type a legacy file already answered synchronously would put
  // two responders on one message (legacy files are deleted, so this is now
  // the only responder for any of these).
  const answerableFeatures = ['settings-overlay', 'onboarding', 'controls'];
  for (const type of RESPONDED_TYPES) {
    const route = routeMessage({ type });
    assert.equal(route.kind, 'routed', `${type} is answered by bootstrap but routes nowhere`);
    assert.ok(
      answerableFeatures.includes(route.feature),
      `${type} routes to ${route.feature}, which bootstrap does not answer for`,
    );
  }
  assert.deepEqual(
    [...RESPONDED_TYPES].sort(),
    [
      'golens-cache-invalidated',
      'golens-close-settings',
      'golens-full-project-status',
      'golens-preload-full-project',
      'golens-settings-ready',
      'golens-show-onboarding',
      'golens-show-settings',
    ],
  );
});

test('a message arriving before the module graph has mounted is answered, not dropped', async () => {
  const { send, dispatched, finishMount } = loadBootstrap({ mountResult: () => ({ kind: 'shown' }) });

  // This is the exact production sequence that failed the browser smoke: the
  // popup click lands while bootstrap's import() is still in flight.
  const call = send('golens-show-settings');
  assert.equal(call.returned, true, 'must keep the message channel open while the mount is in flight');
  assert.equal(call.responded, false, 'nothing to answer with yet');
  assert.deepEqual(dispatched, [], 'no handle exists yet');

  finishMount();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.deepEqual(dispatched, ['golens-show-settings'], 'the held message must reach the feature once mounted');
  assert.deepEqual(call.response, { ok: true, result: { shown: true } });
});

test('the response reports what the feature actually did, not that it was asked', async () => {
  const { send, finishMount } = loadBootstrap({ mountResult: () => ({ kind: 'not-gitlab' }) });
  const call = send('golens-show-settings');
  finishMount();
  await new Promise((resolve) => setTimeout(resolve, 0));

  // popup.js's activeTabRequest throws on !ok and shows this text to the user.
  assert.deepEqual(call.response, { ok: false, error: 'Open a supported GitLab page first.' });
});

test('a failed module import is reported as a failure rather than a silent success', async () => {
  const { send, finishMount } = loadBootstrap({ failImport: true });
  const call = send('golens-show-settings');
  finishMount();
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(call.response.ok, false);
  assert.match(call.response.error, /could not load/i);
});

test('golens-settings-ready mirrors content.js\'s old ok: Boolean(host) envelope', async () => {
  const open = loadBootstrap({ mountResult: () => ({ kind: 'ready' }) });
  const openCall = open.send('golens-settings-ready');
  open.finishMount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(openCall.response, { ok: true, result: { ready: true } });

  const shut = loadBootstrap({ mountResult: () => ({ kind: 'not-open' }) });
  const shutCall = shut.send('golens-settings-ready');
  shut.finishMount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(shutCall.response, { ok: false, result: { ready: false } });
});

test('golens-show-onboarding mirrors content.js\'s old ok/error envelope', async () => {
  const shown = loadBootstrap({ mountResult: () => ({ kind: 'shown' }) });
  const shownCall = shown.send('golens-show-onboarding');
  shown.finishMount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(shownCall.response, { ok: true, result: { shown: true } });

  const already = loadBootstrap({ mountResult: () => ({ kind: 'already-open' }) });
  const alreadyCall = already.send('golens-show-onboarding');
  already.finishMount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(alreadyCall.response, { ok: true, result: { shown: true } });

  const refused = loadBootstrap({ mountResult: () => ({ kind: 'not-gitlab' }) });
  const refusedCall = refused.send('golens-show-onboarding');
  refused.finishMount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(refusedCall.response, { ok: false, error: 'Open a GitLab merge request first.' });
});

test('messages bootstrap does not answer still reach the module graph', async () => {
  const { send, dispatched, finishMount } = loadBootstrap();
  const call = send('golens-enabled');
  assert.notEqual(call.returned, true, 'must not hold a channel open for a message it will not answer');

  finishMount();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(dispatched, ['golens-enabled']);
});
