# 12 — platform/overlay-registry + near-cycle-break

**What to build:** De `platform/overlay-registry` (interface ticket 04 §2: `claim`/`isAnyOpen`/
`subscribe`) vervangt de DOM-backdoor uit ticket 02 §4: `shortcutCoachBlocked` in
`go-navigation.js` vraagt de registry i.p.v. `#golens-onboarding-root`/`#golens-settings-root` te
lezen. De legacy onboarding-/settings-overlay-code in `content.js` claimt bij openen en released
bij sluiten (via bridge zolang niet gemigreerd). Daarmee is de enige near-cycle uit ticket 02
gebroken vóór de feature-migraties die erop leunen.

**Blocked by:** 11 — lifecycle-orchestrator.

**Status:** resolved

- [x] Geen DOM-read van andermans roots meer; suppressiegedrag van de coach-toast ongewijzigd
- [x] Claims/releases kloppen ook bij SPA-navigatie en overlay-sluiting via alle paden
- [x] Volledige `npm run check` groen

## Resultaat

Trof bij aanvang al een grotendeels afgeronde, niet-gecommitte implementatie aan (working tree had
`page/platform/overlay-registry.js`, `tests/platform-overlay-registry.test.js`, en wijzigingen in
`go-navigation.js`/`content.js`/`tests/go-navigation-context.test.js`). Geverifieerd tegen 03/04/02 §4
en tegen alle gates; geen aanvullende code nodig.

- **`page/platform/overlay-registry.js`**: `createOverlayRegistry()` → `{ claim, isAnyOpen, subscribe }`,
  exact volgens 04 §2. State (`counts`/`listeners`) leeft op modulescope buiten de returned closure, zodat
  `go-navigation.js` en `content.js` — twee losse classic content scripts die elk hun eigen
  `import()` naar dezelfde module-URL doen — dezelfde claims zien zonder `globalThis`-contract (de
  ES-modulecache van de dynamic-import-bootstrap regelt dit). `claim(name)` telt per naam (niet een
  set), zodat dubbele claim/release niet kan desyncen; `release()` is idempotent.
- **`go-navigation.js`**: `shortcutCoachBlocked()` leest niet meer `#golens-onboarding-root`/
  `#golens-settings-root` uit de DOM, maar vraagt `overlayRegistry?.isAnyOpen() ?? false`. Bridge naar
  de module start als IIFE-top-level dynamic `import()` (zelfde patroon als de `debounceIdle`-bridge
  uit ticket 08, commit c736eca) — geen queue-nodig hier, want vóór de import resolvet kan
  `content.js` sowieso nog geen claim hebben gezet (die start zijn eigen import evenzeer async), dus
  "registry nog niet geladen" en "geen overlay open" zijn ononderscheidbaar en geven hetzelfde gedrag
  als de oude DOM-read op dat moment. `overlayRegistryReady` toegevoegd aan `__test` zodat tests
  deterministisch kunnen wachten i.p.v. racen.
- **`content.js`**: claimt bij het openen van onboarding/settings (`showOnboarding`,
  `showFirstRunOnboarding`, `showSettingsOverlay`) en released via de twee enige sluitpaden
  (`closeOnboarding`/`closeSettingsOverlay`), die op hun beurt door Esc, buiten-klik, close-knop én
  SPA-reconcile (`teardown`) worden aangeroepen — dus alle sluitroutes released consequent. Release-
  handles staan in `state.onboardingOverlayRelease`/`state.settingsOverlayRelease`, met optional-
  chaining-guards zodat een mislukte module-load (registry blijft `null`) alleen de registry-publicatie
  degradeert, niet het openen/sluiten van de overlays zelf.
- **Tests**: `tests/platform-overlay-registry.test.js` (nieuw, 9 unit tests: isAnyOpen-basis,
  per-naam telling, idempotente release, module-singleton-eigenschap, subscribe/unsubscribe,
  subscriber-fout isoleren) + één end-to-end test toegevoegd aan
  `tests/go-navigation-context.test.js` die een claim via een los `createOverlayRegistry()`-import
  laat doorwerken in `shortcutCoachBlocked()`, ter vervanging van de oude DOM-backdoor-aanname.

**Afwijkingen van 03/04**: geen. Interface, dependency-richting (`page/platform`, geen
feature→feature/lifecycle-import, geen `globalThis`) en het claim/release-per-sluitpad-gedrag volgen
04 §2 en 03 §7.1 letterlijk.

**Verrassingen**: de implementatie was al aanwezig in de working tree (ongecommit) toen deze uitvoering
begon — waarschijnlijk een eerdere, afgebroken poging. Na verificatie tegen de spec en de drie gates
bleek hij correct en compleet; er is niets herschreven, alleen gecontroleerd en de gates gedraaid.
`npm run test:browser` slaagde in één keer (5/5, geen scenario-5-retry nodig).
