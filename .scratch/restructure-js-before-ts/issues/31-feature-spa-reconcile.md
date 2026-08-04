# 31 — SPA reconcile loop

Label: `wayfinder:grilling`
Status: proposed
Assignee: claude
**Blocked by:** 11 — lifecycle-orchestrator

## Question

`content.js`'s pagina-reconciliatie — `reconcilePage`/`leaveMergeRequestPage`, de body-
`MutationObserver`, `turbo:load`/`pjax:end`/`popstate`-listeners, `isGitLab`/`isMergeRequest`/
`mergeRequestPageKey`, en de rapid-diffs-opt-in (`enableRapidDiffs`/`watchForRapidDiffs`) — krijgt
een nieuwe plek. Waar?

Resolve:
- Gaat dit op in `page/lifecycle` (het is arguably al lifecycle's taak — SPA-navigatie detecteren en
  features mounten/unmounten), of wordt het een nieuwe `page/features/mr-page-reconciler.js`?
- Toets tegen ticket 03 §3's afhankelijkheidsregels (`feature → feature` en `feature → lifecycle` zijn
  verboden): welke van de twee opties overtreedt die regels niet?
- Als het antwoord "lifecycle" is: dit ticket raakt dan `page/lifecycle/index.js` rechtstreeks in
  plaats van een nieuwe feature toe te voegen — is dat aanvaardbaar qua scope van ticket 03's module-
  indeling?
- Waar hoort de 50ms reconcile-debounce (`page/platform/clock.js`'s `createLegacyDebounceIdle`,
  ticket 08) dan bij: aangeroepen vanuit lifecycle, of vanuit de gekozen feature-module?

## Answer

*Nog te beantwoorden — aparte ronde, niet in dit ticket.*

---

Ná de beslissing hierboven gelden voor de implementatiefase (aparte ronde/ticket):

- [ ] Ontwerpvraag (lifecycle vs. losse feature) beantwoord en gemotiveerd vóór implementatie
- [ ] Reconcile-debounce (50ms via `page/platform/clock.js`'s `createLegacyDebounceIdle`, ticket 08)
  hergebruikt, niet gedupliceerd
- [ ] SPA-navigatiedetectie (turbo/pjax/popstate/MutationObserver) exact ongewijzigd gedrag
- [ ] Rapid-diffs-opt-in exact ongewijzigd
- [ ] Unit tests in `tests/features-spa-reconcile.test.js` (of lifecycle's eigen test-file als de
  keuze op lifecycle valt)
- [ ] `npm run check:syntax` en `npm test` groen
