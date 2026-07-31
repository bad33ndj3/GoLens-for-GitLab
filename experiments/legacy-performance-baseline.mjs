import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SAMPLE_FLAG = '--sample';
const DEFAULT_SAMPLES = 5;

function percentile(values, fraction) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
}

function summary(values) {
  return {
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    min: Math.min(...values),
    max: Math.max(...values),
  };
}

function goProject() {
  const files = [{
    path: 'contracts/runner.go',
    source: `package contracts

type Runner interface {
  Run() error
  Close() error
}
`,
  }];
  for (let packageIndex = 0; packageIndex < 50; packageIndex++) {
    const packageName = `pkg${String(packageIndex).padStart(3, '0')}`;
    files.push({
      path: `${packageName}/runner.go`,
      source: `package ${packageName}

type Runner struct{}
func (*Runner) Run() error { return nil }
func (*Runner) Close() error { return nil }
func HoverTarget() int { return ${packageIndex} }
func UseHoverTarget() int { return HoverTarget() }
`,
    });
    files.push({
      path: `${packageName}/generated.go`,
      source: `package ${packageName}

${Array.from({ length: 195 }, (_value, functionIndex) => (
  `func Generated${functionIndex}() int { return ${functionIndex} }`
)).join('\n')}
`,
    });
  }
  return files;
}

function blobID(source) {
  return createHash('sha1')
    .update(`blob ${Buffer.byteLength(source)}\0`)
    .update(source)
    .digest('hex');
}

async function parserInstance() {
  const { Parser, Language } = await import('web-tree-sitter');
  await Parser.init();
  const parser = new Parser();
  parser.setLanguage(await Language.load(resolve(root, 'vendor/tree-sitter-go.wasm')));
  return parser;
}

function queryPosition(file, needle, identifier = needle) {
  const lines = file.source.split('\n');
  const lineIndex = lines.findIndex((line) => line.includes(needle));
  assert.notEqual(lineIndex, -1, `missing benchmark query ${needle}`);
  return {
    line: lineIndex + 1,
    character: lines[lineIndex].indexOf(identifier),
    identifier,
  };
}

function timedQueries(iterations, query) {
  const samples = [];
  for (let iteration = 0; iteration < iterations; iteration++) {
    const startedAt = performance.now();
    query();
    samples.push(performance.now() - startedAt);
  }
  return {
    median: percentile(samples, 0.5),
    p95: percentile(samples, 0.95),
  };
}

