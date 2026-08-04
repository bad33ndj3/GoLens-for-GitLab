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

## After (issue #22)

`findImplementations` now memoizes `recordsByIdentity`, `methodsByReceiver`, promoted-method
lookups, and the full sorted candidate list on the same generation-scoped `scope` object
`searchScope`'s `packageCount` already uses (`_scopeEntries` in `worker/index-core.js`), keyed
by `(origin, project, ref, mutationGeneration)` and, for candidates/promoted-methods, further by
interface/record identity. A mutation (`indexPackage`, `disposeProject`, `clear`) still bumps
`mutationGeneration` or deletes the scope-cache entry outright, so nothing new to invalidate.

`npm run bench -- --filter findImplementations`:

| case | median(ms) | p95(ms) | ops/s |
|---|---|---|---|
| page 1 [small: 40x8 (~320 files)] | 0.003 | 0.026 | 390244 |
| page 2 via cursor [small: 40x8 (~320 files)] | 0.002 | 0.006 | 551876 |
| page 1 [large: 1200x16 (~19,200 files)] | 0.001 | 0.002 | 666667 |
| page 2 via cursor [large: 1200x16 (~19,200 files)] | 0.003 | 0.003 | 400000 |

Both cases collapse to sub-millisecond at every scale, page 1 included — not just page 2. That's
because the harness's own `implementationsSetup` already calls `findImplementations` once (to
capture `firstPageCursor`/assert `hasMore`) before any timed iteration runs, and 5 warmup calls
run before that; with memoization, that single priming call is enough to make *every* later call
against the same interface — cursor or not — a cache hit. The harness can no longer isolate a
genuinely cold call, so a separate one-off script measured that directly at large scale, on a
fresh index that had never seen `findImplementations` before:

```
cold (first-ever call):          126.588ms
warm (page 2 via cursor):        0.059ms
warm (repeat page 1, no cursor): 0.009ms
speedup (cold / warm page2):     2162.3x
```

(Cold is slower here than the pre-fix baseline's ~22ms median because this interface's
`records.find(...)` lookup and full candidate build/sort now run once, un-amortized by warmup —
still a single call, same shape of work the old code did on every call. `pkg000`'s `Doer`
interface sorts near the front of the large fixture's package list, so this number is a
representative single-cold-call cost, not a worst case.) The 2162x speedup from cold to warm
page 2, on the same scope object, is the concrete "nothing was reused, now everything after the
first call is" signal the fix targets.
