// Benchmarks for the hot paths in `go-semantic-core.js` identified in
// `experiments/2026-08-03-performance-findings.md` (#1 searchScope, #2
// findReferences, #3 findImplementations).
//
// Parser/Language setup mirrors `tests/go-semantic-core.test.js` exactly:
// same `web-tree-sitter` API, same checked-in `vendor/tree-sitter-go.wasm`.
//
// Two fixture scales are registered for indexProject/searchScope/
// findReferences/findImplementations, because their cost is proportional
// to the size of the indexed project (see docs/benchmarks/README.md,
// "Fixture scale"):
//   - "small" (~40 packages x 8 files = ~320 files): fast, good for tight
//     iteration and stability.
//   - "large" (~1200 packages x 16 files = ~19,200 files): approximates
//     the real 20,000+ file target repo this extension is actually used
//     against. Small-scale numbers alone are NOT representative of
//     production cost for these four cases — see the README before using
//     either scale to judge whether an optimization is worth doing.

import assert from 'node:assert/strict';
import { Language, Parser } from 'web-tree-sitter';
import { GoSemanticIndex } from '../../go-semantic-core.js';
import { buildSyntheticProject } from './fixtures.mjs';

// Override with GOLENS_BENCH_SCALE=smoke for a fast sanity pass (used by
// tests/benchmarks-smoke.test.js) so the harness itself stays cheap to
// protect with a normal node:test run. Smoke mode collapses both scales
// down to tiny fixtures; it does not exercise the real "large" size.
const SMOKE = process.env.GOLENS_BENCH_SCALE === 'smoke';

// packageCount must be >= 7 at small scale: Doer implementors are packages
// at index % 3 === 0 (excluding 0 itself), so findImplementations needs at
// least two (indices 3 and 6) to exercise a real second page.
const SCALES = {
  small: {
    label: 'small: 40x8 (~320 files)',
    packageCount: SMOKE ? 7 : 40,
    filesPerPackage: SMOKE ? 3 : 8,
  },
  large: {
    label: 'large: 1200x16 (~19,200 files, ~20k-file-repo scale)',
    // Smoke mode still needs >=7 packages for the Doer-implementor rule
    // above; it does not need to be "large" since it only proves the case
    // still runs, not that it's fast at scale.
    packageCount: SMOKE ? 7 : 1200,
    filesPerPackage: SMOKE ? 3 : 16,
  },
};

const SCOPE = { origin: '', project: 'bench/project', ref: 'a'.repeat(40) };

async function loadParser() {
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load(new URL('../../vendor/tree-sitter-go.wasm', import.meta.url).pathname));
  return parser;
}

function locate(source, needlePrefix, identifier) {
  const lines = source.split('\n');
  const lineIndex = lines.findIndex((line) => line.includes(needlePrefix));
  assert.notEqual(lineIndex, -1, `expected to find "${needlePrefix}"`);
  const character = lines[lineIndex].indexOf(identifier, lines[lineIndex].indexOf(needlePrefix));
  assert.notEqual(character, -1, `expected "${identifier}" on the located line`);
  return { line: lineIndex + 1, character };
}

// Indexing the "large" fixture costs several seconds (see README). Cases
// that share a scale (searchScope/findReferences/findImplementations) pay
// that cost once per scale, not once per case, via this memoized promise
// cache — only `indexProject` itself builds a fresh index per timed
// iteration, because measuring that cold cost is the point of that case.
const indexedProjectCache = new Map();
function buildIndexedProject(scaleKey) {
  if (!indexedProjectCache.has(scaleKey)) {
    indexedProjectCache.set(scaleKey, (async () => {
      const scale = SCALES[scaleKey];
      const parser = await loadParser();
      const project = buildSyntheticProject({ packageCount: scale.packageCount, filesPerPackage: scale.filesPerPackage });
      const index = new GoSemanticIndex(parser);
      const result = index.indexProject({ ...SCOPE, modulePath: project.modulePath, files: project.files });
      assert.equal(result.status, 'projectIndexed');
      assert.equal(result.packages, scale.packageCount);
      return { parser, project, index };
    })());
  }
  return indexedProjectCache.get(scaleKey);
}

