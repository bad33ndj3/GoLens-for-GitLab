# 35 — content.js's resterende message-types naar bootstrap

**What to build:** `content.js`'s eigen `chrome.runtime.onMessage`-listener behandelt vandaag
`golens-enabled`/`golens-cache-invalidated`/`golens-preload-full-project`/
`golens-full-project-status`. Zodra `content.js` verdwijnt (ticket 22) hebben deze vier types een
claim in `bootstrap.js` nodig, zelfde patroon als ticket 16's drie settings-types (zie map.md's
"Message-seam"-sectie: geclaimde types in een lijst, `withHandle()`, kind-uit-gesloten-verzameling
antwoorden, `tests/bootstrap-message-seam.test.js` bewaakt de deelverzameling-invariant). Valt
vermoedelijk toe aan welke van 30/31 het onderliggende gedrag bezit (`golens-enabled` → 34's
eigenaar; `golens-cache-invalidated`/`golens-preload-full-project`/`golens-full-project-status` →
30's preload-state-machine) — dit ticket claimt ze expliciet in bootstrap.js zodat ze niet
stilzwijgend verloren gaan.

**Blocked by:** 30 — feature-controls (gereed); 34 — derived-enabled-owner (beslecht, zie 34's
`## Answer`); **22 — contract-and-reassess (nieuw, zie `## Bevinding` hieronder)**.

**Status:** resolved — geland binnen ticket 22's commit (fc595d4), zie `## Voltooiing` hieronder.

## Bevinding

*(2026-08-04, batch 3)* Getoetst of de vier message-types nu al naar `bootstrap.js` kunnen
verhuizen, gegeven dat 30 en 34 klaar zijn. `content.js:270-291` beantwoordt alle vier vandaag nog
zelf (`golens-enabled`/`golens-cache-invalidated`/`golens-preload-full-project`/
`golens-full-project-status`), en ditzelfde bestand documenteert al de exacte valkuil voor de twee
overige message-types (`golens-show-onboarding`/`golens-show-settings`, regel 286-290): twee
responders op één type betekent dat er één verliest.

Om deze vier in `bootstrap.js` te claimen zonder die valkuil moet content.js's eigen
`chrome.runtime.onMessage`-handler eruit — maar content.js is de plek waar de **werkende**
`controlsHandle` gemount wordt (met `ctx.legacy`, ticket 30). `page/lifecycle` (waar `bootstrap.js`
doorheen route't) mount alleen de **inerte** tweede `controls`-instantie (geen `ctx.legacy`,
`page/main.js:118`) — die beantwoordt elke aanroep met `{status:'unavailable', …}`. Zolang
content.js blijft bestaan náást de claim in bootstrap.js, is er dus geen "twee responders op
hetzelfde bericht"-risico te vermijden zonder de MR-preload-vanuit-popup-flow kapot te maken:
óf content.js's handler blijft (en bootstrap.js's claim is dood/dubbel), óf hij gaat weg (en dan
routeert alles naar de inerte instantie, die niets doet).

**Conclusie: deze ticket kan pas landen ná/samen met ticket 22** (waar content.js daadwerkelijk
verdwijnt en `controlsHandle`'s functionaliteit een andere, blijvende eigenaar krijgt — zie ticket
31's `## Answer` voor het lot van content.js's orkestratie in het algemeen). Blocked-by hierboven
uitgebreid met 22.

- [x] Alle vier message-types geclaimd in `bootstrap.js`, geroute naar de juiste feature-handle
- [x] `tests/bootstrap-message-seam.test.js`'s deelverzameling-invariant blijft kloppen
- [x] Geen twee responders op hetzelfde message-type
- [x] `npm run check:syntax` en `npm test` groen; browser-smoke solo groen (met kanttekening, zie
      `## Voltooiing`)

## Voltooiing (2026-08-04, vervolgsessie)

Geen aparte implementatie nodig — ticket 22's commit (`fc595d4`) claimde alle vier types al in
`bootstrap.js` in dezelfde wijziging die `content.js` verwijderde (`bootstrap.js:40-53`, expliciet
gecommentarieerd "Ticket 22/35"), precies zoals de `## Bevinding` hierboven voorspelde ("kan pas
landen ná/samen met ticket 22"). Dit is dus een paperwork-only sessie: status bijgewerkt, checklist
geverifieerd.

- **`golens-cache-invalidated`/`golens-preload-full-project`/`golens-full-project-status`** zitten
  in `RESPONDED_TYPES` en worden beantwoord via `envelopeFor()` tegen `controls.js`'s handle
  (ticket 30's preload-state-machine).
- **`golens-enabled`** wordt bewust *niet* in `bootstrap.js` beantwoord — zelfde gedrag als
  `content.js` altijd had (nooit een response gestuurd). Het routeert via `page/lifecycle/
  internal.js`'s `routeMessage()` naar lifecycle's eigen `enabled`-fanout, wat ticket 34's `## Answer`
  al aanwijst als de vaste eigenaar van de afgeleide enable/disable-fanout. Dat maakt de vier-types-
  claim compleet: drie beantwoord door een feature-handle, één bewust doorgeroute zonder response,
  net als voorheen.
- **Eén responder bevestigd**: `grep -rn sendResponse` over alle niet-test-bestanden treft alleen
  `bootstrap.js` voor deze vier types (`go-semantic-worker.js`'s `sendResponse` bedient een andere
  message-namespace; `page/lifecycle/index.js` en de feature-modules documenteren expliciet dat ze
  nooit zelf `sendResponse` aanroepen). `content.js` bestaat niet meer, dus geen dubbel-responder-
  risico.
- **Gates**: `npm run check:syntax` groen. `node --test tests/*.test.js` 508/508 groen, inclusief
  `tests/bootstrap-message-seam.test.js`'s subset-assertie tegen `RESPONDED_TYPES`.
- **Browser-smoke, kanttekening**: vier solo-runs op deze commit gaven 4/4 rood, verdeeld over twee
  al gedocumenteerde, losstaande oorzaken — geen van beide door dit ticket veroorzaakt of ermee
  samenhangend: twee keer scenario 5 (large-diff, `<40ms`-timing, machine-load-flakiness zoals
  map.md al vastlegt) en twee keer de settings-overlay-race die ticket 37 al opent (`Extension
  message golens-show-settings did not reach ... Receiving end does not exist`). In alle vier runs
  faalde de skeleton-mount-scenario (de eerste, vóór settings) niet — bootstrap.js/manifest injecteren
  en mounten dus prima; dit is geen ticket-22/35-regressie. Zie map.md's `## Correcties tijdens
  uitvoering` voor de bredere notitie: dit weerspreekt ticket 22's afsluitnotitie ("solo tweemaal
  groen").
