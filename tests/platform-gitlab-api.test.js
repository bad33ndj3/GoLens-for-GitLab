// page/platform/gitlab-api.js as a unit — `fetch` and `clock` injected,
// no real network calls and no real waiting anywhere. This suite covers
// unit-level behavior: that the caches, the retry policy and the two
// pagination strategies work correctly, and that the injected seams are
// read late rather than captured at construction.

import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { Window } from 'happy-dom';

import {
  createGitLabApi,
  dirname,
  documentationURL,
  isProjectGoPath,
  mapLimit,
  mergeRequestIID,
  nextPageNumber,
  normalizePath,
  packageDocumentationURL,
  parseBlobLink,
  projectContext,
  projectPackageURL,
  refsDisagreeWithFile,
  sourceRefFor,
  standardLibraryURL,
} from '../page/platform/gitlab-api.js';

const SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

function setLocation(pathname = '/group/project/-/merge_requests/42/diffs') {
  globalThis.location = {
    href: `https://gitlab.example${pathname}`,
    origin: 'https://gitlab.example',
    pathname,
  };
}

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  };
}

function textResponse(body, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  };
}

// An immediate clock: the retry loop's backoff is recorded, never waited on.
function recordingClock() {
  const delays = [];
  return {
    delays,
    clock: { setTimeout: (fn, ms) => { delays.push(ms); fn(); return 0; }, clearTimeout: () => {} },
  };
}

beforeEach(() => {
  setLocation();
  globalThis.document = new Window({ url: globalThis.location.href }).document;
});

// --- Pure helpers ---------------------------------------------------------

test('strips bidi markers and spacing GitLab renders into file titles', () => {
  assert.equal(normalizePath('svc/ snapshot/‎ pkg/search.go'), 'svc/snapshot/pkg/search.go');
  assert.equal(normalizePath('‪pkg/search.go‬'), 'pkg/search.go');
});

test('dirname returns the empty string for a root-level path', () => {
  assert.equal(dirname('svc/snapshot/search.go'), 'svc/snapshot');
  assert.equal(dirname('main.go'), '');
});

test('excludes vendor and testdata trees from project Go paths', () => {
  assert.equal(isProjectGoPath('service/runner.go'), true);
  assert.equal(isProjectGoPath('service/runner_test.go'), true);
  assert.equal(isProjectGoPath('vendor/example.com/lib/runner.go'), false);
  assert.equal(isProjectGoPath('pkg/testdata/broken.go'), false);
  assert.equal(isProjectGoPath('README.md'), false);
});

test('pins standard-library docs to the vendored Go version but not third-party ones', () => {
  assert.equal(standardLibraryURL('net/http'), 'https://pkg.go.dev/net/http@go1.26.5');
  assert.equal(packageDocumentationURL('github.com/gofrs/uuid/v5'), 'https://pkg.go.dev/github.com/gofrs/uuid/v5');
  assert.equal(documentationURL({ status: 'builtin', symbol: 'len' }), 'https://pkg.go.dev/builtin@go1.26.5#len');
  assert.equal(documentationURL({ status: 'standardLibrary', importPath: 'fmt' }), 'https://pkg.go.dev/fmt@go1.26.5');
  assert.equal(documentationURL({ status: 'project', importPath: 'example.com/m/pkg' }), 'https://pkg.go.dev/example.com/m/pkg');
});

test('builds project tree URLs only for commit-pinned refs', () => {
  assert.equal(
    projectPackageURL({ ref: SHA, packagePath: 'svc/snapshot' }),
    `https://gitlab.example/group/project/-/tree/${SHA}/svc/snapshot`,
  );
  // A root package has no path segment to append.
  assert.equal(projectPackageURL({ ref: SHA, packagePath: '' }), `https://gitlab.example/group/project/-/tree/${SHA}`);
  assert.equal(projectPackageURL({ ref: 'main', packagePath: 'svc' }), '');
});

test('parses blob links with branch names that contain slashes', () => {
  assert.deepEqual(
    parseBlobLink({ href: `https://gitlab.example/group/project/-/blob/${SHA}/svc/search.go` }, 'svc/search.go'),
    { ref: SHA, path: 'svc/search.go' },
  );
  assert.deepEqual(
    parseBlobLink({ href: 'https://gitlab.example/group/project/-/blob/caspers/feature/x/svc/search.go' }, 'svc/search.go'),
    { ref: 'caspers/feature/x', path: 'svc/search.go' },
  );
  assert.equal(parseBlobLink({ href: 'https://gitlab.example/group/project/-/tree/main' }), null);
  assert.equal(parseBlobLink(null), null);
});

