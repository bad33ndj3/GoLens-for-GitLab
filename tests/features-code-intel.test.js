import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { mount } from '../page/features/code-intel.js';

function buildFixture(bodyHTML = '') {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.write(`<!doctype html><html><body>${bodyHTML}</body></html>`);
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.NodeFilter = window.NodeFilter;
  globalThis.Event = window.Event;
  globalThis.CustomEvent = window.CustomEvent;
  globalThis.KeyboardEvent = window.KeyboardEvent;
  globalThis.innerWidth = 1000;
  globalThis.innerHeight = 800;
  globalThis.matchMedia = () => ({ matches: false });
  globalThis.CSS = window.CSS;
  return window;
}

function fakeLegacy(overrides = {}) {
  const calls = { toast: [], offerShortcutCoach: [], navigateToLocation: [] };
  return {
    fileContextFor: () => null,
    lineContextFor: () => null,
    codeCellFor: () => null,
    diffFileRoots: () => [],
    projectContext: () => ({ project: 'group/project', projectBase: 'https://gitlab.example/group/project' }),
    documentationURL: (result) => `https://pkg.go.dev/${result.importPath || result.symbol}`,
    projectPackageURL: (result) => `https://gitlab.example/group/project/-/tree/${result.ref}/${result.packagePath}`,
    visibleDiffRootForDefinition: () => null,
    navigateToLocation: async (target) => { calls.navigateToLocation.push(target); return true; },
    loadPackage: async () => {},
    preloadMergeRequest: async () => {},
    mergeRequestRefsForFile: async () => ({ headSha: 'a'.repeat(40), startSha: 'b'.repeat(40), baseSha: 'c'.repeat(40) }),
    mergeRequestIID: () => 42,
    sourceRefFor: () => 'a'.repeat(40),
    dirname: (path) => path.split('/').slice(0, -1).join('/'),
    workerRPC: async () => ({ status: 'notFound' }),
    toast: (message) => calls.toast.push(message),
    offerShortcutCoach: async (actionID) => { calls.offerShortcutCoach.push(actionID); return false; },
    requestFrame: (fn) => setTimeout(fn, 0),
    openFullSearch: () => {},
    calls,
    ...overrides,
  };
}

const pointer = { x: 10, y: 10 };

test('mount(ctx) without ctx.legacy: every method degrades instead of throwing', () => {
  buildFixture();
  const handle = mount({});
  assert.equal(handle.navigationAction('semanticJump'), false);
  assert.equal(handle.showResult({ status: 'notFound' }, pointer), false);
  assert.equal(handle.selectedSymbolLocation(), null);
  assert.equal(handle.selectedOccurrenceSourceLocation(), null);
  assert.doesNotThrow(() => handle.pinPopover());
  assert.doesNotThrow(() => handle.hidePopover());
  assert.doesNotThrow(() => handle.handleEscape({ preventDefault() {}, stopPropagation() {} }));
  assert.doesNotThrow(() => handle.setEnabled(true));
  assert.doesNotThrow(() => handle.unmount());
});

test('findReferences()/findImplementations() without ctx.legacy resolve to notFound', async () => {
  buildFixture();
  const handle = mount({});
  assert.deepEqual(await handle.findReferences(), { status: 'notFound' });
  assert.deepEqual(await handle.findImplementations(), { status: 'notFound' });
});

test('showResult(): renders a resolved definition, with the go-to-definition action only for a usage (not a declaration)', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  const definition = { name: 'Run', kind: 'function', signature: 'func Run() error', documentation: 'Run performs the operation.', path: 'service/run.go', line: 12 };

  assert.equal(handle.showResult({ status: 'resolved', isDefinition: false, definition }, pointer), true);
  const shadow = document.getElementById('golens-go-intelligence-root').shadowRoot;
  assert.equal(shadow.querySelector('.popover-title').textContent, 'Run');
  assert.equal(shadow.querySelector('.popover-header .symbol-badge').textContent, 'F');
  assert.equal(shadow.querySelector('.docs').textContent, 'Run performs the operation.');
  assert.equal(shadow.querySelectorAll('.choices button').length, 1, 'usages get a go-to-definition action');

  assert.equal(handle.showResult({ status: 'resolved', isDefinition: true, definition }, pointer), true);
  assert.equal(shadow.querySelectorAll('.choices button').length, 0, 'declarations get no go-to-definition action on themselves');
});

