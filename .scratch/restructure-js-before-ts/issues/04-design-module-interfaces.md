# 04 — Design small, stable public interfaces for each module

Label: `wayfinder:grilling`
Status: resolved
Assignee: claude
**Blocked by:** 03 — Define target module boundaries and dependency rules

## Question

For each module fixed by ticket 03, what is its public interface — the narrow surface other modules
are allowed to call, deep enough to hide the module's internal complexity?

Resolve, via `/grilling` and `codebase-design`:
- The exported functions/classes per module, their signatures, and what invariants they guarantee.
- What stays private and must not leak (DOM shape, worker message format, cache internals, etc).
- How errors/ambiguous outcomes are represented at each boundary (keep the existing "return missing or
  ambiguous results instead of guessing" contract explicit at the interface, not just in prose).
- Whether any interface needs a prototype (via `/prototype`) to validate feel before committing — flag
  it here rather than deciding blind if a shape is contentious.

## Answer

Resolved via `/grilling` (five decisions, each confirmed by the user), designed with
`codebase-design` against the ticket 02 map and the ticket 03 boundaries. Signatures are JS-shaped
(destructured params, JSDoc-able); they translate 1:1 to TS later.

### 1. Uniform page-module contract

Every page module (features *and* platform services follow the same idiom) exports one factory:

```js
export function mount(ctx) → handle   // features
export function createX(deps) → x     // platform services
```

- `ctx` contains **only** platform services and lifecycle-injected capabilities — a feature never
  constructs its own dependencies (`accept dependencies, don't create them`).
- `handle` = `{ unmount(), ...≤ ~5 feature methods }`. `unmount()` is total: after it returns, the
  module has removed all DOM it created, cancelled timers/inflight work, and released registry
  registrations. Mount after unmount must be safe (SPA navigation).
- Lifecycle is the sole holder of handles; no handle ever crosses into another feature.
- Test surface = the handle plus the module's pure core functions (internal seam, exported from an
  `internal.js` the dependency rules bar other modules from importing).

### 2. Platform service interfaces

```js
// platform/rpc-client — hides: {id,method,params} framing, port lifecycle/reconnect,
// in-flight bookkeeping, the test-only postMessage fallback transport
createRpcClient({ connect }) → {
  query:  { resolveDefinition, resolveHover, findReferences, findImplementations, packageRelations },
  cache:  { cacheStats, projectCacheStatus, mergeRequestCacheStatus, packageCacheStatus,
            prepareSources, clearCache, cachePackage, cacheProject, cacheMergeRequest,
            restorePackage, restoreProject, restoreMergeRequest },
  index:  { indexPackage, indexProject, disposeProject },
  dispose(),
}
// every method: async, params object 1:1 with today's wire params; lifecycle injects only the
// namespaces a feature needs (code-intel: query+cache; mr-preload: cache+index; …)

// platform/settings-store — hides: chrome.storage areas, onChanged plumbing, defaults merging
createSettingsStore() → {
  get(key) → value,                       // sync snapshot after ready()
  ready() → Promise,
  subscribe(key, fn) → unsubscribe,       // fn(newValue); fires on external writes too
  set(key, value) → Promise,              // key-ownership rule from ticket 03 §5 enforced by
}                                          // convention: only the owning module calls set()

// platform/clock — hides: timer scheduling; the one test seam for time
createClock() → { now(), setTimeout(fn, ms) → cancel, debounceIdle(fn, opts) → debounced }
// replaces the duplicated defaultClock/setClock/debounceIdle pair

// platform/overlay-registry — hides: which module has which overlay open (replaces the DOM read)
createOverlayRegistry() → {
  claim(name) → release,                  // onboarding/settings-overlay claim while open
  isAnyOpen() → boolean,                  // keyboard-nav's shortcutCoachBlocked query
  subscribe(fn) → unsubscribe,
}
```

### 3. Feature handles (page)

Mapping of today's 19 `GoLensGoNavigation` methods + content.js features onto handles. Methods not
listed here (the 60+ `__test` exports) become internal-seam exports, not interface.

