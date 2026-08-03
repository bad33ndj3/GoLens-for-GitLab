# 01 — Audit tests and docs against current features

Label: `wayfinder:task`
Status: open
Assignee: unclaimed
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

<!-- filled in on resolution -->
