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

**Status:** resolved (commit d295410)

- [x] Retry/backoff-gedrag (`RETRYABLE_STATUS`/`FETCH_RETRY_DELAYS_MS`) exact overgenomen
- [x] Paginatie (concurrent-bij-bekend-totaal, sequentieel-fallback) exact overgenomen
- [x] `state.absentSourcePaths`/`state.modulePaths`/`state.refsPromise`-caches functioneel identiek
- [x] `mergeRequestRefs`'s 15s-cache en `refsDisagreeWithFile`-herfetch-logica behouden
- [x] `mergeRequestHeadRef`'s ref-cache-reset bij een ongeldige SHA behouden: bij een `headSha`
  die niet aan `COMMIT_SHA` voldoet wordt `state.refsPromise`/`refsKey`/`refsFetchedAt`
  gereset (naar `null`/`''`/`0`) én wordt `Error('Unable to determine the MR head commit.')`
  gegooid — beide helften, niet alleen de reset zonder de throw
- [x] `go-navigation.js` gebruikt deze module i.p.v. eigen kopieën
- [x] Unit tests in `tests/platform-gitlab-api.test.js` (fetch geïnjecteerd, geen echte netwerkcalls)
- [x] `npm run check:syntax` en `npm test` groen

## Resolutie

`page/platform/gitlab-api.js` aangemaakt; `go-navigation.js` roept alles via thin wrappers
achter een dynamic-`import()`-bridge aan (zelfde patroon als ticket 26). Pure helpers zijn
losse named exports, het stateful deel zit in `createGitLabApi(deps)`.

37 unit tests in `tests/platform-gitlab-api.test.js`, waaronder een test die *beide* helften
van `mergeRequestHeadRef`'s reset-en-throw afdwingt (faalt als een van de twee wegvalt).

**Afwijkingen van de ticketletter** (ook vastgelegd in de module-header):

1. `fetch`/`clock`/abort-signal worden **late-bound** geinjecteerd (`getClock`/`getSignal`
   accessors; `fetch` valt per call terug op `globalThis.fetch`) in plaats van als waarden
   gecaptured. Drie bestaande gedragingen eisen dit: tests herschrijven `globalThis.fetch`
   midden in een test, `setClock` wisselt de clock *na* constructie, en `state.abortController`
   wordt bij elke init na teardown vervangen. Een gecapturede waarde zou na een SPA-remount
   een verlopen signal blijven gebruiken.
2. `sleep` staat op de instance, niet als losse export (deelt de geinjecteerde clock).
3. `normalizePath`/`parseBlobLink`/`dirname` blijven byte-identiek gedupliceerd in
   `page/platform/diff-dom.js`. Importeren zou een platform->platform-edge toevoegen puur om
   ~15 regels pure string-afhandeling te ontdubbelen; beide module-headers leggen dit vast.

4. **Nieuw laadvenster tussen IIFE-start en bridge-resolve.** De synchrone wrappers
   (`normalizePath`, `projectContext`, `parseBlobLink`, `mapLimit`, ...) gooien een `TypeError`
   zolang de bridge niet resolvet; de async wrappers await'en hem eerst; teardown-bereikbare
   resets optional-chainen. Alle huidige call-sites van de synchrone groep liggen na de load,
   dus dit is in productie onbereikbaar — maar het is wél een gedragsverschil met vóór 27, en
   `tests/go-navigation-context.test.js` moest er expliciet op wachten
   (`await Promise.all([gitlabApiReady, sourceLoaderReady, toastReady])`).
