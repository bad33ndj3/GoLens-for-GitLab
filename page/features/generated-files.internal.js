// page/features/generated-files.internal.js — pure decision core for
// page/features/generated-files.js. No DOM, no chrome.*, no timers: these
// functions only classify already-read data. Not part of the module's public
// interface — the dependency rules bar other modules from importing this
// file directly.

// normalizeRepositoryPath(path) -> path with bidi marks stripped, trimmed,
// internal whitespace around slashes collapsed, and no leading/trailing
// slash. Total: never throws, treats a missing path as ''.
export function normalizeRepositoryPath(path) {
  return (path || '')
    .replace(/[‎‏‪-‮⁦-⁩]/g, '')
    .trim()
    .replace(/\s*\/\s*/g, '/')
    .replace(/^\/+|\/+$/g, '');
}

// folderContainsPath(folderPath, filePath) -> true when filePath is inside
// folderPath (one or more path segments below it).
export function folderContainsPath(folderPath, filePath) {
  return filePath.startsWith(`${folderPath}/`);
}

// hasCollapseGeneratedFilesLink(hrefs, baseHref) -> true when any href
// resolves (against baseHref) to GitLab's "collapse generated files" help
// anchor. Total: a malformed href is skipped, never thrown.
export function hasCollapseGeneratedFilesLink(hrefs, baseHref) {
  return (hrefs || []).some((href) => {
    try {
      const url = new URL(href, baseHref);
      return url.hash === '#collapse-generated-files'
        && /\/help\/user\/project\/merge_requests\/changes(?:\.(?:html|md))?$/.test(url.pathname);
    } catch {
      return false;
    }
  });
}

// isGeneratedWarning({ text, hrefs, baseHref }) -> true when a collapsed-file
// warning's text + links mark the file as GitLab-detected-generated.
export function isGeneratedWarning({ text, hrefs, baseHref }) {
  return Boolean(text && text.includes('.gitattributes') && hasCollapseGeneratedFilesLink(hrefs, baseHref));
}

// shouldHideGeneratedFiles({ enabled, hideGeneratedFiles, isDiffPage }) ->
// the top-level gate content.js's reconcileGeneratedDiffFiles used to open
// with. Total.
export function shouldHideGeneratedFiles({ enabled, hideGeneratedFiles, isDiffPage }) {
  return Boolean(enabled && hideGeneratedFiles && isDiffPage);
}

// shouldShowFullFileButtons({ enabled, isDiffPage }) -> the top-level gate
// content.js's reconcileFullFileButtons used to open with. Total.
export function shouldShowFullFileButtons({ enabled, isDiffPage }) {
  return Boolean(enabled && isDiffPage);
}

// classifyFolders({ folders, allFilePaths, hiddenFilePaths, autoCollapsedFolderPaths })
// -> per-folder plan, one entry per input folder:
//   { folderPath, onlyContainsHidden, markAutoCollapsed, shouldCollapse }
// `folders` is [{ folderPath, expanded }]. `onlyContainsHidden` says whether
// the folder should carry the generated-folder marker. `markAutoCollapsed`
// says whether this reconcile pass is the one that should add the folder to
// the auto-collapsed set (only the first time it becomes only-hidden).
// `shouldCollapse` additionally requires the folder to currently be expanded
// (matches the legacy "auto-collapse once" behavior: a folder GoLens didn't
// itself collapse, or that the user re-expanded, is left alone next time
// around). Total: never throws on empty/missing sets.
export function classifyFolders({ folders, allFilePaths, hiddenFilePaths, autoCollapsedFolderPaths }) {
  const allPaths = [...(allFilePaths || [])];
  const hiddenPaths = new Set(hiddenFilePaths || []);
  const autoCollapsed = autoCollapsedFolderPaths || new Set();
  return (folders || []).map(({ folderPath, expanded }) => {
    const containsHidden = Boolean(folderPath) && allPaths.some((path) => hiddenPaths.has(path) && folderContainsPath(folderPath, path));
    const containsVisible = Boolean(folderPath) && allPaths.some((path) => !hiddenPaths.has(path) && folderContainsPath(folderPath, path));
    const onlyContainsHidden = Boolean(containsHidden && !containsVisible);
    const alreadyAutoCollapsed = autoCollapsed.has(folderPath);
    const markAutoCollapsed = onlyContainsHidden && !alreadyAutoCollapsed;
    const shouldCollapse = markAutoCollapsed && expanded === true;
    return { folderPath, onlyContainsHidden, markAutoCollapsed, shouldCollapse };
  });
}

