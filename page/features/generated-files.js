// page/features/generated-files.js — hides: generated-file detection, row
// hiding, and the full-file button. The first feature slice carved out of
// content.js; the pattern set here — mount(ctx) -> { unmount }, pure
// decision core in generated-files.internal.js, DOM/timers/subscriptions
// in this shell, fully self-contained once mounted — was repeated across
// all features.
//
// Reacts to settings.subscribe('hideGeneratedFiles'). Also (read-only)
// subscribes to 'enabled': this module may subscribe to foreign keys, it just
// never writes one — this module never calls ctx.settings.set().
//
// Self-contained page-change observation: page/lifecycle's own
// location.href poll is still inert for mounted features today (see
// page/lifecycle/index.js's header comment — reconciling mounted features
// on navigation is future work, not part of this ticket), so this module
// owns its own MutationObserver plus the same event set content.js used to
// funnel into its retired schedulePageReconcile
// (popstate/turbo:load/pjax:end/visibilitychange), debounced through
// platform/clock at the same 50ms delay content.js used.
import { createClock } from '../platform/clock.js';
import {
  normalizeRepositoryPath,
  isGeneratedWarning,
  classifyFolders,
  shouldHideGeneratedFiles,
  shouldHideNoDiff,
  isNoDiffPath,
  parseNoDiffRules,
  parseDiffStatBadge,
  parsePageTotal,
  parsePageTotalAriaLabel,
  formatNoDiffTotal,
  formatNoDiffHiddenOnly,
  shouldShowFullFileButtons,
  findRapidFullFileItem,
  viewerIsText,
  fullFileButtonMode,
  matchesFullFileActionLabel,
  isShowingFullFileLabel,
  fullFileButtonView,
} from './generated-files.internal.js';

const RECONCILE_DEBOUNCE_MS = 50;
const FULL_FILE_EXPANSION_TIMEOUT_MS = 15000;
const FULL_FILE_EXPANSION_LIMIT = 500;

// Deliberate duplicate of content.js's own isMergeRequestDiff(): content.js
// is a classic (non-module) content script and can't be imported from here,
// and this predicate is a one-line, unlikely-to-drift regex — not a
// "platform" concern worth a shared module for one ticket's sake (unlike
// e.g. the clock dedup in ticket 08, which had real, drifting duplication).
function isMergeRequestDiff(loc) {
  return /\/-\/merge_requests\/\d+\/diffs(?:$|\/|\?)/.test(loc.pathname + loc.search);
}

function diffFileRoots(doc) {
  return doc.querySelectorAll(
    'diff-file[data-testid="rd-diff-file"], diff-file[data-file-data], .diff-file.file-holder'
  );
}

function diffFilePath(diffFile) {
  try {
    const fileData = JSON.parse(diffFile.dataset.fileData || '{}');
    const dataPath = normalizeRepositoryPath(fileData.new_path || fileData.old_path);
    if (dataPath) return dataPath;
  } catch {
    // Legacy diffs and incomplete Rapid Diff fragments use DOM path metadata.
  }
  const dataPath = normalizeRepositoryPath(diffFile.dataset.path);
  if (dataPath) return dataPath;
  const title = diffFile.querySelector(
    '[data-testid="file-title"], .file-title-name, .rd-diff-file-link, [data-testid="rd-diff-file-header"] a'
  );
  return normalizeRepositoryPath(title?.textContent);
}

function isGeneratedCollapsedDiff(diffFile, loc) {
  const warnings = diffFile.querySelectorAll(
    '[data-testid="diff-file-warning"], .collapsed-file-warning, .rd-no-preview'
  );
  return [...warnings].some((warning) => isGeneratedWarning({
    text: warning.textContent,
    hrefs: [...warning.querySelectorAll('a[href]')].map((link) => link.getAttribute('href')),
    baseHref: loc.href,
  }));
}

