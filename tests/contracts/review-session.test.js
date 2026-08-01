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

function hostFor(stream, { projections = [], actions = [], reads = [] } = {}) {
  return {
    review,
    events: (signal) => { signal.addEventListener('abort', () => stream.close(), { once: true }); return stream.iterable; },
    apply: (projection) => { projections.push(projection); return { kind: 'applied' }; },
    perform: async (action) => { actions.push(action); return { kind: 'completed' }; },
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
  const session = startReviewSession({
    host: hostFor(stream, { projections }),
    intelligence: { query: async () => ({ status: 'missing', reason: 'identifier', source, snapshot: '1', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: [] } }) },
    bookmarks: {
      list: async () => [record],
      toggle: async (input) => { toggles.push(input); return { action: 'added', record }; },
    },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });
  const target = { revision: 1, token: 'target', path: record.location.path, side: 'new', line: 2, identifier: 'Target', source };

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  await tick();
  assert.equal(projections.at(-1).surface, undefined);
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target });
  await tick();
  stream.emit({ type: 'intent', revision: 1, command: 'toggle-bookmark' });
  await tick();
  stream.emit({ type: 'intent', revision: 1, command: 'open-bookmarks' });
  await tick();

  assert.equal(toggles.length, 1);
  assert.deepEqual(toggles[0].location, { path: target.path, side: target.side, startLine: 2, endLine: 2 });
  assert.equal(projections.at(-1).surface.title, 'MR bookmarks');
  assert.match(projections.at(-1).surface.body, /1 current bookmark/);
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
  await session.stop();
  await session.stop();

  assert.equal(querySignal.aborted, true);
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
    host: hostFor(stream, { projections, actions }),
    intelligence: { query: async (request) => ({ status: 'missing', reason: 'identifier', source, snapshot: '1', coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: [String(request.path)] } }) },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });

  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
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
  assert.deepEqual(projections.at(-1).fullFileControls, [{ path: second.path, full: true }]);
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
    { path: first.path, line: first.line }, { path: second.path, line: second.line },
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

test('Review Session terminates when an asynchronous dependency breaks its contract', async () => {
  const stream = events();
  const projections = [];
  const session = startReviewSession({
    host: hostFor(stream, { projections }),
    intelligence: { query: async () => { throw new Error('broken Intelligence invariant'); } },
    preferences: { enabled: true, hideGeneratedFiles: false },
  });
  stream.emit({ type: 'host-revised', revision: 1, surface: 'changes' });
  stream.emit({ type: 'intent', revision: 1, command: 'hover-target', target: {
    revision: 1, token: 'target', path: repositoryPath('pkg/main.go'), side: 'new', line: 2, identifier: 'Target', source,
  } });
  await tick();
  assert.equal(projections.at(-1).status, 'GoLens stopped after an internal error.');
  await session.stop();
});
