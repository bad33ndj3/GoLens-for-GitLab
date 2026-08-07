// platform/blob-dom — the blob-view-DOM primitives every feature reads
// GitLab's standalone file view (`/-/blob/<ref>/<path>`) through. This is the
// blob-view sibling of platform/diff-dom.js: same idiom (plain named
// function exports, no `createX(deps)` factory — pure DOM readers with
// nothing to inject), same module-scoped generation-cache trick for the same
// reason (page/main.js and any observer that watches the blob DOM reach this
// module through their own dynamic `import()`, and within one frame's
// isolated world the extension-origin module URL resolves to a single
// instance, so the cache and generation counter stay shared).
//
// Deliberately NOT sharing state, code, or an import edge with diff-dom.js:
// a blob page and a diff page never coexist in the same frame, but keeping
// the two modules independent means neither has to reason about the other's
// DOM shape, and a bug in one can't leak into the other. The generation
// counter below is therefore this module's own, not diff-dom.js's.
//
// Known deliberate duplication (same rationale diff-dom.js's header records
// relative to platform/gitlab-api.js): `normalizePath`/`dirname` below are
// byte-identical copies of diff-dom.js's private helpers of the same name.
// This is the DOM-reading layer; importing across platform modules purely to
// dedupe ~15 lines of string handling would add an edge with no real payoff.
//
// GitLab's blob viewer virtualizes rendering: a large file only has a
// fraction of its lines in the DOM at a time, split across multiple
// `pre.code.highlight` chunk elements, with more chunks appearing as the
// user scrolls. Every DOM read here that walks lines (`codeCellFor`,
// `caretCellFor`) is deliberately scoped to a single chunk — never a
// document-wide `querySelectorAll('div.line')` — because line indices are
// only meaningful within their own chunk.
//
// `revealLine`'s virtualization trigger is the one genuinely unverified
// piece of this module: live testing (twice, against real gitlab.com blob
// pages) confirmed that setting `scrollTop` and dispatching a plain `scroll`
// event does NOT cause GitLab's virtualizer to render new chunks — it
// appears to listen only to native wheel-level input. This module dispatches
// a synthetic `WheelEvent` instead, which is the best available substitute
// but was not confirmed against a real page (no browser access during this
// module's authoring). The retry loop bounds itself and returns null rather
// than hanging if that assumption turns out to be wrong.

const GO_FILE = /\.go$/i;
const BLOB_ROOT_SELECTOR = '[data-testid="blob-viewer-file-content"].blob-content[data-path]';
const CHUNK_SELECTOR = 'pre.code.highlight';
const OVERLAY_SELECTOR = 'code.line.gl-z-1';
const HIGHLIGHT_SELECTOR = 'code.gl-absolute';
const DEFAULT_LINE_HEIGHT = 19;

function normalizePath(value) {
  return value
    .replace(/[‎‏‪-‮]/g, '')
    .replace(/\s*\/\s*/g, '/')
    .trim();
}

function dirname(path) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

// Blob URLs are `/-/blob/<ref>/<path>`, where `<ref>` is very often a branch
// name (unlike diff-dom.js's parseBlobLink, which mostly sees 40-hex-char
// commit SHAs pinned into diff markup). Since the path is already known
// (read straight off `data-path`), resolving the ref is just: find the
// marker, decode, and strip the known path suffix — falling back to the
// SHA-shaped-prefix and first-segment heuristics diff-dom.js's parseBlobLink
// also falls back to, for the rare case the suffix strip doesn't line up
// (e.g. URL-encoding differences).
function parseRefFromLocation(path) {
  const marker = '/-/blob/';
  const index = location.pathname.indexOf(marker);
  if (index < 0) return null;
  const rest = decodeURIComponent(location.pathname.slice(index + marker.length));
  const normalizedPath = normalizePath(path);
  if (normalizedPath && rest.endsWith(`/${normalizedPath}`)) {
    return rest.slice(0, -(normalizedPath.length + 1));
  }
  const shaMatch = rest.match(/^([0-9a-f]{40})\/(.+)$/i);
  if (shaMatch) return shaMatch[1];
  const slash = rest.indexOf('/');
  return slash < 0 ? null : rest.slice(0, slash);
}

