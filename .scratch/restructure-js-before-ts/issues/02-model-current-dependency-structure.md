# 02 — Model the current dependency structure and architectural pressure points

Label: `wayfinder:task`
Status: closed
Assignee: claude
**Blocked by:** none

## Question

What does the *current* dependency structure across the five large files actually look like, and
where is it under the most strain? This is raw material for ticket 03 (target module boundaries) — it
describes what exists, it does not decide what should exist.

Produce a dependency map covering, for `go-navigation.js`, `content.js`, `go-semantic-core.js`,
`go-semantic-cache.js`, and `go-semantic-worker.js`:
- Who calls whom directly (function/class level is fine; file-level granularity is the floor).
- Where state crosses file boundaries — shared globals, module-level mutable state, DOM as shared
  state, `postMessage`/worker protocol payloads, `chrome.storage` keys read/written from more than one
  file.
- Cycles or near-cycles (A depends on B which depends back on something A owns).
- Any file acting as a dependency hub (many unrelated things route through it).
- Places where policy/decision logic (what to do) and infrastructure/side effects (DOM mutation,
  network, storage) are interleaved in the same function, rather than separated.

Write the result as an asset (a markdown document with a dependency diagram or table) linked from this
ticket's resolution — don't just describe it in prose in the answer field.

## Answer

Full dependency map written to
[02-dependency-map.md](02-dependency-map.md). Summary:

- `go-navigation.js` is the dominant hub — the only bridge between the page DOM/`content.js` and
  the semantic-index worker, carrying ~6 largely unrelated feature areas (hover/click resolution,
  popover UI, full-project search, bookmarks, occurrence highlighting, hunk/file navigation, MR
  preloading) through one 3096-line file and one ~25-field `state` object.
- `content.js` is a secondary hub for page-lifecycle/UI-chrome concerns (onboarding, settings
  overlay, bookmark drawer, mascot celebration polling, generated-file hiding, extension-message
  dispatch), similarly funneled through one file and one `state` object. It's a pure consumer of
  `go-navigation.js` via `globalThis.GoLensGoNavigation` (one-directional), except for one
  near-cycle: `go-navigation.js`'s `shortcutCoachBlocked` reads `#golens-onboarding-root`/
  `#golens-settings-root` directly off the DOM that `content.js` owns, bypassing the API boundary.
- `go-semantic-core.js` and `go-semantic-cache.js` are clean leaf ES modules — no imports, no
  `chrome.*`, no DOM. `go-semantic-worker.js` is the only importer of both, and the sole far side
  of the one real cross-context channel (`chrome.runtime.connect('golens-go-rpc')` port RPC,
  request `{id, method, params}` / response `{id, ok, result|error}`).
- No genuine cycles found; the closest is state left behind by one `go-semantic-worker.js` RPC call
  (`restoreMergeRequest`'s mid-loop early return) affecting the correctness of a later, separate RPC
  call's result.
- Shared state crossing file boundaries is almost entirely `globalThis.GoLens*` properties, a
  handful of DOM ids/classes/CSS custom properties, and `chrome.storage.sync` keys — all four sync
  keys (`enabled`, `hideGeneratedFiles`, `shortcutCoachEnabled`, `shortcutBindings`) turn out to be
  written from at least two of `content.js`/`popup.js`/`settings.js`/`shortcut-settings.js`, not
  just read by `content.js` as it first appears. Plus one dead contract (`golens-go-status` custom
  event, dispatched, never listened to anywhere in the repo — confirmed by grep).
- Policy/infrastructure interleaving is pervasive across all five files (see map §6) — none of the
  five files currently separate "decide what to do" from "do it" at the function level.
