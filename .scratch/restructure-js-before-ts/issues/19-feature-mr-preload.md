# 19 — Feature-migratie: mr-preload

**What to build:** MR-scoped preloading en full-project-preload uit `go-navigation.js` worden
`features/mr-preload` met de ticket 04 §3-handle (`preloadMergeRequest`/`preloadStatus`/
`preloadFullProject`/`fullProjectStatus`/`invalidateCache`). Kern van de ontvlechting (ticket 02
§6): `planPreload(diffState)` beslist puur welke packages/searches in welke volgorde, de shell
voert het plan uit via `rpc.cache`/`rpc.index`. Statussen `kind`-gediscrimineerd; lifecycle
routeert `golens-preload-full-project`/`golens-full-project-status`. Legacy-code direct verwijderd.

**Blocked by:** 09 — platform/rpc-client; 11 — lifecycle-orchestrator.

**Status:** resolved

- [x] Preload-gedrag, volgorde en statusrapportage identiek (perf niet geregresseerd)
- [x] `planPreload` puur en los getest, gescheiden van uitvoering
- [x] Statussen met gesloten `kind`-set op de handle (zie afwijking hieronder: veld heet `status`, niet `kind`)
- [x] `npm run check:syntax` en `npm test` groen (`npm run check`/`test:browser` bewust niet gedraaid — instructie van de oproepende agent, flaky onder parallelle load)

## Resultaat

**Gebouwd:**
- `page/features/mr-preload.internal.js` — pure functional core: `planPreload(diffState) →
  [{ packagePath, action: 'load' }]` (kind-gediscrimineerd op `'changed' | 'dependencies' |
  'candidates'`, incrementeel aangeroepen per fase omdat welke pakketten in fase 2/3 horen pas
  bekend is nadat fase 1 relaties heeft opgehaald — dat is inherent, niet een gemiste
  vereenvoudiging), plus `mergeSearchStatus`, `relatedReadyMessage`, `selectRelevantInterfaces`,
  `implementationSearchTerms`, `relatedLoadingProgress`, `relatedLoadingMessage`, en de bewust
  gedupliceerde eenregelige `dirname`/`isCommitSha` (zelfde motivatie als ticket 13's
  `isMergeRequestDiff`-duplicatie: te klein en te stabiel voor een gedeelde platform-module).
- `page/features/mr-preload.js` — de imperative shell: `mount(ctx) → { unmount,
  preloadMergeRequest, preloadStatus, preloadFullProject, fullProjectStatus, invalidateCache }`
  per ticket 04 §3. Voert `planPreload`'s fasen uit via `ctx.legacy`, een capability-bag met
  go-navigation.js's eigen `workerRPC`/`loadPackage`/`loadProject`/`projectContext`/
  `mergeRequestHeadRef`/`mergeRequestIID`/`listMergeRequestChangedFiles`/`modulePathFor`/
  `searchProjectBlobPaths`/`projectLoadingProgress`/`forgetStaleProjectCache`/`resetCaches` (zie
  afwijking hieronder). Zonder `ctx.legacy` degradeert elke status/actie-methode naar
  `{ status: 'unavailable' }` in plaats van te crashen.
- `page/main.js`: `{ name: 'mr-preload', mount: mountMrPreload }` toegevoegd aan `features:
  []` (minimale diff, geen herformattering).
- `go-navigation.js`: een async-import-bridge (zelfde vorm als ticket 08's clock-bridge en de
  overlay-registry-bridge), IIFE-top-level gestart, mount't de echte, volledig capabele instantie
  zelf met de `legacy`-bag hierboven. Vijf dunne adapters (`preloadMergeRequest`,
  `mergeRequestPreloadStatus`, `preloadFullProject`, `fullProjectPreloadStatus`,
  `invalidateCacheState`) blijven onder identieke naam en signatuur bestaan op
  `globalThis.GoLensGoNavigation` (content.js roept ze zo aan) en vertalen naar de handle's
  optie-object-vorm. **Regelverschil: 3173 → 3022 regels** (`git diff --stat`: 122
  insertions/268 deletions, netto **−151**). Verwijderd: de vijf oorspronkelijke functie-bodies,
  plus de preload-only helpers `relatedLoadingProgress`/`relatedLoadingMessage`/
  `mergeSearchStatus`/`relatedReadyMessage`/`implementationSearchTerms` en de nu-ongebruikte
  `RELATED_CACHE_MAX_CANDIDATE_PACKAGES`/`RELATED_CACHE_MAX_SEARCH_QUERIES`/
  `RELATED_CACHE_SEARCH_PAGES`-constanten. Blijven staan (gedeeld met nog niet gemigreerde
  hover/click-resolutie): `workerRPC`, `projectContext`, `mergeRequestHeadRef`, `mergeRequestIID`,
  `loadPackage`, `loadProject`, `listMergeRequestChangedFiles`, `modulePathFor`,
  `searchProjectBlobPaths`, `projectLoadingProgress`, `dirname`, `COMMIT_SHA` — 20+ andere
  aanroepplekken per stuk, dus verwijderen zou functionaliteit breken of GitLab-paginatielogica
  dupliceren (precies wat ticket 03 §3 afraadt).
