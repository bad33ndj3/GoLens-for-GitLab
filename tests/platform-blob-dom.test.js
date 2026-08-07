import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  blobRootFor,
  bumpFileContextGeneration,
  caretCellFor,
  codeCellFor,
  computeFileContext,
  diffFileRoots,
  fileContextFor,
  flashDestination,
  lineContextFor,
  navigateToLocation,
  revealLine,
  visibleDiffRootForDefinition,
  waitForDiffUpdate,
} from '../page/platform/blob-dom.js';

// This suite mirrors tests/platform-diff-dom.test.js's happy-dom setup, for
// the blob-view sibling module. `caretRangeFromPoint`/`caretPositionFromPoint`
// are not implemented by happy-dom, so tests that need a caret hit stub
// `document.caretRangeFromPoint` directly — the same liberty diff-dom.js's
// tests take with other DOM APIs the test environment doesn't implement.

const SHA = 'a'.repeat(40);

function setLocation(pathname) {
  globalThis.location = {
    href: `https://gitlab.example${pathname}`,
    origin: 'https://gitlab.example',
    pathname,
  };
}

before(() => {
  setLocation('/group/project/-/blob/main/pkg/cache.go');
  globalThis.document = new Window({ url: globalThis.location.href }).document;
  globalThis.WheelEvent = new Window({ url: globalThis.location.href }).WheelEvent;
});

function mountFixture(html, pathname) {
  if (pathname) setLocation(pathname);
  const window = new Window({ url: globalThis.location.href });
  window.document.body.innerHTML = html;
  globalThis.document = window.document;
  globalThis.WheelEvent = window.WheelEvent;
  return window;
}

// Builds one `pre.code.highlight` chunk: the transparent overlay carries the
// whole chunk's text as one `\n`-joined text node, and the highlighted layer
// underneath carries one `div.line#LC{n}` per line, offset by `startLine`.
function chunkHtml(lines, startLine = 0) {
  const text = lines.join('\n');
  const highlighted = lines
    .map((line, i) => `<div class="line" id="LC${startLine + i}"><span class="hljs-x">${line}</span></div>`)
    .join('');
  return `
    <pre class="code highlight">
      <code class="line gl-z-1">${text}</code>
      <code class="gl-absolute">${highlighted}</code>
    </pre>`;
}

function blobFixture({ path = 'pkg/cache.go', chunks = [chunkHtml(['package pkg', '', 'func Foo() {', '\treturn nil', '}'])] } = {}) {
  return `
    <div data-testid="blob-viewer-file-content" class="blob-content" data-path="${path}">
      <div class="gl-flex">
        <div class="gl-absolute gl-flex gl-flex-col"></div>
        <div class="gl-w-full">
          ${chunks.join('\n')}
        </div>
      </div>
    </div>`;
}

test('resolves the blob root from a node inside it', () => {
  const window = mountFixture(blobFixture());
  const line = window.document.querySelector('#LC0');
  assert.equal(blobRootFor(line).getAttribute('data-path'), 'pkg/cache.go');
  assert.equal(blobRootFor(window.document.body), null);
});

test('computes a file context with matching old/new paths, filtered to Go files', () => {
  const window = mountFixture(blobFixture(), '/group/project/-/blob/main/pkg/cache.go');
  const root = window.document.querySelector('.blob-content');
  assert.deepEqual(
    { ...computeFileContext(root), root: undefined },
    { root: undefined, path: 'pkg/cache.go', oldPath: 'pkg/cache.go', newPath: 'pkg/cache.go', packagePath: 'pkg', ref: 'main' },
  );
});

test('parses a 40-hex-char SHA ref the same way as a branch-name ref', () => {
  const window = mountFixture(blobFixture(), `/group/project/-/blob/${SHA}/pkg/cache.go`);
  const root = window.document.querySelector('.blob-content');
  assert.equal(computeFileContext(root).ref, SHA);
});

test('returns no file context for non-Go files', () => {
  const window = mountFixture(blobFixture({ path: 'docs/readme.md' }), '/group/project/-/blob/main/docs/readme.md');
  assert.equal(computeFileContext(window.document.querySelector('.blob-content')), null);
});

test('caches file context per blob root until the generation is bumped', () => {
  const window = mountFixture(blobFixture(), '/group/project/-/blob/main/pkg/cache.go');
  const root = window.document.querySelector('.blob-content');
  const line = window.document.querySelector('#LC0');
  assert.equal(fileContextFor(line).ref, 'main');

  root.setAttribute('data-path', 'pkg/other.go');
  assert.equal(fileContextFor(line).path, 'pkg/cache.go', 'a second read hits the cache without re-resolving');

  bumpFileContextGeneration();
  assert.equal(fileContextFor(line).path, 'pkg/other.go', 'bumping the generation invalidates the cached context');
});

