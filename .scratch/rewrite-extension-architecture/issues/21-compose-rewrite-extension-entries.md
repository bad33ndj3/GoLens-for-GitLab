# Compose rewrite extension entries

Status: resolved
Blocked by: 20

## Acceptance criteria

- Keep the content entry a thin composition root with no package internals.
- Start Go Intelligence worker, cache, and messaging from the worker entry.
- Restore popup and settings parity through public capabilities.
- Expose setup, coach, bookmark, semantic, and cache workflows through intentions and projections.
- Use the same built JS and CSS for static and dynamic content registration.
- Cover all four entries through contract tests.
- Produce a complete replacement artifact while the legacy root extension remains the release default.

## Answer

Composed the content, worker, popup, and settings entries exclusively through public package capabilities. The rewrite now exposes setup, coaching, bookmark, semantic, cache, host-access, and guide workflows through intentions and projections, reuses the built content assets for static and dynamic registration, and emits a validated four-entry replacement artifact without changing the legacy release default.

Contract coverage now exercises all four entries, including immutable review replacement, worker messaging, popup cache state, settings parity, and modal focus sequencing.
