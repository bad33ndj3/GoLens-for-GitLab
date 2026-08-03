#!/usr/bin/env node
// Performance benchmark runner for GoLens hot paths.
//
// Usage:
//   npm run bench -- [--label <name>] [--out <path.json>] [--compare <baseline.json>]
//                     [--markdown <path.md>] [--filter <substring>]
//
// Discovers every `tests/benchmarks/*.bench.mjs` module, each of which must
// export `benchmarks`: an array of
//   { name, category, setup?, run, iterations?, warmup? }
// `setup` runs once per case, outside the timed loop, and its return value
// (the "context") is passed to every `run(ctx)` call. `run` may be async.
//
// This script is deliberately dependency-free (Node core only) so it runs
// the same way in CI as on a laptop.

import { readdir } from 'node:fs/promises';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_ITERATIONS = 30;
const DEFAULT_WARMUP = 5;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BENCH_DIR = join(ROOT, 'tests', 'benchmarks');

function parseArgs(argv) {
  const args = { label: 'run', out: '', compare: '', markdown: '', filter: '' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--label') args.label = argv[++index];
    else if (arg === '--out') args.out = argv[++index];
    else if (arg === '--compare') args.compare = argv[++index];
    else if (arg === '--markdown') args.markdown = argv[++index];
    else if (arg === '--filter') args.filter = argv[++index];
  }
  return args;
}

async function discoverBenchmarkModules() {
  const entries = await readdir(BENCH_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.bench.mjs'))
    .map((entry) => join(BENCH_DIR, entry.name))
    .sort();
}

async function loadCases(filter) {
  const modulePaths = await discoverBenchmarkModules();
  const cases = [];
  for (const modulePath of modulePaths) {
    const module = await import(pathToFileURL(modulePath).href);
    if (!Array.isArray(module.benchmarks)) {
      throw new Error(`${modulePath} does not export a "benchmarks" array`);
    }
    for (const definition of module.benchmarks) {
      if (!definition?.name || typeof definition.run !== 'function') {
        throw new Error(`${modulePath} exports an invalid benchmark case`);
      }
      if (filter && !definition.name.includes(filter)) continue;
      cases.push({ ...definition, sourceFile: modulePath });
    }
  }
  return cases;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1));
  return sorted[index];
}

async function runCase(definition) {
  const iterations = definition.iterations || DEFAULT_ITERATIONS;
  const warmup = definition.warmup ?? DEFAULT_WARMUP;
  const context = definition.setup ? await definition.setup() : undefined;

  for (let index = 0; index < warmup; index++) {
    await definition.run(context);
  }

  const samples = [];
  for (let index = 0; index < iterations; index++) {
    const start = performance.now();
    await definition.run(context);
    samples.push(performance.now() - start);
  }

  const medianMs = median(samples);
  const p95Ms = percentile(samples, 0.95);
  return {
    name: definition.name,
    category: definition.category || 'uncategorized',
    iterations,
    warmup,
    medianMs,
    p95Ms,
    minMs: Math.min(...samples),
    maxMs: Math.max(...samples),
    opsPerSec: medianMs > 0 ? 1000 / medianMs : Infinity,
  };
}

function header(label) {
  return {
    label,
    timestamp: new Date().toISOString(),
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpu: cpus()[0]?.model || 'unknown',
    cpuCount: cpus().length,
  };
}

function formatMs(value) {
  return value.toFixed(value < 10 ? 3 : 2);
}

function printResultsTable(results) {
  const nameWidth = Math.max(4, ...results.map((result) => result.name.length));
  console.log(`${'name'.padEnd(nameWidth)}  median(ms)  p95(ms)  ops/s`);
  for (const result of results) {
    console.log(
      `${result.name.padEnd(nameWidth)}  ${formatMs(result.medianMs).padStart(10)}  `
      + `${formatMs(result.p95Ms).padStart(7)}  ${Math.round(result.opsPerSec).toString().padStart(8)}`,
    );
  }
}

function deltaPercent(baselineMs, currentMs) {
  if (!(baselineMs > 0)) return null;
  return ((currentMs - baselineMs) / baselineMs) * 100;
}

