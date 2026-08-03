# 16 — Feature-migratie: settings-overlay

**What to build:** De in-page settings-overlay uit `content.js` wordt `features/settings-overlay`
met `mount(ctx) → { unmount, show(), close() }`: overlay-DOM, settings.html-embedding en de
ready-handshake privé; overlay-registry-claim zolang open. Lifecycle routeert
`golens-show-settings`/`golens-close-settings`/`golens-settings-ready` naar de handle.
Legacy-code direct verwijderd.

**Blocked by:** 11 — lifecycle-orchestrator; 12 — overlay-registry.

**Status:** ready-for-agent

- [ ] Openen/sluiten via popup en berichten identiek aan nu, incl. handshake
- [ ] Registry-claim correct over alle open/sluit-paden
- [ ] `unmount()` ruimt DOM en claim volledig op
- [ ] Volledige `npm run check` groen
