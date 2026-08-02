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

const tick = () => new Promise((resolve) => setTimeout(resolve));

function hostFor(stream, { projections = [], actions = [], reads = [], actionOutcomes = [] } = {}) {
  return {
    review,
    events: (signal) => { signal.addEventListener('abort', () => stream.close(), { once: true }); return stream.iterable; },
    apply: (projection) => { projections.push(projection); return { kind: 'applied' }; },
    perform: async (action, signal) => {
      actions.push(action);
      const outcome = actionOutcomes.shift();
      return typeof outcome === 'function' ? outcome(action, signal) : outcome || { kind: 'completed' };
    },
    read: async (request) => reads.shift()?.(request) || { kind: 'unavailable', reason: 'not-rendered' },
  };
}

test('Review Session rejects a late semantic result after its Host revision changes', async () => {
  const stream = events();
  const projections = [];
  const actions = [];
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

test('Review Session waits for fullscreen confirmation and reconciles the complete projection', async () => {
  const stream = events();
  const projections = [];
  const actions = [];
  const session = startReviewSession({
    host: hostFor(stream, { projections, actions }),
    intelligence: { query: async () => ({ status: 'missing', reason: 'identifier', source, snapshot: '1', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: [] } }) },
    preferences: { enabled: true, hideGeneratedFiles: true },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'toggle-focus' });
  await tick();
  assert.equal(projections.at(-1).focusMode, false);
  assert.equal(actions.at(-1).action, 'set-fullscreen');
  assert.equal(actions.at(-1).active, true);

  stream.emit({ type: 'fullscreen-changed', revision: 1, active: true });
  await tick();
  assert.equal(projections.at(-1).focusMode, true);
  assert.equal(projections.at(-1).hideGeneratedFiles, true);
  assert.deepEqual(projections.at(-1).controls.map(({ command }) => command), [
    'toggle-enabled', 'toggle-focus', 'cache-related', 'open-bookmarks',
  ]);
  stream.emit({ type: 'host-revised', revision: 2, surface: 'changes' });
  await tick();
  assert.equal(projections.at(-1).focusMode, true, 'DOM reconciliation cannot end browser-confirmed focus');
  stream.emit({ type: 'intent', revision: 2, command: 'toggle-enabled' });
  await tick();
  assert.equal(projections.at(-1).focusMode, true, 'disablement requests fullscreen exit but waits for confirmation');
  stream.emit({ type: 'fullscreen-changed', revision: 2, active: false });
  await tick();
  assert.equal(projections.at(-1).focusMode, false);
  await session.stop();
});

test('Review Session runs related Coverage and exposes monotonic progress', async () => {
  const stream = events();
  const projections = [];
  const coverageRequests = [];
  const session = startReviewSession({
    host: hostFor(stream, { projections, reads: [() => ({ kind: 'ok', value: { files: [{ path: repositoryPath('pkg/main.go'), contentId: 'blob' }] } })] }),
    intelligence: {
      query: async () => assert.fail('no semantic query expected'),
      async ensureCoverage(request, progress) {
        coverageRequests.push(request);
        progress({ phase: 'fetching', completed: 1, total: 2, cached: 0, downloaded: 1, packageCount: 1 });
        progress({ phase: 'ready', completed: 2, total: 2, cached: 0, downloaded: 2, packageCount: 1 });
        return { status: 'ready', source, snapshot: '7', coverage: { scope: 'indexed-packages', complete: true, packageCount: 1, packagePaths: ['pkg'] } };
      },
    },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'cache-related' });
  await tick();
  await tick();

  assert.deepEqual(coverageRequests, [{ goal: 'related-review', changedPaths: [repositoryPath('pkg/main.go')] }]);
  assert.ok(projections.some(({ status }) => /1 of 2/.test(status || '')));
  assert.match(projections.at(-1).status, /ready/i);
  assert.equal(projections.at(-1).controls[2].busy, false);
  await session.stop();
});

test('Review Session completes an insufficient semantic query and keeps cancellation retryable', async () => {
  const stream = events();
  const projections = [];
  const coverageRequests = [];
  let queryCount = 0;
  let firstCoverageSignal;
  const target = { revision: 1, token: 'target', path: repositoryPath('pkg/main.go'), side: 'new', line: 2, identifier: 'Target', source };
  const session = startReviewSession({
    host: hostFor(stream, { projections }),
    intelligence: {
      async query(request) {
        queryCount += 1;
        const context = { source, snapshot: String(queryCount), coverage: { scope: 'current-package', complete: false, packageCount: 1, packagePaths: ['pkg'] } };
        if (queryCount === 1) return { ...context, status: 'coverage-insufficient', required: 'complete-project-search', reason: 'More packages may contain the symbol.' };
        return { ...context, status: 'resolved', isDefinition: true, symbol: { signature: 'func Target()', identity: { source, path: request.path, line: request.line, column: request.column, kind: 'function', name: 'Target' }, documentation: '', documentationLine: 1, packageName: 'pkg', packagePath: 'pkg' } };
      },
      ensureCoverage(request, _progress, signal) {
        coverageRequests.push(request);
        if (coverageRequests.length === 1) {
          firstCoverageSignal = signal;
          return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
        }
        return Promise.resolve({ status: 'ready', source, snapshot: '2', coverage: { scope: 'complete-project-search', queryFingerprint: 'target', searchStrategy: 'code-search', complete: true, packageCount: 2, packagePaths: ['pkg', 'other'] } });
      },
    },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target });
  await tick();
  assert.equal(projections.at(-1).surface.actions[0].id, 'complete-coverage');
  stream.emit({ type: 'intent', revision: 1, command: 'surface-action', actionId: 'complete-coverage' });
  await tick();
  stream.emit({ type: 'intent', revision: 1, command: 'surface-action', actionId: 'cancel-coverage' });
  await tick();
  assert.equal(firstCoverageSignal.aborted, true);
  assert.equal(projections.at(-1).surface.actions[0].id, 'complete-coverage');
  stream.emit({ type: 'intent', revision: 1, command: 'surface-action', actionId: 'complete-coverage' });
  await tick();
  await tick();

  assert.deepEqual(coverageRequests, [
    { goal: 'complete-query', query: { operation: 'resolve-symbol', path: target.path, line: target.line, column: 1, identifier: 'Target' } },
    { goal: 'complete-query', query: { operation: 'resolve-symbol', path: target.path, line: target.line, column: 1, identifier: 'Target' } },
  ]);
  assert.equal(projections.at(-1).status, 'func Target()');
  await session.stop();
});

test('Review Session silently indexes the current package and retries the first semantic query', async () => {
  const stream = events();
  const projections = [];
  const coverageRequests = [];
  let queryCount = 0;
  const target = { revision: 1, token: 'target', path: repositoryPath('pkg/main.go'), side: 'new', line: 2, identifier: 'Target', source };
  const session = startReviewSession({
    host: hostFor(stream, { projections }),
    intelligence: {
      async query(request) {
        queryCount += 1;
        const context = { source, snapshot: String(queryCount), coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: ['pkg'] } };
        if (queryCount === 1) return { ...context, status: 'coverage-insufficient', required: 'current-package', reason: 'No semantic snapshot is published.' };
        return { ...context, status: 'resolved', isDefinition: true, symbol: { signature: 'func Target()', identity: { source, path: request.path, line: request.line, column: request.column, kind: 'function', name: 'Target' }, documentation: '', documentationLine: 1, packageName: 'pkg', packagePath: 'pkg' } };
      },
      async ensureCoverage(request) {
        coverageRequests.push(request);
        return { status: 'ready', source, snapshot: '2', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: ['pkg'] } };
      },
    },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target });
  await tick();
  await tick();
  await tick();

  assert.deepEqual(coverageRequests, [{ goal: 'current-package', packagePath: 'pkg' }]);
  assert.equal(queryCount, 2);
  assert.equal(projections.at(-1).surface?.title, 'Target');
  assert.equal(projections.at(-1).surface?.symbol?.signature, 'func Target()');
  await session.stop();
});