function indexProjectSetup(scaleKey) {
  return async () => {
    const scale = SCALES[scaleKey];
    const parser = await loadParser();
    const project = buildSyntheticProject({ packageCount: scale.packageCount, filesPerPackage: scale.filesPerPackage });
    return { parser, project };
  };
}

function searchScopeSetup(scaleKey) {
  return async () => {
    const { index } = await buildIndexedProject(scaleKey);
    return { index };
  };
}

function resolveSetup(scaleKey) {
  return async () => {
    const { index, project } = await buildIndexedProject(scaleKey);
    const primarySource = project.files.find((file) => file.path === 'pkg000/file000.go').source;
    const position = locate(primarySource, 'func New(', 'New');
    return {
      index,
      request: { ...SCOPE, packagePath: 'pkg000', path: 'pkg000/file000.go', identifier: 'New', ...position },
    };
  };
}

function referencesSetup(scaleKey) {
  return async () => {
    const { index, request } = await resolveSetup(scaleKey)();
    const resolved = index.resolve(request);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.definition.name, 'New');
    return { index, definition: resolved.definition };
  };
}

function implementationsSetup(scaleKey) {
  return async () => {
    const { index, project } = await buildIndexedProject(scaleKey);
    const primarySource = project.files.find((file) => file.path === 'pkg000/file000.go').source;
    const position = locate(primarySource, 'type Doer interface', 'Doer');
    const resolved = index.resolve({
      ...SCOPE, packagePath: 'pkg000', path: 'pkg000/file000.go', identifier: 'Doer', ...position,
    });
    assert.equal(resolved.status, 'resolved');
    // At small/smoke scale the synthetic project is small, so use a page
    // size that still leaves a real second page to benchmark.
    const pageSize = (SMOKE || scaleKey === 'small') ? 1 : 5;
    const first = index.findImplementations({ ...SCOPE, interfaceDefinition: resolved.definition, pageSize });
    assert.equal(first.status, 'implementations');
    assert.ok(first.candidates.length >= 1, 'expected at least one Doer implementor');
    assert.equal(first.hasMore, true, `expected a second page of implementors for pageSize:${pageSize}`);
    assert.ok(first.nextCursor, 'expected a non-empty cursor for page two');
    return {
      index, interfaceDefinition: resolved.definition, firstPageCursor: first.nextCursor, pageSize,
    };
  };
}

function scopeSuffix(scaleKey) {
  return `[${SCALES[scaleKey].label}]`;
}

function scaleDependentCases(scaleKey, { indexProjectIterations, indexProjectWarmup, otherIterations, otherWarmup }) {
  return [
    {
      name: `indexProject (cold) ${scopeSuffix(scaleKey)}`,
      category: 'semantic-core',
      iterations: indexProjectIterations,
      warmup: indexProjectWarmup,
      setup: indexProjectSetup(scaleKey),
      run: ({ parser, project }) => {
        // A fresh index every iteration: this benchmark measures the cold
        // parse+index cost (finding #4), not incremental re-indexing.
        const index = new GoSemanticIndex(parser);
        const result = index.indexProject({ ...SCOPE, modulePath: project.modulePath, files: project.files });
        assert.equal(result.status, 'projectIndexed');
      },
    },
    {
      name: `searchScope (mode: project) ${scopeSuffix(scaleKey)}`,
      category: 'semantic-core',
      iterations: otherIterations,
      warmup: otherWarmup,
      setup: searchScopeSetup(scaleKey),
      run: ({ index }) => {
        const result = index.searchScope({ ...SCOPE, mode: 'project', packagePath: 'pkg000' });
        assert.equal(result.kind, 'fullProject');
      },
    },
    {
      name: `findReferences (widely used identifier, pageSize:100) ${scopeSuffix(scaleKey)}`,
      category: 'semantic-core',
      iterations: otherIterations,
      warmup: otherWarmup,
      setup: referencesSetup(scaleKey),
      run: ({ index, definition }) => {
        const result = index.findReferences({ ...SCOPE, packagePath: 'pkg000', definition, pageSize: 100 });
        assert.equal(result.status, 'references');
      },
    },
    {
      name: `findImplementations (page 1) ${scopeSuffix(scaleKey)}`,
      category: 'semantic-core',
      iterations: otherIterations,
      warmup: otherWarmup,
      setup: implementationsSetup(scaleKey),
      run: ({ index, interfaceDefinition, pageSize }) => {
        const result = index.findImplementations({ ...SCOPE, interfaceDefinition, pageSize });
        assert.equal(result.status, 'implementations');
      },
    },
    {
      name: `findImplementations (page 2 via cursor) ${scopeSuffix(scaleKey)}`,
      category: 'semantic-core',
      iterations: otherIterations,
      warmup: otherWarmup,
      setup: implementationsSetup(scaleKey),
      run: ({ index, interfaceDefinition, firstPageCursor, pageSize }) => {
        const result = index.findImplementations({
          ...SCOPE, interfaceDefinition, pageSize, cursor: firstPageCursor,
        });
        assert.equal(result.status, 'implementations');
      },
    },
  ];
}

