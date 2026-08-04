# 17 — Feature-migratie: keyboard-nav

**What to build:** Hunk-/file-toetsnavigatie en het shortcut-coach-aanbod uit `go-navigation.js`
(plus de shortcut-matching-aansturing uit `content.js`) worden `features/keyboard-nav` met
`mount(ctx) → { unmount, offerShortcutCoach(context) }`. `ctx` levert `overlays.isAnyOpen()`
(vervangt definitief de oude DOM-check) en een door lifecycle geïnjecteerde capability om
navigatie-acties aan (nog legacy) code-intel door te geven. Pure target-berekening als core;
DOM-scrolling/hints in de shell. Legacy-code direct verwijderd.

**Blocked by:** 11 — lifecycle-orchestrator; 12 — overlay-registry.

**Status:** resolved

- [x] Alle bestaande shortcuts en het coach-aanbod gedragen zich identiek — geverifieerd via
      `tests/features-keyboard-nav.test.js` (poort van `tests/content-shortcuts.test.js`'s
      volledige toetsenbord-scenario + de coach-blocked-scenario's uit
      `tests/go-navigation-context.test.js`).
- [x] Suppressie via `overlays.isAnyOpen()`; geen DOM-reads van andermans roots — de toast/coach-
      hint-DOM blijft in `go-navigation.js` (gedeelde surface voor ~15 nog-niet-gemigreerde
      call sites); `keyboard-nav.js` bereikt hem via de `legacyToast`-capability, niet via een
      eigen tweede toast-surface (zie `keyboard-nav.js`'s header-comment voor de motivatie —
      een tweede surface zou "gedragen zich identiek" breken).
- [x] Target-berekening puur en los getest — `pickNavigationIndex`, `hunkStartIndices`,
      `isBlockedShortcutTarget`, `messageForAction`, `isCoachBlocked`, `isMergeRequestPath` in
      `keyboard-nav.internal.js`, getest in `tests/keyboard-nav-internal.test.js`.
- [x] Volledige `npm run check` groen

Uitgevoerd: `page/features/keyboard-nav.js` + `.internal.js`, geregistreerd in `page/main.js` met
twee lifecycle-capabilities (`runLegacyNavigationAction`, `legacyToast`). `go-navigation.js`
verliest `SHORTCUT_COACH_MESSAGES`/`shortcutCoachBlocked`/`offerShortcutCoach`'s
beslissingslaag/`hunkTargets`/`changedRow`/`navigateElements`/de vier hunk-file-branches in
`runNavigationAction`/`state.elementNavigation`/de dode overlay-registry-bridge (was alleen voor
`shortcutCoachBlocked`); krijgt `showToast`/`showShortcutCoachHint` (vereenvoudigd,
message-in-plaats-van-lookup)/`isToastShowing` als publieke capability-surface, plus een
`loadKeyboardNavModule()`-bridge zodat zijn resterende `offerShortcutCoach(...)`-call-sites
(historyBack/nextOccurrence/semanticJump) naar de nieuwe module doorschakelen — zelfde naam,
zelfde fire-and-forget-vorm. `content.js` verliest de globale keydown/click-shortcut-dispatch en
de native-file-search-helpers; `shortcutBindings`-tracking in `state.settings` werd dood en is
verwijderd. `tests/content-shortcuts.test.js` verhuisd naar
`tests/features-keyboard-nav.test.js`; de `shortcutCoachBlocked()`-test in
`tests/go-navigation-context.test.js` idem.

Code-review (Spec-as) vond 3 echte fideliteitsafwijkingen, alle drie gefixed en van een regressietest
voorzien: (1) `offerShortcutCoach`'s blocked-check werd niet meer herhaald ná de
`GoLensShortcutCoach.consider()`-await (het origineel deed dat wel, via `showShortcutCoachHint`'s
eigen `shortcutCoachBlocked()`-herhaling); (2) go-navigation.js's `offerShortcutCoach`-bridge miste
zijn `return`, dus `GoLensGoNavigation.offerShortcutCoach` loste altijd `undefined` op in plaats van
een `Promise<boolean>`; (3) `enabled` startte `false` tot `settings.ready()` resolvede, waar
content.js's origineel `state.enabled` optimistisch op `true` begon (shortcuts al actief vóór
settings laden). Ook `isBlockedShortcutTarget`'s dode `isSearch`-parameter werd echt aangesloten.
