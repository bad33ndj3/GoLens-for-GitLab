# 18 — Feature-migratie: bookmarks

**What to build:** Bookmark-anchoring/-recovery uit `go-navigation.js` én de drawer uit
`content.js` worden samen `features/bookmarks` met de ticket 04 §3-handle
(`subscribe`/`snapshot`/`toggleAt`/`reveal`/`remove`/`clear`/`recover`); surfaces en
marker-reconciliatie worden intern (`registerBookmarkSurface`/`refreshBookmarks` verdwijnen van de
interface). `globalThis.GoLensBookmarks` (bookmark-store.js, buiten scope) komt binnen via `ctx`.
Recovery gesplitst: pure kandidaat-berekening als core, fetch/store-writes in de shell, uitkomsten
`kind`-gediscrimineerd. Legacy-code direct verwijderd.

**Blocked by:** 11 — lifecycle-orchestrator.

**Status:** resolved

- [x] Toggle, reveal, recovery, drawer en markers gedragen zich identiek, ook na SPA-navigatie —
      geverifieerd via `tests/features-bookmarks.test.js` (11 scenario's: inert-degrade, subscribe/
      snapshot, toggle add/remove, marker click, reveal, remove/clear, alle vijf recovery-kinds,
      enable/disable, de twee self-bridge-only methoden) plus `tests/content-bookmarks.test.js`'s
      bestaande drawer-scenario (aangepast op de nieuwe handle-vorm, geen assertie verzwakt) en
      `tests/browser-smoke.mjs`'s bestaande scenario's (ongewijzigd, blijven groen).
- [x] Eén module bezit alle bookmark-state; geen globaal contract meer met content.js — de 9 losse
      `globalThis.GoLensGoNavigation.subscribeBookmarks`/`refreshBookmarks`/`bookmarkSnapshot`/
      `toggleBookmarkAt`/`revealBookmark`/`removeBookmark`/`clearBookmarks`/`recoverBookmark`/
      `registerBookmarkSurface`-functies zijn vervangen door één `get bookmarks()`-accessor die
      het ticket-04 §3-handle zélf teruggeeft; content.js roept `.subscribe`/`.snapshot`/`.toggleAt`/
      `.reveal`/`.remove`/`.clear`/`.recover` rechtstreeks aan en houdt geen bookmark-data meer vast
      (zie uitvoeringsnotities).
