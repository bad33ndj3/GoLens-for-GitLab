# 27 — Platform: gitlab-api

**What to build:** `page/platform/gitlab-api.js`, een ES module met de GitLab REST/GraphQL-laag
uit `go-navigation.js`: `authenticatedFetch`/`fetchWithRetry`/`fetchSource`/`fetchBlob`/
`fetchTreeEntries`/`listPackageFiles`/`listProjectFiles`/`listMergeRequestChangedFiles`/
`searchProjectBlobPaths`/`mergeRequestRefs`/`mergeRequestRefsForFile`/`modulePathFor`/
`sourceRefFor`/`documentationURL`/`projectPackageURL`/`standardLibraryURL`/
`packageDocumentationURL`/`parseBlobLink`/`projectContext`/`mergeRequestIID`/`nextPageNumber`/
`mapLimit`/`mergeRequestHeadRef`/`clearMergeRequestRefs`/`refsDisagreeWithFile`/`sleep`/`dirname`/
`isProjectGoPath`/`normalizePath` (deze laatste zeven ontbraken in de eerdere opsomming; zie
map.md's correctielijst). `mergeRequestHeadRef` (go-navigation.js:1105) is **geen** dode/interne
functie: het is een live `legacy`-capability die `page/features/mr-preload.js:67` vandaag al
aanroept (`legacy.mergeRequestHeadRef()`) — niet als vrijblijvend beschouwen bij het overhevelen.
`createX(deps)`-factory (ticket 04 §2) omdat deze laag stateful caches heeft
(`state.absentSourcePaths`/`state.modulePaths`/`state.refsPromise` e.a.) en tests deterministisch
`fetch`/`clock` moeten kunnen injecteren — zie hoe `platform/rpc-client.js` (09) en
`platform/clock.js` (08) dat al doen. Gedrag exact ongewijzigd (retry-backoff-tijden, paginatie,
caching, foutafhandeling).

**Blocked by:** geen.

**Status:** proposed

- [ ] Retry/backoff-gedrag (`RETRYABLE_STATUS`/`FETCH_RETRY_DELAYS_MS`) exact overgenomen
- [ ] Paginatie (concurrent-bij-bekend-totaal, sequentieel-fallback) exact overgenomen
- [ ] `state.absentSourcePaths`/`state.modulePaths`/`state.refsPromise`-caches functioneel identiek
- [ ] `mergeRequestRefs`'s 15s-cache en `refsDisagreeWithFile`-herfetch-logica behouden
- [ ] `mergeRequestHeadRef`'s ref-cache-reset bij een ongeldige SHA behouden: bij een `headSha`
  die niet aan `COMMIT_SHA` voldoet wordt `state.refsPromise`/`refsKey`/`refsFetchedAt`
  gereset (naar `null`/`''`/`0`) én wordt `Error('Unable to determine the MR head commit.')`
  gegooid — beide helften, niet alleen de reset zonder de throw
- [ ] `go-navigation.js` gebruikt deze module i.p.v. eigen kopieën
- [ ] Unit tests in `tests/platform-gitlab-api.test.js` (fetch geïnjecteerd, geen echte netwerkcalls)
- [ ] `npm run check:syntax` en `npm test` groen