test('reads project and merge-request context off the current location', () => {
  assert.deepEqual(projectContext(), { project: 'group/project', projectBase: 'https://gitlab.example/group/project' });
  assert.equal(mergeRequestIID(), '42');
  setLocation('/group/project');
  assert.equal(projectContext(), null);
  assert.equal(mergeRequestIID(), '');
});

test('prefers the x-next-page header and falls back to a full page of entries', () => {
  const response = (header) => ({ headers: { get: () => header ?? null } });
  assert.equal(nextPageNumber(response('7'), 2, new Array(100)), 7);
  assert.equal(nextPageNumber(response(), 2, new Array(100)), 3);
  assert.equal(nextPageNumber(response(), 2, new Array(12)), 0);
});

test('detects stale MR refs and picks the side-appropriate source ref', () => {
  const refs = { headSha: SHA, startSha: 'c'.repeat(40), baseSha: 'd'.repeat(40) };
  assert.equal(refsDisagreeWithFile(refs, OTHER_SHA), true);
  assert.equal(refsDisagreeWithFile(refs, SHA), false);
  // A branch name is not a commit, so it can never disagree.
  assert.equal(refsDisagreeWithFile(refs, 'feature/branch'), false);
  assert.equal(sourceRefFor({ ref: OTHER_SHA }, { side: 'new' }, refs), OTHER_SHA);
  assert.equal(sourceRefFor({ ref: OTHER_SHA }, { side: 'old' }, refs), refs.startSha);
  assert.equal(sourceRefFor({ ref: 'feature/branch' }, { side: 'new' }, refs), SHA);
});

test('mapLimit preserves input order while running at most `limit` at a time', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapLimit([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return value * 2;
  });
  assert.deepEqual(result, [2, 4, 6, 8, 10, 12, 14]);
  assert.equal(peak <= 3, true);
});

// --- Injected seams -------------------------------------------------------

test('reads the injected fetch, clock and abort signal per call, not at construction', async () => {
  const seen = [];
  let signal = 'first-signal';
  const { delays, clock } = recordingClock();
  // Constructed before any of the three are given their final values.
  const api = createGitLabApi({
    fetch: (url, options) => { seen.push({ url, signal: options.signal }); return Promise.resolve(textResponse('module example.com/m')); },
    getClock: () => clock,
    getSignal: () => signal,
  });

  await api.fetchSource('go.mod', SHA);
  assert.equal(seen[0].signal, 'first-signal');

  // A teardown/init cycle replaces the AbortController; the next fetch must
  // see the new signal rather than the captured, already-aborted one.
  signal = 'second-signal';
  await api.fetchSource('other.go', SHA);
  assert.equal(seen[1].signal, 'second-signal');
  assert.deepEqual(delays, []);
});

test('sends credentialed requests and lets an explicit signal win over the ambient one', async () => {
  const seen = [];
  const api = createGitLabApi({
    fetch: (url, options) => { seen.push(options); return Promise.resolve(textResponse('ok')); },
    getSignal: () => 'ambient',
  });
  await api.fetchSource('a.go', SHA);
  assert.equal(seen[0].credentials, 'include');
  assert.equal(seen[0].signal, 'ambient');
  await api.fetchSource('b.go', SHA, 'explicit');
  assert.equal(seen[1].signal, 'explicit');
});

// --- Retry policy ---------------------------------------------------------

test('retries retryable statuses with the fixed backoff and gives up after three', async () => {
  const { delays, clock } = recordingClock();
  let calls = 0;
  const api = createGitLabApi({
    fetch: async () => { calls++; return textResponse('rate limited', { status: 429 }); },
    getClock: () => clock,
  });
  const response = await api.fetchWithRetry('https://gitlab.example/x');
  assert.equal(response.status, 429);
  assert.equal(calls, 4, 'one initial attempt plus three retries');
  assert.deepEqual(delays, [200, 800, 2000]);
});

test('does not retry a non-retryable status', async () => {
  const { delays, clock } = recordingClock();
  let calls = 0;
  const api = createGitLabApi({
    fetch: async () => { calls++; return textResponse('nope', { status: 403 }); },
    getClock: () => clock,
  });
  const response = await api.fetchWithRetry('https://gitlab.example/x');
  assert.equal(response.status, 403);
  assert.equal(calls, 1);
  assert.deepEqual(delays, []);
});

test('stops retrying as soon as a retry succeeds', async () => {
  const { delays, clock } = recordingClock();
  const statuses = [503, 200];
  const api = createGitLabApi({
    fetch: async () => textResponse('body', { status: statuses.shift() }),
    getClock: () => clock,
  });
  assert.equal((await api.fetchWithRetry('https://gitlab.example/x')).ok, true);
  assert.deepEqual(delays, [200]);
});

