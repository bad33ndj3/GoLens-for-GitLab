import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock, createLegacyDebounceIdle } from '../page/platform/clock.js';

// Deterministic control over global timers/idle callback so debounce
// behavior can be asserted without sleeping.
function withFakeTimers(run) {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  const realRequestIdleCallback = globalThis.requestIdleCallback;

  let nextId = 1;
  const timeoutCallbacks = new Map();
  globalThis.setTimeout = (fn) => {
    const id = nextId++;
    timeoutCallbacks.set(id, fn);
    return id;
  };
  globalThis.clearTimeout = (id) => {
    timeoutCallbacks.delete(id);
  };
  let idleCallback = null;
  globalThis.requestIdleCallback = (fn) => {
    idleCallback = fn;
    return 1;
  };

  const fireOnlyTimeout = () => {
    const [id, fn] = [...timeoutCallbacks.entries()][0];
    timeoutCallbacks.delete(id);
    fn();
  };
  const fireIdle = () => {
    const fn = idleCallback;
    idleCallback = null;
    fn();
  };

  try {
    return run({
      pendingTimeoutCount: () => timeoutCallbacks.size,
      fireOnlyTimeout,
      idleScheduled: () => idleCallback !== null,
      fireIdle,
    });
  } finally {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    if (realRequestIdleCallback === undefined) delete globalThis.requestIdleCallback;
    else globalThis.requestIdleCallback = realRequestIdleCallback;
  }
}

test('now() returns the current time', () => {
  const clock = createClock();
  const before = Date.now();
  const value = clock.now();
  const after = Date.now();
  assert.ok(value >= before && value <= after, 'now() should reflect the current wall clock');
});

test('setTimeout(fn, ms) schedules fn and returns a cancel function', () => {
  withFakeTimers(({ pendingTimeoutCount, fireOnlyTimeout }) => {
    const clock = createClock();
    let called = false;
    const cancel = clock.setTimeout(() => { called = true; }, 50);
    assert.equal(pendingTimeoutCount(), 1, 'expected a timer to be scheduled');
    assert.equal(typeof cancel, 'function', 'setTimeout must return a cancel function');
    fireOnlyTimeout();
    assert.equal(called, true, 'the scheduled callback should run when the timer fires');
  });
});

test('setTimeout cancel() prevents the callback from running, and is idempotent', () => {
  withFakeTimers(() => {
    const clock = createClock();
    let called = false;
    const cancel = clock.setTimeout(() => { called = true; }, 50);
    cancel();
    cancel(); // must not throw or double-clear
    assert.equal(called, false, 'cancelled timers must not fire');
  });
});

test('debounceIdle(fn, opts) collapses a burst into a single idle-deferred call', () => {
  withFakeTimers(({ pendingTimeoutCount, fireOnlyTimeout, idleScheduled, fireIdle }) => {
    const clock = createClock();
    const calls = [];
    const debounced = clock.debounceIdle((...args) => calls.push(args), { delayMs: 20 });

    debounced('a');
    debounced('b');
    debounced('c');

    assert.equal(pendingTimeoutCount(), 1, 'a burst of calls should settle onto a single pending timer');
    assert.equal(idleScheduled(), false, 'no idle callback should be scheduled before the debounce window elapses');
    assert.equal(calls.length, 0, 'fn must not run before the debounce settles');

    fireOnlyTimeout();
    assert.equal(idleScheduled(), true, 'the settled debounce should defer through requestIdleCallback');
    assert.equal(calls.length, 0, 'fn must not run until the idle callback fires');

    fireIdle();
    assert.deepEqual(calls, [['c']], 'only the last call in the burst should run, exactly once');
  });
});

test('debounceIdle(...).cancel() prevents a pending call from running', () => {
  withFakeTimers(({ pendingTimeoutCount, fireOnlyTimeout, idleScheduled }) => {
    const clock = createClock();
    const calls = [];
    const debounced = clock.debounceIdle((...args) => calls.push(args), { delayMs: 20 });

    debounced('x');
    debounced.cancel();
    assert.equal(pendingTimeoutCount(), 0, 'cancel() should clear the pending timer');

    // Calling again afterwards still works normally.
    debounced('y');
    assert.equal(pendingTimeoutCount(), 1);
    fireOnlyTimeout();
    assert.equal(idleScheduled(), true);
  });
});

// createLegacyDebounceIdle(getClock) is the ticket-08 bridge for
// go-navigation.js/content.js's own (test-swappable) `clock` object, which
// has a different shape than createClock()'s instance above: raw
// setTimeout/clearTimeout ids, no `now`. Its whole reason to exist is that
// it re-reads `getClock()` on every invocation rather than binding to one
// clock at creation time — a debounced function created against one clock
// must still observe a later swap to a different clock (this is exactly
// what content.js's `setClock()` relies on: it's called *after*
// `schedulePageReconcile` already exists).
function fakeLegacyClock() {
  let nextId = 1;
  const timeoutCallbacks = new Map();
  let idleCallback = null;
  return {
    clock: {
      setTimeout: (fn) => { const id = nextId++; timeoutCallbacks.set(id, fn); return id; },
      clearTimeout: (id) => { timeoutCallbacks.delete(id); },
      requestIdle: (fn) => { idleCallback = fn; return nextId++; },
    },
    pendingTimeoutCount: () => timeoutCallbacks.size,
    fireOnlyTimeout: () => {
      const [id, fn] = [...timeoutCallbacks.entries()][0];
      timeoutCallbacks.delete(id);
      fn();
    },
    idleScheduled: () => idleCallback !== null,
    fireIdle: () => {
      const fn = idleCallback;
      idleCallback = null;
      fn();
    },
  };
}

test('createLegacyDebounceIdle: debounces through the injected clock, same shape as go-navigation/content.js', () => {
  const legacy = fakeLegacyClock();
  const debounceIdle = createLegacyDebounceIdle(() => legacy.clock);
  const calls = [];
  const debounced = debounceIdle((...args) => calls.push(args), 20);

  debounced('a');
  debounced('b');
  assert.equal(legacy.pendingTimeoutCount(), 1, 'a burst settles onto one pending timer');

  legacy.fireOnlyTimeout();
  assert.equal(legacy.idleScheduled(), true, 'the settled debounce defers through requestIdle');
  assert.equal(calls.length, 0);

  legacy.fireIdle();
  assert.deepEqual(calls, [['b']], 'only the last call in the burst runs');
});

test('createLegacyDebounceIdle: a debounced function re-reads getClock() on every call, so a later clock swap is observed', () => {
  const clockA = fakeLegacyClock();
  const clockB = fakeLegacyClock();
  let current = clockA.clock;
  const debounceIdle = createLegacyDebounceIdle(() => current);
  const calls = [];
  // Created while clockA is current — mirrors content.js creating
  // `schedulePageReconcile` at init() time, before any test calls setClock().
  const debounced = debounceIdle((...args) => calls.push(args), 10);

  // Swap the clock out from under the already-created debounced function.
  current = clockB.clock;

  debounced('x');
  assert.equal(clockA.pendingTimeoutCount(), 0, 'the old clock never sees a call made after the swap');
  assert.equal(clockB.pendingTimeoutCount(), 1, 'the new clock is used instead, without recreating the debounced function');

  clockB.fireOnlyTimeout();
  clockB.fireIdle();
  assert.deepEqual(calls, [['x']]);
});
