# 15 — Feature-migratie: onboarding

**What to build:** De first-run-flow uit `content.js` wordt `features/onboarding` met
`mount(ctx) → { unmount, show() }`: first-run-detectie (`golensOnboardingVersion`), flow-DOM,
opslaan van keuzes via de settings-store, en een overlay-registry-claim zolang hij open staat.
Lifecycle routeert het `golens-show-onboarding`-bericht naar de handle. Legacy-code direct
verwijderd.

**Blocked by:** 10 — platform/settings-store; 11 — lifecycle-orchestrator; 12 — overlay-registry.

**Status:** ready-for-agent

- [ ] First-run en handmatig openen gedragen zich identiek; keuzes landen op dezelfde keys
- [ ] Registry-claim actief zolang open; coach-suppressie blijft werken
- [ ] `unmount()`/sluiten ruimt DOM en claim volledig op
- [ ] Volledige `npm run check` groen
