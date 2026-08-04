// platform/toast — the one transient-notification surface on a merge-request
// page (ticket 29). Lifted verbatim from go-navigation.js's
// `ensureUI`/`toast`/`hideToast`/`isToastShowing`/`showShortcutCoachHint`.
//
// It stays a single surface on purpose: page/features/keyboard-nav.js,
// bookmarks.js, project-search.js and code-intel.js all reach it (today via
// go-navigation.js's `legacyToast` capability and its `showToast`/
// `showShortcutCoachHint`/`isToastShowing` globals; after ticket 22 by
// direct injection). code-intel.js deliberately runs its *popover* in its
// own separate shadow host — that is a different surface with a different
// lifetime, and this one shrank to toast-only when that split happened
// (ticket 21).
//
// One element, two renderings, distinguished by `dataset.kind`:
//   - `message` — a plain string, auto-hides after 2600ms.
//   - `shortcut` — the shortcut coach's hint: label, message, key binding,
//     and two actions ("Got it" / "Turn tips off"), auto-hides after 8000ms.
// The `message` rendering hides the label/binding/actions through CSS
// rather than by rebuilding the markup, which is why both share one node.
//
// ## Deviations from ticket 29's literal wording, and why
//
// 1. **No `clock` dependency.** Ticket 29 proposes `createToast({ clock })`.
//    The originals used bare `setTimeout`/`clearTimeout`, *not*
//    go-navigation.js's swappable `clock` — routing them through it would
//    newly make `__test.setClock(...)` affect toast auto-hide timing, which
//    is a behaviour change in a ticket whose first checklist item is
//    "toast-timers ongewijzigd". `createToast()` therefore takes no deps and
//    keeps the raw globals. If a test ever needs to control these timers,
//    add the seam then, deliberately.
//
// 2. **`GoLensShortcutCoach` stays a global read.** The "Turn tips off"
//    button calls `globalThis.GoLensShortcutCoach?.setEnabled?.(false)`
//    exactly as before. shortcut-settings.js's global is outside this
//    ticket's scope; injecting it would change who owns that contract
//    without any ticket saying so.

const MESSAGE_TIMEOUT_MS = 2600;
const SHORTCUT_HINT_TIMEOUT_MS = 8000;

export function createToast() {
  let host = null;
  let timer = null;

  // `isConnected`, not a plain null check: an SPA navigation can remove the
  // host from the document while this closure still holds the reference, and
  // the toast then has to rebuild rather than write into a detached tree.
  function ensureUI() {
    if (host?.isConnected) return host.shadowRoot;
    const element = document.createElement('div');
    element.id = 'golens-go-toast-root';
    const shadow = element.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all:initial; position:fixed; z-index:var(--golens-z-popover); inset:0; pointer-events:none; font:12px/1.45 var(--golens-font-sans); color-scheme:dark; }
        * { box-sizing:border-box; }
        kbd { display:inline-flex; min-width:17px; min-height:17px; align-items:center; justify-content:center; padding:1px 3px; border:1px solid var(--golens-border-strong); border-bottom-width:2px; border-radius:var(--golens-radius-xs); background:var(--golens-surface-inset); color:var(--golens-text-primary); font:700 9px/1 var(--golens-font-mono); }
        .toast { position:fixed; right:18px; bottom:18px; display:none; width:min(390px,calc(100vw - 36px)); padding:var(--golens-space-3); border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-md); background:var(--golens-surface-raised); color:var(--golens-text-primary); box-shadow:var(--golens-shadow-md); pointer-events:auto; }
        .toast.show { display:grid; }
        .toast[data-kind="message"] { width:auto; max-width:360px; padding:var(--golens-space-2) var(--golens-space-3); }
        .toast[data-kind="message"] .toast-label,.toast[data-kind="message"] .toast-binding,.toast[data-kind="message"] .toast-actions { display:none; }
        .toast-label { margin:0 0 3px; color:var(--golens-primary-hover); font:700 9px/1.3 var(--golens-font-mono); letter-spacing:.06em; text-transform:uppercase; }
        .toast-content { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--golens-space-3); align-items:center; }
        .toast-message { color:var(--golens-text-primary); line-height:1.45; }
        .toast-binding { min-height:24px; padding:3px 7px; white-space:nowrap; }
        .toast-actions { display:flex; gap:var(--golens-space-2); justify-content:flex-end; margin-top:var(--golens-space-2); }
        .toast-actions button { padding:4px 7px; border:1px solid transparent; border-radius:var(--golens-radius-xs); background:transparent; color:var(--golens-text-secondary); font:650 10px/1.3 var(--golens-font-sans); cursor:pointer; }
        .toast-actions button:hover { border-color:var(--golens-border-default); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
        .toast-actions button:active { background:var(--golens-surface-pressed); transform:translateY(1px); }
        .toast-actions button:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:1px; }
      </style>
      <section class="toast" data-kind="message" role="status" aria-live="polite"><p class="toast-label">Shortcut tip</p><div class="toast-content"><div class="toast-message"></div><kbd class="toast-binding"></kbd></div><div class="toast-actions"><button type="button" data-action="shortcut-tip-dismiss">Got it</button><button type="button" data-action="shortcut-tip-disable">Turn tips off</button></div></section>
    `;
    document.body.append(element);
    host = element;
    shadow.querySelector('[data-action="shortcut-tip-dismiss"]').addEventListener('click', hideToast);
    shadow.querySelector('[data-action="shortcut-tip-disable"]').addEventListener('click', async () => {
      const saved = await globalThis.GoLensShortcutCoach?.setEnabled?.(false);
      toast(saved ? 'Shortcut tips turned off. You can re-enable them in settings.' : 'Could not update shortcut tip settings.');
    });
    return shadow;
  }

  function hideToast() {
    clearTimeout(timer);
    timer = null;
    host?.shadowRoot.querySelector('.toast')?.classList.remove('show');
  }

  function toast(message) {
    const element = ensureUI().querySelector('.toast');
    clearTimeout(timer);
    element.dataset.kind = 'message';
    element.querySelector('.toast-message').textContent = message;
    element.classList.add('show');
    timer = setTimeout(hideToast, MESSAGE_TIMEOUT_MS);
  }

  function isToastShowing() {
    return Boolean(host?.shadowRoot.querySelector('.toast')?.classList.contains('show'));
  }

  // Renders a hint it is handed, message included — it does not decide
  // whether or what to show. That decision (the blocked-check and the
  // action→message mapping) is page/features/keyboard-nav.js's, since ticket
  // 17. Returns false for a hint with no message so the caller can tell a
  // rendered hint from a skipped one.
  function showShortcutCoachHint(hint) {
    if (!hint?.message) return false;
    const element = ensureUI().querySelector('.toast');
    clearTimeout(timer);
    element.dataset.kind = 'shortcut';
    element.querySelector('.toast-message').textContent = hint.message;
    element.querySelector('.toast-binding').textContent = hint.displayBinding;
    element.classList.add('show');
    timer = setTimeout(hideToast, SHORTCUT_HINT_TIMEOUT_MS);
    return true;
  }

  // go-navigation.js's `teardown()` cleared the pending timer and removed the
  // host in two separate steps against its own `state`; both are this
  // module's business now.
  function destroy() {
    clearTimeout(timer);
    timer = null;
    host?.remove();
    host = null;
  }

  return { ensureUI, toast, hideToast, isToastShowing, showShortcutCoachHint, destroy };
}