test('Review Session clears the Coverage lock and accepts a fresh hover after an internal Coverage abort', async () => {
  const stream = events();
  const projections = [];
  let queryCount = 0;
  const target = { revision: 1, token: 'target', path: repositoryPath('pkg/main.go'), side: 'new', line: 2, identifier: 'Target', source };
  const session = startReviewSession({
    host: hostFor(stream, { projections }),
    intelligence: {
      async query(request) {
        queryCount += 1;
        const context = { source, snapshot: String(queryCount), coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: ['pkg'] } };
        if (queryCount === 1) return { ...context, status: 'coverage-insufficient', required: 'current-package', reason: 'No semantic snapshot is published.' };
        return { ...context, status: 'resolved', isDefinition: true, symbol: { signature: 'func Target()', identity: { source, path: request.path, line: request.line, column: request.column, kind: 'function', name: 'Target' }, documentation: '', documentationLine: 1, packageName: 'pkg', packagePath: 'pkg' } };
      },
      async ensureCoverage() { throw new DOMException('Aborted', 'AbortError'); },
    },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target });
  await tick();
  await tick();

  assert.equal(queryCount, 1, 'the internally-timed-out Coverage attempt must not silently vanish');
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target: { ...target, token: 'target2', line: 3, identifier: 'Target2' } });
  await tick();
  assert.equal(queryCount, 2, 'a hover-target arriving after the Coverage lock clears must start a fresh query');
  await session.stop();
});

