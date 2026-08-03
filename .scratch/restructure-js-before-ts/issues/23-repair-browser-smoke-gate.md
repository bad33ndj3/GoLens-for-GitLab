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

**Status:** open

- [ ] Oorzaak van de `Runtime.evaluate`-timeout benoemd (omgeving, harness-timeout, of browserversie)
- [ ] `npm run test:browser` 5/5 groen op een schone kopie van HEAD, zonder `CHROME_NO_SANDBOX`-hack
      of met die hack expliciet in `package.json` vastgelegd i.p.v. als mondelinge overlevering
- [ ] Ticket 05's uitgeschakelde checkbox (mount + pushState-re-mount) alsnog groen afgevinkt
- [ ] Geen test verzwakt, overgeslagen of verwijderd om dit te halen

**Waarom vóór 13–21:** de vorige poging
(`caspers/rewrite-extension-architecture`) faalde op gedrag, UI en performance — precies wat unit
tests niet zien. 13–21 snijden features uit `content.js`/`go-navigation.js`; zonder deze gate wordt
een regressie pas zichtbaar als er negen tickets op elkaar gestapeld staan.
