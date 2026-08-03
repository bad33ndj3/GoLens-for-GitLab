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