```js
// lifecycle (not a feature) — hides: page-transition classification, enabled-gating,
// chrome.runtime.onMessage dispatch, mount ordering
start({ platform, features }) → { stop() }
// pure core: classifyPageTransition(url, prev) → kind; routeMessage(msg) → { feature, action }

// features/code-intel — hides: hover/click detection, popover DOM, occurrence highlighting,
// resolution orchestration (absorbs: runNavigationAction's reference actions, showResult)
mount(ctx) → { unmount, setEnabled(bool), navigationAction(name) → boolean /* handled? */ }

// features/project-search — hides: modal DOM, search paging, blob-path search
mount(ctx) → { unmount, open(), close() }

// features/keyboard-nav — hides: hunk/file target computation, key matching, coach hint DOM
mount(ctx) → { unmount, offerShortcutCoach(context) }
// ctx capability: overlays.isAnyOpen() replaces the #golens-*-root DOM read

// features/mr-preload — hides: which packages/searches to preload and in what order
mount(ctx) → { unmount, preloadMergeRequest(mr), preloadStatus() → status,
               preloadFullProject(), fullProjectStatus() → status, invalidateCache() }
// pure core: planPreload(diffState) → [{ packagePath, action }]

// features/bookmarks — hides: anchoring, recovery candidates, drawer DOM, marker reconciliation
mount(ctx) → { unmount, subscribe(fn) → unsubscribe, snapshot() → bookmarks,
               toggleAt(location), reveal(id), remove(id), clear(), recover(id) }
// registerBookmarkSurface/refreshBookmarks fold inside: the module owns its surfaces

// features/onboarding — hides: first-run detection (golensOnboardingVersion), flow DOM
mount(ctx) → { unmount, show() }

// features/settings-overlay — hides: overlay DOM, settings.html embedding, ready-handshake
mount(ctx) → { unmount, show(), close() }

// features/celebration — hides: MR action detection, discussion/celebration polling cadence
mount(ctx) → { unmount }        // fully autonomous once mounted

// features/generated-files — hides: generated-file detection, row hiding, full-file button
mount(ctx) → { unmount }        // reacts to settings.subscribe('hideGeneratedFiles')
```

### 4. Worker interfaces

```js
// worker/dispatch — hides: both transports (port + test-only postMessage) behind one wire
// contract, the mutation queue, rollback-on-error
createDispatcher({ index, sourceCache, hostAccess }) → { handle(request) → Promise<response> }
// pure core: routeMethod(method) → { kind: 'query'|'mutation', validate(params) }

// worker/index-core — GoSemanticIndex, public surface frozen to the dispatch set:
constructor(parser)             // duck-typed parser stays the test seam
indexPackage, indexProject, resolve, findReferences, findImplementations, packageRelations,
hasPackage, hasProject, packageDefinitionCount, searchScope, serializeProject, restoreIndex,
importToPackagePath, disposeProject, clear
// private (underscore, off the interface): _treeFor, _serializePackage, _restorePackageEntry,
// _scopeEntries, _packageCount; the never-populated _implementationCache is deleted (ticket 03 §7)

// worker/source-cache — GoSemanticSourceCache, public surface frozen to the dispatch set:
constructor({ indexedDB })      // injected — the test seam
writePackage, writeProject, stageProject, writeMergeRequest, readPackage, readProject,
readMergeRequest, hasProject, projectStatus, mergeRequestStatus, packageStatus,
packageStatusesFor, prepareSources, stats, clear     (+ standalone isCommitSHA)
// private: readSourceRecords, writeSourceRecords, deleteSourceRecords, readManifest(s),
// writeManifest, validateSourceRecords, stageSnapshotSources, writeSnapshot — these leak
// IndexedDB internals today and lose interface status
```

Invariants stated at the interface, not just in prose: refs must satisfy `isCommitSHA` before any
cache write (commit-pinned guarantee); all mutations serialize through the dispatch queue; per
ticket 03 §7 `restoreMergeRequest` returns completeness in its own result instead of relying on a
later status call.

### 5. Domain outcomes vs failure — on every interface

- Domain outcomes (found / missing / ambiguous / stale / partial / …) are ordinary return values
  with a mandatory `kind` discriminator from a **closed, per-method documented set**. Never `null`,
  never a thrown exception, never a guess — this codifies the existing "return missing or ambiguous
  results instead of guessing" contract. `showResult`'s 11-way branching becomes the documented
  `kind` set of the query methods.
- Rejected promises / exceptions are reserved for infrastructure failure (port gone, IndexedDB
  broken, fetch failed). Feature shells translate those to UI status; they never synthesize a
  domain answer from them.
