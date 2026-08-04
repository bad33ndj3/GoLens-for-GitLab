// page/features/bookmarks.internal.js — pure decision core for
// page/features/bookmarks.js. No DOM, no chrome.*, no timers, no fetch:
// these functions only turn already-gathered data (bookmark records,
// diff-line text, candidate line hashes) into snapshots and kind-discriminated
// domain outcomes. Not part of the module's public interface — the dependency
// rules bar other modules from importing this file directly.

// normalizePath(value) -> GitLab file-title text with bidi marks and
// spaced-slash artifacts stripped, byte-identical to go-navigation.js's
// former normalizePath(). Duplicated per the keyboard-nav.internal.js /
// onboarding.internal.js precedent (a small, unlikely-to-drift helper isn't
// worth a shared platform module). Total.
export function normalizePath(value) {
  return value
    .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
    .replace(/\s*\/\s*/g, '/')
    .trim();
}

// bookmarkRangeLabel(location) -> "L12" or "L12–14", byte-identical to
// content.js's former bookmarkRangeLabel() (and the range fallback half of
// go-navigation.js's former bookmarkLabel()). Total.
export function bookmarkRangeLabel(location) {
  return location.startLine === location.endLine
    ? `L${location.startLine}`
    : `L${location.startLine}–${location.endLine}`;
}

// bookmarkLabel(record, contextText) -> the human-readable label shown for
// a bookmark: the trimmed/collapsed visible-line text if available,
// otherwise "path · Lstart–end". Mirrors go-navigation.js's former
// bookmarkLabel(), except the DOM lookup for the visible line's text is the
// shell's job — `contextText` is that already-resolved text (or '' if the
// line isn't currently visible). Total.
export function bookmarkLabel(record, contextText = '') {
  const context = contextText.trim().replace(/\s+/g, ' ').slice(0, 80);
  return context || `${record.location.path} · ${bookmarkRangeLabel(record.location)}`;
}

// snapshotRecords(records, scope, contextTextByID) -> the `{scope, current,
// stale}` shape subscribe()/snapshot() hand callers, byte-identical to
// go-navigation.js's former bookmarkSnapshot(). `contextTextByID` is a plain
// `{ [record.id]: text }` map the shell builds from already-performed DOM
// lookups (one per record) — kept as data rather than a callback so this
// function stays a total, pure mapping. Total.
export function snapshotRecords(records, scope, contextTextByID = {}) {
  const withMeta = records.map((record) => ({
    ...record,
    stale: record.scope.headSha !== scope?.headSha,
    label: bookmarkLabel(record, contextTextByID[record.id] || ''),
  }));
  return {
    scope,
    current: withMeta.filter((record) => !record.stale),
    stale: withMeta.filter((record) => record.stale),
  };
}

// bookmarkRecoveryCandidates(lines, record, hashText) -> candidate
// relocations for a stale bookmark within a fresh file's lines, mirroring
// go-navigation.js's former bookmarkRecoveryCandidates() exactly (including
// the early-break once a second candidate is found — the caller only needs
// to know "more than one", not the full list). `hashText` is injected
// (`bookmark-store.js`'s `hashText` in production) so this stays deterministic
// given its inputs rather than reaching a global. Total given a well-formed
// record (has `.anchor` and `.location.startLine <= .location.endLine`).
export async function bookmarkRecoveryCandidates(lines, record, hashText) {
  const length = record.location.endLine - record.location.startLine + 1;
  const lineHashes = await Promise.all(lines.map((line) => hashText(line)));
  const candidates = [];
  for (let index = 0; index <= lines.length - length; index++) {
    const selected = lines.slice(index, index + length).join('\n');
    if (record.anchor.symbol && !selected.includes(record.anchor.symbol)) continue;
    const beforeHash = lineHashes[index - 1] || '';
    const afterHash = lineHashes[index + length] || '';
    const beforeMatches = Boolean(record.anchor.beforeHash && beforeHash === record.anchor.beforeHash);
    const afterMatches = Boolean(record.anchor.afterHash && afterHash === record.anchor.afterHash);
    if (!beforeMatches && !afterMatches) continue;
    const selectionHash = length === 1 ? lineHashes[index] : await hashText(selected);
    const anchor = { symbol: record.anchor.symbol, selectionHash, beforeHash, afterHash };
    const selectionAndContext = Boolean(record.anchor.selectionHash && selectionHash === record.anchor.selectionHash && (beforeMatches || afterMatches));
    const adjacentContext = Boolean(record.anchor.beforeHash && record.anchor.afterHash && beforeMatches && afterMatches);
    if (selectionAndContext || adjacentContext) candidates.push({ index, anchor });
    if (candidates.length > 1) break;
  }
  return candidates;
}

// recoveryOutcome(candidates, length) -> the kind-discriminated decision
// bookmarks.js's recover() shell turns into a result, from the closed set
// {missing, ambiguous, found}. Mirrors go-navigation.js's former
// recoverBookmark()'s post-candidates branching
// (`candidates.length !== 1 ? ... : ...`) as an explicit outcome instead of
// an inline ternary duplicated at each call site. Total.
export function recoveryOutcome(candidates, length) {
  if (candidates.length === 0) return { kind: 'missing' };
  if (candidates.length > 1) return { kind: 'ambiguous' };
  const candidate = candidates[0];
  return {
    kind: 'found',
    startLine: candidate.index + 1,
    endLine: candidate.index + length,
    anchor: candidate.anchor,
  };
}
