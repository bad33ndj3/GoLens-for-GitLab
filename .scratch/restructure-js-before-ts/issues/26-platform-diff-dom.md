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

**Status:** proposed

- [ ] Elke functienaam/-signatuur/-gedrag identiek overgenomen (geen DOM-selector-wijzigingen)
- [ ] `fileContextFor`'s cache-semantiek (generation-gebaseerde invalidatie) behouden
- [ ] `go-navigation.js` importeert deze module voor de bovenstaande functies i.p.v. eigen kopieën
  (of: blijft ze zelf gebruiken via import, geen duplicatie)
- [ ] Unit tests in `tests/platform-diff-dom.test.js`
- [ ] `npm run check:syntax` en `npm test` groen
