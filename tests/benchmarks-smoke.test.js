// Protects the benchmark harness itself from bit-rot: imports every
// `tests/benchmarks/*.bench.mjs` module and runs one iteration of each
// case at a reduced ("smoke") scale, so `npm test` stays fast while still
// catching a broken fixture, a broken helper import, or a benchmark case
// whose assertions no longer hold.
//
// `npm run bench` (the full, slow, real-scale run) is intentionally NOT
// part of `npm test` — see docs/benchmarks/README.md.

import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';

process.env.GOLENS_BENCH_SCALE = 'smoke';

const BENCH_DIR = fileURLToPath(new URL('./benchmarks/', import.meta.url));

async function benchmarkModulePaths() {
  const entries = await readdir(BENCH_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.bench.mjs'))
    .map((entry) => join(BENCH_DIR, entry.name))
    .sort();
}

test('every benchmark module exports runnable cases at smoke scale', async () => {
  const modulePaths = await benchmarkModulePaths();
  assert.ok(modulePaths.length > 0, 'expected at least one *.bench.mjs module');

  for (const modulePath of modulePaths) {
    const module = await import(pathToFileURL(modulePath).href);
    assert.ok(Array.isArray(module.benchmarks), `${modulePath} must export a "benchmarks" array`);
    assert.ok(module.benchmarks.length > 0, `${modulePath} exports no benchmark cases`);

    for (const definition of module.benchmarks) {
      assert.equal(typeof definition.name, 'string', `${modulePath} has a case without a name`);
      assert.equal(typeof definition.run, 'function', `"${definition.name}" has no run()`);
      const context = definition.setup ? await definition.setup() : undefined;
      // One iteration is enough to prove the case still executes without
      // throwing; the real timing run lives in `npm run bench`.
      await definition.run(context);
    }
  }
});
