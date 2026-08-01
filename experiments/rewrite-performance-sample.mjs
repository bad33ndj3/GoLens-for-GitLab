import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { Window } from 'happy-dom';

import {
  blobID,
  goProject,
  parserInstance,
  queryPosition,
  rapidDiff,
  timedQueries,
} from './legacy-performance-baseline.mjs';

async function semanticSample() {
  const [{ commitSha, repositoryKey, repositoryPath, sourceIdentity }, { GoIntelligenceCache }, { SemanticSnapshotIndex }, parser] = await Promise.all([
    import('../src/domain.ts'),
    import('../src/go-intelligence/cache.ts'),
    import('../src/go-intelligence/semantic-index.ts'),
    parserInstance(),
  ]);
  const rawFiles = goProject();
  const files = rawFiles.map((file) => ({ path: repositoryPath(file.path), source: file.source, contentId: blobID(file.source) }));
  const source = sourceIdentity({ repositoryKey: repositoryKey('https://gitlab.example/group/project'), commitSha: commitSha('b'.repeat(40)) });
  const fullCoverage = Object.freeze({
    scope: 'full-project', complete: true, packageCount: 51,
    packagePaths: Object.freeze(['contracts', ...Array.from({ length: 50 }, (_value, index) => `pkg${String(index).padStart(3, '0')}`)]),
  });

  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const index = new SemanticSnapshotIndex(parser, source, 'benchmark-full', fullCoverage);
  const indexingStartedAt = performance.now();
  index.indexProject('example.com/project', files);
  const fullProjectIndexMs = performance.now() - indexingStartedAt;
  globalThis.gc?.();
  const semanticHeapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;

  const hoverFile = files.find(({ path }) => path === 'pkg025/runner.go');
  assert.ok(hoverFile);
  const position = queryPosition(hoverFile, 'return HoverTarget()', 'HoverTarget');
  const hover = () => {
    const result = index.query({
      operation: 'resolve-symbol', path: hoverFile.path, line: position.line,
      column: position.character + 1, identifier: position.identifier,
    });
    assert.equal(result.status, 'resolved');
    return result;
  };
  hover();
  const hoverSemanticMs = timedQueries(250, hover);
  const contractFile = files.find(({ path }) => path === 'contracts/runner.go');
  assert.ok(contractFile);
  const contractPosition = queryPosition(contractFile, 'type Runner interface', 'Runner');
  const contract = index.query({
    operation: 'resolve-symbol', path: contractFile.path, line: contractPosition.line,
    column: contractPosition.character + 1, identifier: contractPosition.identifier,
  });
  assert.equal(contract.status, 'resolved');
  const jump = () => {
    const result = index.query({ operation: 'find-implementations', symbol: contract.symbol.identity, pageSize: 100 });
    assert.equal(result.status, 'implementations');
    assert.equal(result.candidates.length, 50);
  };
  jump();
  const jumpSemanticMs = timedQueries(100, jump);

  const relatedPaths = new Set(['contracts', ...Array.from({ length: 10 }, (_value, pathIndex) => `pkg${String(pathIndex).padStart(3, '0')}`)]);
  const relatedFiles = files.filter(({ path }) => relatedPaths.has(dirname(path)));
  const relatedCache = new GoIntelligenceCache(undefined);
  const relatedIndex = new SemanticSnapshotIndex(parser, source, 'benchmark-related', {
    scope: 'indexed-packages', complete: true, packageCount: relatedPaths.size, packagePaths: [...relatedPaths],
  });
  const relatedStartedAt = performance.now();
  for (const packagePath of relatedPaths) {
    const packageFiles = relatedFiles.filter(({ path }) => dirname(path) === packagePath);
    const manifest = {
      source, modulePath: 'example.com/project',
      coverage: { scope: 'current-package', complete: true, packageCount: 1, packagePaths: [packagePath] },
      files: packageFiles.map(({ path, contentId }) => ({ path, contentId })),
    };
    await relatedCache.stage(source, packageFiles);
    const restored = await relatedCache.publish(manifest);
    relatedIndex.indexPackage(packagePath, restored.sources, restored.modulePath);
  }
  assert.equal((await relatedCache.inspect(source)).sourceBlobs, relatedFiles.length);
  const relatedCacheProcessingMs = performance.now() - relatedStartedAt;

  const fullCache = new GoIntelligenceCache(undefined);
  const fullManifest = {
    source, modulePath: 'example.com/project', coverage: fullCoverage,
    files: files.map(({ path, contentId }) => ({ path, contentId })),
  };
  const fullStartedAt = performance.now();
  await fullCache.stage(source, files);
  const restored = await fullCache.publish(fullManifest);
  const restoredIndex = new SemanticSnapshotIndex(parser, source, 'benchmark-restored', restored.coverage);
  restoredIndex.indexProject(restored.modulePath, restored.sources);
  assert.equal((await fullCache.restore(source))?.sources.length, files.length);
  const fullProjectCacheProcessingMs = performance.now() - fullStartedAt;

  return {
    fullProjectIndexMs,
    hoverSemanticMedianMs: hoverSemanticMs.median,
    hoverSemanticP95Ms: hoverSemanticMs.p95,
    jumpSemanticMedianMs: jumpSemanticMs.median,
    jumpSemanticP95Ms: jumpSemanticMs.p95,
    relatedCacheProcessingMs,
    fullProjectCacheProcessingMs,
    semanticHeapDeltaBytes,
  };
}

