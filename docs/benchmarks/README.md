# Performance benchmarks

This directory holds the performance baseline for the hot paths listed in
`experiments/2026-08-03-performance-findings.md` (points 1, 2, 3, 5, 7, 8).
The harness lives in `scripts/benchmark.mjs` and `tests/benchmarks/`.

## Running

```sh
npm run bench                                            # console table only
npm run bench -- --label optimized --out docs/benchmarks/optimized.json
npm run bench -- --compare docs/benchmarks/baseline.json \
                  --markdown docs/benchmarks/comparison.md \
                  --out docs/benchmarks/optimized.json    # before/after
npm run bench -- --filter searchScope                     # run a subset
```

`npm run bench` is **not** part of `npm test` — the real-scale run takes
roughly a minute and a half, dominated by the large-scale cases described
below (`occurrenceRanges`, `indexProject`/`findReferences` at 20k-file
scale, and one deliberately single-shot ~26s cache `stats` scan), which is
too slow for the normal test loop. `tests/benchmarks-smoke.test.js` instead
imports every `*.bench.mjs` module and runs one iteration of each case at a
tiny fixture size (`GOLENS_BENCH_SCALE=smoke`), so a broken benchmark case
still fails `npm test` quickly.

## Target scale: this is a 20,000+ file repo

GoLens is used against Go repositories on the order of 20,000+ source
files, not the few-hundred-file toy projects a hand-written test fixture
would default to. Several of the flagged hot paths are `O(files)` or
`O(cached sources)` — their cost is proportional to how much is indexed or
cached, not fixed. A fixture that's 60x smaller than the real target makes
those cases look free when they aren't: `searchScope` measured 0.036ms at
~320 files and 5-9ms at ~19,200 files; `findReferences` went from ~20ms to
~1.2s; `stats` against a fake IndexedDB went from ~65ms to ~25.7
**seconds**. None of that shows up if you only ever benchmark the small
fixture.

To make that visible, the harness registers **two fixture scales** for the
four hot paths whose cost scales with the indexed/cached set:

- **small** (~40 packages x 8 files ≈ 320 files / ~50-300 cache records):
  fast, good for tight iteration during development and for cases that
  aren't scale-dependent.
- **large** (~1200 packages x 16 files ≈ 19,200 files / ~20,000 cache
  records): approximates the real target repo size.

Case names carry a `[small: ...]` / `[large: ...]` suffix so the two are
never confused in the console table or a `--compare` report. **Do not use
the small-scale number alone to judge whether an optimization on these
paths is worth doing** — at 320 files several of them are already close to
the timer's noise floor and look negligible; the large-scale number is the
one that matters for the real repo this extension runs against.

**Scale-dependent cases** (registered at both scales):
`indexProject`, `searchScope` (both modes), `findReferences`,
`findImplementations` (both pages), and the cache's `stats`.

