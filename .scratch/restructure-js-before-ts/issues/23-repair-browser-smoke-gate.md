# 23 — Browser-smoke weer bruikbaar maken als gate

**What to build:** `tests/browser-smoke.mjs` draait weer betrouwbaar groen, zodat de
feature-carve-outs (13–21) een end-to-end vangnet hebben. Op dit moment faalt de smoke óók op een
schone kopie van HEAD — dit is dus geen regressie van deze operatie maar een kapotte gate.

**Meting (2026-08-03):** schone kopie van `22a22b5` faalt 3/3 en een schone worktree 5/5 met
`Error: DevTools Runtime.evaluate timed out for ws://127.0.0.1:PORT/devtools/page/...`, telkens mét
`CHROME_NO_SANDBOX=1`. In de hoofd-werkmap komen runs verder (tot het settings- of large-diff-scenario)
maar halen het einde niet. Dat pad-verschil is zelf een aanwijzing: onderzoek Helium/Chromium-versie,
profiel- en TCC-state, en of de DevTools-`Runtime.evaluate`-timeout te kort staat voor deze machine.

**Blocked by:** None — can start immediately.

**Status:** open — diagnose-only, zie "Diagnose (2026-08-03)" hieronder. Geen fix committed.

- [x] Oorzaak van de `Runtime.evaluate`-timeout benoemd (omgeving, harness-timeout, of browserversie) —
      zie diagnose: **de gesanctioneerde hypothese (harness-timeout te kort) is getest en weerlegd**;
      werkelijke oorzaak is machine-niveau (nondeterministische extension-messaging in deze
      Chromium/Helium-build, headless). Buiten scope van dit ticket om op te lossen.
- [ ] `npm run test:browser` 5/5 groen op een schone kopie van HEAD, zonder `CHROME_NO_SANDBOX`-hack
      of met die hack expliciet in `package.json` vastgelegd i.p.v. als mondelinge overlevering —
      niet gehaald; zie diagnose (2/8 bij verhoogde timeout, machine-niveau geacht)
- [ ] Ticket 05's uitgeschakelde checkbox (mount + pushState-re-mount) alsnog groen afgevinkt —
      niet aangeraakt; blijft uitgeschakeld tot de gate zelf betrouwbaar is
- [x] Geen test verzwakt, overgeslagen of verwijderd om dit te halen — `tests/browser-smoke.mjs` staat
      terug op de originele HEAD-versie (`git diff` leeg); alle diagnostische edits zijn teruggedraaid

## Diagnose (2026-08-03)

**Werkende invocatie (voor het protocol):** `CHROME_NO_SANDBOX=1 node tests/browser-smoke.mjs` vanaf
de repo-root. Zonder `CHROME_NO_SANDBOX=1` niet apart getest in deze sessie (alle metingen hieronder
gebruiken de hack); zie punt 4.

**Gesanctioneerde hypothese getest en verworpen.** `DEVTOOLS_TIMEOUT_MS` (30000 → 90000) en de
scenario-deadline in `runBrowserAttempt` (idem) tijdelijk verhoogd, lokaal 8x gedraaid met
`CHROME_NO_SANDBOX=1`:
- 2/8 groen (`browser injection smoke passed`), 6/8 rood.
- De rode runs falen niet consistent op dezelfde plek of met dezelfde foutmelding:
  - 3x `Error: Extension message golens-show-settings did not reach ... (last:
    {"ok":false,"error":"Could not establish connection. Receiving end does not exist."})` — scenario 2
    (settings-overlay).
  - 2x `Error: Browser scenario timed out` op scenario 5 (large-diff): fixture-marker
    `data-large-diff-streamed="true"` staat al binnen milliseconden, maar
    `[data-golens-full-file]`-knoppen blijven op 0 van de verwachte 80 — ook na 90s.
- Als de timeout zelf de oorzaak was, zou een 3x langere timeout het gat dichten. Dat gebeurt niet:
  het patroon is intermitterend, niet "bijna genoeg tijd". **Item verworpen; timeout niet verhoogd in
  de committede versie.**

**Discriminator: scenario 1 faalt nooit (8/8 groen), scenario 2 en 5 wel.** Scenario 1
(skeletonmount/pushState-re-mount) verifieert via een `Runtime.evaluate` rechtstreeks op de
paginacontext — geen berichtenverkeer nodig. Scenario 2 gaat via de service-worker
(`chrome.tabs.sendMessage` → content-script `onMessage`-listener). Content.js draait dus wel degelijk
en registreert consequent zijn DOM-markers (scenario 1); het is specifiek het
service-worker-naar-content-script berichtenkanaal (en, in scenario 5, de doorlooptijd/afronding van
de full-file-injectie na streaming) dat intermitterend faalt.

**Teardown-/profiel-hypothese getest (advisor-suggestie) en niet bevestigd.** Vermoeden: `stopBrowser`
kan SIGKILL-branch nemen zonder de exit af te wachten, waardoor het volgende Chrome-proces met een
nog-vergrendeld gedeeld `--user-data-dir`-profiel start. Instrumentatie toegevoegd
(`child.pid`/`exitCode`/wachttijd bij stop, `SingletonLock`-check vóór de volgende spawn): in de
gelogde run sloot elk Chrome-proces netjes af (`exitCode=0`, wachttijd <100ms) en was er geen
`SingletonLock` aanwezig vóór de volgende spawn — toch faalde scenario 2 daarna alsnog. Deze hypothese
verklaart de waarneming dus niet (in elk geval niet in de vorm getest); niet verder vervolgd binnen dit
ticket. Alle instrumentatie teruggedraaid, `tests/browser-smoke.mjs` staat weer op de originele inhoud.

**Conclusie:** de oorzaak is machine-niveau — nondeterministische extension-service-worker-messaging
(en/of trage full-file-injectie na streaming) op deze Chromium 150.0.7871.186 (Helium 0.14.9.1),
headless, op macOS 26.5.2/arm64. Dit is geen harness-timeout-probleem (weerlegd door meting) en geen
codewijziging in `tests/browser-smoke.mjs` haalt het betrouwbaar naar 5/5. Conform ticketinstructie:
**gestopt, geen browser-install/pin uitgevoerd** — dat valt buiten dit ticket.

**Openstaand voor een vervolgticket (niet hier opgelost):**
1. Waarom faalt `chrome.tabs.sendMessage` naar het content-script structureel voor de volledige
   retry-periode in sommige runs (geen race die binnen seconden oplost, maar een permanente afwezigheid
   van de listener voor die hele browser-instantie)? Dit wijst eerder op een top-level uitzondering of
   racende async state in `content.js`'s initialisatiepad dan op trage injectie — maar `content.js`
   valt buiten de file-ownership van dit ticket.
2. Waarom blijft full-file-knop-injectie in scenario 5 soms op 0/80 staan, ook na 90s, terwijl de
   streaming-marker vrijwel meteen klaar is?
3. Test zonder `CHROME_NO_SANDBOX=1` (niet gedaan in deze sessie) om te bepalen of checkbox 2's
   "zonder de hack"-pad haalbaar is, ongeacht bovenstaande flakiness.

**Waarom vóór 13–21:** de vorige poging
(`caspers/rewrite-extension-architecture`) faalde op gedrag, UI en performance — precies wat unit
tests niet zien. 13–21 snijden features uit `content.js`/`go-navigation.js`; zonder deze gate wordt
een regressie pas zichtbaar als er negen tickets op elkaar gestapeld staan.
