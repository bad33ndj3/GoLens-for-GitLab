// platform/overlay-registry — hides which module currently has a page-level
// overlay open. Replaces go-navigation.js's direct DOM read of
// content.js-owned `#golens-onboarding-root` / `#golens-settings-root`.
// Contract:
//   createOverlayRegistry() -> { claim(name) -> release, isAnyOpen() -> boolean, subscribe(fn) -> unsubscribe }
//
// State lives at module scope, not inside the returned object, so every
// caller that resolves this same module URL observes the same claims.
// That matters here specifically: content.js (which owns the onboarding
// and settings overlays and claims/releases around opening/closing them)
// and go-navigation.js (which only ever reads `isAnyOpen()`) are two
// separate classic content scripts, each reaching this module through its
// own dynamic `import()`. Both run in the same per-frame isolated world,
// so the module bootstrap resolves both imports to one cached ES module
// instance — no `globalThis` contract needed to share this state, and
// `createOverlayRegistry()` takes no deps because of it: it is inherently
// a page-wide singleton, not a per-caller instance.
//
// `claim`/`release` are counted per name (not a plain set membership), so
// a caller that calls `claim(name)` again before releasing the first claim
// — or calls the same `release` more than once — cannot desync the count.

const counts = new Map(); // name -> open claim count
const listeners = new Set();

function notify() {
  const open = counts.size > 0;
  for (const fn of listeners) {
    try {
      fn(open);
    } catch {
      // A subscriber's own error must not break the others or the caller
      // that triggered the notification.
    }
  }
}

export function createOverlayRegistry() {
  function claim(name) {
    counts.set(name, (counts.get(name) || 0) + 1);
    notify();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = (counts.get(name) || 0) - 1;
      if (next <= 0) counts.delete(name);
      else counts.set(name, next);
      notify();
    };
  }

  function isAnyOpen() {
    return counts.size > 0;
  }

  function subscribe(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  return { claim, isAnyOpen, subscribe };
}
