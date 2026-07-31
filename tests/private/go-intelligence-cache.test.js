import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { commitSha, repositoryKey, repositoryPath, sourceIdentity } from '../../src/domain.ts';
import { GoIntelligenceCache } from '../../src/go-intelligence/cache.ts';

function source(repository, sha = 'a') {
  return sourceIdentity({ repositoryKey: repositoryKey(repository), commitSha: commitSha(sha.repeat(40)) });
}

function file(path, value) {
  return {
    path: repositoryPath(path),
    contentId: createHash('sha1').update(`blob ${Buffer.byteLength(value)}\0`).update(value).digest('hex'),
    source: value,
  };
}

function manifest(identity, files) {
  return {
    source: identity,
    modulePath: 'example.com/project',
    coverage: { scope: 'full-project', complete: true, packageCount: 1, packagePaths: ['sample'] },
    files: files.map(({ path, contentId }) => ({ path, contentId })),
  };
}

test('content-addressed blobs are repository-isolated and corruption invalidates only its manifest', async () => {
  const cache = new GoIntelligenceCache(undefined);
  const first = source('gitlab.example/group/first');
  const second = source('gitlab.example/group/second', 'b');
  const shared = file('sample/main.go', 'package sample\n');

  await cache.stage(first, [shared]);
  await cache.publish(manifest(first, [shared]));
  assert.deepEqual(await cache.prepare(manifest(second, [shared])), {
    cached: 0, missing: [{ path: shared.path, contentId: shared.contentId }],
  });

  cache.corrupt(shared.contentId);
  assert.equal(await cache.restore(first), null);
  assert.deepEqual(await cache.inspect(), {
    sourceBlobs: 0, packageManifests: 0, projectManifests: 0, bytes: 0,
  });
});

test('rejects fetched source that does not match its Git identity', async () => {
  const cache = new GoIntelligenceCache(undefined);
  const identity = source('gitlab.example/group/project');
  const expected = file('sample/main.go', 'package sample\n');
  await assert.rejects(cache.stage(identity, [{ ...expected, source: 'package changed\n' }]), /does not match/);
});

test('retains package and project manifests for one Source identity', async () => {
  const cache = new GoIntelligenceCache(undefined);
  const identity = source('gitlab.example/group/project');
  const packageFile = file('sample/main.go', 'package sample\n');
  const projectFile = file('other/main.go', 'package other\n');
  await cache.stage(identity, [packageFile, projectFile]);
  await cache.publish({
    ...manifest(identity, [packageFile]),
    coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: ['sample'] },
  });
  await cache.publish(manifest(identity, [packageFile, projectFile]));

  assert.deepEqual(await cache.inspect(identity), {
    sourceBlobs: 2, packageManifests: 1, projectManifests: 1,
    bytes: Buffer.byteLength(packageFile.source) + Buffer.byteLength(projectFile.source),
  });
  assert.equal((await cache.restore(identity)).coverage.scope, 'full-project');
});

test('restores the manifest that satisfies the requested Coverage proof', async () => {
  const cache = new GoIntelligenceCache(undefined);
  const identity = source('gitlab.example/group/project');
  const shared = file('sample/main.go', 'package sample\n');
  await cache.stage(identity, [shared]);
  for (const queryFingerprint of ['query-one', 'query-two']) {
    await cache.publish({
      ...manifest(identity, [shared]),
      coverage: {
        scope: 'complete-project-search', complete: true, packageCount: 1, packagePaths: ['sample'],
        queryFingerprint, searchStrategy: 'identifier',
      },
    });
  }
  const restored = await cache.restore(identity, shared.path, (value) => value.scope === 'complete-project-search'
    && value.queryFingerprint === 'query-two');
  assert.equal(restored.coverage.queryFingerprint, 'query-two');
});
