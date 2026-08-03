# 14 — Feature-migratie: celebration

**What to build:** De MR-"mascot"-celebration (actie-detectie + discussion/celebration-polling) uit
`content.js` en de bijbehorende statusmethods uit `go-navigation.js` worden
`features/celebration` met `mount(ctx) → { unmount }` — autonoom na mount, pollend via
`rpc.cache`/eigen fetches en de clock. Legacy-code direct verwijderd.

**Blocked by:** 09 — platform/rpc-client; 11 — lifecycle-orchestrator.

**Status:** ready-for-agent

- [ ] Celebratie-gedrag en polling-cadans ongewijzigd
- [ ] `mergeRequestCelebrationStatus`/`mergeRequestDiscussionStatus` niet langer op een globaal contract
- [ ] `unmount()` stopt alle polling; geen timers na teardown
- [ ] Volledige `npm run check` groen
