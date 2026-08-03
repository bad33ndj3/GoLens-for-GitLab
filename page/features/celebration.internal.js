// page/features/celebration.internal.js — pure decision core for
// page/features/celebration.js (ticket 14; contract per ticket 04 §1's
// internal-seam convention, mirrored from generated-files.internal.js). No
// DOM, no chrome.*, no timers, no `fetch`.

// isGitLabPage/isMergeRequestPath: deliberate duplicates of content.js's own
// isGitLab()/isMergeRequest() (same duplication precedent as
// generated-files.internal.js's isMergeRequestDiff and
// settings-overlay.internal.js's isGitLabPage/isMergeRequestPath — a
// one-line, unlikely-to-drift predicate, not worth a shared platform module
// for one ticket's sake). Total.
export function isGitLabPage({ hasGitlabGlobal, hasCsrfMeta, hasAppShell }) {
  return Boolean(hasGitlabGlobal || (hasCsrfMeta && hasAppShell));
}

export function isMergeRequestPath(pathname) {
  return /\/-\/merge_requests\/\d+/.test(pathname || '');
}

// mergeRequestIID(pathname) -> the numeric IID segment, or '' when absent.
// Mirrors go-navigation.js's own mergeRequestIID().
export function mergeRequestIID(pathname) {
  return (pathname || '').match(/\/-\/merge_requests\/(\d+)/)?.[1] || '';
}

// projectFromPathname(pathname) -> { project } | null. Mirrors
// go-navigation.js's own projectContext(), minus the origin-derived
// `projectBase` field this module never needs.
export function projectFromPathname(pathname) {
  const parts = (pathname || '').split('/').filter(Boolean);
  const marker = parts.indexOf('-');
  if (marker < 2) return null;
  return { project: parts.slice(0, marker).join('/') };
}

// normalizeCelebrationStatus/normalizeDiscussionStatus: byte-identical to
// content.js's former normalizers. Total.
export function normalizeCelebrationStatus(result) {
  return {
    state: String(result?.state || '').toLowerCase(),
    approvers: [...new Set((result?.approvers || []).map(String))],
  };
}

export function normalizeDiscussionStatus(result) {
  return { unresolved: Math.max(0, Number(result?.unresolved) || 0) };
}

// celebrationReached(action, baseline, current) -> whether `current` shows
// the outcome `action` was polling for. Byte-identical to content.js's
// former celebrationReached(). Total.
export function celebrationReached(action, baseline, current) {
  if (action === 'merged') return baseline.state !== 'merged' && current.state === 'merged';
  const previousApprovers = new Set(baseline.approvers);
  return current.approvers.some((approver) => !previousApprovers.has(approver));
}

// isFridayAfterFour(date) -> whether `date` falls in the Friday-beer-kart
// window. Byte-identical to content.js's former isFridayAfterFour(). Total.
export function isFridayAfterFour(date = new Date()) {
  return date.getDay() === 5 && date.getHours() >= 16;
}

export const CELEBRATION_POLL_INTERVALS_MS = [250, 500, 750, 1000, 1500, 2000, 2500];
export const FRIDAY_MR_CREATE_STORAGE_KEY = 'golensFridayMergeRequestCreation';

// momentFor(kind) -> the mascot-moment descriptor for a closed set of kinds,
// or undefined for anything else. Byte-identical table to content.js's
// former `moments` map inside showMascotMoment(). Total.
const MASCOT_MOMENTS = {
  approved: { asset: 'golens-approved.png', message: 'Approval confirmed', duration: 1700 },
  merged: { asset: 'golens-merged.png', message: 'Merge confirmed', duration: 2000 },
  pitstop: { asset: 'golens-pitstop.png', message: 'Source cache ready', duration: 2100 },
  resolved: { asset: 'golens-discussions-resolved.png', message: 'All discussions resolved', duration: 1900 },
  friday: { asset: 'golens-friday-beer.png', message: 'Friday review complete. Cheers!', duration: 5800 },
};
export function momentFor(kind) {
  return MASCOT_MOMENTS[kind];
}