**Scale-independent cases** (small scale only — their cost is per-file or
per-call, not proportional to the indexed/cached set size):
`resolve` (one file's identifier tree walk), `prepareSources`,
`writePackage`/`readPackage`, `packageStatus`, `mergeRequestStatus` (fixed
at 20 packages — see finding #5, that count itself is the point),
`fileContextFor`, `codeCellFor`, `occurrenceRanges` (DOM cases — the
"large" concept doesn't apply the same way to a diff view; see the
happy-dom sizing note below for why `occurrenceRanges` in particular uses a
much smaller fixture than the other two DOM cases).

## Files

- `scripts/benchmark.mjs` — the runner. Discovers `tests/benchmarks/*.bench.mjs`,
  times each exported case (warmup iterations, then N timed iterations),
  reports median/p95/ops-per-second, and can write JSON (`--out`) and a
  before/after comparison (`--compare` + `--markdown`).
- `tests/benchmarks/fixtures.mjs` — deterministic synthetic Go project
  generator (`buildSyntheticProject({ packageCount, filesPerPackage })`) for
  the `go-semantic-core.js` cases, parameterized so both fixture scales
  reuse the same generator.
- `tests/benchmarks/semantic-core.bench.mjs` — findings #1-#3: `searchScope`,
  `findReferences`, `findImplementations`, plus `indexProject`/`resolve`,
  each of the four scale-dependent ones registered at both fixture scales
  (see "Target scale" above).
- `tests/benchmarks/fake-indexeddb.mjs` — minimal in-memory IndexedDB fake
  (only the surface `go-semantic-cache.js` uses), with an artificial
  per-request delay so real IDB round-trip counts show up in timings.
- `tests/benchmarks/semantic-cache.bench.mjs` — finding #5: `prepareSources`,
  `writePackage`/`readPackage`, `packageStatus`, `mergeRequestStatus`,
  `stats`, each run against both the in-memory `Map` fallback and the fake
  IndexedDB; `stats` additionally registered at the ~20,000-record large
  scale.
- `tests/benchmarks/diff-fixture.mjs` — synthetic large-diff DOM builder
  (`buildDiffFixtureHTML`), matching Rapid Diffs markup
  (`diff-file[data-testid="rd-diff-file"]`, `data-file-data`,
  `[data-testid="rd-diff-line-content"]`, `a[href*="/-/blob/"]`). Exported
  for reuse by future UI/perf tests, not just this benchmark suite.
- `tests/benchmarks/diff-dom.bench.mjs` — findings #7-#8: `fileContextFor`
  and `codeCellFor` (x1000, simulating the un-throttled mousemove path) and
  `occurrenceRanges`.
- `docs/benchmarks/baseline.json` — the committed pre-optimization
  reference. **Do not regenerate this file when optimizing** — it is the
  fixed comparison point. Only `optimized.json` (gitignored/ad hoc) and a
  comparison markdown get refreshed as optimization work lands.

## What each case measures

| case | finding | scale(s) | what it exercises |
| --- | --- | --- | --- |
| `indexProject` | #4 (context) | small + large | cold parse+index of the full synthetic project |
| `searchScope` (project / package) | #1 | small + large | full package-count recompute on every hover |
| `resolve` | #2 (context) | small only | single identifier-node resolution (per-file, not scale-dependent) |
| `findReferences` | #2 | small + large | per-candidate `resolve()` calls across the whole project for a name used many times (~600+ at small scale) |
| `findImplementations` page 1 / page 2 | #3 | small + large | full-project method/type record rebuild per query, including cursor pagination recompute |
| `prepareSources` | #5 | small only | hash-revalidation across 500 files, half already cached |
| `writePackage` + `readPackage` | #5 | small only | one full snapshot write/read round trip |
| `packageStatus` | #5 | small only | single-package IDB status check (with project-manifest fallback path) |
| `mergeRequestStatus` | #5 | small only | the sequential `packageStatus` loop across 20 packages — the count itself is the case in the finding |
| `stats` | #5 (context, "extra, bijna gratis") | small + large | full cursor scan across all three object stores; large scale (~20,000 source records) backs the popup's cache-status display at real repo size |
| `fileContextFor` x1000 | #7 | full 60x120 diff | uncached per-mousemove file-context lookup |
| `codeCellFor` x1000 | #7 | full 60x120 diff | uncached per-mousemove hit-test |
| `occurrenceRanges` | #8 | reduced 8x3 diff | TreeWalker + per-text-node `Range` rebuild across a diff |

## Sizing notes and known limitations

- **`occurrenceRanges` uses an 8x3 fixture, not 60x120.** happy-dom's
  `Range` implementation turned out to be quadratic in total cell count for
  this call pattern (measured: 20 cells ~0.7s, 40 cells ~2.8s — the full
  60x120/7200-cell fixture extrapolates to hours, not seconds). This is a
  `happy-dom` characteristic of the test harness, not something
  `occurrenceRanges` itself does across files — each cell's TreeWalker/Range
  work is scoped to that cell. `fileContextFor` and `codeCellFor` don't have
  this problem (their DOM queries are scoped to one diff root, independent
  of total document size), so those two cases use the full 60x120 fixture
  as originally specified. `buildDiffFixtureHTML` in
  `tests/benchmarks/diff-fixture.mjs` still defaults to 60x120 so future
  full-scale UI tests can use it; only the `occurrenceRanges` benchmark case
  overrides it down.
- **Sub-millisecond in-memory cache cases are batched.** `resolve`,
  `packageStatus`/`stats`/`writePackage+readPackage`/`mergeRequestStatus`
  against the in-memory `Map` fallback complete in low single-digit
  microseconds — comparable to `performance.now()`'s own overhead. Left
  unbatched, their medians drifted >20-50% across a 3x stability check.
  Each of those cases now runs its operation N times per timed sample
  (`x20`/`x50`/`x100`/`x300` in the case name) to amortize the measurement
  noise; the reported `medianMs` is for the whole batch, not one call — this
  only matters for reading the absolute number, comparisons across
  baseline/optimized runs stay apples-to-apples since the batch size is
  fixed per case.
- **Still-noisy cases after batching**: even after batching, `searchScope`,
  `resolve`, and the fake-IndexedDB variant of `prepareSources` occasionally
  showed one run in a 3x stability check drift 10-21% from the other two
  (all still sub-millisecond or IO-timer-jitter-bound operations). This is
  scheduling/GC noise on the laptop this baseline was recorded on, not a
  harness bug; if you see a case swing wildly when comparing against this
  baseline, re-run `npm run bench` once or twice before concluding a real
  regression happened. Every other case settled within ~10% across three
  consecutive runs.
- **`indexProject`'s Tree-sitter trees are never freed** across iterations
  (`indexPackage` stores a `tree` per file; nothing calls `tree.delete()`,
  matching production — `disposeProject` only drops the Map entries). The
  small-scale case therefore uses a low iteration count (5, warmup 1)
  rather than fighting WASM-heap growth across dozens of iterations; the
  large-scale case (~19,200 files, ~3.3s per call) is measured **once**
  with no warmup — an honest single measurement per the "impractical large
  case" rule below, not a shrunk fixture.
- **The large-scale cache `stats` (IndexedDB) case is measured once.** At
  ~20,000 source records, a single `stats()` call costs ~25.7s: the fake
  IndexedDB's cursor walk schedules one `setTimeout`-backed step per
  record (see `fake-indexeddb.mjs`), so the scan is ~20,000 sequential
  macrotask delays. Rather than silently shrinking the record count (which
  would misrepresent the real 20k-scale cost this case exists to measure),
  it runs with `iterations: 1, warmup: 0` and says so in its case
  definition — the same "honest slow number over a shrunk fixture" rule
  applied to `occurrenceRanges` above. Its in-memory-fallback sibling has
  no such problem (~3ms for the same 20,000 records) and runs normally.
  Large-scale setup for both variants seeds the store directly instead of
  going through 20,000 `writePackage` calls (`stats()` never validates
  content against a Git blob hash, so a direct seed exercises the same
  read path without paying the fake IDB's per-request delay during setup).
- **Small-scale cases must run before large-scale ones in the same
  process.** All benchmark cases run in one Node process. A 3x stability
  check found that once the ~19,200-file large index has been built, its
  much bigger heap makes GC pauses longer and those pauses bleed into
  *unrelated* later timings — `searchScope (mode: package) [small]`
  measured ~0.04ms in isolation but ~5ms when a case ordering bug ran it
  right after the large-scale block. `tests/benchmarks/semantic-core.bench.mjs`
  now declares every small-scale case before any large-scale one for
  exactly this reason; keep that ordering if you add more scale-dependent
  cases.

## Regenerating the baseline vs. comparing against it

- Only regenerate `docs/benchmarks/baseline.json` if you are deliberately
  moving the reference point (e.g. after a fixture change that isn't a
  performance optimization). Normal optimization work should leave it
  untouched.
- After an optimization, run:
  ```sh
  npm run bench -- --label optimized \
                    --out docs/benchmarks/optimized.json \
                    --compare docs/benchmarks/baseline.json \
                    --markdown docs/benchmarks/comparison.md
  ```
  and check the per-case delta% in the printed table / `comparison.md`.
