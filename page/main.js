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
import { createOverlayRegistry } from './platform/overlay-registry.js';
import { start as startLifecycle } from './lifecycle/index.js';
import { mount as mountGeneratedFiles } from './features/generated-files.js';
import { mount as mountSettingsOverlay } from './features/settings-overlay.js';
import { mount as mountOnboarding } from './features/onboarding.js';
import { mount as mountKeyboardNav } from './features/keyboard-nav.js';
import { mount as mountMrPreload } from './features/mr-preload.js';
import { mount as mountCelebration } from './features/celebration.js';

export function mount(ctx = {}) {
  const clock = ctx.clock || createClock();
  const settings = ctx.settings || createSettingsStore();
  const overlays = ctx.overlays || createOverlayRegistry();
  const root = document.documentElement;

  // Test/observability hook only — no user-visible behavior. Proves the
  // module graph loaded and mounted (and, via the mount count set by the
  // bootstrap script, that it re-mounts after SPA navigation).
  root.dataset.golensPageSkeletonMounted = 'true';
  root.dataset.golensPageSkeletonMountedAt = String(clock.now());

  const lifecycle = startLifecycle({
    platform: { clock, settings, overlays },
    features: [
      { name: 'generated-files', mount: mountGeneratedFiles },
      { name: 'settings-overlay', mount: mountSettingsOverlay },
      { name: 'onboarding', mount: mountOnboarding },
      {
        name: 'keyboard-nav',
        mount: mountKeyboardNav,
        // Capabilities (ticket 03 §3): keyboard-nav.js can't reach
        // go-navigation.js's still-legacy functions/DOM any other way
        // (feature -> legacy-global is not a "no globalThis contract"
        // violation the same way feature -> feature would be, since
        // go-navigation.js is not itself a migrated feature yet — see
        // keyboard-nav.js's own header comment for the fuller rationale).
        capabilities: {
          runLegacyNavigationAction: (action) => globalThis.GoLensGoNavigation?.runNavigationAction?.(action) === true,
          legacyToast: {
            message: (text) => globalThis.GoLensGoNavigation?.showToast?.(text),
            shortcutHint: (hint) => globalThis.GoLensGoNavigation?.showShortcutCoachHint?.(hint) ?? false,
            isShowing: () => globalThis.GoLensGoNavigation?.isToastShowing?.() ?? false,
          },
        },
      },
      { name: 'mr-preload', mount: mountMrPreload },
      { name: 'celebration', mount: mountCelebration },
    ],
    // Opt out of lifecycle's own chrome.runtime.onMessage registration:
    // bootstrap.js registers synchronously, before this module graph even
    // finishes importing, and feeds messages in through `dispatch` below.
    // Registering here as well would dispatch every message twice.
    runtime: null,
  });

  let unmounted = false;
  return {
    dispatch: lifecycle.dispatch,
    unmount() {
      if (unmounted) return;
      unmounted = true;
      lifecycle.stop();
      delete root.dataset.golensPageSkeletonMounted;
      delete root.dataset.golensPageSkeletonMountedAt;
    },
  };
}
