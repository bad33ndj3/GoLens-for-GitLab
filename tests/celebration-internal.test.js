import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isGitLabPage,
  isMergeRequestPath,
  mergeRequestIID,
  projectFromPathname,
  normalizeCelebrationStatus,
  normalizeDiscussionStatus,
  celebrationReached,
  isFridayAfterFour,
  momentFor,
  matchMergeRequestAction,
  matchDiscussionResolveAction,
  matchCreateMergeRequestAction,
  nextPageNumber,
  discussionUnresolvedCount,
  confettiPieces,
  celebrationAnchor,
  CELEBRATION_POLL_INTERVALS_MS,
  FRIDAY_MR_CREATE_STORAGE_KEY,
} from '../page/features/celebration.internal.js';

test('isGitLabPage() requires either the gitlab global or both csrf meta and an app shell', () => {
  assert.equal(isGitLabPage({ hasGitlabGlobal: true, hasCsrfMeta: false, hasAppShell: false }), true);
  assert.equal(isGitLabPage({ hasGitlabGlobal: false, hasCsrfMeta: true, hasAppShell: true }), true);
  assert.equal(isGitLabPage({ hasGitlabGlobal: false, hasCsrfMeta: true, hasAppShell: false }), false);
  assert.equal(isGitLabPage({ hasGitlabGlobal: false, hasCsrfMeta: false, hasAppShell: false }), false);
});

test('isMergeRequestPath() matches only merge-request paths, tolerating missing input', () => {
  assert.equal(isMergeRequestPath('/group/project/-/merge_requests/42'), true);
  assert.equal(isMergeRequestPath('/group/project/-/merge_requests/42/diffs'), true);
  assert.equal(isMergeRequestPath('/group/project/-/issues/1'), false);
  assert.equal(isMergeRequestPath(''), false);
  assert.equal(isMergeRequestPath(undefined), false);
});

test('mergeRequestIID() extracts the numeric IID, or "" when absent', () => {
  assert.equal(mergeRequestIID('/group/project/-/merge_requests/42/diffs'), '42');
  assert.equal(mergeRequestIID('/group/project/-/issues/1'), '');
  assert.equal(mergeRequestIID(undefined), '');
});

test('projectFromPathname() derives the project path above the "-" marker, or null', () => {
  assert.deepEqual(projectFromPathname('/group/sub/project/-/merge_requests/42'), { project: 'group/sub/project' });
  assert.equal(projectFromPathname('/-/merge_requests/42'), null);
  assert.equal(projectFromPathname('/group'), null);
});

test('normalizeCelebrationStatus() lowercases state and dedupes approvers as strings', () => {
  assert.deepEqual(
    normalizeCelebrationStatus({ state: 'OPENED', approvers: [7, '7', 8] }),
    { state: 'opened', approvers: ['7', '8'] },
  );
  assert.deepEqual(normalizeCelebrationStatus({}), { state: '', approvers: [] });
});

test('normalizeDiscussionStatus() clamps unresolved to a non-negative number', () => {
  assert.deepEqual(normalizeDiscussionStatus({ unresolved: 3 }), { unresolved: 3 });
  assert.deepEqual(normalizeDiscussionStatus({ unresolved: -1 }), { unresolved: 0 });
  assert.deepEqual(normalizeDiscussionStatus({}), { unresolved: 0 });
});

test('celebrationReached("merged") fires only on the opened -> merged transition', () => {
  assert.equal(celebrationReached('merged', { state: 'opened', approvers: [] }, { state: 'merged', approvers: [] }), true);
  assert.equal(celebrationReached('merged', { state: 'merged', approvers: [] }, { state: 'merged', approvers: [] }), false);
});

test('celebrationReached("approved") fires only when a new approver appears', () => {
  assert.equal(celebrationReached('approved', { state: 'opened', approvers: ['1'] }, { state: 'opened', approvers: ['1', '2'] }), true);
  assert.equal(celebrationReached('approved', { state: 'opened', approvers: ['1'] }, { state: 'opened', approvers: ['1'] }), false);
});