test('showResult(): renders references with scope-aware absence copy and a "Search complete project" action when coverage is incomplete', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  const result = {
    status: 'references',
    definition: { name: 'Run', kind: 'function', path: 'service/run.go', line: 12 },
    locations: [],
    hasMore: false,
    scope: { kind: 'indexedPackages', packageCount: 12, complete: false, searchStatus: 'limited' },
    request: { kind: 'references', ref: 'b'.repeat(40), target: pointer, definition: { name: 'Run' } },
  };
  assert.equal(handle.showResult(result, pointer), true);
  const shadow = document.getElementById('golens-go-intelligence-root').shadowRoot;
  assert.equal(shadow.querySelector('.docs').textContent, 'Not found in 12 indexed packages. Search coverage is incomplete.');
  assert.equal(shadow.querySelector('.scope').hidden, true, 'the usages list never shows the scope line (matches the demo)');
  assert.equal([...shadow.querySelectorAll('.choices button')].at(-1).textContent, 'Search complete project');
});

test('showResult(): groups multi-location references by file into compact usage rows, with a usages-count badge', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  const result = {
    status: 'references',
    definition: { name: 'JetStream', kind: 'interface', path: 'jetstream/jetstream.go', line: 15 },
    locations: [
      { path: 'packages/ezjetstream/router.go', line: 15 },
      { path: 'packages/ezjetstream/router.go', line: 76 },
      { path: 'packages/ezjetstream/stream.go', line: 273 },
    ],
    hasMore: false,
    scope: { kind: 'currentPackage' },
  };
  assert.equal(handle.showResult(result, pointer), true);
  const shadow = document.getElementById('golens-go-intelligence-root').shadowRoot;
  assert.equal(shadow.querySelector('.usages-count').hidden, false);
  assert.equal(shadow.querySelector('.usages-count').textContent, '3 usages');
  const groups = shadow.querySelectorAll('.usage-group');
  assert.equal(groups.length, 2, 'locations are grouped by file');
  assert.equal(groups[0].querySelector('.usage-group-file').textContent.startsWith('router.go'), true);
  assert.equal(groups[0].querySelectorAll('.usage-row').length, 2);
  assert.equal(groups[1].querySelectorAll('.usage-row').length, 1);
  assert.equal(shadow.querySelector('.popover').classList.contains('popover--list'), true, 'widens to the Find-Usages layout');
  assert.equal(shadow.querySelector('.popover-body').classList.contains('usages-body'), true);
  assert.equal(shadow.querySelector('.choices').classList.contains('choices--flush'), true, 'no bordered box around the grouped rows');
  assert.equal(shadow.querySelector('.signature-block').hidden, true, 'no signature preamble alongside the usages list');
  assert.equal(shadow.querySelector('.scope').hidden, true, 'no scope line crowding the usages list');
});

test('showResult({ compact: true }): a resolved definition drops its docs/signature when arriving via a usages-list click', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  const definition = { name: 'Store', kind: 'interface', signature: 'type Store interface { Get(string) ([]byte, error) }', documentation: 'Store persists blobs.', path: 'internal/cache/store.go', line: 8 };

  handle.showResult({ status: 'resolved', isDefinition: true, definition }, pointer, { compact: true });
  const shadow = document.getElementById('golens-go-intelligence-root').shadowRoot;
  assert.equal(shadow.querySelector('.docs').textContent, '', 'docs are dropped in compact mode');
  assert.equal(shadow.querySelector('.signature-block').hidden, true, 'signature is dropped in compact mode');
  assert.equal(shadow.querySelector('.popover-title').textContent, 'Store', 'the header itself still renders');

  handle.showResult({ status: 'resolved', isDefinition: true, definition }, pointer);
  assert.equal(shadow.querySelector('.docs').textContent, 'Store persists blobs.', 'a normal (non-compact) render still shows docs');
});

