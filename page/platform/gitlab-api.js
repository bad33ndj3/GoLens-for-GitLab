// platform/gitlab-api — the one place that talks to GitLab over HTTP.
// Everything below used to live in go-navigation.js and was handed to the
// `legacy` capability bags of bookmarks, mr-preload, project-search and
// code-intel. Hides: credentialed fetch, the retry/backoff policy, the two
// pagination strategies, and three caches (absent source paths, resolved
// module paths, and the merge-request diff refs with their 15s TTL).
//
// Shape: a `createGitLabApi(deps)` factory for everything that touches the
// network or the caches, plus plain named exports for the pure helpers
// (path/URL manipulation, page-context readers) that have neither state nor
// injectable dependencies — the same split platform/diff-dom.js makes, and
// for the same reason: there is nothing to inject into `normalizePath`.
//
// ## Implementation notes
//
// 1. **`fetch`, `clock` and the abort signal are injected as *late-bound*
//    accessors, not values.** `createGitLabApi({ fetch, getClock, getSignal })`
//    calls each on every use rather than capturing it once. This is not
//    stylistic:
//      - `tests/go-navigation-context.test.js` reassigns `globalThis.fetch`
//        *inside* each test, after the module has been constructed.
//      - `helpers.setClock(...)` swaps go-navigation.js's mutable `clock`
//        object after construction and expects the already-built retry loop
//        to observe the swap (the backoff-delay assertions depend on it).
//        Same constraint, and the same solution, as
//        `platform/clock.js`'s `createLegacyDebounceIdle(getClock)`.
//      - `authenticatedFetch` defaults its signal to go-navigation.js's
//        `state.abortController.signal`, and that controller is *replaced*
//        on every `init()` after a `teardown()`. Capturing it once would
//        make every fetch after an SPA re-mount run against a stale,
//        already-aborted signal.
//
// 2. **`sleep` is on the instance, not a plain export**, because it is the
//    retry loop's only use of the injected clock.
//
// 3. **`normalizePath`/`parseBlobLink`/`dirname` are duplicated in
//    platform/diff-dom.js** rather than imported from here. diff-dom is the
//    DOM-reading layer and this is the network layer, and making the former
//    depend on the latter adds a platform→platform edge purely to dedupe
//    ~15 lines of pure string handling. The copies stay; both sides document
//    this decision.

const GO_FILE = /\.go$/i;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const GO_DOCS_VERSION = 'go1.26.5';

const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const FETCH_RETRY_DELAYS_MS = [200, 800, 2000];

// --- Pure helpers ---------------------------------------------------------

export function normalizePath(value) {
  return value
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/\s*\/\s*/g, '/')
    .trim();
}

export function dirname(path) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

export function isProjectGoPath(path) {
  if (!GO_FILE.test(path)) return false;
  return !path.split('/').some((part) => part === 'vendor' || part === 'testdata');
}

export function standardLibraryURL(importPath) {
  return `https://pkg.go.dev/${importPath.split('/').map(encodeURIComponent).join('/')}@${GO_DOCS_VERSION}`;
}

export function packageDocumentationURL(importPath) {
  return `https://pkg.go.dev/${importPath.split('/').map(encodeURIComponent).join('/')}`;
}

export function documentationURL(result) {
  if (result.status === 'builtin') return `${standardLibraryURL('builtin')}#${encodeURIComponent(result.symbol)}`;
  return result.status === 'standardLibrary' ? standardLibraryURL(result.importPath) : packageDocumentationURL(result.importPath);
}

