# 11 — lifecycle-orchestrator

**What to build:** De `page/lifecycle`-module (ticket 03 §2, interface ticket 04 §3): pure
`classifyPageTransition(url, prev)` en `routeMessage(msg)`-cores, een shell die features via
`mount(ctx) → { unmount, … }` beheert, `enabled`-gating, en de `chrome.runtime.onMessage`-dispatch.
Coexisteert met de legacy reconcile: zolang features nog niet gemigreerd zijn, mount lifecycle een
lege/minimale set en delegeert de rest ongewijzigd aan `content.js`. SPA-detectie via
`location.href`-observatie (prototype-bevinding, ticket 04 §7). `ctx` bevat uitsluitend
platform-services + geïnjecteerde capabilities.

**Blocked by:** 05 — Bootstrap + page-skelet.

**Status:** ready-for-agent

- [ ] `start({platform, features}) → {stop}` werkt; mount/unmount-volgorde expliciet
- [ ] Paginatransitie-classificatie puur en los getest
- [ ] Legacy-gedrag ongewijzigd zolang features niet gemigreerd zijn
- [ ] Volledige `npm run check` groen
