# Restructure the JavaScript before TypeScript

Label: `wayfinder:map`
Status: open

## Destination

An approved spec — target module boundaries (decided from scratch, not carried over from any prior
attempt), dependency rules, small stable public interfaces, and an execution sequence — for
restructuring the five large legacy JS files (`go-navigation.js`, `content.js`, `go-semantic-core.js`,
`go-semantic-cache.js`, `go-semantic-worker.js`) in place, as preparation for a later TypeScript
migration. This map produces the spec and its tickets; it does not execute the refactor.

## Notes

- Consult `codebase-design` and `domain-modeling` for module/interface design; `grilling` for every
  HITL ticket.
- Prior context: `caspers/rewrite-extension-architecture` attempted a big-bang TS+Lit rewrite and
  failed — by the end, functionality regressed, the UI looked completely different, things were slow,
  UX was bad, and many things no longer worked, because behaviour, performance, and UI all changed at
  once with no incremental verification. This map exists so the next attempt is staged and verifiable.
  **That rewrite's module analysis (Review Session / GitLab Host / Go Intelligence) is explicitly
  ignored** — target module boundaries are decided fresh against the current legacy code, not inherited.
- Every step keeps existing behaviour and performance intact; no UI or framework changes belong in this
  map.
- Prepares a later TypeScript migration; that migration is a separate, not-yet-started effort and is
  out of scope here.
