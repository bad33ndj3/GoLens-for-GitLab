# 28 — Platform: source-loader

**What to build:** `page/platform/source-loader.js`: `loadPackage`/`loadProject` en hun
cache-orchestratie (`state.packages`/`state.projects`/`state.projectProgressListeners`) uit
`go-navigation.js`, inclusief `packageLoadingProgress`/`packageLoadingMessage`/
`projectLoadingProgress`/`projectLoadingMessage` en de `status()`-functie die het
`golens-go-status` CustomEvent dispatcht. **Dit event is live** (`tests/browser-smoke.mjs:268`
en `:445` luisteren erop, zie map.md's correctielijst) — niet als dood beschouwen. `createX(deps)`
neemt `workerRPC` (uit `rpc-client.js`, 09) en de `gitlab-api.js`-functies (27) als dependency in
plaats van ze zelf te importeren, zodat tests ze kunnen stubben.

**Blocked by:** 09 — platform/rpc-client; 27 — platform/gitlab-api.

**Status:** resolved (commit d295410)

- [x] `loadPackage`/`loadProject`'s caching (per-key promise, project-key kortsluit-check),
  voortgangsrapportage en `golens-go-status`-dispatch exact ongewijzigd
- [x] `go-navigation.js` gebruikt deze module i.p.v. eigen kopieën
- [x] Unit tests in `tests/platform-source-loader.test.js`
- [x] `npm run check:syntax` en `npm test` groen; browser-smoke solo groen (event-contract)

## Resolutie

`page/platform/source-loader.js` aangemaakt; `createSourceLoader(deps)` krijgt `workerRPC`,
`status` en de gitlab-api-functies via `go-navigation.js`'s eigen wrappers, waardoor de twee
import-bridges geen onderlinge volgorde nodig hebben.

20 unit tests in `tests/platform-source-loader.test.js`, inclusief de drie verschillende
reset-semantieken (`reset` / `clearLoaded` laat in-flight listeners staan /
`forgetStaleProject` weigert zolang er subscribers zijn).

**Afwijking van de ticketletter:** `status()` — de `golens-go-status`-dispatch — blijft in
`go-navigation.js` en wordt als dependency *ingespoten*. Reden: `init()` vuurt
`status('idle', ...)` synchroon, terwijl de import-bridge pas op een latere microtask
resolvet; een dispatcher achter de bridge zou dat eerste event laten vallen. Precies dat
event is live (`tests/browser-smoke.mjs:283` zet er `document.body.dataset.goStatus` mee,
`:460` gate't er een scenario op).

**Browser-smoke (event-contract):** het `golens-go-status`-scenario is groen. De suite als
geheel is rood op het settings-overlay-scenario, maar dat is **pre-existing**: een baseline-run
op HEAD (9c62a28, ticket 26) faalt identiek — zelfde fingerprint (skeleton-fixture gerenderd,
`data-golens-skeleton-remounted="true"`, geen `#golens-settings-root`, dan timeout). Ook
gecontroleerd dat het geen stille bridge-failure is: tijdelijke `console.error` in alle drie de
`.catch()`-handlers leverde nul treffers over drie runs, dus de modules laden in de browser.
map.md's regel "twee keer solo falen is echt kapot" gaat over *hetzelfde* scenario dat tweemaal
faalt; hier gaat het om een faler die ook zonder deze wijziging optreedt.

**Tweede afwijking, gevonden in de code-review:** de source-loader-bridge is *geketend* achter
de gitlab-api-bridge (`Promise.all([gitlabApiReady, loadSourceLoaderModule()])`) in plaats van
ermee te racen. De deps die `createSourceLoader` krijgt zijn go-navigation.js's eigen wrappers,
en twee daarvan (`projectContext`, `mapLimit`) zijn synchroon en dereferencen `gitlabApiModule`
direct. Won deze bridge de race, dan gooide de eerste `loadPackage()` — die alleen
`sourceLoaderReady` await't — op een null module. Een eerdere versie van de module-header
beweerde het tegenovergestelde; die claim is gecorrigeerd.
