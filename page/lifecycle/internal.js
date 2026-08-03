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
const FEATURE_ROUTES = {
  'golens-cache-invalidated': { feature: 'mr-preload', action: 'invalidateCache' },
  'golens-preload-full-project': { feature: 'mr-preload', action: 'preloadFullProject' },
  'golens-full-project-status': { feature: 'mr-preload', action: 'fullProjectStatus' },
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
