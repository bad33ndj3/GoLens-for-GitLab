import assert from 'node:assert/strict';
import test from 'node:test';

import { commitSha, repositoryKey, repositoryPath, sourceIdentity } from '../../src/domain.ts';
import { createGitLabHost, reviewDescriptor } from '../../src/gitlab-host/index.ts';

const headSha = commitSha('a'.repeat(40));
const review = reviewDescriptor({
  identity: {
    origin: 'https://gitlab.example',
    repositoryKey: repositoryKey('https://gitlab.example/group/project'),
    projectPath: repositoryPath('group/project'),
    mergeRequestIid: '42',
    headSha,
  },
  refs: { baseSha: 'b'.repeat(40), startSha: 'c'.repeat(40) },
});

test('bound host reads validated commit-pinned source without exposing GitLab payloads', async () => {
  const requests = [];
  const host = createGitLabHost({
    origin: review.identity.origin,
    fetch: async (input, init) => {
      requests.push({ input: String(input), init });
      return new Response(JSON.stringify({
        file_path: 'pkg/main.go',
        blob_id: 'd'.repeat(40),
        content: Buffer.from('package pkg\n').toString('base64'),
        encoding: 'base64',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const source = sourceIdentity({ repositoryKey: review.identity.repositoryKey, commitSha: headSha });

  const outcome = await host.connect(review).read({
    operation: 'source-file', source, path: repositoryPath('pkg/main.go'),
  }, new AbortController().signal);

  assert.deepEqual(outcome, {
    kind: 'ok',
    value: { path: repositoryPath('pkg/main.go'), contentId: 'd'.repeat(40), text: 'package pkg\n' },
  });
  assert.equal(requests[0].input, `https://gitlab.example/api/v4/projects/group%2Fproject/repository/files/pkg%2Fmain.go?ref=${headSha}`);
  assert.equal(requests[0].init.credentials, 'include');
});

test('bound host rejects a source identity from another repository', async () => {
  const host = createGitLabHost({ origin: review.identity.origin, fetch: async () => new Response() });
  const other = sourceIdentity({ repositoryKey: repositoryKey('https://gitlab.example/other/project'), commitSha: headSha });
  await assert.rejects(host.connect(review).read({
    operation: 'source-file', source: other, path: repositoryPath('pkg/main.go'),
  }, new AbortController().signal), /source identity/i);
});

