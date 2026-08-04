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
  const autoCollapsedGeneratedFolders = new Set();

  function isDiffPage() {
    return isMergeRequestDiff(loc);
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

  function reconcileGeneratedDiffFiles() {
    if (!shouldHideGeneratedFiles({ enabled, hideGeneratedFiles, isDiffPage: isDiffPage() })) {
      restoreGeneratedDiffFiles();
      return;
    }
    const hiddenFileHashes = new Set();
    const allFilePaths = new Set();
    const hiddenFilePaths = new Set();
    diffFileRoots(doc).forEach((diffFile) => {
      const hidden = isGeneratedCollapsedDiff(diffFile, loc);
      const filePath = diffFilePath(diffFile);
      diffFile.toggleAttribute('data-golens-generated-hidden', hidden);
      if (hidden && diffFile.id) hiddenFileHashes.add(diffFile.id);
      if (filePath) allFilePaths.add(filePath);
      if (hidden && filePath) hiddenFilePaths.add(filePath);
    });
    doc.querySelectorAll('[data-file-row]').forEach((fileRow) => {
      fileRow.toggleAttribute(
        'data-golens-generated-file-row',
        hiddenFileHashes.has(fileRow.dataset.fileRow)
      );
    });
    reconcileGeneratedFileFolders(allFilePaths, hiddenFilePaths);
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

  const scheduleReconcile = clock.debounceIdle(reconcile, { delayMs: RECONCILE_DEBOUNCE_MS });

  const observer = new MutationObserver(scheduleReconcile);
  observer.observe(doc.body, { childList: true, subtree: true });

  const onVisibilityChange = () => {
    if (doc.visibilityState === 'visible') scheduleReconcile();
  };
  win.addEventListener('popstate', scheduleReconcile);
  doc.addEventListener('turbo:load', scheduleReconcile);
  doc.addEventListener('pjax:end', scheduleReconcile);
  doc.addEventListener('visibilitychange', onVisibilityChange);

  let unsubscribeHideGeneratedFiles = null;
  let unsubscribeEnabled = null;
  if (settings) {
    settings.ready().then(() => {
      if (unmounted) return;
      hideGeneratedFiles = Boolean(settings.get('hideGeneratedFiles'));
      enabled = Boolean(settings.get('enabled'));
      reconcile();
      unsubscribeHideGeneratedFiles = settings.subscribe('hideGeneratedFiles', (value) => {
        hideGeneratedFiles = Boolean(value);
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
      unsubscribeEnabled?.();
      removeFullFileButtons();
      restoreGeneratedDiffFiles();
    },
  };
}
