import assert from 'node:assert/strict';
import { test } from 'node:test';
import { start } from '../page/lifecycle/index.js';

function fakeClock() {
  const scheduled = [];
  return {
    scheduled,
    setTimeout(fn, ms) {
      const entry = { fn, ms, cancelled: false };
      scheduled.push(entry);
      return () => { entry.cancelled = true; };
    },
    // Fires the most recently scheduled, non-cancelled timer (the poll loop
    // reschedules itself each time it fires).
    fireLatest() {
      for (let i = scheduled.length - 1; i >= 0; i -= 1) {
        if (!scheduled[i].cancelled) {
          scheduled[i].cancelled = true; // consumed: firing is a one-shot, like a real timer
          scheduled[i].fn();
          return;
        }
      }
    },
    pendingCount() {
      return scheduled.filter((entry) => !entry.cancelled).length;
    },
  };
}

function fakeRuntime() {
  const listeners = [];
  return {
    onMessage: {
      addListener(fn) { listeners.push(fn); },
      removeListener(fn) {
        const i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      },
    },
    listenerCount: () => listeners.length,
    dispatch(message) {
      const results = listeners.map((fn) => fn(message));
      return results;
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
    get(key) { return values[key]; },
    ready() { return readyPromise; },
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

function fakeFeature(name) {
  const calls = [];
  let unmountCalled = false;
  return {
    name,
    calls,
    unmountCalled: () => unmountCalled,
    mount(ctx) {
      calls.push({ event: 'mount', ctx });
      return {
        unmount() { unmountCalled = true; calls.push({ event: 'unmount' }); },
        setEnabled(value) { calls.push({ event: 'setEnabled', value }); },
        invalidateCache() { calls.push({ event: 'invalidateCache' }); },
      };
    },
  };
}

test('start({platform, features}) mounts features in order and stop() unmounts in reverse order', () => {
  const order = [];
  const featureA = { name: 'a', mount: () => { order.push('mount a'); return { unmount: () => order.push('unmount a') }; } };
  const featureB = { name: 'b', mount: () => { order.push('mount b'); return { unmount: () => order.push('unmount b') }; } };

  const lifecycle = start({ platform: {}, features: [featureA, featureB], runtime: null, location: null });
  assert.deepEqual(order, ['mount a', 'mount b'], 'features mount in array order');

  lifecycle.stop();
  assert.deepEqual(order, ['mount a', 'mount b', 'unmount b', 'unmount a'], 'stop() unmounts in reverse order');
});

test('stop() is idempotent and safe to call before any async gating resolves', () => {
  const feature = fakeFeature('a');
  const settings = fakeSettingsStore();
  const lifecycle = start({ platform: { settings }, features: [feature], runtime: null, location: null });
  lifecycle.stop();
  assert.doesNotThrow(() => lifecycle.stop());
  assert.equal(feature.unmountCalled(), true);
});

test('each feature ctx is platform merged with that feature\'s own capabilities, not another feature\'s', () => {
  const platform = { clock: 'the-clock' };
  const seen = {};
  const featureA = { name: 'a', capabilities: { onlyA: 1 }, mount: (ctx) => { seen.a = ctx; return { unmount() {} }; } };
  const featureB = { name: 'b', mount: (ctx) => { seen.b = ctx; return { unmount() {} }; } };
  start({ platform, features: [featureA, featureB], runtime: null, location: null });
  assert.deepEqual(seen.a, { clock: 'the-clock', onlyA: 1 });
  assert.deepEqual(seen.b, { clock: 'the-clock' });
});

test('enabled-gating: mounted features receive setEnabled once settings.ready() resolves, then on later changes', async () => {
  const feature = fakeFeature('a');
  const settings = fakeSettingsStore({ enabled: true });
  start({ platform: { settings }, features: [feature], runtime: null, location: null });

  assert.deepEqual(feature.calls.filter((c) => c.event === 'setEnabled'), [], 'no gating applied before ready() resolves');
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(feature.calls.filter((c) => c.event === 'setEnabled'), [{ event: 'setEnabled', value: true }]);

  settings.fireChange('enabled', false);
  assert.deepEqual(
    feature.calls.filter((c) => c.event === 'setEnabled'),
    [{ event: 'setEnabled', value: true }, { event: 'setEnabled', value: false }],
  );
});

test('enabled-gating stops propagating after stop(), even if settings.ready() resolves later', async () => {
  const feature = fakeFeature('a');
  const settings = fakeSettingsStore({ enabled: true });
  const lifecycle = start({ platform: { settings }, features: [feature], runtime: null, location: null });
  lifecycle.stop();
  settings.resolveReady();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(feature.calls.filter((c) => c.event === 'setEnabled'), [], 'stop() before ready() must suppress gating');
});

test('chrome.runtime.onMessage dispatch: golens-enabled routes to lifecycle, not a feature handle', () => {
  const feature = fakeFeature('mr-preload');
  const runtime = fakeRuntime();
  start({ platform: {}, features: [feature], runtime, location: null });
  const results = runtime.dispatch({ type: 'golens-enabled', enabled: false });
  assert.deepEqual(results, [undefined], 'the listener must never return a value (no sendResponse/no held channel)');
  assert.deepEqual(feature.calls.filter((c) => c.event === 'setEnabled'), [{ event: 'setEnabled', value: false }]);
});

test('chrome.runtime.onMessage dispatch: routed messages call the mounted feature\'s handle method', () => {
  const feature = fakeFeature('mr-preload');
  const runtime = fakeRuntime();
  start({ platform: {}, features: [feature], runtime, location: null });
  runtime.dispatch({ type: 'golens-cache-invalidated' });
  assert.deepEqual(feature.calls.filter((c) => c.event === 'invalidateCache'), [{ event: 'invalidateCache' }]);
});

test('chrome.runtime.onMessage dispatch: unrouted/unknown messages are ignored (never sendResponse, never true)', () => {
  const feature = fakeFeature('mr-preload');
  const runtime = fakeRuntime();
  start({ platform: {}, features: [feature], runtime, location: null });
  const results = runtime.dispatch({ type: 'some-other-extension-message' });
  assert.deepEqual(results, [undefined]);
  assert.deepEqual(feature.calls.filter((c) => c.event !== 'mount'), []);
});

test('chrome.runtime.onMessage dispatch: routed message with no mounted feature by that name is a safe no-op', () => {
  const runtime = fakeRuntime();
  start({ platform: {}, features: [], runtime, location: null });
  assert.doesNotThrow(() => runtime.dispatch({ type: 'golens-show-onboarding' }));
});

test('stop() removes the chrome.runtime.onMessage listener', () => {
  const runtime = fakeRuntime();
  const lifecycle = start({ platform: {}, features: [], runtime, location: null });
  assert.equal(runtime.listenerCount(), 1);
  lifecycle.stop();
  assert.equal(runtime.listenerCount(), 0);
});

test('SPA detection: polls location.href via the injected clock and classifies transitions', () => {
  const clock = fakeClock();
  const location = { href: 'https://gitlab.com/a' };
  const lifecycle = start({ platform: { clock }, features: [], runtime: null, location });

  assert.equal(clock.pendingCount(), 1, 'a poll timer should be scheduled at start');
  clock.fireLatest();
  assert.equal(clock.pendingCount(), 1, 'the poll reschedules itself when nothing changed');

  location.href = 'https://gitlab.com/b';
  assert.doesNotThrow(() => clock.fireLatest());

  lifecycle.stop();
  assert.equal(clock.pendingCount(), 0, 'stop() cancels the pending poll');
});

test('SPA detection does not run when no clock or no location is provided', () => {
  assert.doesNotThrow(() => start({ platform: {}, features: [], runtime: null, location: null }));
  assert.doesNotThrow(() => start({ platform: { clock: fakeClock() }, features: [], runtime: null, location: null }));
});