// --- Caches ---------------------------------------------------------------

test('remembers a 404 source path for the session instead of re-requesting it', async () => {
  let calls = 0;
  const api = createGitLabApi({ fetch: async () => { calls++; return textResponse('missing', { status: 404 }); } });
  await assert.rejects(api.fetchSource('gone.go', SHA), /returned 404/);
  await assert.rejects(api.fetchSource('gone.go', SHA), /returned 404/);
  assert.equal(calls, 1, 'the second call is answered from the absent-path cache');
});

test('caches a resolved module path per project+ref, including the empty result', async () => {
  let calls = 0;
  const api = createGitLabApi({
    fetch: async () => { calls++; return textResponse('module example.com/m\n'); },
  });
  assert.equal(await api.modulePathFor(SHA), 'example.com/m');
  assert.equal(await api.modulePathFor(SHA), 'example.com/m');
  assert.equal(calls, 1);
  // A different ref is a different cache entry.
  assert.equal(await api.modulePathFor(OTHER_SHA), 'example.com/m');
  assert.equal(calls, 2);
});

test('caches a failed go.mod lookup as an empty module path rather than retrying it', async () => {
  let calls = 0;
  const api = createGitLabApi({ fetch: async () => { calls++; return textResponse('nope', { status: 404 }); } });
  assert.equal(await api.modulePathFor(SHA), '');
  assert.equal(await api.modulePathFor(SHA), '');
  assert.equal(calls, 1);
});

test('propagates an aborted go.mod lookup instead of caching an empty module path', async () => {
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  const api = createGitLabApi({ fetch: async () => { throw abort; } });
  await assert.rejects(api.modulePathFor(SHA), /aborted/);
});

test('clearModulePaths forces the next lookup back to the network', async () => {
  let calls = 0;
  const api = createGitLabApi({ fetch: async () => { calls++; return textResponse('module example.com/m'); } });
  await api.modulePathFor(SHA);
  api.clearModulePaths();
  await api.modulePathFor(SHA);
  assert.equal(calls, 2);
});

test('rejects a blob download whose ID is not a valid object hash before fetching', async () => {
  let calls = 0;
  const api = createGitLabApi({ fetch: async () => { calls++; return textResponse('x'); } });
  await assert.rejects(api.fetchBlob({ path: 'a.go', blobId: 'nope' }, SHA), /valid blob ID/);
  assert.equal(calls, 0);
});

// --- Merge-request refs ---------------------------------------------------

function graphqlApi(diffRefs, onCall = () => {}) {
  return createGitLabApi({
    fetch: async () => {
      onCall();
      return jsonResponse({ data: { project: { mergeRequest: { diffRefs } } } });
    },
  });
}

test('caches merge-request refs for 15 seconds and re-fetches after clearing', async () => {
  let calls = 0;
  const api = graphqlApi({ headSha: SHA, baseSha: OTHER_SHA }, () => { calls++; });
  assert.deepEqual(await api.mergeRequestRefs(), { headSha: SHA, baseSha: OTHER_SHA });
  await api.mergeRequestRefs();
  assert.equal(calls, 1);
  api.clearMergeRequestRefs();
  await api.mergeRequestRefs();
  assert.equal(calls, 2);
});

test('answers empty refs outside a merge request without calling GraphQL', async () => {
  setLocation('/group/project/-/tree/main');
  let calls = 0;
  const api = graphqlApi({ headSha: SHA }, () => { calls++; });
  assert.deepEqual(await api.mergeRequestRefs(), {});
  assert.equal(calls, 0);
});

test('degrades to empty refs when GraphQL fails rather than rejecting', async () => {
  const api = createGitLabApi({ fetch: async () => { throw new Error('offline'); } });
  assert.deepEqual(await api.mergeRequestRefs(), {});
});

test('re-fetches refs once when the cached head disagrees with the file being resolved', async () => {
  const heads = [SHA, OTHER_SHA];
  let calls = 0;
  const api = createGitLabApi({
    fetch: async () => {
      calls++;
      return jsonResponse({ data: { project: { mergeRequest: { diffRefs: { headSha: heads.shift() ?? OTHER_SHA } } } } });
    },
  });
  // The DOM says the file is pinned to OTHER_SHA; the first cached answer
  // says SHA, so the cache is dropped and re-fetched exactly once.
  assert.deepEqual(await api.mergeRequestRefsForFile({ ref: OTHER_SHA }), { headSha: OTHER_SHA });
  assert.equal(calls, 2);
});

