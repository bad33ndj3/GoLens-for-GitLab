# Review and redesign the rewritten extension experience

Status: ready-for-agent
Blocked by: 26

## Context

The rewritten extension feels faster when it works, but the initial local review
shows a substantial design regression from the previous version. The design
breakage also impairs feature discovery, interaction, and practical use, so this
is product functionality work rather than final visual polish.

Do this only after the architecture rewrite and legacy removal are complete. The
user and agent must review the live extension together before choosing or
implementing the redesign.

## Acceptance criteria

- Review the built extension together with the user across the main GitLab MR,
  popup, settings, onboarding, help, focus, cache, bookmark, hover, and semantic
  navigation workflows.
- Compare the rewritten experience with the previous version and record concrete
  visual, interaction, discoverability, accessibility, and functional regressions.
- Preserve and measure the rewrite's perceived performance improvement; do not
  reintroduce the legacy runtime or architecture to recover its design.
- Agree the redesign direction with the user before implementation, resolving
  product and UX choices one question at a time.
- Implement the approved redesign across affected surfaces, including responsive
  states, errors, loading, empty states, keyboard use, and GitLab DOM variants.
- Update the complete Help reference and focused onboarding tests for every
  changed user-visible behaviour, incrementing `ONBOARDING_VERSION` when the
  first-run experience changes materially.
- Add focused regression coverage for every design defect that broke usage and
  run the complete project check plus live unpacked-extension acceptance.
- Resolve this ticket only after the user reviews and accepts the redesigned
  extension in Chrome.

## Comments

- 2026-08-01: Created from the first local test of the architecture rewrite. The
  user reported that it feels faster when operational, while the new design is
  far behind the previous version and frequently breaks usage.
- 2026-08-02: User-tested MR !9585 and reported the rewrite as unusable. Agreed
  scope: keep the sidebar icons; render one icon-only full-file toggle directly
  before GitLab's `Viewed` control, and only for a file that GitLab can expand;
  use the same toggle for full file versus changes only. Do not pre-index the
  500k-line repository. On a first semantic query without a current-package
  snapshot, silently index that package, show progress on the existing cache
  icon, then retry; repository-wide search remains explicit and is a small
  anchored popover. A genuine package-index failure must be local/retryable,
  never a blocking dialog.
- 2026-08-02: Implemented but not committed: `src/gitlab-host/dom.ts` now
  filters non-expandable files and mounts the existing Lit full-file control
  before `Viewed`; `src/gitlab-host/surfaces.ts` makes it an icon toggle with a
  spinner and retry tooltip; `src/review-session/reducer.ts` and `runtime.ts`
  request `current-package` coverage automatically and retry the original
  query. Added focused contract coverage in
  `tests/contracts/gitlab-host.test.js` and
  `tests/contracts/review-session.test.js`; updated the legacy host fixture in
  `tests/private/gitlab-host-dom.test.js` to mark its second file expandable.
- 2026-08-02: Verification completed: `npm run typecheck`, `npm test` (216
  passing), and `npm run build`. `npm run test:rewrite-browser` did not run:
  its preflight rejects the currently active Node 26 because this repository
  requires Node 24. Switch to Node 24, then run that browser suite, review the
  exact diff against the user's existing uncommitted UI work, and commit only
  the intended scope. Do not discard the pre-existing edits in
  `src/gitlab-host/index.ts`, `src/gitlab-lens.css`, `src/golens-theme.css`, or
  `src/settings.ts`.
