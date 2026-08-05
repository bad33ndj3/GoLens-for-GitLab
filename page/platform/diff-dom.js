// platform/diff-dom — the diff-DOM primitives every feature reads GitLab's
// merge-request diff through. These used to live in go-navigation.js and
// were handed to all four carved-out `legacy` bags (bookmarks, code-intel,
// and through code-intel indirectly mr-preload/project-search). They are
// pure DOM readers with no injectable dependencies, so this module
// deliberately exports plain named functions instead of a `createX(deps)`
// factory — there is nothing to inject and no per-instance state worth
// constructing.
//
// The one piece of state, `fileContextFor`'s generation-keyed cache, lives
// at module scope rather than inside a returned object, the same idiom (and
// for the same reason) as platform/overlay-registry: go-navigation.js and
// page/main.js are separate classic content scripts that each reach this
// module through their own dynamic `import()`, and both must observe the
// same cache and the same generation counter. Within one frame's isolated
// world the extension-origin module URL resolves to a single instance.
//
// go-navigation.js still owns the diff MutationObserver that decides *when*
// the cache is stale; it calls `bumpFileContextGeneration()` here instead of
// owning the counter itself.
//
// Known remaining duplication, deliberately not fixed:
//   - `normalizePath`/`parseBlobLink`/`dirname` below are byte-identical
//     copies of the ones platform/gitlab-api.js owns. They stay private
//     copies on purpose: this is the DOM-reading layer and that is the
//     network layer, and importing across would add a platform→platform edge
//     purely to dedupe ~15 lines of pure string handling. gitlab-api.js's
//     header records the same decision.
//   - bookmarks.js:70 keeps its own private `lineFromAnchor`, and
//     keyboard-nav.js:94/118 + code-intel.js:418 keep their own
//     `diffFileRoots`/`flashDestination`. Those modules are left untouched.

const GO_FILE = /\.go$/i;
const DIFF_ROOT_SELECTOR = 'diff-file, .diff-file, [data-testid="diff-file"], [data-testid="rd-diff-file"], [data-file-path]';

function normalizePath(value) {
  return value
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/\s*\/\s*/g, '/')
    .trim();
}

function dirname(path) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function parseBlobLink(anchor, expectedPath = '') {
  if (!anchor?.href) return null;
  const url = new URL(anchor.href, location.href);
  const marker = '/-/blob/';
  const index = url.pathname.indexOf(marker);
  if (index < 0) return null;
  const rest = decodeURIComponent(url.pathname.slice(index + marker.length));
  const normalizedExpected = normalizePath(expectedPath);
  if (normalizedExpected && rest.endsWith(`/${normalizedExpected}`)) {
    return { ref: rest.slice(0, -(normalizedExpected.length + 1)), path: normalizedExpected };
  }
  const match = rest.match(/^([0-9a-f]{40})\/(.+)$/i);
  if (match) return { ref: match[1], path: normalizePath(match[2]) };
  const slash = rest.indexOf('/');
  return slash < 0 ? null : { ref: rest.slice(0, slash), path: normalizePath(rest.slice(slash + 1)) };
}

export function diffFileRoots() {
  return [...document.querySelectorAll(DIFF_ROOT_SELECTOR)].filter((candidate) => {
    const outerRapid = candidate.parentElement?.closest?.('diff-file');
    return !outerRapid || outerRapid === candidate;
  });
}

export function diffRootFor(node) {
  // Rapid Diffs wraps every file in a <diff-file data-file-data="…">
  // custom element. Prefer that outer element over the inner article so the
  // commit-pinned old/new paths remain available to the resolver.
  return node?.closest('diff-file')
    || node?.closest('.diff-file, [data-testid="diff-file"], [data-testid="rd-diff-file"], [data-file-path], .rd-diff-file')
    || node?.closest('table')?.parentElement;
}

export function rapidFileData(root) {
  const value = root?.getAttribute?.('data-file-data');
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
}

