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
