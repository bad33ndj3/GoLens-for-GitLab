# 21 — Feature-migratie: code-intel

**What to build:** De grootste slice: hover/click-resolutie, de popover en occurrence-highlighting
uit `go-navigation.js` worden één deep module `features/code-intel` met
`mount(ctx) → { unmount, setEnabled(bool), navigationAction(name) → boolean }` (ticket 04 §3).
Popover-DOM en highlight-mechaniek zijn implementatiedetail. De 11-way `showResult`-branching wordt
de gesloten `kind`-set van de query-resultaten (ticket 04 §5); resolutie-orkestratie in de shell,
presentatie-/classificatiebeslissingen puur. De keyboard-nav-capability uit ticket 17 schakelt om
van legacy-bridge naar deze handle. Legacy-code direct verwijderd.

**Blocked by:** 09 — platform/rpc-client; 11 — lifecycle-orchestrator; 12 — overlay-registry.

**Status:** done

- [x] Hover, click, pin/dismiss, highlighting en referentie-navigatie identiek (perf niet geregresseerd)
- [x] Alle resultaatstatussen als gesloten `kind`-set; missing/ambiguous nooit een gok
- [x] Keyboard-nav werkt via de handle-capability; laatste legacy-bridge voor deze feature weg
- [x] Volledige `npm run check` + browser-smoke groen

## Notes (afronding)

**Ticket 08 clock-bridge (`scheduleDiffReconciliation`/`legacyDebounceIdleFactory`) verwijderd, niet
verplaatst.** Dat mechanisme dreef alleen occurrence-refresh na diff-DOM-mutaties — nu code-intel.js's
eigen zorg via een plain `setTimeout`-debounce (`scheduleOccurrenceRefreshFromMutation`, 50ms +
`scheduleOccurrenceRefresh`'s eigen 30ms, dezelfde timing-compositie als het origineel). Dezelfde keuze
als ticket 18 voor bookmarks.js maakte: geen afhankelijkheid van page/platform/clock.js's async-ready
races voor "exact dezelfde getallen" garanderen. `fileContextGeneration`-invalidatie blijft in
go-navigation.js's eigen (vereenvoudigde) diffObserver — ongemoeid. `grep` bevestigt
`clockReady`/`debounceIdle`/`requestIdle`/`loadClockModule` volledig weg uit go-navigation.js (op een
kale `requestIdle`-fallback in het basis clock-object na).

**Testsplitsing:** `tests/go-navigation-context.test.js` (1077 → 505 regels) verloor alle code-intel-
gerelateerde cases naar `tests/code-intel-internal.test.js` (19 tests, pure functies uit
`code-intel.internal.js`) en `tests/features-code-intel.test.js` (15 tests, `mount()`-gedrag via een
fake `legacy`). De twee dode ticket-08 `getScheduleDiffReconciliation`-tests en de stale
`await helpers.clockReady` in `before()` zijn verwijderd. `before()` kreeg een niet-lekkend
`globalThis.document` (was voorheen een toevallige lek van een DOM-test die nu weg is — sommige
pagination-tests bleken daarvan af te hangen; nu expliciet gezet).

**Bewuste afwijking van ticket 04 §1** ("testoppervlak = handle + pure `internal.js`-functies"):
`code-intel.js`'s `mount()`-handle draagt een `__test: { caretAtPoint, occurrenceRanges }`-bag, puur
voor `tests/benchmarks/diff-dom.bench.mjs` — ticket 24's perf-baseline benchmarkt die twee functies bij
naam, en 13-21's "geen perf-regressie"-criterium is alleen toetsbaar als die rijen vergelijkbaar
blijven. Niet voor gebruik buiten `tests/benchmarks/`. De occurrence-highlighting-gedragsdekking die
hierdoor uit `go-navigation-context.test.js` verdween (de directe `occurrenceRanges`/`targetForOccurrence`-
assertie) is opnieuw gedekt in `features-code-intel.test.js` via het publieke pad (klik -> `selectSymbol`
-> `navigationAction('nextOccurrence')` -> toast + `selectedOccurrenceSourceLocation()`), zonder extra
export.

**Perf-meting (`npm run bench`, standaard heap) tegen ticket 24's baseline — geen regressie:**

```
case                                                                                baseline (24)  nu
fileContextFor x1000 (uncached, 60x120 diff, un-throttled mousemove path)                1.530ms   1.596ms
codeCellFor x1000 (uncached, 60x120 diff, hit-test path)                                 0.220ms   0.213ms
caretAtPoint x1000 (uncached, 60x120 diff, hover hit-test path, stubbed caret hit-test)  68.03ms   67.77ms
occurrenceRanges (8x3 diff, reduced from 60x120)                                         6.739ms   7.121ms
```

Alle vier binnen ruis van de baseline; `caretAtPoint`/`occurrenceRanges` nu gemeten via
`code-intel.js`'s `mount().__test`-bag in plaats van go-navigation.js's oude `__test`.

**`npm run check`** (syntax + 437 node-tests + browser-smoke) groen. `browser-smoke.mjs` bleek al
vlokkerig op deze machine — 4 van 7 losse runs slaagden, falend op uiteenlopende, aan code-intel
ongerelateerde scenario's (SPA-remount-timing, settings-message-timing), nooit op het code-intel-
popover-scenario zelf zodra het zover kwam. Beoordeeld als bestaande omgevingsvlokkerigheid
(headless-Chrome-onder-belasting), niet als regressie door deze ticket — noch page/main.js's
lifecycle/mount-volgorde noch bootstrap.js zijn in deze ticket gewijzigd buiten het toevoegen van de
`code-intel`-feature-entry.