// findRapidFullFileItem(items) -> the Rapid Diffs options-menu item whose
// click action shows/hides the full file, or null. `items` is the already
// JSON.parse()d options-menu payload (possibly nested via `.items`). Total.
export function findRapidFullFileItem(items) {
  for (const item of items || []) {
    if (item?.extraAttrs?.['data-click'] === 'showFullFile') return item;
    const nested = findRapidFullFileItem(item?.items);
    if (nested) return nested;
  }
  return null;
}

// viewerIsText(fileData) -> true when a Rapid Diffs file's parsed
// `data-file-data` marks its viewer as a text viewer. Total.
export function viewerIsText(fileData) {
  return Boolean(fileData?.viewer?.startsWith('text_'));
}

// fullFileButtonMode(nativeItem) -> 'full' | 'changes', from a Rapid Diffs
// options-menu item (or null/undefined, when there's no native item yet).
export function fullFileButtonMode(nativeItem) {
  return nativeItem?.extraAttrs?.['data-full'] ? 'changes' : 'full';
}

// matchesFullFileActionLabel(text) -> true for GitLab's legacy dropdown
// action labels ("Show full file" / "Show changes only"), case-insensitively,
// ignoring surrounding whitespace.
export function matchesFullFileActionLabel(text) {
  return /^(show full file|show changes only)$/i.test((text || '').trim());
}

// isShowingFullFileLabel(text) -> true specifically for "Show full file"
// (as opposed to "Show changes only"), used to infer which mode a legacy
// dropdown action click just switched *into*.
export function isShowingFullFileLabel(text) {
  return /^show full file$/i.test((text || '').trim());
}

// fullFileButtonView({ mode, label, busy }) -> the view-model for the
// full-file button's visual/a11y state; the shell applies it to a DOM
// button. Total: defaults mode to 'full' and busy to false, same as the
// legacy setFullFileButtonState's default parameter object.
export function fullFileButtonView({ mode = 'full', label, busy = false } = {}) {
  const defaultLabel = mode === 'changes' ? 'Show changes only' : mode === 'complete' ? 'Full file shown' : 'Show full file';
  const accessibleLabel = label || defaultLabel;
  return {
    mode,
    state: busy ? 'busy' : mode === 'complete' ? 'complete' : 'idle',
    disabled: busy || mode === 'complete',
    ariaBusy: busy,
    title: busy ? 'Expanding full file…' : accessibleLabel,
    ariaLabel: busy ? 'Expanding full file' : accessibleLabel,
  };
}

// --- root .gitattributes -diff support -----------------------------------
// Pure decision core for hiding MR diff files whose path matches a `-diff`
// (or `diff=false`) rule from the repository-root `.gitattributes`, plus the
// recalculated-total badge shown beside GitLab's own total. No DOM, no
// chrome.*, no timers. Total: every function below never throws.

export const NO_DIFF_RULE_LIMIT = 500;
export const NO_DIFF_TEXT_LIMIT = 100 * 1024;

// parseNoDiffRules(text) -> { rules, truncated }, where rules is
// [{ pattern, noDiff }] in file order (last-match-wins is preserved by that
// order — see isNoDiffPath). Blank lines and `#` comments are skipped; each
// remaining line splits on whitespace into pattern + attribute tokens, and
// `noDiff` is true when the attributes contain exactly `-diff` or
// `diff=false`. Safety cap: at most the first 500 lines / 100KB are read and
// `truncated` reports whether input was dropped (fail explicitly, never a
// silent partial index). Total.
export function parseNoDiffRules(text) {
  try {
    const source = typeof text === 'string' ? text : '';
    if (!source) return { rules: [], truncated: false };
    let capped = source;
    let truncated = false;
    if (capped.length > NO_DIFF_TEXT_LIMIT) {
      capped = capped.slice(0, NO_DIFF_TEXT_LIMIT);
      truncated = true;
    }
    const lines = capped.split('\n');
    if (lines.length > NO_DIFF_RULE_LIMIT) truncated = true;
    const rules = [];
    for (const line of lines.slice(0, NO_DIFF_RULE_LIMIT)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const tokens = trimmed.split(/\s+/);
      const pattern = tokens[0];
      if (!pattern) continue;
      const noDiff = tokens.slice(1).some((attr) => attr === '-diff' || attr === 'diff=false');
      rules.push({ pattern, noDiff });
    }
    return { rules, truncated };
  } catch {
    return { rules: [], truncated: false };
  }
}

