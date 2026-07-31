# Enforce rewrite performance budgets

Status: ready-for-agent
Blocked by: 22

## Acceptance criteria

- Compare ten fresh-process legacy and rewrite samples in the same job using medians.
- Fail primary paths above `max(legacy * 1.20, legacy + 5 ms)`.
- Enforce retained heap at 115%, hover p95 at 1 ms, implementation p95 at 2 ms, and streamed delay below 40 ms.
- Gate environment-dependent paths only when both 20% and 25 ms slower.
- Validate correctness and completeness before sampling.
- Emit per-path machine-readable reports without a combined score.
- Rerun the complete paired comparison, never only one side.
