# Add Playwright rewrite parity coverage

Status: resolved
Blocked by: 21

## Acceptance criteria

- Give every observable-behaviour contract row an evidence pointer.
- Exercise all four built entries in a Playwright persistent context.
- Cover Rapid and legacy diffs, navigation, replacement, reconciliation, disablement, fullscreen, settings, onboarding, bookmarks, semantics, and self-hosted access.
- Cover worker restart, cold and warm cache, progress, cancellation, and incomplete Coverage.
- Cover accessibility and reduced motion.
- Preserve the streamed-diff delay ceiling and legacy smoke until the atomic switch.
- Use no raw debugger or WebSocket transport.

## Answer

Added row-by-row rewrite acceptance evidence and a Playwright persistent-context scenario that loads the built content, worker, popup, and settings entries. The scenario covers Rapid and legacy diffs, lifecycle reconciliation, enablement, fullscreen, onboarding, settings and self-hosted validation, bookmarks, semantic Coverage expansion and cancellation, cold/warm cache behavior, accessibility, reduced motion, and the retained 40ms streamed-diff ceiling. Successful self-hosted approval and persistent dynamic registration remain covered at the executable permission seam in `tests/gitlab-host-access.test.js`, where the browser-native permission prompt can be accepted deterministically.

Real-browser coverage also closed five parity defects exposed only at the platform seam: Lit surfaces now render when a content-script document has no custom-element registry, review cleanup preserves onboarding and guide surfaces, physical-code shortcuts match `KeyboardEvent.code`, incomplete interface searches cannot claim absence, and self-hosted validation errors reach the existing live region. The legacy WebSocket smoke remains unchanged pending the atomic switch.
