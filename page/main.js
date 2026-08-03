// page/main.js — first entry point of the real ES-module page skeleton
// (ticket 05). Loaded via `import(chrome.runtime.getURL('page/main.js'))`
// from the thin bootstrap content script. Mounts alongside the legacy
// content scripts; it is not yet wired to any user-visible feature.
//
// Follows the uniform page-module contract (ticket 04 §1):
//   export function mount(ctx) -> handle
// where `handle.unmount()` is total and mount-after-unmount is safe (SPA
// navigation re-mounts this module on every page transition).
import { createClock } from './platform/clock.js';

export function mount(ctx = {}) {
  const clock = ctx.clock || createClock();
  const root = document.documentElement;

  // Test/observability hook only — no user-visible behavior. Proves the
  // module graph loaded and mounted (and, via the mount count set by the
  // bootstrap script, that it re-mounts after SPA navigation).
  root.dataset.golensPageSkeletonMounted = 'true';
  root.dataset.golensPageSkeletonMountedAt = String(clock.now());

  let unmounted = false;
  return {
    unmount() {
      if (unmounted) return;
      unmounted = true;
      delete root.dataset.golensPageSkeletonMounted;
      delete root.dataset.golensPageSkeletonMountedAt;
    },
  };
}