- Tracker: local markdown in this `.scratch/restructure-js-before-ts/` directory (repo default is
  GitHub Issues per `docs/agents/issue-tracker.md`, overridden for this effort at the user's request).
  Blocking is expressed via a `**Blocked by:**` line in each ticket body (no native blocking available).

## Decisions so far

- [01 — Audit tests and docs against current features](issues/01-audit-tests-and-docs-against-current-features.md) — Docs mostly matched; fixed `domain.md`'s inaccurate `src/` layout and `AGENTS.md`'s missing `bench`/`package`/`release` commands. No coverage gaps found; nothing added to fog.
- [02 — Model current dependency structure](issues/02-model-current-dependency-structure.md) — Full map in [02-dependency-map.md](issues/02-dependency-map.md). `go-navigation.js`/`content.js` are hub files carrying many unrelated features through one `state` object each; `go-semantic-core.js`/`go-semantic-cache.js` are clean leaf ES modules; `go-semantic-worker.js` is the sole bridge between them via one port-RPC channel. No true cycles; one near-cycle (`go-navigation.js` reads `content.js`'s DOM directly for one check); one dead contract (`golens-go-status` event, never listened to); policy/infra interleaving found in all five files.
- [03 — Define target module boundaries](issues/03-define-target-module-boundaries.md) — Feature-slices over een platformlaag: `page/lifecycle` (orchestrator) → 9 feature-modules → `page/platform` (rpc-client, settings-store, clock, overlay-registry); worker blijft `dispatch`/`index-core`/`source-cache`. Verboden: feature→feature, feature→lifecycle, elk `globalThis`-contract. Per module functional core / imperative shell; `mount(ctx)`→`unmount()` state-lifecycle; één eigenaar per `chrome.storage`-key. Page-modules worden echte ES modules via dynamic `import()` (bootstrap-contentscript, geen bundler). Breekpakket: DOM-backdoor → overlay-registry, RPC-status-roundtrip → resultaat in antwoord, dood `golens-go-status` event en lege `_implementationCache` verwijderd, clock/debounceIdle gededupliceerd, worker-dispatch routing/effect gesplitst.
- [04 — Design module interfaces](issues/04-design-module-interfaces.md) — Uniform contract `mount(ctx) → { unmount, ≤±5 methods }` voor features, `createX(deps)` voor platform-services; rpc-client met drie namespaces (query/cache/index, 1:1 wire-mapping, framing/transport privé); domein-uitkomsten altijd `kind`-gediscrimineerde returnwaarden uit gesloten sets, exceptions alleen voor infra-falen; worker-klassen getrimd tot de dispatch-set (cache's ~10 IndexedDB-helpers worden privé). Eén prototype geflagd én uitgevoerd: de dynamic-`import()`-bootstrap — **PASS** (import onder strikte pagina-CSP werkt vanuit de isolated world; `web_accessible_resources` verplicht; mount in ~15–29ms; SPA-re-mount werkt via `location.href`-observatie). Wegwerpcode op branch `proto/bootstrap-import`.

## Correcties tijdens uitvoering (2026-08-03)

Analysefase-bevindingen die tijdens de executie feitelijk onjuist bleken. De tickets 02/03 hierboven
blijven staan zoals ze geschreven zijn; dit is de correctielijst.

- **`golens-go-status` is geen dood contract.** 02 en 03 §7 claimen "nergens een listener".
  `tests/browser-smoke.mjs:268` registreert er wel degelijk één (zet `document.body.dataset.goStatus`)
  en `:445` hangt de hele implementations-popover-smoke aan `dataset.goStatus === 'ready'`. Ticket 06
  is daarop ingeperkt tot één dood contract (`_implementationCache`), de dispatch blijft staan.
- **Er is geen "RPC-status-roundtrip" bij `restoreMergeRequest`.** 03 §7 noemt een extra
  status-aanroep na `restoreMergeRequest` als breekpunt. Beide call-sites
  (`go-navigation.js:1285` en `:1315`) voeren het resultaat direct door naar `relatedResultScope(...)`;
  er is geen vervolgaanroep om weg te halen. Breekpakket-item vervalt.
- **`createRpcClient` wijkt bewust af van 04 §2.** De geleverde module neemt ook een `onDisconnect`-dep
  en `dispose({ reason })`, omdat het bestaande cache-clear- en annuleergedrag anders niet 1:1
  behouden blijft. Gedocumenteerd in de module en in ticket 09.
- **Ticket 10 is partieel.** `page/platform/settings-store.js` bestaat en `content.js` loopt er volledig
  doorheen, maar onboarding-save en `settings.js`/`shortcut-settings.js` schrijven `shortcutBindings`
  nog buiten de store om; "één eigenaar per `chrome.storage`-key" (03) is dus nog niet gehaald.
- **De browser-smoke is niet bruikbaar als gate.** `tests/browser-smoke.mjs` faalt op deze machine ook
  op een schone kopie van HEAD (3/3, plus 5/5 in een schone worktree) met
  `DevTools Runtime.evaluate timed out`, mét `CHROME_NO_SANDBOX=1`. Vanaf ticket 05 draaien de tickets
  dus op `node --test tests/*.test.js` + `check:syntax` als gate. Dat betekent geen end-to-end vangnet
  voor de rest van deze operatie — de smoke-omgeving repareren verdient een eigen ticket vóór de
  zwaardere feature-carve-outs (13–21).

- **De benchmark-OOM was harness-teardown, geen fixture-schaal en geen productielek.** Ticket 24 nam
  aan dat de keuze "te grote fixture / te lage heap-limiet" versus "echt lek" was. Het was geen van
  beide: de drie `diff-dom`-cases gaven hun happy-dom-fixture nooit vrij (`window.close()` is
  ontoereikend; alleen `await window.happyDOM.close()` breekt de keten), waardoor ~4 GB bezet bleef
  vóór de grote `semantic-core`-cases. Na een `teardown`-hook in `runCase` draait `npm run bench`
  `EXIT:0` op de **standaard** heap — peak RSS 1.95 GB, plateau 302 MB. Geen `package.json`-wijziging
  nodig. Baseline voor 13–21 staat in ticket 24.
- **De browser-smoke was niet machine-niveau maar een harness-tekort — en is gerepareerd.** Twee
  eerdere conclusies waren fout: niet de `Runtime.evaluate`-timeout (30s→90s hielp niet: 2/8 groen),
  en ook niet "nondeterminisme in headless Chromium, buiten scope". De echte oorzaak was een
  ontbrekende CI-launch-flag-set: headless throttlet timers van backgrounded renderers, terwijl de
  fixtures op 5–20 ms pollen en scenario 5 `<40 ms` asserteert. Met de standaard
  Puppeteer/Playwright-flags (`--disable-renderer-backgrounding`,
  `--disable-backgrounding-occluded-windows`, `--disable-background-networking`, `--disable-sync`,
  `--disable-features=Translate,OptimizationHints,MediaRouter,CalculateNativeWinOcclusion`, e.a.)
  is de smoke **5/5 groen op een schone kopie van HEAD**, inclusief koude eerste run — door de
  orchestrator geverifieerd in een geïsoleerde worktree, los van de agent die dit opleverde.
  Geen scenario of assertie aangeraakt. `CHROME_NO_SANDBOX=1` staat nu vast in `package.json`
  in plaats van mondelinge overlevering. Helium is de ondersteunde browser; echte Chrome faalt 3/3
  al bij scenario 1 op google_apis/gcm-ruis en is expliciet niet ondersteund.
  **`npm run test:browser` is vanaf hier weer een verplichte gate voor 13–21.**

- **Ticket 08 is partieel en blijft dat tot `go-navigation.js` een ES module is.** Alleen
  `content.js`'s `debounceIdle` is gecentraliseerd in `page/platform/clock.js`
  (`createLegacyDebounceIdle`), via dezelfde async-`import()`-bridge als ticket 10. `go-navigation.js`
  is bewust niet gemigreerd: zijn `init()` is synchroon en fire-and-forget, en tests asserten
  synchrone bijwerkingen direct erna — een async import-bridge zou de eerste debounce-aanroep stil
  kunnen laten no-oppen, en dat schendt de "timing exact ongewijzigd"-eis. Twee bevindingen die 03
  niet had: de `debounceIdle`-duplicaten waren byte-identiek, maar de `defaultClock`-duplicaten
  **niet** (`go-navigation.js` heeft een extra `requestFrame` voor `throttle()`/`sleep()`); en de
  `setClock`-migratie naar de clock-seam is niet gedaan omdat zes tests fake-clock met eigen
  echte-timer-wachters op hetzelfde global mengen. De rest van de clock-dedup hoort dus achter de
  ES-module-conversie van `go-navigation.js`, niet vóór.

  **Correctie:** de "blijft partieel tot ES-module"-conclusie hierboven is overruled en ticket 08
  is inmiddels volledig gedaan. De aanname klopte alleen voor een `await import()`-bridge binnen
  `init()` zelf; een queue-until-ready-placeholder (import start op IIFE-top-level vóór `init()`
  ooit draait, `init()` zet synchroon een placeholder met een `pending`-vlag neer, de late `.then()`
  installeert de echte debounced functie en vuurt hem hooguit één keer af voor wat gequeued stond)
  laat `init()` wél synchroon zonder de timing zichtbaar te veranderen — een burst vóór ready valt
  samen tot precies één aanroep ná ready, wat de 50ms-debounce toch al doet voor een burst ná
  ready. `go-navigation.js`'s `debounceIdle` is nu ook gecentraliseerd in
  `page/platform/clock.js` (`createLegacyDebounceIdle`); zijn lokale kopie is verwijderd. De
  `setClock`-migratie naar de clock-seam blijft wel bewust niet gedaan (zie boven) — dat besluit
  staat los van deze correctie. ES-module-conversie van `go-navigation.js` is dus geen
  precondition meer voor de rest van de clock-dedup.

- **De browser-smoke is groen maar flaky onder machineload.** Scenario 5 asserteert `<40 ms`
  timer-delay; draait er tegelijk ander zwaar werk op de machine (bench, een tweede testrun, een
  agent), dan faalt hij daarop. Solo is hij betrouwbaar groen — waargenomen op HEAD vóór ticket 12
  (eerst rood onder load, daarna solo groen) en bevestigd bij 12 en 13. **Gates altijd sequentieel
  draaien; nooit twee agents die tegelijk `npm run check` doen.** Dit is geen reden om een rode
  smoke weg te wuiven: twee keer solo falen is echt kapot.

- **Ticket 13 verandert één timing die 03 "identiek" noemde.** De onboarding-save reconcilieerde de
  generated-files-UI synchroon; `features/generated-files` reageert nu via zijn eigen
  `chrome.storage.onChanged`-subscriptie, dus één macrotask later. Alleen tegen happy-dom
  geverifieerd, niet tegen echte Chrome-storage-latency. Bewust geaccepteerd (de subscriptie ís het
  ticket-04-contract), maar het is een gedragsverschil om bij ticket 22 opnieuw tegen te houden.

- **`normalizeRepositoryPath` en `reconcileGoTestFileRows` blijven in `content.js`.** Geen enkel
  ticket 13–21 claimt de go-test-file-rows-feature. Bij ticket 22 moet blijken of dat een gemiste
  slice is of bewust legacy-restant.

## Batch 1 (27–29) — uitgevoerd 2026-08-04, commit d295410

Tickets 27, 28 en 29 staan op `resolved`; 30–36 blijven `proposed` en hebben dezelfde
sign-off nodig. `go-navigation.js` ging van 1324 naar ~1000 regels. Vier besluiten die
buiten de tickets vielen en bij ticket 22 opnieuw langs moeten:

- **`status()` blijft in `go-navigation.js`.** Ticket 28 vroeg om de `golens-go-status`-dispatch
  mee te verhuizen; dat kan niet. `init()` vuurt `status('idle', ...)` synchroon, de
  import-bridge resolvet pas een microtask later, dus een dispatcher achter de bridge laat dat
  eerste event vallen — en juist dat event is live (browser-smoke.mjs:283/:460). `status` gaat nu
  als dependency de source-loader in. Derde keer dat dit event ons bijna te grazen nam; laat het
  de laatste zijn.
- **Platform-services krijgen late-bound accessors, geen gecapturede waarden.**
  `createGitLabApi({ getClock, getSignal })`, en `fetch` valt per call terug op
  `globalThis.fetch`. Drie bestaande gedragingen eisen dit (tests herschrijven `globalThis.fetch`
  mid-test, `setClock` wisselt na constructie, `state.abortController` wordt bij elke init
  vervangen). Zelfde idioom als `createLegacyDebounceIdle(getClock)`. Vermoedelijk het patroon
  voor elke volgende platform-service met een verwisselbare dependency.
- **`normalizePath`/`parseBlobLink`/`dirname` blijven gedupliceerd** tussen `diff-dom.js` en
  `gitlab-api.js`. Ontdubbelen zou een platform→platform-edge introduceren voor ~15 regels pure
  string-afhandeling. Beide module-headers leggen het besluit vast.
- **De toast gebruikt kale `setTimeout`, niet de verwisselbare `clock`** (ticket 29 stelde
  `createToast({ clock })` voor). Doorlussen zou `setClock` nieuw invloed geven op toast-timing.
  De features bereiken de toast ook nog steeds via de `legacyToast`-capability; directe injectie
  is 36/22-werk.

**De import-bridges introduceren een laadvenster, en de faalhouding verschilt per laag.** Tussen
IIFE-start en bridge-resolve gooien de synchrone gitlab-api-wrappers, await'en de async wrappers,
en no-op'en de toast-wrappers stil (een toast is nooit load-bearing). Teardown-bereikbare resets
optional-chainen altijd. Alle huidige call-sites van de synchrone groep liggen na de load, dus in
productie onbereikbaar — maar bij ticket 22, als de bridges verdwijnen, moet dit venster
verdwijnen en niet stilletjes van vorm veranderen. De source-loader-bridge is om dezelfde reden
*geketend* achter de gitlab-api-bridge in plaats van ermee te racen: zijn ingespoten deps zijn
go-navigation.js's synchrone wrappers.

**Correctie op de flakiness-regel hieronder.** Het settings-overlay-scenario van de browser-smoke
is rood, en niet door deze wijziging: een baseline-run op HEAD (9c62a28, ticket 26) faalt identiek
— zelfde fingerprint (skeleton-fixture gerenderd, `data-golens-skeleton-remounted="true"`, geen
`#golens-settings-root`, dan timeout). Ook uitgesloten dat het een stille bridge-failure was:
tijdelijke `console.error` in alle drie de nieuwe `.catch()`-handlers gaf nul treffers over drie
runs. De regel "twee keer solo falen is echt kapot" gaat over *hetzelfde* scenario dat tweemaal
faalt — daar bleek hier ook aan voldaan, maar de oorzaak ligt vóór batch 1. **Dit scenario is nog
niet opgelost en hoort een eigen ticket te krijgen; batch 1 heeft het niet veroorzaakt en lost het
niet op.**

## Batch 2 (30, 32–33) — uitgevoerd 2026-08-04

Tickets 30, 32 en 33 staan op `resolved`. Ticket 31 (spa-reconcile) blijft bewust buiten
deze batch: het ticket zelf noemt zijn kernvraag ("lifecycle vs. nieuwe feature-module")
nog onbeantwoord en verwijst naar een aparte ronde — niets daarin geraakt aangepast.
`content.js` ging van 899 naar ~290 regels. Besluiten die buiten de tickets vielen:

- **`controls.js` blijft één module, geen controls-shell/bookmark-drawer-split.** Ticket 30
  vroeg om dat expliciet af te wegen. De trigger-knop van de drawer leeft in de shadow-root
  van de toolbar, één `bookmarks.subscribe()`-callback stuurt zowel de toolbar-badge als een
  open drawer aan, en het sluiten van de drawer reikt terug de toolbar-shadow in om
  `aria-expanded` te resetten. Splitsen zou een nieuwe cross-module-seam eisen voor precies de
  koppeling die ticket 30 zelf verbiedt (geen nieuwe `globalThis`-contracten) — dus één feature.
- **`rapid-diffs`-opt-in blijft in `content.js`**, zoals ticket 31 al aangaf. `controls.js`
  krijgt alleen `legacy.enableRapidDiffs` doorgegeven voor de entering-tak van
  `toggleReviewFocus`; `watchForRapidDiffs`/`enableRapidDiffs`/`isMergeRequestDiff` blijven
  ongewijzigd in `content.js` en worden ook niet dubbel geïmplementeerd.
- **Elke DOM-lookup in `controls.js` gaat via module-scoped `host`/`drawerHost`-referenties**,
  nooit via `document.getElementById('gitlab-lens-root')` (zoals de originele
  `closeBookmarkDrawer()`/`renderBookmarkControl()`-defaults deden). `page/main.js` registreert
  een tweede, inerte instantie (zelfde vorm als bookmarks/project-search/code-intel) die
  `page/lifecycle` bij elke SPA-navigatie mount/unmount't; zonder deze scoping-regel zou die
  inerte instantie de echte toolbar/drawer van de content.js-instantie kunnen slopen. Getest in
  `tests/features-controls.test.js` ("unmount() only ever touches this instance's own host").
- **`bookmarkDrawerPosition` gebruikt `||`, niet `??`**, voor de fallback op `bounds.left`/
  `bounds.top` — bewust byte-voor-byte gelijk aan het origineel. Met `??` zou een toolbar die
  exact op `top: 0`/`left: 0` staat een ander resultaat geven dan de legacy-expressie.
- **`content.js`'s `visibilitychange`/`focus`/`fullscreenchange`-listeners voor preload-refresh
  en review-focus-auto-exit verhuizen mee naar `controls.js`'s eigen `mount()`** (zelfde
  self-contained idioom als de andere feature-modules): `content.js`'s eigen
  `visibilitychange`-listener roept nu alleen nog `schedulePageReconcile()` aan, niet meer
  `refreshPreloadStatus()` — dat zit nu in `controls.js`'s eigen listener op hetzelfde event.
  Functioneel identiek (beide vuren op dezelfde gebeurtenis), maar wel twee listeners op
  hetzelfde event in plaats van één.
- **`reconcilePage()`'s call-site blijft ongewijzigd in `content.js`** (ticket 31's scope), net
  als de instructie in ticket 30 vroeg — alleen de implementatie erachter
  (`createControls`/`setEnabled`/preload-machine) is verhuisd naar `controlsHandle`.

## Fan-out-regels voor 14–21 (file-ownership)

De feature-carve-outs snijden uit twee hub-bestanden; max één agent per hubbestand tegelijk.

| ticket | `content.js` | `go-navigation.js` |
|---|---|---|
| ~~14 celebration~~ | ~~✔~~ | ~~✔~~ | *(klaar)* |
| ~~15 onboarding~~ | ~~✔~~ | | *(klaar)* |
| ~~16 settings-overlay~~ | ~~✔~~ | | *(klaar)* |
| ~~17 keyboard-nav~~ | ~~✔~~ | ~~✔~~ | *(klaar)* |
| 18 bookmarks | ✔ | ✔ |
| ~~19 mr-preload~~ | | ~~✔~~ | *(klaar)* |
| 20 project-search | | ✔ |
| 21 code-intel | | ✔ |

Open: 18, 20, 21.

17 en 18 raken beide hubs en draaien dus solo. `page/main.js` (de `features`-array) is een
gedeeld raakvlak van élk ticket — parallelle agents moeten hun entry met een eigen, unieke anchor
toevoegen.

## Message-seam: opgelost in ticket 16 (2026-08-03)

Ticket 16 faalde eerst en is daarna in tweede instantie opgelost door éérst de oorzaak weg te
nemen. Wat er nu ligt, erft elke volgende message-gestuurde carve-out:

- **`bootstrap.js` is de enige `chrome.runtime.onMessage`-registratie voor de page-modules.** Het
  is een klassiek content script, dus die listener bestaat vanaf script-evaluatie. Binnenkomende
  messages worden vastgehouden tot er een handle is (`withHandle()`) — dat dekt zowel de eerste
  page-load als élk unmount/import/mount-gat van een SPA-remount. Vóór deze fix ging elke message
  in die vensters stil verloren; in productie deed een popup-klik tijdens het laden niets.
- **`page/lifecycle`'s `start()` geeft `dispatch(message)` terug.** `page/main.js` geeft
  `runtime: null` mee om zelfregistratie uit te zetten, anders dispatcht elke message twee keer.
  Zelfregistratie blijft voor aanroepers die wél een `runtime` meegeven (de tests).
- **Wie antwoordt: bootstrap, en alleen voor types die het waar kan maken.** Het houdt een lijst
  van geclaimde message-types (nu de drie settings-types), doet `return true`, wacht de handle af,
  dispatcht, en mapt de kind naar dezelfde envelope die `content.js` produceerde. Niet-geclaimde
  types worden wél doorgegeven maar niet beantwoord — `content.js`/`go-navigation.js` antwoorden
  daar synchroon op, en twee responders op één message betekent dat er één verliest.

**Regel voor de volgende carve-outs:** een feature-handle geeft een **kind uit een gesloten
verzameling** terug, nooit een stille early return. Bootstrap moet het verschil tussen "gelukt" en
"kon niet" kunnen zien, want `popup.js` toont die fouttekst aan de gebruiker. Claim je een nieuw
message-type in bootstrap, haal het dan weg bij de oude responder in dezelfde wijziging;
`tests/bootstrap-message-seam.test.js` bewaakt dat de lijst een deelverzameling van
`FEATURE_ROUTES` blijft die naar een gemounte feature wijst.

De browser-smoke is hierbij nooit verzwakt: die ving deze race, en zijn settings-scenario is het
bewijs dat de migratie klopt — het slaagt terwijl `content.js` `#golens-settings-root` niet meer
aanmaakt.

- **Ticket 22's premise is factually wrong — legacy files still carry ~2000 lines of
  production code, unclaimed by any ticket.** 22 says "`go-navigation.js` en `content.js`
  bevatten geen productiecode meer" (blockers 07/08/13-21 all done). They do:
  - `go-navigation.js` (1408 lines) still owns the **shared infra every `legacy` capability
    bag depends on** — diff-DOM primitives (`diffRootFor`/`rapidFileData`/
    `computeFileContext`/`fileContextFor`/`codeCellFor`/`lineFromAnchor`/`lineAnchorFor`/
    `expansionDirectionForLine`/`waitForDiffUpdate`/`revealLine`/
    `visibleDiffRootForDefinition`/`flashDestination`/`navigateToLocation`/
    `lineContextFor`/`diffFileRoots`, plus the `fileContextGeneration` cache its own
    `diffObserver` invalidates); the GitLab REST/GraphQL layer (`fetchWithRetry`/
    `fetchSource`/`fetchBlob`/`fetchTreeEntries`/`listPackageFiles`/`listProjectFiles`/
    `listMergeRequestChangedFiles`/`searchProjectBlobPaths`/`mergeRequestRefs`/
    `mergeRequestRefsForFile`/`modulePathFor`/`sourceRefFor`/`documentationURL`/
    `projectPackageURL`/`standardLibraryURL`/`packageDocumentationURL`/`parseBlobLink`/
    `normalizePath`/`projectContext`); the `loadPackage`/`loadProject` cache-orchestration
    (`state.packages`/`state.projects`/`state.projectProgressListeners`/`state.modulePaths`,
    `workerRPC`, the `status()` → `golens-go-status` CustomEvent dispatch — **this event is
    live**, see the correction above re: `tests/browser-smoke.mjs:268`/`:445`, don't drop it
    a second time); the toast shadow host (`ensureUI`/`toast`/`hideToast`/`isToastShowing`/
    `showShortcutCoachHint`); and `init()`/`teardown()`/`onKeyDown`/`refreshMergeRequestRefs`
    orchestration, plus the four dynamic-`import()` bridges (keyboard-nav/mr-preload/
    project-search/bookmarks/code-intel) that build `legacy` bags from all of the above and
    the `globalThis.GoLensGoNavigation` surface those bridges are exposed through.
  - `content.js` (899 lines) is **an entire unmigrated feature**, not leftover glue: the
    controls toolbar (~340 lines of shadow DOM: enable toggle, focus toggle, preload button,
    bookmarks button), the bookmark drawer UI (list rendering, jump/remove/recover/clear
    actions), review-focus/fullscreen (`toggleReviewFocus`), the preload state machine
    (`preloadMergeRequest`/`refreshPreloadStatus`/`startFullProjectPreload`/
    `refreshFullProjectPreloadStatus`), the SPA reconcile loop (`reconcilePage`/
    `leaveMergeRequestPage`/the body `MutationObserver`/`turbo:load`/`pjax:end`/`popstate`),
    rapid-diffs opt-in (`enableRapidDiffs`/`watchForRapidDiffs`), the discussion-line-link
    feature (`overviewDiscussionLineTarget`/`mountOverviewDiscussionLineLink`/
    `reconcileOverviewDiscussionLineLinks`), the previously-flagged
    go-test-file-rows feature (`normalizeRepositoryPath`/`reconcileGoTestFileRows`), and
    `content.js`'s own `chrome.runtime.onMessage` listener for `golens-enabled`/
    `golens-cache-invalidated`/`golens-preload-full-project`/`golens-full-project-status`
    (bootstrap.js's message-seam, per the ticket-16 section above, only claims the three
    settings types — these four still need a home when `content.js`'s own listener goes
    away).
  - Two `state.enabled` flags (one in each file), both real gates
    (`runNavigationAction`/`reconcileGoTestFileRows`/the `legacy.isEnabled` capabilities),
    driven by the same setting but with no single owner post-split — "één eigenaar per
    `chrome.storage`-key" (03) covers the storage key, not this derived fan-out.
  - **Ticket 22 is set to `blocked` below pending new tickets for this work** (proposed
    immediately below); its own checklist is unchanged and still correct once those land.

- **Proposed tickets to close the gap above.** 26–29 zijn inmiddels goedgekeurd en
  `resolved` (zie de batch-1-sectie hierboven); **30–36 blijven `proposed`** en hebben nog
  steeds sign-off nodig voordat er code voor geschreven wordt:
  - Platform (what every `legacy` bag actually needs, so first):
    - **26 — `page/platform/diff-dom.js`**: the diff-DOM primitive group above, verbatim
      behaviour. Home for `fileContextGeneration`'s cache-bump too, or documents why it
      stays with whichever module keeps the `diffObserver`.
    - **27 — `page/platform/gitlab-api.js`**: the REST/GraphQL group above
      (`fetchWithRetry` and everything built on it).
    - **28 — `page/platform/source-loader.js`**: `loadPackage`/`loadProject` + their cache
      state + `workerRPC` + the `status()`/`golens-go-status` dispatch. Blocked by 27
      (fetch layer) and needs `rpc-client.js` (09, done).
    - **29 — `page/platform/toast.js`**: the toast shadow host
      (`ensureUI`/`toast`/`hideToast`/`isToastShowing`/`showShortcutCoachHint`).
  - Features (the unmigrated content.js feature, split by concern):
    - **30 — `page/features/controls.js`**: toolbar + preload state machine +
      review-focus + bookmark drawer. Largest of the new tickets; may itself want
      splitting (controls-shell vs. bookmark-drawer) when scoped — flag that at
      breakdown time rather than deciding here.
    - **31 — SPA reconcile loop**: `reconcilePage`/`leaveMergeRequestPage`/the
      MutationObserver/turbo/pjax/popstate listeners. Open design question this ticket
      must answer: fold into `page/lifecycle` (it's arguably lifecycle's job already) or
      a new `page/features/mr-page-reconciler.js` — decide against ticket 03 §3's
      dependency rules before writing code, don't default silently.
    - **32 — `page/features/discussion-line-link.js`**: `overviewDiscussionLineTarget`/
      `mountOverviewDiscussionLineLink`/`reconcileOverviewDiscussionLineLinks`.
    - **33 — `page/features/go-test-file-rows.js`**: `normalizeRepositoryPath`/
      `reconcileGoTestFileRows` (the gap map.md already flagged under ticket 13/22 above).
  - **34 — owner for the derived enable/disable fan-out**: decide and document who drives
    `state.enabled`'s effects (navigation actions, go-test-file-rows, `legacy.isEnabled`)
    once both legacy flags are gone — likely settings-store's `subscribe('enabled', …)`
    fanning out through page/lifecycle, but that's this ticket's decision to make, not an
    assumption to bake into 26-33.
  - **35 — content.js's remaining message types**: `golens-enabled`/
    `golens-cache-invalidated`/`golens-preload-full-project`/`golens-full-project-status`
    need a bootstrap.js claim (ticket-16 pattern) once `content.js`'s own listener is
    deleted. Likely folds into whichever of 30/31 owns the behaviour each message
    triggers, but call it out as its own checklist item so it isn't dropped silently.
  - **36 — go-navigation.js's orchestration slice** (added 2026-08-04, after review of
    26-35): the group this list originally named in the inventory above but then failed to
    give a ticket — `init()`/`teardown()`/`onKeyDown` (live Escape routing, two branches)/
    `runNavigationAction` (the `state.enabled` gate, reached from `page/main.js:66`)/
    `state.diffObserver` + `isBookmarkOnlyMutation`/`refreshMergeRequestRefs`/
    `ensureRpcClient`+`workerRPC`/`offerShortcutCoach`, plus the `__test` bag (35 entries,
    consumed by `tests/go-navigation-context.test.js`, `tests/benchmarks/diff-dom.bench.mjs`
    and the `content-*` tests) that dies with the file. Blocked by 31 and 34 — `init()` *is*
    the second `state.enabled` flag and `content.js:686`/`:282` (31's reconcile loop) is what
    calls it, so both decisions land first. A valid outcome of 36 is "dissolves into 31+34,
    no module of its own", documented rather than assumed.
  - **22 rewritten** (after 26-36 land): only what its title says — delete the four
    dynamic-import bridges and `globalThis.GoLensGoNavigation`/`GoLensContent`, wire real
    deps into `page/main.js`/`page/lifecycle` directly, update the manifest, verify
    dependency rules over the full graph, full `npm run check` + browser-smoke green.
    **This supersedes 22's own correction note** ("deze ticket blijft ongewijzigd"), which
    contradicted this line: rehoming live behaviour is 36's job, bridge-deletion is 22's.

## Not yet specified

- Niets meer — de capability-migraties zijn geticket als 05–22 (2026-08-03, via `/to-tickets`,
  breakdown door de user goedgekeurd). De spec = de antwoorden van tickets 03+04 (geen apart
  document, per user-besluit); de executievolgorde = de blocking-graph van 05–22. Uitvoering valt
  binnen deze map. Frontier bij start: 05 en 06.
- Toegevoegd tijdens uitvoering (2026-08-03): **23** (browser-smoke weer groen) en **24** (benchmark
  OOM) — beide gates zijn kapot los van deze operatie, en beide horen vóór 13–21 gefixt te zijn omdat
  dat de tickets zijn die gedrag en performance uit de hub-bestanden snijden. **25** (README/AGENTS
  hervalideren) hangt achter 22.

## Out of scope

- Any TypeScript migration work itself.
- Any UI, Lit, or framework changes.
- Reusing or re-validating the `caspers/rewrite-extension-architecture` module analysis — ignored per
  user instruction, not reopened.