test('Review Session redirects a pending Coverage retry to the latest hover target', async () => {
  const stream = events();
  const projections = [];
  const coverageRequests = [];
  let queryCount = 0;
  let snapshot = '1';
  const targetA = { revision: 1, token: 'a', path: repositoryPath('pkg/a.go'), side: 'new', line: 2, identifier: 'A', source };
  const targetB = { revision: 1, token: 'b', path: repositoryPath('pkg/b.go'), side: 'new', line: 5, identifier: 'B', source };
  const session = startReviewSession({
    host: hostFor(stream, { projections }),
    intelligence: {
      async query(request) {
        queryCount += 1;
        const context = { source, snapshot, coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: ['pkg'] } };
        if (queryCount === 1) return { ...context, status: 'coverage-insufficient', required: 'current-package', reason: 'No semantic snapshot is published.' };
        return { ...context, status: 'resolved', isDefinition: true, symbol: { signature: `func ${request.identifier}()`, identity: { source, path: request.path, line: request.line, column: request.column, kind: 'function', name: request.identifier }, documentation: '', documentationLine: 1, packageName: 'pkg', packagePath: 'pkg' } };
      },
      ensureCoverage(request, _progress, signal) {
        coverageRequests.push(request);
        if (coverageRequests.length === 1) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
        snapshot = '9';
        return Promise.resolve({ status: 'ready', source, snapshot, coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: ['pkg'] } });
      },
    },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target: targetA });
  await tick();
  assert.deepEqual(coverageRequests[0], { goal: 'current-package', packagePath: 'pkg/a.go'.slice(0, 'pkg/a.go'.lastIndexOf('/')) });

  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target: targetB });
  await tick();
  await tick();

  assert.equal(coverageRequests.length, 2, 'the redirect must cancel the first Coverage attempt and start a second one for B');
  assert.deepEqual(coverageRequests[1], { goal: 'current-package', packagePath: 'pkg/b.go'.slice(0, 'pkg/b.go'.lastIndexOf('/')) });
  assert.equal(queryCount, 2, 'only the redirected target must be resolved, not the original A hover');
  assert.equal(projections.at(-1).surface?.title, 'B');
  assert.equal(projections.at(-1).surface?.symbol?.signature, 'func B()');
  await session.stop();
});

test('Review Session anchors the hover popover to the pointer coordinates from the hover intent', async () => {
  const stream = events();
  const projections = [];
  const target = { revision: 1, token: 'target', path: repositoryPath('pkg/main.go'), side: 'new', line: 2, identifier: 'Target', source };
  const session = startReviewSession({
    host: hostFor(stream, { projections }),
    intelligence: {
      async query(request) {
        return { source, snapshot: '1', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: ['pkg'] },
          status: 'resolved', isDefinition: true, symbol: { signature: 'func Target()', identity: { source, path: request.path, line: request.line, column: request.column, kind: 'function', name: 'Target' }, documentation: '', documentationLine: 1, packageName: 'pkg', packagePath: 'pkg' } };
      },
    },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target, clientX: 210, clientY: 340 });
  await tick();

  assert.deepEqual(projections.at(-1).surface?.anchor, { x: 210, y: 340 });
  await session.stop();
});

test('Review Session recovers a hover that arrived while a click-driven query was in flight', async () => {
  const stream = events();
  const projections = [];
  let queryCount = 0;
  let resolveFirst;
  const targetA = { revision: 1, token: 'a', path: repositoryPath('pkg/a.go'), side: 'new', line: 2, identifier: 'A', source };
  const targetB = { revision: 1, token: 'b', path: repositoryPath('pkg/b.go'), side: 'new', line: 5, identifier: 'B', source };
  const session = startReviewSession({
    host: hostFor(stream, { projections }),
    intelligence: {
      query(request) {
        queryCount += 1;
        if (queryCount === 1) {
          return new Promise((resolve) => { resolveFirst = () => resolve({ source, snapshot: '1', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: ['pkg'] }, status: 'missing' }); });
        }
        return Promise.resolve({ source, snapshot: '1', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: ['pkg'] },
          status: 'resolved', isDefinition: true, symbol: { signature: `func ${request.identifier}()`, identity: { source, path: request.path, line: request.line, column: request.column, kind: 'function', name: request.identifier }, documentation: '', documentationLine: 1, packageName: 'pkg', packagePath: 'pkg' } });
      },
    },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'select-target', target: targetA });
  await tick();
  assert.equal(queryCount, 1);

  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target: targetB, clientX: 50, clientY: 60 });
  await tick();
  assert.equal(queryCount, 1, 'the hover must not start a query while the click-driven query is still in flight');

  resolveFirst();
  await tick();
  await tick();

  assert.equal(queryCount, 2, 'the pending hover must fire once the blocking query completes');
  assert.equal(projections.at(-1).surface?.title, 'B');
  assert.deepEqual(projections.at(-1).surface?.anchor, { x: 50, y: 60 });
  await session.stop();
});