async function semanticSample() {
  const [{ GoSemanticIndex }, { GoSemanticSourceCache }, parser] = await Promise.all([
    import('../go-semantic-core.js'),
    import('../go-semantic-cache.js'),
    parserInstance(),
  ]);
  const files = goProject();
  const cacheFiles = files.map((file) => ({ ...file, blobId: blobID(file.source) }));
  const entries = cacheFiles.map(({ path, blobId }) => ({ path, blobId }));
  const scope = {
    origin: 'https://gitlab.example',
    project: 'group/project',
    ref: 'b'.repeat(40),
    modulePath: 'example.com/project',
  };

  globalThis.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  const index = new GoSemanticIndex(parser);
  const indexingStartedAt = performance.now();
  const indexed = index.indexProject({ ...scope, files });
  const fullProjectIndexMs = performance.now() - indexingStartedAt;
  assert.equal(indexed.files, files.length);
  globalThis.gc?.();
  const semanticHeapDeltaBytes = process.memoryUsage().heapUsed - heapBefore;

  const hoverFile = files.find(({ path }) => path === 'pkg025/runner.go');
  const hoverParams = {
    ...scope,
    packagePath: 'pkg025',
    path: hoverFile.path,
    ...queryPosition(hoverFile, 'return HoverTarget()', 'HoverTarget'),
  };
  const hover = () => {
    const result = index.resolve(hoverParams);
    assert.equal(result.status, 'resolved');
  };
  hover();
  const hoverSemanticMs = timedQueries(250, hover);

  const interfaceDefinition = index.packageRelations({
    ...scope,
    packagePath: 'contracts',
  }).interfaces[0].definition;
  const jump = () => {
    const result = index.findImplementations({
      ...scope,
      interfaceDefinition,
      pageSize: 100,
    });
    assert.equal(result.status, 'implementations');
    assert.equal(result.candidates.length, 50);
  };
  jump();
  const jumpSemanticMs = timedQueries(100, jump);

  const relatedPaths = new Set(['contracts', ...Array.from({ length: 10 }, (_value, index) => (
    `pkg${String(index).padStart(3, '0')}`
  ))]);
  const relatedFiles = cacheFiles.filter(({ path }) => relatedPaths.has(dirname(path)));
  const relatedCache = new GoSemanticSourceCache({ indexedDB: undefined });
  const relatedIndex = new GoSemanticIndex(parser);
  const relatedStartedAt = performance.now();
  for (const packagePath of relatedPaths) {
    const packageFiles = relatedFiles.filter(({ path }) => dirname(path) === packagePath);
    const packageEntries = packageFiles.map(({ path, source }) => ({ path, blobId: blobID(source) }));
    await relatedCache.writePackage({ ...scope, packagePath, entries: packageEntries, files: packageFiles });
    const snapshot = await relatedCache.readPackage({ ...scope, packagePath });
    assert.ok(snapshot, `related cache did not restore ${packagePath}`);
    relatedIndex.indexPackage({ ...scope, packagePath, ...snapshot });
  }
  const relatedCacheProcessingMs = performance.now() - relatedStartedAt;

  const fullCache = new GoSemanticSourceCache({ indexedDB: undefined });
  const fullIndex = new GoSemanticIndex(parser);
  const fullStartedAt = performance.now();
  const staged = await fullCache.stageProject({ ...scope, entries, files: cacheFiles });
  fullIndex.indexProject({ ...scope, ...staged });
  await fullCache.writeProject({ ...scope, entries, files: cacheFiles });
  assert.ok(await fullCache.readProject(scope), 'full project cache did not restore');
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
    projectFiles: files.length,
    projectLines: files.reduce((total, file) => total + file.source.split('\n').length, 0),
    projectSourceBytes: files.reduce((total, file) => total + Buffer.byteLength(file.source), 0),
    relatedFiles: relatedFiles.length,
  };
}

function rapidDiff(fileIndex, linesPerFile) {
  const lines = Array.from({ length: linesPerFile }, (_value, lineIndex) => `
    <tr>
      <td class="new_line"><a aria-label="Added line ${lineIndex + 1}">${lineIndex + 1}</a></td>
      <td class="line_content">func File${fileIndex}Line${lineIndex}() {}</td>
    </tr>`).join('');
  return `
    <diff-file data-testid="rd-diff-file" data-file-data='{"viewer":"text_inline","new_path":"streamed/${fileIndex}.go"}'>
      <article class="rd-diff-file">
        <header class="rd-diff-file-header" data-testid="rd-diff-file-header">
          <div class="rd-diff-file-info"><div class="rd-diff-file-options-menu"><div data-options-menu>
            <script type="application/json">[{"text":"Show full file","extraAttrs":{"data-click":"showFullFile"}}]</script>
          </div></div></div>
        </header>
        <table><tbody>${lines}</tbody></table>
      </article>
    </diff-file>`;
}

async function waitFor(check, message, timeoutMs = 10000) {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 0));
  }
  throw new Error(message);
}