// matchGlob(pattern, value) -> true when the gitattributes-style glob
// matches the whole value: `*` spans within a segment, `?` one character
// within a segment, `**/` zero or more directories, bare `**` anything.
function matchNoDiffGlob(pattern, value) {
  let regex = '^';
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          regex += '(.*/)?';
          i += 2;
        } else {
          regex += '.*';
          i += 1;
        }
      } else {
        regex += '[^/]*';
      }
    } else if (char === '?') {
      regex += '[^/]';
    } else if ('.+^$|\\'.includes(char)) {
      regex += `\\${char}`;
    } else {
      regex += char;
    }
  }
  return new RegExp(`${regex}$`).test(value);
}

// matchesNoDiffPattern(pattern, filePath) -> true when a single
// `.gitattributes` pattern matches the repository-relative file path:
// a leading `/` anchors to the root, a pattern without `/` matches the
// basename at any depth, a trailing `/` matches a directory prefix (at any
// depth when the directory itself contains no `/`, anchored otherwise), and
// anything else matches the full path. Both sides go through
// normalizeRepositoryPath. A leading `!` is stripped before matching —
// negation is inverted by isNoDiffPath, not here. Unknown glob syntax
// (`{}`, `[]`, `()`, or `!` anywhere but leading) never matches. Total.
export function matchesNoDiffPattern(pattern, filePath) {
  try {
    if (typeof pattern !== 'string') return false;
    let raw = pattern.trim();
    if (!raw) return false;
    if (raw.startsWith('!')) raw = raw.slice(1).trim();
    if (!raw) return false;
    if (raw.includes('!') || /[{}\[\]()]/.test(raw)) return false;
    const cleaned = normalizeRepositoryPath(filePath);
    if (!cleaned) return false;
    // A leading `/` anchors to the root: it is read before
    // normalizeRepositoryPath strips it, so `/root.go` never degrades to a
    // basename match. After stripping, the full-path match below is already
    // root-anchored.
    const rootAnchored = raw.startsWith('/');
    const directory = raw.endsWith('/');
    const normalized = normalizeRepositoryPath(raw);
    if (!normalized) return false;
    if (directory) {
      if (rootAnchored || normalized.includes('/')) {
        return cleaned === normalized || cleaned.startsWith(`${normalized}/`);
      }
      return cleaned.split('/').slice(0, -1).includes(normalized);
    }
    if (!rootAnchored && !normalized.includes('/')) {
      const basename = cleaned.split('/').pop();
      return matchNoDiffGlob(normalized, basename);
    }
    return matchNoDiffGlob(normalized, cleaned);
  } catch {
    return false;
  }
}

// isNoDiffPath(rules, filePath) -> true when the last matching rule marks
// the path as `-diff`. `rules` is parseNoDiffRules()'s `{ rules }` shape or
// a bare rule array. A rule whose pattern starts with `!` inverts that
// rule's own `noDiff` value when its remainder matches (gitignore-style
// re-inclusion). Empty/invalid input is false. Total.
export function isNoDiffPath(rules, filePath) {
  try {
    const list = Array.isArray(rules) ? rules : rules?.rules;
    if (!Array.isArray(list) || list.length === 0) return false;
    const cleaned = normalizeRepositoryPath(filePath);
    if (!cleaned) return false;
    let result = false;
    for (const rule of list) {
      const raw = typeof rule?.pattern === 'string' ? rule.pattern.trim() : '';
      if (!raw) continue;
      const negated = raw.startsWith('!');
      const inner = negated ? raw.slice(1) : raw;
      if (!matchesNoDiffPattern(inner, cleaned)) continue;
      result = negated ? !rule.noDiff : Boolean(rule.noDiff);
    }
    return result;
  } catch {
    return false;
  }
}

// shouldHideNoDiff({ enabled, hideNoDiffAttributes, isDiffPage }) -> the
// top-level gate for root-`.gitattributes` `-diff` hiding. Total. Kept
// separate from shouldHideGeneratedFiles (which is untouched) so the shell
// can OR the two gates without changing existing behavior.
export function shouldHideNoDiff({ enabled, hideNoDiffAttributes, isDiffPage }) {
  return Boolean(enabled && hideNoDiffAttributes && isDiffPage);
}

