# Add rewrite build and architecture guardrails

Status: resolved
Blocked by:

## Acceptance criteria

- Strict typechecking and a production build create a validated unpacked four-entry extension.
- The content entry is classic-script compatible; worker, popup, and settings are modules.
- An explicit runtime allowlist rejects missing references, unexpected files, source maps, tests, and TypeScript.
- Playwright proves a built content-script-to-worker round trip in a persistent context.
- Architecture checks reject forbidden imports and runtime cycles without adding a dependency.
- Failed production and watched builds preserve the last valid artifact; `dist/` remains untracked.
- The legacy root extension remains releaseable.

## Answer

Added the strict TypeScript/esbuild rewrite build, explicit runtime allowlist and
reference validation, shared static/dynamic content-script registration,
serialized last-valid watch publication, dependency/cycle enforcement, and a
Playwright persistent-context content-to-worker check. CI and release checks now
install Playwright Chromium and validate the rewrite beside the unchanged legacy
root extension.