// matchMergeRequestAction/matchDiscussionResolveAction/matchCreateMergeRequestAction:
// pure string matchers taking { testID, label } (both already lowercased),
// split out of content.js's DOM-touching buttonDetailsForTarget() +
// mergeRequestActionForTarget()/discussionResolveActionForTarget()/
// createMergeRequestActionForTarget(). Regexes byte-identical to the
// originals. Total.
export function matchMergeRequestAction({ testID, label }) {
  const combined = `${testID} ${label}`;
  if (/unapprove|revoke(?: my)? approval/.test(combined)) return '';
  if (/(?:^|[-_])approve(?:[-_]|$)/.test(testID) || /^(?:approve|submit approval)(?:\s|$)/.test(label)) return 'approved';
  if (/(?:^|[-_])merge(?:[-_]|$)/.test(testID) || /^(?:merge|merge immediately|merge when pipeline succeeds|set to auto-merge)(?:\s|$)/.test(label)) return 'merged';
  return '';
}

export function matchDiscussionResolveAction({ testID, label }) {
  const combined = `${testID} ${label}`;
  if (/reopen|unresolve/.test(combined)) return false;
  return /resolve[-_](?:discussion|thread)/.test(testID)
    || /^(?:resolve discussion|resolve thread)(?:\s|$)/.test(label);
}

export function matchCreateMergeRequestAction({ testID, label }) {
  return /create[-_]merge[-_]request/.test(testID)
    || /^create merge request(?:\s|$)/.test(label);
}

// nextPageNumber(nextPageHeader, currentPage, entriesLength) -> the next
// GitLab API page to fetch, or 0 when done. Mirrors go-navigation.js's own
// nextPageNumber(), taking the already-read header string instead of a
// Response so this stays fetch-free. Total.
export function nextPageNumber(nextPageHeader, currentPage, entriesLength) {
  if (/^\d+$/.test(nextPageHeader || '')) return Number(nextPageHeader);
  return entriesLength === 100 ? currentPage + 1 : 0;
}

// discussionUnresolvedCount(discussions) -> count of discussions with at
// least one resolvable, unresolved note. Mirrors the filter go-navigation.js
// applied inline inside mergeRequestDiscussionStatus(). Total.
export function discussionUnresolvedCount(discussions) {
  if (!Array.isArray(discussions)) return 0;
  return discussions.filter((discussion) =>
    Array.isArray(discussion?.notes)
    && discussion.notes.some((note) => note?.resolvable && !note?.resolved)
  ).length;
}

// confettiPieces(count) -> deterministic per-piece style values for the
// Friday celebration's confetti field. Same index-based formulas as
// content.js's former inline Array.from(...) map. Total.
export function confettiPieces(count) {
  return Array.from({ length: count }, (_, index) => ({
    x: (index * 37 + 11) % 101,
    drift: (index * 53) % 141 - 70,
    delay: (index * 89) % 1400,
    fall: 3000 + (index * 137) % 1000,
    turn: 360 + (index * 47) % 540,
  }));
}

// celebrationAnchor({ controlsRect, viewportWidth, viewportHeight, approvalWidth })
// -> { left, top } | null. Mirrors content.js's former inline positioning
// for the approved/resolved sprites, anchored off the controls panel's
// bounding rect. Total.
export function celebrationAnchor({ controlsRect, viewportWidth, viewportHeight, approvalWidth }) {
  if (!controlsRect) return null;
  const left = Math.max(12, Math.min(viewportWidth - approvalWidth - 12, controlsRect.left - approvalWidth + 18));
  const top = Math.max(12, Math.min(viewportHeight - approvalWidth - 12, controlsRect.top + controlsRect.height / 2 - approvalWidth / 2));
  return { left, top };
}
