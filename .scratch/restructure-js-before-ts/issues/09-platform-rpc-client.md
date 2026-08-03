# 09 — platform/rpc-client

**What to build:** De port-RPC (`golens-go-rpc`) verhuist uit `go-navigation.js` naar een
`platform/rpc-client`-module met de ticket 04 §2-interface: `createRpcClient({connect})` met
`query`/`cache`/`index`-namespaces, 1:1 op het bestaande wire-contract; framing (`{id,method,
params}`), reconnect en in-flight-administratie privé. Infra-falen als rejection
(`RpcUnavailableError`), domein-uitkomsten als `kind`-gediscrimineerde returnwaarden (ticket 04
§5) — wire-payloads zelf wijzigen niet. `go-navigation.js` consumeert de client via een
tijdelijke bridge; het oude inline RPC-mechanisme verdwijnt.

**Blocked by:** 05 — Bootstrap + page-skelet.

**Status:** ready-for-agent

- [ ] Alle 20 wire-methods bereikbaar via de drie namespaces; geen wire-wijziging
- [ ] Port-lifecycle/framing niet meer zichtbaar in go-navigation.js
- [ ] Rejections alleen bij infra-falen; bestaand foutgedrag in de UI ongewijzigd
- [ ] Volledige `npm run check` groen
