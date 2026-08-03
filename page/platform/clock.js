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
// go-navigation.js's `debounceIdle` is NOT migrated to this helper: its
// `init()` is synchronous (called fire-and-forget, with tests asserting
// synchronous side effects like attached listeners immediately after), and
// this module can only be reached via `import()`, which is asynchronous.
// Bridging it would mean either changing `init()`'s synchronous contract
// (out of scope) or accepting a startup race where the first debounced
// call could silently no-op before the import resolves — a real, if
// small, behavior change the ticket's "exact timing" requirement rules
// out. See `.scratch/restructure-js-before-ts/issues/08-platform-clock-dedup.md`
// for the resulting partial-completion note.
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
