(() => {
  // GO_FILE/COMMIT_SHA/GO_DOCS_VERSION moved to page/platform/gitlab-api.js
  // (ticket 27) along with their last remaining readers; nothing in this
  // file matches paths, commit SHAs, or builds pkg.go.dev URLs any more.

  // Injectable time source for throttle/debounce so tests are deterministic
  // and don't sleep. `setClock` (test-only) swaps parts of it; `resetClock`
  // restores the real implementations.
  function defaultClock() {
    return {
      setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
      clearTimeout: (id) => globalThis.clearTimeout(id),
      requestFrame: (fn) => (globalThis.requestAnimationFrame ? globalThis.requestAnimationFrame(fn) : globalThis.setTimeout(fn, 16)),
      requestIdle: (fn) => (globalThis.requestIdleCallback ? globalThis.requestIdleCallback(fn, { timeout: 300 }) : globalThis.setTimeout(fn, 0)),
    };
  }
  let clock = defaultClock();
  function setClock(overrides) {
    clock = overrides ? { ...defaultClock(), ...overrides } : defaultClock();
  }

  // Bridge onto page/platform/diff-dom.js (ticket 26): the diff-DOM
  // primitives (diffFileRoots/diffRootFor/rapidFileData/computeFileContext/
  // fileContextFor/codeCellFor/lineFromAnchor/lineAnchorFor/
  // expansionDirectionForLine/waitForDiffUpdate/revealLine/
  // visibleDiffRootForDefinition/flashDestination/navigateToLocation/
  // lineContextFor) and `fileContextFor`'s generation-keyed cache used to be
  // defined directly in this file and handed to all four `legacy` bags
  // below. They now live in that module; this file keeps same-named thin
  // wrappers so no `legacy` bag entry, `__test` key, or call site had to
  // change. The wrappers exist because this file is still a *classic*
  // content script: `import()` is the only way in and it cannot resolve at
  // top level, so the primitives cannot be plain imported bindings until
  // ticket 22 removes this file. Same dynamic-`import()` bridge and
  // IIFE-top-level kickoff as the feature bridges below.
  //
  // Every wrapper below is only ever reached from an event handler, a
  // runtime message, or a mounted feature's `legacy` bag — all of them long
  // after this sub-30ms load resolves (ticket 04 §7's measurement). The one
  // exception is `bumpFileContextGeneration()`, called synchronously from
  // `init()`'s diff observer: it is optional-chained because a bump that
  // lands before the module loads is a no-op on an empty cache — nothing can
  // be cached until a `fileContextFor` call succeeds, which itself requires
  // the module.
  //
  // `dirname`/`normalizePath`/`parseBlobLink` are now wrappers onto
  // page/platform/gitlab-api.js (ticket 27), which owns this file's copies.
  // diff-dom.js deliberately keeps its own private copies rather than
  // importing them from there — see its header for why that platform→
  // platform edge was not worth ~15 lines of pure string handling.
  async function loadDiffDomModule() {
    try {
      return await import(chrome.runtime.getURL('page/platform/diff-dom.js'));
    } catch {
      return await import('./page/platform/diff-dom.js');
    }
  }
  let diffDom = null;
  // Exposed via __test.diffDomReady so tests and benchmarks can
  // deterministically await the load instead of racing it; production code
  // never awaits this itself.
  const diffDomReady = loadDiffDomModule()
    .then((mod) => {
      diffDom = mod;
    })
    .catch(() => {
      // Both the chrome.runtime.getURL and relative import fallbacks failed
      // (should not happen in production). The wrappers below then throw on
      // the null module rather than silently answering "no diff here", which
      // would look to every feature like a page without a diff.
    });

  // Bridge onto page/platform/gitlab-api.js (ticket 27),
  // page/platform/source-loader.js (ticket 28) and page/platform/toast.js
  // (ticket 29). Same dynamic-`import()` shape and IIFE-top-level kickoff as
  // the diff-dom bridge above, for the same reason: this file is still a
  // classic content script and cannot use top-level `import`.
  //
  // Three notes specific to these three:
  //
  // 1. **source-loader's deps are this file's own wrappers, not the
  //    gitlab-api module object.** The two imports are independent promises
  //    with no ordering guarantee; going through the wrappers (which await
  //    their own module) means neither bridge has to wait for the other.
  //
  // 2. **`status()` stays in this file** and is injected into the loader.
  //    `init()` dispatches `golens-go-status` synchronously, so a dispatcher
  //    living behind this import would drop that first `idle` event — and
  //    `tests/browser-smoke.mjs:268`/`:445` depend on this event. See
  //    source-loader.js's header for the full rationale.
  //
  // 3. **The async wrappers `await` their module; the synchronous ones do
  //    not** and will throw if reached before the import resolves. Every
  //    synchronous call site is an event handler, a mounted feature's
  //    `legacy` bag, or a test that awaits the matching `__test` ready
  //    promise — all of them long after this sub-30ms load. The exception is
  //    `teardown()`, which can genuinely run early and therefore
  //    optional-chains every reset call below.
  async function loadGitLabApiModule() {
    try {
      return await import(chrome.runtime.getURL('page/platform/gitlab-api.js'));
    } catch {
      return await import('./page/platform/gitlab-api.js');
    }
  }
  async function loadSourceLoaderModule() {
    try {
      return await import(chrome.runtime.getURL('page/platform/source-loader.js'));
    } catch {
      return await import('./page/platform/source-loader.js');
    }
  }
  async function loadToastModule() {
    try {
      return await import(chrome.runtime.getURL('page/platform/toast.js'));
    } catch {
      return await import('./page/platform/toast.js');
    }
  }

  let gitlabApiModule = null;
  let gitlabApi = null;
  // Exposed via __test.gitlabApiReady (and the two below it) so tests can
  // deterministically await the load instead of racing it; production code
  // never awaits these itself.
  const gitlabApiReady = loadGitLabApiModule()
    .then((mod) => {
      gitlabApiModule = mod;
      gitlabApi = mod.createGitLabApi({
        // `fetch` is deliberately not passed: the module's default already
        // reads `globalThis.fetch` per call, which is what tests reassign.
        getClock: () => clock,
        getSignal: () => state.abortController?.signal,
      });
    })
    .catch(() => {
      // Both the chrome.runtime.getURL and relative import fallbacks failed
      // (should not happen in production). The wrappers below then throw on
      // the null module rather than silently reporting "no such file" —
      // same failure stance as the diff-dom bridge above.
    });

  let sourceLoaderModule = null;
  let sourceLoader = null;
  // Chained behind `gitlabApiReady`, not raced with it: the deps handed to
  // `createSourceLoader` below include this file's *synchronous* wrappers
  // (`projectContext`, `mapLimit`), which dereference `gitlabApiModule`
  // directly. If this bridge won the race, the first `loadPackage()` — which
  // only awaits `sourceLoaderReady` — would throw on a null module.
  const sourceLoaderReady = Promise.all([gitlabApiReady, loadSourceLoaderModule()])
    .then(([, mod]) => {
      sourceLoaderModule = mod;
      sourceLoader = mod.createSourceLoader({
        workerRPC,
        status,
        projectContext,
        listPackageFiles,
        listProjectFiles,
        fetchBlob,
        modulePathFor,
        mapLimit,
      });
    })
    .catch(() => {
      // Same stance as the gitlab-api bridge above: `sourceLoader` stays null
      // and the wrappers throw on it rather than silently reporting "nothing
      // to load".
    });

  let toastSurface = null;
  const toastReady = loadToastModule()
    .then((mod) => {
      toastSurface = mod.createToast();
    })
    .catch(() => {
      // Deliberately the *other* stance from the two bridges above: every
      // toast wrapper optional-chains, so a failed load costs the user their
      // toasts and nothing else. A toast is never load-bearing — throwing
      // here would take down the navigation action that wanted to show one.
    });

  // Bridge onto page/features/keyboard-nav.js (ticket 17): the shortcut
  // coach's blocked-check, message-for-action decision, and hint DOM
  // trigger used to be this file's own shortcutCoachBlocked()/
  // SHORTCUT_COACH_MESSAGES/offerShortcutCoach(). This file's
  // showShortcutCoachHint() stays (the `.toast` element is this file's own
  // shadow host), reached back through keyboard-nav.js's injected
  // `legacyToast.shortcutHint` capability — but the *decision* of whether
  // and what to show now lives in keyboard-nav.js, and this file's three
  // remaining offerShortcutCoach() call sites (historyBack, nextOccurrence,
  // semanticJump — none of them keyboard-nav's own hunk/file actions) need
  // to reach it. Same dynamic-`import()` bridge and IIFE-top-level kickoff
  // as the bridges above; `offerShortcutCoach` below keeps its original
  // name and fire-and-forget shape so none of those three call sites (or
  // the public `offerShortcutCoach` export other legacy code may still
  // reach) had to change.
  async function loadKeyboardNavModule() {
    try {
      return await import(chrome.runtime.getURL('page/features/keyboard-nav.js'));
    } catch {
      return await import('./page/features/keyboard-nav.js');
    }
  }
  let keyboardNavModule = null;
  // Exposed via __test.keyboardNavReady so tests can deterministically await
  // the load instead of racing it; production code never awaits this itself.
  const keyboardNavReady = loadKeyboardNavModule()
    .then((mod) => {
      keyboardNavModule = mod;
    })
    .catch(() => {
      // Both the chrome.runtime.getURL and relative import fallbacks failed
      // (should not happen in production). offerShortcutCoach() below then
      // permanently no-ops — a dropped coach hint, not a crash (mirrors the
      // clock/overlay-registry bridges' failure handling above).
    });

  function offerShortcutCoach(actionID) {
    return keyboardNavModule?.offerShortcutCoach?.(actionID) ?? Promise.resolve(false);
  }

  // Bridge onto page/features/mr-preload.js (ticket 19): preloadMergeRequest,
  // mergeRequestPreloadStatus, preloadFullProject, fullProjectPreloadStatus,
  // and invalidateCacheState used to be five functions defined directly in
  // this file. Their pure planning core (which packages/searches to load, in
  // what order) is genuinely extractable — it now lives in
  // page/features/mr-preload.internal.js — but the execution shell still
  // needs workerRPC/loadPackage/loadProject/projectContext/
  // mergeRequestHeadRef/mergeRequestIID/listMergeRequestChangedFiles/
  // modulePathFor/searchProjectBlobPaths, all shared with hover/click
  // resolution elsewhere in this file (not migrated by this ticket). Ticket
  // 03 §3's "capabilities that lifecycle injects at mount" is the sanctioned
  // escape hatch for exactly this: this bridge builds a `legacy` capability
  // bag from this file's own functions and mounts the module itself, fully
  // capable — unlike page/main.js's page/lifecycle, which has no access to
  // these closures (that would be the forbidden globalThis contract) and so
  // mounts a second, capability-less instance purely for message routing
  // (see mr-preload.js's header comment for the documented consequence).
  //
  // Same shape as the clock/overlay-registry bridges above: IIFE-top-level
  // kickoff for maximum head start, no queue-until-ready placeholder (every
  // adapter below is async and only ever invoked from a click handler or a
  // runtime message, both long after module evaluation completes) — except
  // `invalidateCacheState`, which content.js calls synchronously and
  // fire-and-forget; a `pendingInvalidate` flag replays it once the module
  // becomes ready instead of silently dropping it during the (sub-30ms, per
  // ticket 04 §7's measurement) load race.
  async function loadMrPreloadModule() {
    try {
      return await import(chrome.runtime.getURL('page/features/mr-preload.js'));
    } catch {
      return await import('./page/features/mr-preload.js');
    }
  }
  let mrPreloadHandle = null;
  let pendingInvalidate = false;
  // Exposed via __test.mrPreloadReady so tests can deterministically await
  // the load instead of racing it; production code never awaits this itself.
  const mrPreloadReady = loadMrPreloadModule()
    .then(({ mount }) => {
      mrPreloadHandle = mount({
        legacy: {
          projectContext,
          mergeRequestHeadRef,
          mergeRequestIID,
          workerRPC,
          loadPackage,
          loadProject,
          listMergeRequestChangedFiles,
          modulePathFor,
          searchProjectBlobPaths,
          projectLoadingProgress,
          // Ticket 28: both used to reach into `state.packages`/
          // `state.projects`/`state.projectProgressListeners` directly. The
          // source-loader instance owns those caches, and with them the
          // "never drop a project load that still has subscribers" rule.
          forgetStaleProjectCache(scope) {
            sourceLoader?.forgetStaleProject(scope);
          },
          resetCaches() {
            sourceLoader?.reset();
          },
        },
      });
      if (pendingInvalidate) {
        pendingInvalidate = false;
        mrPreloadHandle.invalidateCache();
      }
    })
    .catch(() => {
      // Both the chrome.runtime.getURL and relative import fallbacks failed
      // (should not happen in production). Leave mrPreloadHandle null; the
      // adapters below then permanently throw "module failed to load"
      // instead of crashing on a null handle (mirrors the clock/
      // overlay-registry bridges' failure handling above).
    });

  async function preloadMergeRequest(progress = () => {}) {
    await mrPreloadReady;
    if (!mrPreloadHandle) throw new Error('MR preload module failed to load.');
    return mrPreloadHandle.preloadMergeRequest({ progress });
  }
  async function mergeRequestPreloadStatus() {
    await mrPreloadReady;
    if (!mrPreloadHandle) throw new Error('MR preload module failed to load.');
    return mrPreloadHandle.preloadStatus();
  }
  async function preloadFullProject(progress = () => {}, requestedRef = '') {
    await mrPreloadReady;
    if (!mrPreloadHandle) throw new Error('MR preload module failed to load.');
    return mrPreloadHandle.preloadFullProject({ progress, ref: requestedRef });
  }
  async function fullProjectPreloadStatus() {
    await mrPreloadReady;
    if (!mrPreloadHandle) throw new Error('MR preload module failed to load.');
    return mrPreloadHandle.fullProjectStatus();
  }
  function invalidateCacheState() {
    if (mrPreloadHandle) mrPreloadHandle.invalidateCache();
    else pendingInvalidate = true;
  }

  // Bridge onto page/features/project-search.js (ticket 20): the "search
  // complete project" modal used to be four functions defined directly in
  // this file (searchCompleteProject/openFullSearch/runFullSearch plus the
  // minimize/restore/cancel trio). Its paging/progress decision core is
  // genuinely extractable — it now lives in
  // page/features/project-search.internal.js — but the execution shell
  // still needs searchProjectBlobPaths/loadPackage (shared with hover/click
  // resolution and mr-preload, not migrated by this ticket) and the
  // popover-rendering functions showResult/pinPopover/hidePopover/toast
  // (also shared, likewise not migrated). Same escape hatch as the
  // mr-preload bridge above: a `legacy` capability bag built from this
  // file's own functions, mounted fully capable here — unlike
  // page/main.js's page/lifecycle, which mounts a second, capability-less
  // instance purely for message routing (see project-search.js's own
  // header comment).
  async function loadProjectSearchModule() {
    try {
      return await import(chrome.runtime.getURL('page/features/project-search.js'));
    } catch {
      return await import('./page/features/project-search.js');
    }
  }
  let projectSearchHandle = null;
  // Exposed via __test.projectSearchReady so tests can deterministically
  // await the load instead of racing it; production code never awaits this
  // itself.
  const projectSearchReady = loadProjectSearchModule()
    .then(({ mount }) => {
      projectSearchHandle = mount({
        legacy: {
          searchProjectBlobPaths,
          loadPackage,
          findReferencesAt,
          findImplementationsAt,
          showResult,
          pinPopover,
          hidePopover,
          toast,
          isEnabled: () => state.enabled,
        },
      });
    })
    .catch(() => {
      // Both the chrome.runtime.getURL and relative import fallbacks failed
      // (should not happen in production). Leave projectSearchHandle null;
      // openFullSearch() below then permanently no-ops instead of crashing
      // on a null handle (mirrors the mr-preload bridge's failure handling).
    });

  function openFullSearch(result, pointer) {
    projectSearchHandle?.open(result, pointer);
  }

  // Bridge onto page/features/bookmarks.js (ticket 18): bookmark
  // anchoring/recovery/markers/selection-UI used to be ~25 functions
  // defined directly in this file (bookmarkScopeKey through
  // revealDiffBookmark), plus content.js's drawer *state* (its DOM stays in
  // content.js — see that file's own comment). `globalThis.GoLensBookmarks`
  // (bookmark-store.js, out of scope for ticket 18) stays a global exactly
  // as before; everything else follows the same escape hatch as the
  // mr-preload/project-search bridges above: a `legacy` capability bag from
  // this file's own closures (diff-DOM primitives, MR/network helpers,
  // reveal/navigation helpers, the toast surface, and the active code-intel
  // selection, none of which have migrated out of this file yet), mounted
  // fully capable here. page/main.js mounts a second, capability-less
  // instance purely for message-routing consistency; unlike project-search
  // that instance is inert on purpose (see bookmarks.js's header comment) —
  // bookmarks genuinely owns live diff DOM (markers, a MutationObserver), so
  // a second functional instance would double-render markers.
  async function loadBookmarksModule() {
    try {
      return await import(chrome.runtime.getURL('page/features/bookmarks.js'));
    } catch {
      return await import('./page/features/bookmarks.js');
    }
  }
  let bookmarksHandle = null;
  let pendingBookmarksEnable = false;
  // Exposed via __test.bookmarksReady so tests can deterministically await
  // the load instead of racing it; production code never awaits this
  // itself.
  const bookmarksReady = loadBookmarksModule()
    .then(({ mount }) => {
      bookmarksHandle = mount({
        bookmarkStore: globalThis.GoLensBookmarks?.createStore ? globalThis.GoLensBookmarks.createStore() : null,
        hashText: globalThis.GoLensBookmarks?.hashText,
        legacy: {
          projectContext,
          mergeRequestIID,
          mergeRequestRefs,
          clearMergeRequestRefs,
          diffFileRoots,
          diffRootFor,
          rapidFileData,
          parseBlobLink,
          codeCellFor,
          lineContextFor,
          fetchSource,
          navigateToLocation,
          waitForDiffUpdate,
          lineAnchorFor,
          toast,
          isEnabled: () => state.enabled,
          // Ticket 21: the hovered target's source location is now
          // code-intel.js's own state (`activeTarget`) — forwards to its
          // self-bridge-only `selectedSymbolLocation()` handle method
          // instead of reading `state.activeTarget` directly.
          selectedSymbolLocation: () => codeIntelHandle?.selectedSymbolLocation?.() ?? null,
        },
      });
      if (pendingBookmarksEnable) {
        pendingBookmarksEnable = false;
        bookmarksHandle.enable();
      }
    })
    .catch(() => {
      // Both the chrome.runtime.getURL and relative import fallbacks failed
      // (should not happen in production). Leave bookmarksHandle null; the
      // adapters below then permanently no-op instead of crashing on a null
      // handle (mirrors the mr-preload/project-search bridges' failure
      // handling).
    });
  function enableBookmarks() {
    if (bookmarksHandle) bookmarksHandle.enable();
    else pendingBookmarksEnable = true;
  }
  function disableBookmarks() {
    pendingBookmarksEnable = false;
    bookmarksHandle?.disable();
  }

  // Bridge onto page/features/code-intel.js (ticket 21): hover/click
  // resolution, the popover DOM, occurrence highlighting, and reference/
  // implementation navigation used to be ~40 functions defined directly in
  // this file (targetAtEvent through showResult, resolveAt/
  // findReferencesAt/findImplementationsAt, the occurrence-highlighting
  // group). Same escape hatch as the bookmarks/project-search/mr-preload
  // bridges above: a `legacy` capability bag of this file's own closures
  // (diff-DOM primitives, package/project loading, worker RPC, URL
  // builders, diff-reveal, the shared toast surface, the shortcut-coach
  // bridge, the frame-throttle clock, and project-search's modal opener —
  // none of which have migrated out of this file), mounted fully capable
  // here. page/main.js mounts a second, capability-less instance purely for
  // message-routing consistency; every method on that instance degrades to
  // false/null/{kind:'unavailable'} instead of crashing (see
  // code-intel.js's own header comment).
  async function loadCodeIntelModule() {
    try {
      return await import(chrome.runtime.getURL('page/features/code-intel.js'));
    } catch {
      return await import('./page/features/code-intel.js');
    }
  }
  let codeIntelHandle = null;
  let pendingCodeIntelEnable = null;
  // Exposed via __test.codeIntelReady so tests can deterministically await
  // the load instead of racing it; production code never awaits this
  // itself.
  const codeIntelReady = loadCodeIntelModule()
    .then(({ mount }) => {
      codeIntelHandle = mount({
        legacy: {
          fileContextFor,
          lineContextFor,
          codeCellFor,
          diffFileRoots,
          projectContext,
          documentationURL,
          projectPackageURL,
          visibleDiffRootForDefinition,
          navigateToLocation,
          loadPackage,
          preloadMergeRequest,
          mergeRequestRefsForFile,
          mergeRequestIID,
          sourceRefFor,
          dirname,
          workerRPC,
          toast,
          offerShortcutCoach,
          requestFrame: (fn) => clock.requestFrame(fn),
          openFullSearch,
        },
      });
      if (pendingCodeIntelEnable !== null) {
        codeIntelHandle.setEnabled(pendingCodeIntelEnable);
        pendingCodeIntelEnable = null;
      }
    })
    .catch(() => {
      // Both the chrome.runtime.getURL and relative import fallbacks failed
      // (should not happen in production). Leave codeIntelHandle null; the
      // adapters below then permanently no-op/degrade instead of crashing
      // on a null handle (mirrors the mr-preload/project-search/bookmarks
      // bridges' failure handling).
    });
  function setCodeIntelEnabled(value) {
    if (codeIntelHandle) codeIntelHandle.setEnabled(value);
    else pendingCodeIntelEnable = value;
  }
  // Thin one-liners keeping their pre-ticket-21 names so
  // project-search.js's and bookmarks.js's existing `legacy` capability
  // bags (findReferencesAt/findImplementationsAt/showResult/pinPopover/
  // hidePopover) keep working unchanged — same pattern as
  // `openFullSearch()`'s own one-liner forward onto `projectSearchHandle`
  // (ticket 20).
  function findReferencesAt(target, definition, cursor = '', scopeOverride = null) {
    return codeIntelHandle ? codeIntelHandle.findReferences(target, definition, cursor, scopeOverride) : Promise.resolve({ status: 'notFound' });
  }
  function findImplementationsAt(target, definition, progress = () => {}, cursor = '', scopeOverride = null) {
    return codeIntelHandle ? codeIntelHandle.findImplementations(target, definition, progress, cursor, scopeOverride) : Promise.resolve({ status: 'notFound' });
  }
  function showResult(result, pointer) {
    return codeIntelHandle ? codeIntelHandle.showResult(result, pointer) : false;
  }
  function pinPopover(target = null) {
    codeIntelHandle?.pinPopover(target);
  }
  function hidePopover() {
    codeIntelHandle?.hidePopover();
  }

  const state = {
    enabled: false,
    abortController: null,
  };

  // GitLab-API primitives: thin wrappers onto page/platform/gitlab-api.js
  // (ticket 27). The pure ones below are plain module exports; the network-
  // and cache-bearing ones come off the `gitlabApi` instance built in the
  // bridge above. `state.absentSourcePaths`/`state.modulePaths`/
  // `state.refsPromise`/`state.refsKey`/`state.refsFetchedAt` moved into
  // that instance with them.
  function projectContext() {
    return gitlabApiModule.projectContext();
  }

  function normalizePath(value) {
    return gitlabApiModule.normalizePath(value);
  }

  function dirname(path) {
    return gitlabApiModule.dirname(path);
  }

  function isProjectGoPath(path) {
    return gitlabApiModule.isProjectGoPath(path);
  }

  function standardLibraryURL(importPath) {
    return gitlabApiModule.standardLibraryURL(importPath);
  }

  function packageDocumentationURL(importPath) {
    return gitlabApiModule.packageDocumentationURL(importPath);
  }

  function documentationURL(result) {
    return gitlabApiModule.documentationURL(result);
  }

  function projectPackageURL(result) {
    return gitlabApiModule.projectPackageURL(result);
  }

  function parseBlobLink(anchor, expectedPath = '') {
    return gitlabApiModule.parseBlobLink(anchor, expectedPath);
  }

  function mapLimit(values, limit, mapper) {
    return gitlabApiModule.mapLimit(values, limit, mapper);
  }

  function nextPageNumber(response, currentPage, entries) {
    return gitlabApiModule.nextPageNumber(response, currentPage, entries);
  }

  function refsDisagreeWithFile(refs, fileRef) {
    return gitlabApiModule.refsDisagreeWithFile(refs, fileRef);
  }

  function sourceRefFor(file, line, refs) {
    return gitlabApiModule.sourceRefFor(file, line, refs);
  }

  function mergeRequestIID() {
    return gitlabApiModule.mergeRequestIID();
  }

  // Optional-chained: also reached from `teardown()`, which can run before
  // the import resolves. A reset against a cache that cannot have entries
  // yet is a no-op, not an error.
  function clearMergeRequestRefs() {
    gitlabApi?.clearMergeRequestRefs();
  }

  async function fetchSource(path, ref, signal = undefined) {
    await gitlabApiReady;
    return gitlabApi.fetchSource(path, ref, signal);
  }

  async function fetchBlob(entry, ref, signal = undefined) {
    await gitlabApiReady;
    return gitlabApi.fetchBlob(entry, ref, signal);
  }

  async function listPackageFiles(packagePath, ref, signal = undefined) {
    await gitlabApiReady;
    return gitlabApi.listPackageFiles(packagePath, ref, signal);
  }

  async function listProjectFiles(ref) {
    await gitlabApiReady;
    return gitlabApi.listProjectFiles(ref);
  }

  async function listMergeRequestChangedFiles() {
    await gitlabApiReady;
    return gitlabApi.listMergeRequestChangedFiles();
  }

  async function searchProjectBlobPaths(search, ref, options = {}) {
    await gitlabApiReady;
    return gitlabApi.searchProjectBlobPaths(search, ref, options);
  }

  async function modulePathFor(ref, signal = undefined) {
    await gitlabApiReady;
    return gitlabApi.modulePathFor(ref, signal);
  }

  async function mergeRequestRefs() {
    await gitlabApiReady;
    return gitlabApi.mergeRequestRefs();
  }

  async function mergeRequestRefsForFile(file) {
    await gitlabApiReady;
    return gitlabApi.mergeRequestRefsForFile(file);
  }

  // A live `legacy` capability (page/features/mr-preload.js:67), not an
  // internal helper \u2014 see ticket 27.
  async function mergeRequestHeadRef() {
    await gitlabApiReady;
    return gitlabApi.mergeRequestHeadRef();
  }

  // Diff-DOM primitives: thin wrappers onto page/platform/diff-dom.js
  // (ticket 26) — see that bridge's comment at the top of this file for why
  // they are wrappers and not imported bindings. Signatures and behavior are
  // unchanged; `computeFileContext` and `fileContextFor`'s generation-keyed
  // cache moved into the module with them.
  function diffRootFor(node) {
    return diffDom.diffRootFor(node);
  }

  function rapidFileData(root) {
    return diffDom.rapidFileData(root);
  }

  function fileContextFor(node) {
    return diffDom.fileContextFor(node);
  }

  function codeCellFor(target) {
    return diffDom.codeCellFor(target);
  }

  function lineFromAnchor(anchor) {
    return diffDom.lineFromAnchor(anchor);
  }

  function lineAnchorFor(root, line, preferredSide = '') {
    return diffDom.lineAnchorFor(root, line, preferredSide);
  }

  function expansionDirectionForLine(line, visibleLines) {
    return diffDom.expansionDirectionForLine(line, visibleLines);
  }

  function waitForDiffUpdate(root) {
    return diffDom.waitForDiffUpdate(root);
  }

  function revealLine(root, line, preferredSide = '') {
    return diffDom.revealLine(root, line, preferredSide);
  }

  function visibleDiffRootForDefinition(definition) {
    return diffDom.visibleDiffRootForDefinition(definition);
  }

  function navigateToLocation(location, options = {}) {
    return diffDom.navigateToLocation(location, options);
  }

  function lineContextFor(cell) {
    return diffDom.lineContextFor(cell);
  }

  function status(kind, message, progress) {
    document.dispatchEvent(new CustomEvent('golens-go-status', {
      detail: { kind, message, ...(progress ? { progress } : {}) },
    }));
  }

  // Progress view-models: thin wrappers onto page/platform/source-loader.js
  // (ticket 28), where they live alongside the two load flows that produce
  // them. `projectLoadingProgress` is also handed to
  // page/features/mr-preload.js as a `legacy` capability.
  function packageLoadingProgress(phase, completed = 0, total = 0, details = {}) {
    return sourceLoaderModule.packageLoadingProgress(phase, completed, total, details);
  }

  function packageLoadingMessage(packagePath, progress) {
    return sourceLoaderModule.packageLoadingMessage(packagePath, progress);
  }

  function projectLoadingProgress(phase, completed = 0, total = 0, details = {}) {
    return sourceLoaderModule.projectLoadingProgress(phase, completed, total, details);
  }

  function projectLoadingMessage(progress) {
    return sourceLoaderModule.projectLoadingMessage(progress);
  }

  // relatedLoadingProgress/relatedLoadingMessage (MR-related preload's own
  // progress view-model formatters) moved to
  // page/features/mr-preload.internal.js (ticket 19) — they were only ever
  // used by preloadMergeRequest, also moved there.

  // Temporary bridge onto platform/rpc-client (ticket 09): go-navigation
  // still dispatches by a dynamic wire-method-name string (`resolveAt(target,
  // 'resolveHover', …)`), so `workerRPC` stays as a lookup shim rather than
  // every call site switching to `client.query.resolveHover(...)` directly.
  // Framing, port lifecycle/reconnect, and in-flight bookkeeping now live in
  // page/platform/rpc-client.js; this file only knows the wire-method name
  // and its params. `rpcClient` is created lazily (only once a caller
  // actually needs the worker), so tests that never trigger an RPC never
  // touch `chrome.runtime`.
  let rpcClient = null;
  let rpcMethodNamespace = null;
  let rpcClientPromise = null;

  function ensureRpcClient() {
    if (rpcClient) return Promise.resolve(rpcClient);
    if (!rpcClientPromise) {
      rpcClientPromise = import(chrome.runtime.getURL('page/platform/rpc-client.js')).then((module) => {
        rpcClient = module.createRpcClient({
          connect: () => chrome.runtime.connect({ name: 'golens-go-rpc' }),
          // The worker restarted and lost its in-memory index, so every
          // restored/cached result is stale. Tickets 27/28 own these caches
          // now; `clearLoaded()` deliberately leaves in-flight loads'
          // progress listeners attached (see source-loader.js).
          onDisconnect: () => {
            sourceLoader?.clearLoaded();
            gitlabApi?.clearModulePaths();
          },
        });
        rpcMethodNamespace = module.methodNamespace;
        return rpcClient;
      });
    }
    return rpcClientPromise;
  }

  async function workerRPC(method, params) {
    const client = await ensureRpcClient();
    return client[rpcMethodNamespace(method)][method](params);
  }

  // Source loading: thin wrappers onto page/platform/source-loader.js
  // (ticket 28). `state.packages`/`state.projects`/
  // `state.projectProgressListeners` moved into that module's instance, as
  // did the per-key in-flight-promise de-duplication and the progress
  // fan-out. `status()` above is injected into it rather than moving with
  // them — see that module's header for why.
  async function loadPackage(packagePath, ref, onProgress = () => {}, signal = undefined) {
    await sourceLoaderReady;
    return sourceLoader.loadPackage(packagePath, ref, onProgress, signal);
  }

  async function loadProject(ref, progress = () => {}) {
    await sourceLoaderReady;
    return sourceLoader.loadProject(ref, progress);
  }

  // mergeSearchStatus/relatedReadyMessage/implementationSearchTerms and
  // mergeRequestPreloadStatus/preloadMergeRequest/fullProjectPreloadStatus/
  // preloadFullProject/invalidateCacheState all moved to
  // page/features/mr-preload.js and its .internal.js pure core (ticket 19).
  // The bridge near the top of this file ("Bridge onto
  // page/features/mr-preload.js") now defines these same five names as
  // thin async adapters onto the mounted module's handle.

  // Toast surface: thin wrappers onto page/platform/toast.js (ticket 29).
  // The shadow host, its markup/CSS, the 2600ms/8000ms auto-hide timers and
  // `state.toastTimer`/`state.ui` all moved into that module's instance.
  // The surface stays shared (keyboard-nav.js/bookmarks.js/
  // project-search.js/code-intel.js all reach it); only its implementation
  // moved. code-intel.js's popover remains a separate shadow host of its
  // own (ticket 21).
  //
  // `toast`/`showShortcutCoachHint` are also this file's public
  // `showToast`/`showShortcutCoachHint` exports, and `isToastShowing` its
  // `legacyToast.isShowing` capability. All three degrade rather than throw
  // if reached before the import resolves — a dropped notification is not
  // worth crashing a keyboard action over, and `showShortcutCoachHint`
  // already had a false return for "did not show".

  // sourceLocationForTarget through hidePopover (popover DOM, rendering,
  // and hit-test presentation, ~600 lines) moved to
  // page/features/code-intel.js/.internal.js (ticket 21).

  function hideToast() {
    toastSurface?.hideToast();
  }

  function toast(message) {
    toastSurface?.toast(message);
  }

  // isToastShowing()/showShortcutCoachHint() are exposed on this module's
  // public surface (ticket 17) as capabilities page/features/keyboard-nav.js
  // is given at mount, since the coach hint reuses the same `.toast` element
  // (dataset.kind distinguishes 'message' from 'shortcut'). keyboard-nav.js
  // owns the blocked-check and the message-for-action decision; the surface
  // only renders a hint it is handed, message included.
  function isToastShowing() {
    return toastSurface?.isToastShowing() ?? false;
  }

  function showShortcutCoachHint(hint) {
    return toastSurface?.showShortcutCoachHint(hint) ?? false;
  }

  // Ticket 26: the diff-root selector and this walk live in
  // page/platform/diff-dom.js; this stays a wrapper for the `legacy` bags.
  function diffFileRoots() {
    return diffDom.diffFileRoots();
  }

  // targetAtEvent/identifierBoundary/occurrenceRanges/paintOccurrences/
  // refreshOccurrences/scheduleOccurrenceRefresh/clearSelectedSymbol/
  // selectSymbol/navigateOccurrence/targetForOccurrence/
  // targetForSelectedOccurrence moved to page/features/code-intel.js
  // (ticket 21) — occurrence highlighting now runs off that module's own
  // MutationObserver, not this file's diffObserver (see its own comment on
  // that architecture change).

  // runNavigationAction(action) -> boolean. Shrunk to just the three
  // bookmark actions (ticket 21): semanticJump/previousOccurrence/
  // nextOccurrence/historyBack/historyForward moved to code-intel.js's own
  // navigationAction(action), reached by keyboard-nav.js through a new
  // `navigationAction` capability (page/main.js) instead of this function.
  // keyboard-nav.js's `runLegacyNavigationAction` capability still points
  // here, now only for the bookmark actions — see keyboard-nav.js's header
  // comment for the split.
  function runNavigationAction(action) {
    if (!state.enabled) return false;
    if (action === 'toggleBookmark') {
      // Bridge onto page/features/bookmarks.js (ticket 18): the
      // selection-or-focused-marker-or-code-intel-fallback chain now lives
      // in bookmarks.js's toggleAtSelection() — this file only still owns
      // the code-intel fallback (the currently selected occurrence's source
      // location), reached through code-intel.js's own
      // selectedOccurrenceSourceLocation() handle method (ticket 21 — that
      // state moved out of this file along with occurrence selection).
      const selectedTarget = codeIntelHandle?.selectedOccurrenceSourceLocation?.() ?? null;
      const fallback = selectedTarget ? { path: selectedTarget.path, side: selectedTarget.side, startLine: selectedTarget.line, endLine: selectedTarget.line } : null;
      bookmarksHandle?.toggleAtSelection(fallback);
      return true;
    }
    if (action === 'previousBookmark') { void bookmarksHandle?.navigate(-1); return true; }
    if (action === 'nextBookmark') { void bookmarksHandle?.navigate(1); return true; }
    return false;
  }

  // markTarget/throttleToFrame/handleMouseMovePoint/onMouseMove/
  // eventIsInsideUI/dismissPinnedPopoverFromOutside/navigateSemanticTarget/
  // onClick moved to page/features/code-intel.js (ticket 21) — hover/click
  // detection and resolution orchestration now run entirely inside that
  // module's own `setEnabled(true)`, not this file's `init()`.

  // onKeyDown(event): document-level Escape routing. Two branches remain,
  // in the original priority order (ticket 20's project-search-minimize
  // check first, then the popover): the project-search-minimize check stays
  // here verbatim (see its own comment); the popover branch now delegates
  // to code-intel.js's own handleEscape() self-bridge-only handle method
  // (ticket 21) — that module owns the popover state
  // (popoverMode/selectedIdentifier) this used to read directly.
  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    if ([...event.composedPath(), document.activeElement].some((target) => target?.closest?.('input, textarea, select, [contenteditable], dialog, [role="dialog"], [aria-modal="true"]'))) return;
    // Ticket 20: the full-search modal's DOM moved into
    // page/features/project-search.js's own shadow host, so this can no
    // longer read `.full-search-backdrop` directly — it asks the
    // self-bridged handle instead. Only reached when the modal does NOT
    // have focus (the guard above already suppresses Escape while it
    // does, via event.composedPath()'s in-shadow entries) — e.g. a click
    // on the backdrop blurred focus to <body> without closing the dialog.
    // See project-search.js's header comment for the fuller trace.
    if (projectSearchHandle?.minimize?.()?.kind === 'minimized') {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    codeIntelHandle?.handleEscape?.(event);
  }

  // isBookmarkOnlyMutation(mutation) -> whether a MutationRecord is entirely
  // page/features/bookmarks.js's own marker/selection-UI DOM. Duplicated
  // (not imported — this file is not an ES module) from that module's
  // bookmarkProjectionMutation(); see the diff-observer comment below for
  // why this file still needs its own copy.
  function isBookmarkOnlyMutation(mutation) {
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    return nodes.length > 0 && nodes.every((node) => node.nodeType === 1 && (
      node.matches?.('[data-golens-bookmark-marker], #golens-bookmark-selection-root')
      || node.querySelector?.('[data-golens-bookmark-marker], #golens-bookmark-selection-root')
    ));
  }

  function init() {
    if (state.enabled || !/\/-\/merge_requests\/\d+/.test(location.pathname)) return;
    state.enabled = true;
    state.abortController = new AbortController();
    // Ticket 18: bookmark-store setup/subscription and the diff-marker
    // surface registration used to happen inline here. Both now live inside
    // bookmarks.js's own enable(), reached through this file's self-bridge
    // (see the "Bridge onto page/features/bookmarks.js" comment above).
    enableBookmarks();
    // Ticket 21: hover/click detection, the popover, and occurrence
    // highlighting used to be wired directly here (mousemove/click/keydown
    // listeners, the diff-reconciliation debounce feeding
    // scheduleOccurrenceRefresh). All of that now lives inside
    // code-intel.js's own setEnabled(true), reached through this file's
    // self-bridge (see the "Bridge onto page/features/code-intel.js"
    // comment above) — including that module's own MutationObserver, so
    // this file's diffObserver below only still bumps
    // fileContextGeneration for fileContextFor's cache.
    setCodeIntelEnabled(true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('visibilitychange', refreshMergeRequestRefs, true);
    state.diffObserver = new MutationObserver((mutations) => {
      // Ticket 18: bookmarks.js now places its own markers in the diff and
      // runs its own separate MutationObserver to reconcile them — this
      // guard (duplicated from bookmarks.js's own
      // bookmarkProjectionMutation(), documented there) still needs to
      // ignore mutations that are only that module's marker/selection-UI
      // DOM, or every marker placement would bump fileContextGeneration
      // needlessly.
      if (mutations.length && mutations.every(isBookmarkOnlyMutation)) return;
      // Invalidation is synchronous — a hover right after this fires must
      // never resolve a stale cached file context. Ticket 26: the counter
      // itself is owned by page/platform/diff-dom.js; optional-chained
      // because a bump before that module loads is a no-op on a cache that
      // cannot have entries yet (see the bridge comment at the top).
      diffDom?.bumpFileContextGeneration();
    });
    const diffObserverRoot = document.getElementById('diffs') || document.body;
    state.diffObserver.observe(diffObserverRoot, { childList: true, subtree: true, characterData: true });
    status('idle', 'Go intelligence · hover code to start');
  }

  function teardown() {
    state.enabled = false;
    state.abortController?.abort();
    state.abortController = null;
    state.diffObserver?.disconnect();
    state.diffObserver = null;
    setCodeIntelEnabled(false);
    // Ticket 18: navigation-index/focused-location resets, the refresh
    // timer, the selection UI, and marker removal all now live inside
    // bookmarks.js's own disable().
    disableBookmarks();
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('visibilitychange', refreshMergeRequestRefs, true);
    rpcClient?.dispose({ reason: 'Go intelligence request cancelled' });
    // Tickets 27/28/29 own this state now. Every call is optional-chained:
    // `teardown()` is synchronous and can run before the platform imports
    // resolve, and a reset against caches that cannot have entries yet is a
    // no-op, not an error.
    sourceLoader?.reset();
    gitlabApi?.clearModulePaths();
    gitlabApi?.clearMergeRequestRefs();
    projectSearchHandle?.close({ restorePopover: false });
    toastSurface?.destroy();
  }

  function refreshMergeRequestRefs() {
    if (document.visibilityState === 'visible') {
      clearMergeRequestRefs();
    }
  }

  globalThis.GoLensGoNavigation = {
    init,
    teardown,
    preloadMergeRequest,
    mergeRequestPreloadStatus,
    preloadFullProject,
    fullProjectPreloadStatus,
    invalidateCacheState,
    runNavigationAction,
    offerShortcutCoach,
    // showToast/showShortcutCoachHint/isToastShowing (ticket 17): given to
    // page/features/keyboard-nav.js as its `legacyToast` capability — see
    // the keyboard-nav bridge comment above for why the toast element
    // itself stays here rather than becoming a second toast surface.
    showToast: toast,
    showShortcutCoachHint,
    isToastShowing,
    // Ticket 18: the 8 ad-hoc bookmark methods that used to live here
    // (subscribeBookmarks/refreshBookmarks/bookmarkSnapshot/
    // toggleBookmarkAt/revealBookmark/removeBookmark/clearBookmarks/
    // recoverBookmark/registerBookmarkSurface) are replaced by this single
    // live accessor onto the ticket-04 §3 handle itself — content.js reaches
    // `.subscribe`/`.snapshot`/`.toggleAt`/`.reveal`/`.remove`/`.clear`/
    // `.recover` directly, the same shape any other caller of a mounted
    // feature would. A getter (not a value captured once) because
    // `bookmarksHandle` is only populated once the self-bridge's dynamic
    // import resolves (see that bridge's comment above).
    get bookmarks() { return bookmarksHandle; },
    // get codeIntel() (ticket 21): same live-accessor shape as `bookmarks`
    // above, for the same reason (`codeIntelHandle` only populates once the
    // self-bridge's dynamic import resolves). keyboard-nav.js's
    // `navigationAction` capability (page/main.js) reaches
    // `.navigationAction(action)` through this.
    get codeIntel() { return codeIntelHandle; },
    __test: { normalizePath, standardLibraryURL, packageDocumentationURL, documentationURL, projectPackageURL, parseBlobLink, lineFromAnchor, lineAnchorFor, expansionDirectionForLine, revealLine, fileContextFor, codeCellFor, lineContextFor, isProjectGoPath, nextPageNumber, fetchSource, fetchBlob, listPackageFiles, listProjectFiles, searchProjectBlobPaths, packageLoadingProgress, packageLoadingMessage, projectLoadingProgress, projectLoadingMessage, refsDisagreeWithFile, sourceRefFor, onKeyDown, showShortcutCoachHint, setClock, diffDomReady, gitlabApiReady, sourceLoaderReady, toastReady, keyboardNavReady, mrPreloadReady, projectSearchReady, bookmarksReady, codeIntelReady },
  };
})();