test('Review Session does not let hover supersede semantic navigation', async () => {
  const stream = events();
  let navigationSignal;
  let queries = 0;
  const target = { revision: 1, token: 'target', path: repositoryPath('pkg/main.go'), side: 'new', line: 2, identifier: 'Target', source };
  const session = startReviewSession({
    host: hostFor(stream),
    intelligence: {
      query(_request, signal) {
        queries += 1;
        navigationSignal = signal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      },
    },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'activate-target', target });
  await tick();
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target: { ...target, token: 'hover' } });
  await tick();

  assert.equal(queries, 1);
  assert.equal(navigationSignal.aborted, false);
  await session.stop();
});

test('Review Session cancels query Coverage when a newer semantic intent supersedes it', async () => {
  const stream = events();
  const projections = [];
  let queryCount = 0;
  let coverageSignal;
  const target = { revision: 1, token: 'target', path: repositoryPath('pkg/main.go'), side: 'new', line: 2, identifier: 'Target', source };
  const session = startReviewSession({
    host: hostFor(stream, { projections }),
    intelligence: {
      async query(request) {
        queryCount += 1;
        const context = { source, snapshot: '1', coverage: { scope: 'current-package', complete: false, packageCount: 1, packagePaths: ['pkg'] } };
        if (queryCount === 1) return { ...context, status: 'coverage-insufficient', required: 'complete-project-search', reason: 'Incomplete.' };
        return { ...context, status: 'resolved', isDefinition: false, symbol: { signature: 'func NewIntent()', identity: { source, path: request.path, line: request.line, column: request.column, kind: 'function', name: 'NewIntent' }, documentation: '', documentationLine: 1, packageName: 'pkg', packagePath: 'pkg' } };
      },
      ensureCoverage(_request, _progress, signal) {
        coverageSignal = signal;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
      },
    },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target });
  await tick();
  stream.emit({ type: 'intent', revision: 1, command: 'surface-action', actionId: 'complete-coverage' });
  await tick();
  stream.emit({ type: 'intent', revision: 1, command: 'activate-target', target: { ...target, token: 'new-intent', identifier: 'NewIntent' } });
  await tick();

  assert.equal(coverageSignal.aborted, true);
  assert.equal(projections.at(-1).controls[2].busy, false);
  assert.equal(projections.at(-1).status, undefined);
  await session.stop();
});

test('Review Session loads and toggles private MR-local bookmarks through its port', async () => {
  const stream = events();
  const projections = [];
  const toggles = [];
  const record = {
    id: 'one', createdAt: 1,
    scope: { origin: review.identity.origin, project: review.identity.projectPath, mergeRequest: '42', headSha: source.commitSha },
    location: { path: repositoryPath('pkg/main.go'), side: 'new', startLine: 2, endLine: 2 },
    anchor: { symbol: 'Target', selectionHash: '', beforeHash: '', afterHash: '' },
  };
  const oldRecord = { ...record, id: 'old', location: { ...record.location, path: repositoryPath('pkg/old.go'), side: 'old', startLine: 7, endLine: 7 } };
  const session = startReviewSession({
    host: hostFor(stream, { projections }),
    intelligence: { query: async () => ({ status: 'missing', reason: 'identifier', source, snapshot: '1', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: [] } }) },
    bookmarks: {
      list: async () => [record, oldRecord],
      toggle: async (input) => { toggles.push(input); return { action: 'added', record }; },
    },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });
  const target = { revision: 1, token: 'target', path: record.location.path, side: 'new', line: 2, identifier: 'Target', source };

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  await tick();
  assert.equal(projections.at(-1).surface, undefined);
  assert.equal(projections.at(-1).bookmarkLocations.find(({ path }) => path === oldRecord.location.path).source.commitSha, review.refs.startSha);
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target });
  await tick();
  const range = { location: { path: target.path, side: target.side, startLine: 2, endLine: 4 }, anchor: { symbol: '', selectionHash: '1'.repeat(64), beforeHash: '2'.repeat(64), afterHash: '3'.repeat(64) } };
  stream.emit({ type: 'intent', revision: 1, command: 'toggle-bookmark', bookmark: range });
  await tick();
  stream.emit({ type: 'intent', revision: 1, command: 'open-bookmarks' });
  await tick();

  assert.equal(toggles.length, 1);
  assert.deepEqual(toggles[0].location, range.location);
  assert.deepEqual(toggles[0].anchor, range.anchor);
  assert.equal(projections.at(-1).surface.title, 'MR bookmarks');
  assert.match(projections.at(-1).surface.body, /2 current bookmarks/);
  assert.deepEqual(projections.at(-1).bookmarks, ['target']);
  await session.stop();
});