- Tests: 23 nieuwe tests in `tests/features-mr-preload.test.js` (11 pure-core, 12 shell/handle,
  inclusief een capability-loze degradatie-test en een test die een ruwe
  `chrome.runtime`-berichtvorm als argument doorgeeft). `tests/go-navigation-context.test.js`:
  4 tests die de verhuisde pure helpers via `__test` aanriepen zijn verwijderd (functionaliteit nu
  gedekt in de nieuwe test-file); `__test`'s export-object is bijgewerkt (verhuisde namen eruit,
  `mrPreloadReady` erbij, zelfde patroon als `clockReady`/`overlayRegistryReady`).

**Afwijkingen van 03/04 (met reden):**
- **Twee mount-instanties, één functioneel.** go-navigation.js's eigen bridge mount't de
  volledig-capabele instantie (met `ctx.legacy`). `page/main.js`'s `page/lifecycle` mount't via
  `FEATURE_ROUTES` (`golens-preload-full-project` → `preloadFullProject`, `golens-full-project-status`
  → `fullProjectStatus`, `golens-cache-invalidated` → `invalidateCache`) een **tweede**, capability-
  loze instantie — `page/lifecycle` heeft geen toegang tot go-navigation.js's closures (dat zou het
  verboden `globalThis`-contract zijn). Die tweede instantie degradeert elke aanroep naar
  `{ status: 'unavailable' }`/no-op in plaats van te crashen; `content.js`'s eigen
  `chrome.runtime.onMessage`-listener blijft de enige die daadwerkelijk `sendResponse` aanroept en
  dus het feitelijke gedrag bepaalt (ongewijzigd). Geen dubbele preload-run: de functionele kant
  loopt uitsluitend via go-navigation.js's bridge, precies zoals vóór dit ticket. Niet in scope om
  op te lossen — vereist ofwel content.js's eigen listener weg te halen (buiten mijn
  file-ownership) ofwel `page/lifecycle` capabilities te geven die het vandaag niet heeft.
- **Statussen behouden het veld `status`, niet `kind`.** `content.js` leest `result.status`/
  `result.coverage`/`result.searchStatus` rechtstreeks van elke preload-aanroep (bijv.
  `refreshPreloadStatus`, `startFullProjectPreload`) — het teruggave-schema moest byte-identiek
  blijven. De onderliggende worker-RPC (`projectCacheStatus` e.a.) gebruikt al een gesloten
  `status`-verzameling (`'missing' | 'complete'`, plus `'unavailable'` voor de capability-loze
  degradatie hierboven); dat is de facto het `kind`-gediscrimineerde contract uit ticket 04 §5, nu
  gedocumenteerd op de handle-methoden in plaats van hernoemd.
- **`invalidateCacheState()` is van origine synchroon**, content.js roept hem fire-and-forget aan
  vanuit een `chrome.runtime.onMessage`-listener. Tijdens de (sub-30ms, ticket 04 §7) laadrace van
  de bridge zou een vroege aanroep anders stilzwijgend genegeerd worden; een `pendingInvalidate`-vlag
  herspeelt hem zodra de module klaar is, zodat er geen gat overblijft.

**Verrassingen:**
- `preloadMergeRequest` wordt ook **intern** binnen go-navigation.js aangeroepen (vanuit
  `findImplementationsAt`, niet-gemigreerde hover/click-code) — de bridge-adapter behoudt daarom
  zijn oorspronkelijke positionele signatuur `preloadMergeRequest(progress)` zodat die aanroepplek
  ongewijzigd blijft werken.
- Zelfreview met `/advisor` ving een echte regressie vóór oplevering: de originele
  `loadPhase` deduplicete én sorteerde élke fase (ook `dependencies`) voor deterministische
  laadvolgorde; mijn eerste versie liet `planPreload`'s `'dependencies'`-tak ongesorteerd
  (ontdekkingsvolgorde in plaats van alfabetisch). Gefixt door `.sort()` toe te voegen aan die tak
  plus een regressietest met bewust niet-alfabetisch ontdekte dependencies
  (`tests/features-mr-preload.test.js`).
- De cache-sleutel voor `state.projects`/`state.projectProgressListeners`
  (``${origin}\u0000${project}\u0000${ref}``, go-navigation.js's own NUL-joined key format) is expliciet **niet** naar de nieuwe module
  verplaatst: `forgetStaleProjectCache({ origin, project, ref })` neemt de losse velden aan en
  berekent de sleutel zelf, binnen go-navigation.js, waar `state` leeft — de nieuwe module hoeft
  het interne sleutelformaat niet te kennen.

**Gate-uitkomsten:** `npm run check:syntax` EXIT:0. `npm test` EXIT:0, 285/285 (was 266; +23 nieuw,
−4 verhuisd). `npm run check`/`npm run test:browser` bewust niet gedraaid (instructie: flaky onder
parallelle load, door de oproepende agent zelf te draaien).

**Niet geverifieerd:** productie-timing van de dynamic-import-bridge voor dít specifieke pad (alleen
generiek geverifieerd in ticket 04 §7's prototype voor het bootstrap-mechanisme zelf); het
dubbele-mount-scenario (vorige sectie) is alleen via unit-tests bevestigd, niet in een live
GitLab-tab met `page/lifecycle` daadwerkelijk gemount naast go-navigation.js's bridge.
