import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizePath,
  bookmarkRangeLabel,
  bookmarkLabel,
  snapshotRecords,
  bookmarkRecoveryCandidates,
  recoveryOutcome,
} from '../page/features/bookmarks.internal.js';

test('normalizes GitLab file-title spacing and bidi markers', () => {
  assert.equal(normalizePath('svc/ snapshot/\u200e pkg/search.go'), 'svc/snapshot/pkg/search.go');
});

test('formats single-line and multi-line bookmark ranges', () => {
  assert.equal(bookmarkRangeLabel({ startLine: 12, endLine: 12 }), 'L12');
  assert.equal(bookmarkRangeLabel({ startLine: 12, endLine: 14 }), 'L12–14');
});

test('bookmark label prefers trimmed context text, falls back to path · range', () => {
  const record = { location: { path: 'pkg/review.go', startLine: 3, endLine: 3 } };
  assert.equal(bookmarkLabel(record, '  return   value  '), 'return value');
  assert.equal(bookmarkLabel(record, ''), 'pkg/review.go · L3');
  const long = 'x'.repeat(120);
  assert.equal(bookmarkLabel(record, long).length, 80);
});

test('snapshotRecords partitions current vs. stale by scope head and attaches labels', () => {
  const scope = { headSha: 'a'.repeat(40) };
  const records = [
    { id: 'cur', scope: { headSha: scope.headSha }, location: { path: 'a.go', startLine: 1, endLine: 1 } },
    { id: 'old', scope: { headSha: 'b'.repeat(40) }, location: { path: 'b.go', startLine: 2, endLine: 2 } },
  ];
  const snapshot = snapshotRecords(records, scope, { cur: 'return nil', old: '' });
  assert.equal(snapshot.scope, scope);
  assert.deepEqual(snapshot.current.map((r) => r.id), ['cur']);
  assert.deepEqual(snapshot.stale.map((r) => r.id), ['old']);
  assert.equal(snapshot.current[0].label, 'return nil');
  assert.equal(snapshot.stale[0].label, 'b.go · L2');
  assert.equal(snapshot.current[0].stale, false);
  assert.equal(snapshot.stale[0].stale, true);
});

test('snapshotRecords treats every record as stale when there is no current scope', () => {
  const records = [{ id: 'x', scope: { headSha: 'a'.repeat(40) }, location: { path: 'a.go', startLine: 1, endLine: 1 } }];
  const snapshot = snapshotRecords(records, null, {});
  assert.equal(snapshot.current.length, 0);
  assert.equal(snapshot.stale.length, 1);
});

// Deterministic stand-in for GoLensBookmarks.hashText: distinct inputs get
// distinct hashes, same input gets the same hash, matching everything these
// tests need from a real hash function.
async function hashText(value) {
  return `h:${value}`;
}

test('recovers a moved bookmark from a single safe context match', async () => {
  const record = {
    location: { path: 'pkg/review.go', side: 'new', startLine: 2, endLine: 2 },
    anchor: {
      symbol: 'Target',
      selectionHash: await hashText('Target(old)'),
      beforeHash: await hashText('before()'),
      afterHash: await hashText('after()'),
    },
  };
  const moved = ['header', 'before()', 'Target(new)', 'after()', 'footer'];
  const candidates = await bookmarkRecoveryCandidates(moved, record, hashText);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].index, 2);
  assert.notEqual(candidates[0].anchor.selectionHash, record.anchor.selectionHash, 'the edited line itself is still a safe adjacent-context match');
  const outcome = recoveryOutcome(candidates, 1);
  assert.deepEqual(outcome, { kind: 'found', startLine: 3, endLine: 3, anchor: candidates[0].anchor });
});

test('two equally-good matches are ambiguous, not a guess', async () => {
  const record = {
    location: { path: 'pkg/review.go', side: 'new', startLine: 2, endLine: 2 },
    anchor: {
      symbol: 'Target',
      selectionHash: await hashText('Target(old)'),
      beforeHash: await hashText('before()'),
      afterHash: await hashText('after()'),
    },
  };
  const moved = ['header', 'before()', 'Target(new)', 'after()', 'footer'];
  const candidates = await bookmarkRecoveryCandidates([...moved, ...moved], record, hashText);
  assert.equal(candidates.length, 2);
  assert.deepEqual(recoveryOutcome(candidates, 1), { kind: 'ambiguous' });
});

test('the stored symbol remains a required constraint — no match without it', async () => {
  const record = {
    location: { path: 'pkg/review.go', side: 'new', startLine: 2, endLine: 2 },
    anchor: {
      symbol: 'Target',
      selectionHash: await hashText('Target(old)'),
      beforeHash: await hashText('before()'),
      afterHash: await hashText('after()'),
    },
  };
  const candidates = await bookmarkRecoveryCandidates(['before()', 'Other()', 'after()'], record, hashText);
  assert.equal(candidates.length, 0);
  assert.deepEqual(recoveryOutcome(candidates, 1), { kind: 'missing' });
});

test('recovery candidate at index 0 has no beforeHash to match, only afterHash', async () => {
  const record = {
    location: { path: 'pkg/review.go', side: 'new', startLine: 2, endLine: 2 },
    anchor: { symbol: '', selectionHash: await hashText('Target()'), beforeHash: '', afterHash: await hashText('after()') },
  };
  const lines = ['Target()', 'after()'];
  const candidates = await bookmarkRecoveryCandidates(lines, record, hashText);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].index, 0);
});

test('recovery candidate at the final index has no afterHash to match, only beforeHash', async () => {
  const record = {
    location: { path: 'pkg/review.go', side: 'new', startLine: 2, endLine: 2 },
    anchor: { symbol: '', selectionHash: await hashText('Target()'), beforeHash: await hashText('before()'), afterHash: '' },
  };
  const lines = ['before()', 'Target()'];
  const candidates = await bookmarkRecoveryCandidates(lines, record, hashText);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].index, 1);
});

test('a multi-line selection reuses the per-line hash instead of rehashing when length is 1', async () => {
  let calls = 0;
  const countingHash = async (value) => { calls++; return hashText(value); };
  const record = {
    location: { path: 'pkg/review.go', side: 'new', startLine: 2, endLine: 2 },
    anchor: { symbol: '', selectionHash: await hashText('Target()'), beforeHash: await hashText('before()'), afterHash: await hashText('after()') },
  };
  const lines = ['before()', 'Target()', 'after()'];
  calls = 0;
  const candidates = await bookmarkRecoveryCandidates(lines, record, countingHash);
  assert.equal(candidates.length, 1);
  // 3 line hashes, no extra rehash of the (length===1) selection itself.
  assert.equal(calls, 3);
});
