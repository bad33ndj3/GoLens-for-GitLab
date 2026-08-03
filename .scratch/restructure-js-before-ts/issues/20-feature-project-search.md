# 20 — Feature-migratie: project-search

**What to build:** De "search complete project"-modal uit `go-navigation.js` wordt
`features/project-search` met `mount(ctx) → { unmount, open(), close() }`: modal-DOM, paging en
blob-path-zoeken privé; queries via `rpc.query`, uitkomsten `kind`-gediscrimineerd (incl.
missing/ambiguous). Legacy-code direct verwijderd.

**Blocked by:** 09 — platform/rpc-client; 11 — lifecycle-orchestrator.

**Status:** ready-for-agent

- [ ] Openen (via shortcut/actie), zoeken, paging en sluiten identiek aan nu
- [ ] Abort/cleanup van lopende zoekopdrachten bij `close()`/`unmount()`/navigatie
- [ ] Volledige `npm run check` groen
