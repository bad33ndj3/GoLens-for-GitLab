// page/features/controls.internal.js — pure decision core for
// page/features/controls.js. No DOM, no chrome.*, no timers: these functions
// only compute view-models or classify already-read data.

// isMergeRequestPath(pathname) -> true for any merge-request path, mirrors
// content.js's isMergeRequest(). Total.
export function isMergeRequestPath(pathname) {
  return /\/-\/merge_requests\/\d+/.test(pathname || '');
}

// isMergeRequestDiffPath(pathname, search) -> true for a merge-request diffs
// tab. The rapid-diffs opt-in (enableRapidDiffs/watchForRapidDiffs) moved
// into this module directly, as its only remaining caller. Total.
export function isMergeRequestDiffPath(pathname, search) {
  return /\/-\/merge_requests\/\d+\/diffs(?:$|\/|\?)/.test(`${pathname || ''}${search || ''}`);
}

// preloadCompleteMessage({ searchStatus, coverage }) -> the status label
// shown once an MR-head preload finishes, shared by both the
// preloadMergeRequest success path and refreshPreloadStatus's "already
// complete" path (byte-identical ternary in both, in the pre-migration
// code). Total.
export function preloadCompleteMessage({ searchStatus, coverage }) {
  if (searchStatus === 'unavailable') return 'Related cache ready · code search unavailable';
  if (searchStatus === 'limited') return 'Related cache ready · candidate search limited';
  return coverage === 'full' ? 'Full project cached' : 'Related MR cache ready';
}

// preloadButtonView({ status, message, progress, enabled }) -> the
// view-model content.js's renderPreloadState used to compute and apply
// directly to the DOM. Total.
export function preloadButtonView({ status, message, progress, enabled }) {
  const busy = status === 'checking' || status === 'busy';
  const percentage = Number.isFinite(progress?.percentage) ? Math.max(0, Math.min(100, progress.percentage)) : null;
  const indeterminate = busy && (percentage === null || progress?.phase === 'discovering');
  const visualState = status === 'checking' ? 'checking' : status;
  const showCount = busy
    && !indeterminate
    && progress?.unit === 'packages'
    && Number.isFinite(progress.completed)
    && Number.isFinite(progress.total)
    && progress.total > 0;
  const countLabel = showCount ? `${progress.completed}/${progress.total}` : '';
  const countLength = countLabel.replace('/', '').length;
  const label = status === 'complete'
    ? (message || 'Related MR cache ready')
    : status === 'busy' || status === 'checking'
    ? (message || 'Checking MR head cache…')
    : status === 'error'
    ? `Cache related MR packages · ${message || 'previous attempt failed'}`
    : 'Cache related MR packages';
  return {
    dataState: visualState,
    disabled: !enabled || busy,
    indeterminate,
    ariaBusy: busy,
    ariaValueNow: indeterminate || percentage === null ? null : String(percentage),
    fillWidth: indeterminate || percentage === null ? '' : `${percentage}%`,
    countLabel,
    showCount,
    countSize: countLength > 6 ? 'tiny' : countLength > 4 ? 'small' : 'normal',
    label,
  };
}

// bookmarkButtonView({ count, stale, enabled }) -> the view-model
// content.js's renderBookmarkControl used to compute and apply directly to
// the DOM. Total.
export function bookmarkButtonView({ count, stale, enabled }) {
  const label = `Open MR bookmarks · ${count} current${stale ? `, ${stale} stale` : ''}`;
  return {
    badgeText: count > 99 ? '99+' : String(count),
    badgeHidden: count === 0,
    staleHidden: stale === 0,
    disabled: !enabled,
    label,
  };
}

// toggleButtonView({ enabled, reviewFocus }) -> the view-model
// content.js's renderControlState used to compute for the enable-toggle and
// focus buttons. Total.
export function toggleButtonView({ enabled, reviewFocus }) {
  return {
    toggleAriaPressed: String(enabled),
    toggleTitle: enabled ? 'Turn GoLens off' : 'Turn GoLens on',
    toggleReviewFocus: String(enabled && reviewFocus),
    focusDisabled: !enabled,
    focusAriaPressed: String(enabled && reviewFocus),
  };
}

// bookmarkRangeLabel(record) -> "L<n>" or "L<start>–<end>" for a bookmark's
// line range. Total.
export function bookmarkRangeLabel(record) {
  return record.location.startLine === record.location.endLine
    ? `L${record.location.startLine}`
    : `L${record.location.startLine}–${record.location.endLine}`;
}

// diffViewFromLocation({ search, cookie }) -> 'inline' | 'parallel', GoLens's
// read of GitLab's own persisted diff-view preference. GitLab's diffs Vuex
// action (setDiffViewType) writes both a `view` query-string param (via
// history.pushState, no reload) and a `diff_view` cookie every time the user
// switches — the query param reflects the just-applied choice immediately,
// the cookie is what GitLab reads to pick the view on a fresh page load
// before that load's own `view` param (if any) is present. Never guesses
// beyond those two signals; GitLab's own default (no param, no cookie) is
// 'inline'. Total.
export function diffViewFromLocation({ search, cookie }) {
  const param = new URLSearchParams(search || '').get('view');
  if (param === 'inline' || param === 'parallel') return param;
  const match = /(?:^|;\s*)diff_view=(inline|parallel)(?:;|$)/.exec(cookie || '');
  return match ? match[1] : 'inline';
}

// diffViewToggleView({ view, enabled, isDiffPath }) -> the view-model for the
// diff-view rail button. Disabled state depends only on GoLens's own
// enablement and being on a merge-request diffs path — never on whether
// GitLab's own preferences control has been located in the DOM yet (that
// would flash disabled->enabled as GitLab's Vue app mounts); a toggle
// attempt that can't find GitLab's control degrades to a toast instead, see
// controls.js's toggleDiffView(). Total.
export function diffViewToggleView({ view, enabled, isDiffPath }) {
  const parallel = view === 'parallel';
  return {
    ariaPressed: String(parallel),
    disabled: !enabled || !isDiffPath,
    label: parallel ? 'Switch to inline diff view' : 'Switch to side-by-side diff view',
  };
}

// bookmarkDrawerPosition({ bounds, innerWidth, innerHeight }) -> { left, top }
// pixel offsets for the drawer, clamped to stay on-screen with a 12px
// margin. `bounds` is the toolbar host's getBoundingClientRect() result (or
// undefined/null when unavailable). Uses `||`, not `??`, matching the
// original content.js expression exactly: a 0 (toolbar flush against the
// viewport edge) falls through to the fallback, same as an unavailable
// `bounds`. Total.
export function bookmarkDrawerPosition({ bounds, innerWidth, innerHeight }) {
  const left = Math.max(12, Math.min(innerWidth - 392, (bounds?.left || innerWidth - 420) - 382));
  const top = Math.max(12, Math.min(innerHeight - 520, bounds?.top || 72));
  return { left, top };
}