async function domSample() {
  const fileCount = 80;
  const linesPerFile = 100;
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.write(`<!doctype html><html><head><meta name="csrf-token" content="fixture"></head><body>
    <div class="layout-page is-merge-request"><div class="ai-panels"><nav><button>AI</button></nav></div></div>
    <main id="diffs">${Array.from({ length: fileCount }, (_value, index) => rapidDiff(index, linesPerFile)).join('')}</main>
  </body></html>`);
  Object.assign(globalThis, {
    window, document: window.document, location: window.location, HTMLElement: window.HTMLElement,
    Element: window.Element, Node: window.Node, customElements: window.customElements,
    CustomEvent: window.CustomEvent, MutationObserver: window.MutationObserver,
  });
  const [{ commitSha, repositoryKey, repositoryPath }, { createGitLabHost, reviewDescriptor }] = await Promise.all([
    import('../src/domain.ts'),
    import('../src/gitlab-host/index.ts'),
  ]);
  const review = reviewDescriptor({
    identity: {
      origin: 'https://gitlab.example', repositoryKey: repositoryKey('https://gitlab.example/group/project'),
      projectPath: repositoryPath('group/project'), mergeRequestIid: '42', headSha: commitSha('b'.repeat(40)),
    },
    refs: { baseSha: commitSha('a'.repeat(40)), startSha: commitSha('a'.repeat(40)) },
  });
  const controller = new AbortController();
  const initializationStartedAt = performance.now();
  const bound = createGitLabHost({ origin: review.identity.origin, window, fetch: async () => new Response('{}') }).connect(review, controller.signal);
  const events = bound.events(controller.signal)[Symbol.asyncIterator]();
  const initial = (await events.next()).value;
  assert.equal(initial.files.length, fileCount);
  const projection = (event) => ({
    revision: event.revision, enabled: true,
    fullFileControls: event.files.map(({ path, full }) => ({ path, full })),
  });
  assert.equal(bound.apply(projection(initial)).kind, 'applied');
  assert.equal(window.document.querySelectorAll('[data-golens-full-file-control]').length, fileCount);
  const largeMrInitializationMs = performance.now() - initializationStartedAt;

  const replacement = window.document.createElement('template');
  replacement.innerHTML = Array.from({ length: fileCount }, (_value, index) => rapidDiff(index + fileCount, linesPerFile)).join('');
  window.document.getElementById('diffs').replaceChildren(replacement.content.cloneNode(true));
  const mutationStartedAt = performance.now();
  const revised = (await events.next()).value;
  assert.equal(revised.type, 'host-revised');
  assert.equal(revised.files.length, fileCount);
  assert.equal(bound.apply(projection(revised)).kind, 'applied');
  assert.equal(window.document.querySelectorAll('[data-golens-full-file-control]').length, fileCount);
  const mutationReconciliationMs = performance.now() - mutationStartedAt;
  controller.abort();
  window.close();
  return { largeMrInitializationMs, mutationReconciliationMs };
}

try {
  const semantic = await semanticSample();
  const dom = await domSample();
  console.log(JSON.stringify({ complete: true, ...semantic, ...dom }));
} catch (error) {
  console.error(error?.stack || error);
  process.exit(1);
}
