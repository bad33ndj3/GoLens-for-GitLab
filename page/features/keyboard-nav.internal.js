// page/features/keyboard-nav.internal.js — pure decision core for
// page/features/keyboard-nav.js. No DOM, no chrome.*, no timers.

// isMergeRequestPath(pathname) -> mirrors content.js's former isMergeRequest()
// guard on the global keydown listener. Duplicated per precedent: a one-line,
// unlikely-to-drift predicate, not worth a shared platform module. Total.
export function isMergeRequestPath(pathname) {
  return /\/-\/merge_requests\/\d+/.test(pathname || '');
}

// pickNavigationIndex({ length, currentIndex, direction, firstAfterIndex })
// -> the target index to move to, mirroring go-navigation.js's former
// navigateElements() index arithmetic exactly. Caller guards `length > 0`
// (an empty list is a distinct "nothing to navigate" outcome, not encoded
// here). `currentIndex` is -1 when there is no current cursor (first
// navigation, or the remembered element scrolled out of the DOM).
// `firstAfterIndex` is the index of the first element at or past 35% of
// the viewport (-1 if none), used only when there is no current cursor.
// Total given length > 0.
export function pickNavigationIndex({ length, currentIndex, direction, firstAfterIndex }) {
  if (currentIndex >= 0) return (currentIndex + direction + length) % length;
  if (direction > 0) return firstAfterIndex < 0 ? 0 : firstAfterIndex;
  return firstAfterIndex <= 0 ? length - 1 : firstAfterIndex - 1;
}

// hunkStartIndices(changedFlags) -> indices where a run of "changed" rows
// begins, mirroring go-navigation.js's former hunkTargets() fallback loop
// (the row-scanning branch used when no explicit hunk markup exists).
// `changedFlags` is a boolean per row, computed by the shell via
// changedRow()-equivalent DOM reads. Total: [] for an empty or
// all-unchanged input.
export function hunkStartIndices(changedFlags) {
  const starts = [];
  let previousChanged = false;
  changedFlags.forEach((changed, index) => {
    if (changed && !previousChanged) starts.push(index);
    previousChanged = changed;
  });
  return starts;
}

// isBlockedShortcutTarget({ isSearch, hasBlockingAncestor, blockingIsFormLike,
// disabled, readOnly, contentEditableAttr }) -> whether this one candidate
// target (from event.composedPath() plus document.activeElement) should
// suppress shortcut handling, mirroring content.js's former
// isBlockedShortcutEvent() per-candidate logic exactly. The shell resolves
// one of these prop bags per candidate via closest()/matches() and calls
// this for each; `.some(...)` over the results replaces the original
// `targets.some(...)` body. Total.
export function isBlockedShortcutTarget({ isSearch, hasBlockingAncestor, blockingIsFormLike, disabled, readOnly, contentEditableAttr }) {
  if (isSearch) return true;
  if (!hasBlockingAncestor) return false;
  if (!blockingIsFormLike) return true;
  return !disabled && !readOnly && contentEditableAttr !== 'false';
}

// messageForAction(actionID) -> the shortcut-coach hint copy for that
// action, or undefined if this action never gets a coach hint. Byte-
// identical values to go-navigation.js's former SHORTCUT_COACH_MESSAGES.
// Total.
const COACH_MESSAGES = {
  focusFileSearch: "Focus GitLab's file search without reaching for the mouse.",
  semanticJump: 'Open the selected symbol directly from the keyboard.',
  nextOccurrence: 'Move through the selected occurrences from the keyboard.',
  historyBack: 'Return to the previous semantic location.',
};

export function messageForAction(actionID) {
  return COACH_MESSAGES[actionID];
}

// isCoachBlocked({ hidden, overlayOpen, toastShowing }) -> whether the
// shortcut coach must stay silent right now, mirroring go-navigation.js's
// former shortcutCoachBlocked() OR-combination exactly. `overlayOpen` comes
// from ctx.overlays.isAnyOpen() rather than a DOM read of another module's
// root; `toastShowing` comes from the legacyToast capability's isShowing(),
// since the toast element itself still lives in go-navigation.js's own shadow
// host. Total.
export function isCoachBlocked({ hidden, overlayOpen, toastShowing }) {
  return Boolean(hidden || overlayOpen || toastShowing);
}
