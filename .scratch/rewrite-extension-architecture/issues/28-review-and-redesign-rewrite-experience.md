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
