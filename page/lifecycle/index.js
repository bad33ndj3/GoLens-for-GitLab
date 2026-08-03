// page/lifecycle — the imperative shell that wires features (ticket 03 §2,
// interface ticket 04 §3). Not a feature itself: it hides page-transition
// detection, `enabled`-gating, `chrome.runtime.onMessage` routing, and
// mount/unmount ordering behind one entry point:
//   start({ platform, features }) -> { stop() }
//
// Coexistence with the legacy path (ticket 11): as long as features aren't
// migrated (07-22 land later), `features` is an empty/minimal array here and
// everything else keeps flowing through content.js/go-navigation.js
// unchanged. This module does not import or alter either legacy file.
//
// Transitional double SPA-observation (documented deviation, see ticket 11's
// file for the same note): bootstrap.js (ticket 05) already polls
// `location.href` to remount the whole `page/main.js` module graph on
// navigation (verified in ticket 04 §7's prototype). This module *also*
// polls `location.href`, independently, because ticket 04 §7 assigns that
// observation to lifecycle itself ("lifecycle must poll/observe
// location.href"), for a different purpose: reconciling the *mounted feature
// set* on in-page navigation without a full module remount, once features
// exist to reconcile. Today `features` is empty, so this poll is inert (it
// only tracks `lastUrl`) and the two observers do not conflict. Left as-is
// rather than removing bootstrap's poll, since that poll is ticket 05's
// verified, tested behavior and the (currently unrunnable) browser-smoke
// coverage keys off it.
import { classifyPageTransition, routeMessage } from './internal.js';

const NAV_POLL_MS = 200;

// start({ platform, features, runtime, location }) -> { stop() }
//
// - `platform`: bag of already-constructed platform services (e.g. `{ clock,
//   settings }`) merged into every feature's `ctx`, plus per-feature
//   `capabilities` (ticket 04 §1's "accept dependencies, don't create them").
//   Lifecycle never constructs platform services itself.
// - `features`: array of `{ name, mount(ctx) -> handle, capabilities? }`,
//   mounted in array order; `stop()` unmounts in the reverse order (resource
//   teardown mirrors acquisition).
// - `runtime`/`location`: injectable seams for `chrome.runtime` and the page
//   `location`, defaulting to the real globals; overridable in tests.
export function start({ platform = {}, features = [], runtime, location: loc } = {}) {
  const resolvedRuntime = runtime !== undefined ? runtime : globalThis.chrome?.runtime;
  const resolvedLocation = loc !== undefined ? loc : (typeof location !== 'undefined' ? location : undefined);

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

  // `enabled`-gating: lifecycle owns the `enabled` key (ticket 03 §5).
  // Applied once the settings store resolves; guarded against `stop()`
  // racing ahead of `ready()`. Read-only here: lifecycle does not write
  // `enabled` back to storage — content.js still owns that write until its
  // toggle UI migrates (ticket 03: legacy behavior unchanged).
  let unsubscribeEnabled = null;
  if (platform.settings) {
    platform.settings.ready().then(() => {
      if (stopped) return;
      applyEnabled(platform.settings.get('enabled'));
      unsubscribeEnabled = platform.settings.subscribe('enabled', applyEnabled);
    });
  }

  // SPA-navigation detection (ticket 04 §7): poll `location.href` through the
  // injected clock rather than raw `setInterval`, keeping time a test seam.
  let cancelPoll = null;
  if (platform.clock && resolvedLocation) {
    let lastUrl = resolvedLocation.href;
    const poll = () => {
      if (stopped) return;
      const kind = classifyPageTransition(resolvedLocation.href, lastUrl);
      if (kind === 'navigation') {
        lastUrl = resolvedLocation.href;
        // No mounted features to reconcile yet (ticket 11 scope). Once
        // feature tickets land, a navigation here would re-run each mounted
        // feature's own reconcile step.
      }
      cancelPoll = platform.clock.setTimeout(poll, NAV_POLL_MS);
    };
    cancelPoll = platform.clock.setTimeout(poll, NAV_POLL_MS);
  }

  // dispatch(message) -> the routed feature handle's own return value, or
  // `undefined` when nothing handled it. Exposed on the returned object so a
  // caller that registered its own `chrome.runtime.onMessage` listener
  // *synchronously* can feed messages in (bootstrap.js does exactly this —
  // see the "message seam" comment there). That indirection exists because
  // this module graph is only reachable through an async `import()`: a
  // listener registered in here does not exist yet during the first ~15-30ms
  // after page load, nor during the unmount/mount gap of an SPA re-mount, and
  // every message arriving in those windows was silently lost (found by
  // ticket 16's browser-smoke failure).
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
    cancelPoll?.();
    removeMessageListener?.();
    unsubscribeEnabled?.();
    unmountAll();
  }

  return { stop, dispatch };
}
