# 07 — Worker: surfaces trimmen + dispatch splitsen

**What to build:** De worker-trio krijgt zijn ticket 04 §4-interfaces: `GoSemanticIndex` en
`GoSemanticSourceCache` publiek getrimd tot de dispatch-set (de ~10 source-record/manifest/
snapshot-helpers van de cache worden underscore-privé), en `performDispatch` gesplitst in pure
method-routing versus persist/rollback-shell (functional core / imperative shell, ticket 03 §4).
Tegelijk de wire-verbetering uit ticket 03 §7: `restoreMergeRequest` geeft compleetheid direct in
zijn eigen RPC-resultaat terug; de caller in `go-navigation.js` gebruikt dat i.p.v. een extra
status-roundtrip. Invarianten expliciet op de interface: refs commit-pinned (`isCommitSHA`) vóór
elke cache-write; mutaties serialiseren door de dispatch-queue.

**Blocked by:** 06 — Worker-opruiming (zelfde bestanden).

**Status:** ready-for-agent

- [ ] Publieke method-lijsten exact conform ticket 04 §4; rest underscore-privé
- [ ] Routing puur en los testbaar; effecten in de shell; beide RPC-transports achter één contract
- [ ] `restoreMergeRequest`-resultaat bevat compleetheid; caller doet geen extra status-call meer
- [ ] Volledige `npm run check` groen; worker-tests testen via de publieke interface