test('mergeRequestHeadRef resets the refs cache AND throws on a non-commit head', async () => {
  let calls = 0;
  // First answer is unusable, second is a real SHA. If the reset half were
  // missing the second call would be served from the 15s cache and also
  // fail; if the throw half were missing the caller would silently proceed.
  const heads = ['', SHA];
  const api = createGitLabApi({
    fetch: async () => {
      calls++;
      return jsonResponse({ data: { project: { mergeRequest: { diffRefs: { headSha: heads.shift() } } } } });
    },
  });
  await assert.rejects(api.mergeRequestHeadRef(), /Unable to determine the MR head commit\./);
  assert.equal(await api.mergeRequestHeadRef(), SHA);
  assert.equal(calls, 2);
});

// --- Blob-view ref resolution ----------------------------------------------

test('blobFileRef returns a SHA ref directly without hitting the network', async () => {
  let calls = 0;
  const api = createGitLabApi({ fetch: async () => { calls++; return jsonResponse({ id: OTHER_SHA }); } });
  assert.deepEqual(await api.blobFileRef({ path: 'a.go', ref: SHA }), { headSha: SHA, baseSha: '', startSha: '' });
  assert.equal(calls, 0);
});

test('blobFileRef resolves a branch name to a full commit SHA via the commits API', async () => {
  const requested = [];
  const api = createGitLabApi({
    fetch: async (url) => { requested.push(url); return jsonResponse({ id: SHA }); },
  });
  assert.deepEqual(await api.blobFileRef({ path: 'a.go', ref: 'main' }), { headSha: SHA, baseSha: '', startSha: '' });
  assert.equal(requested.length, 1);
  assert.equal(
    requested[0],
    'https://gitlab.example/api/v4/projects/group%2Fproject/repository/commits/main',
  );
});

test('blobFileRef memoizes per project+ref, keeping different refs independent', async () => {
  let calls = 0;
  const shaByRef = { main: SHA, develop: OTHER_SHA };
  const api = createGitLabApi({
    fetch: async (url) => { calls++; const ref = decodeURIComponent(url.split('/commits/')[1]); return jsonResponse({ id: shaByRef[ref] }); },
  });
  assert.equal((await api.blobFileRef({ path: 'a.go', ref: 'main' })).headSha, SHA);
  assert.equal((await api.blobFileRef({ path: 'a.go', ref: 'main' })).headSha, SHA);
  assert.equal(calls, 1, 'the second call for the same ref is served from cache');
  assert.equal((await api.blobFileRef({ path: 'a.go', ref: 'develop' })).headSha, OTHER_SHA);
  assert.equal(calls, 2, 'a different ref is a separate cache entry');
});

test('blobFileRef degrades to empty refs on a failing response instead of throwing', async () => {
  const api = createGitLabApi({ fetch: async () => jsonResponse({}, { status: 404 }) });
  assert.deepEqual(await api.blobFileRef({ path: 'a.go', ref: 'main' }), { headSha: '', baseSha: '', startSha: '' });
});

test('blobFileRef degrades to empty refs when fetch itself rejects', async () => {
  const api = createGitLabApi({ fetch: async () => { throw new Error('offline'); } });
  assert.deepEqual(await api.blobFileRef({ path: 'a.go', ref: 'main' }), { headSha: '', baseSha: '', startSha: '' });
});

test('blobFileRef does not cache a failure, so a later call retries the network', async () => {
  let calls = 0;
  const results = [() => jsonResponse({}, { status: 500 }), () => jsonResponse({ id: SHA })];
  const api = createGitLabApi({ fetch: async () => { calls++; return results.shift()(); } });
  assert.deepEqual(await api.blobFileRef({ path: 'a.go', ref: 'main' }), { headSha: '', baseSha: '', startSha: '' });
  assert.deepEqual(await api.blobFileRef({ path: 'a.go', ref: 'main' }), { headSha: SHA, baseSha: '', startSha: '' });
  assert.equal(calls, 2);
});

// --- Pagination -----------------------------------------------------------

test('fetches tree pages concurrently when GitLab reports a total page count', async () => {
  const requested = [];
  const api = createGitLabApi({
    fetch: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      requested.push(page);
      return jsonResponse(
        [{ type: 'blob', path: `pkg/file${page}.go`, id: SHA }],
        { headers: page === 1 ? { 'x-total-pages': '3' } : {} },
      );
    },
  });
  const files = await api.listPackageFiles('pkg', SHA);
  assert.deepEqual(files.map((file) => file.path), ['pkg/file1.go', 'pkg/file2.go', 'pkg/file3.go']);
  assert.deepEqual([...requested].sort(), [1, 2, 3]);
});

