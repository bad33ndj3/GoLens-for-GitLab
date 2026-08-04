// page/features/keyboard-nav.js — hides: hunk/file target computation, key
// matching, and shortcut-coach offering (ticket 17; boundary from ticket 03
// §2, interface from ticket 04 §3). Carved out of go-navigation.js (the
// coach system, hunk/file navigation) and content.js (the global keydown
// dispatch loop, native-file-search helpers). Pure decision core in
// keyboard-nav.internal.js; DOM/messaging in this shell.
//
// mount(ctx) -> { unmount, offerShortcutCoach(actionID) }. `ctx.overlays`
// replaces the old #golens-*-root DOM read for coach suppression (ticket 12).
// Two capabilities page/main.js injects, since neither is reachable any
// other way without a feature -> legacy-global dependency (ticket 03 §3):
//   - runLegacyNavigationAction(action) -> boolean — forwards actions this
//     module doesn't own (semanticJump, historyBack/Forward, toggleBookmark,
//     previousBookmark, nextBookmark) to go-navigation.js's still-legacy
//     runNavigationAction(), which is unchanged by this ticket.
//   - legacyToast: { message(text), shortcutHint(hint), isShowing() } —
//     go-navigation.js's toast element is shared UI serving ~15 unmigrated
//     call sites (bookmarks, semantic jump, copy, project search, …); giving
//     this module its own toast host would mean two toast surfaces that can
//     show at once, which the "gedragen zich identiek" acceptance criterion
//     forbids. So the element stays in go-navigation.js, reached through
//     this capability, while this module owns the *decision* of whether and
//     what to show (isCoachBlocked, messageForAction) — the former
//     shortcutCoachBlocked()/SHORTCUT_COACH_MESSAGES/offerShortcutCoach().
//
// Reverse bridge: go-navigation.js's own remaining offerShortcutCoach() call
// sites (historyBack, nextOccurrence, semanticJump — none of them this
// module's own hunk/file actions) reach this module's offerShortcutCoach
// through a dynamic import() bridge and the module-scope `active` export
// below, mirroring celebration.js's requestMoment() pattern exactly (ticket
// 14): there is only ever one mounted instance, so a bare module-level
// export forwarding to whichever instance is currently mounted is simpler
// than plumbing a capability the other direction. A call while nothing is
// mounted is a silent no-op, same as celebration's requestMoment during the
// mount/unmount gap.
//
// Mount-once lifetime, not pageKey-tracked (same deviation ticket 14/16
// documented): bootstrap.js remounts the whole page/main.js module graph on
// every location.href change, so the hunk/file navigation cursor
// (`elementNavigation`) resets on every such change, where go-navigation.js's
// legacy teardown() only reset it on actually leaving the merge request.
import {
  isMergeRequestPath,
  pickNavigationIndex,
  hunkStartIndices,
  isBlockedShortcutTarget,
  messageForAction,
  isCoachBlocked,
} from './keyboard-nav.internal.js';

const DIFF_ROOT_SELECTOR = 'diff-file, .diff-file, [data-testid="diff-file"], [data-testid="rd-diff-file"], [data-file-path]';

let active = null;

// offerShortcutCoach(actionID) -> forwards to the currently-mounted
// instance, or no-ops. See header comment for why this exists outside the
// mount(ctx) contract.
export function offerShortcutCoach(actionID) {
  return active ? active.offerShortcutCoach(actionID) : Promise.resolve(false);
}

