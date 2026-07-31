import assert from 'node:assert/strict';
import test from 'node:test';

import { repositoryPath } from '../../src/domain.ts';
import { normalizeGitLabOrigin } from '../../src/gitlab-host/access.ts';
import { createGitLabRepository } from '../../src/gitlab-host/repository.ts';

const origin = 'https://gitlab.example';
const sha = 'a'.repeat(40);
const descriptor = Object.freeze({
  identity: Object.freeze({ origin, repositoryKey: `${origin}/group/project`, projectPath: 'group/project', mergeRequestIid: '42', headSha: sha }),
  refs: Object.freeze({ baseSha: 'b'.repeat(40), startSha: 'c'.repeat(40) }),
});

function response(value, { status = 200, next = '' } = {}) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'x-next-page': next } });
}

test('resolves and validates immutable review identities from private GitLab refs', async () => {
  let request;
  const repository = createGitLabRepository({ origin, fetch: async (input, init) => {
    request = { input: String(input), init };
    return response({ data: { project: { mergeRequest: { diffRefs: {
      headSha: sha, baseSha: 'b'.repeat(40), startSha: 'c'.repeat(40),
    } } } } });
  } });

  const outcome = await repository.resolveReview({ projectPath: 'group/project', mergeRequestIid: '42' }, new AbortController().signal);
  assert.equal(outcome.kind, 'ok');
  assert.equal(outcome.value.identity.repositoryKey, `${origin}/group/project`);
  assert.equal(outcome.value.identity.headSha, sha);
  assert.equal(request.input, `${origin}/api/graphql`);
  assert.equal(request.init.credentials, 'include');
  assert.deepEqual(JSON.parse(request.init.body).variables, { fullPath: 'group/project', iid: '42' });
});

test('repository listing follows headers, uses the short-page fallback, and enforces package bounds', async () => {
  const requests = [];
  const repository = createGitLabRepository({ origin, fetch: async (input) => {
    requests.push(String(input));
    const page = Number(new URL(String(input)).searchParams.get('page'));
    if (page === 1) return response(Array.from({ length: 100 }, (_value, index) => ({ type: 'blob', path: `pkg/f${index}.go`, id: String(index).padStart(40, '0') })), { next: '2' });
    return response([{ type: 'blob', path: 'pkg/final.go', id: 'f'.repeat(40) }]);
  } });
  const bound = repository.bind(descriptor);
  const result = await bound.read({
    operation: 'go-files', source: { repositoryKey: `${origin}/group/project`, commitSha: sha },
    scope: { kind: 'package', path: repositoryPath('pkg') },
  }, new AbortController().signal);
  assert.equal(result.kind, 'ok');
  assert.equal(result.value.files.length, 101);
  assert.equal(requests.length, 2);

  const tooLarge = createGitLabRepository({ origin, fetch: async () => response(
    Array.from({ length: 100 }, (_value, index) => ({ type: 'blob', path: `pkg/f${index}.go`, id: 'd'.repeat(40) })),
  ) }).bind(bound.review);
  assert.deepEqual(await tooLarge.read({
    operation: 'go-files', source: { repositoryKey: `${origin}/group/project`, commitSha: sha },
    scope: { kind: 'package', path: repositoryPath('pkg') },
  }, new AbortController().signal), { kind: 'limit-exceeded', limit: { name: 'package-files', maximum: 200 } });
});

test('project search reports complete, limited, and unavailable coverage honestly', async () => {
  let mode = 'complete';
  const repository = createGitLabRepository({ origin, fetch: async () => {
    if (mode === 'unavailable') throw new TypeError('offline');
    return response(mode === 'limited' ? [{ path: 'pkg/main.go' }, { path: 'pkg/other.go' }] : [{ path: 'pkg/main.go' }]);
  } });
  const bound = repository.bind(descriptor);
  const query = {
    operation: 'search-go-paths', source: { repositoryKey: `${origin}/group/project`, commitSha: sha }, search: 'Run',
  };
  assert.deepEqual(await bound.read(query, new AbortController().signal), {
    kind: 'ok', value: { paths: [repositoryPath('pkg/main.go')], coverage: 'complete' },
  });
  mode = 'limited';
  assert.deepEqual(await bound.read({ ...query, limits: { pages: 1, paths: 1 } }, new AbortController().signal), {
    kind: 'ok', value: { paths: [repositoryPath('pkg/main.go')], coverage: 'limited', reason: 'path-limit' },
  });
  mode = 'unavailable';
  assert.deepEqual(await bound.read(query, new AbortController().signal), {
    kind: 'ok', value: { paths: [], coverage: 'unavailable', reason: 'offline' },
  });
});

