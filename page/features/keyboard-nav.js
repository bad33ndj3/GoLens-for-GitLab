// page/features/keyboard-nav.js — hides: hunk/file target computation, key
// matching, and shortcut-coach offering (ticket 17; boundary from ticket 03
// §2, interface from ticket 04 §3). Carved out of go-navigation.js (the
// coach system, hunk/file navigation) and content.js (the global keydown
// dispatch loop, native-file-search helpers). Pure decision core in
// keyboard-nav.internal.js; DOM/messaging in this shell.
//
// mount(ctx) -> { unmount, offerShortcutCoach(actionID) }. `ctx.overlays`
// replaces the old #golens-*-root DOM read for coach suppression (ticket 12).
// Capabilities page/main.js injects, since none are reachable any other way
// without a feature -> feature edge (ticket 03 §3):
//   - navigationAction(action) -> boolean (ticket 21) — forwards the five
//     actions page/features/code-intel.js now owns (semanticJump,
//     previousOccurrence, nextOccurrence, historyBack, historyForward) to
//     that module's handle. Tried first; returns false for actions it
//     doesn't own (its own closed action set), so this file falls through
//     to runLegacyNavigationAction below for those.
//   - runLegacyNavigationAction(action) -> boolean — the three remaining
//     actions (toggleBookmark, previousBookmark, nextBookmark), reproducing
//     go-navigation.js's former (shrunk-by-ticket-21) runNavigationAction()
//     body directly against page/features/bookmarks.js's real handle
//     (ticket 22 — the name survives, the implementation moved into
//     page/main.js's closure instead of a globalThis bridge).
//   - legacyToast: { message(text), shortcutHint(hint), isShowing() } — the
//     shared toast surface (page/lifecycle/mr-session.js's `toast` instance,
//     ticket 29) serving ~15 call sites (bookmarks, semantic jump, copy,
//     project search, …); giving this module its own toast host would mean
//     two toast surfaces that can show at once, which the "gedragen zich
//     identiek" acceptance criterion forbids. This module still owns the
//     *decision* of whether and what to show (isCoachBlocked,
//     messageForAction) — the former shortcutCoachBlocked()/
//     SHORTCUT_COACH_MESSAGES/offerShortcutCoach().
//   - minimizeProjectSearch()/handleCodeIntelEscape(event) (ticket 22/20/21)
//     — document-level Escape routing, formerly go-navigation.js's onKeyDown.
//     Wired here (not a new page/lifecycle-level keydown listener) since
//     this module already owns document-level keydown dispatch; see
//     onEscapeKeyDown below for the exact behavior preserved.
//
// Reverse bridge: code-intel.js's own remaining offerShortcutCoach() call
// sites (historyBack, nextOccurrence, semanticJump — none of them this
// module's own hunk/file actions) reach this module's offerShortcutCoach
// through the module-scope `active` export below (page/main.js passes it
// into code-intel's `legacy.offerShortcutCoach`), mirroring celebration.js's
// requestMoment() pattern exactly (ticket 14): there is only ever one
// mounted instance, so a bare module-level export forwarding to whichever
// instance is currently mounted is simpler than plumbing a capability the
// other direction. A call while nothing is mounted is a silent no-op, same
// as celebration's requestMoment during the mount/unmount gap.
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
  const navigationAction = ctx.navigationAction;
  const legacyToast = ctx.legacyToast || {};
  const minimizeProjectSearch = ctx.minimizeProjectSearch;
  const handleCodeIntelEscape = ctx.handleCodeIntelEscape;

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
    else handled = navigationAction?.(action) === true || runLegacyNavigationAction?.(action) === true;
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

  // --- Escape routing (ticket 22/20/21) ---------------------------------
  //
  // Byte-identical to go-navigation.js's former document-level onKeyDown:
  // same guard (composedPath()/activeElement against the same selector,
  // independent of isBlockedShortcutEvent's different shortcut-typing
  // semantics above), same two branches in the same priority order
  // (project-search-minimize first, then code-intel's popover), same
  // `document`-target/capture-phase registration. Kept as its own listener
  // rather than folded into onKeyDown above: onKeyDown's shortcut dispatch
  // is gated by isComposing/isBlockedShortcutEvent, neither of which
  // go-navigation.js's Escape handler ever checked. Gated on `enabled` and
  // isMergeRequestPage() — the merge-request activation latch
  // (page/lifecycle/mr-session.js's activate()/deactivate(), reached
  // in the original only while attached) is equivalent in practice: the
  // latch is only ever set while both are true.
  const ESCAPE_GUARD_SELECTOR = 'input, textarea, select, [contenteditable], dialog, [role="dialog"], [aria-modal="true"]';
  function onEscapeKeyDown(event) {
    if (event.key !== 'Escape' || !enabled || !isMergeRequestPage()) return;
    if ([...event.composedPath(), doc.activeElement].some((target) => target?.closest?.(ESCAPE_GUARD_SELECTOR))) return;
    if (minimizeProjectSearch?.()?.kind === 'minimized') {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    handleCodeIntelEscape?.(event);
  }

  doc.addEventListener('keydown', onKeyDown, true);
  doc.addEventListener('keydown', onEscapeKeyDown, true);
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
      doc.removeEventListener('keydown', onEscapeKeyDown, true);
      doc.removeEventListener('click', onShortcutCoachManualClick, true);
      unsubscribeEnabled?.();
      elementNavigation = { hunk: null, file: null };
    },
    offerShortcutCoach: offerShortcutCoachImpl,
  };
}