- Pure core functions are total: they never throw on domain input.

### 6. What must not leak (summary)

DOM shape and element ids (each module owns its DOM; observation only via overlay-registry), the
RPC wire framing and transport duality, `chrome.storage` area/key layout (behind settings-store),
IndexedDB store/manifest/source-record layout (behind source-cache), tree-sitter node shapes
(behind index-core — including the partial fake nodes `_restorePackageEntry` fabricates, a known
gap to narrow during TS typing), and timer scheduling (behind clock).

### 7. Prototype flag

One prototype required before the spec is final, none other: the **dynamic-`import()` bootstrap**
on a real gitlab.com page — verify `bootstrap.js → import(chrome.runtime.getURL(…)) → mount()`
works reliably and fast enough (SPA navigation included) with `web_accessible_resources`, CSP, and
the isolated world. Throwaway per `/prototype`; its answer lands here. If it fails, ticket 03 §6
(module mechanism) reopens — interfaces above are unaffected except the bootstrap entry.

Handles, `ctx`, and `kind`-results are conventional enough to specify on paper; no other prototype.

**Prototype verdict (2026-08-03): PASS — the bootstrap works; the spec is unblocked.** Built by a
sonnet subagent, independently re-run and reviewed. Throwaway code lives on branch
`proto/bootstrap-import` (`experiments/proto-bootstrap-import/`, one command:
`node experiments/proto-bootstrap-import/run.mjs`). Findings, on Chromium 150 (Helium, headless):

1. `import(chrome.runtime.getURL('page/main.js'))` from the isolated world succeeds against a
   strict GitLab-like page CSP (`default-src 'self'; script-src 'self' 'nonce-…'; object-src
   'none'; base-uri 'self'`) — page CSP does not apply to extension-origin module loads.
2. `web_accessible_resources` is **required**: without it the import rejects
   (`TypeError: Failed to fetch dynamically imported module`, `net::ERR_FAILED`). The manifest
   must list `page/*` with the gitlab.com match pattern.
3. Timing: bootstrap-start → completed `mount()` in ~15–29ms at `document_end` — no user-visible
   delay.
4. SPA `pushState` navigation: module graph stays alive; re-mount per navigation works (3/3).
   Caveat: the isolated world does not observe page-world `pushState` directly — lifecycle must
   poll/observe `location.href` (matching today's reconcile approach), not hook `history`.
5. Transitive imports (`page/main.js` → `./platform/clock.js`) resolve correctly.

Not covered (accepted): real gitlab.com login/https and non-Chromium browsers; behavior is
Chromium-level, not page-content-dependent.

### Deviations found during ticket 22 (contract & reassess)

- **Two message types are not "always `kind`-discriminated."** `golens-cache-invalidated` and
  `golens-preload-full-project` route to `page/features/controls.js`'s `invalidatePreloadState`/
  `startFullProjectPreload`, whose return shapes (`{kind:'invalidated'}` and
  `{status, message, progress}` respectively) predate this ticket and are pinned by
  `tests/features-controls.test.js`. `golens-full-project-status` (`refreshFullProjectPreloadStatus`)
  is async and can reject — the one routed action with a failure path beyond "the module didn't
  load." `bootstrap.js`'s `envelopeFor` handles these three positionally (outcome present vs.
  `undefined`) rather than requiring a `.kind` field, preserving content.js's original envelopes
  (`golens-cache-invalidated`/`golens-preload-full-project` were unconditionally `ok:true`) instead
  of reshaping `controls.js`'s existing, tested return values for the message seam's benefit.
- **`bootstrap.js`'s `chrome.runtime.onMessage` listener now awaits its outcome**
  (`await Promise.resolve(handle.dispatch(message))`) before enveloping, to support
  `golens-full-project-status`'s async action. Every other routed action is synchronous, and
  `await` on a non-promise is a no-op microtask — no other route's observable envelope changed.
- **`golens-enabled` is intentionally never claimed by `bootstrap.js`.** content.js's original
  handler for it never called `sendResponse`; `page/lifecycle/internal.js`'s `routeMessage` already
  classifies it as `{kind:'lifecycle', action:'setEnabled'}` (not a feature route), and
  `page/lifecycle/index.js`'s own `settings.subscribe('enabled', …)` fanout applies it. No change
  needed to preserve this — recorded here since ticket 22's brief flagged it as one of the four
  message types needing "a home."
