# Legacy performance baseline

Measured on 2026-07-31 with Node v26.5.0 on darwin-arm64. The canonical
command is:

```sh
GOLENS_PERF_SAMPLES=10 npm run measure:legacy
```

The command starts every sample in a fresh process, forces garbage collection
around retained-heap measurement, asserts every expected result, and emits a
machine-readable JSON report. It exits non-zero when the legacy implementation
does not finish a workload or returns an incorrect semantic or cache result.

## Workloads

- Large merge request: 80 Rapid Diff files and 8,000 rendered lines. Happy DOM
  runs the real `content.js`; initialization starts immediately before module
  injection and ends when all full-file controls exist. Mutation reconciliation
  replaces the complete diff tree and ends when all replacement controls exist.
- Semantic project: 101 files, 10,307 lines, and 380,665 source bytes across 50
  implementation packages plus one interface package. Hover resolves a
  same-package call; jump finds all 50 structural interface implementations.
- Related cache: 21 files across the interface package and ten implementation
  packages.
- Full-project cache: all 101 project files. Cache timings include hashing,
  snapshot processing, restore, Tree-sitter parsing, and indexing.

## Ten-sample result

| Metric | Median | p95 / maximum sample |
| --- | ---: | ---: |
| Large-MR initialization | 450.271 ms | 506.852 ms |
| Full-tree mutation reconciliation | 377.094 ms | 541.141 ms |
| Full-project semantic index | 187.856 ms | 237.053 ms |
| Hover semantic query, within-run median | 0.0233 ms | 0.0242 ms |
| Hover semantic query, within-run p95 | 0.0391 ms | 0.0424 ms |
| Implementation jump, within-run median | 0.1069 ms | 0.1218 ms |
| Implementation jump, within-run p95 | 0.1952 ms | 0.2481 ms |
| Related-cache processing | 38.492 ms | 57.914 ms |
| Full-project cache processing | 170.001 ms | 189.188 ms |
| Retained semantic heap after GC | 15,860,104 bytes | 15,865,248 bytes |

With ten samples the report's p95 is the slowest observed sample. “Set the
rewrite performance budgets” must choose the comparison statistic and
tolerance; these measurements are evidence, not budgets by themselves.

## Interpretation and boundaries

- Large-diff DOM work is the dominant deterministic latency in this fixture.
  Semantic hover and jump computation is sub-millisecond after indexing.
- Retained semantic heap is the reliable memory signal: approximately 15.13
  MiB for 380,665 source bytes after forced GC. Total Chromium, renderer, or
  extension-process memory includes runtime noise and service-worker lifecycle
  effects and is not suitable for an absolute cross-machine gate.
- Cache timings intentionally exclude network and IndexedDB latency. Those vary
  with GitLab, fixture delays, browser storage, and machine state. Test cold and
  shared-cache behaviour for correctness, and use same-run legacy-versus-rewrite
  comparisons if an end-to-end latency gate is needed.
- Hover and jump figures isolate the semantic core. Browser-event dispatch,
  rendering, source fetching, and worker wake-up belong in same-run Playwright
  comparisons rather than these absolute CPU floors.
- Happy DOM is not a Chromium performance model. The DOM figures are a stable
  differential workload for the real legacy content script, suitable for
  legacy-versus-rewrite comparisons on the same runtime and machine.
- The existing browser smoke constraint—less than 40 ms maximum timer delay
  while streaming 80 files and 800 lines—remains a separate red-capable legacy
  floor until the performance-budget ticket replaces or incorporates it.
