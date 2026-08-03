# 21 — Feature-migratie: code-intel

**What to build:** De grootste slice: hover/click-resolutie, de popover en occurrence-highlighting
uit `go-navigation.js` worden één deep module `features/code-intel` met
`mount(ctx) → { unmount, setEnabled(bool), navigationAction(name) → boolean }` (ticket 04 §3).
Popover-DOM en highlight-mechaniek zijn implementatiedetail. De 11-way `showResult`-branching wordt
de gesloten `kind`-set van de query-resultaten (ticket 04 §5); resolutie-orkestratie in de shell,
presentatie-/classificatiebeslissingen puur. De keyboard-nav-capability uit ticket 17 schakelt om
van legacy-bridge naar deze handle. Legacy-code direct verwijderd.

**Blocked by:** 09 — platform/rpc-client; 11 — lifecycle-orchestrator; 12 — overlay-registry.

**Status:** ready-for-agent

- [ ] Hover, click, pin/dismiss, highlighting en referentie-navigatie identiek (perf niet geregresseerd)
- [ ] Alle resultaatstatussen als gesloten `kind`-set; missing/ambiguous nooit een gok
- [ ] Keyboard-nav werkt via de handle-capability; laatste legacy-bridge voor deze feature weg
- [ ] Volledige `npm run check` + browser-smoke groen