test('Ctrl+click on a declaration with usages shows a loading usages-count badge and skeleton rows while findReferences() is in flight', async () => {
  const window = buildFixture(`
    <section class="diff-file" data-file-path="pkg/run.go">
      <table><tbody>
        <tr><td class="new_line"><a aria-label="Added line 1">1</a></td><td class="line_content" data-line="1"><span>Run</span>()</td></tr>
      </tbody></table>
    </section>`);
  const definition = { name: 'Run', kind: 'function', path: 'pkg/run.go', line: 1 };
  let resolveReferences;
  const referencesPromise = new Promise((resolve) => { resolveReferences = resolve; });
  const legacy = fakeLegacy({
    diffFileRoots: () => [...window.document.querySelectorAll('.diff-file')],
    codeCellFor: (node) => node?.closest?.('.line_content') || null,
    fileContextFor: (cell) => (cell?.closest?.('.line_content')
      ? { path: 'pkg/run.go', oldPath: 'pkg/run.go', newPath: 'pkg/run.go', packagePath: 'pkg' }
      : null),
    lineContextFor: (cell) => ({ line: Number(cell.closest('.line_content')?.dataset.line || 0), side: 'new' }),
    workerRPC: async (method) => {
      if (method === 'resolveDefinition') return { status: 'resolved', isDefinition: true, definition };
      if (method === 'findReferences') return referencesPromise;
      return { status: 'notFound' };
    },
  });
  const handle = mount({ legacy });
  handle.setEnabled(true);

  const span = window.document.querySelector('.line_content[data-line="1"] span');
  const click = new window.Event('click', { bubbles: true });
  Object.defineProperty(click, 'target', { value: span });
  Object.defineProperty(click, 'button', { value: 0 });
  Object.defineProperty(click, 'metaKey', { value: true });
  window.document.dispatchEvent(click);

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const shadow = document.getElementById('golens-go-intelligence-root').shadowRoot;
  const usagesCount = shadow.querySelector('.usages-count');
  assert.equal(usagesCount.hidden, false, 'the usages-count badge is shown while finding usages');
  assert.equal(usagesCount.classList.contains('is-loading'), true);
  assert.equal(shadow.querySelectorAll('.usage-row-skeleton').length > 0, true, 'skeleton rows stand in for not-yet-loaded usage rows');

  resolveReferences({
    status: 'references',
    definition,
    locations: [{ path: 'pkg/other.go', line: 9 }, { path: 'pkg/other.go', line: 21 }],
    hasMore: false,
    scope: { kind: 'currentPackage' },
  });
  for (let i = 0; i < 5; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(shadow.querySelectorAll('.usage-row-skeleton').length, 0, 'skeleton rows are gone once real results render');
  assert.equal(shadow.querySelectorAll('.usage-row').length, 2);

  handle.setEnabled(false);
});

test('package loading shows its progress in the header pill, not a full-width bar', async () => {
  const window = buildFixture(`
    <section class="diff-file" data-file-path="pkg/run.go">
      <table><tbody>
        <tr><td class="new_line"><a aria-label="Added line 1">1</a></td><td class="line_content" data-line="1"><span>Run</span>()</td></tr>
      </tbody></table>
    </section>`);
  let resolveDefinition;
  const definitionPromise = new Promise((resolve) => { resolveDefinition = resolve; });
  const legacy = fakeLegacy({
    diffFileRoots: () => [...window.document.querySelectorAll('.diff-file')],
    codeCellFor: (node) => node?.closest?.('.line_content') || null,
    fileContextFor: (cell) => (cell?.closest?.('.line_content')
      ? { path: 'pkg/run.go', oldPath: 'pkg/run.go', newPath: 'pkg/run.go', packagePath: 'pkg' }
      : null),
    lineContextFor: (cell) => ({ line: Number(cell.closest('.line_content')?.dataset.line || 0), side: 'new' }),
    loadPackage: async (packagePath, ref, onProgress) => {
      onProgress?.('Loading pkg…', { phase: 'indexing', percentage: 40, completed: 2, total: 5 });
    },
    workerRPC: async (method) => (method === 'resolveDefinition' ? definitionPromise : { status: 'notFound' }),
  });
  const handle = mount({ legacy });
  handle.setEnabled(true);

  const span = window.document.querySelector('.line_content[data-line="1"] span');
  const click = new window.Event('click', { bubbles: true });
  Object.defineProperty(click, 'target', { value: span });
  Object.defineProperty(click, 'button', { value: 0 });
  Object.defineProperty(click, 'metaKey', { value: true });
  window.document.dispatchEvent(click);

  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const shadow = document.getElementById('golens-go-intelligence-root').shadowRoot;
  assert.equal(shadow.querySelector('.loading-progress'), null, 'the full-width progress bar markup is gone entirely');
  const usagesCount = shadow.querySelector('.usages-count');
  assert.equal(usagesCount.hidden, false, 'progress renders in the header pill instead');
  assert.equal(usagesCount.classList.contains('is-loading'), true);
  assert.match(usagesCount.textContent, /40%/);

  resolveDefinition({ status: 'notFound' });
  await new Promise((resolve) => setTimeout(resolve, 0));
  handle.setEnabled(false);
});

test('showResult(): groups implementations into production and collapsed test-double sections', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  const result = {
    status: 'implementations',
    interfaceDefinition: { name: 'Runner', signature: 'type Runner interface { Run() error }', path: 'service/runner.go', line: 1 },
    methodCount: 1,
    candidates: [
      { displayName: 'service.Runner', kind: 'struct', matchedMethods: 1, methodCount: 1, confidence: 'asserted', path: 'service/runner.go', line: 4, documentationLine: 3, documentation: 'Runner handles production work.', isTestDouble: false },
      { displayName: '*mocks.Runner', kind: 'struct', matchedMethods: 1, methodCount: 1, confidence: 'structural', path: 'internal/mocks/runner.go', line: 5, documentationLine: 0, documentation: '', isTestDouble: true },
    ],
  };
  assert.equal(handle.showResult(result, pointer), true);
  const shadow = document.getElementById('golens-go-intelligence-root').shadowRoot;
  assert.equal(shadow.querySelector('.popover-title').textContent, 'Implementations of Runner');
  assert.equal(shadow.querySelector('.popover-header .symbol-badge').textContent, 'I');
  assert.match(shadow.querySelector('.choices button').textContent, /service\.Runner/);
  assert.equal(shadow.querySelector('summary').textContent, 'Test doubles (1)');
});

