# 22 — Contract & reassess

**What to build:** De afronding (contract-fase van expand–contract, plus source-plan stap 14):
legacy `go-navigation.js` en `content.js` bevatten geen productiecode meer en verdwijnen, samen
met alle tijdelijke globalThis-bridges en de oude manifest-entries. Manifest definitief:
bootstrap + ES-module-graph. Daarna abstracties heroverwegen na de reeks migraties: interfaces die
in de praktijk te breed/te smal bleken worden bijgesteld en in de tickets 03/04-antwoorden
gedocumenteerd; dependency-regels nagelopen op overtredingen.

**Blocked by:** 07; 08; 13; 14; 15; 16; 17; 18; 19; 20; 21; 26; 27; 28; 29; 30; 31; 32; 33; 34; 35.

**Status:** blocked

**Correctie (2026-08-04):** premise "legacy bestanden bevatten geen productiecode meer"
klopt niet — zie map.md's `## Correcties tijdens uitvoering` voor de volledige inventarisatie
(~2000 regels ongeclaimde productiecode in beide hub-bestanden) en de voorgestelde tickets
26-35 die dat gat dichten. Deze ticket blijft ongewijzigd en wordt weer `ready-for-agent`
zodra 26-35 landen.

- [ ] Geen globalThis-contract tussen modules meer; legacy-bestanden verwijderd
- [ ] Manifest bevat alleen bootstrap (+ ongewijzigde externe scripts) en WAR voor `page/*`
- [ ] Dependency-regels (ticket 03 §3) geverifieerd over de hele import-graph
- [ ] Afwijkingen van de 03/04-interfaces gedocumenteerd in die tickets
- [ ] Volledige `npm run check` + browser-smoke groen
