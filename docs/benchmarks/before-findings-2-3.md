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
