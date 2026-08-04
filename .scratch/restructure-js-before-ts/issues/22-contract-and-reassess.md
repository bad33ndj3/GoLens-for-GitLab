# 22 — Contract & reassess

**What to build:** De afronding (contract-fase van expand–contract, plus source-plan stap 14):
legacy `go-navigation.js` en `content.js` bevatten geen productiecode meer en verdwijnen, samen
met alle tijdelijke globalThis-bridges en de oude manifest-entries. Manifest definitief:
bootstrap + ES-module-graph. Daarna abstracties heroverwegen na de reeks migraties: interfaces die
in de praktijk te breed/te smal bleken worden bijgesteld en in de tickets 03/04-antwoorden
gedocumenteerd; dependency-regels nagelopen op overtredingen.

**Blocked by:** 07; 08; 13; 14; 15; 16; 17; 18; 19; 20; 21; 26; 27; 28; 29; 30; 31; 32; 33; 34; 36.
(35 stond hier eerder ook — verwijderd, zie **Bevindingen batch 3** hieronder: 35 hangt van 22 af,
niet andersom.)

**Status:** ready-for-agent — alle overige blockers zijn `resolved`/`done`/`closed`.

**Correctie (2026-08-04):** premise "legacy bestanden bevatten geen productiecode meer"
klopt niet — zie map.md's `## Correcties tijdens uitvoering` voor de volledige inventarisatie
(~2000 regels ongeclaimde productiecode in beide hub-bestanden) en de tickets 26-36 die dat gat
dichten. Deze ticket wordt weer `ready-for-agent` zodra 26-36 landen.

**Scope-afbakening (2026-08-04, tweede ronde):** een eerdere versie van deze correctie zei dat
deze ticket "ongewijzigd blijft", terwijl map.md's voorstellijst 22 juist inperkte tot alleen zijn
titel. Dat is nu beslecht: **22 bezit alleen het slopen** van de vijf dynamic-import-bridges en
`globalThis.GoLensGoNavigation`/`GoLensContent`, de manifest-update en de
dependency-regelverificatie over de hele import-graph. Het **herhuisvesten van het levende gedrag**
dat vandaag nog in `go-navigation.js`'s orkestratielaag zit (`init`/`teardown`/`onKeyDown`/
`runNavigationAction`/`diffObserver`/`refreshMergeRequestRefs`) is ticket 36, niet deze.

**Bevindingen batch 3 (2026-08-04):** 31, 34 en 36's onderzoek (zie hun eigen tickets) wijst hun
resterende implementatiewerk hierheen toe, niet naar een aparte ronde: 31's `reconcilePage`/
`leaveMergeRequestPage`/SPA-detectie-verhuizing naar `page/lifecycle`; 34's aansluiten van
`runNavigationAction`/`reconcileGoTestFileRows`/`legacy.isEnabled` op lifecycle's al-gebouwde
enable-fanout (met de activatie-latch als apart, behouden signaal); 36's volledige
`go-navigation.js`-orkestratieslice (init/teardown/onKeyDown/runNavigationAction/diffObserver/
`__test`-bag-herleiding). 35's vier message-types kunnen pas zonder dubbele responder naar
`bootstrap.js` verhuizen zodra content.js's eigen handler hier verdwijnt. Dit bevestigt 22's
premisse-correctie (zie boven): het "slopen"-werk en het "herhuisvesten van resterend levend
gedrag"-werk zijn in de praktijk niet los te knippen — allebei landen in deze ticket.

**Correctie (2026-08-04, derde ronde):** 35 stond hierboven in 22's eigen blocked-by-lijst, terwijl
35's eigen ticket zegt dat 35 juist op 22 wacht (content.js moet weg vóórdat 35's claim in
bootstrap.js geen dubbele responder wordt). Dat was een cirkel. Opgelost: 35 uit 22's blocked-by
gehaald. 22 is daarmee niet meer geblokkeerd — elke overige blocker staat op `resolved`/`done`/
`closed`.

- [x] Geen globalThis-contract tussen modules meer; legacy-bestanden verwijderd
- [x] Manifest bevat alleen bootstrap (+ ongewijzigde externe scripts) en WAR voor `page/*`
- [x] Dependency-regels (ticket 03 §3) geverifieerd over de hele import-graph
- [x] Afwijkingen van de 03/04-interfaces gedocumenteerd in die tickets
- [x] Volledige `npm run check` + browser-smoke groen

