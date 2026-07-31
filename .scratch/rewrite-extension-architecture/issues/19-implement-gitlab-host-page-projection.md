# Implement GitLab Host page projection

Status: resolved
Blocked by: 18

## Acceptance criteria

- Observe supported reviews and replace them when immutable review identity or head changes.
- Bind Diff targets and intentions to a Host revision and reject stale actions.
- Deliver ordered intentions and coalesce rendered revisions.
- Apply complete idempotent projections for Rapid and legacy diffs.
- Support fullscreen, search, reveal, expansion, full-file, destination, and copy actions.
- Keep GitLab DOM details private and Lit confined to GoLens Shadow DOM.
- Preserve dialog accessibility, focus, Escape, reduced motion, teardown, and event contracts.

## Answer

Added immutable review observation and revision-bound host bindings with ordered
intentions, stale-action rejection, and complete idempotent projections for
Rapid and legacy diffs. The private DOM adapters normalize targets, generated
and test-file presentation, shortcuts, full-file controls, search, fullscreen,
reveal, destination, and copy actions behind the public host contract. Lit is
confined to accessible GoLens Shadow DOM surfaces with focus restoration,
Escape handling, reduced motion, and deterministic teardown.
