# design-sync notes — golens-design-mock

This package is a hand-authored React/TS recreation of the shipped extension's UI
(popup, settings, control-rail/bookmark/discussion widgets), built purely to give
Claude Design something real to build with. It is not generated from the
extension's actual `popup.html`/`settings.html`/`gitlab-lens.css` at build time —
those stay the source of visual truth; this package is a manual port of their
tokens and markup into React components.

## Known render warns
- None outstanding. The `[GRID_OVERFLOW]` warnings across two waves
  (CacheCard, HostForm, HostRow, PopupHeader, PreferenceRow, ShortcutRow, then
  ChoiceRow) were resolved via `cfg.overrides.<Name>.cardMode = "column"` —
  see `config.json`.

## Coverage gap caught post-upload
- The first pass (15 components) missed the extension's actual centerpiece:
  the **Go intelligence popover** shown on hovering/clicking a recognized Go
  symbol in a diff (source: `page/features/code-intel.js` +
  `code-intel.internal.js` in the parent repo). Added in a second wave:
  `SymbolBadge` (12 kind badges, colors ported 1:1 from
  `code-intel.js`'s `.symbol-*` rules), `ChoiceRow` (one candidate in the
  definition/references/implementations choice list), and
  `GoIntelligencePopover` (the composite: header with copy/close actions,
  loading state, signature block, docs, scope caption, choices list,
  shortcut-hint footer). Before syncing a UI surface again, re-check
  `DESIGN.md`'s "five user-facing surfaces" list against what's actually
  been mocked — control rail, onboarding dialog, and the full onboarding
  flow are still NOT covered.

## Re-sync risks
- **Drift from the real extension.** If `../golens-theme.css`, `../popup.css`,
  `../settings.css`, or `../gitlab-lens.css` change in the parent repo, this
  package's `src/styles.css` and component markup will NOT auto-update — someone
  has to manually re-port the change. There is no build-time link between them.
  This now also applies to `../page/features/code-intel.js`'s popover markup/CSS.
- **`src/styles.css` is hand-maintained**, not generated from the real CSS files.
  Class names are a fresh `golens-*` vocabulary invented for this mock, not a
  1:1 copy of the original (data-attribute-driven) class names.
- All 18 components have authored previews (1-4 cells each) graded `good` on
  the absolute rubric. No floor cards remain.
- No provider/context is used anywhere — every component is self-contained.
- Still not mocked: the five-button control rail, the first-run onboarding
  dialog/flow, and the bookmark-selection root (`#golens-bookmark-selection-root`)
  mentioned in `code-intel.js` but not explored here.