test('exact-origin validation rejects wildcards, credentials, and cross-origin bindings', () => {
  assert.equal(normalizeGitLabOrigin('gitlab.example/group'), origin);
  assert.throws(() => normalizeGitLabOrigin('https://*'), /wildcards/);
  assert.throws(() => normalizeGitLabOrigin('https://user:secret@gitlab.example'), /credentials/);
  const repository = createGitLabRepository({ origin, fetch: async () => response({}) });
  assert.throws(() => repository.bind({
    identity: { origin: 'https://evil.example', repositoryKey: `${origin}/group/project`, projectPath: 'group/project', mergeRequestIid: '42', headSha: sha },
    refs: { baseSha: 'b'.repeat(40), startSha: 'c'.repeat(40) },
  }), /origin/i);
});

test('review status normalizes approvals and paginated unresolved discussions', async () => {
  const repository = createGitLabRepository({ origin, fetch: async (input) => {
    const url = String(input);
    if (url.endsWith('/approvals')) return response({ state: 'merged', approved_by: [
      { user: { id: 17 } }, { user: { username: 'reviewer' } }, { nope: true },
    ] });
    const page = Number(new URL(url).searchParams.get('page'));
    return response(page === 1
      ? [{ notes: [{ resolvable: true, resolved: false }] }]
      : [{ notes: [{ resolvable: true, resolved: true }] }], { next: page === 1 ? '2' : '' });
  } });
  const bound = repository.bind(descriptor);
  assert.deepEqual(await bound.read({ operation: 'review-status' }, new AbortController().signal), {
    kind: 'ok', value: { state: 'merged', approvers: ['17', 'reviewer'], unresolvedDiscussions: 1 },
  });
});

test('maps routine HTTP failures but rejects malformed payloads and pagination', async () => {
  const source = { repositoryKey: `${origin}/group/project`, commitSha: sha };
  for (const [status, reason] of [[401, 'authentication-required'], [403, 'forbidden'], [404, 'not-found'], [429, 'rate-limited'], [500, 'upstream-unavailable']]) {
    const failed = createGitLabRepository({ origin, fetch: async () => response({}, { status }) }).bind(descriptor);
    assert.deepEqual(await failed.read({ operation: 'source-file', source, path: repositoryPath('main.go') }, new AbortController().signal), {
      kind: 'unavailable', reason,
    });
  }

  const malformed = createGitLabRepository({ origin, fetch: async () => response({ blob_id: 'bad' }) }).bind(descriptor);
  await assert.rejects(malformed.read({ operation: 'source-file', source, path: repositoryPath('main.go') }, new AbortController().signal), /invalid repository file/i);

  const looping = createGitLabRepository({ origin, fetch: async () => response([], { next: '1' }) }).bind(descriptor);
  await assert.rejects(looping.read({
    operation: 'go-files', source, scope: { kind: 'package', path: repositoryPath('pkg') },
  }, new AbortController().signal), /invalid pagination/i);

  const malformedPagination = createGitLabRepository({ origin, fetch: async () => response([], { next: 'later' }) }).bind(descriptor);
  await assert.rejects(malformedPagination.read({
    operation: 'go-files', source, scope: { kind: 'package', path: repositoryPath('pkg') },
  }, new AbortController().signal), /invalid pagination/i);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(malformed.read({
    operation: 'source-file', source, path: repositoryPath('main.go'),
  }, controller.signal), { name: 'AbortError' });
});