export function blobRootFor(node) {
  return node?.closest?.(BLOB_ROOT_SELECTOR) || null;
}

export function computeFileContext(root) {
  const rawPath = root?.getAttribute?.('data-path');
  if (!rawPath) return null;
  const path = normalizePath(rawPath);
  if (!GO_FILE.test(path)) return null;
  const ref = parseRefFromLocation(path);
  if (ref == null) return null;
  return { root, path, oldPath: path, newPath: path, packagePath: dirname(path), ref };
}

// Cached per blob root, same idiom (and same reason) as diff-dom.js's
// fileContextFor: this runs on every un-throttled mousemove target, and its
// DOM work (attribute reads, location parsing) is identical for every cell
// in the file. Whatever observer watches the blob DOM for chunk/virtualizer
// changes bumps the generation via `bumpFileContextGeneration()` so a hover
// right after new chunks render never resolves a stale context. Negative
// results (non-Go files) are cached too.
let fileContextGeneration = 0;
const fileContextCache = new WeakMap();

export function bumpFileContextGeneration() {
  fileContextGeneration++;
}

export function fileContextFor(node) {
  const root = blobRootFor(node);
  if (!root) return null;
  const cached = fileContextCache.get(root);
  if (cached && cached.generation === fileContextGeneration) return cached.context;
  const context = computeFileContext(root);
  fileContextCache.set(root, { generation: fileContextGeneration, context });
  return context;
}

// Feature-detects between caretPositionFromPoint and caretRangeFromPoint in
// the same order code-intel.js's own caretAtPoint does, for consistency
// across the extension (and because that's the order Firefox vs.
// Chromium/WebKit support favors).
function caretRawAtPoint(clientX, clientY) {
  const doc = document;
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(clientX, clientY);
    if (!position?.offsetNode) return null;
    return { node: position.offsetNode, offset: position.offset };
  }
  if (doc.caretRangeFromPoint) {
    const range = doc.caretRangeFromPoint(clientX, clientY);
    if (!range?.startContainer) return null;
    return { node: range.startContainer, offset: range.startOffset };
  }
  return null;
}

// Resolves a (node, offset) hit into a character offset within `container`'s
// full text content, via Range — robust even if the caret API hands back a
// node nested deeper than container's expected single flat text node.
function characterOffsetWithin(container, node, offset) {
  if (!container || !node || !container.contains(node)) return null;
  const range = document.createRange();
  range.selectNodeContents(container);
  try {
    range.setEnd(node, offset);
  } catch {
    return null;
  }
  return range.toString().length;
}

function newlineCountBefore(text, characterOffset) {
  let count = 0;
  const limit = Math.min(characterOffset, text.length);
  for (let i = 0; i < limit; i++) {
    if (text[i] === '\n') count++;
  }
  return count;
}

// codeCellFor(target, clientX, clientY): the key blob-view hit-test. The
// transparent `code.line.gl-z-1` overlay (which receives every pointer
// event) holds one flat text node per chunk with the whole chunk's text,
// `\n`-joined; the visually-highlighted `code.gl-absolute` layer underneath
// it is unhittable directly. Live-verified mapping: counting `\n` characters
// in the overlay's text up to the caret's character offset gives the exact
// 0-based index, WITHIN THAT SAME CHUNK, of the corresponding highlighted
// `div.line`.
export function codeCellFor(target, clientX, clientY) {
  const chunk = target?.closest?.(CHUNK_SELECTOR);
  if (!chunk) return null;
  if (clientX == null || clientY == null) {
    // Defensive fallback for direct unit-testing convenience only — it
    // CANNOT succeed against a real blob page. `event.target` there is
    // always the transparent `code.line.gl-z-1` overlay (it receives every
    // pointer event), which has no `div.line` ancestor; the `div.line`s
    // live in the sibling `code.gl-absolute` layer underneath, which per
    // this module's header is unhittable via elementFromPoint/closest.
    // Every production call site MUST pass clientX/clientY (i.e. call this
    // as `codeCellFor(event.target, event.clientX, event.clientY)`) or blob
    // hover/hit-testing will silently return null forever.
    return target?.closest?.('div.line') || null;
  }
  const overlay = chunk.querySelector(OVERLAY_SELECTOR);
  if (!overlay) return null;
  const caret = caretRawAtPoint(clientX, clientY);
  if (!caret) return null;
  const characterOffset = characterOffsetWithin(overlay, caret.node, caret.offset);
  if (characterOffset == null) return null;
  const index = newlineCountBefore(overlay.textContent || '', characterOffset);
  const lines = chunk.querySelectorAll(`${HIGHLIGHT_SELECTOR} div.line`);
  return lines[index] || null;
}

