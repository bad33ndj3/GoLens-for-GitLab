# Measure the legacy performance baseline

Type: `task`
Status: resolved

## Question

What reproducible baseline does the current implementation establish for large-MR initialization, mutation reconciliation, hover and jump latency, related and full-project caching, and reliably measurable memory use?

## Answer

Use the reproducible harness and recorded ten-sample result in the
[`Legacy performance baseline`](../assets/legacy-performance-baseline.md). Run
it with `GOLENS_PERF_SAMPLES=10 npm run measure:legacy`.

On Node v26.5.0, darwin-arm64, the 8,000-line real-content-script workload had
a 450.271 ms median initialization and 377.094 ms median full-tree mutation
reconciliation. The 10,307-line semantic workload indexed in 187.856 ms;
within-run p95 hover and implementation-jump queries were 0.0391 ms and 0.1952
ms respectively. Processing and indexing 21 related-cache files took 38.492 ms;
the 101-file full-project cache took 170.001 ms. The full semantic index retained
15,860,104 bytes after forced garbage collection.

These are differential CPU and retained-heap baselines, not universal user
latency promises. Absolute gates may cover these deterministic workloads.
Network, IndexedDB, worker wake-up, browser rendering, and total Chromium memory
must use correctness assertions or same-run legacy-versus-rewrite comparisons;
cross-machine absolute thresholds would measure the environment as much as the
extension. Retain the existing streamed-diff timer-delay check as a separate
legacy floor until “Set the rewrite performance budgets” decides the final
statistics and tolerances.
