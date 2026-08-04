// page/features/bookmarks.js — hides: bookmark anchoring/recovery, the diff
// markers, the selection-to-bookmark UI, and the drawer's data (ticket 18;
// boundary from ticket 03 §2, interface from ticket 04 §3). Carved out of
// go-navigation.js's former bookmark* functions (anchoring, recovery,
// markers, selection) and content.js's former bookmark drawer *state*
// (`state.bookmarkSnapshot`/`bookmarkUnsubscribe`/`bookmarkDrawerReturnFocus`
// — the drawer's DOM stays in content.js, now a pure consumer of this
// module's `subscribe`/`snapshot` plus the mutating methods below, instead
// of holding bookmark data of its own). Pure recovery-candidate computation
// lives in bookmarks.internal.js; DOM/store orchestration lives here.
//
// mount(ctx) -> { unmount, subscribe(fn) -> unsubscribe, snapshot() ->
// snapshot, toggleAt(location) -> Promise<boolean>, reveal(id) ->
// Promise<boolean>, remove(id) -> Promise<boolean>, clear(mode) ->
// Promise<count>, recover(id) -> Promise<{kind, ...}> }. `registerBookmark
// Surface`/`refreshBookmarks` do NOT survive as interface (ticket 18's
// explicit ask): this module owns diff-marker placement itself — there is
// exactly one surface (the GitLab diff) now that markers live here instead
// of being registered by go-navigation.js from the outside.
//
// Same entanglement shape ticket 19/20 hit: bookmark anchoring needs
// go-navigation.js's diff-DOM primitives (diffFileRoots, diffRootFor,
// rapidFileData, parseBlobLink, codeCellFor, lineContextFor), its MR/network
// helpers (projectContext, mergeRequestIID, mergeRequestRefs,
// clearMergeRequestRefs, fetchSource), its reveal/navigation helpers
// (navigateToLocation, waitForDiffUpdate, lineAnchorFor), its toast surface,
// and its code-intel selection state (the active hovered/selected symbol,
// for the anchor's `symbol` field) — none of which have migrated out of
// go-navigation.js yet (later tickets). Ticket 03 §3's escape hatch applies
// exactly as it did for mr-preload/project-search: `ctx.legacy` is a
// capability bag go-navigation.js's own self-bridge builds from its own
// closures; `ctx.bookmarkStore` is the `GoLensBookmarks.createStore()`
// instance (bookmark-store.js, out of scope per ticket 18 — it stays a
// global, entering here only via `ctx`) plus its `hashText` helper. When
// page/main.js mounts this feature for message-routing consistency, `ctx`
// carries neither — every method below degrades to a no-op/false/0/
// `{kind:'unavailable'}` instead of running a second, competing diff
// observer and a second set of markers on the same page (bookmarks, unlike
// project-search, genuinely owns live DOM in the diff — a second functional
// instance would double-render markers and double-observe the diff).
//
// Deviation from ticket 18's literal `{subscribe, snapshot, toggleAt,
// reveal, remove, clear, recover}` text: four more methods exist on the
// returned handle — `enable()`/`disable()` (go-navigation.js's init()/
// teardown() call these; they used to inline bookmark-store setup and
// marker/timer/selection-UI teardown directly), `toggleAtSelection
// (fallbackLocation)` and `navigate(direction)` (go-navigation.js's
// runNavigationAction() 'toggleBookmark'/'previousBookmark'/'nextBookmark'
// branches — the selection-or-focused-line-or-code-intel-fallback chain and
// the ordered next/previous walk are keyboard-shortcut concerns with no
// natural fit in the ticket's 7-method public contract). All four are
// consumed only by go-navigation.js's self-bridge, never by content.js or
// page/main.js — same treatment as project-search.js's `minimize()`.
import {
  normalizePath,
  snapshotRecords,
  bookmarkRecoveryCandidates,
  recoveryOutcome,
} from './bookmarks.internal.js';

