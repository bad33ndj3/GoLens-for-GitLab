# 34 — Eigenaar voor de afgeleide enable/disable-fanout

Label: `wayfinder:grilling`
Status: proposed
Assignee: claude
**Blocked by:** 10 — platform/settings-store; 11 — lifecycle-orchestrator

## Question

Vandaag bestaan er twee losse `state.enabled`-vlaggen (één in `go-navigation.js`, één in
`content.js`), beide echte gates (`runNavigationAction`, `reconcileGoTestFileRows`, de
`legacy.isEnabled`-capabilities die bookmarks.js/project-search.js injecteren). "Één eigenaar per
`chrome.storage`-key" (ticket 03) dekt de opslag-key zelf via `settings-store.js` (10), maar niet wie
de **afgeleide** aan/uit-fanout naar features aanstuurt zodra beide legacy-vlaggen weg zijn.

Resolve:
- Wie is eigenaar van de afgeleide enable/disable-fanout? Vermoeden: `settings-store`'s
  `subscribe('enabled', …)` die via `page/lifecycle` naar elke gemounte feature fan-out — maar is dat
  ook de beslissing, en waarom?
- Hoe wordt elke huidige `state.enabled`-afhankelijke gate (`runNavigationAction`,
  `reconcileGoTestFileRows`, `legacy.isEnabled`-capabilities) op de nieuwe eigenaar aangesloten, zonder
  gedragsverschil?
- Hoe wordt geborgd dat er geen twee losse vlaggen meer kunnen bestaan die uit sync raken?

## Answer

*Nog te beantwoorden — aparte ronde, niet in dit ticket.*

---

Ná de beslissing hierboven gelden voor de implementatiefase (aparte ronde/ticket):

- [ ] Eigenaar van de afgeleide enable/disable-fanout gekozen en gemotiveerd
- [ ] Elke huidige `state.enabled`-afhankelijke gate (navigatie-acties, go-test-file-rows,
  `legacy.isEnabled`-capabilities) werkt via de nieuwe eigenaar, gedrag ongewijzigd
- [ ] Geen twee losse vlaggen meer die uit sync kunnen raken
- [ ] `npm run check:syntax` en `npm test` groen