test('Review Session stop is terminal, idempotent, and aborts replaceable work', async () => {
  const stream = events();
  const projections = [];
  let querySignal;
  const session = startReviewSession({
    host: hostFor(stream, { projections }),
    intelligence: { query: (_request, signal) => {
      querySignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    } },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target: { revision: 1, token: 'target', path: repositoryPath('pkg/main.go'), side: 'new', line: 2, identifier: 'Target', source } });
  await tick();
  stream.emit({ type: 'intent', revision: 1, command: 'toggle-enabled' });
  await tick();
  assert.equal(querySignal.aborted, true);
  assert.equal(projections.at(-1).status, undefined);
  await session.stop();
  await session.stop();

  const count = projections.length;
  stream.emit({ type: 'host-revised', revision: 2, surface: 'changes' });
  await tick();
  assert.equal(projections.length, count);
});

test('Review Session keeps semantic continuations snapshot-bound and records in-diff history', async () => {
  const stream = events();
  const actions = [];
  const projections = [];
  const definition = { revision: 1, token: 'definition', path: repositoryPath('pkg/target.go'), side: 'new', line: 4, identifier: 'Target', source };
  const usage = { revision: 1, token: 'usage', path: repositoryPath('pkg/main.go'), side: 'new', line: 9, identifier: 'Target', source };
  const queries = [];
  const session = startReviewSession({
    host: hostFor(stream, { projections, actions }),
    intelligence: {
      async query(request) {
        queries.push(request);
        if (request.operation === 'find-references') return {
          status: 'references', source, snapshot: 'changed', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: ['pkg'] },
          symbol: request.symbol, locations: [{ path: usage.path, line: usage.line, column: 1 }],
        };
        return {
          status: 'resolved', isDefinition: request.path === definition.path, source, snapshot: 'stable',
          coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: ['pkg'] },
          symbol: { signature: 'func Target()', identity: { source, path: definition.path, line: definition.line, column: 1, kind: 'function', name: 'Target' }, documentation: '', documentationLine: 1, packageName: 'pkg', packagePath: 'pkg' },
        };
      },
    },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target: definition });
  await tick();
  stream.emit({ type: 'intent', revision: 1, command: 'activate-target', target: definition });
  await tick();
  await tick();

  assert.equal(queries.at(-1).operation, 'find-references');
  assert.equal(actions.length, 0, 'a changed Semantic snapshot must make the continuation inert');

  stream.emit({ type: 'intent', revision: 1, command: 'activate-target', target: usage });
  await tick();
  assert.equal(actions.at(-1).action, 'reveal-target');
  assert.equal(actions.at(-1).target.token, definition.token);
  stream.emit({ type: 'intent', revision: 1, command: 'history-back' });
  await tick();
  assert.equal(actions.at(-1).target.token, usage.token);
  await session.stop();
});

test('the composition root replaces immutable Review Sessions instead of retargeting them', async () => {
  globalThis.location = { pathname: '/' };
  globalThis.chrome = { runtime: { sendMessage: async () => {} } };
  const { runReviewSessionComposition } = await import('../../src/content.ts');
  const stream = events();
  const second = Object.freeze({ ...review, identity: Object.freeze({ ...review.identity, mergeRequestIid: '43' }) });
  const started = [];
  const stopped = [];
  const signals = [];
  const controller = new AbortController();
  const running = runReviewSessionComposition({
    host: {
      observeReviews: () => stream.iterable,
      connect: (next, signal) => { signals.push(signal); return { review: next }; },
    },
    start: (bound) => {
      started.push(bound.review.identity.mergeRequestIid);
      return { stop: async () => { stopped.push(bound.review.identity.mergeRequestIid); } };
    },
    signal: controller.signal,
  });

  stream.emit(review);
  await tick();
  stream.emit(review);
  await tick();
  stream.emit(second);
  await tick();
  controller.abort();
  stream.close();
  await running;

  assert.deepEqual(started, ['42', '43']);
  assert.deepEqual(stopped, ['42', '43']);
  assert.ok(signals.every(({ aborted }) => aborted));
});

