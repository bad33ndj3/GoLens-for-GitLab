import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { mount } from '../page/features/settings-overlay.js';

function fakeOverlayRegistry() {
  const counts = new Map();
  return {
    claim(name) {
      counts.set(name, (counts.get(name) || 0) + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const next = (counts.get(name) || 0) - 1;
        if (next <= 0) counts.delete(name); else counts.set(name, next);
      };
    },
    isAnyOpen() {
      return counts.size > 0;
    },
    claimCountFor(name) {
      return counts.get(name) || 0;
    },
  };
}

function fakeRuntime() {
  const listeners = new Set();
  return {
    getURL: (path) => `chrome-extension://golens/${path}`,
    onMessage: {
      addListener(fn) { listeners.add(fn); },
      removeListener(fn) { listeners.delete(fn); },
    },
    emit(message) {
      for (const fn of [...listeners]) fn(message);
    },
    listenerCount: () => listeners.size,
  };
}

function buildFixture(pathname = '/group/project/-/merge_requests/42/diffs') {
  const window = new Window({ url: `https://gitlab.example${pathname}` });
  window.document.write(`
    <!doctype html>
    <html><head><meta name="csrf-token" content="fixture"></head><body>
      <div class="layout-page is-merge-request"></div>
    </body></html>
  `);
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  return window;
}

test('show() mounts the overlay host with the settings iframe and claims the registry', () => {
  buildFixture();
  const overlays = fakeOverlayRegistry();
  const runtime = fakeRuntime();
  const handle = mount({ overlays, runtime });

  handle.show();

  const host = document.getElementById('golens-settings-root');
  assert.ok(host, 'settings host was not mounted');
  const frame = host.shadowRoot.querySelector('iframe');
  assert.equal(frame.title, 'GoLens settings');
  assert.match(frame.src, /settings\.html$/);
  const dialog = host.shadowRoot.querySelector('[role="dialog"]');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.equal(overlays.claimCountFor('settings-overlay'), 1);
  assert.equal(overlays.isAnyOpen(), true);

  handle.unmount();
});

test('show() called while already open focuses the existing iframe instead of claiming again', () => {
  buildFixture();
  const overlays = fakeOverlayRegistry();
  const handle = mount({ overlays, runtime: fakeRuntime() });

  handle.show();
  const frame = document.getElementById('golens-settings-root').shadowRoot.querySelector('iframe');
  let focused = false;
  frame.focus = () => { focused = true; };
  handle.show();

  assert.equal(focused, true);
  assert.equal(overlays.claimCountFor('settings-overlay'), 1, 'a second show() must not claim again');

  handle.unmount();
});