export function computeFileContext(root) {
  const fileData = rapidFileData(root);
  const title = root.querySelector('[data-testid="file-title"], .file-title-name, .diff-file-header a[href*="/-/blob/"], .rd-diff-file-link, [data-testid="rd-diff-file-header"] a[href*="/-/blob/"]');
  const dataPath = root.getAttribute('data-file-path')
    || title?.getAttribute('data-file-path')
    || fileData.new_path
    || fileData.old_path;
  const path = normalizePath(dataPath || title?.textContent || '');
  if (!GO_FILE.test(path)) return null;
  const oldPath = normalizePath(fileData.old_path || path);
  const newPath = normalizePath(fileData.new_path || path);
  const links = [...root.querySelectorAll('a[href*="/-/blob/"]')];
  const link = links.find((candidate) => {
    const parsed = parseBlobLink(candidate, newPath) || parseBlobLink(candidate, oldPath);
    return parsed?.path === newPath || parsed?.path === oldPath;
  }) || links[0];
  const parsed = parseBlobLink(link, newPath) || parseBlobLink(link, oldPath) || parseBlobLink(link, path);
  if (!parsed) return null;
  return { root, path: newPath, oldPath, newPath, packagePath: dirname(newPath), ref: parsed.ref };
}

// Cached per diff-file root: `fileContextFor` runs on every un-throttled
// mousemove target and its DOM work (title/blob-link queries) is the same
// for every cell in a file. `fileContextGeneration` is bumped synchronously
// (not debounced) by go-navigation.js's diff observer, through
// `bumpFileContextGeneration()`, whenever the diff DOM actually changes, so
// a hover right after an expansion/re-render never resolves a stale
// root/path/ref. Negative results (non-Go files) are cached too, so
// hovering unsupported files stays cheap.
let fileContextGeneration = 0;
const fileContextCache = new WeakMap();

export function bumpFileContextGeneration() {
  fileContextGeneration++;
}

export function fileContextFor(node) {
  const root = diffRootFor(node);
  if (!root) return null;
  const cached = fileContextCache.get(root);
  if (cached && cached.generation === fileContextGeneration) return cached.context;
  const context = computeFileContext(root);
  fileContextCache.set(root, { generation: fileContextGeneration, context });
  return context;
}

export function codeCellFor(target) {
  const direct = target?.closest('td.line_content, td[class*="line-content"], [data-testid="diff-line-content"], [data-testid="rd-diff-line-content"], .rd-diff-code, .rd-diff-line-code');
  if (direct) return direct;
  const cell = target?.closest('td, [role="cell"], [role="gridcell"]');
  if (!cell || cell.querySelector('a[href*="#"]')) return null;
  const row = cell.closest('tr, [role="row"]');
  if (!row?.querySelector('a[href*="#"], [data-line-number]')) return null;
  return cell;
}

export function lineFromAnchor(anchor) {
  if (!anchor) return 0;
  const data = anchor.getAttribute?.('data-line-number') || anchor.dataset?.lineNumber;
  if (/^\d+$/.test(data || '')) return Number(data);
  const label = `${anchor.getAttribute?.('aria-label') || ''} ${anchor.title || ''}`;
  const labelMatch = label.match(/(?:added|deleted|line)\D*(\d+)\s*$/i);
  if (labelMatch) return Number(labelMatch[1]);
  const text = (anchor.textContent || '').trim();
  if (/^\d+$/.test(text)) return Number(text);
  const hash = anchor.hash || anchor.getAttribute?.('href') || '';
  const hashMatch = hash.match(/(?:_|L)(\d+)$/i);
  return hashMatch ? Number(hashMatch[1]) : 0;
}

export function lineAnchorFor(root, line, preferredSide = '') {
  const matches = [...root.querySelectorAll('a[href*="#"], [data-line-number]')]
    .filter((anchor) => lineFromAnchor(anchor) === line);
  if (preferredSide) {
    const preferred = matches.find((anchor) => {
      const context = `${anchor.getAttribute('aria-label') || ''} ${anchor.closest('td, [role="cell"], [role="gridcell"]')?.className || ''}`;
      return preferredSide === 'old' ? /deleted|old/i.test(context) : !/deleted|old/i.test(context);
    });
    if (preferred) return preferred;
  }
  return matches.find((anchor) => !/deleted|old/i.test(`${anchor.getAttribute('aria-label') || ''} ${anchor.closest('td, [role="cell"], [role="gridcell"]')?.className || ''}`)) || matches[0] || null;
}

