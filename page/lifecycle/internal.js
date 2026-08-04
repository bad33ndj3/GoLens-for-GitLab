// page/lifecycle/internal.js — pure decision core for page/lifecycle. No DOM,
// no chrome.*, no timers: these functions only classify inputs into data.
// Not part of the module's public interface (internal.js follows dependency
// rules that bar other modules from importing).

// classifyPageTransition(url, prev) -> kind, kind in {'initial','unchanged','navigation'}.
// `prev` is the previously observed `location.href` (or null/undefined before
// the first observation). Total: never throws on any string/null/undefined input.
export function classifyPageTransition(url, prev) {
  if (prev == null) return 'initial';
  if (url === prev) return 'unchanged';
  return 'navigation';
}

// Message-type -> {feature, action} routing table, derived from content.js's
// current `chrome.runtime.onMessage` listener (today's only consumer of these
// message types) and their senders (popup.js, settings.js,
// extension-cache-ui.js). Every entry here has both a real sender and a real
// listener today; nothing dead is encoded.
//
// The three preload/cache-status types below were originally pointed at
// `mr-preload`, but production behavior (content.js's own message handler)
// always went through `controlsHandle` (the toolbar's preload button state),
// not mr-preload.js's raw handle. These are repointed at `controls` for
// behavior parity with the original implementation.
const FEATURE_ROUTES = {
  'golens-cache-invalidated': { feature: 'controls', action: 'invalidatePreloadState' },
  'golens-preload-full-project': { feature: 'controls', action: 'startFullProjectPreload' },
  'golens-full-project-status': { feature: 'controls', action: 'refreshFullProjectPreloadStatus' },
  'golens-show-onboarding': { feature: 'onboarding', action: 'show' },
  'golens-show-settings': { feature: 'settings-overlay', action: 'show' },
  'golens-close-settings': { feature: 'settings-overlay', action: 'close' },
  'golens-settings-ready': { feature: 'settings-overlay', action: 'ready' },
};

// routeMessage(msg) -> kind-discriminated route, from a closed set:
//   { kind: 'lifecycle', action: 'setEnabled' }   -- golens-enabled: `enabled`
//                                                     is lifecycle's own owned
//                                                     key, not a feature route.
//   { kind: 'routed', feature, action }           -- known message type
//   { kind: 'unrouted' }                          -- anything else
// The two matched kinds still carry `feature`/`action` where meaningful.
// Total: never throws on any input, including `undefined`/non-object `msg`.
export function routeMessage(message) {
  const type = message && typeof message === 'object' ? message.type : undefined;
  if (type === 'golens-enabled') return { kind: 'lifecycle', action: 'setEnabled' };
  const route = type ? FEATURE_ROUTES[type] : undefined;
  if (!route) return { kind: 'unrouted' };
  return { kind: 'routed', feature: route.feature, action: route.action };
}
