# Implement GitLab Host page projection

Status: ready-for-agent
Blocked by: 18

## Acceptance criteria

- Observe supported reviews and replace them when immutable review identity or head changes.
- Bind Diff targets and intentions to a Host revision and reject stale actions.
- Deliver ordered intentions and coalesce rendered revisions.
- Apply complete idempotent projections for Rapid and legacy diffs.
- Support fullscreen, search, reveal, expansion, full-file, destination, and copy actions.
- Keep GitLab DOM details private and Lit confined to GoLens Shadow DOM.
- Preserve dialog accessibility, focus, Escape, reduced motion, teardown, and event contracts.
