# 25 — README en AGENTS hervalideren na de herstructurering

**What to build:** `README.md`, `AGENTS.md` en de docs waar ticket 01 al doorheen ging
(`docs/agents/*`, `domain.md`) kloppen weer met de code zoals die er ná deze operatie uitziet.
Ticket 01 valideerde ze tegen de oude structuur; sindsdien zijn `bootstrap.js`, `page/lifecycle/`,
`page/platform/` en de feature-modules erbij gekomen en zijn `content.js` en `go-navigation.js`
uitgekleed.

**Blocked by:** 22 — draait pas als alle capability-migraties binnen zijn.

**Status:** open

- [ ] Beschreven bestandslayout in README/AGENTS/`domain.md` komt overeen met de werkelijke boom
      (inclusief `page/`, `bootstrap.js`, en welke bestanden nog legacy zijn)
- [ ] Alle genoemde npm-scripts bestaan nog en doen wat er staat (`test`, `test:browser`, `bench`,
      `check`, `check:syntax`, `package`, `release`)
- [ ] De dependency-regels uit ticket 03 (feature↛feature, feature↛lifecycle, geen `globalThis`)
      staan ergens waar een volgende bijdrager ze vindt, niet alleen in `.scratch/`
- [ ] Elke claim daadwerkelijk geverifieerd tegen de code, niet overgeschreven uit een ticket —
      in deze operatie bleken drie analyse-claims feitelijk onjuist (zie `map.md`)
