# 22 — Contract & reassess

**What to build:** De afronding (contract-fase van expand–contract, plus source-plan stap 14):
legacy `go-navigation.js` en `content.js` bevatten geen productiecode meer en verdwijnen, samen
met alle tijdelijke globalThis-bridges en de oude manifest-entries. Manifest definitief:
bootstrap + ES-module-graph. Daarna abstracties heroverwegen na de reeks migraties: interfaces die
in de praktijk te breed/te smal bleken worden bijgesteld en in de tickets 03/04-antwoorden
gedocumenteerd; dependency-regels nagelopen op overtredingen.

**Blocked by:** 07; 08; 13; 14; 15; 16; 17; 18; 19; 20; 21.

**Status:** ready-for-agent

- [ ] Geen globalThis-contract tussen modules meer; legacy-bestanden verwijderd
- [ ] Manifest bevat alleen bootstrap (+ ongewijzigde externe scripts) en WAR voor `page/*`
- [ ] Dependency-regels (ticket 03 §3) geverifieerd over de hele import-graph
- [ ] Afwijkingen van de 03/04-interfaces gedocumenteerd in die tickets
- [ ] Volledige `npm run check` + browser-smoke groen