test('Review Session reconciles synchronized preferences and saves enablement through one port', async () => {
  const stream = events();
  const projections = [];
  const actions = [];
  const saved = [];
  let notify;
  const session = startReviewSession({
    host: hostFor(stream, { projections, actions }),
    intelligence: { query: async () => assert.fail('no semantic query expected') },
    preferences: { enabled: true, hideGeneratedFiles: false },
    preferencePort: {
      subscribe(listener) { notify = listener; return () => { notify = undefined; }; },
      async set(update) { saved.push(update); },
    },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  await tick();
  notify({ enabled: true, hideGeneratedFiles: true });
  await tick();
  assert.equal(projections.at(-1).hideGeneratedFiles, true);
  stream.emit({ type: 'intent', revision: 1, command: 'toggle-enabled' });
  await tick();
  assert.deepEqual(saved, [{ enabled: false }]);
  notify({ enabled: true, hideGeneratedFiles: true });
  stream.emit({ type: 'intent', revision: 1, command: 'toggle-focus' });
  await tick();
  stream.emit({ type: 'fullscreen-changed', revision: 1, active: true });
  await tick();
  notify({ enabled: false, hideGeneratedFiles: true });
  await tick();
  assert.equal(actions.at(-1).action, 'set-fullscreen');
  assert.equal(actions.at(-1).active, false);
  assert.equal(projections.at(-1).focusMode, true);
  await session.stop();
  assert.equal(notify, undefined);
});

test('Review Session rejects a semantic result from the snapshot replaced by Coverage', async () => {
  const stream = events();
  const projections = [];
  let resolveQuery;
  const session = startReviewSession({
    host: hostFor(stream, { projections, reads: [() => ({ kind: 'ok', value: { files: [{ path: repositoryPath('pkg/main.go'), contentId: 'blob' }] } })] }),
    intelligence: {
      query: () => new Promise((resolve) => { resolveQuery = resolve; }),
      async ensureCoverage() {
        return { status: 'ready', source, snapshot: 'new', coverage: { scope: 'indexed-packages', complete: true, packageCount: 1, packagePaths: ['pkg'] } };
      },
    },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });
  const target = { revision: 1, token: 'target', path: repositoryPath('pkg/main.go'), side: 'new', line: 2, identifier: 'Target', source };

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target });
  await tick();
  stream.emit({ type: 'intent', revision: 1, command: 'cache-related' });
  await tick();
  await tick();
  resolveQuery({ status: 'resolved', isDefinition: false, source, snapshot: 'old', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: [] }, symbol: { signature: 'late result', identity: { source, path: target.path, line: 2, column: 1, kind: 'function', name: 'Target' }, documentation: '', documentationLine: 1, packageName: 'pkg', packagePath: 'pkg' } });
  await tick();

  assert.notEqual(projections.at(-1).status, 'late result');
  await session.stop();
});

test('Review Session executes full-file and relative navigation helpers', async () => {
  const stream = events();
  const projections = [];
  const actions = [];
  const first = { revision: 1, token: 'first', path: repositoryPath('a.go'), side: 'new', line: 2, identifier: 'First', source };
  const second = { revision: 1, token: 'second', path: repositoryPath('b.go'), side: 'new', line: 8, identifier: 'Second', source };
  const session = startReviewSession({
    host: hostFor(stream, { projections, actions, actionOutcomes: [{ kind: 'completed' }, { kind: 'unavailable', reason: 'not-rendered' }] }),
    intelligence: { query: async (request) => ({ status: 'missing', reason: 'identifier', source, snapshot: '1', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: [String(request.path)] } }) },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes', files: [{ path: first.path, full: false }, { path: second.path, full: false }] });
  await tick();
  assert.deepEqual(projections.at(-1).fullFileControls, [{ path: first.path, full: false }, { path: second.path, full: false }]);
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target: first });
  await tick();
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target: second });
  await tick();
  stream.emit({ type: 'intent', revision: 1, command: 'previous-file' });
  await tick();
  assert.equal(actions.at(-1).action, 'navigate-relative');
  assert.deepEqual({ kind: actions.at(-1).kind, direction: actions.at(-1).direction }, { kind: 'file', direction: 'previous' });

  stream.emit({ type: 'intent', revision: 1, command: 'toggle-full-file', path: second.path });
  await tick();
  assert.equal(actions.at(-1).action, 'set-full-file');
  assert.equal(actions.at(-1).full, true);
  assert.deepEqual(projections.at(-1).fullFileControls, [{ path: first.path, full: false }, { path: second.path, full: false, error: 'Full file is unavailable.' }]);
  stream.emit({ type: 'host-revised', revision: 2, surface: 'changes', files: [{ path: first.path, full: false }, { path: second.path, full: false }] });
  await tick();
  assert.deepEqual(projections.at(-1).fullFileControls, [{ path: first.path, full: false }, { path: second.path, full: false }]);
  await session.stop();
});

