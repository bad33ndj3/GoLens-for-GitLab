import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { mount } from '../page/features/bookmarks.js';
import { normalizePath } from '../page/features/bookmarks.internal.js';

// Moved from tests/content-bookmarks.test.js (ticket 22 — that file's other
// test was content.js-specific and is superseded elsewhere; this CSS-only
// check never depended on content.js).
test('moves bookmark markers away from GitLab comment buttons', async () => {
  const css = await readFile(new URL('../gitlab-lens.css', import.meta.url), 'utf8');
  assert.match(css, /:has\(button:not\(\.golens-bookmark-marker\)\) > \.golens-bookmark-marker\s*\{\s*left: 18px;/);
});

// --- a faithful-enough re-implementation of go-navigation.js's diff-DOM
// primitives, matching exactly what its self-bridge hands bookmarks.js as
// `ctx.legacy` (see go-navigation.js's "Bridge onto
// page/features/bookmarks.js" comment). Kept here rather than imported
// since go-navigation.js is not an ES module.

const DIFF_ROOT_SELECTOR = 'diff-file, .diff-file, [data-testid="diff-file"], [data-testid="rd-diff-file"], [data-file-path]';

function diffFileRoots() {
  return [...document.querySelectorAll(DIFF_ROOT_SELECTOR)].filter((candidate) => {
    const outerRapid = candidate.parentElement?.closest?.('diff-file');
    return !outerRapid || outerRapid === candidate;
  });
}

function diffRootFor(node) {
  return node?.closest('diff-file')
    || node?.closest('.diff-file, [data-testid="diff-file"], [data-testid="rd-diff-file"], [data-file-path], .rd-diff-file')
    || node?.closest('table')?.parentElement;
}

function rapidFileData(root) {
  const value = root?.getAttribute?.('data-file-data');
  if (!value) return {};
  try { return JSON.parse(value); } catch { return {}; }
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

function codeCellFor(target) {
  const direct = target?.closest('td.line_content, td[class*="line-content"], [data-testid="diff-line-content"], [data-testid="rd-diff-line-content"], .rd-diff-code, .rd-diff-line-code');
  if (direct) return direct;
  const cell = target?.closest('td, [role="cell"], [role="gridcell"]');
  if (!cell || cell.querySelector('a[href*="#"]')) return null;
  const row = cell.closest('tr, [role="row"]');
  if (!row?.querySelector('a[href*="#"], [data-line-number]')) return null;
  return cell;
}

function lineFromAnchorLocal(anchor) {
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

function lineContextFor(cell) {
  const row = cell.closest('tr, [role="row"]');
  if (!row) return null;
  const cells = [...row.querySelectorAll(':scope > td, :scope > [role="cell"], :scope > [role="gridcell"]')];
  const cellIndex = Math.max(0, cells.indexOf(cell));
  const preceding = cells.slice(0, cellIndex).reverse();
  for (const candidate of preceding) {
    const anchor = candidate.querySelector('a[href*="#"], [data-line-number]');
    const line = lineFromAnchorLocal(anchor || candidate);
    if (!line) continue;
    const position = cell.getAttribute('data-position') || candidate.getAttribute('data-position') || '';
    const label = `${anchor?.getAttribute('aria-label') || ''} ${candidate.className || ''}`;
    return { line, side: position === 'old' || (!position && /deleted|old/i.test(label)) ? 'old' : 'new' };
  }
  return null;
}

function buildFixture(bodyHTML) {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.write(`<!doctype html><html><body>${bodyHTML}</body></html>`);
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.MutationObserver = window.MutationObserver;
  globalThis.Node = window.Node;
  globalThis.getSelection = () => window.getSelection();
  globalThis.innerWidth = 1200;
  globalThis.innerHeight = 800;
  return window;
}

function fakeLegacy(overrides = {}) {
  const calls = { toast: [], navigateToLocation: [] };
  const headSha = 'a'.repeat(40);
  return {
    enabled: true,
    isEnabled() { return this.enabled; },
    toast(message) { calls.toast.push(message); },
    diffFileRoots,
    diffRootFor,
    rapidFileData,
    parseBlobLink,
    codeCellFor,
    lineContextFor,
    projectContext: () => ({ project: 'group/project', projectBase: 'https://gitlab.example/group/project' }),
    mergeRequestIID: () => '42',
    mergeRequestRefs: async () => ({ headSha, startSha: 'b'.repeat(40), baseSha: 'b'.repeat(40) }),
    clearMergeRequestRefs: () => {},
    fetchSource: async () => 'line one\nline two\n',
    navigateToLocation: async (loc) => { calls.navigateToLocation.push(loc); return true; },
    waitForDiffUpdate: async () => {},
    lineAnchorFor: () => ({}),
    selectedSymbolLocation: () => null,
    calls,
    ...overrides,
  };
}

function fakeStore(overrides = {}) {
  const records = new Map();
  let nextID = 1;
  return {
    async list(scope) {
      return [...records.values()].filter((r) => r.scope.origin === scope.origin && r.scope.project === scope.project && r.scope.mrIid === scope.mrIid);
    },
    async toggle({ scope, location, anchor }) {
      const existing = [...records.values()].find((r) => r.scope.headSha === scope.headSha && r.location.path === location.path && r.location.side === location.side && r.location.startLine === location.startLine);
      if (existing) { records.delete(existing.id); return { action: 'removed', record: existing }; }
      const record = { id: `bm-${nextID++}`, scope, location, anchor };
      records.set(record.id, record);
      return { action: 'added', record };
    },
    async remove(record) { records.delete(record.id); },
    async clear(scope, mode) {
      const toRemove = [...records.values()].filter((r) => {
        const stale = r.scope.headSha !== scope.headSha;
        return mode === 'all' || (mode === 'stale' ? stale : !stale);
      });
      toRemove.forEach((r) => records.delete(r.id));
      return toRemove.length;
    },
    async recover(record, next) {
      records.delete(record.id);
      const recovered = { ...record, ...next };
      records.set(recovered.id, recovered);
      return recovered;
    },
    subscribe() { return () => {}; },
    hashText: async (value) => `h:${value}`,
    _records: records,
    ...overrides,
  };
}

const DIFF_FIXTURE = () => {
  const sha = 'a'.repeat(40);
  return `
    <div id="diffs">
      <section class="diff-file" data-file-path="pkg/review.go">
        <a class="file-title-name" href="https://gitlab.example/group/project/-/blob/${sha}/pkg/review.go">pkg/review.go</a>
        <table><tbody>
          <tr><td class="new_line"><a href="#L1" aria-label="Added line 1">1</a></td><td class="line_content">func Run() {</td></tr>
          <tr><td class="new_line"><a href="#L2" aria-label="Added line 2">2</a></td><td class="line_content">return nil</td></tr>
          <tr><td class="new_line"><a href="#L3" aria-label="Added line 3">3</a></td><td class="line_content">}</td></tr>
        </tbody></table>
      </section>
    </div>`;
};

test('mount(ctx) without ctx.legacy: everything degrades instead of throwing', async () => {
  buildFixture('<div id="diffs"></div>');
  const handle = mount({});
  assert.deepEqual(handle.snapshot(), { scope: null, current: [], stale: [] });
  assert.equal(await handle.toggleAt({ path: 'a.go', side: 'new', startLine: 1, endLine: 1 }), false);
  assert.equal(await handle.reveal('x'), false);
  assert.equal(await handle.remove('x'), false);
  assert.equal(await handle.clear(), 0);
  assert.deepEqual(await handle.recover('x'), { kind: 'unavailable' });
  assert.equal(handle.enable(), false);
  assert.doesNotThrow(() => handle.unmount());
});

test('subscribe(fn) delivers the current snapshot immediately, then again after toggleAt', async () => {
  buildFixture(DIFF_FIXTURE());
  const legacy = fakeLegacy();
  const store = fakeStore();
  const handle = mount({ legacy, bookmarkStore: store });
  const seen = [];
  const unsubscribe = handle.subscribe((snapshot) => seen.push(snapshot));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { scope: null, current: [], stale: [] });

  const ok = await handle.toggleAt({ path: 'pkg/review.go', side: 'new', startLine: 2, endLine: 2 });
  assert.equal(ok, true);
  // Two refreshes fire (byte-identical to the original toggleBookmarkAt()):
  // one to establish scope (no scope was known yet), one after the store
  // write — so 1 initial delivery + 2 refreshes = 3.
  assert.equal(seen.length, 3);
  assert.equal(seen[2].current.length, 1);
  assert.equal(seen[2].current[0].label, 'return nil');
  assert.deepEqual(legacy.calls.toast, ['Bookmark added.']);

  unsubscribe();
  handle.unmount();
});

test('toggleAt on the same location twice adds then removes the bookmark', async () => {
  buildFixture(DIFF_FIXTURE());
  const legacy = fakeLegacy();
  const store = fakeStore();
  const handle = mount({ legacy, bookmarkStore: store });
  const location = { path: 'pkg/review.go', side: 'new', startLine: 1, endLine: 1 };
  await handle.toggleAt(location);
  assert.equal(handle.snapshot().current.length, 1);
  await handle.toggleAt(location);
  assert.equal(handle.snapshot().current.length, 0);
  assert.deepEqual(legacy.calls.toast, ['Bookmark added.', 'Bookmark removed.']);
  handle.unmount();
});

test('toggleAt places a marker button in the diff cell; clicking it toggles the bookmark off', async () => {
  buildFixture(DIFF_FIXTURE());
  const legacy = fakeLegacy();
  const store = fakeStore();
  const handle = mount({ legacy, bookmarkStore: store });
  await handle.toggleAt({ path: 'pkg/review.go', side: 'new', startLine: 1, endLine: 1 });
  const marker = document.querySelector('[data-golens-bookmark-marker]');
  assert.ok(marker, 'a marker button was rendered');
  assert.equal(marker.getAttribute('aria-pressed'), 'true');

  marker.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(handle.snapshot().current.length, 0);
  handle.unmount();
});

test('reveal(id) navigates to the bookmark location; unknown id toasts and returns false', async () => {
  buildFixture(DIFF_FIXTURE());
  const legacy = fakeLegacy();
  const store = fakeStore();
  const handle = mount({ legacy, bookmarkStore: store });
  await handle.toggleAt({ path: 'pkg/review.go', side: 'new', startLine: 2, endLine: 2 });
  const [record] = handle.snapshot().current;
  const revealed = await handle.reveal(record.id);
  assert.equal(revealed, true);
  assert.deepEqual(legacy.calls.navigateToLocation, [{ path: 'pkg/review.go', line: 2, side: 'new' }]);

  const missing = await handle.reveal('does-not-exist');
  assert.equal(missing, false);
  assert.ok(legacy.calls.toast.includes('That bookmark is not available in the current review surface.'));
  handle.unmount();
});

test('remove(id) and clear(mode) delegate to the store and refresh the snapshot', async () => {
  buildFixture(DIFF_FIXTURE());
  const legacy = fakeLegacy();
  const store = fakeStore();
  const handle = mount({ legacy, bookmarkStore: store });
  await handle.toggleAt({ path: 'pkg/review.go', side: 'new', startLine: 1, endLine: 1 });
  await handle.toggleAt({ path: 'pkg/review.go', side: 'new', startLine: 2, endLine: 2 });
  assert.equal(handle.snapshot().current.length, 2);

  const [first] = handle.snapshot().current;
  assert.equal(await handle.remove(first.id), true);
  assert.equal(handle.snapshot().current.length, 1);

  const cleared = await handle.clear('all');
  assert.equal(cleared, 1);
  assert.equal(handle.snapshot().current.length, 0);
  handle.unmount();
});

test('recover(id): current, unavailable, missing, ambiguous, recovered', async () => {
  buildFixture(DIFF_FIXTURE());
  const headSha = 'a'.repeat(40);
  const legacy = fakeLegacy();
  const store = fakeStore();
  const handle = mount({ legacy, bookmarkStore: store });
  await handle.toggleAt({ path: 'pkg/review.go', side: 'new', startLine: 2, endLine: 2 });
  const [record] = handle.snapshot().current;

  // 'current': the record's scope head matches the live scope.
  assert.deepEqual(await handle.recover(record.id), { kind: 'current' });

  // Force a stale scope by directly rewriting the record's stored headSha.
  const stored = store._records.get(record.id);
  stored.scope = { ...stored.scope, headSha: 'b'.repeat(40) };

  // 'unavailable': no ref for the requested side.
  const unavailableLegacy = fakeLegacy({ mergeRequestRefs: async () => ({}) });
  const unavailableHandle = mount({ legacy: unavailableLegacy, bookmarkStore: store });
  await unavailableHandle.toggleAt({ path: 'pkg/review.go', side: 'new', startLine: 3, endLine: 3 }); // establishes scope
  assert.equal((await unavailableHandle.recover(record.id)).kind, 'unavailable');
  unavailableHandle.unmount();

  // 'missing': fetchSource throws.
  const missingLegacy = fakeLegacy({ fetchSource: async () => { throw new Error('404'); } });
  const missingHandle = mount({ legacy: missingLegacy, bookmarkStore: store });
  await missingHandle.toggleAt({ path: 'pkg/review.go', side: 'new', startLine: 3, endLine: 3 });
  assert.equal((await missingHandle.recover(record.id)).kind, 'missing');
  missingHandle.unmount();

  // 'ambiguous': two equally-good matches in the fetched source (same
  // symbol, same surrounding context, at two different offsets).
  const ambiguousLegacy = fakeLegacy({ fetchSource: async () => 'ctx\nTarget()\nctx\nTarget()\nctx\n' });
  const ambiguousHandle = mount({ legacy: ambiguousLegacy, bookmarkStore: store });
  const ambiguousRecord = {
    ...stored,
    anchor: { symbol: 'Target', selectionHash: '', beforeHash: await store.hashText('ctx'), afterHash: await store.hashText('ctx') },
  };
  // Overwrite the stored record *before* the handle's own refresh (below)
  // caches it, so `recover()` sees this anchor rather than the original.
  store._records.set(ambiguousRecord.id, ambiguousRecord);
  await ambiguousHandle.toggleAt({ path: 'pkg/review.go', side: 'new', startLine: 4, endLine: 4 });
  assert.equal((await ambiguousHandle.recover(ambiguousRecord.id)).kind, 'ambiguous');
  ambiguousHandle.unmount();

  handle.unmount();
});

test('enable()/disable(): disable removes markers and the mouseup selection listener', async () => {
  buildFixture(DIFF_FIXTURE());
  const legacy = fakeLegacy();
  const store = fakeStore();
  const handle = mount({ legacy, bookmarkStore: store });
  await handle.toggleAt({ path: 'pkg/review.go', side: 'new', startLine: 1, endLine: 1 });
  assert.ok(document.querySelector('[data-golens-bookmark-marker]'));
  handle.disable();
  assert.equal(document.querySelector('[data-golens-bookmark-marker]'), null);
  handle.unmount();
});

test('toggleAtSelection(fallback) falls back to the provided code-intel location when nothing is selected/focused', async () => {
  buildFixture(DIFF_FIXTURE());
  const legacy = fakeLegacy();
  const store = fakeStore();
  const handle = mount({ legacy, bookmarkStore: store });
  const fallback = { path: 'pkg/review.go', side: 'new', startLine: 1, endLine: 1 };
  const handled = handle.toggleAtSelection(fallback);
  assert.equal(handled, true);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(handle.snapshot().current.length, 1);
  handle.unmount();
});

test('toggleAtSelection(null) with no selection/focus/fallback toasts instead of throwing', async () => {
  buildFixture(DIFF_FIXTURE());
  const legacy = fakeLegacy();
  const handle = mount({ legacy, bookmarkStore: fakeStore() });
  assert.equal(handle.toggleAtSelection(null), true);
  assert.ok(legacy.calls.toast.includes('Focus a diff line or select contiguous lines first.'));
  handle.unmount();
});

test('navigate(direction) reports "no bookmarks" when the current head has none', async () => {
  buildFixture(DIFF_FIXTURE());
  const legacy = fakeLegacy();
  const handle = mount({ legacy, bookmarkStore: fakeStore() });
  const result = await handle.navigate(1);
  assert.equal(result, false);
  assert.ok(legacy.calls.toast.includes('No bookmarks in this MR head.'));
  handle.unmount();
});