test('showResult(): unrecognized status returns false and leaves the popover closed', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  assert.equal(handle.showResult({ status: 'somethingUnrecognized' }, pointer), false);
});

test('pinPopover()/hidePopover(): pin only takes effect while the popover is already showing; hide always closes it', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  handle.pinPopover(pointer);
  const shadow = document.getElementById?.('golens-go-intelligence-root');
  assert.equal(shadow, null, 'pinPopover() before any showResult() does not create the popover host');

  handle.showResult({ status: 'notFound', symbol: 'Missing' }, pointer);
  const popover = document.getElementById('golens-go-intelligence-root').shadowRoot.querySelector('.popover');
  assert.equal(popover.getAttribute('role'), 'tooltip', 'a plain notFound result starts passive, not pinned');
  handle.pinPopover(pointer);
  assert.equal(popover.getAttribute('role'), 'dialog');
  handle.hidePopover();
  assert.equal(popover.classList.contains('show'), false);
});

test('handleEscape(): hides a pinned popover and prevents/stops the event', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  handle.showResult({
    status: 'implementations',
    interfaceDefinition: { name: 'Runner' },
    methodCount: 0,
    candidates: [{ displayName: 'service.Runner', isTestDouble: false }],
  }, pointer);
  const popover = document.getElementById('golens-go-intelligence-root').shadowRoot.querySelector('.popover');
  assert.equal(popover.getAttribute('role'), 'dialog', 'a result with candidates pins itself');

  let prevented = false;
  let stopped = false;
  handle.handleEscape({ preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  assert.equal(popover.classList.contains('show'), false);
  assert.equal(prevented, true);
  assert.equal(stopped, true);
});

test('navigationAction("previousOccurrence"/"nextOccurrence"): toasts when nothing is selected, does not throw once enabled', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  handle.setEnabled(true);
  assert.equal(handle.navigationAction('nextOccurrence'), false);
  assert.deepEqual(legacy.calls.toast, ['Click a Go symbol to select it first.']);
  handle.setEnabled(false);
});

