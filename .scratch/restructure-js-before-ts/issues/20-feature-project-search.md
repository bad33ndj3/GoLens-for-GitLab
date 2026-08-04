# 20 — Feature-migratie: project-search

**What to build:** De "search complete project"-modal uit `go-navigation.js` wordt
`features/project-search` met `mount(ctx) → { unmount, open(), close() }`: modal-DOM, paging en
blob-path-zoeken privé; queries via `rpc.query`, uitkomsten `kind`-gediscrimineerd (incl.
missing/ambiguous). Legacy-code direct verwijderd.

**Blocked by:** 09 — platform/rpc-client; 11 — lifecycle-orchestrator.

**Status:** resolved

- [x] Openen (via shortcut/actie), zoeken, paging en sluiten identiek aan nu — geverifieerd via
      `tests/features-project-search.test.js` (20 scenario's: open/close/minimize/restore/retry/
      cancel, references vs. implementations dispatch, alle drie foutpaden) plus
      `tests/browser-smoke.mjs`'s bestaande full-search-scenario (aangepast op de nieuwe DOM-host,
      geen assertie verzwakt).
- [x] Abort/cleanup van lopende zoekopdrachten bij `close()`/`unmount()`/navigatie — een
      `AbortController` per zoekopdracht, aangesproken door `close()`, `unmount()`, én
      `go-navigation.js`'s `teardown()` (via `close({restorePopover:false})`, ticket-note hieronder).
- [x] Volledige `npm run check` groen — `check:syntax` groen, `node --test tests/*.test.js` 403/403
      groen (incl. 35 nieuwe project-search-tests, zie regel 90-96 hieronder), `npm run test:browser`
      groen ("browser injection smoke passed"). Twee eerdere volledige `npm run check`-runs kregen
      direct ná de zware unit-testsuite een rode smoke op een niet-project-search-scenario
      (`golens-show-settings`-connectie resp. `golensSkeletonRemounted`) — bekend gedrag, map.md's
      "browser-smoke is groen maar flaky onder machineload". Een derde volledige `npm run check`-run
      na een korte pauze én drie losse solo `npm run test:browser`-runs waren alle vijf groen. Geen
      enkele project-search-assertie is in welke run dan ook gefaald.

## Uitvoeringsnotities

