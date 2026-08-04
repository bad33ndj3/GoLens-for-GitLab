// platform/source-loader — "make package/project sources available to the
// worker, once" (ticket 28). Owns the two cache-orchestration flows that
// used to live in go-navigation.js: `loadPackage` and `loadProject`, plus
// the three caches they coordinate through (`packages`, `projects`, and the
// per-project set of progress listeners).
//
// The shape of both flows is the same and is the reason this is one module
// rather than two: check the worker's cache → restore on a hit → otherwise
// list the files, ask the worker which sources it is missing, download only
// those with bounded concurrency, hand them back to the worker to index —
// reporting progress at every step and de-duplicating concurrent callers
// onto a single in-flight promise per cache key.
//
// ## `status` is injected, not owned here — read this before "fixing" it
//
// Ticket 28 lists `status()` (the `golens-go-status` CustomEvent dispatch)
// as moving into this module. It is instead an injected dependency. This was
// a deliberate deviation at the time, documented the way
// platform/rpc-client.js documents its own (`onDisconnect`/
// `dispose({reason})`): go-navigation.js's `init()` fired `status('idle', …)`
// **synchronously**, and this module was reached through a dynamic
// `import()` bridge, so a dispatch living here would have landed inside the
// load window and been dropped. `tests/browser-smoke.mjs:268` registers the
// listener that sets `document.body.dataset.goStatus`, and `:445` gates the
// whole implementations-popover scenario on it reaching `'ready'` — this
// event is live, and map.md's correction list records it already having
// been mistaken for a dead contract once.
//
// Ticket 22 update: `status()` now lives in `page/lifecycle/mr-session.js`
// (go-navigation.js is deleted) and is still injected here, for the same
// reason restated in mr-session.js's own header — its dispatch must stay
// reachable as a plain function call from wherever activation happens, not
// bound to this module's own import timing. Injecting it also keeps the
// original stated reason for wanting a factory ("zodat tests ze kunnen
// stubben"): an injected `status` is strictly easier to assert on than a
// dispatched DOM event.
//
// ## Dependencies are injected, not imported
//
// `createSourceLoader` takes the GitLab-API functions it needs as plain
// deps rather than importing platform/gitlab-api.js itself. That keeps this
// module honest as a unit under test: nothing here reaches the network
// except through something the caller handed it. `page/lifecycle/
// mr-session.js` is the one caller now, and — being a real ES module — it
// constructs its `gitlabApi` instance before this module, so there is no
// import-ordering race left to document (ticket 22; the two-bridge-race this
// section used to describe was a go-navigation.js/content.js-era concern).

// --- Progress view-models (pure) ------------------------------------------
//
// Plain named exports, not factory methods: no state, nothing injectable.
// go-navigation.js re-exposes all four through `__test`, and hands
// `projectLoadingProgress` to page/features/mr-preload.js as a `legacy`
// capability (it formats its own "full project cache ready" updates with
// it). Both reach them only at runtime, long after the import bridge
// resolves.

export function packageLoadingProgress(phase, completed = 0, total = 0, details = {}) {
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

export function packageLoadingMessage(packagePath, progress) {
  const label = packagePath || 'root package';
  if (progress.phase === 'discovering') return `Preparing ${label}…`;
  if (progress.phase === 'indexing') return `Indexing symbols · ${progress.percentage}% · ${progress.total} / ${progress.total} files`;
  return `Loading ${label} · ${progress.percentage}% · ${progress.completed} / ${progress.total} files`;
}

export function projectLoadingProgress(phase, completed = 0, total = 0, details = {}) {
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

export function projectLoadingMessage(progress) {
  if (progress.phase === 'discovering') return 'Preparing MR head cache…';
  if (progress.phase === 'indexing') return `Caching and indexing ${progress.total} Go files…`;
  if (progress.phase === 'ready') return 'MR head cache ready';
  if (Number.isFinite(progress.cached) && Number.isFinite(progress.remaining)) {
    return `${progress.cached.toLocaleString()} cached · ${progress.remaining.toLocaleString()} remaining · ${progress.percentage}%`;
  }
  return `Fetching project Go sources · ${progress.percentage}% · ${progress.completed} / ${progress.total} files`;
}

const COMMIT_SHA = /^[0-9a-f]{40}$/i;

// --- The loader -----------------------------------------------------------

export function createSourceLoader({
  workerRPC,
  status,
  projectContext,
  listPackageFiles,
  listProjectFiles,
  fetchBlob,
  modulePathFor,
  mapLimit,
} = {}) {
  const packages = new Map();
  const projects = new Map();
  const projectProgressListeners = new Map();

  async function loadPackage(packagePath, ref, onProgress = () => {}, signal = undefined) {
    const context = projectContext();
    const key = `${location.origin}\u0000${context.project}\u0000${ref}\u0000${packagePath}`;
    const projectKey = `${location.origin}\u0000${context.project}\u0000${ref}`;
    // A whole-project load supersedes any per-package one: if the project is
    // already loaded (or loading) the package's symbols are in there too.
    if (projects.has(projectKey)) return projects.get(projectKey);
    if (packages.has(key)) return packages.get(key);
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
      // Drop the failed promise so a later caller retries rather than
      // re-awaiting a rejection forever.
      packages.delete(key);
      status('error', error.message);
      throw error;
    });
    packages.set(key, promise);
    return promise;
  }

  async function loadProject(ref, progress = () => {}) {
    const context = projectContext();
    const key = `${location.origin}\u0000${context.project}\u0000${ref}`;
    // Unlike loadPackage, a second caller for an in-flight project load
    // subscribes its own progress callback to the running load instead of
    // just awaiting the promise silently.
    if (projects.has(key)) {
      projectProgressListeners.get(key)?.add(progress);
      return projects.get(key);
    }
    const listeners = new Set([progress]);
    projectProgressListeners.set(key, listeners);
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
      projects.delete(key);
      status('error', error.message);
      throw error;
    }).finally(() => {
      projectProgressListeners.delete(key);
    });
    projects.set(key, promise);
    return promise;
  }

  // --- Cache-reset surface -------------------------------------------------
  //
  // go-navigation.js's `teardown()`, its RPC `onDisconnect` handler, and
  // page/features/mr-preload.js's `legacy.resetCaches`/
  // `legacy.forgetStaleProjectCache` used to reach into `state.packages`/
  // `state.projects`/`state.projectProgressListeners` directly. They call
  // these instead; the three sets of semantics are deliberately distinct.

  // teardown() and mr-preload's `resetCaches`: forget everything, including
  // listeners for loads still in flight.
  function reset() {
    packages.clear();
    projects.clear();
    projectProgressListeners.clear();
  }

  // The RPC port dropped: the worker restarted and lost its in-memory index,
  // so every restored/cached result is stale. Progress listeners are NOT
  // cleared — the loads they belong to are still running and their callers
  // still want the updates. Matches the original `onDisconnect` handler,
  // which cleared exactly `packages`/`projects` (and modulePaths, now
  // gitlab-api's).
  function clearLoaded() {
    packages.clear();
    projects.clear();
  }

  // mr-preload's `forgetStaleProjectCache`: drop a completed project load so
  // the next call re-checks the worker, but never yank a load that still has
  // subscribers attached.
  function forgetStaleProject({ origin, project, ref }) {
    const projectKey = `${origin}\u0000${project}\u0000${ref}`;
    if (!projectProgressListeners.has(projectKey)) projects.delete(projectKey);
  }

  return { loadPackage, loadProject, reset, clearLoaded, forgetStaleProject };
}
