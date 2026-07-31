# Set the rewrite performance budgets

Type: `grilling`
Status: resolved
Blocked by: 10

## Question

Which evidence-based budgets and comparison rules should block the rewrite when the new implementation regresses a primary performance path?

## Answer

Gate the rewrite with ten fresh-process samples of the unchanged legacy and
rewrite workloads in the same job, on the same runtime and machine. Compare
medians, not the recorded 2026-07-31 numbers: those numbers prove the workloads
and give diagnostic context, but are not portable thresholds.

The rewrite fails when any of these primary-path budgets is exceeded:

- Large-MR initialization, full-tree mutation reconciliation, full-project
  indexing, related-cache processing, or full-project cache processing has a
  rewrite median above `max(legacy median * 1.20, legacy median + 5 ms)`.
- Retained semantic heap after forced garbage collection has a rewrite median
  above `legacy median * 1.15`.
- The semantic-core fixture exceeds a 1 ms within-run p95 hover query or a 2 ms
  within-run p95 implementation jump. These absolute ceilings avoid treating
  timer noise around the sub-millisecond legacy results as a meaningful ratio.
- The Playwright streamed-diff fixture records a maximum timer delay of 40 ms
  or more. Keep this existing responsiveness floor; do not replace it with a
  total page-load threshold.

Every performance run must first pass the workload's result and completeness
assertions. A faster incomplete result is a failure, not a performance win. A
gate fails on one complete ten-sample comparison; rerunning only the failing
side is invalid. If infrastructure noise is suspected, rerun the whole paired
comparison and retain both reports with the merge-request evidence.

Network transfer, IndexedDB latency, worker wake-up, GitLab rendering, and total
Chromium memory receive no cross-machine absolute budget. Cover their cold,
warm, cancellation, and cache-reuse behaviour with Playwright correctness
checks. Any timing claim for them must use a paired legacy-versus-rewrite run on
the same fixture and environment; it blocks only when the rewrite median is
more than 20% and 25 ms slower. Do not combine unrelated metrics into one score,
and do not trade a regression in one primary path for a gain in another.
