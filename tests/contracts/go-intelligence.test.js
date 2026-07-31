import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { Language, Parser } from 'web-tree-sitter';

import { commitSha, repositoryKey, repositoryPath, sourceIdentity } from '../../src/domain.ts';
import { openGoIntelligence, startGoIntelligenceWorker } from '../../src/go-intelligence/index.ts';

function event() {
  const listeners = new Set();
  return {
    addListener(listener) { listeners.add(listener); },
    removeListener(listener) { listeners.delete(listener); },
    emit(value) { for (const listener of listeners) listener(value); },
  };
}

function runtime() {
  const onConnect = event();
  return {
    onConnect,
    connect() {
      const clientMessage = event();
      const workerMessage = event();
      const clientDisconnect = event();
      const workerDisconnect = event();
      const client = {
        onMessage: clientMessage,
        onDisconnect: clientDisconnect,
        postMessage: (message) => queueMicrotask(() => workerMessage.emit(message)),
        disconnect() { clientDisconnect.emit(); workerDisconnect.emit(); },
      };
      onConnect.emit({
        onMessage: workerMessage,
        onDisconnect: workerDisconnect,
        postMessage: (message) => queueMicrotask(() => clientMessage.emit(message)),
      });
      return client;
    },
  };
}

async function createParser() {
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load(new URL('../../vendor/tree-sitter-go.wasm', import.meta.url).pathname));
  return parser;
}

function file(path, source) {
  const contentId = createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
  return Object.freeze({ path: repositoryPath(path), contentId });
}

const source = sourceIdentity({ repositoryKey: repositoryKey('gitlab.example/group/project'), commitSha: commitSha('a'.repeat(40)) });
const code = 'package sample\nfunc Target() {}\nfunc Use() { Target() }\n';
const entry = file('sample/sample.go', code);
const coverage = Object.freeze({
  scope: 'current-package', complete: true, packageCount: 1, packagePaths: Object.freeze(['sample']),
});

test('cold coverage publishes atomically and warm coverage restores without fetching', async () => {
  const chromeRuntime = runtime();
  startGoIntelligenceWorker({ runtime: chromeRuntime, createParser });
  let reads = 0;
  let sourceAvailable = true;
  const reader = {
    async discover() {
      if (!sourceAvailable) throw new Error('offline');
      return { modulePath: 'example.com/project', coverage, files: [entry] };
    },
    async read() { reads++; return code; },
  };
  const intelligence = openGoIntelligence({ source, reader, runtime: chromeRuntime });
  const phases = [];
  const duplicatePhases = [];

  const coverageRequest = { goal: 'current-package', packagePath: 'sample' };
  const [ready] = await Promise.all([
    intelligence.ensureCoverage(coverageRequest, ({ phase }) => phases.push(phase), new AbortController().signal),
    intelligence.ensureCoverage(coverageRequest, ({ phase }) => duplicatePhases.push(phase), new AbortController().signal),
  ]);
  assert.equal(ready.status, 'ready');
  assert.equal(reads, 1);
  assert.deepEqual(phases, ['checking-cache', 'discovering', 'fetching', 'fetching', 'indexing', 'publishing', 'ready']);
  assert.deepEqual(duplicatePhases, phases);

  const result = await intelligence.query({
    operation: 'resolve-symbol', path: entry.path, line: 3, column: 14, identifier: 'Target',
  }, new AbortController().signal);
  assert.equal(result.status, 'resolved');
  assert.equal(result.symbol.identity.line, 2);

  sourceAvailable = false;
  const warmPhases = [];
  await intelligence.ensureCoverage(
    { goal: 'current-package', packagePath: 'sample' },
    ({ phase }) => warmPhases.push(phase),
    new AbortController().signal,
  );
  assert.equal(reads, 1);
  assert.deepEqual(warmPhases, ['checking-cache', 'ready']);
  assert.deepEqual(await intelligence.inspectCache({ scope: 'global' }, new AbortController().signal), {
    sourceBlobs: 1, packageManifests: 1, projectManifests: 0, bytes: Buffer.byteLength(code),
  });
  assert.deepEqual(await intelligence.clearCache({ scope: 'global' }, new AbortController().signal), {
    status: 'cleared', sourceBlobs: 1, packageManifests: 1, projectManifests: 0, bytes: Buffer.byteLength(code),
  });
  assert.equal((await intelligence.ensureCoverage(
    { goal: 'current-package', packagePath: 'sample' }, () => {}, new AbortController().signal,
  )).status, 'unavailable');
});
