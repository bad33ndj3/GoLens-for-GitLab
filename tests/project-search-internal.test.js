import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dirname,
  NO_TERMS_MESSAGE,
  INCOMPLETE_MESSAGE,
  canOpen,
  searchTerms,
  blobPathsComplete,
  candidatePackagePaths,
  completeProjectScope,
  rerunQueryKind,
} from '../page/features/project-search.internal.js';

test('dirname: directory portion of a slash-separated path, "" for root-level', () => {
  assert.equal(dirname('service/run.go'), 'service');
  assert.equal(dirname('service/internal/run.go'), 'service/internal');
  assert.equal(dirname('run.go'), '');
});

test('canOpen: true only when result.request.ref is present', () => {
  assert.equal(canOpen({ request: { ref: 'a'.repeat(40) } }), true);
  assert.equal(canOpen({ request: {} }), false);
  assert.equal(canOpen({}), false);
  assert.equal(canOpen(null), false);
  assert.equal(canOpen(undefined), false);
});

test('searchTerms: a references result searches for the definition name', () => {
  assert.deepEqual(
    searchTerms({ request: { kind: 'references', definition: { name: 'Run' } } }),
    { kind: 'terms', terms: ['Run'] },
  );
});

test('searchTerms: a non-references result uses the RESULT-level searchTerms (sibling of request, not inside it)', () => {
  assert.deepEqual(
    searchTerms({ request: { kind: 'implementations' }, searchTerms: ['Runner', 'Start'] }),
    { kind: 'terms', terms: ['Runner', 'Start'] },
  );
  // A searchTerms field nested inside request must NOT be picked up.
  assert.deepEqual(
    searchTerms({ request: { kind: 'implementations', searchTerms: ['wrong-spot'] } }),
    { kind: 'noTerms' },
  );
});

test('searchTerms: empty term list is the noTerms domain outcome, not a throw', () => {
  assert.deepEqual(searchTerms({ request: { kind: 'implementations' }, searchTerms: [] }), { kind: 'noTerms' });
  assert.deepEqual(searchTerms({ request: { kind: 'implementations' } }), { kind: 'noTerms' });
  assert.deepEqual(searchTerms({ request: { kind: 'references', definition: {} } }), { kind: 'noTerms' });
  assert.deepEqual(searchTerms({}), { kind: 'noTerms' });
  assert.deepEqual(searchTerms(null), { kind: 'noTerms' });
});

test('blobPathsComplete: only "complete" status counts', () => {
  assert.equal(blobPathsComplete('complete'), true);
  assert.equal(blobPathsComplete('limited'), false);
  assert.equal(blobPathsComplete('unavailable'), false);
});

test('candidatePackagePaths: sorted, de-duplicated directories', () => {
  assert.deepEqual(
    candidatePackagePaths(['b/x.go', 'a/y.go', 'b/z.go', 'root.go']),
    ['', 'a', 'b'],
  );
});

test('completeProjectScope: byte-identical shape to the legacy scope object', () => {
  assert.deepEqual(completeProjectScope(7), {
    kind: 'completeProjectSearch',
    packageCount: 7,
    complete: true,
    searchStatus: 'complete',
    strategy: 'gitlabCodeSearch',
  });
});

test('rerunQueryKind: references vs implementations dispatch', () => {
  assert.equal(rerunQueryKind({ kind: 'references' }), 'references');
  assert.equal(rerunQueryKind({ kind: 'implementations' }), 'implementations');
  assert.equal(rerunQueryKind({}), 'implementations');
});

test('message constants: verbatim legacy error copy', () => {
  assert.equal(NO_TERMS_MESSAGE, 'This interface has no searchable methods, so code search cannot prove complete coverage.');
  assert.equal(INCOMPLETE_MESSAGE, 'GitLab code search could not prove complete coverage for this project.');
});
