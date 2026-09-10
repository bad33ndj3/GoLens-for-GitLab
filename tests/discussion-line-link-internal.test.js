import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  formatReviewSolution,
  formatReviewSolutionBundle,
  normalizeReviewText,
} from '../page/features/discussion-line-link.internal.js';

test('formatReviewSolution produces one escaped, paste-ready instruction', () => {
  assert.equal(formatReviewSolution({
    path: 'svc/contracting/core/main.go',
    line: 33,
    noteUrl: 'https://gitlab.example/group/project/-/merge_requests/42#note_7',
    author: '@reviewer',
    comment: 'This middleware\nseems "wrong".',
    solution: 'Use middleware x.',
    accepted: true,
  }), 'svc/contracting/core/main.go:33 [https://gitlab.example/group/project/-/merge_requests/42#note_7 @reviewer - "This middleware\\nseems \\"wrong\\"."] - Action: Implement exactly what the reviewer requested. Optional guidance: "Use middleware x."');
});

test('formatReviewSolutionBundle includes accepted comments without optional guidance', () => {
  const complete = {
    path: 'a.go', line: 1, noteUrl: 'https://gitlab.example/mr#note_1',
    author: 'reviewer', comment: 'Change this.', solution: '', accepted: true,
  };
  assert.equal(formatReviewSolutionBundle([complete, { ...complete, accepted: false }]), formatReviewSolution(complete));
  assert.match(formatReviewSolution(complete), /Implement exactly what the reviewer requested\.$/);
  assert.equal(formatReviewSolution({ ...complete, noteUrl: '' }), '');
});

test('normalizeReviewText preserves suggested-change code and trims display whitespace', () => {
  assert.equal(
    normalizeReviewText('Please use this.\r\n\r\nSuggested change:\n  return middlewareX(next)  \n'),
    'Please use this.\n\nSuggested change:\n  return middlewareX(next)'
  );
});
