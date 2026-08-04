(() => {
  const GO_FILE = /\.go$/i;
  const COMMIT_SHA = /^[0-9a-f]{40}$/i;
  const GO_DOCS_VERSION = 'go1.26.5';
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
  // `dirname` and `normalizePath`/`parseBlobLink` stay in this file (still
  // used by its GitLab-API helpers and code-intel's `legacy.dirname`); the
  // module carries its own private copies until ticket 27 moves the owning
  // copy to the gitlab-api layer.
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
          forgetStaleProjectCache({ origin, project, ref }) {
            const projectKey = `${origin}\u0000${project}\u0000${ref}`;
            if (!state.projectProgressListeners.has(projectKey)) state.projects.delete(projectKey);
          },
          resetCaches() {
            state.packages.clear();
            state.projects.clear();
            state.projectProgressListeners.clear();
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
    packages: new Map(),
    projects: new Map(),
    projectProgressListeners: new Map(),
    modulePaths: new Map(),
    absentSourcePaths: new Set(),
    refsPromise: null,
    refsKey: '',
    refsFetchedAt: 0,
    toastTimer: null,
    abortController: null,
    ui: null,
  };

  function projectContext() {
    const parts = location.pathname.split('/').filter(Boolean);
    const marker = parts.indexOf('-');
    if (marker < 2) return null;
    const project = parts.slice(0, marker).join('/');
    return { project, projectBase: `${location.origin}/${project}` };
  }

  function normalizePath(value) {
    return value
      .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
      .replace(/\s*\/\s*/g, '/')
      .trim();
  }

  function dirname(path) {
    const index = path.lastIndexOf('/');
    return index < 0 ? '' : path.slice(0, index);
  }

  function isProjectGoPath(path) {
    if (!GO_FILE.test(path)) return false;
    return !path.split('/').some((part) => part === 'vendor' || part === 'testdata');
  }

  function standardLibraryURL(importPath) {
    return `https://pkg.go.dev/${importPath.split('/').map(encodeURIComponent).join('/')}@${GO_DOCS_VERSION}`;
  }

  function packageDocumentationURL(importPath) {
    return `https://pkg.go.dev/${importPath.split('/').map(encodeURIComponent).join('/')}`;
  }

  function documentationURL(result) {
    if (result.status === 'builtin') return `${standardLibraryURL('builtin')}#${encodeURIComponent(result.symbol)}`;
    return result.status === 'standardLibrary' ? standardLibraryURL(result.importPath) : packageDocumentationURL(result.importPath);
  }

  function projectPackageURL(result) {
    const context = projectContext();
    if (!context || !COMMIT_SHA.test(result.ref || '')) return '';
    const tree = `${context.projectBase}/-/tree/${encodeURIComponent(result.ref)}`;
    return result.packagePath
      ? `${tree}/${result.packagePath.split('/').map(encodeURIComponent).join('/')}`
      : tree;
  }

  function parseBlobLink(anchor, expectedPath = '') {
    if (!anchor?.href) return null;
    const url = new URL(anchor.href, location.href);
    const marker = '/-/blob/';
    const index = url.pathname.indexOf(marker);
    if (index < 0) return null;
    const rest = decodeURIComponent(url.pathname.slice(index + marker.length));
    const normalizedExpected = normalizePath(expectedPath);
    if (normalizedExpected && rest.endsWith(`/${normalizedExpected}`)) {
      return { ref: rest.slice(0, -(normalizedExpected.length + 1)), path: normalizedExpected };
    }
    const match = rest.match(/^([0-9a-f]{40})\/(.+)$/i);
    if (match) return { ref: match[1], path: normalizePath(match[2]) };
    const slash = rest.indexOf('/');
    return slash < 0 ? null : { ref: rest.slice(0, slash), path: normalizePath(rest.slice(slash + 1)) };
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

  function packageLoadingProgress(phase, completed = 0, total = 0, details = {}) {
    const safeTotal = Math.max(0, Number.isFinite(total) ? Math.floor(total) : 0);
    const safeCompleted = Math.min(safeTotal, Math.max(0, Number.isFinite(completed) ? Math.floor(completed) : 0));
    const percentage = phase === 'ready'
      ? 100
      : phase === 'discovering'
      ? 0
      : phase === 'indexing' || safeTotal === 0
      ? 90
      : Math.round((safeCompleted / safeTotal) * 90);
    return { phase, completed: safeCompleted, total: safeTotal, percentage, ...details };
  }

  function packageLoadingMessage(packagePath, progress) {
    const label = packagePath || 'root package';
    if (progress.phase === 'discovering') return `Preparing ${label}…`;
    if (progress.phase === 'indexing') return `Indexing symbols · ${progress.percentage}% · ${progress.total} / ${progress.total} files`;
    return `Loading ${label} · ${progress.percentage}% · ${progress.completed} / ${progress.total} files`;
  }

  function projectLoadingProgress(phase, completed = 0, total = 0, details = {}) {
    const safeTotal = Math.max(0, Number.isFinite(total) ? Math.floor(total) : 0);
    const safeCompleted = Math.min(safeTotal, Math.max(0, Number.isFinite(completed) ? Math.floor(completed) : 0));
    const percentage = phase === 'ready'
      ? 100
      : phase === 'discovering'
      ? 0
      : phase === 'indexing' || safeTotal === 0
      ? 95
      : Math.round((safeCompleted / safeTotal) * 90);
    return { phase, completed: safeCompleted, total: safeTotal, percentage, ...details };
  }

  function projectLoadingMessage(progress) {
    if (progress.phase === 'discovering') return 'Preparing MR head cache…';
    if (progress.phase === 'indexing') return `Caching and indexing ${progress.total} Go files…`;
    if (progress.phase === 'ready') return 'MR head cache ready';
    if (Number.isFinite(progress.cached) && Number.isFinite(progress.remaining)) {
      return `${progress.cached.toLocaleString()} cached · ${progress.remaining.toLocaleString()} remaining · ${progress.percentage}%`;
    }
    return `Fetching project Go sources · ${progress.percentage}% · ${progress.completed} / ${progress.total} files`;
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
          onDisconnect: () => {
            state.packages.clear();
            state.projects.clear();
            state.modulePaths.clear();
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

  function authenticatedFetch(input, options = {}) {
    const { signal = state.abortController?.signal, ...requestOptions } = options;
    return fetch(input, {
      credentials: 'include',
      ...requestOptions,
      signal,
    });
  }

  function nextPageNumber(response, currentPage, entries) {
    const header = response.headers.get('x-next-page');
    if (/^\d+$/.test(header || '')) return Number(header);
    return entries.length === 100 ? currentPage + 1 : 0;
  }

  const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
  const FETCH_RETRY_DELAYS_MS = [200, 800, 2000];

  function sleep(ms) {
    return new Promise((resolve) => clock.setTimeout(resolve, ms));
  }

  // Retries a retryable (rate-limited/transient-server-error) response with
  // backoff before giving up, so a single blip can't abort a whole caching
  // job. Never retries an aborted request.
  async function fetchWithRetry(url, options = {}) {
    for (let attempt = 0; ; attempt++) {
      const response = await authenticatedFetch(url, options);
      if (response.ok || !RETRYABLE_STATUS.has(response.status) || attempt >= FETCH_RETRY_DELAYS_MS.length) return response;
      await sleep(FETCH_RETRY_DELAYS_MS[attempt]);
    }
  }

  async function fetchSource(path, ref, signal = undefined) {
    const project = projectContext();
    const url = `${project.projectBase}/-/raw/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`;
    if (state.absentSourcePaths.has(url)) throw new Error(`GitLab returned 404 for ${path}`);
    const response = await fetchWithRetry(url, { signal });
    if (response.status === 404) state.absentSourcePaths.add(url);
    if (!response.ok) throw new Error(`GitLab returned ${response.status} for ${path}`);
    return response.text();
  }

  async function fetchBlob({ path, blobId }, ref, signal = undefined) {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(blobId || '')) {
      throw new Error(`GitLab did not provide a valid blob ID for ${path}`);
    }
    const { project } = projectContext();
    const url = `${location.origin}/api/v4/projects/${encodeURIComponent(project)}/repository/blobs/${encodeURIComponent(blobId)}/raw`;
    if (state.absentSourcePaths.has(url)) throw new Error(`GitLab returned 404 for ${path}`);
    const response = await fetchWithRetry(url, { signal });
    if (response.status === 404) state.absentSourcePaths.add(url);
    if (!response.ok) throw new Error(`GitLab returned ${response.status} for ${path}`);
    return { path, blobId, source: await response.text() };
  }

  function clearMergeRequestRefs() {
    state.refsPromise = null;
    state.refsKey = '';
    state.refsFetchedAt = 0;
  }

  function refsDisagreeWithFile(refs, fileRef) {
    return COMMIT_SHA.test(fileRef || '')
      && COMMIT_SHA.test(refs?.headSha || '')
      && refs.headSha.toLowerCase() !== fileRef.toLowerCase();
  }

  async function mergeRequestRefs() {
    const context = projectContext();
    const iid = location.pathname.match(/\/-\/merge_requests\/(\d+)/)?.[1];
    const key = `${location.origin}\u0000${context?.project || ''}\u0000${iid || ''}`;
    if (state.refsPromise && state.refsKey === key && Date.now() - state.refsFetchedAt < 15000) return state.refsPromise;
    state.refsKey = key;
    state.refsFetchedAt = Date.now();
    state.refsPromise = (async () => {
      if (!context || !iid) return {};
      const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
      const response = await authenticatedFetch(`${location.origin}/api/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify({
          query: 'query GoLensMergeRequestRefs($fullPath: ID!, $iid: String!) { project(fullPath: $fullPath) { mergeRequest(iid: $iid) { diffRefs { baseSha headSha startSha } } } }',
          variables: { fullPath: context.project, iid },
        }),
      });
      if (!response.ok) return {};
      const payload = await response.json();
      return payload.data?.project?.mergeRequest?.diffRefs || {};
    })().catch(() => ({}));
    return state.refsPromise;
  }

  async function mergeRequestRefsForFile(file) {
    let refs = await mergeRequestRefs();
    if (refsDisagreeWithFile(refs, file.ref)) {
      clearMergeRequestRefs();
      refs = await mergeRequestRefs();
    }
    return refs;
  }

  function sourceRefFor(file, line, refs) {
    if (line.side === 'old') return refs.startSha || refs.baseSha || file.ref;
    return COMMIT_SHA.test(file.ref || '') ? file.ref : (refs.headSha || file.ref);
  }

  // Fetches a paginated repository-tree listing. When GitLab reports a total
  // page count, the remaining pages are known upfront and fetched
  // concurrently; GitLab.com is known to omit pagination headers, so when it
  // doesn't the existing sequential `x-next-page`/page-size fallback is used.
  async function fetchTreeEntries(urlFor, signal) {
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    const headers = csrf ? { 'X-CSRF-Token': csrf } : {};
    const fetchPage = async (page) => {
      const response = await fetchWithRetry(urlFor(page), { headers, signal });
      if (!response.ok) throw new Error(`GitLab source API returned ${response.status}`);
      const entries = await response.json();
      if (!Array.isArray(entries)) throw new Error('GitLab returned an invalid repository tree response');
      return { response, entries };
    };
    const first = await fetchPage(1);
    const totalPagesHeader = first.response.headers.get('x-total-pages');
    const totalPages = /^\d+$/.test(totalPagesHeader || '') ? Number(totalPagesHeader) : 0;
    if (totalPages > 1) {
      const remainingPages = await mapLimit(
        Array.from({ length: totalPages - 1 }, (_value, index) => index + 2),
        6,
        async (page) => (await fetchPage(page)).entries,
      );
      return [...first.entries, ...remainingPages.flat()];
    }
    const entries = [...first.entries];
    for (let page = nextPageNumber(first.response, 1, first.entries); page;) {
      const next = await fetchPage(page);
      entries.push(...next.entries);
      page = nextPageNumber(next.response, page, next.entries);
    }
    return entries;
  }

  async function listPackageFiles(packagePath, ref, signal = undefined) {
    const { project } = projectContext();
    const encodedProject = encodeURIComponent(project);
    const entries = await fetchTreeEntries(
      (page) => `${location.origin}/api/v4/projects/${encodedProject}/repository/tree?path=${encodeURIComponent(packagePath)}&ref=${encodeURIComponent(ref)}&per_page=100&page=${page}`,
      signal,
    );
    const files = entries.filter((entry) => entry.type === 'blob' && GO_FILE.test(entry.path)).map((entry) => ({ path: entry.path, blobId: entry.id || '' }));
    if (files.length > 200) throw new Error(`Package ${packagePath || '.'} contains too many Go files`);
    return files;
  }

  async function listProjectFiles(ref) {
    const { project } = projectContext();
    const encodedProject = encodeURIComponent(project);
    const entries = await fetchTreeEntries(
      (page) => `${location.origin}/api/v4/projects/${encodedProject}/repository/tree?recursive=true&ref=${encodeURIComponent(ref)}&per_page=100&page=${page}`,
      undefined,
    );
    return entries.filter((entry) => entry.type === 'blob' && isProjectGoPath(entry.path)).map((entry) => ({ path: entry.path, blobId: entry.id || '' }));
  }

  function mergeRequestIID() {
    return location.pathname.match(/\/-\/merge_requests\/(\d+)/)?.[1] || '';
  }

  async function listMergeRequestChangedFiles() {
    const { project } = projectContext();
    const mergeRequest = mergeRequestIID();
    if (!mergeRequest) throw new Error('GitLab merge request context is unavailable.');
    const encodedProject = encodeURIComponent(project);
    const files = [];
    for (let page = 1; page;) {
      const url = `${location.origin}/api/v4/projects/${encodedProject}/merge_requests/${encodeURIComponent(mergeRequest)}/diffs?per_page=100&page=${page}`;
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(`GitLab merge request API returned ${response.status}`);
      const entries = await response.json();
      if (!Array.isArray(entries)) throw new Error('GitLab returned an invalid merge request diff response');
      files.push(...entries
        .filter((entry) => !entry.deleted_file && isProjectGoPath(entry.new_path || ''))
        .map((entry) => entry.new_path));
      page = nextPageNumber(response, page, entries);
    }
    return [...new Set(files)];
  }

  async function searchProjectBlobPaths(search, ref, { maxPages = 100, maxPaths = Infinity, signal = undefined, searchType = '' } = {}) {
    const { project } = projectContext();
    const encodedProject = encodeURIComponent(project);
    const paths = new Set();
    try {
      for (let page = 1; page <= maxPages; page++) {
        const parameters = new URLSearchParams({ scope: 'blobs', search, ref, per_page: '100', page: String(page) });
        if (searchType) parameters.set('search_type', searchType);
        const response = await authenticatedFetch(`${location.origin}/api/v4/projects/${encodedProject}/search?${parameters}`, { signal });
        if (!response.ok) return { paths: [...paths], status: paths.size ? 'limited' : 'unavailable' };
        const entries = await response.json();
        if (!Array.isArray(entries)) return { paths: [...paths], status: paths.size ? 'limited' : 'unavailable' };
        entries.filter((entry) => isProjectGoPath(entry.path || '')).forEach((entry) => paths.add(entry.path));
        if (paths.size >= maxPaths) return { paths: [...paths].slice(0, maxPaths), status: 'limited' };
        const nextPage = response.headers.get('x-next-page');
        if (nextPage) {
          page = Number(nextPage) - 1;
          continue;
        }
        if (entries.length < 100) return { paths: [...paths], status: 'complete' };
      }
      return { paths: [...paths], status: 'limited' };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return { paths: [...paths], status: paths.size ? 'limited' : 'unavailable' };
    }
  }

  async function modulePathFor(ref, signal = undefined) {
    const key = `${projectContext().project}\u0000${ref}`;
    if (state.modulePaths.has(key)) return state.modulePaths.get(key);
    try {
      const source = await fetchSource('go.mod', ref, signal);
      const modulePath = source.match(/^\s*module\s+([^\s]+)\s*$/m)?.[1] || '';
      state.modulePaths.set(key, modulePath);
      return modulePath;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      state.modulePaths.set(key, '');
      return '';
    }
  }

  async function mapLimit(values, limit, mapper) {
    const results = new Array(values.length);
    let next = 0;
    async function consume() {
      while (next < values.length) {
        const index = next++;
        results[index] = await mapper(values[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, consume));
    return results;
  }

  async function loadPackage(packagePath, ref, onProgress = () => {}, signal = undefined) {
    const context = projectContext();
    const key = `${location.origin}\u0000${context.project}\u0000${ref}\u0000${packagePath}`;
    const projectKey = `${location.origin}\u0000${context.project}\u0000${ref}`;
    if (state.projects.has(projectKey)) return state.projects.get(projectKey);
    if (state.packages.has(key)) return state.packages.get(key);
    const promise = (async () => {
      const reportProgress = (progress) => {
        const message = packageLoadingMessage(packagePath, progress);
        status('loading', message, progress);
        onProgress(message, progress);
      };
      reportProgress(packageLoadingProgress('discovering'));
      const cacheStatus = COMMIT_SHA.test(ref)
        ? await workerRPC('packageCacheStatus', { origin: location.origin, project: context.project, ref, packagePath })
        : { status: 'missing' };
      if (cacheStatus.status === 'complete') {
        const cached = await workerRPC('restorePackage', { origin: location.origin, project: context.project, ref, packagePath });
        if (cached.status !== 'cacheMiss') {
          const message = cached.status === 'cacheHit'
            ? `Go intelligence restored from cache · ${cached.definitions} symbols`
            : 'Go intelligence ready';
          status('ready', message, packageLoadingProgress('ready'));
          return { ...cached, cached: cached.files || 0, downloaded: 0 };
        }
      }
      const entries = await listPackageFiles(packagePath, ref, signal);
      const prepared = COMMIT_SHA.test(ref)
        ? await workerRPC('prepareSources', { origin: location.origin, project: context.project, ref, files: entries })
        : { total: entries.length, cached: 0, missing: entries.map((entry) => ({ ...entry, referencedFiles: 1 })) };
      let downloaded = 0;
      let completed = prepared.cached;
      const progressDetails = () => ({
        cached: prepared.cached,
        downloaded,
        remaining: Math.max(0, prepared.total - completed),
      });
      reportProgress(packageLoadingProgress('fetching', completed, prepared.total, progressDetails()));
      const files = await mapLimit(prepared.missing, 6, async (entry) => {
        const file = await fetchBlob(entry, ref, signal);
        const referencedFiles = entry.referencedFiles || 1;
        downloaded += referencedFiles;
        completed += referencedFiles;
        reportProgress(packageLoadingProgress('fetching', completed, prepared.total, progressDetails()));
        return file;
      });
      reportProgress(packageLoadingProgress('indexing', completed, prepared.total, progressDetails()));
      const modulePath = await modulePathFor(ref, signal);
      const result = await workerRPC('cachePackage', { origin: location.origin, project: context.project, ref, packagePath, modulePath, entries, files });
      status('ready', `Go intelligence ready · ${result.definitions} symbols`, packageLoadingProgress('ready', prepared.total, prepared.total));
      return { ...result, cached: prepared.cached, downloaded };
    })().catch((error) => {
      state.packages.delete(key);
      status('error', error.message);
      throw error;
    });
    state.packages.set(key, promise);
    return promise;
  }

  async function loadProject(ref, progress = () => {}) {
    const context = projectContext();
    const key = `${location.origin}\u0000${context.project}\u0000${ref}`;
    if (state.projects.has(key)) {
      state.projectProgressListeners.get(key)?.add(progress);
      return state.projects.get(key);
    }
    const listeners = new Set([progress]);
    state.projectProgressListeners.set(key, listeners);
    const promise = (async () => {
      const reportProgress = (update, message = projectLoadingMessage(update)) => {
        for (const listener of listeners) listener(message, update);
        status(update.phase === 'ready' ? 'ready' : 'loading', message, update);
      };
      reportProgress(projectLoadingProgress('discovering'));
      const cached = await workerRPC('restoreProject', { origin: location.origin, project: context.project, ref });
      if (cached.status !== 'cacheMiss') {
        const message = cached.status === 'cacheHit'
          ? `Go project intelligence restored from cache · ${cached.packages} packages`
          : 'Go project intelligence ready';
        reportProgress(projectLoadingProgress('ready'), message);
        return cached;
      }
      const entries = await listProjectFiles(ref);
      const prepared = COMMIT_SHA.test(ref)
        ? await workerRPC('prepareSources', { origin: location.origin, project: context.project, ref, files: entries })
        : { total: entries.length, cached: 0, missing: entries.map((entry) => ({ ...entry, referencedFiles: 1 })) };
      let downloaded = 0;
      let completed = prepared.cached;
      const progressDetails = () => ({
        cached: prepared.cached,
        downloaded,
        remaining: Math.max(0, prepared.total - completed),
      });
      reportProgress(projectLoadingProgress('fetching', completed, prepared.total, progressDetails()));
      const files = await mapLimit(prepared.missing, 6, async (entry) => {
        const file = await fetchBlob(entry, ref);
        const referencedFiles = entry.referencedFiles || 1;
        downloaded += referencedFiles;
        completed += referencedFiles;
        reportProgress(projectLoadingProgress('fetching', completed, prepared.total, progressDetails()));
        return file;
      });
      reportProgress(projectLoadingProgress('indexing', prepared.total, prepared.total, progressDetails()));
      const modulePath = await modulePathFor(ref);
      const result = await workerRPC('cacheProject', { origin: location.origin, project: context.project, ref, modulePath, entries, files });
      reportProgress(projectLoadingProgress('ready', prepared.total, prepared.total, progressDetails()), `Go project intelligence ready · ${result.packages} packages`);
      return result;
    })().catch((error) => {
      state.projects.delete(key);
      status('error', error.message);
      throw error;
    }).finally(() => {
      state.projectProgressListeners.delete(key);
    });
    state.projects.set(key, promise);
    return promise;
  }

  async function mergeRequestHeadRef() {
    const ref = (await mergeRequestRefs()).headSha || '';
    if (!COMMIT_SHA.test(ref)) {
      state.refsPromise = null;
      state.refsKey = '';
      state.refsFetchedAt = 0;
      throw new Error('Unable to determine the MR head commit.');
    }
    return ref;
  }

  // mergeSearchStatus/relatedReadyMessage/implementationSearchTerms and
  // mergeRequestPreloadStatus/preloadMergeRequest/fullProjectPreloadStatus/
  // preloadFullProject/invalidateCacheState all moved to
  // page/features/mr-preload.js and its .internal.js pure core (ticket 19).
  // The bridge near the top of this file ("Bridge onto
  // page/features/mr-preload.js") now defines these same five names as
  // thin async adapters onto the mounted module's handle.

  // ensureUI() -> the toast-only shadow host. Shrunk from its former
  // popover+toast markup (ticket 21): the popover DOM is now entirely
  // private to page/features/code-intel.js, in its own shadow host (see
  // that module's own header comment on the toast-surface decision — this
  // host stays here because keyboard-nav.js/bookmarks.js/project-search.js/
  // code-intel.js all still reach it as a shared capability).
  function ensureUI() {
    if (state.ui?.isConnected) return state.ui.shadowRoot;
    const host = document.createElement('div');
    host.id = 'golens-go-toast-root';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all:initial; position:fixed; z-index:var(--golens-z-popover); inset:0; pointer-events:none; font:12px/1.45 var(--golens-font-sans); color-scheme:dark; }
        * { box-sizing:border-box; }
        kbd { display:inline-flex; min-width:17px; min-height:17px; align-items:center; justify-content:center; padding:1px 3px; border:1px solid var(--golens-border-strong); border-bottom-width:2px; border-radius:var(--golens-radius-xs); background:var(--golens-surface-inset); color:var(--golens-text-primary); font:700 9px/1 var(--golens-font-mono); }
        .toast { position:fixed; right:18px; bottom:18px; display:none; width:min(390px,calc(100vw - 36px)); padding:var(--golens-space-3); border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-md); background:var(--golens-surface-raised); color:var(--golens-text-primary); box-shadow:var(--golens-shadow-md); pointer-events:auto; }
        .toast.show { display:grid; }
        .toast[data-kind="message"] { width:auto; max-width:360px; padding:var(--golens-space-2) var(--golens-space-3); }
        .toast[data-kind="message"] .toast-label,.toast[data-kind="message"] .toast-binding,.toast[data-kind="message"] .toast-actions { display:none; }
        .toast-label { margin:0 0 3px; color:var(--golens-primary-hover); font:700 9px/1.3 var(--golens-font-mono); letter-spacing:.06em; text-transform:uppercase; }
        .toast-content { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--golens-space-3); align-items:center; }
        .toast-message { color:var(--golens-text-primary); line-height:1.45; }
        .toast-binding { min-height:24px; padding:3px 7px; white-space:nowrap; }
        .toast-actions { display:flex; gap:var(--golens-space-2); justify-content:flex-end; margin-top:var(--golens-space-2); }
        .toast-actions button { padding:4px 7px; border:1px solid transparent; border-radius:var(--golens-radius-xs); background:transparent; color:var(--golens-text-secondary); font:650 10px/1.3 var(--golens-font-sans); cursor:pointer; }
        .toast-actions button:hover { border-color:var(--golens-border-default); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
        .toast-actions button:active { background:var(--golens-surface-pressed); transform:translateY(1px); }
        .toast-actions button:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:1px; }
      </style>
      <section class="toast" data-kind="message" role="status" aria-live="polite"><p class="toast-label">Shortcut tip</p><div class="toast-content"><div class="toast-message"></div><kbd class="toast-binding"></kbd></div><div class="toast-actions"><button type="button" data-action="shortcut-tip-dismiss">Got it</button><button type="button" data-action="shortcut-tip-disable">Turn tips off</button></div></section>
    `;
    document.body.append(host);
    state.ui = host;
    shadow.querySelector('[data-action="shortcut-tip-dismiss"]').addEventListener('click', hideToast);
    shadow.querySelector('[data-action="shortcut-tip-disable"]').addEventListener('click', async () => {
      const saved = await globalThis.GoLensShortcutCoach?.setEnabled?.(false);
      toast(saved ? 'Shortcut tips turned off. You can re-enable them in settings.' : 'Could not update shortcut tip settings.');
    });
    return shadow;
  }

  // sourceLocationForTarget through hidePopover (popover DOM, rendering,
  // and hit-test presentation, ~600 lines) moved to
  // page/features/code-intel.js/.internal.js (ticket 21).

  function hideToast() {
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
    state.ui?.shadowRoot.querySelector('.toast')?.classList.remove('show');
  }

  function toast(message) {
    const element = ensureUI().querySelector('.toast');
    clearTimeout(state.toastTimer);
    element.dataset.kind = 'message';
    element.querySelector('.toast-message').textContent = message;
    element.classList.add('show');
    state.toastTimer = setTimeout(hideToast, 2600);
  }

  // isToastShowing()/showShortcutCoachHint() are exposed on this module's
  // public surface (ticket 17) as capabilities page/features/keyboard-nav.js
  // is given at mount, since the coach hint reuses this same `.toast`
  // element (dataset.kind distinguishes 'message' from 'shortcut') and the
  // element itself stays here rather than becoming a second toast surface.
  // keyboard-nav.js now owns the blocked-check and the message-for-action
  // decision (formerly shortcutCoachBlocked()/SHORTCUT_COACH_MESSAGES here);
  // this function only renders a hint it is handed, message included.
  function isToastShowing() {
    return Boolean(state.ui?.shadowRoot.querySelector('.toast')?.classList.contains('show'));
  }

  function showShortcutCoachHint(hint) {
    if (!hint?.message) return false;
    const element = ensureUI().querySelector('.toast');
    clearTimeout(state.toastTimer);
    element.dataset.kind = 'shortcut';
    element.querySelector('.toast-message').textContent = hint.message;
    element.querySelector('.toast-binding').textContent = hint.displayBinding;
    element.classList.add('show');
    state.toastTimer = setTimeout(hideToast, 8000);
    return true;
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
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
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
    state.packages.clear();
    state.projects.clear();
    state.projectProgressListeners.clear();
    state.modulePaths.clear();
    state.refsPromise = null;
    state.refsKey = '';
    state.refsFetchedAt = 0;
    projectSearchHandle?.close({ restorePopover: false });
    state.ui?.remove();
    state.ui = null;
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
    __test: { normalizePath, standardLibraryURL, packageDocumentationURL, documentationURL, projectPackageURL, parseBlobLink, lineFromAnchor, lineAnchorFor, expansionDirectionForLine, revealLine, fileContextFor, codeCellFor, lineContextFor, isProjectGoPath, nextPageNumber, fetchSource, fetchBlob, listPackageFiles, listProjectFiles, searchProjectBlobPaths, packageLoadingProgress, packageLoadingMessage, projectLoadingProgress, projectLoadingMessage, refsDisagreeWithFile, sourceRefFor, onKeyDown, showShortcutCoachHint, setClock, diffDomReady, keyboardNavReady, mrPreloadReady, projectSearchReady, bookmarksReady, codeIntelReady },
  };
})();
