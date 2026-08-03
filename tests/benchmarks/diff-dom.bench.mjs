// Benchmarks for the DOM-facing hot paths in `go-navigation.js` identified
// in `experiments/2026-08-03-performance-findings.md`:
//   #7 `fileContextFor` runs on every un-throttled mousemove, uncached
//      per diff root.
//   #8 `occurrenceRanges` walks every code cell of every diff file with a
//      fresh TreeWalker + Range per text node, on every DOM mutation while
//      a symbol is selected.
//
// Loads `go-navigation.js` the same way `tests/go-navigation-context.test.js`
// does: as a global-attaching IIFE against a `happy-dom` `Window`, reached
// through `globalThis.GoLensGoNavigation.__test`.
//
// IMPORTANT SIZING NOTE (see docs/benchmarks/README.md for detail): the
// `occurrenceRanges` case does NOT use the full 60x120 fixture. happy-dom's
// `Range` implementation is quadratic in the *total* DOM size the range
// operations are measured against (confirmed empirically: cells=20 ~= 0.7s,
// cells=40 ~= 2.8s, cells=80 (60x120 scaled down proportionally) would run
// for hours). That quadratic cost is a `happy-dom` characteristic, not
// something `occurrenceRanges` itself does across files (each cell's walk
// is scoped to that cell) — but it makes the full spec size infeasible to
// benchmark here. The case below uses a deliberately small fixture and
// says so in its name; `fileContextFor`'s cost is independent of total DOM
// size (its queries are scoped to one diff root), so that case DOES use
// the full 60x120 fixture as specified.

import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { buildDiffFixtureHTML } from './diff-fixture.mjs';

const SMOKE = process.env.GOLENS_BENCH_SCALE === 'smoke';

// Full-size fixture, per spec, for the size-independent fileContextFor case.
const FULL_FILE_COUNT = SMOKE ? 3 : 60;
const FULL_ROWS_PER_FILE = SMOKE ? 3 : 120;

// Deliberately small fixture for occurrenceRanges: happy-dom Range cost is
// quadratic in total cell count, so this is sized to keep a single call
// under ~1.5s (see note above) while still exercising every code path
// (multiple files, multiple identifier occurrences per row, an identifier
// that is also a substring of a longer identifier).
const OCCURRENCE_FILE_COUNT = SMOKE ? 2 : 8;
const OCCURRENCE_ROWS_PER_FILE = SMOKE ? 2 : 3;

let modulePromise;
async function loadGoNavigation() {
  if (!modulePromise) {
    globalThis.location = {
      href: 'https://gitlab.example/group/project/-/merge_requests/1/diffs',
      origin: 'https://gitlab.example',
      pathname: '/group/project/-/merge_requests/1/diffs',
    };
    modulePromise = (async () => {
      await import('../../bookmark-store.js?golens-benchmarks');
      await import('../../go-navigation.js');
      return globalThis.GoLensGoNavigation.__test;
    })();
  }
  return modulePromise;
}

function mountFixture(html) {
  const window = new Window({ url: globalThis.location.href });
  window.document.body.innerHTML = html;
  return window;
}

async function fileContextForSetup() {
  const helpers = await loadGoNavigation();
  const html = buildDiffFixtureHTML({ fileCount: FULL_FILE_COUNT, rowsPerFile: FULL_ROWS_PER_FILE });
  const window = mountFixture(html);
  globalThis.document = window.document;
  globalThis.NodeFilter = window.NodeFilter;
  const cell = window.document.querySelector('[data-testid="rd-diff-line-content"]');
  assert.ok(cell, 'expected at least one diff code cell');
  const context = helpers.fileContextFor(cell);
  assert.ok(context, 'expected fileContextFor to resolve a file context');
  assert.match(context.path, /\.go$/);
  return { helpers, cell };
}

async function codeCellForSetup() {
  const helpers = await loadGoNavigation();
  const html = buildDiffFixtureHTML({ fileCount: FULL_FILE_COUNT, rowsPerFile: FULL_ROWS_PER_FILE });
  const window = mountFixture(html);
  globalThis.document = window.document;
  globalThis.NodeFilter = window.NodeFilter;
  const span = window.document.querySelector('[data-testid="rd-diff-line-content"] .id');
  assert.ok(span, 'expected an identifier span inside a diff code cell');
  const cell = helpers.codeCellFor(span);
  assert.ok(cell, 'expected codeCellFor to resolve the containing code cell');
  return { helpers, span };
}

async function occurrenceRangesSetup() {
  const helpers = await loadGoNavigation();
  const html = buildDiffFixtureHTML({ fileCount: OCCURRENCE_FILE_COUNT, rowsPerFile: OCCURRENCE_ROWS_PER_FILE });
  const window = mountFixture(html);
  globalThis.document = window.document;
  globalThis.NodeFilter = window.NodeFilter;
  const occurrences = helpers.occurrenceRanges('Client');
  assert.ok(occurrences.length > 0, 'expected at least one "Client" occurrence in the fixture');
  return { helpers };
}

export const benchmarks = [
  {
    name: `fileContextFor x1000 (uncached, ${FULL_FILE_COUNT}x${FULL_ROWS_PER_FILE} diff, un-throttled mousemove path)`,
    category: 'diff-dom',
    setup: fileContextForSetup,
    run: ({ helpers, cell }) => {
      for (let index = 0; index < 1000; index++) helpers.fileContextFor(cell);
    },
  },
  {
    name: `codeCellFor x1000 (uncached, ${FULL_FILE_COUNT}x${FULL_ROWS_PER_FILE} diff, hit-test path)`,
    category: 'diff-dom',
    setup: codeCellForSetup,
    run: ({ helpers, span }) => {
      for (let index = 0; index < 1000; index++) helpers.codeCellFor(span);
    },
  },
  {
    name: `occurrenceRanges (${OCCURRENCE_FILE_COUNT}x${OCCURRENCE_ROWS_PER_FILE} diff, reduced from 60x120 — see file header)`,
    category: 'diff-dom',
    iterations: SMOKE ? 1 : 4,
    warmup: SMOKE ? 0 : 1,
    setup: occurrenceRangesSetup,
    run: ({ helpers }) => {
      const occurrences = helpers.occurrenceRanges('Client');
      assert.ok(occurrences.length > 0);
    },
  },
];