test('Review Session rolls back a pending full-file projection when disabled', async () => {
  const stream = events();
  const projections = [];
  let actionSignal;
  const path = repositoryPath('pkg/main.go');
  const session = startReviewSession({
    host: hostFor(stream, { projections, actionOutcomes: [(_action, signal) => {
      actionSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    }] }),
    intelligence: { query: async () => assert.fail('no semantic query expected') },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes', files: [{ path, full: false }] });
  stream.emit({ type: 'intent', revision: 1, command: 'toggle-full-file', path });
  await tick();
  assert.equal(projections.at(-1).fullFileControls[0].busy, true);
  stream.emit({ type: 'intent', revision: 1, command: 'toggle-enabled' });
  await tick();

  assert.equal(actionSignal.aborted, true);
  assert.deepEqual(projections.at(-1).fullFileControls, [{ path, full: false }]);
  await session.stop();
});

test('Review Session keeps semantic choices and confirmed review milestones inside the workflow', async () => {
  const stream = events();
  const projections = [];
  const actions = [];
  const definition = { revision: 1, token: 'definition', path: repositoryPath('definition.go'), side: 'new', line: 2, identifier: 'Target', source };
  const first = { revision: 1, token: 'first-use', path: repositoryPath('first.go'), side: 'new', line: 4, identifier: 'Target', source };
  const second = { revision: 1, token: 'second-use', path: repositoryPath('second.go'), side: 'new', line: 6, identifier: 'Target', source };
  const symbol = { source, path: definition.path, line: definition.line, column: 1, kind: 'function', name: 'Target' };
  const session = startReviewSession({
    host: hostFor(stream, { projections, actions, reads: [() => ({ kind: 'ok', value: { state: 'opened', approvers: ['casper'], unresolvedDiscussions: 0 } })] }),
    intelligence: {
      async query(request) {
        const context = { source, snapshot: 'stable', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: [] } };
        if (request.operation === 'find-references') return request.pageToken
          ? { ...context, status: 'references', symbol: request.symbol, locations: [{ path: second.path, line: second.line, column: 1 }] }
          : { ...context, status: 'references', symbol: request.symbol, locations: [{ path: first.path, line: first.line, column: 1 }], nextPageToken: 'next' };
        if (request.path === definition.path) return { ...context, status: 'resolved', isDefinition: true, symbol: { signature: 'func Target()', identity: symbol, documentation: '', documentationLine: 1, packageName: 'pkg', packagePath: 'pkg' } };
        return { ...context, status: 'missing', reason: 'identifier' };
      },
    },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  for (const target of [first, second]) {
    stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target });
    await tick();
  }
  stream.emit({ type: 'intent', revision: 1, command: 'activate-target', target: definition });
  await tick();
  await tick();
  assert.equal(projections.at(-1).surface.actions.length, 2);
  stream.emit({ type: 'intent', revision: 1, command: 'surface-action', actionId: 'destination:1' });
  await tick();
  assert.equal(actions.at(-1).target.token, second.token);

  stream.emit({ type: 'intent', revision: 1, command: 'native-approve' });
  await tick();
  assert.equal(projections.at(-1).announcement, 'Approval confirmed.');

  stream.emit({ type: 'intent', revision: 1, command: 'select-target', target: definition });
  await tick();
  await tick();
  assert.deepEqual(projections.at(-1).occurrenceLocations.map(({ path, line }) => ({ path, line })), [
    { path: definition.path, line: definition.line }, { path: first.path, line: first.line }, { path: second.path, line: second.line },
  ]);
  await session.stop();
});

test('Review Session reveals an untouched loaded semantic destination by Source location', async () => {
  const stream = events();
  const actions = [];
  const definitionPath = repositoryPath('pkg/definition.go');
  const usage = { revision: 1, token: 'usage', path: repositoryPath('pkg/use.go'), side: 'new', line: 9, identifier: 'Target', source };
  const session = startReviewSession({
    host: hostFor(stream, { actions }),
    intelligence: { query: async () => ({
      status: 'resolved', isDefinition: false, source, snapshot: '1', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: [] },
      symbol: { signature: 'func Target()', identity: { source, path: definitionPath, line: 3, column: 1, kind: 'function', name: 'Target' }, documentation: '', documentationLine: 1, packageName: 'pkg', packagePath: 'pkg' },
    }) },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'activate-target', target: usage });
  await tick();
  assert.deepEqual({ action: actions.at(-1).action, path: actions.at(-1).path, line: actions.at(-1).line }, {
    action: 'reveal-source', path: definitionPath, line: 3,
  });
  stream.emit({ type: 'intent', revision: 1, command: 'history-back' });
  await tick();
  assert.equal(actions.at(-1).target.token, usage.token);
  await session.stop();
});

test('Review Session terminates on a broken Host contract and leaves one bounded failure state', async () => {
  const projections = [];
  let unsubscribed = false;
  const session = startReviewSession({
    host: {
      review,
      async *events() { yield { type: 'host-revised', revision: 1, surface: 'changes' }; throw new Error('broken host invariant'); },
      apply: (projection) => { projections.push(projection); return { kind: 'applied' }; },
      perform: async () => ({ kind: 'completed' }),
      read: async () => ({ kind: 'unavailable', reason: 'not-rendered' }),
    },
    intelligence: { query: async () => assert.fail('no semantic query expected') },
    preferences: { enabled: true, hideGeneratedFiles: false },
    preferencePort: { subscribe: () => () => { unsubscribed = true; }, set: async () => {} },
  });

  await tick();
  assert.equal(projections.at(-1).status, 'GoLens stopped after an internal error.');
  assert.equal(unsubscribed, true);
  await session.stop();
});

