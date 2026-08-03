// page/features/settings-overlay.js — hides: the in-page settings overlay's
// DOM, settings.html-embedding, ready-handshake, and its overlay-registry
// claim (ticket 16; boundary from ticket 03 §2, interface from ticket 04
// §3). Carved out of content.js following generated-files.js's pattern
// (ticket 13): mount(ctx) -> { unmount, show(), close() }, pure decision
// core in settings-overlay.internal.js, DOM/messaging in this shell.
//
// Routed via page/lifecycle (page/lifecycle/internal.js's FEATURE_ROUTES):
// 'golens-show-settings' -> show(), 'golens-close-settings' -> close(),
// 'golens-settings-ready' -> ready(). content.js keeps a thin ack-only
// chrome.runtime.onMessage shim for the same message types (see its own
// comments) since page/lifecycle's routed listener never calls
// sendResponse; both listeners fire for every message delivered to this
// tab, so the ack and this module's actual DOM work happen in parallel, not
// as a single synchronous call like content.js's former showSettingsOverlay.
//
// Mutual exclusion with onboarding (still content.js-owned, unmigrated):
// content.js's own 'golens-show-settings' handler calls its closeOnboarding()
// directly (legal: it owns onboarding). The reverse — closing settings when
// onboarding opens — can't be a direct call the other way (no feature ->
// feature calls, ticket 03 §3), so this module listens for the same
// 'golens-show-onboarding' message itself and closes, applying the same
// isGitLab()/isMergeRequest() guard content.js's own handler applies before
// it shows onboarding, so the two stay in sync about when that message is
// actually honored. Documented deviation: this reverse path used to be one
// synchronous function call inside content.js's message handler; it is now
// two independent chrome.runtime.onMessage listeners reacting to the same
// delivered message, so relative ordering depends on listener registration
// order rather than being guaranteed within one function body.
import { createOverlayRegistry } from '../platform/overlay-registry.js';
import { isGitLabPage, isMergeRequestPath, overlayMarkup } from './settings-overlay.internal.js';

function detectGitLabPage(doc, win) {
  return isGitLabPage({
    hasGitlabGlobal: Boolean(win.gon?.gitlab_url),
    hasCsrfMeta: Boolean(doc.querySelector('meta[name="csrf-token"]')),
    hasAppShell: Boolean(doc.querySelector('.super-sidebar, [data-testid="super-sidebar"], #js-top-bar, .layout-page, .ai-panels')),
  });
}

export function mount(ctx = {}) {
  const doc = document;
  const win = window;
  const runtime = ctx.runtime !== undefined ? ctx.runtime : globalThis.chrome?.runtime;
  const overlays = ctx.overlays || createOverlayRegistry();

  let unmounted = false;
  let host = null;
  let release = null;
  let returnFocus = null;

  function close({ restoreFocus = true } = {}) {
    if (!host) return;
    host.remove();
    host = null;
    release?.();
    release = null;
    if (restoreFocus) returnFocus?.focus?.();
    returnFocus = null;
  }

  function show() {
    if (host) {
      host.shadowRoot?.querySelector('iframe')?.focus();
      return;
    }
    if (!detectGitLabPage(doc, win)) return;
    returnFocus = doc.activeElement;
    host = doc.createElement('div');
    host.id = 'golens-settings-root';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = overlayMarkup({ settingsUrl: runtime?.getURL ? runtime.getURL('settings.html') : 'settings.html' });
    shadow.querySelector('[data-action="close-settings-backdrop"]').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) close();
    });
    const frame = shadow.querySelector('iframe');
    frame.addEventListener('load', () => {
      host.dataset.loaded = 'true';
      frame.focus();
    }, { once: true });
    doc.body.append(host);
    release = overlays.claim('settings-overlay');
  }

  function ready() {
    if (host) host.dataset.ready = 'true';
    return Boolean(host);
  }

  // Mirrors content.js's own 'golens-show-onboarding' guard exactly, so this
  // module only closes settings when content.js's handler would actually
  // proceed to open onboarding.
  function onRuntimeMessage(message) {
    if (message?.type !== 'golens-show-onboarding') return;
    if (!detectGitLabPage(doc, win) || !isMergeRequestPath(win.location.pathname)) return;
    close({ restoreFocus: false });
  }
  runtime?.onMessage?.addListener(onRuntimeMessage);

  return {
    unmount() {
      if (unmounted) return;
      unmounted = true;
      runtime?.onMessage?.removeListener(onRuntimeMessage);
      close({ restoreFocus: false });
    },
    show,
    close,
    ready,
  };
}
