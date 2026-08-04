# 26 — Platform: diff-dom

**What to build:** `page/platform/diff-dom.js`, een ES module met de diff-DOM-primitieven die nu
verspreid in `go-navigation.js` staan en door alle vier de `legacy`-bags (bookmarks/code-intel/
mr-preload/project-search — indirect via code-intel) gedeeld worden: `diffRootFor`/`rapidFileData`/
`computeFileContext`/`fileContextFor`/`codeCellFor`/`lineFromAnchor`/`lineAnchorFor`/
`expansionDirectionForLine`/`waitForDiffUpdate`/`revealLine`/`visibleDiffRootForDefinition`/
`flashDestination`/`navigateToLocation`/`lineContextFor`/`diffFileRoots`.
(`normalizePath` (go-navigation.js:406) hoort hier niet bij — het is een pure string/unicode-util
zonder DOM-afhankelijkheid en verhuist naar 27's gitlab-api-laag, waar hij ook feitelijk gebruikt
wordt.)
`fileContextFor`'s cache (`fileContextGeneration`/`fileContextCache`) verhuist mee; de module
exporteert een manier om de generation te bumpen (bijv. `bumpFileContextGeneration()`) zodat
go-navigation.js's `diffObserver` hem nog kan invalideren zonder de cache zelf te bezitten.
Gedrag exact ongewijzigd (zelfde DOM-selectors, zelfde caching, zelfde timing). Geen
`createX(deps)`-factory nodig — dit zijn pure DOM-lezende functies zonder externe dependencies,
dus platte named exports volstaan (afwijking van ticket 04 §2's `createX(deps)`-conventie,
gemotiveerd door het ontbreken van injectable deps).

**Blocked by:** geen.

**Status:** resolved — geïmplementeerd op 2026-08-04. 27-36 blijven `proposed` tot dezelfde sign-off.

- [x] Elke functienaam/-signatuur/-gedrag identiek overgenomen (geen DOM-selector-wijzigingen)
- [x] `fileContextFor`'s cache-semantiek (generation-gebaseerde invalidatie) behouden
- [x] `go-navigation.js` importeert deze module voor de bovenstaande functies i.p.v. eigen kopieën
  (of: blijft ze zelf gebruiken via import, geen duplicatie)
- [x] Unit tests in `tests/platform-diff-dom.test.js`
- [x] `npm run check:syntax` en `npm test` groen

## Resultaat

`page/platform/diff-dom.js` bestaat, met platte named exports plus
`bumpFileContextGeneration()`; de generation-cache staat op module-scope (overlay-registry-idioom),
omdat go-navigation.js en page/main.js de module elk via hun eigen dynamic `import()` bereiken.

Omdat `go-navigation.js` nog een *classic* content script is (geen top-level `await`, geen statische
import), staan daar nu gelijknamige dunne wrappers die naar de module delegeren — geen enkel
`legacy`-bag-item, `__test`-key of call site veranderde daardoor. `computeFileContext` en
`DIFF_ROOT_SELECTOR` verdwenen uit go-navigation.js; `flashDestination` ook (alleen
`navigateToLocation` gebruikte hem daar nog). De diff-observer roept `diffDom?.bumpFileContextGeneration()`
aan; optional-chained omdat een bump vóór de module-load een no-op is op een cache die dan nog leeg
móét zijn (er kan pas iets in staan na een geslaagde `fileContextFor`, en die vereist de module).

Nieuw: `__test.diffDomReady`, zodat `tests/go-navigation-context.test.js` en
`tests/benchmarks/diff-dom.bench.mjs` de load deterministisch afwachten i.p.v. ernaar te racen.
Benchmark-casenamen en gemeten functies ongewijzigd.

Bewust *niet* opgelost (buiten scope): `normalizePath`/`parseBlobLink` staan nu dubbel (privé in de
module, plus go-navigation.js's eigen kopie voor zijn GitLab-API-werk en code-intel's `legacy.dirname`)
— ticket 27 verhuist de eigenaar naar de gitlab-api-laag. Ook ongemoeid: bookmarks.js's privé
`lineFromAnchor` en keyboard-nav.js/code-intel.js's eigen `diffFileRoots`/`flashDestination`.

Gates: `npm run check:syntax` groen, `npm test` groen (460 tests). `npm run bench --scale=smoke` draait
de vier diff-dom-cases zonder regressie. De browser-smoke is flaky — zowel mét als zonder deze wijziging
faalt hij ~1 op 3 runs met dezelfde `golens-show-settings`/"Receiving end does not exist"-fout; dat is
ticket 23's terrein, niet van deze wijziging.
