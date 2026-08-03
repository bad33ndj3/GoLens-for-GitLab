# 19 — Feature-migratie: mr-preload

**What to build:** MR-scoped preloading en full-project-preload uit `go-navigation.js` worden
`features/mr-preload` met de ticket 04 §3-handle (`preloadMergeRequest`/`preloadStatus`/
`preloadFullProject`/`fullProjectStatus`/`invalidateCache`). Kern van de ontvlechting (ticket 02
§6): `planPreload(diffState)` beslist puur welke packages/searches in welke volgorde, de shell
voert het plan uit via `rpc.cache`/`rpc.index`. Statussen `kind`-gediscrimineerd; lifecycle
routeert `golens-preload-full-project`/`golens-full-project-status`. Legacy-code direct verwijderd.

**Blocked by:** 09 — platform/rpc-client; 11 — lifecycle-orchestrator.

**Status:** ready-for-agent

- [ ] Preload-gedrag, volgorde en statusrapportage identiek (perf niet geregresseerd)
- [ ] `planPreload` puur en los getest, gescheiden van uitvoering
- [ ] Statussen met gesloten `kind`-set op de handle
- [ ] Volledige `npm run check` groen
