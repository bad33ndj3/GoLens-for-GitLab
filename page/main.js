// page/main.js — first entry point of the real ES-module page skeleton
// (ticket 05). Loaded via `import(chrome.runtime.getURL('page/main.js'))`
// from the thin bootstrap content script. Mounts alongside the legacy
// content scripts; it is not yet wired to any user-visible feature.
//
// Follows the uniform page-module contract (ticket 04 §1):
//   export function mount(ctx) -> handle
// where `handle.unmount()` is total and mount-after-unmount is safe (SPA
// navigation re-mounts this module on every page transition).
//
// Ticket 11 wires page/lifecycle in alongside the skeleton: `start()` is
// called with an empty feature set (no feature ticket has landed yet), so it
// only performs its own inert location.href observation for now (see
// page/lifecycle/index.js's header comment) — no user-visible behavior
// changes, and content.js/go-navigation.js are untouched.
import { createClock } from './platform/clock.js';
import { start as startLifecycle } from './lifecycle/index.js';

export function mount(ctx = {}) {
  const clock = ctx.clock || createClock();
  const root = document.documentElement;

  // Test/observability hook only — no user-visible behavior. Proves the
  // module graph loaded and mounted (and, via the mount count set by the
  // bootstrap script, that it re-mounts after SPA navigation).
  root.dataset.golensPageSkeletonMounted = 'true';
  root.dataset.golensPageSkeletonMountedAt = String(clock.now());

  const lifecycle = startLifecycle({ platform: { clock }, features: [] });

  let unmounted = false;
  return {
    unmount() {
      if (unmounted) return;
      unmounted = true;
      lifecycle.stop();
      delete root.dataset.golensPageSkeletonMounted;
      delete root.dataset.golensPageSkeletonMountedAt;
    },
  };
}