// Walks text nodes inside `cell` in document order, returning the one that
// contains character offset `targetOffset` (and the offset within it). This
// is the "cell's own single text-containing node, walking into its
// firstChild appropriately" the contract describes — written generally
// enough to also cope with a line that turned out to carry several
// `span.hljs-*` children rather than one flat text node.
function locateOffsetInCell(cell, targetOffset) {
  const doc = cell.ownerDocument || document;
  const walker = doc.createTreeWalker(cell, 4 /* NodeFilter.SHOW_TEXT */);
  let node = walker.nextNode();
  let consumed = 0;
  let last = null;
  while (node) {
    const length = node.textContent.length;
    if (consumed + length >= targetOffset) {
      return { node, offset: Math.max(0, Math.min(targetOffset - consumed, length)) };
    }
    consumed += length;
    last = node;
    node = walker.nextNode();
  }
  if (last) return { node: last, offset: last.textContent.length };
  return { node: cell, offset: 0 };
}

// caretCellFor(node, offset, cell): remaps a caret hit that landed in the
// transparent overlay's text into the equivalent (node, offset) inside
// `cell`, the highlighted `div.line` codeCellFor resolved for the same
// point. Both layers render identical per-line text, so once the
// chunk-relative character offset of the hit is known (recomputed the same
// way codeCellFor derives it) and the character offset where `cell`'s own
// line starts within the chunk is known (from `cell.id` -> line index ->
// summing preceding lines' lengths + 1 `\n` each), the within-line offset is
// just the difference.
export function caretCellFor(node, offset, cell) {
  if (!cell || !cell.isConnected) return null;
  const chunk = cell.closest(CHUNK_SELECTOR);
  if (!chunk) return null;
  const overlay = chunk.querySelector(OVERLAY_SELECTOR);
  if (!overlay) return null;
  const characterOffset = characterOffsetWithin(overlay, node, offset);
  if (characterOffset == null) return null;
  const text = overlay.textContent || '';
  const lines = text.split('\n');
  const index = newlineCountBefore(text, characterOffset);
  if (index < 0 || index >= lines.length) return null;
  let lineStart = 0;
  for (let i = 0; i < index; i++) lineStart += lines[i].length + 1;
  const withinLineOffset = Math.max(0, Math.min(characterOffset - lineStart, lines[index].length));
  const resolved = locateOffsetInCell(cell, withinLineOffset);
  return resolved;
}

export function lineContextFor(cell) {
  const match = /^LC(\d+)$/.exec(cell?.id || '');
  if (!match) return null;
  return { line: Number(match[1]), side: 'new' };
}

export function diffFileRoots() {
  const root = document.querySelector(BLOB_ROOT_SELECTOR);
  return root ? [root] : [];
}

export function waitForDiffUpdate(root) {
  return new Promise((resolve) => {
    let observer;
    const MutationObserverConstructor = root.ownerDocument?.defaultView?.MutationObserver || globalThis.MutationObserver;
    const finish = () => {
      clearTimeout(timeout);
      observer?.disconnect();
      resolve();
    };
    const timeout = setTimeout(finish, 400);
    if (!MutationObserverConstructor) return;
    observer = new MutationObserverConstructor(finish);
    observer.observe(root, { childList: true, subtree: true });
  });
}