test('returns no file context for a node outside any blob root', () => {
  mountFixture('<p id="loose">not a blob</p>', '/group/project/-/blob/main/pkg/cache.go');
  assert.equal(fileContextFor(globalThis.document.querySelector('#loose')), null);
});

test('resolves a code cell via caret hit-testing, scoped to its own chunk', () => {
  const window = mountFixture(blobFixture({
    chunks: [chunkHtml(['aaa', 'bbb', 'ccc'], 0), chunkHtml(['ddd', 'eee', 'fff'], 3)],
  }));
  const chunks = window.document.querySelectorAll('pre.code.highlight');
  const overlay2 = chunks[1].querySelector('code.line.gl-z-1');
  const textNode2 = overlay2.firstChild;

  // Simulate a hit landing on line index 1 ("eee") within the SECOND chunk.
  // If codeCellFor counted newlines globally instead of per-chunk, this
  // would incorrectly resolve against chunk 1's lines.
  window.document.caretRangeFromPoint = () => ({ startContainer: textNode2, startOffset: 'ddd\n'.length + 1 });

  const cell = codeCellFor(overlay2, 10, 10);
  assert.equal(cell.id, 'LC4');
  assert.equal(cell.closest('pre.code.highlight'), chunks[1]);
});

test('resolves the first chunk correctly when a second chunk is also present', () => {
  const window = mountFixture(blobFixture({
    chunks: [chunkHtml(['aaa', 'bbb', 'ccc'], 0), chunkHtml(['ddd', 'eee', 'fff'], 3)],
  }));
  const chunks = window.document.querySelectorAll('pre.code.highlight');
  const overlay1 = chunks[0].querySelector('code.line.gl-z-1');
  const textNode1 = overlay1.firstChild;

  window.document.caretRangeFromPoint = () => ({ startContainer: textNode1, startOffset: 'aaa\n'.length + 1 });

  const cell = codeCellFor(overlay1, 10, 10);
  assert.equal(cell.id, 'LC1');
});

test('falls back to caretPositionFromPoint when caretRangeFromPoint is unavailable', () => {
  const window = mountFixture(blobFixture());
  const overlay = window.document.querySelector('code.line.gl-z-1');
  const textNode = overlay.firstChild;
  delete window.document.caretRangeFromPoint;
  window.document.caretPositionFromPoint = () => ({ offsetNode: textNode, offset: 'package pkg\n'.length });

  const cell = codeCellFor(overlay, 5, 5);
  assert.equal(cell.id, 'LC1');
});

test('returns null when the target is outside any chunk', () => {
  const window = mountFixture(blobFixture());
  assert.equal(codeCellFor(window.document.querySelector('.blob-content'), 1, 1), null);
});

test('falls back to closest div.line when coordinates are omitted', () => {
  const window = mountFixture(blobFixture());
  const highlightedLine = window.document.querySelector('#LC2');
  const inner = highlightedLine.querySelector('.hljs-x');
  assert.equal(codeCellFor(inner), highlightedLine);
});

test('remaps an overlay caret hit into the resolved highlighted cell', () => {
  const window = mountFixture(blobFixture());
  const overlay = window.document.querySelector('code.line.gl-z-1');
  const textNode = overlay.firstChild;
  const cell = window.document.querySelector('#LC2'); // "func Foo() {"

  // Chunk text: "package pkg\n\nfunc Foo() {\n\treturn nil\n}"
  // Offset of "Foo" inside the chunk = len("package pkg\n\nfunc ") = 19.
  const chunkOffset = 'package pkg\n\nfunc '.length;
  const result = caretCellFor(textNode, chunkOffset, cell);
  assert.ok(result.node);
  // Within line 2 ("func Foo() {"), "Foo" starts at offset 5.
  assert.equal(result.offset, 'func '.length);
});

test('remaps an overlay caret hit in a SECOND chunk using chunk-relative offsets, not cell.id', () => {
  // Deliberately proves the implementation choice: caretCellFor derives the
  // within-chunk line index by \n-counting the chunk's own overlay text
  // (chunk-relative), not by parsing `cell.id` (document-global). Using
  // `cell.id` here would be wrong, since chunk 2's lines are LC3.. while its
  // own text/newline-count restarts at index 0.
  const window = mountFixture(blobFixture({
    chunks: [chunkHtml(['aaa', 'bbb', 'ccc'], 0), chunkHtml(['ddd', 'eee foo', 'fff'], 3)],
  }));
  const chunks = window.document.querySelectorAll('pre.code.highlight');
  const overlay2 = chunks[1].querySelector('code.line.gl-z-1');
  const textNode2 = overlay2.firstChild;
  const cell = chunks[1].querySelector('#LC4'); // "eee foo", chunk-relative index 1

  // Chunk 2 text: "ddd\neee foo\nfff". Offset of "foo" = len("ddd\neee ") = 8.
  const chunkOffset = 'ddd\neee '.length;
  const result = caretCellFor(textNode2, chunkOffset, cell);
  assert.equal(result.offset, 'eee '.length);
});

