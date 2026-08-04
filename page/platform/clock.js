// platform/clock — the one test seam for time. Hides timer scheduling
// (setTimeout/clearTimeout/requestIdleCallback) behind a small factory so
// features never touch globals directly. Per ticket 04 §2:
//   createClock() -> { now(), setTimeout(fn, ms) -> cancel, debounceIdle(fn, opts) -> debounced }

export function createClock() {
  function now() {
    return Date.now();
  }

  function setTimeout(fn, ms) {
    const id = globalThis.setTimeout(fn, ms);
    let cancelled = false;
    return () => {
      if (cancelled) return;
      cancelled = true;
      globalThis.clearTimeout(id);
    };
  }

  function requestIdle(fn, idleTimeoutMs) {
    if (globalThis.requestIdleCallback) {
      return globalThis.requestIdleCallback(fn, { timeout: idleTimeoutMs });
    }
    return globalThis.setTimeout(fn, 0);
  }

  // Debounces `fn` by `opts.delayMs` of quiet time, then runs it through
  // `requestIdleCallback` (falling back to an immediate call when the
  // environment doesn't support it) so a burst of callers doesn't compete
  // with rendering. Returns the debounced function with a `.cancel()`.
  function debounceIdle(fn, opts = {}) {
    const delayMs = opts.delayMs ?? 0;
    const idleTimeoutMs = opts.idleTimeoutMs ?? 300;
    let cancelPending = null;
    const debounced = (...args) => {
      if (cancelPending) cancelPending();
      cancelPending = setTimeout(() => {
        cancelPending = null;
        requestIdle(() => fn(...args), idleTimeoutMs);
      }, delayMs);
    };
    debounced.cancel = () => {
      if (cancelPending) cancelPending();
      cancelPending = null;
    };
    return debounced;
  }

  return { now, setTimeout, debounceIdle };
}

// --- Legacy bridge (ticket 08) --------------------------------------------
//
// Ticket 22 update: both `go-navigation.js` and `content.js`, described
// throughout this section in the past tense, are deleted.
// `createLegacyDebounceIdle` survives unchanged — `page/lifecycle/
// mr-session.js` is its only caller now, using it exactly the way
// content.js's `schedulePageReconcile` did (a real, synchronously-resolved
// import, no dynamic-`import()` bridge needed any more since mr-session.js
// is a real ES module).
//
// go-navigation.js and content.js are classic (non-module) content scripts,
// each with its own local, test-swappable `clock` object (`defaultClock()`
// / `setClock()`), not an instance from `createClock()` above. Their
// `debounceIdle(fn, delayMs)` bodies were byte-identical duplicates of each
// other — that duplicate algorithm is what this ticket centralizes.
//
// It deliberately does NOT reuse `createClock()`'s `debounceIdle` above,
// because the two interfaces are incompatible in a way ticket 04 §2 didn't
// anticipate:
//   - `createClock().setTimeout` returns a *cancel closure*; the legacy
//     `clock.setTimeout` returns a raw timer id consumed by a separate
//     `clock.clearTimeout(id)` — swapping one shape for the other would
//     change what test doubles receive.
//   - Legacy callers (e.g. `content-reconcile-debounce.test.js`) create the
//     debounced function once, then swap the whole `clock` object *after*
//     via `setClock()` and expect the already-created debounced function to
//     observe the swap on its next call. `createClock()`'s `debounceIdle`
//     binds to one fixed instance at creation and cannot do this.
// `createLegacyDebounceIdle(getClock)` reproduces the exact legacy
// algorithm but re-reads `getClock()` on every invocation (not just at
// creation), so a legacy file's mutable `clock` variable can still be
// swapped out from under an already-created debounced function, exactly as
// the two duplicated copies did.
//
// go-navigation.js is now also migrated onto this helper, via the same
// dynamic-`import()` bridge as content.js above. Its `init()` still has to
// stay synchronous (called fire-and-forget, with tests asserting
// synchronous side effects like attached listeners immediately after), so
// it can't simply `await` this module the way content.js's `init()` does.
// Instead it starts the import at IIFE-evaluation time (before `init()`
// ever runs) and installs a queue-until-ready placeholder in place of the
// debounced function: calls before the import resolves just set a pending
// flag, and once ready the real `createLegacyDebounceIdle(...)`-made
// function is installed and fired at most once to cover whatever was
// queued — a burst before ready collapses into exactly one call after
// ready, same as what the debounce itself already does for a burst after
// ready. This avoids both changing `init()`'s synchronous contract and the
// "first call silently no-ops before the import resolves" race a naive
// bridge would introduce. See
// `.scratch/restructure-js-before-ts/issues/08-platform-clock-dedup.md`
// and the `scheduleDiffReconciliation` bridge in go-navigation.js's
// `init()` for the implementation.
export function createLegacyDebounceIdle(getClock) {
  return function debounceIdle(fn, delayMs) {
    let timer = null;
    const debounced = (...args) => {
      const clock = getClock();
      if (timer !== null) clock.clearTimeout(timer);
      timer = clock.setTimeout(() => {
        timer = null;
        clock.requestIdle(() => fn(...args));
      }, delayMs);
    };
    debounced.cancel = () => {
      const clock = getClock();
      if (timer !== null) clock.clearTimeout(timer);
      timer = null;
    };
    return debounced;
  };
}
