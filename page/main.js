// page/main.js — first entry point of the real ES-module page skeleton
// (ticket 05). Loaded via `import(chrome.runtime.getURL('page/main.js'))`
// from the thin bootstrap content script. Mounts alongside the legacy
// content scripts.
//
// Follows the uniform page-module contract (ticket 04 §1):
//   export function mount(ctx) -> handle
// where `handle.unmount()` is total and mount-after-unmount is safe (SPA
// navigation re-mounts this module on every page transition).
//
// Ticket 11 wired page/lifecycle in alongside the skeleton. Ticket 13 is the
// first feature to actually populate `features: []` below: generated-files
// migrated whole out of content.js (legacy code deleted in the same
// ticket), landing here as the pattern tickets 14-21 repeat. `settings` is
// constructed here (not by the feature — ticket 04 §1's "accept
// dependencies, don't create them") and passed via `platform` so every
// mounted feature's `ctx` includes it.
import { createClock } from './platform/clock.js';
import { createSettingsStore } from './platform/settings-store.js';
import { start as startLifecycle } from './lifecycle/index.js';
import { mount as mountGeneratedFiles } from './features/generated-files.js';
import { mount as mountMrPreload } from './features/mr-preload.js';

export function mount(ctx = {}) {
  const clock = ctx.clock || createClock();
  const settings = ctx.settings || createSettingsStore();
  const root = document.documentElement;

  // Test/observability hook only — no user-visible behavior. Proves the
  // module graph loaded and mounted (and, via the mount count set by the
  // bootstrap script, that it re-mounts after SPA navigation).
  root.dataset.golensPageSkeletonMounted = 'true';
  root.dataset.golensPageSkeletonMountedAt = String(clock.now());

  const lifecycle = startLifecycle({
    platform: { clock, settings },
    features: [
      { name: 'generated-files', mount: mountGeneratedFiles },
      { name: 'mr-preload', mount: mountMrPreload },
    ],
  });

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
