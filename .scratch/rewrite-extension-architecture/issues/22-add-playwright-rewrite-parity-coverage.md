# Add Playwright rewrite parity coverage

Status: ready-for-agent
Blocked by: 21

## Acceptance criteria

- Give every observable-behaviour contract row an evidence pointer.
- Exercise all four built entries in a Playwright persistent context.
- Cover Rapid and legacy diffs, navigation, replacement, reconciliation, disablement, fullscreen, settings, onboarding, bookmarks, semantics, and self-hosted access.
- Cover worker restart, cold and warm cache, progress, cancellation, and incomplete Coverage.
- Cover accessibility and reduced motion.
- Preserve the streamed-diff delay ceiling and legacy smoke until the atomic switch.
- Use no raw debugger or WebSocket transport.
