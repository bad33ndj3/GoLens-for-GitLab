## GoLens design mock — build conventions

**No provider or root wrapper is required.** Every component is a plain, self-contained function component — no context, theme, or router dependency. Import and render directly:

```tsx
import { Button, Toggle, CacheCard } from 'golens-design-mock';
```

**Styling idiom: plain CSS classes, no CSS-in-JS, no Tailwind.** Every class is prefixed `golens-` and BEM-style modifiers use `--` (`golens-button--primary`, `golens-button--destructive`). Compose classes with plain string concatenation, e.g. `['golens-button', `golens-button--${variant}`].filter(Boolean).join(' ')`. Never invent a new prefix or utility-class vocabulary — extend the existing `golens-*` families instead. Real names in use today: `golens-button`, `golens-icon-button`, `golens-toggle`, `golens-progress`, `golens-status`, `golens-popup-header`, `golens-cache-card`, `golens-sidebar`, `golens-sidebar-tab`, `golens-preference-row`, `golens-host-form`, `golens-host-row`, `golens-shortcut-row`, `golens-help-card`, `golens-bookmark-marker`, `golens-discussion-line-link`.

**All visual values are CSS custom properties on `:root`/`.golens-scope`**, never hard-coded hex or px in a component's own rules beyond structural layout. Color: `--golens-surface-*`, `--golens-text-*`, `--golens-accent-*`, `--golens-{primary,info,success,error}[-hover|-pressed|-soft]`. Spacing: `--golens-space-1` (4px) through `--golens-space-6` (32px). Radius: `--golens-radius-{xs,sm,md,lg,xl,control,panel,overlay}`. Shadow: `--golens-shadow-{sm,md,lg,control,overlay,focus}`. Motion: `--golens-motion-{fast,base}` + `--golens-ease-out`. When building a new composition, read values from these tokens — never introduce a raw color.

**Where the truth lives:** `_ds/styles.css` is the full token + component stylesheet (the only stylesheet — nothing is generated at runtime). Per-component API is in each `<Name>.d.ts`; per-component usage is in each `<Name>.prompt.md`.

**One idiomatic build snippet** (a settings preference row using real tokens and the shipped component):

```tsx
import { PreferenceRow } from 'golens-design-mock';

<div style={{ display: 'grid', gap: 10, background: 'var(--golens-surface-canvas)', padding: 16 }}>
  <PreferenceRow
    title="Hide generated files"
    description="Uses GitLab's .gitattributes marker. Large collapsed files remain visible."
    checked={true}
    onCheckedChange={setHideGenerated}
  />
</div>
```

This mock is a from-scratch, hand-authored recreation of a real shipping browser extension's UI (GoLens for GitLab) — not a generated or placeholder library. Treat its 15 components and their tokens as the extension's actual design language.
