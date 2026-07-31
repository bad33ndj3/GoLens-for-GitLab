import assert from 'node:assert/strict';
import test from 'node:test';

const { commitSha, repositoryKey, repositoryPath } = await import('../../src/domain.ts');
const { startReviewSession } = await import('../../src/review-session/index.ts');

const source = { repositoryKey: repositoryKey('gitlab.example/group/project'), commitSha: commitSha('a'.repeat(40)) };
const review = Object.freeze({
  identity: Object.freeze({ origin: 'https://gitlab.example', repositoryKey: source.repositoryKey, projectPath: repositoryPath('group/project'), mergeRequestIid: '42', headSha: source.commitSha }),
  refs: Object.freeze({ baseSha: commitSha('b'.repeat(40)), startSha: commitSha('c'.repeat(40)) }),
});

function events() {
  const queue = [];
  let resume;
  let closed = false;
  return {
    emit(value) { if (resume) { const next = resume; resume = undefined; next(value); } else queue.push(value); },
    close() { closed = true; resume?.(null); },
    iterable: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          if (queue.length) yield queue.shift();
          else {
            const value = await new Promise((resolve) => { resume = resolve; });
            if (closed) return;
            yield value;
          }
        }
      },
    },
  };
}

test('Review Session rejects a late semantic result after its Host revision changes', async () => {
  const stream = events();
  const projections = [];
  let resolveQuery;
  const session = startReviewSession({
    host: {
      review,
      events: (signal) => { signal.addEventListener('abort', () => stream.close(), { once: true }); return stream.iterable; },
      apply: (projection) => { projections.push(projection); return { kind: 'applied' }; },
      perform: async () => ({ kind: 'completed' }),
      read: async () => ({ kind: 'unavailable', reason: 'not-rendered' }),
    },
    intelligence: { query: () => new Promise((resolve) => { resolveQuery = resolve; }) },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  await new Promise((resolve) => setTimeout(resolve));
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target: { revision: 1, token: 'target', path: repositoryPath('pkg/main.go'), side: 'new', line: 2, identifier: 'Target', source } });
  await new Promise((resolve) => setTimeout(resolve));
  stream.emit({ type: 'host-revised', revision: 2, surface: 'changes' });
  resolveQuery({ status: 'resolved', isDefinition: false, source, snapshot: '1', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: [] }, symbol: { signature: 'func Target()', identity: { source, path: repositoryPath('pkg/main.go'), line: 2, column: 1, kind: 'function', name: 'Target' }, documentation: '', documentationLine: 1, packageName: 'pkg', packagePath: 'pkg' } });
  await new Promise((resolve) => setTimeout(resolve));

  assert.equal(projections.at(-1).revision, 2);
  assert.equal(projections.at(-1).status, undefined);
  await session.stop();
});
