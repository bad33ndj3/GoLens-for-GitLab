# 01 — Audit tests and docs against current features

Label: `wayfinder:task`
Status: closed
Assignee: claude
**Blocked by:** none

## Question

Do the existing tests, `AGENTS.md`, `README.md`, and other repo docs still match the extension's
actual current features and behaviour? Freezing intentional behaviour changes (constraint of this
whole effort) only makes sense if what "current behaviour" *is* is accurately written down first.

Check:
- Does `AGENTS.md` describe any control, shortcut, onboarding step, or storage key that no longer
  exists, or omit one that does?
- Does `README.md` (and any other top-level docs) match?
- Do `tests/*.test.js` cover the critical functionality named in `AGENTS.md` — the four page controls,
  hover/click/definition resolution, bookmarks, onboarding, shortcuts, cache, self-hosted host access —
  well enough to catch a regression during a later structural refactor? Judge against existing
  coverage; do **not** add new tests just because coverage could theoretically be higher. Only flag or
  add tests where a critical behaviour has no coverage at all.
- Does `docs/agents/domain.md` and `docs/agents/issue-tracker.md` still hold?

Update stale docs directly. If a genuine coverage gap in critical functionality is found, note it
under the map's **Not yet specified** section (don't silently add tests for out-of-scope gaps) rather
than expanding this ticket's scope.

## Answer

Docs and tests mostly match current behaviour. Fixed two real gaps, found no others worth acting on:

- `docs/agents/domain.md` described a generic `src/` + `docs/adr/` layout that doesn't exist in this
  repo (flat root files, no `src/`). Rewritten to reflect the actual layout.
- `AGENTS.md`'s "Build, Test, and Development Commands" and "Project Structure" sections never
  mentioned `npm run bench`, `npm run package`, `npm run release`, or the `scripts/` directory's
  contents, even though `scripts/benchmark.mjs`, `scripts/package-extension.mjs`, and
  `scripts/release-extension.mjs` exist with their own tests (`tests/benchmarks-smoke.test.js`,
  `tests/release-extension.test.js`) and `docs/benchmarks/README.md`. Added them.

Checked and confirmed accurate, no changes needed:
- `README.md`'s feature list (hover/click/Cmd-F12 navigation, focus mode, caching, bookmarks,
  mascot celebrations including the Friday lap, shortcut coach) against `content.js`,
  `shortcut-settings.js`, and their test files — all present and covered
  (`content-celebrations.test.js`, `content-friday.test.js`, `content-bookmarks.test.js`,
  `shortcut-coach-ui.test.js`).
- The four-control strip (`focus-toggle`, `preload-toggle`, `bookmark-toggle`, on/off) matches
  `AGENTS.md`'s description exactly.
- Default shortcut bindings (`Primary+F12`, `Alt+F5`, `Alt+PageUp/Down`, `Primary+KeyP`,
  `Shift+KeyF`, etc.) in `shortcut-settings.js` match what `README.md` and onboarding copy in
  `content.js` claim.
- `extension-cache-ui.js` has no dedicated test file, but its exports (`cacheRequest`,
  `createFullProjectCacheController`, `formatBytes`) are exercised through DOM-level assertions in
  `tests/popup.test.js` and `tests/settings.test.js` — consistent with `AGENTS.md`'s own testing
  convention (coverage grouped by consuming surface, not by source file). Not a gap.
- `docs/agents/issue-tracker.md` (GitHub Issues) still holds as the repo default; this effort itself
  uses `.scratch/` per explicit user override, noted on the map.

No characterisation-coverage gaps in critical functionality found — existing 167 tests across
onboarding, shortcuts, bookmarks, cache, hover/navigation, and the worker protocol are judged
sufficient to catch regressions during the coming structural refactor. Nothing added to the map's
"Not yet specified".

`npm run check:syntax` and `npm test` (167/167) both pass after the doc edits.
