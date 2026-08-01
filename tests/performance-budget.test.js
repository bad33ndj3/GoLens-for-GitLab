import assert from 'node:assert/strict';
import test from 'node:test';

import { performanceReport } from '../scripts/performance-budget.mjs';

const complete = (value) => ({ complete: true, ...value });
const baseline = {
  largeMrInitializationMs: 100,
  mutationReconciliationMs: 100,
  fullProjectIndexMs: 100,
  relatedCacheProcessingMs: 100,
  fullProjectCacheProcessingMs: 100,
  semanticHeapDeltaBytes: 1000,
  hoverSemanticP95Ms: 0.5,
  jumpSemanticP95Ms: 1,
  streamedDiffMaximumDelayMs: 20,
  workerWakeMs: 100,
};
const ten = (legacy, rewrite) => Array.from({ length: 10 }, () => ({
  legacy: complete({ ...baseline, ...legacy }),
  rewrite: complete({ ...baseline, ...rewrite }),
}));

test('reports each performance path independently using the accepted budgets', () => {
  const report = performanceReport(ten({}, {
    largeMrInitializationMs: 120,
    mutationReconciliationMs: 120,
    fullProjectIndexMs: 120,
    relatedCacheProcessingMs: 120,
    fullProjectCacheProcessingMs: 120,
    semanticHeapDeltaBytes: 1150,
    hoverSemanticP95Ms: 1,
    jumpSemanticP95Ms: 2,
    streamedDiffMaximumDelayMs: 39.9,
    workerWakeMs: 125,
  }), ['workerWakeMs']);

  assert.equal('score' in report, false);
  assert.equal(report.paths.largeMrInitialization.passed, true);
  assert.equal(report.paths.semanticHeap.passed, true);
  assert.equal(report.paths.hoverP95.passed, true);
  assert.equal(report.paths.implementationP95.passed, true);
  assert.equal(report.paths.streamedDiffDelay.passed, true);
  assert.equal(report.paths.workerWake.passed, true);
});

test('fails primary, absolute, and environment-dependent regressions at their strict boundaries', () => {
  const report = performanceReport(ten({}, {
    largeMrInitializationMs: 120.01,
    mutationReconciliationMs: 120.01,
    fullProjectIndexMs: 120.01,
    relatedCacheProcessingMs: 120.01,
    fullProjectCacheProcessingMs: 120.01,
    semanticHeapDeltaBytes: 1150.01,
    hoverSemanticP95Ms: 1.01,
    jumpSemanticP95Ms: 2.01,
    streamedDiffMaximumDelayMs: 40,
    workerWakeMs: 125.01,
  }), ['workerWakeMs']);

  assert.equal(Object.values(report.paths).every(({ passed }) => !passed), true);
});

test('rejects partial or incomplete comparisons before calculating budgets', () => {
  assert.throws(() => performanceReport(ten({}, {}).slice(1)), /exactly 10 paired samples/);
  const samples = ten({}, {});
  samples[4].rewrite.complete = false;
  assert.throws(() => performanceReport(samples), /incomplete rewrite sample 5/);
});