// parseDiffStatBadge(text) -> { added, deleted } | null, from GitLab's
// per-file or page-total stat strings: `+N -M` (spacing optional),
// `N addition(s)` / `N deletion(s)`, or a lone `+N` / `-N` (the minus also
// matches unicode minus/dash variants). Single-sided input yields 0 for the
// missing side; anything unparseable yields null. Total.
export function parseDiffStatBadge(text) {
  try {
    if (typeof text !== 'string' || !text) return null;
    const normalized = text
      .replace(/[−‐‒–—―﹣]/g, '-')
      .replace(/＋/g, '+');
    // The first class covers U+2212 plus common dash variants; the second
    // the fullwidth plus U+FF0B.
    let added = null;
    let deleted = null;
    const plusMinus = normalized.match(/\+\s*(\d+)[^\d+]*-\s*(\d+)/);
    if (plusMinus) {
      added = Number(plusMinus[1]);
      deleted = Number(plusMinus[2]);
    }
    const additions = normalized.match(/(\d+)\s+additions?/i);
    if (additions) added = Number(additions[1]);
    const deletions = normalized.match(/(\d+)\s+deletions?/i);
    if (deletions) deleted = Number(deletions[1]);
    if (added === null) {
      const plusOnly = normalized.match(/(?:^|\s)\+\s*(\d+)/);
      if (plusOnly) added = Number(plusOnly[1]);
    }
    if (deleted === null) {
      const minusOnly = normalized.match(/(?:^|\s)-\s*(\d+)/);
      if (minusOnly) deleted = Number(minusOnly[1]);
    }
    if (added === null && deleted === null) return null;
    const result = { added: added ?? 0, deleted: deleted ?? 0 };
    if (!Number.isFinite(result.added) || !Number.isFinite(result.deleted)) return null;
    return result;
  } catch {
    return null;
  }
}

// parsePageTotal(text) -> { added, deleted } | null. GitLab's page-total
// node carries the same stat shapes as a per-file badge, so this is the
// same parser under a call-site name. Total.
export function parsePageTotal(text) {
  return parseDiffStatBadge(text);
}

// formatNoDiffTotal({ pageAdded, pageDeleted, hiddenAdded, hiddenDeleted })
// -> the recalculated-total badge text (`· zonder -diff: X+ Y-`), or null
// when there is nothing to show: any non-numeric input, or zero hidden
// lines. Remainders clamp at 0 rather than going negative. Total.
export function formatNoDiffTotal({ pageAdded, pageDeleted, hiddenAdded, hiddenDeleted } = {}) {
  try {
    const values = [pageAdded, pageDeleted, hiddenAdded, hiddenDeleted];
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null;
    if (hiddenAdded + hiddenDeleted <= 0) return null;
    const remainingAdded = Math.max(0, pageAdded - hiddenAdded);
    const remainingDeleted = Math.max(0, pageDeleted - hiddenDeleted);
    return `· zonder -diff: ${remainingAdded}+ ${remainingDeleted}-`;
  } catch {
    return null;
  }
}

// formatNoDiffHiddenOnly({ hiddenAdded, hiddenDeleted }) -> the fallback
// badge text when GitLab's page total is missing or unparseable but lines
// were hidden (`· zonder -diff: ≈10+ 4- verborgen`), or null when there is
// nothing hidden or the input is non-numeric. The ≈ marks the page total as
// unknown: showing the hidden counts beats showing nothing. Total.
export function formatNoDiffHiddenOnly({ hiddenAdded, hiddenDeleted } = {}) {
  try {
    const values = [hiddenAdded, hiddenDeleted];
    if (!values.every((value) => typeof value === 'number' && Number.isFinite(value) && value >= 0)) return null;
    if (hiddenAdded + hiddenDeleted <= 0) return null;
    return `· zonder -diff: ≈${hiddenAdded}+ ${hiddenDeleted}- verborgen`;
  } catch {
    return null;
  }
}

// parsePageTotalAriaLabel(label) -> { added, deleted } | null, from GitLab's
// current page-total accessible name (`Added 2840 lines. Removed 755
// lines.`, case-insensitive; `N addition(s)` / `N deletion(s)` shapes also
// accepted). Both sides must be present; anything else is null. Total.
export function parsePageTotalAriaLabel(label) {
  try {
    if (typeof label !== 'string' || !label) return null;
    const addedMatch = label.match(/(\d+)\s+additions?/i) || label.match(/added\s+(\d+)/i);
    const deletedMatch = label.match(/(\d+)\s+deletions?/i) || label.match(/removed\s+(\d+)/i);
    if (!addedMatch || !deletedMatch) return null;
    const added = Number(addedMatch[1]);
    const deleted = Number(deletedMatch[1]);
    if (!Number.isFinite(added) || !Number.isFinite(deleted) || added < 0 || deleted < 0) return null;
    return { added, deleted };
  } catch {
    return null;
  }
}
