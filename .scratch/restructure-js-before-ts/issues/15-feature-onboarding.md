# 15 — Feature-migratie: onboarding

**What to build:** De first-run-flow uit `content.js` wordt `features/onboarding` met
`mount(ctx) → { unmount, show() }`: first-run-detectie (`golensOnboardingVersion`), flow-DOM,
opslaan van keuzes via de settings-store, en een overlay-registry-claim zolang hij open staat.
Lifecycle routeert het `golens-show-onboarding`-bericht naar de handle. Legacy-code direct
verwijderd.

**Blocked by:** 10 — platform/settings-store; 11 — lifecycle-orchestrator; 12 — overlay-registry.

**Status:** resolved

- [x] First-run en handmatig openen gedragen zich identiek; keuzes landen op dezelfde keys —
      beide gaan door één `open(mode)`-pad (host, markup, claim, wiring); `overlays.claim('onboarding')`
      en `release?.()` komen elk precies één keer voor in `page/features/onboarding.js`.
- [x] Registry-claim actief zolang open; coach-suppressie blijft werken — ongewijzigd, want
      `go-navigation.js`'s `shortcutCoachBlocked()` leest alleen `isAnyOpen()`, naam-onafhankelijk.
- [x] `unmount()`/sluiten ruimt DOM en claim volledig op
- [x] Volledige `npm run check` groen

Uitgevoerd: `page/features/onboarding.js` + `onboarding.internal.js`, geregistreerd in
`page/main.js`. `bootstrap.js` beantwoordt nu ook `golens-show-onboarding`
(`RESPONDED_TYPES`/`envelopeFor`, mirror van ticket 16). Legacy code (closeOnboarding,
onboardingFeatureIcon, showSetupOnboarding, showOnboarding, showFirstRunOnboarding, de
overlay-registry-bridge en de twee message-handlers) verwijderd uit `content.js`.
`tests/content-onboarding.test.js` hernoemd naar `tests/content-page-controls.test.js` met
alleen content.js's resterende gedrag plus regressie-pins dat content.js onboarding niet meer
bouwt/beantwoordt; onboarding's eigen dekking zit in `tests/features-onboarding.test.js` en
`tests/onboarding-internal.test.js`.
