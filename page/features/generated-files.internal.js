// page/features/generated-files.internal.js — pure decision core for
// page/features/generated-files.js (ticket 13; contract per ticket 04 §1's
// internal-seam convention, mirrored from page/lifecycle/internal.js). No
// DOM, no chrome.*, no timers: these functions only classify already-read
// data. Not part of the module's public interface — the dependency rules
// bar other modules from importing this file directly.

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