function fullFileIcon() {
  return `
    <svg class="gitlab-lens-full-file-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 1.75h10M3 14.25h10M8 3.25v3.5m0-3.5L6.25 5M8 3.25 9.75 5M8 12.75v-3.5m0 3.5L6.25 11M8 12.75 9.75 11"></path>
    </svg>
    <svg class="gitlab-lens-changes-only-icon" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3 1.75h10M3 14.25h10M8 6.75v-3.5m0 3.5L6.25 5M8 6.75 9.75 5M8 9.25v3.5m0-3.5L6.25 11M8 9.25 9.75 11"></path>
    </svg>
    <svg class="gitlab-lens-full-file-spinner" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="5.5"></circle>
    </svg>
  `;
}

function applyFullFileButtonView(button, view) {
  button.dataset.mode = view.mode;
  button.dataset.state = view.state;
  button.disabled = view.disabled;
  button.toggleAttribute('aria-busy', view.ariaBusy);
  button.title = view.title;
  button.setAttribute('aria-label', view.ariaLabel);
}

export function mount(ctx) {
  const settings = ctx.settings;
  const clock = ctx.clock || createClock();
  const doc = document;
  const win = window;
  const loc = location;

  let unmounted = false;
  let enabled = false;
  let hideGeneratedFiles = false;
  let hideNoDiffAttributes = false;
  const autoCollapsedGeneratedFolders = new Set();

  // Root-`.gitattributes` `-diff` rules, fetched once per diff page through
  // the injected `gitAttributes` capability (late-bound closures from
  // page/main.js — never a captured value). Absent (older wiring, tests
  // without the capability) means fail-closed to the pre-`-diff` behavior.
  const gitAttributes = ctx.gitAttributes || null;
  let noDiffPageKey = '';
  let noDiffRules = [];
  let noDiffAttempted = false;
  let noDiffLoading = false;

  function isDiffPage() {
    return isMergeRequestDiff(loc);
  }

  function diffPageKey() {
    return `${loc.pathname}${loc.search}`;
  }

  function shouldHideNoDiffNow() {
    return shouldHideNoDiff({ enabled, hideNoDiffAttributes, isDiffPage: isDiffPage() });
  }

  // ensureNoDiffRules() -> kicks off the single root-`.gitattributes` fetch
  // for this diff page (1x per navigation key) when the `-diff` gate is on,
  // then reconciles again once the rules land. Any failure (404, unparsable
  // head ref, fetch error) resolves to `rules = []`, so nothing is ever
  // hidden without rules — fail-closed to the current behavior.
  function ensureNoDiffRules() {
    if (!gitAttributes || unmounted) return;
    if (!shouldHideNoDiffNow()) return;
    const key = diffPageKey();
    if (key !== noDiffPageKey) {
      noDiffPageKey = key;
      noDiffRules = [];
      noDiffAttempted = false;
      noDiffLoading = false;
    }
    if (noDiffLoading || noDiffAttempted) return;
    noDiffLoading = true;
    noDiffAttempted = true;
    (async () => {
      try {
        const headSha = await gitAttributes.getHeadRef();
        if (unmounted || diffPageKey() !== key) return;
        if (!headSha) {
          noDiffRules = [];
          return;
        }
        const signal = gitAttributes.getSignal ? gitAttributes.getSignal() : undefined;
        const text = await gitAttributes.fetchSource('.gitattributes', headSha, signal);
        if (unmounted || diffPageKey() !== key) return;
        noDiffRules = parseNoDiffRules(text).rules;
      } catch {
        noDiffRules = [];
      } finally {
        if (diffPageKey() !== key) return;
        noDiffLoading = false;
        if (!unmounted) reconcile();
      }
    })();
  }

  // --- generated-file hiding ------------------------------------------

  function restoreGeneratedDiffFiles() {
    doc.querySelectorAll('[data-golens-generated-hidden]').forEach((diffFile) => {
      diffFile.removeAttribute('data-golens-generated-hidden');
    });
    doc.querySelectorAll('[data-golens-generated-file-row]').forEach((fileRow) => {
      fileRow.removeAttribute('data-golens-generated-file-row');
    });
    doc.querySelectorAll('[data-golens-generated-folder]').forEach((folder) => {
      folder.removeAttribute('data-golens-generated-folder');
    });
    removeNoDiffBadge();
    autoCollapsedGeneratedFolders.clear();
  }

  function reconcileGeneratedFileFolders(allFilePaths, hiddenFilePaths) {
    const folderElements = [...doc.querySelectorAll('[data-testid="file-row"].folder')];
    const folders = folderElements.map((folder) => ({
      folderPath: normalizeRepositoryPath(folder.getAttribute('title')),
      expanded: folder.getAttribute('aria-expanded') === 'true',
    }));
    const plans = classifyFolders({
      folders,
      allFilePaths,
      hiddenFilePaths,
      autoCollapsedFolderPaths: autoCollapsedGeneratedFolders,
    });
    plans.forEach((plan, index) => {
      const folder = folderElements[index];
      folder.toggleAttribute('data-golens-generated-folder', plan.onlyContainsHidden);
      if (plan.markAutoCollapsed) autoCollapsedGeneratedFolders.add(plan.folderPath);
      if (plan.shouldCollapse) folder.click();
    });
  }

  // --- recalculated -diff total badge -----------------------------------

  function removeNoDiffBadge() {
    doc.querySelectorAll('[data-golens-nodiff-stats]').forEach((badge) => badge.remove());
  }

  // hiddenFileStat(diffFile) -> { added, deleted } | null, from the file's
  // own stat badge. GitLab's current split markup is read first: bare
  // `[data-testid="js-file-addition-line|js-file-deletion-line"]` counts
  // (plain numbers without a +/- prefix, so Number() not the badge parser),
  // then whole `.diff-stats-group` containers whose combined textContent
  // ("+ 2840" / "- 12") parses via parseDiffStatBadge — container-level so
  // a split sign span and count span still combine. Legacy precise
  // `[data-testid="additions|deletions"]` nodes, a combined
  // `.diff-stats`/`.file-stats` node, and a header-scoped leaf scan stay as
  // fallbacks (never diff line content — a `+12` code line is not a stat).
  // Only successfully parsed badges count; anything else is null so the
  // caller can track it as unparseable. Total.
  function hiddenFileStat(diffFile) {
    try {
      const additionLineNode = diffFile.querySelector('[data-testid="js-file-addition-line"]');
      const deletionLineNode = diffFile.querySelector('[data-testid="js-file-deletion-line"]');
      if (additionLineNode || deletionLineNode) {
        const readSplitCount = (node) => {
          try {
            if (!node) return null;
            const raw = (node.textContent || '').replace(/[,\s]/g, '');
            if (!/^\d+$/.test(raw)) return null;
            const value = Number(raw);
            if (!Number.isFinite(value) || value < 0) return null;
            return value;
          } catch {
            return null;
          }
        };
        const splitAdded = readSplitCount(additionLineNode);
        const splitDeleted = readSplitCount(deletionLineNode);
        if (splitAdded !== null || splitDeleted !== null) {
          return { added: splitAdded ?? 0, deleted: splitDeleted ?? 0 };
        }
      }
      const statGroups = diffFile.querySelectorAll('.diff-stats-group');
      if (statGroups.length > 0) {
        let groupedAdded = 0;
        let groupedDeleted = 0;
        let groupedFound = false;
        for (const group of statGroups) {
          if (group.closest('[data-golens-nodiff-stats]')) continue;
          const parsed = parseDiffStatBadge(group.textContent);
          if (parsed && (parsed.added > 0 || parsed.deleted > 0)) {
            groupedAdded += parsed.added;
            groupedDeleted += parsed.deleted;
            groupedFound = true;
          }
        }
        if (groupedFound) return { added: groupedAdded, deleted: groupedDeleted };
      }
      const additionsNode = diffFile.querySelector('[data-testid="additions"]');
      const deletionsNode = diffFile.querySelector('[data-testid="deletions"]');
      if (additionsNode || deletionsNode) {
        const added = additionsNode ? parseDiffStatBadge(additionsNode.textContent) : null;
        const deleted = deletionsNode ? parseDiffStatBadge(deletionsNode.textContent) : null;
        if (!added && !deleted) return null;
        return { added: added ? added.added : 0, deleted: deleted ? deleted.deleted : 0 };
      }
      const combined = diffFile.querySelector('.diff-stats, .file-stats');
      if (combined) return parseDiffStatBadge(combined.textContent);
      const header = diffFile.querySelector(
        'header, [data-testid="file-title-container"], .file-title, [data-testid="rd-diff-file-header"]'
      );
      const scope = header || diffFile;
      for (const leaf of scope.querySelectorAll('span, strong, small, em')) {
        if (leaf.children.length > 0) continue;
        const parsed = parseDiffStatBadge((leaf.textContent || '').trim());
        if (parsed && (parsed.added > 0 || parsed.deleted > 0)) return parsed;
      }
      return null;
    } catch {
      return null;
    }
  }

  // liftToGroupedParent(node) -> the parent grouping several
  // `.diff-stats-group` containers (GitLab's current split style: one `+`
  // group and one `-` group) when it parses as a combined total, or null. A
  // lone single-sided group must never become the total node: placing the
  // badge after it lands *between* GitLab's `+` and `-` halves, where it is
  // invisible and fragile. Total.
  function liftToGroupedParent(node) {
    if (!node || !node.matches?.('.diff-stats-group')) return null;
    const parent = node.parentElement;
    if (!parent || parent === doc.body) return null;
    if (parent.hasAttribute('data-golens-nodiff-stats')) return null;
    if (parent.closest('[data-golens-nodiff-stats]')) return null;
    if (parent.closest('diff-file, .diff-file.file-holder')) return null;
    if (parent.querySelectorAll('.diff-stats-group').length <= 1) return null;
    const parentParsed = parsePageTotal(parent.textContent);
    if (!parentParsed || (parentParsed.added <= 0 && parentParsed.deleted <= 0)) return null;
    return parent;
  }

  // findAriaLabelPageTotal() -> GitLab's current page-total wrapper: a plain
  // `gl-flex` container with no total-specific selector, identified only by
  // `aria-label="Added N lines. Removed M lines."` (case-insensitive
  // added+removed or additions+deletions). Per-file lookalikes live inside a
  // diff-file root and stay excluded. The WRAPPER itself is returned (never
  // an inner group) so the badge lands after the whole total, and it is
  // verified via the combined textContent (both sides > 0) or the
  // aria-label numbers. Total.
  function findAriaLabelPageTotal() {
    for (const node of doc.querySelectorAll('[aria-label]')) {
      if (node.hasAttribute('data-golens-nodiff-stats')) continue;
      if (node.closest('[data-golens-nodiff-stats]')) continue;
      if (node.closest('diff-file, .diff-file.file-holder')) continue;
      const labelParsed = parsePageTotalAriaLabel(node.getAttribute('aria-label') || '');
      if (!labelParsed) continue;
      const textParsed = parsePageTotal(node.textContent);
      if (textParsed && textParsed.added > 0 && textParsed.deleted > 0) return node;
      if (labelParsed.added > 0 || labelParsed.deleted > 0) return node;
    }
    return null;
  }

  // findPageTotalNode() -> GitLab's own page-total stat node, never a
  // per-file badge (those live inside a diff-file root) and never GoLens's
  // own badge. The aria-label wrapper is recognized directly first (it
  // matches no legacy total selector); besides those, page totals in
  // GitLab's current split style are recognized: `.diff-stats-group`
  // containers outside diff-file roots (lifted to their parent when it
  // groups several stat groups, so a split + group and - group report
  // together), and containers holding
  // `js-file-addition-line`/`js-file-deletion-line` counts (with the same
  // parent lift). Total.
  function findPageTotalNode() {
    const ariaLabelTotal = findAriaLabelPageTotal();
    if (ariaLabelTotal) return ariaLabelTotal;
    const matches = doc.querySelectorAll(
      '[data-testid="diff-stats"], .diff-stats, .changed-files-summary, [data-testid="diffs-stats"], .diff-stats-group'
    );
    for (const node of matches) {
      if (node.hasAttribute('data-golens-nodiff-stats')) continue;
      if (node.closest('[data-golens-nodiff-stats]')) continue;
      if (node.closest('diff-file, .diff-file.file-holder')) continue;
      if (node.matches('.diff-stats-group')) {
        const grouped = parsePageTotal(node.textContent);
        if (!grouped || (grouped.added <= 0 && grouped.deleted <= 0)) continue;
        const lifted = liftToGroupedParent(node);
        if (lifted) return lifted;
        return node;
      }
      return node;
    }
    for (const leaf of doc.querySelectorAll('[data-testid="js-file-addition-line"], [data-testid="js-file-deletion-line"]')) {
      if (leaf.closest('[data-golens-nodiff-stats]')) continue;
      if (leaf.closest('diff-file, .diff-file.file-holder')) continue;
      const container = leaf.closest('.diff-stats-group') || leaf.parentElement;
      if (!container || container === doc.body) continue;
      if (container.hasAttribute?.('data-golens-nodiff-stats')) continue;
      if (container.closest('[data-golens-nodiff-stats]')) continue;
      if (container.closest('diff-file, .diff-file.file-holder')) continue;
      const lifted = liftToGroupedParent(container);
      if (lifted) return lifted;
      const parsed = parsePageTotal(container.textContent);
      if (parsed && (parsed.added > 0 || parsed.deleted > 0)) return container;
    }
    const diffs = doc.getElementById('diffs');
    const scope = diffs?.parentElement || doc.body;
    for (const node of scope.querySelectorAll('header, [data-testid="file-tree-header"], .file-tree-header')) {
      if (node.closest('diff-file, .diff-file.file-holder')) continue;
      if (node.querySelector('[data-golens-nodiff-stats]')) continue;
      const parsed = parsePageTotal(node.textContent);
      if (parsed && (parsed.added > 0 || parsed.deleted > 0)) return node;
    }
    return null;
  }

  // reconcileNoDiffTotal(hiddenStats, unparseableBadgeCount) -> creates,
  // moves, or removes the `span[data-golens-nodiff-stats]`. Main path: the
  // badge sits directly after GitLab's total node (GitLab's node itself is
  // never written to). Fallback path: when the page total is missing or
  // unparseable but lines were hidden, an ≈-marked badge with the hidden
  // counts is shown at the top of `#diffs` (else after the file-tree
  // header) — hidden lines without any badge must never happen. Idempotent
  // (equal text is not re-applied and a settled badge is not moved, so the
  // badge never retriggers the observer loop) and only active while the
  // `-diff` gate is on. Total.
  function reconcileNoDiffTotal(hiddenStats, unparseableBadgeCount) {
    if (!shouldHideNoDiffNow()) {
      removeNoDiffBadge();
      return;
    }
    const hiddenAdded = hiddenStats.reduce((sum, stat) => sum + stat.added, 0);
    const hiddenDeleted = hiddenStats.reduce((sum, stat) => sum + stat.deleted, 0);
    const unparseable = String(unparseableBadgeCount);
    const existing = doc.querySelector('[data-golens-nodiff-stats]');
    const placeBadge = (text, anchor, position) => {
      if (!text) {
        existing?.remove();
        return;
      }
      let badge = existing;
      if (!badge) {
        badge = doc.createElement('span');
        badge.setAttribute('data-golens-nodiff-stats', '');
      }
      if (badge.textContent !== text) badge.textContent = text;
      if (badge.dataset.golensNodiffUnparseable !== unparseable) badge.dataset.golensNodiffUnparseable = unparseable;
      if (position === 'after') {
        if (badge.previousElementSibling !== anchor || badge.parentNode !== anchor.parentNode) {
          anchor.after(badge);
        }
      } else if (badge.parentNode !== anchor || badge.previousElementSibling !== null) {
        anchor.prepend(badge);
      }
    };
    const totalNode = findPageTotalNode();
    if (totalNode?.isConnected) {
      const page = parsePageTotal(totalNode.textContent);
      if (page) {
        placeBadge(
          formatNoDiffTotal({ pageAdded: page.added, pageDeleted: page.deleted, hiddenAdded, hiddenDeleted }),
          totalNode,
          'after'
        );
        return;
      }
    }
    const fallbackText = formatNoDiffHiddenOnly({ hiddenAdded, hiddenDeleted });
    if (!fallbackText) {
      existing?.remove();
      return;
    }
    const diffs = doc.getElementById('diffs');
    if (diffs) {
      placeBadge(fallbackText, diffs, 'prepend');
      return;
    }
    const treeHeader = doc.querySelector('[data-testid="file-tree-header"], .file-tree-header');
    if (treeHeader) {
      placeBadge(fallbackText, treeHeader, 'after');
      return;
    }
    existing?.remove();
  }

  function reconcileGeneratedDiffFiles() {
    const hideGenerated = shouldHideGeneratedFiles({ enabled, hideGeneratedFiles, isDiffPage: isDiffPage() });
    const hideNoDiff = shouldHideNoDiffNow();
    if (!hideGenerated && !hideNoDiff) {
      restoreGeneratedDiffFiles();
      return;
    }
    if (hideNoDiff) ensureNoDiffRules();
    const hiddenFileHashes = new Set();
    const allFilePaths = new Set();
    const hiddenFilePaths = new Set();
    const hiddenStats = [];
    let unparseableBadgeCount = 0;
    diffFileRoots(doc).forEach((diffFile) => {
      const filePath = diffFilePath(diffFile);
      const generated = hideGenerated && isGeneratedCollapsedDiff(diffFile, loc);
      const noDiff = hideNoDiff && Boolean(filePath) && isNoDiffPath(noDiffRules, filePath);
      const hidden = Boolean(generated || noDiff);
      diffFile.toggleAttribute('data-golens-generated-hidden', hidden);
      if (hidden && diffFile.id) hiddenFileHashes.add(diffFile.id);
      if (filePath) allFilePaths.add(filePath);
      if (hidden && filePath) hiddenFilePaths.add(filePath);
      if (hidden) {
        const stat = hiddenFileStat(diffFile);
        if (stat) hiddenStats.push(stat);
        else unparseableBadgeCount += 1;
      }
    });
    doc.querySelectorAll('[data-file-row]').forEach((fileRow) => {
      fileRow.toggleAttribute(
        'data-golens-generated-file-row',
        hiddenFileHashes.has(fileRow.dataset.fileRow)
      );
    });
    reconcileGeneratedFileFolders(allFilePaths, hiddenFilePaths);
    reconcileNoDiffTotal(hiddenStats, unparseableBadgeCount);
  }

  // --- full-file button --------------------------------------------------

  function createFullFileButton({ mode = 'full', label, renderer = 'fallback' } = {}) {
    const button = doc.createElement('button');
    button.type = 'button';
    button.className = 'gitlab-lens-full-file-button';
    button.dataset.golensFullFile = '';
    button.dataset.renderer = renderer;
    button.innerHTML = fullFileIcon();
    applyFullFileButtonView(button, fullFileButtonView({ mode, label }));
    return button;
  }

  function rapidFullFileItem(diffFile) {
    const script = diffFile.querySelector('[data-options-menu] script[type="application/json"]');
    if (!script?.textContent) return null;
    try {
      return findRapidFullFileItem(JSON.parse(script.textContent));
    } catch {
      return null;
    }
  }

  function rapidViewerIsText(diffFile) {
    try {
      return viewerIsText(JSON.parse(diffFile.dataset.fileData || '{}'));
    } catch {
      return false;
    }
  }

  function expansionControls(diffFile) {
    const selectors = [
      '.js-unfold-all:not(:disabled)',
      '[data-click="expandLines"][data-expand-direction]:not(:disabled)',
      '.js-unfold:not(:disabled)',
      '.js-unfold-down:not(:disabled)',
    ];
    return selectors.flatMap((selector) => [...diffFile.querySelectorAll(selector)]);
  }

  function diffLineCount(diffFile) {
    return diffFile.querySelectorAll('tr, .diff-grid-row, [data-hunk-lines]').length;
  }

  function waitForExpansionMutation(diffFile, control, button) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const initialLineCount = diffLineCount(diffFile);
      const finish = (callback, value) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timeout);
        callback(value);
      };
      const observer = new MutationObserver(() => {
        const cancelled = !enabled || !diffFile.isConnected || !button.isConnected;
        const expanded = !control.isConnected || diffLineCount(diffFile) !== initialLineCount;
        if (!cancelled && !expanded) return;
        finish(resolve);
      });
      observer.observe(diffFile, { childList: true, subtree: true });
      const timeout = setTimeout(() => finish(reject, new Error('Timed out while expanding diff lines.')), FULL_FILE_EXPANSION_TIMEOUT_MS);
    });
  }

  async function expandAllHunks(diffFile, button) {
    let expansions = 0;
    while (enabled && diffFile.isConnected && button.isConnected) {
      const control = expansionControls(diffFile)[0];
      if (!control) {
        applyFullFileButtonView(button, fullFileButtonView({ mode: 'complete' }));
        return;
      }
      if (++expansions > FULL_FILE_EXPANSION_LIMIT) throw new Error('Too many diff expansion steps.');
      const progress = waitForExpansionMutation(diffFile, control, button);
      control.click();
      await progress;
    }
  }

  function visibleLegacyFullFileAction(optionsButton) {
    const controlled = optionsButton.getAttribute('aria-controls');
    const scopes = [
      controlled ? doc.getElementById(controlled) : null,
      optionsButton.closest('[data-testid="file-title-container"]'),
      ...doc.querySelectorAll('[role="menu"]'),
    ].filter(Boolean);
    for (const scope of scopes) {
      const action = [...scope.querySelectorAll('button, [role="menuitem"]')].find((candidate) =>
        matchesFullFileActionLabel(candidate.textContent)
      );
      if (action) return action;
    }
    return null;
  }

  async function waitForLegacyFullFileAction(optionsButton) {
    const deadline = Date.now() + 1500;
    while (Date.now() < deadline) {
      const action = visibleLegacyFullFileAction(optionsButton);
      if (action) return action;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return null;
  }

  async function runLegacyFullFileAction(diffFile, button) {
    if (button.dataset.state === 'busy') return;
    applyFullFileButtonView(button, fullFileButtonView({ mode: button.dataset.mode, busy: true }));
    try {
      const optionsButton = diffFile.querySelector('[data-testid="options-dropdown-button"]');
      if (optionsButton) {
        optionsButton.click();
        const nativeAction = await waitForLegacyFullFileAction(optionsButton);
        if (nativeAction) {
          const showingFullFile = isShowingFullFileLabel(nativeAction.textContent);
          nativeAction.click();
          const mode = showingFullFile ? 'changes' : 'full';
          diffFile.dataset.golensFullFileMode = mode;
          applyFullFileButtonView(button, fullFileButtonView({ mode }));
          return;
        }
        optionsButton.click();
      }
      if (button.dataset.mode === 'changes') throw new Error('Show changes only is unavailable.');
      await expandAllHunks(diffFile, button);
    } catch (error) {
      if (!button.isConnected) return;
      applyFullFileButtonView(button, fullFileButtonView({ mode: button.dataset.mode, label: 'Could not expand full file' }));
      button.dataset.error = error.message || String(error);
    }
  }

  function mountRapidFullFileButton(diffFile) {
    if (diffFile.querySelector('[data-golens-full-file]')) return;
    const nativeItem = rapidFullFileItem(diffFile);
    const hasFallback = expansionControls(diffFile).length > 0;
    if ((!nativeItem && !hasFallback) || (!rapidViewerIsText(diffFile) && !hasFallback)) return;
    const options = diffFile.querySelector('.rd-diff-file-options-menu');
    const info = options?.parentElement || diffFile.querySelector('.rd-diff-file-info');
    if (!info) return;
    const mode = fullFileButtonMode(nativeItem);
    const button = createFullFileButton({ mode, label: nativeItem?.text, renderer: nativeItem ? 'rapid' : 'fallback' });
    if (nativeItem) {
      button.dataset.click = 'showFullFile';
      if (nativeItem.extraAttrs['data-full']) button.dataset.full = nativeItem.extraAttrs['data-full'];
    } else {
      button.addEventListener('click', () => runLegacyFullFileAction(diffFile, button));
    }
    info.insertBefore(button, options || null);
  }

  function mountLegacyFullFileButton(diffFile) {
    if (diffFile.querySelector('[data-golens-full-file]')) return;
    const rememberedMode = diffFile.dataset.golensFullFileMode;
    if (!expansionControls(diffFile).length && rememberedMode !== 'changes') return;
    const header = diffFile.querySelector('[data-testid="file-title-container"], .file-title');
    const actions = header?.querySelector('.file-actions');
    if (!actions) return;
    const button = createFullFileButton({ mode: rememberedMode || 'full', renderer: 'legacy' });
    button.addEventListener('click', () => runLegacyFullFileAction(diffFile, button));
    const optionsButton = actions.querySelector('[data-testid="options-dropdown-button"]');
    const optionsGroup = optionsButton?.parentElement;
    actions.insertBefore(button, optionsGroup?.parentElement === actions ? optionsGroup : null);
  }

  function removeFullFileButtons() {
    doc.querySelectorAll('[data-golens-full-file]').forEach((button) => button.remove());
  }

  function reconcileFullFileButtons() {
    if (!shouldShowFullFileButtons({ enabled, isDiffPage: isDiffPage() })) {
      removeFullFileButtons();
      return;
    }
    doc.querySelectorAll('diff-file[data-testid="rd-diff-file"], diff-file[data-file-data]').forEach(mountRapidFullFileButton);
    doc.querySelectorAll('.diff-file.file-holder').forEach(mountLegacyFullFileButton);
  }

  // --- reconcile + wiring --------------------------------------------

  function reconcile() {
    if (unmounted) return;
    reconcileFullFileButtons();
    reconcileGeneratedDiffFiles();
  }

  // isNoDiffBadgeOnlyMutation(mutation) -> true when a mutation only touches
  // GoLens's own recalculated-total badge, so maintaining that badge never
  // reschedules (and thereby never re-triggers) a reconcile pass. Total.
  function isNoDiffBadgeOnlyMutation(mutation) {
    if (mutation.type === 'attributes') return Boolean(mutation.target?.closest?.('[data-golens-nodiff-stats]'));
    if (mutation.type === 'characterData') {
      return Boolean(mutation.target?.parentElement?.closest?.('[data-golens-nodiff-stats]'));
    }
    const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
    if (!nodes.length) return false;
    return nodes.every((node) => node.nodeType === 1 && (
      node.matches?.('[data-golens-nodiff-stats]') || node.closest?.('[data-golens-nodiff-stats]')
    ));
  }

  const scheduleReconcile = clock.debounceIdle(reconcile, { delayMs: RECONCILE_DEBOUNCE_MS });

  const observer = new MutationObserver((mutations) => {
    if (mutations.length && mutations.every(isNoDiffBadgeOnlyMutation)) return;
    scheduleReconcile();
  });
  observer.observe(doc.body, { childList: true, subtree: true });

  const onVisibilityChange = () => {
    if (doc.visibilityState === 'visible') scheduleReconcile();
  };
  win.addEventListener('popstate', scheduleReconcile);
  doc.addEventListener('turbo:load', scheduleReconcile);
  doc.addEventListener('pjax:end', scheduleReconcile);
  doc.addEventListener('visibilitychange', onVisibilityChange);

  let unsubscribeHideGeneratedFiles = null;
  let unsubscribeHideNoDiffAttributes = null;
  let unsubscribeEnabled = null;
  if (settings) {
    settings.ready().then(() => {
      if (unmounted) return;
      hideGeneratedFiles = Boolean(settings.get('hideGeneratedFiles'));
      hideNoDiffAttributes = Boolean(settings.get('hideNoDiffAttributes'));
      enabled = Boolean(settings.get('enabled'));
      reconcile();
      unsubscribeHideGeneratedFiles = settings.subscribe('hideGeneratedFiles', (value) => {
        hideGeneratedFiles = Boolean(value);
        reconcile();
      });
      unsubscribeHideNoDiffAttributes = settings.subscribe('hideNoDiffAttributes', (value) => {
        hideNoDiffAttributes = Boolean(value);
        reconcile();
      });
      unsubscribeEnabled = settings.subscribe('enabled', (value) => {
        enabled = Boolean(value);
        reconcile();
      });
    });
  }

  return {
    unmount() {
      if (unmounted) return;
      unmounted = true;
      scheduleReconcile.cancel();
      observer.disconnect();
      win.removeEventListener('popstate', scheduleReconcile);
      doc.removeEventListener('turbo:load', scheduleReconcile);
      doc.removeEventListener('pjax:end', scheduleReconcile);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      unsubscribeHideGeneratedFiles?.();
      unsubscribeHideNoDiffAttributes?.();
      unsubscribeEnabled?.();
      removeFullFileButtons();
      restoreGeneratedDiffFiles();
    },
  };
}
