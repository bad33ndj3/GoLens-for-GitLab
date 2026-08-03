# 14 — Feature-migratie: celebration

**What to build:** De MR-"mascot"-celebration (actie-detectie + discussion/celebration-polling) uit
`content.js` en de bijbehorende statusmethods uit `go-navigation.js` worden
`features/celebration` met `mount(ctx) → { unmount }` — autonoom na mount, pollend via
`rpc.cache`/eigen fetches en de clock. Legacy-code direct verwijderd.

**Blocked by:** 09 — platform/rpc-client; 11 — lifecycle-orchestrator.

**Status:** resolved

- [x] Celebratie-gedrag en polling-cadans ongewijzigd
- [x] `mergeRequestCelebrationStatus`/`mergeRequestDiscussionStatus` niet langer op een globaal contract
- [x] `unmount()` stopt alle polling; geen timers na teardown
- [x] Volledige `npm run check` groen

**Resultaat:**
- `page/features/celebration.internal.js` (pure core, 18 tests) + `page/features/celebration.js`
  (shell, `mount(ctx) → { unmount }`, 5 tests) — actie-detectie, celebratie-/discussion-polling en
  de mascot-overlay, byte-identiek gedrag/markup/cadans overgenomen uit `content.js`.
- **Eigen fetches, geen bridge.** `mergeRequestCelebrationStatus`/`mergeRequestDiscussionStatus`
  waren klein en zonder andere aanroeper (anders dan ticket 19's mr-preload, dat go-navigation.js's
  paginatiehelpers deelde met niet-gemigreerde code) — dus rechtstreeks gedupliceerd (~15 regels) in
  plaats van een `ctx.legacy`-capability-bag; go-navigation.js's kopieën zijn verwijderd, inclusief
  hun plek op `globalThis.GoLensGoNavigation`.
- **Cross-feature pitstop-trigger via module-scope export.** `requestMoment(kind)` forwardt naar de
  actief gemounte instantie (er is er maar één — geen dual-mount zoals ticket 19). `content.js`
  bereikt hem via dezelfde dynamic-`import()`-bridge als settings-store/clock/overlay-registry
  (`triggerPitstopMoment()`), vanuit `preloadMergeRequest`/`startFullProjectPreload`.
- **Mount-once lifetime, niet `pageKey`-getrackt.** `bootstrap.js` remount't de hele
  `page/main.js`-modulegraaf bij elke `location.href`-wijziging (afwijking al gedocumenteerd bij
  ticket 16); dit ticket voegt geen aparte reconcile-op-navigatie toe. Wisselen van tab binnen
  dezelfde MR (Overview → Changes) breekt nu ook de celebratie-/discussion-baseline en een
  lopende poll af, waar `content.js`'s `pageKey`-check ze eerder liet doorlopen — geaccepteerd
  binnen dezelfde "elke href-wijziging"-afwijking, niet oplosbaar binnen dit ticket's
  file-ownership.
- `content.js`: alle celebratie-/discussion-/Friday-state, -functies en de click-listener
  verwijderd; `disableGoLens()`, `leaveMergeRequestPage()`, `setEnabled()`, `closeOnboarding()` en
  de overlay-registry-subscribe hoeven niets meer zelf te doen — `celebration.js` abonneert zich
  zelf op dezelfde overlay-registry-singleton en op `settings.subscribe('enabled', …)`.
  `go-navigation.js`: de twee fetch-functies en hun `globalThis`-export verwijderd.
- Tests: 23 nieuwe tests (`tests/celebration-internal.test.js` + `tests/features-celebration.test.js`).
  `tests/content-celebrations.test.js`/`tests/content-friday.test.js` verwijderd (dekking nu in de
  nieuwe featuremodule-tests). `tests/go-navigation-context.test.js`: 2 tests voor de verwijderde
  fetch-functies verwijderd. `tests/content-onboarding.test.js`: de pitstop/celebratie-assertie na
  preload-completion verwijderd — die test laadt `content.js` los van `page/main.js`, dus
  `celebration.js` is nooit gemount en de bridge no-opt stil; het gedrag wordt al gedekt door
  `features-celebration.test.js`'s eigen overlay-queue-test.

**Afwijkingen van 03/04 (met reden):**
- Zie "Eigen fetches" en "Mount-once lifetime" hierboven.

**Gate-uitkomsten:** `npm run check:syntax` EXIT:0. `npm test` EXIT:0, 312/312. `npm run check`
(incl. `npm run test:browser`) EXIT:0 op de tweede poging — de eerste poging liep vast op de
bekende browser-smoke-flakiness (map.md's correctienotitie), niet op deze wijziging.
