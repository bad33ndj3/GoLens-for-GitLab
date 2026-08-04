# 22 — Contract & reassess

**What to build:** De afronding (contract-fase van expand–contract, plus source-plan stap 14):
legacy `go-navigation.js` en `content.js` bevatten geen productiecode meer en verdwijnen, samen
met alle tijdelijke globalThis-bridges en de oude manifest-entries. Manifest definitief:
bootstrap + ES-module-graph. Daarna abstracties heroverwegen na de reeks migraties: interfaces die
in de praktijk te breed/te smal bleken worden bijgesteld en in de tickets 03/04-antwoorden
gedocumenteerd; dependency-regels nagelopen op overtredingen.

**Blocked by:** 07; 08; 13; 14; 15; 16; 17; 18; 19; 20; 21; 26; 27; 28; 29; 30; 31; 32; 33; 34; 36.
(35 stond hier eerder ook — verwijderd, zie **Bevindingen batch 3** hieronder: 35 hangt van 22 af,
niet andersom.)

**Status:** ready-for-agent — alle overige blockers zijn `resolved`/`done`/`closed`.

**Correctie (2026-08-04):** premise "legacy bestanden bevatten geen productiecode meer"
klopt niet — zie map.md's `## Correcties tijdens uitvoering` voor de volledige inventarisatie
(~2000 regels ongeclaimde productiecode in beide hub-bestanden) en de tickets 26-36 die dat gat
dichten. Deze ticket wordt weer `ready-for-agent` zodra 26-36 landen.

**Scope-afbakening (2026-08-04, tweede ronde):** een eerdere versie van deze correctie zei dat
deze ticket "ongewijzigd blijft", terwijl map.md's voorstellijst 22 juist inperkte tot alleen zijn
titel. Dat is nu beslecht: **22 bezit alleen het slopen** van de vijf dynamic-import-bridges en
`globalThis.GoLensGoNavigation`/`GoLensContent`, de manifest-update en de
dependency-regelverificatie over de hele import-graph. Het **herhuisvesten van het levende gedrag**
dat vandaag nog in `go-navigation.js`'s orkestratielaag zit (`init`/`teardown`/`onKeyDown`/
`runNavigationAction`/`diffObserver`/`refreshMergeRequestRefs`) is ticket 36, niet deze.

**Bevindingen batch 3 (2026-08-04):** 31, 34 en 36's onderzoek (zie hun eigen tickets) wijst hun
resterende implementatiewerk hierheen toe, niet naar een aparte ronde: 31's `reconcilePage`/
`leaveMergeRequestPage`/SPA-detectie-verhuizing naar `page/lifecycle`; 34's aansluiten van
`runNavigationAction`/`reconcileGoTestFileRows`/`legacy.isEnabled` op lifecycle's al-gebouwde
enable-fanout (met de activatie-latch als apart, behouden signaal); 36's volledige
`go-navigation.js`-orkestratieslice (init/teardown/onKeyDown/runNavigationAction/diffObserver/
`__test`-bag-herleiding). 35's vier message-types kunnen pas zonder dubbele responder naar
`bootstrap.js` verhuizen zodra content.js's eigen handler hier verdwijnt. Dit bevestigt 22's
premisse-correctie (zie boven): het "slopen"-werk en het "herhuisvesten van resterend levend
gedrag"-werk zijn in de praktijk niet los te knippen — allebei landen in deze ticket.

**Correctie (2026-08-04, derde ronde):** 35 stond hierboven in 22's eigen blocked-by-lijst, terwijl
35's eigen ticket zegt dat 35 juist op 22 wacht (content.js moet weg vóórdat 35's claim in
bootstrap.js geen dubbele responder wordt). Dat was een cirkel. Opgelost: 35 uit 22's blocked-by
gehaald. 22 is daarmee niet meer geblokkeerd — elke overige blocker staat op `resolved`/`done`/
`closed`.

- [ ] Geen globalThis-contract tussen modules meer; legacy-bestanden verwijderd
- [ ] Manifest bevat alleen bootstrap (+ ongewijzigde externe scripts) en WAR voor `page/*`
- [ ] Dependency-regels (ticket 03 §3) geverifieerd over de hele import-graph
- [ ] Afwijkingen van de 03/04-interfaces gedocumenteerd in die tickets
- [ ] Volledige `npm run check` + browser-smoke groen