## Voltooiing (2026-08-04)

**Status: resolved.** `go-navigation.js`/`content.js` verwijderd; `manifest.json`'s
`content_scripts[0].js` bevat alleen nog `shortcut-settings.js`/`bookmark-store.js` (de expliciet
buiten scope gehouden globals — `GoLensShortcuts`/`GoLensBookmarks` blijven bestaan). Nieuw bestand:
`page/lifecycle/mr-session.js` (zie ticket 03's deviation-note hierboven voor wat het bezit).
`page/main.js` bouwt nu voor elke feature een echte `legacy`-bag rechtstreeks uit
`page/platform/diff-dom.js`/`gitlab-api.js` en `mr-session.js`'s gedeelde instanties, plus
late-bound closures naar andere features' handles — geen enkele feature is nog een "tweede, inerte
instantie".

**Ontwerpvraag orkestratieslice (punt 4 van de user-opdracht):** `page/lifecycle/mr-session.js`,
zoals in ticket 31's eigen antwoord al vastgelegd ("lifecycle, geen feature"). Bevat de
activatie-latch (`activate`/`deactivate`, vervangt `init`/`teardown`), de SPA-reconcile-loop
(`reconcilePage`/`leaveMergeRequestPage`, event- + MutationObserver-gebaseerd, ongewijzigd gedrag
t.o.v. content.js), de diff-invalidatie-observer (`isBookmarkOnlyMutation`-guard + `diffDom.
bumpFileContextGeneration()`), en de gedeelde platform-service-instanties (`gitlabApi`/
`sourceLoader`/`toast`/lazy `workerRPC`). `page/lifecycle/index.js`'s eigen `NAV_POLL_MS`-poll is
verwijderd (niet ernaast gelaten) — die was expliciet bedoeld voor precies deze reconcile-taak,
"once features exist to reconcile"; nu ze bestaat via mr-session zou de poll een tweede mechanisme
voor dezelfde taak zijn geweest.

**Ontwerpvraag Escape-routing (punt 5):** verhuisd naar `page/features/keyboard-nav.js`, als een
tweede, eigen `keydown`-listener (`onEscapeKeyDown`, capture-phase op `document`, zelfde
registratie-vorm als go-navigation.js's origineel) naast de bestaande shortcut-dispatch-listener —
niet samengevoegd met die listener, omdat go-navigation.js's Escape-guard nooit
`isComposing`/`isBlockedShortcutEvent` checkte en samenvoegen die guards ongewild had laten
meetellen. Twee nieuwe capabilities (`minimizeProjectSearch`/`handleCodeIntelEscape`) vervangen de
oude `projectSearchHandle`/`codeIntelHandle`-toegang, dezelfde prioriteitsvolgorde
(project-search-minimize eerst, dan de popover) en dezelfde input/dialog-guard, byte-voor-byte.

**Message-types (ticket 35, opgelost binnen deze ticket):** alle vier types hebben nu een thuis.
`golens-enabled` blijft bewust onbeantwoord door `bootstrap.js` (nooit `sendResponse` in het
origineel; `page/lifecycle`'s eigen `settings.subscribe('enabled', …)`-fanout past het al toe). De
overige drie zijn geclaimd in `bootstrap.js`'s `RESPONDED_TYPES` en `page/lifecycle/internal.js`'s
`FEATURE_ROUTES` gerepareerd om naar `controls` te wijzen i.p.v. `mr-preload` (zie ticket 03's
deviation-note) — dit is de productie-waarheid van vóór deze ticket, niet ticket 16's eigen aanname.

**Overige verhuizingen:** `runNavigationAction`'s drie bookmark-branches zijn nu
`keyboard-nav.js`'s `runLegacyNavigationAction`-capability, met de body rechtstreeks tegen
`bookmarksHandle`/`codeIntelHandle` (geen feature→feature-rand, want de closure leeft in
`page/main.js`). `enableRapidDiffs`/`watchForRapidDiffs`/`isMergeRequestDiff` zijn verhuisd in
`page/features/controls.js` zelf (enige overgebleven aanroeper, ticket 31's deferral is hiermee
afgehandeld). `triggerPitstopMoment` gaat nu via een statische import van `celebration.js`'s eigen
`requestMoment` in `page/main.js` (geen dynamic-import-bridge meer nodig, celebration.js is al een
echte ES-module).

**Gate-resultaten:** `npm run check:syntax` groen; `node --test tests/*.test.js` → 508/508 groen;
`npm run test:browser` solo tweemaal groen (één geïsoleerde timeout tussendoor, gereproduceerd
tijdens een periode van hoge machine-load vlak na een volledige testrun — komt overeen met map.md's
eerder gedocumenteerde flakiness-regel, niet hetzelfde scenario twee keer op rij). Geen
pre-existing ticket-37-fout waargenomen op deze machine — de baseline vóór elke wijziging was al
5/5 groen, dus de eindstaat is volledig groen, niet "groen op één bekende uitzondering na".

**Nieuwe/aangepaste testbestanden:** `tests/lifecycle-mr-session.test.js` (nieuw — reconcile-debounce,
SPA-teardown/re-activatie/storage-driven-enable, diff-observer-invalidatie: vervangt
`content-reconcile-debounce.test.js` en het SPA-gedeelte van `content-page-controls.test.js`, beide
verwijderd). `tests/go-navigation-context.test.js` en `tests/shortcut-coach-ui.test.js` verwijderd
(volledig gedupliceerd door `tests/platform-gitlab-api.test.js`/`platform-diff-dom.test.js`/
`platform-source-loader.test.js`/`platform-toast.test.js`, die rechtstreeks tegen de echte modules
draaien). `tests/content-bookmarks.test.js` verwijderd; zijn CSS-only test verhuisd naar
`tests/features-bookmarks.test.js` (de rest was al gedupliceerd door
`tests/features-controls.test.js`). `tests/benchmarks/diff-dom.bench.mjs` omgezet naar een
statische import van `page/platform/diff-dom.js`. `tests/lifecycle.test.js`,
`tests/lifecycle-internal.test.js`, `tests/bootstrap-message-seam.test.js`,
`tests/gitlab-host-access.test.js` bijgewerkt voor de FEATURE_ROUTES-reparatie/verwijderde poll/
verwijderde manifest-entries.

**Bug gevonden en gefixt tijdens uitvoering:** de eerste versie van `page/main.js` mountte
`mr-preload` zonder `legacy`-bag (kopieerfout — wél gedaan voor bookmarks/project-search/code-intel/
controls, per ongeluk overgeslagen voor mr-preload). Elke `mr-preload`-methode degradeerde daardoor
stil naar `{status:'unavailable'}`, wat pas zichtbaar werd in de browser-smoke (preload bleef op
"idle" hangen na reload). Gefixt door alsnog een volledige `legacy`-bag te bouwen
(`projectContext`/`mergeRequestHeadRef`/`mergeRequestIID`/`workerRPC`/`loadPackage`/`loadProject`/
`listMergeRequestChangedFiles`/`modulePathFor`/`searchProjectBlobPaths`/`projectLoadingProgress`/
`forgetStaleProjectCache`/`resetCaches`) — precies wat go-navigation.js's eigen bridge eerder
injecteerde. Dit is de reden waarom de browser-smoke, ondanks alle unit-tests groen, ontbrekende
capability-bags nog kan vangen die unit-tests met eigen mocks niet zouden zien.

**Niet aangeraakt / bewust buiten scope:** `page/lifecycle/internal.js`'s `classifyPageTransition`
is na het verwijderen van de poll ongebruikt door productiecode, maar blijft staan (eigen geteste
pure export, verwijderen is geen onderdeel van "bridges slopen"). Enkele historische
`go-navigation.js`/`content.js`-verwijzingen in modulecommentaar (waar ze feiten over de herkomst
beschrijven, niet over de huidige architectuur) zijn niet allemaal herschreven — de meest misleidende
("tweede inerte instantie", actieve self-bridge-claims) zijn wel gecorrigeerd
(`controls.js`/`celebration.js`/`bookmarks.js`/`code-intel.js`/`page/main.js`/`clock.js`/
`source-loader.js`).