function buildComparison(baseline, current) {
  const baselineByName = new Map((baseline.results || []).map((result) => [result.name, result]));
  const rows = [];
  for (const result of current.results) {
    const before = baselineByName.get(result.name);
    rows.push({
      name: result.name,
      category: result.category,
      baselineMs: before ? before.medianMs : null,
      currentMs: result.medianMs,
      deltaPercent: before ? deltaPercent(before.medianMs, result.medianMs) : null,
    });
  }
  return rows;
}

function printComparisonTable(rows) {
  const nameWidth = Math.max(4, ...rows.map((row) => row.name.length));
  console.log(`\n${'name'.padEnd(nameWidth)}  baseline(ms)  current(ms)  delta`);
  for (const row of rows) {
    const baselineText = row.baselineMs === null ? 'n/a' : formatMs(row.baselineMs);
    const deltaText = row.deltaPercent === null ? 'n/a' : `${row.deltaPercent >= 0 ? '+' : ''}${row.deltaPercent.toFixed(1)}%`;
    console.log(
      `${row.name.padEnd(nameWidth)}  ${baselineText.padStart(12)}  `
      + `${formatMs(row.currentMs).padStart(11)}  ${deltaText.padStart(8)}`,
    );
  }
}

function comparisonMarkdown(baseline, current, rows) {
  const lines = [];
  lines.push('# Benchmark comparison');
  lines.push('');
  lines.push(`Baseline: \`${baseline.label}\` (${baseline.timestamp}, node ${baseline.node}, ${baseline.cpu})`);
  lines.push(`Current: \`${current.label}\` (${current.timestamp}, node ${current.node}, ${current.cpu})`);
  lines.push('');
  lines.push('| case | category | baseline (ms) | current (ms) | delta |');
  lines.push('| --- | --- | ---: | ---: | ---: |');
  for (const row of rows) {
    const baselineText = row.baselineMs === null ? 'n/a' : row.baselineMs.toFixed(3);
    const deltaText = row.deltaPercent === null ? 'n/a' : `${row.deltaPercent >= 0 ? '+' : ''}${row.deltaPercent.toFixed(1)}%`;
    lines.push(`| ${row.name} | ${row.category} | ${baselineText} | ${row.currentMs.toFixed(3)} | ${deltaText} |`);
  }
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cases = await loadCases(args.filter);
  if (!cases.length) {
    console.error('No benchmark cases discovered under tests/benchmarks/*.bench.mjs');
    process.exitCode = 1;
    return;
  }

  // Diagnostic only, and only active under `--expose-gc` (ticket 24): forces
  // a GC after each case and records the heap baseline it settles at. This
  // distinguishes "heap climbs case-over-case" (an accumulating JS-heap
  // leak) from "one case has a high one-shot peak, baseline drops back
  // afterwards" (a large fixture colliding with the default heap limit,
  // not a leak) — see docs/benchmarks/README.md and ticket 24's baseline
  // note for the reading of this repo's own numbers.
  const trackMemory = typeof global.gc === 'function';

  const results = [];
  for (const definition of cases) {
    process.stdout.write(`running ${definition.name}...\n`);
    const result = await runCase(definition);
    if (trackMemory) {
      global.gc();
      result.heapUsedAfterMB = process.memoryUsage().heapUsed / (1024 * 1024);
      process.stdout.write(`  heapUsed after GC: ${result.heapUsedAfterMB.toFixed(1)} MB\n`);
    }
    results.push(result);
  }

  const output = { ...header(args.label), results };
  printResultsTable(results);

  if (args.out) {
    await mkdir(dirname(args.out), { recursive: true });
    await writeFile(args.out, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
    console.log(`\nwrote ${args.out}`);
  }

  if (args.compare) {
    const baseline = JSON.parse(await readFile(args.compare, 'utf8'));
    const rows = buildComparison(baseline, output);
    printComparisonTable(rows);
    if (args.markdown) {
      await mkdir(dirname(args.markdown), { recursive: true });
      await writeFile(args.markdown, comparisonMarkdown(baseline, output, rows), 'utf8');
      console.log(`\nwrote ${args.markdown}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
