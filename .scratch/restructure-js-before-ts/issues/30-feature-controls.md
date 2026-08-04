# 30 — Feature-migratie: controls

**What to build:** `page/features/controls.js`: de toolbar (~340 regels shadow-DOM: enable-toggle,
focus-toggle, preload-knop, bookmarks-knop) + preload-state-machine
(`preloadMergeRequest`/`refreshPreloadStatus`/`startFullProjectPreload`/
`refreshFullProjectPreloadStatus`) + review-focus/fullscreen (`toggleReviewFocus`) +
bookmark-drawer-UI uit `content.js`. Grootste van de nieuwe tickets — overweeg bij scoping of
controls-shell en bookmark-drawer twee losse features moeten worden (bookmark-drawer consumeert
`page/features/bookmarks.js`'s handle net als vandaag via de live accessor, niet via een nieuwe
globalThis-bridge). Volgt ticket 04 §1's `mount(ctx) → handle`-contract.

**Blocked by:** 18 — feature-bookmarks (voor de bookmark-drawer's databron). 26/27/28/29 blokkeren
niet: content.js's toolbar en preload-state-machine praten uitsluitend met de bestaande
`globalThis.GoLensGoNavigation`-bridge (`preloadMergeRequest`/`mergeRequestPreloadStatus`/
`preloadFullProject`/`fullProjectPreloadStatus`/`invalidateCacheState`/`init`/`teardown`/
`bookmarks`) — geverifieerd door content.js te doorzoeken: nul treffers voor toast-functies of het
`golens-go-status`-event, en `toggleReviewFocus`/`enableRapidDiffs` zijn pure DOM-logica zonder
go-navigation-afhankelijkheid. Die bridge blijft functioneel ongeacht de voortgang van 26-29 (dat
zijn interne herstructureringen van go-navigation.js, geen wijziging van zijn publieke API).
Ticket 22 (blocked by o.a. 30 zelf) kan dus geen blocker van 30 zijn — dat zou circulair zijn.

**Status:** resolved

- [ ] Toolbar-DOM/CSS/gedrag (alle 4 knoppen, states) exact ongewijzigd
- [ ] Preload-state-machine (idle/checking/busy/complete/error, progress-rendering) exact ongewijzigd
- [ ] Review-focus/fullscreen-gedrag exact ongewijzigd
- [ ] Bookmark-drawer (lijst, jump/remove/recover/clear, focus-restore) exact ongewijzigd
- [ ] Geen nieuwe globalThis-contracten
- [ ] Unit tests in `tests/features-controls.test.js`
- [ ] `npm run check:syntax` en `npm test` groen