// IMPORTANT ordering note: every "small" case below runs before any
// "large" one. A 3x stability check found that running the ~19,200-file
// "large" indexed project first (this harness runs every case in one Node
// process) leaves a much bigger heap behind, and GC pauses against that
// bigger heap then bleed into later timings even for unrelated small-scale
// cases (searchScope (mode: package) [small] measured ~0.04ms in
// isolation but ~5ms when run right after the large block). Keeping all
// small-scale cases first keeps their numbers representative; see
// docs/benchmarks/README.md.
export const benchmarks = [
  ...scaleDependentCases('small', {
    indexProjectIterations: SMOKE ? 1 : 5,
    indexProjectWarmup: SMOKE ? 0 : 1,
    otherIterations: SMOKE ? 1 : 30,
    otherWarmup: SMOKE ? 0 : 5,
  }),
  // searchScope(mode: 'package') computes the same project-wide
  // packageCount as mode: 'project' before its early return (core:572-575),
  // so it is exactly as scale-dependent — registered at both scales too.
  {
    name: 'searchScope (mode: package) [small: 40x8 (~320 files)]',
    category: 'semantic-core',
    setup: searchScopeSetup('small'),
    run: ({ index }) => {
      const result = index.searchScope({ ...SCOPE, mode: 'package', packagePath: 'pkg000' });
      assert.equal(result.kind, 'currentPackage');
    },
  },
  {
    // Batched x100: a single resolve() on this fixture is a few
    // microseconds, comparable to performance.now()'s own overhead, which
    // made the median drift >20% run-to-run in the 3x stability check (see
    // docs/benchmarks/README.md). Batching amortizes that measurement
    // noise; the reported medianMs is for the whole batch. resolve() cost
    // is per-file (identifier-node tree walk in one file), not
    // proportional to project size, so only the small scale is registered.
    name: 'resolve (common identifier "New") x100 [small: 40x8 (~320 files)]',
    category: 'semantic-core',
    setup: resolveSetup('small'),
    run: ({ index, request }) => {
      for (let iteration = 0; iteration < 100; iteration++) {
        const result = index.resolve(request);
        assert.equal(result.status, 'resolved');
      }
    },
  },
  ...scaleDependentCases('large', {
    // indexProject at ~19,200 files costs ~3s per call, and (matching the
    // small-scale case) never frees its Tree-sitter trees across
    // iterations, so it is measured once with no warmup rather than
    // amortized over several iterations — an honest single measurement,
    // not a shrunk fixture. See docs/benchmarks/README.md.
    indexProjectIterations: SMOKE ? 1 : 1,
    indexProjectWarmup: 0,
    // searchScope/findReferences/findImplementations share one memoized
    // large index (built once, see buildIndexedProject above). A 3x
    // stability check at iterations:5 showed searchScope/findImplementations
    // swinging up to ~2-3x run-to-run (GC/JIT noise at this heap size);
    // iterations:10 settled that considerably while keeping the total
    // harness runtime practical even though findReferences alone costs
    // over 1s per call at this scale.
    otherIterations: SMOKE ? 1 : 10,
    otherWarmup: SMOKE ? 0 : 2,
  }),
  {
    name: 'searchScope (mode: package) [large: 1200x16 (~19,200 files, ~20k-file-repo scale)]',
    category: 'semantic-core',
    iterations: SMOKE ? 1 : 10,
    warmup: SMOKE ? 0 : 2,
    setup: searchScopeSetup('large'),
    run: ({ index }) => {
      const result = index.searchScope({ ...SCOPE, mode: 'package', packagePath: 'pkg000' });
      assert.equal(result.kind, 'currentPackage');
    },
  },
];
