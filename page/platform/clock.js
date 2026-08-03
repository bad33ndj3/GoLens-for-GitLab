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
