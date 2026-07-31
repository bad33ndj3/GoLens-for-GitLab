# Compose rewrite extension entries

Status: ready-for-agent
Blocked by: 20

## Acceptance criteria

- Keep the content entry a thin composition root with no package internals.
- Start Go Intelligence worker, cache, and messaging from the worker entry.
- Restore popup and settings parity through public capabilities.
- Expose setup, coach, bookmark, semantic, and cache workflows through intentions and projections.
- Use the same built JS and CSS for static and dynamic content registration.
- Cover all four entries through contract tests.
- Produce a complete replacement artifact while the legacy root extension remains the release default.
