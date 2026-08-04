// page/lifecycle — the imperative shell that wires features. Not a feature
// itself: it hides `enabled`-gating, `chrome.runtime.onMessage` routing, and
// mount/unmount ordering behind one entry point:
//   start({ platform, features }) -> { stop() }
//
// This module used to poll `location.href` itself, but
// `page/lifecycle/mr-session.js`'s reconcile loop now does this job, doing
// it per-navigation without waiting on any poll interval. The old poll here
// was superseded (not merely redundant) and is removed. bootstrap.js's own
// separate `location.href` poll (full module-graph remount scheduling) is a
// different mechanism and is untouched.
import { routeMessage } from './internal.js';

// start({ platform, features, runtime }) -> { stop() }
//
// - `platform`: bag of already-constructed platform services (e.g. `{ clock,
//   settings }`) merged into every feature's `ctx`, plus per-feature
//   `capabilities` (accept dependencies, don't create them). Lifecycle never
//   constructs platform services itself.
// - `features`: array of `{ name, mount(ctx) -> handle, capabilities? }`,
//   mounted in array order; `stop()` unmounts in the reverse order (resource
//   teardown mirrors acquisition).
// - `runtime`: injectable seam for `chrome.runtime`, defaulting to the real
//   global; overridable in tests.
export function start({ platform = {}, features = [], runtime } = {}) {
  const resolvedRuntime = runtime !== undefined ? runtime : globalThis.chrome?.runtime;

  let stopped = false;
  const mounted = [];

  // Mount order: forward, explicit.
  for (const feature of features) {
    const ctx = { ...platform, ...(feature.capabilities || {}) };
    const handle = feature.mount(ctx);
    mounted.push({ name: feature.name, handle });
  }

  function applyEnabled(enabled) {
    for (const { handle } of mounted) handle.setEnabled?.(enabled);
  }

  // `enabled`-gating: lifecycle owns the `enabled` key. Applied once the
  // settings store resolves; guarded against `stop()` racing ahead of `ready()`.
  // Read-only here: lifecycle does not write `enabled` back to storage —
  // content.js still owns that write (legacy behavior).
  let unsubscribeEnabled = null;
  if (platform.settings) {
    platform.settings.ready().then(() => {
      if (stopped) return;
      applyEnabled(platform.settings.get('enabled'));
      unsubscribeEnabled = platform.settings.subscribe('enabled', applyEnabled);
    });
  }

  // dispatch(message) -> the routed feature handle's own return value, or
  // `undefined` when nothing handled it. Exposed on the returned object so a
  // caller that registered its own `chrome.runtime.onMessage` listener
  // *synchronously* can feed messages in (bootstrap.js does exactly this —
  // see the "message seam" comment there). That indirection exists because
  // this module graph is only reachable through an async `import()`: a
  // listener registered in here does not exist yet during the first ~15-30ms
  // after page load, nor during the unmount/mount gap of an SPA re-mount, and
  // every message arriving in those windows was silently lost before this
  // indirection was added.
  function dispatch(message) {
    const route = routeMessage(message);
    if (route.kind === 'lifecycle' && route.action === 'setEnabled') {
      applyEnabled(message.enabled);
      return undefined;
    }
    if (route.kind === 'routed') {
      const target = mounted.find((m) => m.name === route.feature);
      return target?.handle[route.action]?.(message);
    }
    return undefined;
  }

  // Self-registration stays for callers that pass a `runtime` (tests, and any
  // embedding that has no synchronous seam of its own). page/main.js passes
  // `runtime: null` precisely to opt out: bootstrap.js owns the one real
  // registration, so registering here too would dispatch every message twice.
  // The listener never calls `sendResponse` and never returns a value, so it
  // never holds the message channel open.
  let removeMessageListener = null;
  if (resolvedRuntime?.onMessage) {
    const listener = (message) => {
      dispatch(message);
      return undefined;
    };
    resolvedRuntime.onMessage.addListener(listener);
    removeMessageListener = () => resolvedRuntime.onMessage.removeListener(listener);
  }

  // Unmount order: reverse of mount order, explicit.
  function unmountAll() {
    for (let i = mounted.length - 1; i >= 0; i -= 1) {
      mounted[i].handle.unmount();
    }
    mounted.length = 0;
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    removeMessageListener?.();
    unsubscribeEnabled?.();
    unmountAll();
  }

  return { stop, dispatch };
}