test('navigationAction("semanticJump"): toasts when no occurrence is selected', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  handle.setEnabled(true);
  assert.equal(handle.navigationAction('semanticJump'), true, 'semanticJump always reports handled once enabled');
  assert.deepEqual(legacy.calls.toast, ['Click a Go symbol to select it first.']);
  handle.setEnabled(false);
});

test('navigationAction("historyBack"/"historyForward"): toasts when there is no semantic-jump history yet', async () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  handle.setEnabled(true);
  assert.equal(handle.navigationAction('historyBack'), true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(legacy.calls.toast, ['No earlier semantic location.']);
  handle.setEnabled(false);
});

test('navigationAction(): returns false for an unowned action, and false entirely while disabled', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  assert.equal(handle.navigationAction('toggleBookmark'), false, 'disabled: code-intel has not been enabled yet');
  handle.setEnabled(true);
  assert.equal(handle.navigationAction('toggleBookmark'), false, 'not one of code-intel\'s five owned actions');
  handle.setEnabled(false);
});

test('unmount(): tears down listeners and removes the popover host; mount-after-unmount is safe', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  handle.setEnabled(true);
  handle.showResult({ status: 'notFound', symbol: 'Missing' }, pointer);
  assert.ok(document.getElementById('golens-go-intelligence-root'));
  handle.unmount();
  assert.equal(document.getElementById('golens-go-intelligence-root'), null);
  assert.doesNotThrow(() => handle.unmount());
});