// The real scroll container is the nearest ancestor with computed
// `overflow-y: auto`/`scroll` AND actual overflow (`scrollHeight >
// clientHeight`) — live-verified NOT to be `.blob-content` itself (already
// full height) and NOT `window` (`scrollY` stays 0 on this page).
function findScrollContainer(root) {
  const doc = root?.ownerDocument || document;
  const view = doc.defaultView || globalThis;
  let node = root;
  while (node) {
    const style = view.getComputedStyle?.(node);
    const overflowY = style?.overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node;
    node = node.parentElement;
  }
  return null;
}

function estimateLineHeight(root) {
  const line = root.querySelector('div.line');
  const height = line?.getBoundingClientRect?.().height;
  return height || DEFAULT_LINE_HEIGHT;
}

// Total scroll height is unknowable while content is virtualized (chunks
// that haven't rendered yet occupy no layout space, so `scrollHeight` lies),
// which rules out computing one absolute `scrollTop` target up front. What
// IS knowable each attempt is which lines are actually rendered right now —
// use that to decide which direction still needs nudging, and keep nudging
// (rather than computing a stale absolute delta against a scrollTop we
// already moved) until the target line shows up or attempts run out.
function renderedLineRange(root) {
  const ids = [...root.querySelectorAll('div.line[id^="LC"]')]
    .map((el) => Number(el.id.slice(2)))
    .filter(Number.isFinite);
  if (!ids.length) return null;
  return { min: Math.min(...ids), max: Math.max(...ids) };
}

export async function revealLine(root, line) {
  const immediate = root.querySelector(`#LC${line}`);
  if (immediate) return immediate;
  const scrollContainer = findScrollContainer(root);
  if (!scrollContainer) return null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const magnitude = Math.max(scrollContainer.clientHeight * 0.9, DEFAULT_LINE_HEIGHT * 10);
    const range = renderedLineRange(root);
    // Direction: below anything rendered so far -> scroll down; above -> up;
    // nothing rendered yet, or `line` sits inside a virtualization gap
    // within the rendered range -> fall back to a rough estimate from line
    // height, since we have no better evidence yet.
    let deltaY;
    if (range && line > range.max) deltaY = magnitude;
    else if (range && line < range.min) deltaY = -magnitude;
    else {
      const estimatedTop = estimateLineHeight(root) * line;
      deltaY = estimatedTop >= scrollContainer.scrollTop ? magnitude : -magnitude;
    }
    const nextTop = Math.max(0, scrollContainer.scrollTop + deltaY);
    // KNOWN NOT TO WORK (live-verified twice against real gitlab.com blob
    // pages): scrollTop assignment + dispatching a plain 'scroll' event does
    // not trigger GitLab's virtualizer to render new chunks. Set scrollTop
    // anyway (harmless, may help positioning) and dispatch a synthetic wheel
    // event as the actual trigger attempt — UNVERIFIED, see module header.
    scrollContainer.scrollTop = nextTop;
    scrollContainer.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true, cancelable: true }));
    const updated = waitForDiffUpdate(root);
    await updated;
    const hit = root.querySelector(`#LC${line}`);
    if (hit) return hit;
  }
  return root.querySelector(`#LC${line}`);
}

export function visibleDiffRootForDefinition(definition) {
  const root = document.querySelector(BLOB_ROOT_SELECTOR);
  if (!root) return null;
  const path = normalizePath(root.getAttribute('data-path') || '');
  return path && path === normalizePath(definition?.path || '') ? root : null;
}

export function flashDestination(target) {
  if (!target) return;
  target.removeAttribute('data-golens-navigation-destination');
  void target.offsetWidth;
  target.setAttribute('data-golens-navigation-destination', '');
  setTimeout(() => target.removeAttribute('data-golens-navigation-destination'), 1300);
}

export async function navigateToLocation(location, { smooth = true } = {}) {
  const root = visibleDiffRootForDefinition(location);
  if (!root) return false;
  const line = await revealLine(root, location.line);
  const target = line || root;
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: smooth && !reducedMotion ? 'smooth' : 'auto', block: 'center' });
  flashDestination(target);
  return true;
}
