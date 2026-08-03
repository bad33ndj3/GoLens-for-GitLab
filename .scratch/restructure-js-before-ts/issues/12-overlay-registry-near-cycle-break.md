# 12 — platform/overlay-registry + near-cycle-break

**What to build:** De `platform/overlay-registry` (interface ticket 04 §2: `claim`/`isAnyOpen`/
`subscribe`) vervangt de DOM-backdoor uit ticket 02 §4: `shortcutCoachBlocked` in
`go-navigation.js` vraagt de registry i.p.v. `#golens-onboarding-root`/`#golens-settings-root` te
lezen. De legacy onboarding-/settings-overlay-code in `content.js` claimt bij openen en released
bij sluiten (via bridge zolang niet gemigreerd). Daarmee is de enige near-cycle uit ticket 02
gebroken vóór de feature-migraties die erop leunen.

**Blocked by:** 11 — lifecycle-orchestrator.

**Status:** ready-for-agent

- [ ] Geen DOM-read van andermans roots meer; suppressiegedrag van de coach-toast ongewijzigd
- [ ] Claims/releases kloppen ook bij SPA-navigatie en overlay-sluiting via alle paden
- [ ] Volledige `npm run check` groen
