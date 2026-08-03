# 11 — lifecycle-orchestrator

**What to build:** De `page/lifecycle`-module (ticket 03 §2, interface ticket 04 §3): pure
`classifyPageTransition(url, prev)` en `routeMessage(msg)`-cores, een shell die features via
`mount(ctx) → { unmount, … }` beheert, `enabled`-gating, en de `chrome.runtime.onMessage`-dispatch.
Coexisteert met de legacy reconcile: zolang features nog niet gemigreerd zijn, mount lifecycle een
lege/minimale set en delegeert de rest ongewijzigd aan `content.js`. SPA-detectie via
`location.href`-observatie (prototype-bevinding, ticket 04 §7). `ctx` bevat uitsluitend
platform-services + geïnjecteerde capabilities.

**Blocked by:** 05 — Bootstrap + page-skelet.

**Status:** resolved

Gebouwd: `page/lifecycle/internal.js` (pure `classifyPageTransition(url, prev) →
'initial'|'unchanged'|'navigation'` en `routeMessage(msg)` → kind-gediscrimineerde
route uit `{lifecycle, routed, unrouted}`) en `page/lifecycle/index.js` (shell
`start({platform, features, runtime, location}) → {stop}`). `page/main.js`
start de lifecycle nu met een leeg `features`-array; content.js/go-navigation.js
zijn niet aangeraakt.

Deviation (gedocumenteerd in `page/lifecycle/index.js`'s header en hier): §3's
letterlijke `routeMessage(msg) → {feature, action}` kan "geen route" niet
uitdrukken zonder `null` (verboden door §5). Uitgebreid naar drie kinds:
`{kind:'lifecycle', action:'setEnabled'}` voor `golens-enabled` (die key is
lifecycle's eigen, geen feature-route), `{kind:'routed', feature, action}` voor
bekende types, `{kind:'unrouted'}` anders.

Transitional dubbele SPA-observatie (bewust, niet een fout): `bootstrap.js`
(ticket 05) pollt al `location.href` om de hele modulegraf te hermounten;
`page/lifecycle` pollt daarnaast zelf `location.href` via de geïnjecteerde
clock, voor een ander doel (reconciliatie van de gemounte feature-set zonder
volledige remount). Vandaag is dat inert (`features` is leeg). Zie
`page/lifecycle/index.js`'s commentaar voor de volledige redenering.

- [x] `start({platform, features}) → {stop}` werkt; mount/unmount-volgorde expliciet — getest in `tests/lifecycle.test.js` (mount forward, stop reverse, idempotent).
- [x] Paginatransitie-classificatie puur en los getest — `tests/lifecycle-internal.test.js`.
- [x] Legacy-gedrag ongewijzigd zolang features niet gemigreerd zijn — content.js/go-navigation.js ongewijzigd; lifecycle's onMessage-listener retourneert nooit een waarde en roept nooit `sendResponse`, dus raced niet met content.js's listener (geverifieerd in `tests/lifecycle.test.js`).
- [ ] Volledige `npm run check` groen — niet geverifieerd: `npm run check` bevat `test:browser` (`tests/browser-smoke.mjs`), die environment-breed kapot is op deze machine (buiten scope van deze ticket). Wel groen: `node --test tests/*.test.js` (213/213) en `npm run check:syntax`.
