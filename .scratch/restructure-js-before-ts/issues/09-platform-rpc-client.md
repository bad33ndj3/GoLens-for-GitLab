# 09 — platform/rpc-client

**What to build:** De port-RPC (`golens-go-rpc`) verhuist uit `go-navigation.js` naar een
`platform/rpc-client`-module met de ticket 04 §2-interface: `createRpcClient({connect})` met
`query`/`cache`/`index`-namespaces, 1:1 op het bestaande wire-contract; framing (`{id,method,
params}`), reconnect en in-flight-administratie privé. Infra-falen als rejection
(`RpcUnavailableError`), domein-uitkomsten als `kind`-gediscrimineerde returnwaarden (ticket 04
§5) — wire-payloads zelf wijzigen niet. `go-navigation.js` consumeert de client via een
tijdelijke bridge; het oude inline RPC-mechanisme verdwijnt.

**Blocked by:** 05 — Bootstrap + page-skelet.

**Status:** resolved — behalve de browser-smoke-verificatie (environment-breed kapot, niet
uitgevoerd/gechased per instructie)

- [x] Alle 20 wire-methods bereikbaar via de drie namespaces; geen wire-wijziging
- [x] Port-lifecycle/framing niet meer zichtbaar in go-navigation.js
- [x] Rejections alleen bij infra-falen; bestaand foutgedrag in de UI ongewijzigd
- [x] `node --test tests/*.test.js` groen (187/187, incl. 12 nieuwe rpc-client-tests);
      `npm run check:syntax` groen. `npm run test:browser` niet uitgevoerd
      (environment-breed kapot, buiten scope van dit ticket)

## Uitvoeringsnotities

- `page/platform/rpc-client.js` (nieuw): `createRpcClient({connect, onDisconnect})` →
  `{query, cache, index, dispose}`, plus `methodNamespace(method)` en `RpcUnavailableError`.
  Framing/timeouts (20s/120s, identieke methode-lijst) en reconnect 1:1 overgenomen uit de oude
  `workerRPC` in `go-navigation.js`.
- Twee bewuste afwijkingen van ticket 04 §2's letterlijke signatuur (`createRpcClient({connect})`),
  beide gedocumenteerd in de module zelf:
  - `onDisconnect` (optionele dep): de bridge in `go-navigation.js` moet `state.packages`/
    `state.projects`/`state.modulePaths` legen zodra de worker-service herstart — dezelfde
    notificatie die de oude inline `port.onDisconnect`-listener gaf. Vuurt niet bij `dispose()`
    (net als vroeger: zelf `port.disconnect()` aanroepen vuurt Chrome's `onDisconnect` niet).
  - `dispose({reason})` (optioneel argument): bewaart de teardown-specifieke afwijstekst ("Go
    intelligence request cancelled") die vroeger apart van de generieke disconnect-tekst liep.
  Wire-contract, framing en foutgedrag zelf zijn ongewijzigd; alleen deze twee lifecycle-haken zijn
  toegevoegd zodat de tijdelijke bridge exact bestaand gedrag kan reproduceren.
- `go-navigation.js`: `workerRPC(method, params)` blijft bestaan als dunne bridge (aanroepers
  dispatchen nog via een dynamische methode-naam-string, bv. `resolveAt(target, 'resolveHover', …)`),
  maar delegeert nu naar de lazy-geïmporteerde client i.p.v. zelf een port te beheren. Client wordt
  pas aangemaakt bij de eerste echte RPC-aanroep (`import(chrome.runtime.getURL(...))`), zodat tests
  zonder `chrome`-mock nooit die pad raken. `state.port`/`state.pending`/`state.rpcID` verwijderd uit
  `go-navigation.js`; teardown roept `rpcClient?.dispose({reason: 'Go intelligence request cancelled'})`.
- `manifest.json` niet aangepast (verboden bestand) — `web_accessible_resources` had al `page/*`,
  dus geen wijziging nodig; geverifieerd met een grep, niet aangenomen.
- Nieuwe tests: `tests/platform-rpc-client.test.js` (12 tests) — namespace-mapping, framing, lazy
  connect, domain-`kind`-resultaten vs. `ok:false`-rejection, timeouts (kort/lang), disconnect +
  reconnect, `onDisconnect`/`dispose()`-lifecycle, id-monotonie over een reconnect.
