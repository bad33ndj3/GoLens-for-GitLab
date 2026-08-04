# Before-benchmark: findings #2 and #3 (pre-optimization baseline)

Captured 2026-08-04 via `npm run bench -- --filter findReferences` and
`npm run bench -- --filter findImplementations`, against the harness described in
`docs/benchmarks/README.md`. No code changes made — this is the current-state baseline
that the specs for findings #2 and #3 (`experiments/2026-08-03-performance-findings.md`)
measure against. Re-run the same two commands after implementation and diff against this
table for the "after" numbers.

## `findReferences` (finding #2 — per-candidate `resolve()`)

| case | median(ms) | p95(ms) | ops/s |
|---|---|---|---|
| widely used identifier, pageSize:100 [small: 40x8 (~320 files)] | 18.83 | 19.19 | 53 |
| widely used identifier, pageSize:100 [large: 1200x16 (~19,200 files)] | 1199.94 | 1255.84 | 1 |

## `findImplementations` (finding #3 — full rebuild per query)

| case | median(ms) | p95(ms) | ops/s |
|---|---|---|---|
| page 1 [small: 40x8 (~320 files)] | 0.319 | 0.543 | 3138 |
| page 2 via cursor [small: 40x8 (~320 files)] | 0.249 | 0.428 | 4024 |
| page 1 [large: 1200x16 (~19,200 files)] | 22.38 | 66.91 | 45 |
| page 2 via cursor [large: 1200x16 (~19,200 files)] | 21.46 | 22.00 | 47 |

Page 2 costs essentially the same as page 1 at large scale (21.46ms vs 22.38ms median) —
confirms the finding: nothing is memoized across pages, so paginating a large candidate set
recomputes `recordsByIdentity`/`methodsByReceiver`/`promotedMethods` from scratch every call.

Raw JSON: `before-findReferences.json`, `before-findImplementations.json` (scratchpad, not
committed).

## After (issue #21)

`findReferences` now resolves each candidate directly from the node `identifierCandidates`
already carries (`_resolveAtNode` in `worker/index-core.js`), instead of re-running
`findIdentifierNode`'s tree walk per candidate via `resolve()`. Restored (lazy) indexes, where a
candidate's node is a position-only stub, fall back to a cheap `descendantForPosition` lookup
(`_identifierNodeAt`) rather than the full text-scan fallback.

`npm run bench -- --filter findReferences`:

| case | median(ms) | p95(ms) | ops/s |
|---|---|---|---|
| widely used identifier, pageSize:100 [small: 40x8 (~320 files)] | 16.62 | 20.95 | 60 |
| widely used identifier, pageSize:100 [large: 1200x16 (~19,200 files)] | 1068.08 | 1073.72 | 1 |

~11% faster at large scale (1068.08ms vs the 1199.94ms baseline). Most of `findReferences`'s
remaining cost is not `findIdentifierNode`'s tree walk (now skipped) but the rest of `resolve()`'s
per-candidate work it still runs unchanged (`localDefinitionFor`'s enclosing-scope walk,
`packageDefinitions`/`memberDefinitions` lookups) plus sorting every same-named candidate
project-wide before paginating — both explicitly out of scope for issue #21, which only asked to
stop re-locating an already-known node.

## After (issue #22)

`findImplementations` now memoizes `recordsByIdentity`, `methodsByReceiver`, promoted-method
lookups, and the full sorted candidate list on the same generation-scoped `scope` object
`searchScope`'s `packageCount` already uses (`_scopeEntries` in `worker/index-core.js`), keyed
by `(origin, project, ref, mutationGeneration)` and, for candidates/promoted-methods, further by
interface/record identity. A mutation (`indexPackage`, `disposeProject`, `clear`) still bumps
`mutationGeneration` or deletes the scope-cache entry outright, so nothing new to invalidate.

The harness's own `implementationsSetup` calls `findImplementations` once before any timed
iteration (to capture `firstPageCursor`/assert `hasMore`), which already warms the memoized scope
—with the old, unmemoized code that priming call was irrelevant, but now it would make the "page
1" case measure a warm hit too, hiding the cold cost it exists to prove. So the "page 1" case's
`run()` now reindexes the (small, cheap) `pkg000` package with its own unchanged files immediately
before each timed call — a legitimate, cheap way to bump the index's single global
`mutationGeneration` and force every memoized structure to rebuild, reproducing "first call after
something in the project changed" every iteration instead of just once:

`npm run bench -- --filter findImplementations`:

| case | median(ms) | p95(ms) | ops/s |
|---|---|---|---|
| page 1 (forced cold) [small: 40x8 (~320 files)] | 1.802 | 2.379 | 555 |
| page 2 via cursor (warm) [small: 40x8 (~320 files)] | 0.002 | 0.004 | 558191 |
| page 1 (forced cold) [large: 1200x16 (~19,200 files)] | 46.15 | 47.36 | 22 |
| page 2 via cursor (warm) [large: 1200x16 (~19,200 files)] | 0.003 | 0.003 | 387147 |

Page 2 is now ~15,000x cheaper than page 1 at large scale (0.003ms vs 46.15ms median) — the
concrete "page N+1 no longer redoes page 1's work" signal the fix targets. Forced-cold page 1 is
itself slightly slower than the ~22ms pre-fix baseline because its timed portion now also includes
the cheap `pkg000` reindex needed to force that cold state every iteration (see `run()` above);
the underlying `findImplementations` work it does is otherwise the same shape the old code did on
every single call, cold or not.
