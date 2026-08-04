# 34 — Eigenaar voor de afgeleide enable/disable-fanout

Label: `wayfinder:grilling`
Status: resolved (ontwerpvraag beantwoord; aansluiten van legacy-gates hoort bij ticket 22, zie `## Answer`)
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

*(2026-08-04, batch 3)* **`settings-store`'s `subscribe('enabled', …)`, uitgevoerd door
`page/lifecycle`, is al gebouwd en is de eigenaar** — `page/lifecycle/index.js:54-70`:
`platform.settings.ready()` → `applyEnabled(settings.get('enabled'))` →
`settings.subscribe('enabled', applyEnabled)` → elke gemounte feature's `handle.setEnabled?.(…)`,
met een commentaar dat al citeert "lifecycle owns the `enabled` key (ticket 03 §5)". Dit ticket
bekrachtigt dat bestaande patroon als hét antwoord; er is geen nieuw mechanisme nodig.

**Precisering 1 — de fanout is vandaag alleen écht voor de volledig-gemigreerde features.** Voor
`generated-files`/`settings-overlay`/`onboarding`/`keyboard-nav`/`celebration`/
`discussion-line-link`/`go-test-file-rows` raakt `applyEnabled` de werkende instantie. Voor de vijf
zelf-gebrugde features (`mr-preload`/`project-search`/`bookmarks`/`code-intel`/`controls`) mount
`page/main.js` alleen de **inerte** tweede instantie (geen `ctx.legacy`) — daar is de fanout een
no-op op een instantie die toch al niets doet. De écht werkende instanties van die vijf leven nog
in `go-navigation.js`/`content.js` en volgen hun eigen gate (zie precisering 2). Dat gat sluit pas
zodra die bestanden verdwijnen (ticket 22/36).

**Precisering 2 — "twee losse `state.enabled`-vlaggen" is niet accuraat; het zijn twee
verschillende dingen.** `content.js`'s `state.enabled` ís de gebruikersinstelling (gezet in
`setEnabled()`, gesynchroniseerd met `settingsStore.subscribe('enabled', …)`). Maar
`go-navigation.js`'s `state.enabled` (regel ~546) is géén kopie van die instelling — het is een
**activatie-latch**: alleen gezet door `init()` (true) en `teardown()` (false), en gelezen door
`runNavigationAction()`'s gate en de `isEnabled: () => state.enabled`-capability die naar
`project-search.js`/`bookmarks.js` gaat. Het antwoordt op "is go-navigation live gemount op déze
MR-pagina", niet op "staat de instelling aan". Beide vlaggen zomaar samenvoegen tot vermogen van
één eigenaar zou `runNavigationAction`'s gate laten verschuiven van "actief op een MR-pagina" naar
"instelling staat aan" — dat is een gedragsverandering, en dit ticket eist expliciet "gedrag
ongewijzigd". De juiste vervolgstap (niet dit ticket, zie hieronder) is: de instelling krijgt één
eigenaar (lifecycle, al gebouwd); de activatie-latch blijft een apart, afgeleid signaal
("is de feature momenteel actief"), eigendom van wie `init`/`teardown`'s gedrag overneemt —
ticket 36's onderzoek wijst dat toe aan diezelfde plek als 36 zelf landt (ticket 22).

**Dit ticket beantwoordt alleen de ontwerpvraag; er verandert geen code.** Het daadwerkelijk
aansluiten van `runNavigationAction`/`reconcileGoTestFileRows`/de `legacy.isEnabled`-capabilities
op deze eigenaar kan pas zonder gedragsverschil zodra `go-navigation.js`/`content.js` (met hun
eigen concurrerende vlaggen) verdwijnen — dat is ticket 22, samen met 36's orkestratieslice.

---

Ná de beslissing hierboven gelden voor de implementatiefase (**ticket 22**, niet een aparte ronde):

- [x] Eigenaar van de afgeleide enable/disable-fanout gekozen en gemotiveerd
- [ ] Elke huidige `state.enabled`-afhankelijke gate (navigatie-acties, go-test-file-rows,
  `legacy.isEnabled`-capabilities) werkt via de nieuwe eigenaar, gedrag ongewijzigd
- [ ] Geen twee losse vlaggen meer die uit sync kunnen raken (activatie-latch blijft een apart
  signaal, zie precisering 2 — "geen twee vlaggen" geldt voor de *instelling*, niet voor elk
  afgeleid signaal)
- [ ] `npm run check:syntax` en `npm test` groen