test('Review Session survives a failed semantic query and stays fully operational', async () => {
  const stream = events();
  const projections = [];
  let queries = 0;
  const session = startReviewSession({
    host: hostFor(stream, { projections }),
    intelligence: { query: async () => { queries += 1; if (queries === 1) throw new Error('broken Intelligence invariant'); return { status: 'missing', reason: 'identifier', source, snapshot: '1', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: [] } }; } },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });
  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target: {
    revision: 1, token: 'target', path: repositoryPath('pkg/main.go'), side: 'new', line: 2, identifier: 'Target', source,
  } });
  await tick();
  assert.equal(projections.at(-1).status, 'Go Intelligence unavailable: broken Intelligence invariant');
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target: {
    revision: 1, token: 'target2', path: repositoryPath('pkg/main.go'), side: 'new', line: 3, identifier: 'Target2', source,
  } });
  await tick();
  assert.equal(queries, 2, 'the session must accept a fresh hover query after a failure, without reloading');
  await session.stop();
});

test('Review Session keeps expected Coverage unavailability bounded', async () => {
  const stream = events();
  const projections = [];
  const session = startReviewSession({
    host: hostFor(stream, { projections, reads: [() => ({ kind: 'unavailable', reason: 'offline' })] }),
    intelligence: { query: async () => assert.fail('no semantic query expected'), ensureCoverage: async () => assert.fail('no Coverage mutation expected') },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });
  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'cache-related' });
  await tick();
  assert.equal(projections.at(-1).status, 'Related package cache is unavailable.');
  stream.emit({ type: 'host-revised', revision: 2, surface: 'changes' });
  await tick();
  assert.equal(projections.at(-1).revision, 2, 'routine unavailability must not terminate the session');
  await session.stop();
});

test('Review Session exposes ambiguous choices and external documentation safely', async () => {
  const stream = events();
  const projections = [];
  const actions = [];
  let external = false;
  const target = { revision: 1, token: 'target', path: repositoryPath('pkg/use.go'), side: 'new', line: 2, column: 5, occurrence: 1, identifier: 'Target', source };
  const identity = (path, line) => ({ source, path: repositoryPath(path), line, column: 1, kind: 'function', name: 'Target' });
  const session = startReviewSession({
    host: hostFor(stream, { projections, actions }),
    intelligence: { query: async (request) => external
      ? { status: 'external', packageKind: 'standard-library', importPath: 'net/http', symbol: 'Client', source, snapshot: '1', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: [] } }
      : { status: 'ambiguous', reason: 'multiple-definitions', candidates: [
        { signature: 'func Target()', identity: identity('pkg/a.go', 3), documentation: '', documentationLine: 1, packageName: 'pkg', packagePath: 'pkg' },
        { signature: 'func Target()', identity: identity('pkg/b.go', 4), documentation: '', documentationLine: 1, packageName: 'pkg', packagePath: 'pkg' },
      ], source, snapshot: '1', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: [String(request.path)] } } },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });
  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target });
  await tick();
  assert.equal(projections.at(-1).surface.actions.length, 2);

  external = true;
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target });
  await tick();
  stream.emit({ type: 'intent', revision: 1, command: 'surface-action', actionId: 'external-documentation' });
  await tick();
  assert.equal(actions.at(-1).action, 'open-destination');
  assert.equal(actions.at(-1).destination.url, 'https://pkg.go.dev/net/http#Client');
  await session.stop();
});

test('Review Session projects contextual coaching and retires shortcut actions', async () => {
  const stream = events();
  const projections = [];
  const considered = [];
  const learned = [];
  const enabled = [];
  let learning = { version: 1, lastHintAt: 0, actions: {} };
  const session = startReviewSession({
    host: hostFor(stream, { projections }),
    intelligence: { query: async () => assert.fail('no semantic query expected') },
    preferences: { enabled: true, hideGeneratedFiles: false },
    coachStorage: {
      async get() { return learning; },
      async set(state) { learning = state; considered.push(...Object.keys(state.actions).filter((action) => !considered.includes(action))); if (state.actions.focusFileSearch?.learned) learned.push('focusFileSearch'); },
      async settings() { return { enabled: true, binding: 'Primary+KeyP' }; },
      async setEnabled(value) { enabled.push(value); },
    },
  });
  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, source: 'manual', command: 'focus-file-search' });
  stream.emit({ type: 'intent', revision: 1, source: 'manual', command: 'focus-file-search' });
  await tick(); await tick();
  assert.deepEqual(considered, ['focusFileSearch']);
  assert.equal(projections.at(-1).surface.title, 'Shortcut tip');
  stream.emit({ type: 'intent', revision: 1, command: 'surface-action', actionId: 'disable-coach' });
  stream.emit({ type: 'intent', revision: 1, source: 'shortcut', command: 'focus-file-search' });
  await tick(); await tick();
  assert.deepEqual(enabled, [false]);
  assert.deepEqual(learned, ['focusFileSearch']);
  await session.stop();
});
