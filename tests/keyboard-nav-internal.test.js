import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isMergeRequestPath,
  pickNavigationIndex,
  hunkStartIndices,
  isBlockedShortcutTarget,
  messageForAction,
  isCoachBlocked,
} from '../page/features/keyboard-nav.internal.js';

test('isMergeRequestPath matches a merge-request path and rejects everything else', () => {
  assert.equal(isMergeRequestPath('/group/project/-/merge_requests/42'), true);
  assert.equal(isMergeRequestPath('/group/project/-/merge_requests/42/diffs'), true);
  assert.equal(isMergeRequestPath('/group/project/-/issues'), false);
  assert.equal(isMergeRequestPath(''), false);
  assert.equal(isMergeRequestPath(undefined), false);
});

test('pickNavigationIndex: with a current cursor, wraps forward and backward', () => {
  assert.equal(pickNavigationIndex({ length: 3, currentIndex: 0, direction: 1, firstAfterIndex: -1 }), 1);
  assert.equal(pickNavigationIndex({ length: 3, currentIndex: 2, direction: 1, firstAfterIndex: -1 }), 0, 'wraps forward past the end');
  assert.equal(pickNavigationIndex({ length: 3, currentIndex: 0, direction: -1, firstAfterIndex: -1 }), 2, 'wraps backward past the start');
});

test('pickNavigationIndex: with no cursor, forward picks the first-after-viewport element or the first', () => {
  assert.equal(pickNavigationIndex({ length: 4, currentIndex: -1, direction: 1, firstAfterIndex: 2 }), 2);
  assert.equal(pickNavigationIndex({ length: 4, currentIndex: -1, direction: 1, firstAfterIndex: -1 }), 0, 'nothing past the viewport point falls back to the first element');
});

test('pickNavigationIndex: with no cursor, backward picks the element before the first-after-viewport one, or the last', () => {
  assert.equal(pickNavigationIndex({ length: 4, currentIndex: -1, direction: -1, firstAfterIndex: 2 }), 1);
  assert.equal(pickNavigationIndex({ length: 4, currentIndex: -1, direction: -1, firstAfterIndex: 0 }), 3, 'the first element is already at/past the viewport point, so backward wraps to the last');
  assert.equal(pickNavigationIndex({ length: 4, currentIndex: -1, direction: -1, firstAfterIndex: -1 }), 3, 'nothing past the viewport point falls back to the last element');
});

test('hunkStartIndices: finds the start of each run of changed rows', () => {
  assert.deepEqual(hunkStartIndices([false, true, true, false, false, true, false, true]), [1, 5, 7]);
});

test('hunkStartIndices: no changed rows is no hunks', () => {
  assert.deepEqual(hunkStartIndices([false, false, false]), []);
});

test('hunkStartIndices: an all-changed input is a single hunk starting at 0', () => {
  assert.deepEqual(hunkStartIndices([true, true, true]), [0]);
});

test('hunkStartIndices: empty input is no hunks', () => {
  assert.deepEqual(hunkStartIndices([]), []);
});

test('isBlockedShortcutTarget: the native file-search element itself always blocks', () => {
  assert.equal(isBlockedShortcutTarget({ isSearch: true, hasBlockingAncestor: false, blockingIsFormLike: false, disabled: false, readOnly: false, contentEditableAttr: null }), true);
});

test('isBlockedShortcutTarget: no blocking ancestor does not block', () => {
  assert.equal(isBlockedShortcutTarget({ isSearch: false, hasBlockingAncestor: false, blockingIsFormLike: false, disabled: false, readOnly: false, contentEditableAttr: null }), false);
});

test('isBlockedShortcutTarget: a non-form blocking ancestor (dialog) always blocks', () => {
  assert.equal(isBlockedShortcutTarget({ isSearch: false, hasBlockingAncestor: true, blockingIsFormLike: false, disabled: false, readOnly: false, contentEditableAttr: null }), true);
});

test('isBlockedShortcutTarget: an enabled, writable form control blocks', () => {
  assert.equal(isBlockedShortcutTarget({ isSearch: false, hasBlockingAncestor: true, blockingIsFormLike: true, disabled: false, readOnly: false, contentEditableAttr: null }), true);
});

test('isBlockedShortcutTarget: a disabled form control does not block', () => {
  assert.equal(isBlockedShortcutTarget({ isSearch: false, hasBlockingAncestor: true, blockingIsFormLike: true, disabled: true, readOnly: false, contentEditableAttr: null }), false);
});

test('isBlockedShortcutTarget: a read-only form control does not block', () => {
  assert.equal(isBlockedShortcutTarget({ isSearch: false, hasBlockingAncestor: true, blockingIsFormLike: true, disabled: false, readOnly: true, contentEditableAttr: null }), false);
});

test('isBlockedShortcutTarget: contenteditable="false" does not block', () => {
  assert.equal(isBlockedShortcutTarget({ isSearch: false, hasBlockingAncestor: true, blockingIsFormLike: true, disabled: false, readOnly: false, contentEditableAttr: 'false' }), false);
});

test('messageForAction: known coach-eligible actions have copy', () => {
  assert.match(messageForAction('focusFileSearch'), /file search/);
  assert.match(messageForAction('semanticJump'), /selected symbol directly/);
  assert.match(messageForAction('nextOccurrence'), /selected occurrences/);
  assert.match(messageForAction('historyBack'), /previous semantic location/);
});

test('messageForAction: hunk/file/other actions have no coach copy', () => {
  assert.equal(messageForAction('previousHunk'), undefined);
  assert.equal(messageForAction('toggleBookmark'), undefined);
  assert.equal(messageForAction('does-not-exist'), undefined);
});

test('isCoachBlocked: blocked when hidden, an overlay is open, or the toast is already showing', () => {
  assert.equal(isCoachBlocked({ hidden: false, overlayOpen: false, toastShowing: false }), false);
  assert.equal(isCoachBlocked({ hidden: true, overlayOpen: false, toastShowing: false }), true);
  assert.equal(isCoachBlocked({ hidden: false, overlayOpen: true, toastShowing: false }), true);
  assert.equal(isCoachBlocked({ hidden: false, overlayOpen: false, toastShowing: true }), true);
});
