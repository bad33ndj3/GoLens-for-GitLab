import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  dirname,
  NO_TERMS_MESSAGE,
  INCOMPLETE_MESSAGE,
  canOpen,
  searchTerms,
  blobSearchPercentage,
  packageIndexPercentage,
  termSearchMessage,
  packageIndexMessage,
  blobPathsComplete,
  candidatePackagePaths,
  completeProjectScope,
  rerunQueryKind,
  focusTargetForStatus,
  chipLabel,
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

test('blobSearchPercentage: 5-35% band across the term list', () => {
  assert.equal(blobSearchPercentage(0, 2), 5);
  assert.equal(blobSearchPercentage(1, 2), 20);
  assert.equal(blobSearchPercentage(0, 1), 5);
});

test('packageIndexPercentage: 35-95% band across the package list, guards zero packages', () => {
  assert.equal(packageIndexPercentage(0, 1), 95);
  assert.equal(packageIndexPercentage(0, 2), 65);
  assert.equal(packageIndexPercentage(1, 2), 95);
  assert.equal(packageIndexPercentage(0, 0), 95);
});

test('termSearchMessage/packageIndexMessage: verbatim phase copy', () => {
  assert.equal(termSearchMessage('Run'), 'Searching project code for Run');
  assert.equal(packageIndexMessage(0, 3), 'Indexing matching package 1 of 3');
  assert.equal(packageIndexMessage(2, 3), 'Indexing matching package 3 of 3');
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

test('focusTargetForStatus: retry on error, minimize otherwise', () => {
  assert.equal(focusTargetForStatus('error'), 'retry');
  assert.equal(focusTargetForStatus('idle'), 'minimize');
  assert.equal(focusTargetForStatus('busy'), 'minimize');
});

test('chipLabel: verbatim chip text', () => {
  assert.equal(chipLabel(0), 'Project search · 0%');
  assert.equal(chipLabel(42), 'Project search · 42%');
});

test('message constants: verbatim legacy error copy', () => {
  assert.equal(NO_TERMS_MESSAGE, 'This interface has no searchable methods, so code search cannot prove complete coverage.');
  assert.equal(INCOMPLETE_MESSAGE, 'GitLab code search could not prove complete coverage for this project.');
});
