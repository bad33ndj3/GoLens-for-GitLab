import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_COUNT = 10;
const PRIMARY_PATHS = {
  largeMrInitialization: 'largeMrInitializationMs',
  mutationReconciliation: 'mutationReconciliationMs',
  fullProjectIndex: 'fullProjectIndexMs',
  relatedCacheProcessing: 'relatedCacheProcessingMs',
  fullProjectCacheProcessing: 'fullProjectCacheProcessingMs',
};

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length / 2) - 1];
}

function maximum(values) {
  return Math.max(...values);
}

function values(samples, side, metric) {
  return samples.map((sample) => {
    const value = sample[side][metric];
    assert.ok(Number.isFinite(value), `invalid ${side} ${metric}`);
    return value;
  });
}

function comparison(samples, metric, budget, statistic = median) {
  const legacy = statistic(values(samples, 'legacy', metric));
  const rewrite = statistic(values(samples, 'rewrite', metric));
  const maximum = budget(legacy);
  return { metric, statistic: statistic === median ? 'median' : 'maximum', legacy, rewrite, budget: maximum, passed: rewrite <= maximum };
}

export function performanceReport(samples, environmentMetrics = []) {
  assert.equal(samples.length, SAMPLE_COUNT, 'performance comparison requires exactly 10 paired samples');
  for (const [index, sample] of samples.entries()) {
    assert.equal(sample.legacy.complete, true, `incomplete legacy sample ${index + 1}`);
    assert.equal(sample.rewrite.complete, true, `incomplete rewrite sample ${index + 1}`);
  }

  const paths = Object.fromEntries(Object.entries(PRIMARY_PATHS).map(([name, metric]) => [
    name,
    comparison(samples, metric, (legacy) => Math.max(legacy * 1.2, legacy + 5)),
  ]));
  paths.semanticHeap = comparison(samples, 'semanticHeapDeltaBytes', (legacy) => legacy * 1.15);
  paths.hoverP95 = comparison(samples, 'hoverSemanticP95Ms', () => 1);
  paths.implementationP95 = comparison(samples, 'jumpSemanticP95Ms', () => 2);
  if (samples.every(({ rewrite }) => Number.isFinite(rewrite.streamedDiffMaximumDelayMs))) {
    paths.streamedDiffDelay = comparison(samples, 'streamedDiffMaximumDelayMs', () => 40, maximum);
    paths.streamedDiffDelay.passed = paths.streamedDiffDelay.rewrite < 40;
  }
  for (const metric of environmentMetrics) {
    const name = metric.replace(/Ms$/, '');
    const path = comparison(samples, metric, () => Infinity);
    path.budget = { relative: 1.2, additiveMs: 25 };
    path.passed = path.rewrite <= path.legacy * 1.2 || path.rewrite <= path.legacy + 25;
    paths[name] = path;
  }
  return {
    schema: 1,
    runtime: { node: process.version, platform: `${process.platform}-${process.arch}`, samples: SAMPLE_COUNT },
    passed: Object.values(paths).every((path) => path.passed),
    paths,
  };
}

function sample(command, args) {
  const child = spawnSync(command, args, { cwd: root, encoding: 'utf8', timeout: 120_000 });
  if (child.status !== 0) throw new Error(child.stderr || child.stdout || 'performance sample failed');
  return JSON.parse(child.stdout.trim());
}

function sampleReport(samples, side) {
  const metrics = Object.keys(samples[0][side]).filter((name) => name !== 'complete');
  return {
    schema: 1,
    runtime: { node: process.version, platform: `${process.platform}-${process.arch}`, samples: SAMPLE_COUNT },
    metrics: Object.fromEntries(metrics.map((metric) => [metric, { median: median(values(samples, side, metric)) }])),
    samples: samples.map((pair) => pair[side]),
  };
}

async function main() {
  const samples = [];
  for (let index = 0; index < SAMPLE_COUNT; index++) {
    samples.push({
      legacy: sample(process.execPath, ['--expose-gc', 'experiments/legacy-performance-baseline.mjs', '--sample']),
      rewrite: sample(process.execPath, ['--expose-gc', '--experimental-strip-types', 'experiments/rewrite-performance-sample.mjs']),
    });
  }
  const reports = {
    legacy: sampleReport(samples, 'legacy'),
    rewrite: sampleReport(samples, 'rewrite'),
    comparison: performanceReport(samples),
  };
  const output = join(root, 'dist', 'performance');
  await mkdir(output, { recursive: true });
  await Promise.all(Object.entries(reports).map(([name, report]) => (
    writeFile(join(output, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`)
  )));
  console.log(JSON.stringify(reports.comparison, null, 2));
  if (!reports.comparison.passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
  });
}