test('isFridayAfterFour() is true only Friday from 16:00 onward', () => {
  assert.equal(isFridayAfterFour(new Date(2026, 6, 17, 16, 0, 0)), true);
  assert.equal(isFridayAfterFour(new Date(2026, 6, 17, 15, 59, 0)), false);
  assert.equal(isFridayAfterFour(new Date(2026, 6, 16, 16, 30, 0)), false);
});

test('momentFor() returns the descriptor for known kinds, undefined otherwise', () => {
  assert.deepEqual(momentFor('approved'), { asset: 'golens-approved.png', message: 'Approval confirmed', duration: 1700 });
  assert.equal(momentFor('nonsense'), undefined);
});

test('matchMergeRequestAction() classifies approve/merge buttons, excluding unapprove', () => {
  assert.equal(matchMergeRequestAction({ testID: 'approve-button', label: 'approve' }), 'approved');
  assert.equal(matchMergeRequestAction({ testID: 'unapprove-button', label: 'revoke approval' }), '');
  assert.equal(matchMergeRequestAction({ testID: 'merge-button', label: 'merge' }), 'merged');
  assert.equal(matchMergeRequestAction({ testID: 'unrelated-button', label: 'close' }), '');
});

test('matchDiscussionResolveAction() classifies resolve buttons, excluding reopen/unresolve', () => {
  assert.equal(matchDiscussionResolveAction({ testID: 'resolve-thread', label: 'resolve thread' }), true);
  assert.equal(matchDiscussionResolveAction({ testID: 'resolve-thread', label: 'reopen thread' }), false);
  assert.equal(matchDiscussionResolveAction({ testID: 'unrelated', label: '' }), false);
});

test('matchCreateMergeRequestAction() classifies the create-MR button', () => {
  assert.equal(matchCreateMergeRequestAction({ testID: 'create-merge-request-button', label: '' }), true);
  assert.equal(matchCreateMergeRequestAction({ testID: '', label: 'create merge request' }), true);
  assert.equal(matchCreateMergeRequestAction({ testID: '', label: 'close' }), false);
});

test('nextPageNumber() prefers the x-next-page header, falling back to a full-page heuristic', () => {
  assert.equal(nextPageNumber('3', 1, 100), 3);
  assert.equal(nextPageNumber('', 1, 100), 2);
  assert.equal(nextPageNumber('', 1, 40), 0);
});

test('discussionUnresolvedCount() counts discussions with an unresolved resolvable note', () => {
  const discussions = [
    { notes: [{ resolvable: true, resolved: false }] },
    { notes: [{ resolvable: true, resolved: true }] },
    { notes: [{ resolvable: false, resolved: false }] },
    { notes: [] },
  ];
  assert.equal(discussionUnresolvedCount(discussions), 1);
  assert.equal(discussionUnresolvedCount(null), 0);
});

test('confettiPieces() is deterministic and produces the requested count', () => {
  const pieces = confettiPieces(48);
  assert.equal(pieces.length, 48);
  assert.deepEqual(pieces[0], { x: 11, drift: -70, delay: 0, fall: 3000, turn: 360 });
  assert.deepEqual(confettiPieces(48)[0], pieces[0]);
});

test('celebrationAnchor() clamps to the viewport and returns null without a controls rect', () => {
  assert.equal(celebrationAnchor({ controlsRect: null, viewportWidth: 1200, viewportHeight: 800, approvalWidth: 144 }), null);
  const anchor = celebrationAnchor({
    controlsRect: { left: 20, top: 20, height: 40 },
    viewportWidth: 1200,
    viewportHeight: 800,
    approvalWidth: 144,
  });
  assert.equal(anchor.left, 12);
  assert.equal(anchor.top, 12);
});

test('CELEBRATION_POLL_INTERVALS_MS/FRIDAY_MR_CREATE_STORAGE_KEY match legacy constants', () => {
  assert.deepEqual(CELEBRATION_POLL_INTERVALS_MS, [250, 500, 750, 1000, 1500, 2000, 2500]);
  assert.equal(FRIDAY_MR_CREATE_STORAGE_KEY, 'golensFridayMergeRequestCreation');
});
