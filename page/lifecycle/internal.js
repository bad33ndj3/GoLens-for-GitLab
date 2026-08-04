// page/lifecycle/internal.js — pure decision core for page/lifecycle (ticket
// 11; contract per ticket 04 §3/§1's internal-seam convention). No DOM,
// no chrome.*, no timers: these functions only classify inputs into data.
// Not part of the module's public interface (ticket 04 §1: "internal.js the
// dependency rules bar other modules from importing").

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
// Ticket 22 correction: the three preload/cache-status types below were
// originally pointed at `mr-preload` (ticket 16's forward guess, before
// ticket 30 gave `page/features/controls.js` its own parallel preload state
// machine). Production behavior — content.js's own message handler — always
// went through `controlsHandle` (the toolbar's preload button state), not
// mr-preload.js's raw handle, so these are repointed at `controls` for
// behavior parity. Documented as a deviation in
// .scratch/restructure-js-before-ts/issues/16-message-seam.md-equivalent
// note (map.md / ticket 22's completion note) rather than left silent.
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
//                                                     key (ticket 03 §5), not
//                                                     a feature route.
//   { kind: 'routed', feature, action }           -- known message type
//   { kind: 'unrouted' }                          -- anything else
// Ticket 04 §3 states the literal shape as `{ feature, action }`; that can't
// express "no route" without `null` (forbidden by ticket 04 §5's "never
// null" domain-outcome rule), so this is a deliberate, documented refinement:
// the two matched kinds still carry `feature`/`action` where meaningful.
// Total: never throws on any input, including `undefined`/non-object `msg`.
export function routeMessage(message) {
  const type = message && typeof message === 'object' ? message.type : undefined;
  if (type === 'golens-enabled') return { kind: 'lifecycle', action: 'setEnabled' };
  const route = type ? FEATURE_ROUTES[type] : undefined;
  if (!route) return { kind: 'unrouted' };
  return { kind: 'routed', feature: route.feature, action: route.action };
}