- [x] Recovery-beslislogica puur en los getest; uitkomsten met `kind` — `bookmarkRecoveryCandidates`
      (kandidaat-berekening) en `recoveryOutcome` (missing/ambiguous/found) in
      `page/features/bookmarks.internal.js`, 11 losse tests in `tests/bookmarks-internal.test.js`
      (incl. index-0/laatste-index-randgevallen en de length===1-hash-hergebruik-optimalisatie).
      `recover(id)`'s volledige gesloten set is `{current, unavailable, missing, ambiguous,
      recovered}` (vijf, niet de "exact/fuzzy" suggestie uit de eerdere planningstekst — zie
      uitvoeringsnotities).
- [x] Volledige `npm run check` groen — `check:syntax` groen, `node --test tests/*.test.js` 422/422
      groen (was 403 vóór dit ticket: +11 `bookmarks-internal.test.js` + 11 `features-bookmarks.test.js`
      − 3 verwijderde bookmark-tests uit `go-navigation-context.test.js`, netto conform de ticket-17/20
      porteer-conventie), `npm run test:browser` groen. Zoals bij ticket 20: een volledige
      `npm run check`-run kreeg direct ná de zware unit-suite een rode smoke op het (aan bookmarks
      onverwante) skeleton-mount/remount-scenario; **geverifieerd in een geïsoleerde
      `git worktree` op een schone kopie van HEAD (vóór dit ticket) dat exact hetzelfde
      fail-dan-slaag-patroon daar ook optreedt** — dus geen regressie van dit ticket. Los
      `npm run test:browser` was daarna herhaaldelijk groen (5×).

## Uitvoeringsnotities

`page/features/bookmarks.js` + `.internal.js` (nieuw), geregistreerd in `page/main.js` als een
tweede, inerte instantie — zelfde vorm als ticket 19/20's mr-preload/project-search
(`page/lifecycle` heeft geen toegang tot `go-navigation.js`'s diff-DOM/MR-netwerk-closures). Anders
dan project-search is de inerte instantie hier bewust volledig passief (geen enable()-aanroep, dus
geen eigen `MutationObserver`, geen eigen markers): bookmarks bezit écht live diff-DOM, dus een
tweede functionele instantie zou dubbele markers/dubbele observers geven — expliciet
gedocumenteerd in beide bestanden hun eigen headercomments. De echte, functionele instantie wordt
door `go-navigation.js` zelf gemount via een self-bridge (`loadBookmarksModule()` +
`bookmarksHandle`, exposed als `__test.bookmarksReady`), met een `legacy`-capability-bag
(`projectContext`/`mergeRequestIID`/`mergeRequestRefs`/`clearMergeRequestRefs`/`diffFileRoots`/
`diffRootFor`/`rapidFileData`/`parseBlobLink`/`codeCellFor`/`lineContextFor`/`fetchSource`/
`navigateToLocation`/`waitForDiffUpdate`/`lineAnchorFor`/`toast`/`isEnabled`/
`selectedSymbolLocation`) — hetzelfde patroon ticket 19/20 al vaststelden voor dezelfde reden
(diff-DOM-primitives en MR/netwerk-helpers zijn nog legacy, gedeeld met nog-niet-gemigreerde
hover/click-resolutie in `go-navigation.js`). `globalThis.GoLensBookmarks` (bookmark-store.js) komt
bewust ongewijzigd binnen via `ctx.bookmarkStore`/`ctx.hashText`, opgebouwd in de self-bridge —
buiten scope, niet aangeraakt.

**"Geen globaal contract meer met content.js" opgelost door de 9 ad-hoc bookmark-methoden op
`globalThis.GoLensGoNavigation` te vervangen door één `get bookmarks()`-accessor die het handle
zélf teruggeeft** (`subscribe`/`snapshot`/`toggleAt`/`reveal`/`remove`/`clear`/`recover`).
content.js's drawer (`showBookmarkDrawer`/`renderBookmarkDrawer`/`createBookmarkListItem`/…) blijft
in content.js — zijn DOM hoort bij content.js's eigen toolbar-knop — maar is nu een pure consumer:
geen `state.bookmarkSnapshot` meer, elke render roept `bookmarks.snapshot()` vers op; acties
(jump/remove/recover/clear) roepen `bookmarks.reveal/remove/recover/clear` rechtstreeks aan i.p.v.
losse ad-hoc functies.

**Afwijkingen van de letterlijke ticket-04 §3-tekst (`{unmount, subscribe, snapshot, toggleAt,
reveal, remove, clear, recover}`), alle vier alleen gebruikt door `go-navigation.js`'s self-bridge,
nooit door content.js of `page/main.js` — zelfde soort toegestane afwijking als project-search's
`minimize()`:**
- `enable()`/`disable()` — vervangen de inline bookmark-store-setup/marker-timer-teardown die
  `init()`/`teardown()` vroeger rechtstreeks deden.
- `toggleAtSelection(fallbackLocation)` — de selectie-of-gefocuste-marker-of-code-intel-fallback-
  keten uit `runNavigationAction`'s oude `toggleBookmark`-branch; `go-navigation.js` berekent alleen
  nog zijn eigen code-intel-fallback (de geselecteerde occurrence) en geeft die door.
- `navigate(direction)` — de vroegere `navigateBookmark()` voor `previousBookmark`/`nextBookmark`.

**Fideliteitsbevinding: `bookmarkScopeKey` was al dode code vóór dit ticket** (alleen gedefinieerd,
nooit aangeroepen, elders in `go-navigation.js`) — niet geport, niet getest, in lijn met "legacy-code
direct verwijderd" i.p.v. dode code met een nieuwe woonplaats te geven.

**Eén echte architectuurwissel t.o.v. de oude code:** bookmarks bezit nu zijn eigen
`MutationObserver` op `#diffs` (i.p.v. mee te liften op `go-navigation.js`'s gedeelde
occurrence/bookmark-observer via `scheduleBookmarkRefresh()` binnen diens 50ms-debounce) — dit is
letterlijk wat ticket 18 vraagt ("de module owns marker placement... geen registratie-API meer").
De 50ms- + 20ms-timing-samenstelling (mutatie → 50ms debounce → nog eens 20ms → `refresh()`) is
bewust exact behouden met kale `setTimeout`/`clearTimeout` (niet `ctx.clock`, om precies dezelfde
getallen te garanderen). Omdat er nu twee observers op dezelfde diff-DOM zitten, moet elk de
markers/selection-UI van de ander negeren om een oneindige reconciliatie-lus te voorkomen:
`go-navigation.js` behoudt een letterlijke duplicaat van `bookmarks.js`'s
`bookmarkProjectionMutation()`-selectorcheck (`isBookmarkOnlyMutation`, gedocumenteerd in beide
bestanden) — een `advisor`-review ving dit vóór implementatie; zonder de duplicaat-guard zou elke
marker-plaatsing `fileContextGeneration` blijven ophogen en `go-navigation.js`'s eigen
hover-cache-invalidatie continu triggeren.

Verwijderd uit `go-navigation.js`: `bookmarkFileContextFor`/`bookmarkLineContextFor`/
`bookmarkLocationForNode` (state-veld-onafhankelijke helpers, ~line 306-576), en het hele blok
`bookmarkScopeKey` t/m `revealDiffBookmark` (~25 functies, ~355 regels) inclusief alle
`state.bookmark*`-velden. Verwijderd uit `content.js`: `state.bookmarkSnapshot` (vervangen door
`currentBookmarkSnapshot()`, dat elke keer vers `bookmarks.snapshot()` opvraagt) en de
`state.bookmarkSnapshot`-reset in `leaveMergeRequestPage()` (niet meer nodig — bookmarks.js's eigen
`disable()`, aangeroepen via `go-navigation.js`'s `teardown()`, is nu verantwoordelijk).