test('falls back to sequential x-next-page paging when GitLab omits the total', async () => {
  const nextByPage = { 1: '2', 2: '3' };
  const api = createGitLabApi({
    fetch: async (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return jsonResponse(
        [{ type: 'blob', path: `pkg/file${page}.go`, id: SHA }],
        { headers: nextByPage[page] ? { 'x-next-page': nextByPage[page] } : {} },
      );
    },
  });
  const files = await api.listPackageFiles('pkg', SHA);
  assert.deepEqual(files.map((file) => file.path), ['pkg/file1.go', 'pkg/file2.go', 'pkg/file3.go']);
});

test('rejects a package with more Go files than the indexer will accept', async () => {
  const api = createGitLabApi({
    fetch: async () => jsonResponse(
      Array.from({ length: 201 }, (_value, index) => ({ type: 'blob', path: `pkg/f${index}.go`, id: SHA })),
    ),
  });
  await assert.rejects(api.listPackageFiles('pkg', SHA), /too many Go files/);
});

test('rejects an invalid repository-tree payload instead of returning junk', async () => {
  const api = createGitLabApi({ fetch: async () => jsonResponse({ message: '404 Not Found' }) });
  await assert.rejects(api.listPackageFiles('pkg', SHA), /invalid repository tree response/);
});

test('listProjectFiles filters vendor and testdata out of a recursive listing', async () => {
  const api = createGitLabApi({
    fetch: async () => jsonResponse([
      { type: 'blob', path: 'svc/runner.go', id: SHA },
      { type: 'blob', path: 'vendor/example.com/lib.go', id: SHA },
      { type: 'blob', path: 'svc/testdata/broken.go', id: SHA },
      { type: 'blob', path: 'README.md', id: SHA },
      { type: 'tree', path: 'svc', id: SHA },
    ]),
  });
  assert.deepEqual((await api.listProjectFiles(SHA)).map((file) => file.path), ['svc/runner.go']);
});

test('de-duplicates and filters merge-request changed files, skipping deletions', async () => {
  const api = createGitLabApi({
    fetch: async () => jsonResponse([
      { new_path: 'svc/a.go' },
      { new_path: 'svc/a.go' },
      { new_path: 'svc/gone.go', deleted_file: true },
      { new_path: 'docs/readme.md' },
      { new_path: 'vendor/x.go' },
    ]),
  });
  assert.deepEqual(await api.listMergeRequestChangedFiles(), ['svc/a.go']);
});

test('reports the merge-request context as unavailable outside a merge request', async () => {
  setLocation('/group/project/-/tree/main');
  const api = createGitLabApi({ fetch: async () => jsonResponse([]) });
  await assert.rejects(api.listMergeRequestChangedFiles(), /merge request context is unavailable/);
});

// --- Blob search ----------------------------------------------------------

test('reports a complete blob search when GitLab returns a partial final page', async () => {
  const api = createGitLabApi({
    fetch: async () => jsonResponse([{ path: 'svc/a.go' }, { path: 'docs/b.md' }]),
  });
  assert.deepEqual(await api.searchProjectBlobPaths('Run', SHA), { paths: ['svc/a.go'], status: 'complete' });
});

test('reports a limited blob search once maxPaths is reached', async () => {
  const api = createGitLabApi({
    fetch: async () => jsonResponse(
      Array.from({ length: 100 }, (_value, index) => ({ path: `svc/f${index}.go` })),
      { headers: { 'x-next-page': '2' } },
    ),
  });
  const result = await api.searchProjectBlobPaths('Run', SHA, { maxPaths: 3 });
  assert.equal(result.status, 'limited');
  assert.equal(result.paths.length, 3);
});

test('reports an unavailable blob search on a failing response, and keeps partial hits as limited', async () => {
  const failing = createGitLabApi({ fetch: async () => jsonResponse({}, { status: 403 }) });
  assert.deepEqual(await failing.searchProjectBlobPaths('Run', SHA), { paths: [], status: 'unavailable' });

  const responses = [
    jsonResponse([{ path: 'svc/a.go' }], { headers: { 'x-next-page': '2' } }),
    jsonResponse({}, { status: 500 }),
  ];
  const partial = createGitLabApi({ fetch: async () => responses.shift() });
  assert.deepEqual(await partial.searchProjectBlobPaths('Run', SHA), { paths: ['svc/a.go'], status: 'limited' });
});

test('propagates an aborted blob search instead of degrading it to a status', async () => {
  const api = createGitLabApi({
    fetch: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); },
  });
  await assert.rejects(api.searchProjectBlobPaths('Run', SHA), { name: 'AbortError' });
});