test('show() is a no-op off a GitLab page', () => {
  const window = new Window({ url: 'https://example.com/' });
  window.document.write('<!doctype html><html><body></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  const overlays = fakeOverlayRegistry();
  const handle = mount({ overlays, runtime: fakeRuntime() });

  handle.show();

  assert.equal(document.getElementById('golens-settings-root'), null);
  assert.equal(overlays.isAnyOpen(), false);

  handle.unmount();
});

test('clicking the backdrop closes the overlay and releases the claim', () => {
  buildFixture();
  const overlays = fakeOverlayRegistry();
  const handle = mount({ overlays, runtime: fakeRuntime() });
  handle.show();
  const backdrop = document.getElementById('golens-settings-root').shadowRoot.querySelector('[data-action="close-settings-backdrop"]');

  backdrop.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  assert.equal(document.getElementById('golens-settings-root'), null);
  assert.equal(overlays.isAnyOpen(), false);

  handle.unmount();
});

test('close() restores focus by default and skips it when told not to', () => {
  buildFixture();
  const overlays = fakeOverlayRegistry();
  const handle = mount({ overlays, runtime: fakeRuntime() });
  const trigger = document.createElement('button');
  const other = document.createElement('button');
  document.body.append(trigger, other);
  trigger.focus();

  handle.show();
  handle.close();
  assert.equal(document.activeElement, trigger, 'close() must restore focus by default');

  other.focus();
  handle.show();
  handle.close({ restoreFocus: false });
  assert.equal(document.activeElement, other, 'close({ restoreFocus: false }) must not refocus the opener');

  handle.unmount();
});

test('ready() marks the host as ready and reports whether the overlay is open', () => {
  buildFixture();
  const handle = mount({ overlays: fakeOverlayRegistry(), runtime: fakeRuntime() });

  assert.deepEqual(handle.ready(), { kind: 'not-open' }, 'ready() before show() reports not open');

  handle.show();
  assert.deepEqual(handle.ready(), { kind: 'ready' });
  assert.equal(document.getElementById('golens-settings-root').dataset.ready, 'true');

  handle.unmount();
});

// Ticket 16: bootstrap.js turns these outcomes into the response popup.js and
// settings.js read, and popup.js shows the user the error text on `!ok`. A
// silent early return here is what made the first attempt's ack lie.
test('show()/close() report kind-discriminated outcomes, never a silent return', () => {
  buildFixture();
  const handle = mount({ overlays: fakeOverlayRegistry(), runtime: fakeRuntime() });

  assert.deepEqual(handle.close(), { kind: 'not-open' }, 'closing what is not open says so');
  assert.deepEqual(handle.show(), { kind: 'shown' });
  assert.deepEqual(handle.show(), { kind: 'already-open' }, 'a second show is not a new overlay');
  assert.deepEqual(handle.close(), { kind: 'closed' });

  handle.unmount();
});

test('show() on a non-GitLab page reports not-gitlab instead of opening', () => {
  const window = new Window({ url: 'https://example.com/whatever' });
  window.document.write('<!doctype html><html><head></head><body></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;

  const handle = mount({ overlays: fakeOverlayRegistry(), runtime: fakeRuntime() });
  assert.deepEqual(handle.show(), { kind: 'not-gitlab' });
  assert.equal(window.document.getElementById('golens-settings-root'), null);

  handle.unmount();
});

test('a golens-show-onboarding runtime message closes settings on a GitLab MR page', () => {
  buildFixture('/group/project/-/merge_requests/7');
  const overlays = fakeOverlayRegistry();
  const runtime = fakeRuntime();
  const handle = mount({ overlays, runtime });
  handle.show();
  assert.ok(document.getElementById('golens-settings-root'));

  runtime.emit({ type: 'golens-show-onboarding' });

  assert.equal(document.getElementById('golens-settings-root'), null);
  assert.equal(overlays.isAnyOpen(), false);

  handle.unmount();
});

test('a golens-show-onboarding runtime message leaves settings open off a merge-request page', () => {
  buildFixture('/group/project/-/issues');
  const overlays = fakeOverlayRegistry();
  const runtime = fakeRuntime();
  const handle = mount({ overlays, runtime });
  handle.show();

  runtime.emit({ type: 'golens-show-onboarding' });

  assert.ok(document.getElementById('golens-settings-root'), 'settings must stay open when onboarding would refuse to show');

  handle.unmount();
});

test('unmount() closes the overlay, releases the claim, removes the runtime listener, and is idempotent', () => {
  buildFixture();
  const overlays = fakeOverlayRegistry();
  const runtime = fakeRuntime();
  const handle = mount({ overlays, runtime });
  handle.show();
  assert.equal(runtime.listenerCount(), 1);

  handle.unmount();

  assert.equal(document.getElementById('golens-settings-root'), null);
  assert.equal(overlays.isAnyOpen(), false);
  assert.equal(runtime.listenerCount(), 0);
  assert.doesNotThrow(() => handle.unmount());

  runtime.emit({ type: 'golens-show-onboarding' });
});

test('mount-after-unmount is safe: a second mount() re-establishes the overlay from scratch', () => {
  buildFixture();
  const overlaysA = fakeOverlayRegistry();
  const handleA = mount({ overlays: overlaysA, runtime: fakeRuntime() });
  handleA.show();
  handleA.unmount();

  const overlaysB = fakeOverlayRegistry();
  const handleB = mount({ overlays: overlaysB, runtime: fakeRuntime() });
  handleB.show();

  assert.ok(document.getElementById('golens-settings-root'));
  assert.equal(overlaysB.claimCountFor('settings-overlay'), 1);

  handleB.unmount();
});