// Occurrence highlighting: clicking a Go symbol selects it and highlights
// every identifier-boundary occurrence across the loaded diff (not
// substring matches like "Runner" containing "Run"); previously asserted
// directly against go-navigation.js's occurrenceRanges()/targetForOccurrence()
// helpers (tests/go-navigation-context.test.js, pre-ticket-21) — those moved
// into this module as private closures (ticket 04 §1's "handle + internal.js
// pure functions" test surface), so this now goes through the public
// click -> navigationAction("nextOccurrence") -> toast/selectedOccurrence-
// SourceLocation() path instead, same invariant, no export needed.
test('selecting a symbol highlights every identifier-boundary occurrence and next/previous cycles through them', () => {
  const window = buildFixture(`
    <section class="diff-file" data-file-path="pkg/run.go">
      <table><tbody>
        <tr><td class="new_line"><a aria-label="Added line 1">1</a></td><td class="line_content" data-line="1">Run Runner Run</td></tr>
        <tr><td class="new_line"><a aria-label="Added line 2">2</a></td><td class="line_content" data-line="2"><span>Run</span>()</td></tr>
      </tbody></table>
    </section>`);
  const legacy = fakeLegacy({
    diffFileRoots: () => [...window.document.querySelectorAll('.diff-file')],
    codeCellFor: (node) => node?.closest?.('.line_content') || null,
    fileContextFor: (cell) => (cell?.closest?.('.line_content')
      ? { path: 'pkg/run.go', oldPath: 'pkg/run.go', newPath: 'pkg/run.go', packagePath: 'pkg' }
      : null),
    lineContextFor: (cell) => ({ line: Number(cell.closest('.line_content')?.dataset.line || 0), side: 'new' }),
  });
  const handle = mount({ legacy });
  handle.setEnabled(true);

  const span = window.document.querySelector('.line_content[data-line="2"] span');
  const click = new window.Event('click', { bubbles: true });
  Object.defineProperty(click, 'target', { value: span });
  Object.defineProperty(click, 'button', { value: 0 });
  window.document.dispatchEvent(click);

  // The click landed on the third (row 2) of three boundary-correct "Run"
  // occurrences — "Runner" is excluded as a substring match. Cycling forward
  // from there wraps to the first.
  assert.equal(handle.navigationAction('nextOccurrence'), true);
  assert.deepEqual(legacy.calls.toast, ['Run · 1 of 3']);
  assert.deepEqual(handle.selectedOccurrenceSourceLocation(), { path: 'pkg/run.go', line: 1, character: 1, side: 'new' });

  handle.setEnabled(false);
});

// throttleToFrame: hover hit-testing runs at most once per animation frame
// during a pointer burst. Exercised through real `mousemove` events once
// setEnabled(true) has attached the document-level listener (byte-identical
// throttling behavior to go-navigation.js's former shared implementation,
// carved out verbatim per this module's header comment).
test('throttles hover hit-tests to at most one per animation frame during a pointer burst', async () => {
  const window = buildFixture(`
    <div id="diffs">
      <diff-file data-testid="rd-diff-file" data-file-data='{"old_path":"pkg/throttle.go","new_path":"pkg/throttle.go"}'>
        <a class="rd-diff-file-link" href="https://gitlab.example/group/project/-/blob/${'1'.repeat(40)}/pkg/throttle.go">pkg/throttle.go</a>
        <table><tbody><tr><td class="new_line"><a aria-label="Added line 1">1</a></td>
          <td data-testid="rd-diff-line-content"><span class="id">Target</span>()</td>
        </tr></tbody></table>
      </diff-file>
    </div>`);
  const cell = window.document.querySelector('[data-testid="rd-diff-line-content"]');
  let frameCallback = null;
  const legacy = fakeLegacy({
    codeCellFor: (node) => node?.closest?.('[data-testid="rd-diff-line-content"]') || null,
    fileContextFor: () => ({ path: 'pkg/throttle.go', oldPath: 'pkg/throttle.go', newPath: 'pkg/throttle.go', packagePath: 'pkg', ref: '1'.repeat(40) }),
    lineContextFor: () => ({ line: 1, side: 'new' }),
    requestFrame: (fn) => { frameCallback = fn; return 1; },
  });
  const handle = mount({ legacy });
  handle.setEnabled(true);
  let hitTests = 0;
  window.document.caretPositionFromPoint = () => { hitTests++; return null; };
  const span = cell.querySelector('.id');
  for (let index = 0; index < 5; index++) {
    const event = new window.Event('mousemove', { bubbles: true });
    Object.defineProperty(event, 'target', { value: span });
    Object.defineProperty(event, 'clientX', { value: 10 });
    Object.defineProperty(event, 'clientY', { value: 10 });
    window.document.dispatchEvent(event);
  }
  assert.equal(hitTests, 0, 'no hit-test runs before the animation frame fires');
  assert.equal(typeof frameCallback, 'function', 'expected a frame to be scheduled');
  frameCallback();
  assert.equal(hitTests, 1, 'a burst of pointer events over one frame produces exactly one hit-test');
  handle.setEnabled(false);
});
