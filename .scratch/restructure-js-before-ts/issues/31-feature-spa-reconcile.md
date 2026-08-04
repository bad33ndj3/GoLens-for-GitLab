# 31 — SPA reconcile loop

Label: `wayfinder:grilling`
Status: resolved (ontwerpvraag beantwoord; implementatie hoort bij ticket 22, zie `## Answer`)
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

*(2026-08-04, batch 3)* **`page/lifecycle`, niet een losse feature.** Ticket 03 §2's module-tabel
zegt het al met zoveel woorden: `page/lifecycle` "Owns `reconcilePage`. Not a feature — the
imperative shell that wires features." Getoetst tegen §3's afhankelijkheidsregels: een losse
`mr-page-reconciler.js` feature zou bij elke navigatie de ándere gemounte features moeten
reconcilen — dat is precies de verboden `feature → feature`-rand. Lifecycle is de enige plek die
§3 niet overtreedt. De 50ms-debounce (`createLegacyDebounceIdle`, ticket 08) verhuist mee naar
lifecycle: `lifecycle → platform` is toegestaan.

**Belangrijke precisering, niet zomaar gladstrijken:** lifecycle's huidige SPA-detectie
(`page/lifecycle/index.js`'s `NAV_POLL_MS`-poll op `location.href`) en content.js's huidige
detectie (popstate/`turbo:load`/`pjax:end`/visibilitychange + een body-`MutationObserver`,
gedebouncet op 50ms) zijn **niet hetzelfde mechanisme**. De poll is vandaag ticket 11's inert stub
(zijn eigen commentaar zegt dat met zoveel woorden — bootstrap.js pollt `href` ook al). De
MutationObserver vangt GitLab's in-place diff-re-renders die `href` nooit wijzigen; die dekking
mag niet verdwijnen. Dit ticket's eis "SPA-navigatiedetectie exact ongewijzigd gedrag" betekent dus:
content.js's mechanisme (events + MutationObserver + debounce) is wat overleeft, niet lifecycle's
poll — de poll-implementatie wordt bij implementatie vervangen, niet content.js's detectie
aangepast aan de poll.

**Dit ticket beantwoordt alleen de ontwerpvraag.** Het daadwerkelijk verplaatsen van
`reconcilePage`/`leaveMergeRequestPage`/de listeners uit content.js naar `page/lifecycle` is een
~1300-regels-brede wijziging over twee classic content scripts onder de byte-identiek-gedrag-eis,
en raakt rechtstreeks de vraag "is content.js na deze verplaatsing nog nodig" (ticket 22). Batch
3's ticket 36-onderzoek (zie dat ticket's `## Resultaat`) laat zien dat de vergelijkbare
orkestratieslice van `go-navigation.js` niet los van ticket 22 te verplaatsen is; dezelfde
afhankelijkheid geldt hier. Implementatie hoort daarom bij ticket 22, niet bij een aparte ronde
zoals de checklist hieronder oorspronkelijk veronderstelde.

---

Ná de beslissing hierboven gelden voor de implementatiefase (**ticket 22**, niet een aparte ronde):

- [ ] Ontwerpvraag (lifecycle vs. losse feature) beantwoord en gemotiveerd vóór implementatie
- [ ] Reconcile-debounce (50ms via `page/platform/clock.js`'s `createLegacyDebounceIdle`, ticket 08)
  hergebruikt, niet gedupliceerd
- [ ] SPA-navigatiedetectie (turbo/pjax/popstate/MutationObserver) exact ongewijzigd gedrag
- [ ] Rapid-diffs-opt-in exact ongewijzigd
- [ ] Unit tests in `tests/features-spa-reconcile.test.js` (of lifecycle's eigen test-file als de
  keuze op lifecycle valt)
- [ ] `npm run check:syntax` en `npm test` groen