export function mount(ctx = {}) {
  const doc = document;
  const win = window;
  const overlays = ctx.overlays;
  const settings = ctx.settings;
  const runLegacyNavigationAction = ctx.runLegacyNavigationAction;
  const legacyToast = ctx.legacyToast || {};

  let unmounted = false;
  // Starts true (not the usual "false until settings.ready()" feature-module
  // default, e.g. generated-files.js): content.js's original keydown
  // listener read `state.enabled`, which was declared `true` and only
  // overwritten by the real setting once init() finished — so shortcuts
  // were live optimistically from the first paint, before settings even
  // loaded. Matched here for "gedragen zich identiek" fidelity.
  let enabled = true;
  let elementNavigation = { hunk: null, file: null };

  function isMergeRequestPage() {
    return isMergeRequestPath(win.location.pathname);
  }

  // --- hunk/file target computation ------------------------------------

  function diffFileRoots() {
    return [...doc.querySelectorAll(DIFF_ROOT_SELECTOR)].filter((candidate) => {
      const outerRapid = candidate.parentElement?.closest?.('diff-file');
      return !outerRapid || outerRapid === candidate;
    });
  }

  function changedRow(row) {
    if (row.matches?.('.new, .old, .added, .deleted, [data-hunk-lines]')) return true;
    return [...row.querySelectorAll('a[aria-label]')].some((anchor) => /^(?:added|removed) line\s+\d+/i.test(anchor.getAttribute('aria-label') || ''));
  }

  function hunkTargets() {
    const explicit = [...doc.querySelectorAll('[data-hunk-lines], .diff-hunk, [data-testid="diff-hunk"], [data-testid="rd-diff-hunk"]')];
    if (explicit.length) return explicit;
    const hunks = [];
    for (const root of diffFileRoots()) {
      const rows = [...root.querySelectorAll('tr, [role="row"]')];
      const starts = hunkStartIndices(rows.map(changedRow));
      for (const index of starts) hunks.push(rows[index]);
    }
    return hunks;
  }

  function flashDestination(target) {
    if (!target) return;
    target.removeAttribute('data-golens-navigation-destination');
    void target.offsetWidth;
    target.setAttribute('data-golens-navigation-destination', '');
    setTimeout(() => target.removeAttribute('data-golens-navigation-destination'), 1300);
  }

  function navigateElements(elements, direction, emptyMessage, kind) {
    if (!elements.length) {
      legacyToast.message?.(emptyMessage);
      return false;
    }
    const currentIndex = elements.indexOf(elementNavigation[kind]);
    const viewportPoint = win.innerHeight * .35;
    const firstAfterIndex = elements.findIndex((element) => element.getBoundingClientRect().top >= viewportPoint);
    const index = pickNavigationIndex({ length: elements.length, currentIndex, direction, firstAfterIndex });
    const target = elements[index];
    elementNavigation[kind] = target;
    target.scrollIntoView({ behavior: win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    flashDestination(target);
    return true;
  }

  // --- native file search ------------------------------------------------

  function nativeFileSearch() {
    return doc.querySelector('[aria-label="File browser"] input[placeholder]')
      || doc.querySelector('[data-testid="file-browser"] input[placeholder]')
      || [...doc.querySelectorAll('input[placeholder]')].find((input) => /search\s*\(e\.g\.\s*\*\.vue\)/i.test(input.placeholder));
  }

  function focusNativeFileSearch() {
    const search = nativeFileSearch();
    if (!search) return false;
    search.focus();
    search.select();
    return true;
  }

  function closeNativeFileSearch() {
    const search = nativeFileSearch();
    if (!search) return false;
    search.value = '';
    search.dispatchEvent(new win.Event('input', { bubbles: true }));
    search.blur();
    return true;
  }

  function isBlockedShortcutEvent(event) {
    const search = nativeFileSearch();
    const targets = [...event.composedPath(), doc.activeElement].filter(Boolean);
    return targets.some((target) => {
      const blocked = target?.closest?.('input, textarea, select, [contenteditable], dialog, [role="dialog"], [aria-modal="true"]');
      return isBlockedShortcutTarget({
        isSearch: target === search,
        hasBlockingAncestor: Boolean(blocked),
        blockingIsFormLike: Boolean(blocked?.matches?.('input, textarea, select, [contenteditable]')),
        disabled: Boolean(blocked?.disabled),
        readOnly: Boolean(blocked?.readOnly),
        contentEditableAttr: blocked?.getAttribute?.('contenteditable') ?? null,
      });
    });
  }

  // --- shortcut coach ------------------------------------------------

  function coachBlockedNow() {
    return isCoachBlocked({
      hidden: doc.visibilityState === 'hidden',
      overlayOpen: overlays?.isAnyOpen() ?? false,
      toastShowing: legacyToast.isShowing?.() ?? false,
    });
  }

  // Mirrors go-navigation.js's former two-check shape exactly: blocked is
  // checked once before asking GoLensShortcutCoach.consider() (cheap early
  // exit) and again after it resolves, since consider() awaits its own
  // storage round trip during which an overlay can open or another toast
  // can start — the old showShortcutCoachHint() re-checked
  // shortcutCoachBlocked() for the same reason.
  async function offerShortcutCoachImpl(actionID) {
    const message = messageForAction(actionID);
    if (!message || !enabled || coachBlockedNow()) return false;
    try {
      const hint = await globalThis.GoLensShortcutCoach?.consider?.(actionID);
      if (!hint || coachBlockedNow()) return false;
      return legacyToast.shortcutHint?.({ actionID: hint.actionID, message, displayBinding: hint.displayBinding }) ?? false;
    } catch {
      return false;
    }
  }

  // --- keydown dispatch ------------------------------------------------

  function onKeyDown(event) {
    if (!enabled || !isMergeRequestPage() || event.isComposing || isBlockedShortcutEvent(event)) return;
    const shortcuts = globalThis.GoLensShortcuts;
    const bindings = shortcuts?.mergeBindings(settings?.get('shortcutBindings'));
    if (!shortcuts || !bindings) return;
    const action = shortcuts.actions.find(({ id }) => shortcuts.matchesEvent(bindings[id], event))?.id;
    if (!action) return;
    let handled = false;
    if (action === 'focusFileSearch') handled = focusNativeFileSearch();
    else if (action === 'clearFileSearch') handled = closeNativeFileSearch();
    else if (action === 'previousHunk') handled = navigateElements(hunkTargets(), -1, 'No loaded diff hunks.', 'hunk');
    else if (action === 'nextHunk') handled = navigateElements(hunkTargets(), 1, 'No loaded diff hunks.', 'hunk');
    else if (action === 'previousFile') handled = navigateElements(diffFileRoots(), -1, 'No loaded diff files.', 'file');
    else if (action === 'nextFile') handled = navigateElements(diffFileRoots(), 1, 'No loaded diff files.', 'file');
    else handled = runLegacyNavigationAction?.(action) === true;
    if (handled) {
      event.preventDefault();
      void globalThis.GoLensShortcutCoach?.markShortcutUsed?.(action);
    }
  }

  function onShortcutCoachManualClick(event) {
    const search = nativeFileSearch();
    if (!enabled || !search || !event.composedPath().includes(search)) return;
    void offerShortcutCoachImpl('focusFileSearch');
  }

  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('click', onShortcutCoachManualClick, true);

  let unsubscribeEnabled = null;
  if (settings) {
    settings.ready().then(() => {
      if (unmounted) return;
      enabled = Boolean(settings.get('enabled'));
      unsubscribeEnabled = settings.subscribe('enabled', (value) => {
        enabled = Boolean(value);
      });
    });
  }

  active = { offerShortcutCoach: offerShortcutCoachImpl };

  return {
    unmount() {
      if (unmounted) return;
      unmounted = true;
      if (active && active.offerShortcutCoach === offerShortcutCoachImpl) active = null;
      doc.removeEventListener('keydown', onKeyDown, true);
      doc.removeEventListener('click', onShortcutCoachManualClick, true);
      unsubscribeEnabled?.();
      elementNavigation = { hunk: null, file: null };
    },
    offerShortcutCoach: offerShortcutCoachImpl,
  };
}
