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
// through `globalThis.GoLensGoNavigation.__test`. `caretAtPoint` and
// `occurrenceRanges` moved to `page/features/code-intel.js` (ticket 21) and
// are reached through that module's own `mount(ctx).__test` — see that
// file's `__test` comment for why it carries one despite ticket 04 §1's
// "handle + internal.js pure functions only" test surface: this baseline
// (ticket 24) is what 13-21's "no perf regression" criterion compares
// against, so the two case names/measured functions must stay stable.
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
import { mount as mountCodeIntel } from '../../page/features/code-intel.js';

const DIFF_ROOT_SELECTOR = 'diff-file, .diff-file, [data-testid="diff-file"], [data-testid="rd-diff-file"], [data-file-path]';

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
      const helpers = globalThis.GoLensGoNavigation.__test;
      // Ticket 26: `fileContextFor`/`codeCellFor` are now thin wrappers onto
      // page/platform/diff-dom.js, loaded through go-navigation.js's dynamic
      // `import()` bridge. Await it so the measured calls never race the
      // load; the case names and measured functions are unchanged.
      await helpers.diffDomReady;
      return helpers;
    })();
  }
  return modulePromise;
}

function mountFixture(html) {
  const window = new Window({ url: globalThis.location.href });
  window.document.body.innerHTML = html;
  return window;
}

// Releasing a fixture requires `happyDOM.close()` and nothing less: the
// synchronous `window.close()` leaves the document reachable, and so does
// dropping every reference to it from here (measured — assigning
// `globalThis.document` alone is enough to pin it, and `delete` does not
// unpin it). Each un-released full-size (60x120) fixture keeps ~1.3 GB
// resident for the rest of the run; three of them in a row exhausted the
// default V8 heap before the large semantic-core cases could run. This is a
// `happy-dom` teardown characteristic of these benchmarks, not a retention
// bug in `go-navigation.js` — the same growth occurs with no helper called
// at all; see ticket 24.
async function releaseFixture({ window, codeIntel }) {
  codeIntel?.unmount();
  delete globalThis.document;
  delete globalThis.NodeFilter;
  await window.happyDOM.close();
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
  return { helpers, cell, window };
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
  return { helpers, span, window };
}

async function caretAtPointSetup() {
  await loadGoNavigation();
  const html = buildDiffFixtureHTML({ fileCount: FULL_FILE_COUNT, rowsPerFile: FULL_ROWS_PER_FILE });
  const window = mountFixture(html);
  globalThis.document = window.document;
  globalThis.window = window;
  globalThis.NodeFilter = window.NodeFilter;
  const cells = [...window.document.querySelectorAll('[data-testid="rd-diff-line-content"]')];
  const cell = cells[cells.length - 1];
  assert.ok(cell, 'expected at least one diff code cell');
  const span = cell.querySelector('.id');
  assert.ok(span, 'expected an identifier span inside the diff code cell');
  const textNode = span.firstChild;
  assert.ok(textNode?.nodeType === 3, 'expected a text node inside the identifier span');
  // happy-dom implements neither `caretPositionFromPoint` nor
  // `caretRangeFromPoint`; stub the former so caretAtPoint takes its normal
  // path (Range walk to a character offset, identifierAtCharacter, boundary
  // matching against the containing element) instead of returning null.
  // The pointer coordinates below are therefore inert — the stub ignores
  // them — and what's timed is caretAtPoint's own cost, not a browser hit-test.
  window.document.caretPositionFromPoint = () => ({ offsetNode: textNode, offset: 0 });
  // caretAtPoint doesn't touch `legacy` at all (it only reads `document` and
  // the pure identifier helpers), so this mount needs no capabilities.
  const codeIntel = mountCodeIntel({});
  const hit = codeIntel.__test.caretAtPoint(cell, 0, 0);
  assert.ok(hit, 'expected caretAtPoint to resolve an identifier at the stubbed caret position');
  return { codeIntel, cell, window };
}

async function occurrenceRangesSetup() {
  const helpers = await loadGoNavigation();
  const html = buildDiffFixtureHTML({ fileCount: OCCURRENCE_FILE_COUNT, rowsPerFile: OCCURRENCE_ROWS_PER_FILE });
  const window = mountFixture(html);
  globalThis.document = window.document;
  globalThis.window = window;
  globalThis.NodeFilter = window.NodeFilter;
  // occurrenceRanges reads `legacy.diffFileRoots()`/`legacy.fileContextFor()`
  // to skip cells outside a resolvable diff file — delegate to go-navigation.js's
  // real fileContextFor (same helpers this suite already loads) and a
  // DIFF_ROOT_SELECTOR query matching code-intel.js's own, so this isn't a
  // stub that silently short-circuits the walk (a `fileContextFor` that
  // always returns falsy would make every root get skipped via `continue`
  // and the case would measure ~nothing while still passing).
  const codeIntel = mountCodeIntel({
    legacy: {
      diffFileRoots: () => [...window.document.querySelectorAll(DIFF_ROOT_SELECTOR)],
      fileContextFor: helpers.fileContextFor,
    },
  });
  const occurrences = codeIntel.__test.occurrenceRanges('Client');
  assert.ok(occurrences.length > 0, 'expected at least one "Client" occurrence in the fixture');
  return { codeIntel, window };
}

export const benchmarks = [
  {
    name: `fileContextFor x1000 (uncached, ${FULL_FILE_COUNT}x${FULL_ROWS_PER_FILE} diff, un-throttled mousemove path)`,
    category: 'diff-dom',
    setup: fileContextForSetup,
    teardown: releaseFixture,
    run: ({ helpers, cell }) => {
      for (let index = 0; index < 1000; index++) helpers.fileContextFor(cell);
    },
  },
  {
    name: `codeCellFor x1000 (uncached, ${FULL_FILE_COUNT}x${FULL_ROWS_PER_FILE} diff, hit-test path)`,
    category: 'diff-dom',
    setup: codeCellForSetup,
    teardown: releaseFixture,
    run: ({ helpers, span }) => {
      for (let index = 0; index < 1000; index++) helpers.codeCellFor(span);
    },
  },
  {
    name: `caretAtPoint x1000 (uncached, ${FULL_FILE_COUNT}x${FULL_ROWS_PER_FILE} diff, hover hit-test path, stubbed browser caret hit-test)`,
    category: 'diff-dom',
    setup: caretAtPointSetup,
    teardown: releaseFixture,
    run: ({ codeIntel, cell }) => {
      for (let index = 0; index < 1000; index++) codeIntel.__test.caretAtPoint(cell, 0, 0);
    },
  },
  {
    name: `occurrenceRanges (${OCCURRENCE_FILE_COUNT}x${OCCURRENCE_ROWS_PER_FILE} diff, reduced from 60x120 — see file header)`,
    category: 'diff-dom',
    iterations: SMOKE ? 1 : 4,
    warmup: SMOKE ? 0 : 1,
    setup: occurrenceRangesSetup,
    teardown: releaseFixture,
    run: ({ codeIntel }) => {
      const occurrences = codeIntel.__test.occurrenceRanges('Client');
      assert.ok(occurrences.length > 0);
    },
  },
];