const COMMIT_SHA = /^[0-9a-f]{40}$/i;
const CODE_CELL_SELECTOR = 'td.line_content, td[class*="line-content"], [data-testid="diff-line-content"], [data-testid="rd-diff-line-content"], .rd-diff-code, .rd-diff-line-code';

// lineFromAnchor(anchor) -> the line number a diff-line anchor/cell encodes,
// byte-identical to go-navigation.js's former lineFromAnchor(). Kept here
// (not bookmarks.internal.js) because it reads live DOM node
// attributes/text, which ticket 04 §1's internal seam excludes — it has no
// other go-navigation.js dependency, so it's duplicated rather than routed
// through `legacy`.
function lineFromAnchor(anchor) {
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

// bookmarkProjectionMutation(mutation) -> whether a MutationRecord is
// entirely this module's own marker/selection-UI DOM (so this module's own
// diff observer, and go-navigation.js's separate diff observer, both ignore
// mutations they caused themselves — without this guard on *both* sides,
// placing a marker retriggers reconciliation forever). Byte-identical to
// go-navigation.js's former bookmarkProjectionMutation(); go-navigation.js
// keeps its own copy of the same selector guard (documented there) since it
// can no longer import this module's internals.
function bookmarkProjectionMutation(mutation) {
  const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
  return nodes.length > 0 && nodes.every((node) => node.nodeType === 1 && (
    node.matches?.('[data-golens-bookmark-marker], #golens-bookmark-selection-root')
    || node.querySelector?.('[data-golens-bookmark-marker], #golens-bookmark-selection-root')
  ));
}

const SELECTION_UI_MARKUP = (left, top) => `
  <style>
    :host { all:initial; position:fixed; z-index:var(--golens-z-popover,2147483001); left:${left}px; top:${top}px; color-scheme:dark; }
    button { border:1px solid var(--golens-border-default,#4b5563); border-radius:6px; padding:6px 9px; background:var(--golens-surface-raised,#20242b); color:var(--golens-text-primary,#f3f4f6); font:600 12px/1.2 system-ui,sans-serif; box-shadow:var(--golens-shadow-sm,0 4px 12px rgba(0,0,0,.3)); cursor:pointer; }
    button:hover { border-color:var(--golens-primary,#fc6d26); }
    button:focus-visible { outline:2px solid var(--golens-focus-ring,#3794ff); outline-offset:2px; }
  </style><button type="button">Bookmark selected lines</button>`;

export function mount(ctx = {}) {
  const legacy = ctx.legacy || null;
  const bookmarkStore = ctx.bookmarkStore || null;
  const hashText = ctx.hashText || bookmarkStore?.hashText || (async (value) => value);

  let unmounted = false;
  let scope = null;
  let records = [];
  const listeners = new Set();
  let storeUnsubscribe = null;
  let refreshTimerCancel = null;
  let diffObserver = null;
  let diffDebounced = null;
  let navigationIndex = -1;
  let focusedLocation = null;
  let selectionUIHost = null;

  // --- bookmark-specific DOM glue (uses `legacy` primitives only) --------

  function bookmarkFileContextFor(node) {
    const root = legacy.diffRootFor(node);
    if (!root) return null;
    const fileData = legacy.rapidFileData(root);
    const title = root.querySelector('[data-testid="file-title"], .file-title-name, .diff-file-header a[href*="/-/blob/"], .rd-diff-file-link, [data-testid="rd-diff-file-header"] a[href*="/-/blob/"]');
    const fallbackPath = normalizePath(root.getAttribute('data-file-path') || root.getAttribute('data-path') || title?.textContent || '');
    const oldPath = normalizePath(fileData.old_path || fallbackPath);
    const newPath = normalizePath(fileData.new_path || fallbackPath);
    if (!oldPath && !newPath) return null;
    const links = [...root.querySelectorAll('a[href*="/-/blob/"]')];
    const parsed = links.map((link) => legacy.parseBlobLink(link, newPath) || legacy.parseBlobLink(link, oldPath)).find(Boolean);
    return { root, oldPath: oldPath || newPath, newPath: newPath || oldPath, ref: parsed?.ref || '' };
  }

  function bookmarkLineContextFor(node) {
    const row = node?.closest?.('tr, [role="row"]');
    if (!row) return null;
    const directCell = node.closest?.('td, [role="cell"], [role="gridcell"]');
    const cells = [...row.querySelectorAll(':scope > td, :scope > [role="cell"], :scope > [role="gridcell"]')];
    const candidates = directCell ? [directCell, ...cells.filter((cell) => cell !== directCell)] : cells;
    for (const candidate of candidates) {
      const anchor = candidate.querySelector?.('a[href*="#"], [data-line-number]');
      const line = lineFromAnchor(anchor || candidate);
      if (!line) continue;
      const position = candidate.getAttribute('data-position') || anchor?.getAttribute('data-position') || '';
      const label = `${anchor?.getAttribute('aria-label') || ''} ${candidate.className || ''}`;
      const side = position === 'old' || (!position && /deleted|old/i.test(label)) ? 'old' : 'new';
      return { line, side, row, lineCell: candidate };
    }
    return null;
  }

  function bookmarkLocationForNode(node) {
    const file = bookmarkFileContextFor(node);
    const line = bookmarkLineContextFor(node);
    if (!file || !line) return null;
    return { path: line.side === 'old' ? file.oldPath : file.newPath, side: line.side, startLine: line.line, endLine: line.line };
  }

  async function currentBookmarkScope() {
    const context = legacy.projectContext();
    const mrIid = legacy.mergeRequestIID();
    if (!context || !mrIid) return null;
    let domHeadSha = '';
    for (const root of legacy.diffFileRoots()) {
      const file = bookmarkFileContextFor(root);
      if (COMMIT_SHA.test(file?.ref || '')) { domHeadSha = file.ref.toLowerCase(); break; }
    }
    let refs = await legacy.mergeRequestRefs();
    if (domHeadSha && COMMIT_SHA.test(refs.headSha || '') && refs.headSha.toLowerCase() !== domHeadSha) {
      legacy.clearMergeRequestRefs();
      refs = await legacy.mergeRequestRefs();
    }
    let headSha = refs.headSha || '';
    if (!COMMIT_SHA.test(headSha)) headSha = domHeadSha;
    return COMMIT_SHA.test(headSha) ? { origin: location.origin, project: context.project, mrIid, headSha: headSha.toLowerCase() } : null;
  }

  function bookmarkRootForLocation(locationValue) {
    return legacy.diffFileRoots().find((root) => {
      const file = bookmarkFileContextFor(root);
      return file && (locationValue.side === 'old' ? file.oldPath : file.newPath) === locationValue.path;
    }) || null;
  }

  function visibleBookmarkLine(locationValue, lineNumber) {
    const root = bookmarkRootForLocation(locationValue);
    if (!root) return null;
    for (const row of root.querySelectorAll('tr, [role="row"]')) {
      const cells = [...row.querySelectorAll(CODE_CELL_SELECTOR)];
      const cell = cells.find((candidate) => {
        const line = legacy.lineContextFor(candidate);
        return line?.line === lineNumber && line.side === locationValue.side;
      });
      if (cell) return { root, row, cell, text: cell.textContent || '' };
    }
    return null;
  }

  async function bookmarkAnchorForLocation(locationValue) {
    const lines = [];
    for (let line = locationValue.startLine; line <= locationValue.endLine; line++) {
      const visible = visibleBookmarkLine(locationValue, line);
      if (!visible) return { symbol: '', selectionHash: '', beforeHash: '', afterHash: '' };
      lines.push(visible.text);
    }
    const before = visibleBookmarkLine(locationValue, locationValue.startLine - 1)?.text || '';
    const after = visibleBookmarkLine(locationValue, locationValue.endLine + 1)?.text || '';
    const selected = legacy.selectedSymbolLocation?.();
    const symbol = selected && selected.path === locationValue.path && selected.side === locationValue.side
      && selected.line >= locationValue.startLine && selected.line <= locationValue.endLine
      ? selected.identifier || '' : '';
    return {
      symbol,
      selectionHash: await hashText(lines.join('\n')),
      beforeHash: await hashText(before),
      afterHash: await hashText(after),
    };
  }

  function bookmarkSelectionState() {
    const selection = globalThis.getSelection?.();
    if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return { location: null, invalid: false };
    const nodeElement = (node) => (node.nodeType === 1 ? node : node.parentElement);
    const anchorCell = legacy.codeCellFor(nodeElement(selection.anchorNode));
    const focusCell = legacy.codeCellFor(nodeElement(selection.focusNode));
    if (!anchorCell || !focusCell) return { location: null, invalid: true };
    const anchorFile = bookmarkFileContextFor(anchorCell);
    const focusFile = bookmarkFileContextFor(focusCell);
    const anchorLine = legacy.lineContextFor(anchorCell);
    const focusLine = legacy.lineContextFor(focusCell);
    if (!anchorFile || !focusFile || !anchorLine || !focusLine || anchorFile.root !== focusFile.root || anchorLine.side !== focusLine.side) {
      return { location: null, invalid: true };
    }
    const startLine = Math.min(anchorLine.line, focusLine.line);
    const endLine = Math.max(anchorLine.line, focusLine.line);
    const path = anchorLine.side === 'old' ? anchorFile.oldPath : anchorFile.newPath;
    for (let line = startLine; line <= endLine; line++) {
      if (!visibleBookmarkLine({ path, side: anchorLine.side }, line)) return { location: null, invalid: true };
    }
    return { location: { path, side: anchorLine.side, startLine, endLine }, invalid: false };
  }

  function removeSelectionUI() {
    selectionUIHost?.remove();
    selectionUIHost = null;
  }

  function reconcileSelectionUI() {
    removeSelectionUI();
    if (!legacy?.isEnabled?.()) return;
    const selection = globalThis.getSelection?.();
    const selectionState = bookmarkSelectionState();
    if (!selectionState.location || !selection?.rangeCount) return;
    const bounds = selection.getRangeAt(0).getBoundingClientRect();
    const host = document.createElement('div');
    host.id = 'golens-bookmark-selection-root';
    const shadow = host.attachShadow({ mode: 'open' });
    const left = Math.max(8, Math.min(innerWidth - 190, bounds.right + 8));
    const top = Math.max(8, Math.min(innerHeight - 42, bounds.bottom + 6));
    shadow.innerHTML = SELECTION_UI_MARKUP(left, top);
    shadow.querySelector('button').addEventListener('click', () => void toggleAtLocation(selectionState.location));
    document.body.append(host);
    selectionUIHost = host;
  }

  // --- snapshot / subscribe ------------------------------------------------

  function computeSnapshot() {
    const contextTextByID = {};
    if (legacy) {
      for (const record of records) {
        contextTextByID[record.id] = visibleBookmarkLine(record.location, record.location.startLine)?.text || '';
      }
    }
    return snapshotRecords(records, scope, contextTextByID);
  }

  function emitSnapshot() {
    const snap = computeSnapshot();
    for (const listener of listeners) listener(snap);
  }

  function subscribe(listener) {
    listeners.add(listener);
    listener(computeSnapshot());
    return () => listeners.delete(listener);
  }

  // --- markers ---------------------------------------------------------

  function bookmarkMarkerCells() {
    if (!legacy) return [];
    const cells = new Set();
    for (const root of legacy.diffFileRoots()) {
      for (const anchor of root.querySelectorAll('a[href*="#"], [data-line-number]')) {
        if (!lineFromAnchor(anchor)) continue;
        const cell = anchor.closest('td, [role="cell"], [role="gridcell"]');
        if (cell) cells.add(cell);
      }
    }
    return [...cells];
  }

  function reconcileDiffBookmarkMarkers(recordsForMarkers) {
    if (!legacy?.isEnabled?.()) {
      document.querySelectorAll('[data-golens-bookmark-marker]').forEach((marker) => marker.remove());
      return;
    }
    const retained = new Set();
    for (const cell of bookmarkMarkerCells()) {
      const locationValue = bookmarkLocationForNode(cell);
      if (!locationValue) continue;
      const matchingRecord = recordsForMarkers.find((record) => record.scope.headSha === scope?.headSha
        && record.location.path === locationValue.path && record.location.side === locationValue.side
        && locationValue.startLine >= record.location.startLine && locationValue.startLine <= record.location.endLine);
      const bookmarked = Boolean(matchingRecord);
      let button = [...cell.children].find((child) => child.matches?.('[data-golens-bookmark-marker]'));
      if (!button) {
        button = document.createElement('button');
        button.type = 'button';
        button.className = 'golens-bookmark-marker';
        button.dataset.golensBookmarkMarker = '';
        button.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 2.25h8v11.5L8 11.1l-4 2.65z"></path></svg>';
        button.addEventListener('focus', () => { focusedLocation = bookmarkLocationForNode(button); });
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          const targetLocation = bookmarkLocationForNode(button);
          focusedLocation = targetLocation;
          const record = records.find((candidate) => candidate.scope.headSha === scope?.headSha
            && candidate.location.path === targetLocation?.path && candidate.location.side === targetLocation?.side
            && targetLocation.startLine >= candidate.location.startLine && targetLocation.startLine <= candidate.location.endLine);
          if (record) void remove(record.id).then(() => legacy.toast('Bookmark removed.')).catch(() => legacy.toast('Could not update the bookmark.'));
          else void toggleAtLocation(targetLocation);
        });
        cell.append(button);
      }
      retained.add(button);
      button.setAttribute('aria-pressed', String(bookmarked));
      button.setAttribute('aria-label', `${bookmarked ? 'Remove' : 'Add'} bookmark on ${locationValue.side} line ${locationValue.startLine}`);
      button.title = bookmarked ? 'Remove bookmark' : 'Bookmark this line';
    }
    document.querySelectorAll('[data-golens-bookmark-marker]').forEach((marker) => { if (!retained.has(marker)) marker.remove(); });
  }

  // --- refresh / scope ---------------------------------------------------

  async function refresh() {
    refreshTimerCancel?.();
    refreshTimerCancel = null;
    if (!legacy) { scope = null; records = []; emitSnapshot(); return computeSnapshot(); }
    scope = await currentBookmarkScope();
    records = scope && bookmarkStore ? await bookmarkStore.list(scope) : [];
    reconcileDiffBookmarkMarkers(records);
    emitSnapshot();
    return computeSnapshot();
  }

  function scheduleRefresh() {
    if (refreshTimerCancel || !legacy) return;
    const id = globalThis.setTimeout(() => { refreshTimerCancel = null; refresh().catch(() => undefined); }, 20);
    refreshTimerCancel = () => globalThis.clearTimeout(id);
  }

  function ensureObserver() {
    if (diffObserver || !legacy) return;
    let debounceTimer = null;
    diffDebounced = () => {
      globalThis.clearTimeout(debounceTimer);
      debounceTimer = globalThis.setTimeout(scheduleRefresh, 50);
    };
    diffDebounced.cancel = () => globalThis.clearTimeout(debounceTimer);
    diffObserver = new MutationObserver((mutations) => {
      if (mutations.length && mutations.every(bookmarkProjectionMutation)) return;
      diffDebounced();
    });
    const root = document.getElementById('diffs') || document.body;
    diffObserver.observe(root, { childList: true, subtree: true, characterData: true });
  }

  function ensureStoreSubscription() {
    if (storeUnsubscribe || !bookmarkStore) return;
    storeUnsubscribe = bookmarkStore.subscribe(() => scheduleRefresh());
  }

  // --- toggle / reveal / remove / clear / recover -------------------------

  async function toggleAtLocation(locationValue) {
    if (!bookmarkStore || !scope) await refresh();
    if (!bookmarkStore || !scope || !locationValue) {
      legacy?.toast?.('Bookmarking is unavailable until the MR head is known.');
      return false;
    }
    try {
      const anchor = await bookmarkAnchorForLocation(locationValue);
      const result = await bookmarkStore.toggle({ scope, location: locationValue, anchor });
      await refresh();
      legacy?.toast?.(result.action === 'added' ? 'Bookmark added.' : 'Bookmark removed.');
      removeSelectionUI();
      return true;
    } catch {
      legacy?.toast?.('Could not update the bookmark.');
      return false;
    }
  }

  function toggleAt(locationValue) {
    if (unmounted || !legacy) return Promise.resolve(false);
    return toggleAtLocation(locationValue);
  }

  // toggleAtSelection(fallbackLocation) -> go-navigation.js's
  // runNavigationAction() 'toggleBookmark' branch only: resolves the
  // selection-or-focused-marker-or-code-intel-fallback chain, byte-identical
  // to go-navigation.js's former inline logic in that branch. Always
  // resolves (fire-and-forget from the caller, matching the original `void
  // toggleBookmarkAt(...)`).
  function toggleAtSelection(fallbackLocation) {
    if (unmounted || !legacy) return true;
    const selectionState = bookmarkSelectionState();
    if (selectionState.invalid) { legacy.toast('Select contiguous lines in one file and one diff side.'); return true; }
    const locationValue = selectionState.location || focusedLocation || fallbackLocation;
    if (!locationValue) { legacy.toast('Focus a diff line or select contiguous lines first.'); return true; }
    void toggleAtLocation(locationValue);
    return true;
  }

  async function revealDiffBookmarkLocation(locationValue) {
    let root = bookmarkRootForLocation(locationValue);
    if (!root) return false;
    const collapsed = [...root.querySelectorAll('button, [role="button"]')].find((button) =>
      !button.disabled && /(?:expand|show diff|load diff|show file)/i.test(`${button.textContent} ${button.getAttribute('aria-label') || ''}`)
    );
    if (collapsed && !legacy.lineAnchorFor(root, locationValue.startLine, locationValue.side)) {
      const updated = legacy.waitForDiffUpdate(root);
      collapsed.click();
      await updated;
      root = bookmarkRootForLocation(locationValue) || root;
    }
    return legacy.navigateToLocation({ path: locationValue.path, line: locationValue.startLine, side: locationValue.side });
  }

  async function reveal(id) {
    if (unmounted || !legacy) return false;
    const record = records.find((item) => item.id === id);
    if (!record) { legacy.toast('That bookmark is not available in the current review surface.'); return false; }
    const revealed = await revealDiffBookmarkLocation(record.location);
    if (!revealed) legacy.toast('That bookmark is not available in the current review surface.');
    return revealed;
  }

  function orderedCurrentRecords() {
    if (!legacy) return [];
    const roots = legacy.diffFileRoots();
    const pathOrder = new Map();
    roots.forEach((root, index) => {
      const file = bookmarkFileContextFor(root);
      if (file) { pathOrder.set(`old:${file.oldPath}`, index); pathOrder.set(`new:${file.newPath}`, index); }
    });
    return records.filter((record) => record.scope.headSha === scope?.headSha).sort((left, right) => {
      const leftOrder = pathOrder.get(`${left.location.side}:${left.location.path}`) ?? Number.MAX_SAFE_INTEGER;
      const rightOrder = pathOrder.get(`${right.location.side}:${right.location.path}`) ?? Number.MAX_SAFE_INTEGER;
      return leftOrder - rightOrder || left.location.startLine - right.location.startLine || left.location.side.localeCompare(right.location.side);
    });
  }

  // navigate(direction) -> go-navigation.js's runNavigationAction()
  // 'previousBookmark'/'nextBookmark' branches only. Byte-identical to
  // go-navigation.js's former navigateBookmark().
  async function navigate(direction) {
    if (unmounted || !legacy) return false;
    const ordered = orderedCurrentRecords();
    if (!ordered.length) { legacy.toast('No bookmarks in this MR head.'); return false; }
    navigationIndex = (navigationIndex + direction + ordered.length) % ordered.length;
    const record = ordered[navigationIndex];
    const revealed = await revealDiffBookmarkLocation(record.location);
    if (revealed) legacy.toast(`Bookmark ${navigationIndex + 1} of ${ordered.length}.`);
    return true;
  }

  async function remove(id) {
    if (unmounted || !legacy || !bookmarkStore) return false;
    const record = records.find((item) => item.id === id);
    if (!record) return false;
    await bookmarkStore.remove(record);
    await refresh();
    return true;
  }

  async function clear(mode = 'all') {
    if (unmounted || !legacy || !bookmarkStore || !scope) return 0;
    const count = await bookmarkStore.clear(scope, mode);
    await refresh();
    return count;
  }

  async function recover(id) {
    if (unmounted || !legacy) return { kind: 'unavailable' };
    const record = records.find((item) => item.id === id);
    if (!record || !scope) return { kind: 'unavailable' };
    if (record.scope.headSha === scope.headSha) return { kind: 'current' };
    const refs = await legacy.mergeRequestRefs();
    const ref = record.location.side === 'old' ? (refs.startSha || refs.baseSha) : refs.headSha;
    if (!COMMIT_SHA.test(ref || '')) return { kind: 'unavailable', message: 'The current MR side ref is unavailable.' };
    let source;
    try {
      source = await legacy.fetchSource(record.location.path, ref);
    } catch {
      return { kind: 'missing', message: 'The bookmarked file is unavailable at the current MR ref.' };
    }
    const lines = source.replace(/\r\n?/g, '\n').split('\n');
    const length = record.location.endLine - record.location.startLine + 1;
    const candidates = await bookmarkRecoveryCandidates(lines, record, hashText);
    const outcome = recoveryOutcome(candidates, length);
    if (outcome.kind === 'missing') return { kind: 'missing', message: 'No safe context match was found.' };
    if (outcome.kind === 'ambiguous') return { kind: 'ambiguous', message: 'Nearby context matches more than one location.' };
    const locationValue = { ...record.location, startLine: outcome.startLine, endLine: outcome.endLine };
    await bookmarkStore.recover(record, { scope, location: locationValue, anchor: outcome.anchor });
    await refresh();
    return { kind: 'recovered', record: records.find((item) => item.id === record.id) };
  }

  // --- enable/disable (go-navigation.js's init()/teardown() only) --------

  function enable() {
    if (unmounted || !legacy) return false;
    ensureStoreSubscription();
    ensureObserver();
    document.addEventListener('mouseup', reconcileSelectionUI, true);
    void refresh();
    return true;
  }

  function disable() {
    navigationIndex = -1;
    focusedLocation = null;
    refreshTimerCancel?.();
    refreshTimerCancel = null;
    diffDebounced?.cancel?.();
    diffObserver?.disconnect();
    diffObserver = null;
    removeSelectionUI();
    document.removeEventListener('mouseup', reconcileSelectionUI, true);
    document.querySelectorAll('[data-golens-bookmark-marker]').forEach((marker) => marker.remove());
  }

  return {
    unmount() {
      if (unmounted) return;
      unmounted = true;
      disable();
      storeUnsubscribe?.();
      storeUnsubscribe = null;
      listeners.clear();
    },
    subscribe,
    snapshot: computeSnapshot,
    toggleAt,
    reveal,
    remove,
    clear,
    recover,
    // go-navigation.js self-bridge only — see header comment.
    enable,
    disable,
    toggleAtSelection,
    navigate,
  };
}