test('caretCellFor returns null for a detached or missing cell', () => {
  const window = mountFixture(blobFixture());
  const overlay = window.document.querySelector('code.line.gl-z-1');
  assert.equal(caretCellFor(overlay.firstChild, 0, null), null);
  const detached = window.document.createElement('div');
  detached.id = 'LC0';
  assert.equal(caretCellFor(overlay.firstChild, 0, detached), null);
});

test('reads the line number from a highlighted cell id', () => {
  const window = mountFixture(blobFixture());
  assert.deepEqual(lineContextFor(window.document.querySelector('#LC2')), { line: 2, side: 'new' });
});

test('returns no line context for a cell without a valid LC id', () => {
  const window = mountFixture(blobFixture());
  const div = window.document.createElement('div');
  assert.equal(lineContextFor(div), null);
  div.id = 'not-a-line';
  assert.equal(lineContextFor(div), null);
});

test('lists the single blob root, or none, for diffFileRoots', () => {
  const window = mountFixture(blobFixture());
  assert.deepEqual(diffFileRoots(), [window.document.querySelector('.blob-content')]);
  mountFixture('<p>no blob here</p>');
  assert.deepEqual(diffFileRoots(), []);
});

test('resolves waitForDiffUpdate on the first mutation of the observed root', async () => {
  const window = mountFixture('<div id="root"></div>');
  const root = window.document.querySelector('#root');
  const updated = waitForDiffUpdate(root);
  root.insertAdjacentHTML('beforeend', '<span>added</span>');
  await updated;
});

test('revealLine returns an already-rendered line immediately', async () => {
  const window = mountFixture(blobFixture());
  const root = window.document.querySelector('.blob-content');
  const line = await revealLine(root, 2);
  assert.equal(line?.id, 'LC2');
});

test('revealLine gives up and returns null when there is no scrollable ancestor', async () => {
  const window = mountFixture(blobFixture());
  const root = window.document.querySelector('.blob-content');
  // No element in this fixture has overflow-y:auto/scroll with real
  // overflow, so findScrollContainer can never find a container to trigger
  // virtualization through — revealLine must give up immediately rather
  // than hang.
  assert.equal(await revealLine(root, 999), null);
});

test('revealLine retries a bounded number of times then gives up for a permanently-missing line', async () => {
  const window = mountFixture(`
    <div id="scroller" style="overflow-y: auto;">
      ${blobFixture()}
    </div>`);
  const scroller = window.document.querySelector('#scroller');
  // happy-dom does not implement real layout/scroll geometry, so force the
  // "genuinely scrollable" signals findScrollContainer checks for.
  Object.defineProperty(scroller, 'scrollHeight', { value: 5000, configurable: true });
  Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true });
  let wheelDispatches = 0;
  scroller.addEventListener('wheel', () => { wheelDispatches++; });

  const root = window.document.querySelector('.blob-content');
  const line = await revealLine(root, 999); // never rendered in this fixture
  assert.equal(line, null);
  assert.ok(wheelDispatches > 0, 'revealLine should attempt to dispatch synthetic wheel events to trigger virtualization');
  assert.ok(wheelDispatches <= 10, 'the retry loop must be bounded');
});

test('matches a definition path against the currently-loaded blob root', () => {
  const window = mountFixture(blobFixture({ path: 'pkg/cache.go' }), '/group/project/-/blob/main/pkg/cache.go');
  assert.equal(visibleDiffRootForDefinition({ path: 'pkg/cache.go' }), window.document.querySelector('.blob-content'));
  assert.equal(visibleDiffRootForDefinition({ path: 'pkg/other.go' }), null);
});

test('flashes a destination element with the navigation attribute', () => {
  const window = mountFixture('<div id="target"></div>');
  const target = window.document.querySelector('#target');
  flashDestination(target);
  assert.equal(target.hasAttribute('data-golens-navigation-destination'), true);
  flashDestination(null);
});

test('navigates to a location inside the loaded blob and reports success', async () => {
  const window = mountFixture(blobFixture(), '/group/project/-/blob/main/pkg/cache.go');
  const line = window.document.querySelector('#LC2');
  const scrolled = [];
  line.scrollIntoView = (options) => scrolled.push(options);
  assert.equal(await navigateToLocation({ path: 'pkg/cache.go', line: 2 }), true);
  assert.deepEqual(scrolled, [{ behavior: 'smooth', block: 'center' }]);
  assert.equal(line.hasAttribute('data-golens-navigation-destination'), true);
});

test('reports failure when the location is not in the loaded blob', async () => {
  mountFixture(blobFixture(), '/group/project/-/blob/main/pkg/cache.go');
  assert.equal(await navigateToLocation({ path: 'pkg/absent.go', line: 2 }), false);
});
