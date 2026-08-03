# 07 — Worker: surfaces trimmen + dispatch splitsen

**What to build:** De worker-trio krijgt zijn ticket 04 §4-interfaces: `GoSemanticIndex` en
`GoSemanticSourceCache` publiek getrimd tot de dispatch-set (de ~10 source-record/manifest/
snapshot-helpers van de cache worden underscore-privé), en `performDispatch` gesplitst in pure
method-routing versus persist/rollback-shell (functional core / imperative shell, ticket 03 §4).
Tegelijk de wire-verbetering uit ticket 03 §7: `restoreMergeRequest` geeft compleetheid direct in
zijn eigen RPC-resultaat terug; de caller in `go-navigation.js` gebruikt dat i.p.v. een extra
status-roundtrip. Invarianten expliciet op de interface: refs commit-pinned (`isCommitSHA`) vóór
elke cache-write; mutaties serialiseren door de dispatch-queue.

**Blocked by:** 06 — Worker-opruiming (zelfde bestanden).

**Status:** resolved

- [x] Publieke method-lijsten exact conform ticket 04 §4; rest underscore-privé — `go-semantic-core.js`
      was already compliant (no change needed: all 15 §4 public methods present, `_treeFor`/
      `_serializePackage`/`_restorePackageEntry`/`_scopeEntries`/`_packageCount` already underscored,
      `_implementationCache` already gone). `go-semantic-cache.js`'s 11 snapshot/manifest/source-record
      helpers (`readSourceRecords`, `writeSourceRecords`, `deleteSourceRecords`, `readManifest`,
      `readManifests`, `writeManifest`, `validateSourceRecords`, `stageSnapshotSources`, `writeSnapshot`,
      `readSnapshot`, `hasSnapshot`) are now underscore-prefixed instance methods; every internal call
      site and the one test that measured storage-call counts via monkey-patch
      (`tests/go-semantic-cache.test.js`) were repointed to the new names.
- [x] Routing puur en los testbaar; effecten in de shell; beide RPC-transports achter één contract —
      extracted pure `routeMethod(method)` (exported from `go-semantic-worker.js`) that replaces the
      `NON_QUEUED_METHODS`/`MUTATING_METHODS` checks inline in `dispatch`; it takes only a method name,
      does no I/O, and is unit-tested directly (3 new tests in `tests/go-semantic-worker.test.js`).
      `performDispatch` is now documented as the imperative shell (persistence, `isCommitSHA` shortcuts,
      `cacheProject`'s disposeProject-on-failure rollback) and is unchanged in behaviour. Both transports
      (port + `self` postMessage fallback) now go through one shared `handleRpcRequest` helper for the
      `{id, ok, result|error}` envelope instead of duplicating it.
- [ ] `restoreMergeRequest`-resultaat bevat compleetheid; caller doet geen extra status-call meer — **not
      done, and not safe to do under this ticket's hard rules.** Verified: neither `findReferencesAt` nor
      `findImplementationsAt` (the only two `go-navigation.js` call sites) make any follow-up
      `mergeRequestCacheStatus`/`projectCacheStatus` call today — ticket 02 §4's "later, separate RPC
      call" premise does not hold in the current tree, so there is no roundtrip left to remove from the
      caller. Adding a completeness field to the wire result itself is blocked by two of this ticket's own
      hard rules: "wire payloads must not change", and the assertion-immutability rule only permits
      repointing private→public, not extending `assert.deepEqual` literals such as
      `tests/go-semantic-worker.test.js:296-298` and `:317-320`. Flagging as the one unresolved item
      rather than silently ticking it or reinterpreting the hard rules.
- [ ] Volledige `npm run check` groen; worker-tests testen via de publieke interface — `npm test` is green
      for every file this ticket owns (all worker/cache/core tests pass, including the 3 new `routeMethod`
      tests); `npm run check:syntax` passes. One unrelated pre-existing failure
      (`tests/content-onboarding.test.js`) and the `CHROME_NO_SANDBOX=1 npm run test:browser` failure
      (`golens-show-settings did not reach ...`) both trace to `content.js`/`page/`/`manifest.json`, which
      this ticket explicitly does not own and which another agent has in-flight, uncommitted changes to
      (confirmed via `git status`: only `go-semantic-cache.js`, `go-semantic-worker.js`, and the tests
      listed above are this session's changes). Leaving unticked since `npm run check` is not fully green
      right now, though the failures are outside this ticket's scope.
