# 17 — Feature-migratie: keyboard-nav

**What to build:** Hunk-/file-toetsnavigatie en het shortcut-coach-aanbod uit `go-navigation.js`
(plus de shortcut-matching-aansturing uit `content.js`) worden `features/keyboard-nav` met
`mount(ctx) → { unmount, offerShortcutCoach(context) }`. `ctx` levert `overlays.isAnyOpen()`
(vervangt definitief de oude DOM-check) en een door lifecycle geïnjecteerde capability om
navigatie-acties aan (nog legacy) code-intel door te geven. Pure target-berekening als core;
DOM-scrolling/hints in de shell. Legacy-code direct verwijderd.

**Blocked by:** 11 — lifecycle-orchestrator; 12 — overlay-registry.

**Status:** ready-for-agent

- [ ] Alle bestaande shortcuts en het coach-aanbod gedragen zich identiek
- [ ] Suppressie via `overlays.isAnyOpen()`; geen DOM-reads van andermans roots
- [ ] Target-berekening puur en los getest
- [ ] Volledige `npm run check` groen
