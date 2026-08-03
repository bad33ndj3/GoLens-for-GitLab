import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClock } from '../page/platform/clock.js';

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
