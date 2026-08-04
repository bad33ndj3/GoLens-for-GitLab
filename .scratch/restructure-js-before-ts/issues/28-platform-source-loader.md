# 28 — Platform: source-loader

**What to build:** `page/platform/source-loader.js`: `loadPackage`/`loadProject` en hun
cache-orchestratie (`state.packages`/`state.projects`/`state.projectProgressListeners`) uit
`go-navigation.js`, inclusief `packageLoadingProgress`/`packageLoadingMessage`/
`projectLoadingProgress`/`projectLoadingMessage` en de `status()`-functie die het
`golens-go-status` CustomEvent dispatcht. **Dit event is live** (`tests/browser-smoke.mjs:268`
en `:445` luisteren erop, zie map.md's correctielijst) — niet als dood beschouwen. `createX(deps)`
neemt `workerRPC` (uit `rpc-client.js`, 09) en de `gitlab-api.js`-functies (27) als dependency in
plaats van ze zelf te importeren, zodat tests ze kunnen stubben.

**Blocked by:** 09 — platform/rpc-client; 27 — platform/gitlab-api.

**Status:** proposed

- [ ] `loadPackage`/`loadProject`'s caching (per-key promise, project-key kortsluit-check),
  voortgangsrapportage en `golens-go-status`-dispatch exact ongewijzigd
- [ ] `go-navigation.js` gebruikt deze module i.p.v. eigen kopieën
- [ ] Unit tests in `tests/platform-source-loader.test.js`
- [ ] `npm run check:syntax` en `npm test` groen; browser-smoke solo groen (event-contract)