export function parseBlobLink(anchor, expectedPath = '') {
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

// --- Page-context readers -------------------------------------------------
//
// These read `location` rather than taking it as a parameter, exactly as
// their go-navigation.js originals did. They stay plain exports (no state,
// nothing injectable); tests drive them by assigning `globalThis.location`,
// which is how go-navigation-context.test.js already sets its scene.

export function projectContext() {
  const parts = location.pathname.split('/').filter(Boolean);
  const marker = parts.indexOf('-');
  if (marker < 2) return null;
  const project = parts.slice(0, marker).join('/');
  return { project, projectBase: `${location.origin}/${project}` };
}

export function mergeRequestIID() {
  return location.pathname.match(/\/-\/merge_requests\/(\d+)/)?.[1] || '';
}

export function projectPackageURL(result) {
  const context = projectContext();
  if (!context || !COMMIT_SHA.test(result.ref || '')) return '';
  const tree = `${context.projectBase}/-/tree/${encodeURIComponent(result.ref)}`;
  return result.packagePath
    ? `${tree}/${result.packagePath.split('/').map(encodeURIComponent).join('/')}`
    : tree;
}

// --- Pagination and ref helpers -------------------------------------------

export function nextPageNumber(response, currentPage, entries) {
  const header = response.headers.get('x-next-page');
  if (/^\d+$/.test(header || '')) return Number(header);
  return entries.length === 100 ? currentPage + 1 : 0;
}

export function refsDisagreeWithFile(refs, fileRef) {
  return COMMIT_SHA.test(fileRef || '')
    && COMMIT_SHA.test(refs?.headSha || '')
    && refs.headSha.toLowerCase() !== fileRef.toLowerCase();
}

export function sourceRefFor(file, line, refs) {
  if (line.side === 'old') return refs.startSha || refs.baseSha || file.ref;
  return COMMIT_SHA.test(file.ref || '') ? file.ref : (refs.headSha || file.ref);
}

// Bounded-concurrency map. Lives here because `fetchTreeEntries` needs it
// for its concurrent-page path; also exported plain because
// platform/source-loader.js (ticket 28) drives its blob downloads through
// the same helper and takes it as a dependency rather than importing this
// module (see that module's header on why its deps come from
// go-navigation.js's wrappers).
export async function mapLimit(values, limit, mapper) {
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

// --- The stateful, network-facing layer -----------------------------------

export function createGitLabApi({ fetch: fetchImpl, getClock, getSignal } = {}) {
  const doFetch = fetchImpl || ((input, options) => globalThis.fetch(input, options));
  const clockOf = getClock || (() => globalThis);
  const signalOf = getSignal || (() => undefined);

  // 404s are remembered per absolute URL so a package with a file GitLab
  // does not serve doesn't re-request it on every hover. Deliberately NOT
  // cleared by go-navigation.js's teardown — a 404 for a commit-pinned URL
  // stays a 404 — matching the original `state.absentSourcePaths`, which
  // teardown() also left alone.
  const absentSourcePaths = new Set();
  const modulePaths = new Map();
  const blobRefs = new Map();
  let refsPromise = null;
  let refsKey = '';
  let refsFetchedAt = 0;

  function authenticatedFetch(input, options = {}) {
    const { signal = signalOf(), ...requestOptions } = options;
    return doFetch(input, {
      credentials: 'include',
      ...requestOptions,
      signal,
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => clockOf().setTimeout(resolve, ms));
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
    if (absentSourcePaths.has(url)) throw new Error(`GitLab returned 404 for ${path}`);
    const response = await fetchWithRetry(url, { signal });
    if (response.status === 404) absentSourcePaths.add(url);
    if (!response.ok) throw new Error(`GitLab returned ${response.status} for ${path}`);
    return response.text();
  }

  async function fetchBlob({ path, blobId }, ref, signal = undefined) {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(blobId || '')) {
      throw new Error(`GitLab did not provide a valid blob ID for ${path}`);
    }
    const { project } = projectContext();
    const url = `${location.origin}/api/v4/projects/${encodeURIComponent(project)}/repository/blobs/${encodeURIComponent(blobId)}/raw`;
    if (absentSourcePaths.has(url)) throw new Error(`GitLab returned 404 for ${path}`);
    const response = await fetchWithRetry(url, { signal });
    if (response.status === 404) absentSourcePaths.add(url);
    if (!response.ok) throw new Error(`GitLab returned ${response.status} for ${path}`);
    return { path, blobId, source: await response.text() };
  }

  function clearMergeRequestRefs() {
    refsPromise = null;
    refsKey = '';
    refsFetchedAt = 0;
  }

  async function mergeRequestRefs() {
    const context = projectContext();
    const iid = location.pathname.match(/\/-\/merge_requests\/(\d+)/)?.[1];
    const key = `${location.origin}\u0000${context?.project || ''}\u0000${iid || ''}`;
    if (refsPromise && refsKey === key && Date.now() - refsFetchedAt < 15000) return refsPromise;
    refsKey = key;
    refsFetchedAt = Date.now();
    refsPromise = (async () => {
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
    return refsPromise;
  }

  async function mergeRequestRefsForFile(file) {
    let refs = await mergeRequestRefs();
    if (refsDisagreeWithFile(refs, file.ref)) {
      clearMergeRequestRefs();
      refs = await mergeRequestRefs();
    }
    return refs;
  }

  // Both halves are load-bearing (ticket 27's checklist calls this out): a
  // head SHA that isn't a commit SHA means the cached refs answer is
  // useless, so the cache is reset *and* the caller is told, rather than
  // being handed a silently-wrong ref.
  async function mergeRequestHeadRef() {
    const ref = (await mergeRequestRefs()).headSha || '';
    if (!COMMIT_SHA.test(ref)) {
      refsPromise = null;
      refsKey = '';
      refsFetchedAt = 0;
      throw new Error('Unable to determine the MR head commit.');
    }
    return ref;
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
    if (modulePaths.has(key)) return modulePaths.get(key);
    try {
      const source = await fetchSource('go.mod', ref, signal);
      const modulePath = source.match(/^\s*module\s+([^\s]+)\s*$/m)?.[1] || '';
      modulePaths.set(key, modulePath);
      return modulePath;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      modulePaths.set(key, '');
      return '';
    }
  }

  // Blob-view counterpart to `mergeRequestRefsForFile`: there is no MR IID
  // and no `diffRefs` query on a blob page, so the URL's ref (a branch name
  // or a SHA) is resolved to a full commit SHA via the REST commits
  // endpoint instead, then wrapped in the same `{ baseSha, headSha,
  // startSha }` shape so `sourceRefFor`/`code-intel.js` need no changes to
  // consume it. `baseSha`/`startSha` are always '' here (a blob view has no
  // "old side"); `sourceRefFor` already falls back to `file.ref` when they're
  // empty, which is exactly what an unpinned blob-view ref should resolve to.
  async function blobFileRef(file) {
    if (COMMIT_SHA.test(file.ref || '')) return { headSha: file.ref, baseSha: '', startSha: '' };
    const key = `${projectContext().project} ${file.ref}`;
    if (blobRefs.has(key)) return blobRefs.get(key);
    const promise = (async () => {
      try {
        const { project } = projectContext();
        const url = `${location.origin}/api/v4/projects/${encodeURIComponent(project)}/repository/commits/${encodeURIComponent(file.ref)}`;
        const response = await authenticatedFetch(url);
        if (!response.ok) throw new Error(`GitLab returned ${response.status} for commit ${file.ref}`);
        const payload = await response.json();
        return { headSha: payload.id || '', baseSha: '', startSha: '' };
      } catch (error) {
        // Unlike `modulePathFor`'s empty-string caching (a missing go.mod is
        // a durable fact about the repo), a failed ref-resolution here is
        // more likely a transient network blip, and there is no safe fake
        // SHA to hand out. So the failure is NOT cached: the entry is
        // dropped so the next call retries against the network instead of
        // being stuck with a remembered failure for the rest of the session.
        blobRefs.delete(key);
        return { headSha: '', baseSha: '', startSha: '' };
      }
    })();
    blobRefs.set(key, promise);
    return promise;
  }

  // Cache-reset surface. go-navigation.js's `teardown()` and its RPC
  // `onDisconnect` handler used to reach into `state.modulePaths`/
  // `state.refsPromise` directly; now they call these. `clearMergeRequestRefs`
  // is also a live capability (bookmarks.js's `legacy` bag) and stays under
  // its original name.
  function clearModulePaths() {
    modulePaths.clear();
  }

  return {
    authenticatedFetch,
    sleep,
    fetchWithRetry,
    fetchSource,
    fetchBlob,
    fetchTreeEntries,
    listPackageFiles,
    listProjectFiles,
    listMergeRequestChangedFiles,
    searchProjectBlobPaths,
    modulePathFor,
    mergeRequestRefs,
    mergeRequestRefsForFile,
    mergeRequestHeadRef,
    blobFileRef,
    clearMergeRequestRefs,
    clearModulePaths,
  };
}