export function expansionDirectionForLine(line, visibleLines) {
  const lines = [...new Set(visibleLines.filter((candidate) => Number.isFinite(candidate) && candidate > 0))].sort((a, b) => a - b);
  if (!lines.length) return null;
  if (line < lines[0]) return 'up';
  if (line > lines[lines.length - 1]) return 'down';
  return null;
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

export async function revealLine(root, line, preferredSide = '') {
  for (let attempt = 0; attempt < 25; attempt++) {
    const target = lineAnchorFor(root, line, preferredSide);
    if (target) return target;
    const visibleLines = [...root.querySelectorAll('a[href*="#"], [data-line-number]')].map(lineFromAnchor);
    const direction = expansionDirectionForLine(line, visibleLines);
    const selector = direction
      ? `button[data-click="expandLines"][data-expand-direction="${direction}"]`
      : '.js-unfold-all, button[data-click="showFullFile"]';
    const button = [...root.querySelectorAll(selector)].find((candidate) => !candidate.disabled);
    if (!button) return null;
    const updated = waitForDiffUpdate(root);
    button.click();
    await updated;
  }
  return lineAnchorFor(root, line, preferredSide);
}

// visibleDiffRootForDefinition/flashDestination/navigateToLocation: shared
// "reveal a source location inside the currently-loaded diff" primitives —
// NOT code-intel-exclusive despite having lived next to its former popover
// code. Both bookmarks.js's `legacy.navigateToLocation` and code-intel.js's
// `legacy.navigateToLocation` reach them.
export function visibleDiffRootForDefinition(definition) {
  const matchingRoots = [...document.querySelectorAll(DIFF_ROOT_SELECTOR)];
  return matchingRoots.find((candidate) => {
    const data = rapidFileData(candidate);
    const paths = [candidate.getAttribute('data-file-path'), data.new_path, data.old_path, candidate.querySelector('[data-testid="file-title"], .file-title-name, .rd-diff-file-link')?.textContent]
      .filter(Boolean).map(normalizePath);
    return paths.includes(normalizePath(definition.path));
  });
}

// diffFileIdentity(root) -> normalized path for any diff file root (unlike
// computeFileContext, not Go-filtered), the writer counterpart to
// visibleDiffRootForDefinition's reader: `visibleDiffRootForDefinition({
// path: diffFileIdentity(root) })` re-finds the same file after GitLab
// rebuilds every file root from scratch, which it does when switching
// inline/parallel diff view — see controls.js's toggleDiffView(), which uses
// this to restore scroll position across that rebuild.
export function diffFileIdentity(root) {
  if (!root) return null;
  const data = rapidFileData(root);
  const path = root.getAttribute('data-file-path')
    || data.new_path || data.old_path
    || root.querySelector('[data-testid="file-title"], .file-title-name, .rd-diff-file-link')?.textContent;
  return path ? normalizePath(path) : null;
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
  const line = await revealLine(root, location.line, location.side);
  const target = line?.closest('tr, [role="row"]') || root;
  const reducedMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  target.scrollIntoView({ behavior: smooth && !reducedMotion ? 'smooth' : 'auto', block: 'center' });
  flashDestination(target);
  return true;
}

export function lineContextFor(cell) {
  const row = cell.closest('tr, [role="row"]');
  if (!row) return null;
  const cells = [...row.querySelectorAll(':scope > td, :scope > [role="cell"], :scope > [role="gridcell"]')];
  const cellIndex = Math.max(0, cells.indexOf(cell));
  const preceding = cells.slice(0, cellIndex).reverse();
  for (const candidate of preceding) {
    const anchor = candidate.querySelector('a[href*="#"], [data-line-number]');
    const line = lineFromAnchor(anchor || candidate);
    if (!line) continue;
    const position = cell.getAttribute('data-position') || candidate.getAttribute('data-position') || '';
    const label = `${anchor?.getAttribute('aria-label') || ''} ${candidate.className || ''}`;
    return { line, side: position === 'old' || (!position && /deleted|old/i.test(label)) ? 'old' : 'new' };
  }
  return null;
}