async function domSample() {
  const { Window } = await import('happy-dom');
  const fileCount = 80;
  const linesPerFile = 100;
  const diffs = Array.from({ length: fileCount }, (_value, index) => rapidDiff(index, linesPerFile)).join('');
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.write(`<!doctype html><html><head><meta name="csrf-token" content="fixture"></head><body>
    <div class="layout-page is-merge-request"><div class="ai-panels"><div><nav><div><button>AI</button></div></nav></div></div></div>
    <main id="diffs">${diffs}</main>
  </body></html>`);

  Object.assign(globalThis, {
    window,
    document: window.document,
    location: window.location,
    MutationObserver: window.MutationObserver,
    Event: window.Event,
    CustomEvent: window.CustomEvent,
    HTMLElement: window.HTMLElement,
    Node: window.Node,
    NodeFilter: window.NodeFilter,
    getComputedStyle: window.getComputedStyle.bind(window),
  });
  globalThis.GoLensGoNavigation = {
    init() {},
    teardown() {},
    async mergeRequestPreloadStatus() { return { status: 'missing' }; },
    async fullProjectPreloadStatus() { return { status: 'missing' }; },
    invalidateCacheState() {},
  };
  globalThis.chrome = {
    storage: {
      sync: { async get(defaults) { return defaults; }, async set() {} },
      local: {
        async get(defaults) { return { ...defaults, golensOnboardingVersion: 11 }; },
        async set() {},
      },
      onChanged: { addListener() {} },
    },
    runtime: {
      getURL(path) { return `chrome-extension://golens/${path}`; },
      onMessage: { addListener() {} },
    },
  };

  const initializationStartedAt = performance.now();
  await import(`${pathToFileURL(resolve(root, 'content.js')).href}?legacy-performance-sample`);
  await waitFor(
    () => window.document.querySelectorAll('[data-golens-full-file]').length === fileCount,
    'large-MR initialization did not reconcile every diff file',
  );
  const largeMrInitializationMs = performance.now() - initializationStartedAt;

  const replacement = window.document.createElement('template');
  replacement.innerHTML = Array.from({ length: fileCount }, (_value, index) => (
    rapidDiff(index + fileCount, linesPerFile)
  )).join('');
  window.document.getElementById('diffs').replaceChildren(replacement.content.cloneNode(true));
  const mutationStartedAt = performance.now();
  await waitFor(
    () => window.document.querySelectorAll('[data-golens-full-file]').length === fileCount,
    'large-MR mutation did not reconcile every replacement diff file',
  );
  const mutationReconciliationMs = performance.now() - mutationStartedAt;
  window.close();

  return {
    largeMrInitializationMs,
    mutationReconciliationMs,
    diffFiles: fileCount,
    diffLines: fileCount * linesPerFile,
  };
}

async function runSample() {
  const semantic = await semanticSample();
  const dom = await domSample();
  return { ...semantic, ...dom };
}

if (process.argv.includes(SAMPLE_FLAG)) {
  try {
    console.log(JSON.stringify(await runSample()));
    process.exit(0);
  } catch (error) {
    console.error(error?.stack || error);
    process.exit(1);
  }
}

const requestedSamples = Number(process.env.GOLENS_PERF_SAMPLES || DEFAULT_SAMPLES);
const sampleCount = Number.isInteger(requestedSamples) && requestedSamples > 0 ? requestedSamples : DEFAULT_SAMPLES;
const samples = [];
for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex++) {
  const child = spawnSync(process.execPath, ['--expose-gc', fileURLToPath(import.meta.url), SAMPLE_FLAG], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  });
  if (child.status !== 0) {
    process.stderr.write(child.stderr || child.stdout);
    process.exit(child.status || 1);
  }
  samples.push(JSON.parse(child.stdout.trim()));
}

const metricNames = [
  'largeMrInitializationMs',
  'mutationReconciliationMs',
  'fullProjectIndexMs',
  'hoverSemanticMedianMs',
  'hoverSemanticP95Ms',
  'jumpSemanticMedianMs',
  'jumpSemanticP95Ms',
  'relatedCacheProcessingMs',
  'fullProjectCacheProcessingMs',
  'semanticHeapDeltaBytes',
];
const report = {
  schema: 1,
  runtime: {
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    samples: sampleCount,
  },
  workload: {
    diffFiles: samples[0].diffFiles,
    diffLines: samples[0].diffLines,
    projectFiles: samples[0].projectFiles,
    projectLines: samples[0].projectLines,
    projectSourceBytes: samples[0].projectSourceBytes,
    relatedFiles: samples[0].relatedFiles,
  },
  metrics: Object.fromEntries(metricNames.map((name) => [name, summary(samples.map((sample) => sample[name]))])),
  boundaries: {
    dom: 'Happy DOM runs the real legacy content script; GitLab rendering time is excluded.',
    semantic: 'Tree-sitter parsing, indexing, hover resolution, and implementation lookup use the real semantic core.',
    cache: 'Measures source hashing, snapshot processing, restore, and indexing; network and IndexedDB latency are excluded.',
    memory: 'Heap delta after forced GC measures retained semantic index data, not total Chromium or extension-process memory.',
  },
};
console.log(JSON.stringify(report, null, 2));