`page/features/project-search.js` + `.internal.js` (nieuw), geregistreerd in `page/main.js` als een
tweede, inerte instantie (zelfde vorm als ticket 19's mr-preload — `page/lifecycle` heeft geen
toegang tot `go-navigation.js`'s closures). De echte, functionele instantie wordt door
`go-navigation.js` zelf gemount via een self-bridge (`loadProjectSearchModule()` +
`projectSearchHandle`, exposed als `__test.projectSearchReady`), met een `legacy`-capability-bag:
`searchProjectBlobPaths`/`loadPackage` (gedeeld met nog-niet-gemigreerde hover/click-resolutie),
`findReferencesAt`/`findImplementationsAt`/`showResult`/`pinPopover`/`hidePopover`/`toast`
(gedeelde popover-rendering), en `isEnabled()`. Dit is exact het patroon dat ticket 19 al vaststelde
voor dezelfde reden (blob-search/package-cache/popover-rendering zijn nog legacy, gedeeld met
hover/click).

**Afwijking van de letterlijke ticket-tekst ("queries via `rpc.query`"):** er bestaat geen
`ctx.rpc` — `page/main.js`'s `platform` is alleen `{clock, settings, overlays}`, en ticket 09 maakt
rpc-client-constructie bewust lazy zodat testpaden zonder `chrome`-mock er nooit tegenaan lopen.
Queries lopen via `legacy.loadPackage`/`legacy.findReferencesAt`/`legacy.findImplementationsAt`, die
zelf via `workerRPC` (ticket 09's dunne bridge) alsnog door `platform/rpc-client` lopen — hetzelfde
gedocumenteerde patroon als ticket 19.

**Modal-DOM is nu volledig privé**: eigen shadow-host `#golens-project-search-root`, lazy aangemaakt
bij de eerste `open()` (niet eager bij `mount()` — anders zou de inerte page/main.js-instantie een
tweede, ongebruikte host/chip renderen). `--golens-*`-tokens bereiken hem via overerving vanaf de
document-`:root`-regel in `golens-theme.css` (geverifieerd, niet aangenomen: dat bestand target al
`:root`, niet alleen specifieke host-ids — geen CSS-wijziging nodig).

`go-navigation.js` verliest `searchCompleteProject`/`openFullSearch`/`runFullSearch`/
`rerunFullSearchQuery`/`updateFullSearchProgress`/`minimizeFullSearch`/`restoreFullSearch`/
`cancelFullSearch`, de `.full-search-*`-CSS en -markup uit zijn eigen shadow-template, en
`state.fullSearch`. `openFullSearch(result, pointer)` blijft als naam bestaan (aangeroepen door de
al bestaande "Search complete project"-popoverknop) maar is nu een one-liner die naar
`projectSearchHandle.open(...)` doorschakelt. `teardown()`'s oude
`state.fullSearch?.controller?.abort(); state.fullSearch = null;` werd
`projectSearchHandle?.close({restorePopover: false})` — een nieuwe `close(opts)`-optie t.o.v. de
letterlijke ticket-04-signatuur (net als settings-overlay.js's `close({restoreFocus})`), nodig omdat
navigatie/unmount alleen moet aborten (geen `showResult`/`pinPopover`/`toast` meer aanroepen op een
popover die toch net wordt afgebroken) terwijl de Cancel-knop wél de originele popover moet
terugzetten.

**Fideliteitsbevinding, twee keer geanalyseerd (eerste lezing fout, gecorrigeerd vóór oplevering):**
`go-navigation.js`'s document-Escape-handler heeft een `fullSearchOpen`-branch die
`minimizeFullSearch()` aanriep. Eerste lezing concludeerde "dode code" (de guard erboven zou altijd
al matchen zolang de dialog focus heeft) en verwijderde de branch zonder vervanging — fout: de guard
matcht via `event.composedPath()`'s in-shadow entries alleen zólang de dialog daadwerkelijk focus
heeft; zodra de focus wegvalt zonder dat de dialog sluit (bv. een klik op de backdrop — een
niet-focusbare div — blurt naar `<body>`), matcht de guard niets meer (en `document.activeElement`
zou op dat moment sowieso de shadow-*host* teruggeven, niet het element in de shadow-tree) en bereikt
Escape wél de `fullSearchOpen`-branch. Echt, bereikbaar gedrag dus, niet dode code — hersteld via een
4e handle-methode `minimize()` (bovenop de letterlijke ticket-tekst `{unmount, open, close}`, binnen
ticket 04 §1's "~5"-budget, zelfde soort afwijking als `close(opts)` hierboven).
`go-navigation.js`'s `onKeyDown` roept nu `projectSearchHandle?.minimize?.()` op exact de plek waar
de oude `fullSearchOpen`-check stond. Gedocumenteerd in de eigen comments van beide bestanden; regressietest toegevoegd op de handle-seam
(`minimize()` → `{kind:'minimized'|'not-open'|'unavailable'}`, `tests/features-project-search.test.js`). Niet gedekt: een end-to-end test die het echte
`go-navigation.js`-`onKeyDown` → `projectSearchHandle.minimize()`-pad met een live zoekopdracht
oefent — dat vereist fetch-mocking-scaffolding voor de full-search-flow die
`tests/go-navigation-context.test.js` nog niet heeft; de delegatie zelf is één regel en handmatig
geverifieerd (`node --check`, volledige suite groen).

`tests/go-navigation-context.test.js`: de twee assertions die `.full-search-dialog`/
`.full-search-minimize` rechtstreeks in go-navigation's eigen popover-shadow-root opzochten zijn
verwijderd (die DOM bestaat daar niet meer); de assertion dat de popover nog steeds een
"Search complete project"-knop rendert blijft staan. `tests/browser-smoke.mjs`: de vier
full-search-assertions (`goFullSearchModal`/`goFullSearchOpened`/`goFullSearchCancelVisible`/
`goFullSearchCancelled`) lezen nu uit `#golens-project-search-root`'s shadow-root in plaats van uit
`goUI`; geen assertie verwijderd of verzwakt.

Nieuwe tests: `tests/project-search-internal.test.js` (15 tests, pure core — term-extractie,
percentage-formules, scope-vorm, message-teksten) en `tests/features-project-search.test.js` (20
tests — open/missingRef/unavailable, references- vs. implementations-dispatch, de twee
domain-outcome-foutpaden (`noTerms`/`incomplete`) mét verbatim legacy-teksten, een generieke
infra-rejection, retry, dubbele `open()` die de eerste zoekopdracht aborteert, minimize/restore via
de chip en via `minimize()`, `close()` met en zonder `restorePopover`, en unmount-veiligheid/remount).
Totaal: 401 → 403 (`node --test tests/*.test.js`).
