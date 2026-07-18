(() => {
  const shortcutDefaults = globalThis.GoLensShortcuts?.defaultBindings?.() || {};
  const defaults = { enabled: true, hideGeneratedFiles: false, shortcutBindings: shortcutDefaults };
  const ONBOARDING_VERSION = 8;
  const ONBOARDING_STORAGE_KEY = 'golensOnboardingVersion';
  const FRIDAY_MR_CREATE_STORAGE_KEY = 'golensFridayMergeRequestCreation';
  const FULL_FILE_EXPANSION_TIMEOUT_MS = 15000;
  const FULL_FILE_EXPANSION_LIMIT = 500;
  const CELEBRATION_POLL_INTERVALS_MS = [250, 500, 750, 1000, 1500, 2000, 2500];
  const state = {
    settings: defaults,
    enabled: true,
    pageKey: '',
    pageActive: false,
    reconcileTimer: null,
    ownsFullscreen: false,
    controlsHost: null,
    controlsMounted: false,
    preload: { status: 'idle', message: '', progress: null },
    preloadCheckID: 0,
    preloadRunID: 0,
    fullPreload: { status: 'idle', message: '', progress: null },
    fullPreloadRunID: 0,
    onboardingReturnFocus: null,
    settingsReturnFocus: null,
    autoCollapsedGeneratedFolders: new Set(),
    celebrationStatus: null,
    celebrationRunID: 0,
    celebrationPollTimer: null,
    celebrationRemoveTimer: null,
    discussionStatus: null,
    discussionRunID: 0,
    discussionPollTimer: null,
    queuedMascotMoment: '',
  };

  function isGitLab() {
    if (window.gon?.gitlab_url) return true;
    const csrf = document.querySelector('meta[name="csrf-token"]');
    const shell = document.querySelector('.super-sidebar, [data-testid="super-sidebar"], #js-top-bar, .layout-page, .ai-panels');
    return Boolean(csrf && shell);
  }

  function isMergeRequest() {
    return /\/-\/merge_requests\/\d+/.test(location.pathname);
  }

  function mergeRequestPageKey() {
    const match = location.pathname.match(/^(.*?\/-\/merge_requests\/\d+)/);
    return match ? `${location.origin}${match[1]}` : '';
  }

  function aiPanelsContainer() {
    return document.querySelector('body > div.layout-page.js-page-layout.page-gutter.page-with-super-sidebar.right-sidebar-collapsed.is-merge-request > div.ai-panels')
      || document.querySelector('.layout-page.is-merge-request > .ai-panels')
      || document.querySelector('div.ai-panels');
  }

  function aiPanelsAnchor() {
    return document.querySelector('body > div.layout-page.js-page-layout.page-gutter.page-with-super-sidebar.right-sidebar-collapsed.is-merge-request > div.ai-panels > div > nav > div > button')
      || aiPanelsContainer()?.querySelector(':scope > div > nav > div > button, nav > div > button, nav button');
  }

  function mountControlsInAiPanels(host) {
    const anchor = aiPanelsAnchor();
    if (anchor) {
      anchor.after(host);
      state.controlsMounted = true;
    }
    if (anchor) return;

    // Never fall back to the document body: a misplaced control is worse
    // than waiting for GitLab to render the intended AI-sidebar control.
    const observer = new MutationObserver(() => {
      if (state.controlsHost !== host) {
        observer.disconnect();
        return;
      }
      const lateAnchor = aiPanelsAnchor();
      if (!lateAnchor) return;
      lateAnchor.after(host);
      state.controlsMounted = true;
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      if (state.controlsHost !== host || host.isConnected) return;
      state.controlsHost = null;
      state.controlsMounted = false;
      schedulePageReconcile();
    }, 30000);
  }

  function isMergeRequestDiff() {
    return /\/-\/merge_requests\/\d+\/diffs(?:$|\/|\?)/.test(location.pathname + location.search);
  }

  function enableRapidDiffs() {
    if (!isMergeRequestDiff()) return false;
    const optIn = [...document.querySelectorAll('button')].find((button) =>
      /^try\s+rapid\s+diffs\b/i.test(button.textContent.trim()) && !button.disabled
    );
    if (!optIn) return false;
    optIn.click();
    return true;
  }

  function watchForRapidDiffs() {
    if (!isMergeRequestDiff() || enableRapidDiffs()) return;
    const observer = new MutationObserver(() => {
      if (!enableRapidDiffs()) return;
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => observer.disconnect(), 15000);
  }

  function generatedFilesDocumentationLink(warning) {
    return [...warning.querySelectorAll('a[href]')].some((link) => {
      try {
        const url = new URL(link.getAttribute('href'), location.href);
        return url.hash === '#collapse-generated-files'
          && /\/help\/user\/project\/merge_requests\/changes(?:\.(?:html|md))?$/.test(url.pathname);
      } catch {
        return false;
      }
    });
  }

  function isGeneratedCollapsedDiff(diffFile) {
    const warnings = diffFile.querySelectorAll(
      '[data-testid="diff-file-warning"], .collapsed-file-warning, .rd-no-preview'
    );
    return [...warnings].some((warning) =>
      warning.textContent.includes('.gitattributes') && generatedFilesDocumentationLink(warning)
    );
  }

  function diffFileRoots() {
    return document.querySelectorAll(
      'diff-file[data-testid="rd-diff-file"], diff-file[data-file-data], .diff-file.file-holder'
    );
  }

  function normalizeRepositoryPath(path) {
    return (path || '')
      .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
      .trim()
      .replace(/\s*\/\s*/g, '/')
      .replace(/^\/+|\/+$/g, '');
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

  function folderContainsPath(folderPath, filePath) {
    return filePath.startsWith(`${folderPath}/`);
  }

  function reconcileGeneratedFileFolders(allFilePaths, hiddenFilePaths) {
    const allPaths = [...allFilePaths];
    const hiddenPaths = [...hiddenFilePaths];
    document.querySelectorAll('[data-testid="file-row"].folder').forEach((folder) => {
      const folderPath = normalizeRepositoryPath(folder.getAttribute('title'));
      const containsHidden = folderPath && hiddenPaths.some((path) => folderContainsPath(folderPath, path));
      const containsVisible = folderPath && allPaths.some((path) =>
        folderContainsPath(folderPath, path) && !hiddenFilePaths.has(path)
      );
      const onlyContainsHidden = Boolean(containsHidden && !containsVisible);
      folder.toggleAttribute('data-golens-generated-folder', onlyContainsHidden);
      if (!onlyContainsHidden || state.autoCollapsedGeneratedFolders.has(folderPath)) return;
      state.autoCollapsedGeneratedFolders.add(folderPath);
      if (folder.getAttribute('aria-expanded') === 'true') folder.click();
    });
  }

  function restoreGeneratedDiffFiles() {
    document.querySelectorAll('[data-golens-generated-hidden]').forEach((diffFile) => {
      diffFile.removeAttribute('data-golens-generated-hidden');
    });
    document.querySelectorAll('[data-golens-generated-file-row]').forEach((fileRow) => {
      fileRow.removeAttribute('data-golens-generated-file-row');
    });
    document.querySelectorAll('[data-golens-generated-folder]').forEach((folder) => {
      folder.removeAttribute('data-golens-generated-folder');
    });
    state.autoCollapsedGeneratedFolders.clear();
  }

  function reconcileGeneratedDiffFiles() {
    if (!state.enabled || !state.settings.hideGeneratedFiles || !isMergeRequestDiff()) {
      restoreGeneratedDiffFiles();
      return;
    }
    const hiddenFileHashes = new Set();
    const allFilePaths = new Set();
    const hiddenFilePaths = new Set();
    diffFileRoots().forEach((diffFile) => {
      const hidden = isGeneratedCollapsedDiff(diffFile);
      const filePath = diffFilePath(diffFile);
      diffFile.toggleAttribute('data-golens-generated-hidden', hidden);
      if (hidden && diffFile.id) hiddenFileHashes.add(diffFile.id);
      if (filePath) allFilePaths.add(filePath);
      if (hidden && filePath) hiddenFilePaths.add(filePath);
    });
    document.querySelectorAll('[data-file-row]').forEach((fileRow) => {
      fileRow.toggleAttribute(
        'data-golens-generated-file-row',
        hiddenFileHashes.has(fileRow.dataset.fileRow)
      );
    });
    reconcileGeneratedFileFolders(allFilePaths, hiddenFilePaths);
  }

  function restoreGoTestFileRows() {
    document.querySelectorAll('[data-golens-go-test-file-row]').forEach((fileRow) => {
      fileRow.removeAttribute('data-golens-go-test-file-row');
    });
  }

  function reconcileGoTestFileRows() {
    if (!state.enabled || !isMergeRequestDiff()) {
      restoreGoTestFileRows();
      return;
    }
    document.querySelectorAll('[data-file-row]').forEach((fileRow) => {
      const labels = [
        fileRow.getAttribute('title'),
        fileRow.getAttribute('aria-label'),
        fileRow.textContent,
      ];
      const isGoTestFile = labels.some((label) =>
        normalizeRepositoryPath(label).endsWith('_test.go')
      );
      fileRow.toggleAttribute('data-golens-go-test-file-row', isGoTestFile);
    });
  }

  function overviewDiscussionLineTarget(discussion) {
    if (!discussion.querySelector('.diff-file tr.line_holder')) return '';
    const pageKey = mergeRequestPageKey();
    if (!pageKey) return '';
    const candidates = discussion.querySelectorAll(
      '.discussion-header .note-header-info a[href], .discussion-header .note-header a[href], .diff-file-header a[href], [data-testid="file-title"] a[href]'
    );
    for (const candidate of candidates) {
      try {
        const url = new URL(candidate.getAttribute('href'), location.href);
        if (`${url.origin}${url.pathname}` === `${pageKey}/diffs` && url.hash) return url.href;
      } catch {
        // Ignore malformed or non-navigation links rendered by third-party GitLab integrations.
      }
    }
    return '';
  }

  function mountOverviewDiscussionLineLink(discussion) {
    if (discussion.querySelector('[data-golens-discussion-line-link]')) return;
    const href = overviewDiscussionLineTarget(discussion);
    const header = discussion.querySelector(
      '.discussion-header .note-header-info, .discussion-header .note-header'
    );
    if (!href || !header) return;
    const link = document.createElement('a');
    link.className = 'gitlab-lens-discussion-line-link';
    link.dataset.golensDiscussionLineLink = '';
    link.href = href;
    link.textContent = 'View in changes';
    link.title = 'Open the commented line in the Changes tab';
    link.setAttribute('aria-label', 'Open commented line in Changes');
    header.append(link);
  }

  function removeOverviewDiscussionLineLinks() {
    document.querySelectorAll('[data-golens-discussion-line-link]').forEach((link) => link.remove());
  }

  function reconcileOverviewDiscussionLineLinks() {
    if (!state.enabled || !isMergeRequest() || isMergeRequestDiff()) {
      removeOverviewDiscussionLineLinks();
      return;
    }
    document.querySelectorAll('[data-testid="discussion-content"].js-discussion-container')
      .forEach(mountOverviewDiscussionLineLink);
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

  function setFullFileButtonState(button, { mode = 'full', label, busy = false } = {}) {
    const defaultLabel = mode === 'changes' ? 'Show changes only' : mode === 'complete' ? 'Full file shown' : 'Show full file';
    const accessibleLabel = label || defaultLabel;
    button.dataset.mode = mode;
    button.dataset.state = busy ? 'busy' : mode === 'complete' ? 'complete' : 'idle';
    button.disabled = busy || mode === 'complete';
    button.toggleAttribute('aria-busy', busy);
    button.title = busy ? 'Expanding full file…' : accessibleLabel;
    button.setAttribute('aria-label', busy ? 'Expanding full file' : accessibleLabel);
  }

  function createFullFileButton({ mode = 'full', label, renderer = 'fallback' } = {}) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'gitlab-lens-full-file-button';
    button.dataset.golensFullFile = '';
    button.dataset.renderer = renderer;
    button.innerHTML = fullFileIcon();
    setFullFileButtonState(button, { mode, label });
    return button;
  }

  function rapidFullFileItem(diffFile) {
    const script = diffFile.querySelector('[data-options-menu] script[type="application/json"]');
    if (!script?.textContent) return null;
    try {
      const findItem = (items) => {
        for (const item of items || []) {
          if (item?.extraAttrs?.['data-click'] === 'showFullFile') return item;
          const nested = findItem(item?.items);
          if (nested) return nested;
        }
        return null;
      };
      return findItem(JSON.parse(script.textContent));
    } catch {
      return null;
    }
  }

  function rapidViewerIsText(diffFile) {
    try {
      return JSON.parse(diffFile.dataset.fileData || '{}').viewer?.startsWith('text_') || false;
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
        const cancelled = !state.enabled || !diffFile.isConnected || !button.isConnected;
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
    while (state.enabled && diffFile.isConnected && button.isConnected) {
      const control = expansionControls(diffFile)[0];
      if (!control) {
        setFullFileButtonState(button, { mode: 'complete' });
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
      controlled ? document.getElementById(controlled) : null,
      optionsButton.closest('[data-testid="file-title-container"]'),
      ...document.querySelectorAll('[role="menu"]'),
    ].filter(Boolean);
    for (const scope of scopes) {
      const action = [...scope.querySelectorAll('button, [role="menuitem"]')].find((candidate) =>
        /^(show full file|show changes only)$/i.test(candidate.textContent.trim())
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
    setFullFileButtonState(button, { mode: button.dataset.mode, busy: true });
    try {
      const optionsButton = diffFile.querySelector('[data-testid="options-dropdown-button"]');
      if (optionsButton) {
        optionsButton.click();
        const nativeAction = await waitForLegacyFullFileAction(optionsButton);
        if (nativeAction) {
          const showingFullFile = /^show full file$/i.test(nativeAction.textContent.trim());
          nativeAction.click();
          const mode = showingFullFile ? 'changes' : 'full';
          diffFile.dataset.golensFullFileMode = mode;
          setFullFileButtonState(button, { mode });
          return;
        }
        optionsButton.click();
      }
      if (button.dataset.mode === 'changes') throw new Error('Show changes only is unavailable.');
      await expandAllHunks(diffFile, button);
    } catch (error) {
      if (!button.isConnected) return;
      setFullFileButtonState(button, { mode: button.dataset.mode, label: 'Could not expand full file' });
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
    const mode = nativeItem?.extraAttrs?.['data-full'] ? 'changes' : 'full';
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
    document.querySelectorAll('[data-golens-full-file]').forEach((button) => button.remove());
  }

  function reconcileFullFileButtons() {
    if (!state.enabled || !isMergeRequestDiff()) {
      removeFullFileButtons();
      return;
    }
    document.querySelectorAll('diff-file[data-testid="rd-diff-file"], diff-file[data-file-data]').forEach(mountRapidFullFileButton);
    document.querySelectorAll('.diff-file.file-holder').forEach(mountLegacyFullFileButton);
  }

  function inReviewFocus() {
    return document.documentElement.classList.contains('gitlab-lens-review-focus');
  }

  async function disableGoLens() {
    cancelCelebrationActivity({ resetStatus: true });
    globalThis.GoLensGoNavigation?.teardown();
    if (inReviewFocus()) await toggleReviewFocus();
  }

  function createControls() {
    if (state.controlsHost && (state.controlsHost.isConnected || !state.controlsMounted)) return;
    state.controlsHost?.remove();
    const host = document.createElement('aside');
    host.id = 'gitlab-lens-root';
    state.controlsHost = host;
    state.controlsMounted = false;
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all:initial; position:relative; display:inline-block; color-scheme:dark; }
        * { box-sizing:border-box; }
        .controls { display:grid; gap:var(--golens-space-1); padding:var(--golens-space-1); border:1px solid var(--golens-border-subtle); border-radius:var(--golens-radius-md); background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-sm); }
        button { position:relative; display:grid; place-items:center; width:32px; height:32px; overflow:hidden; padding:0; border:1px solid transparent; border-radius:var(--golens-radius-sm); background:transparent; color:var(--golens-text-secondary); cursor:pointer; transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),color var(--golens-motion-fast),transform var(--golens-motion-fast),opacity var(--golens-motion-fast); }
        button:hover:not(:disabled) { border-color:var(--golens-border-strong); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
        button:active:not(:disabled) { background:var(--golens-surface-pressed); transform:translateY(1px); }
        button:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:2px; }
        button:disabled { cursor:not-allowed; opacity:.42; }
        button img { grid-area:1 / 1; width:24px; height:24px; border-radius:var(--golens-radius-xs); object-fit:contain; transition:opacity var(--golens-motion-base),transform var(--golens-motion-base); }
        button > svg { width:18px; height:18px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.75; }
        .golens-toggle[aria-pressed="true"] { border-color:var(--golens-primary); background:var(--golens-primary-soft); color:var(--golens-primary-hover); }
        .golens-toggle:not([aria-pressed="true"]) img { filter:grayscale(1); opacity:.58; }
        .golens-toggle .mascot-focus { opacity:0; transform:scale(.72); }
        .golens-toggle[data-review-focus="true"] .mascot-default { opacity:0; transform:scale(.82); }
        .golens-toggle[data-review-focus="true"] .mascot-focus { opacity:1; transform:scale(1); }
        .focus-toggle { color:var(--golens-info); }
        .focus-toggle[aria-pressed="true"] { border-color:var(--golens-info); background:var(--golens-info-soft); color:var(--golens-info-hover); box-shadow:inset 0 0 0 1px color-mix(in srgb,var(--golens-info) 18%,transparent); }
        .focus-toggle:disabled { filter:grayscale(1); }
        .preload-toggle { color:var(--golens-primary-hover); }
        .preload-toggle svg { display:none; width:18px; height:18px; }
        .preload-toggle[data-state="idle"] .preload-idle, .preload-toggle[data-state="error"] .preload-idle, .preload-toggle[data-state="complete"] .preload-check { display:block; }
        .preload-toggle[data-state="checking"] .preload-progress, .preload-toggle[data-state="busy"] .preload-progress { display:block; }
        .preload-toggle[data-state="complete"] { border-color:var(--golens-success); background:var(--golens-success-soft); color:var(--golens-success); }
        .preload-toggle[data-state="error"] { border-color:var(--golens-error); background:var(--golens-error-soft); color:var(--golens-error); }
        .preload-toggle[data-state="checking"], .preload-toggle[data-state="busy"] { cursor:progress; opacity:1; }
        .preload-toggle:disabled:not([data-state="checking"]):not([data-state="busy"]) { filter:grayscale(1); }
        .preload-progress { position:absolute; inset:0; display:none; overflow:hidden; background:var(--golens-surface-raised); }
        .preload-fill { position:absolute; z-index:2; inset:0 auto 0 0; width:0; overflow:hidden; background:var(--golens-primary); transition:width var(--golens-motion-base); }
        .preload-count, .preload-fill-count { position:absolute; inset:0; display:flex; width:30px; align-items:center; justify-content:center; font:800 9px/1 var(--golens-font-mono); font-variant-numeric:tabular-nums; letter-spacing:-.06em; pointer-events:none; }
        .preload-count { z-index:1; color:var(--golens-text-secondary); }
        .preload-fill-count { color:var(--golens-text-inverse); }
        .preload-count[hidden], .preload-fill-count[hidden] { display:none; }
        .preload-toggle[data-count-size="small"] :is(.preload-count,.preload-fill-count) { font-size:8px; }
        .preload-toggle[data-count-size="tiny"] :is(.preload-count,.preload-fill-count) { font-size:7px; letter-spacing:-.1em; }
        .preload-toggle.is-indeterminate .preload-fill { width:42%; animation:preload-sweep 1s ease-in-out infinite; transition:none; }
        @keyframes preload-sweep { from { transform:translateX(-110%); } to { transform:translateX(250%); } }
        @media (prefers-reduced-motion:reduce) { button,button img,.preload-fill { transition:none; } button:active:not(:disabled) { transform:none; } .preload-toggle.is-indeterminate .preload-fill { width:100%; animation:none; opacity:.45; } }
      </style>
      <div class="controls">
        <button class="golens-toggle" data-action="toggle-enabled" aria-pressed="false"><img class="mascot-default" src="${chrome.runtime.getURL('assets/icons/golens-32.png')}" alt=""><img class="mascot-focus" src="${chrome.runtime.getURL('assets/celebrations/golens-focus.png')}" alt=""></button>
        <button class="focus-toggle" data-action="focus" title="Full screen mode" aria-label="Full screen mode" aria-pressed="false"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"></path><path d="M8.5 12h7"></path></svg></button>
        <button class="preload-toggle" data-action="preload" data-state="idle" title="Cache related MR packages" aria-label="Cache related MR packages">
          <svg class="preload-idle" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4-4m-4 4-4-4"></path><path d="M5 17v3h14v-3"></path></svg>
          <span class="preload-progress" role="progressbar" aria-label="Caching related MR packages" aria-valuemin="0" aria-valuemax="100">
            <span class="preload-count" aria-hidden="true" hidden></span>
            <span class="preload-fill" aria-hidden="true"><span class="preload-fill-count" hidden></span></span>
          </span>
          <svg class="preload-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg>
        </button>
      </div>
      `;
    mountControlsInAiPanels(host);
    wireControls(shadow);
  }

  function closeOnboarding() {
    const host = document.getElementById('golens-onboarding-root');
    if (!host) return;
    host.remove();
    state.onboardingReturnFocus?.focus?.();
    state.onboardingReturnFocus = null;
    const queuedMoment = state.queuedMascotMoment;
    state.queuedMascotMoment = '';
    if (queuedMoment && state.enabled && state.pageActive) {
      setTimeout(() => showMascotMoment(queuedMoment), 0);
    }
  }

  function closeSettingsOverlay({ restoreFocus = true } = {}) {
    const host = document.getElementById('golens-settings-root');
    if (!host) return;
    host.remove();
    if (restoreFocus) state.settingsReturnFocus?.focus?.();
    state.settingsReturnFocus = null;
    const queuedMoment = state.queuedMascotMoment;
    state.queuedMascotMoment = '';
    if (queuedMoment && state.enabled && state.pageActive) setTimeout(() => showMascotMoment(queuedMoment), 0);
  }

  function showSettingsOverlay() {
    const existing = document.getElementById('golens-settings-root');
    if (existing) {
      existing.shadowRoot?.querySelector('iframe')?.focus();
      return;
    }
    closeOnboarding();
    state.settingsReturnFocus = document.activeElement;
    const host = document.createElement('div');
    host.id = 'golens-settings-root';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all:initial; position:fixed; inset:0; z-index:var(--golens-z-modal); color-scheme:dark; }
        * { box-sizing:border-box; }
        .backdrop { position:absolute; inset:0; display:grid; place-items:center; overflow:auto; padding:32px; background:rgba(7,10,14,.76); backdrop-filter:blur(3px); }
        iframe { display:block; width:min(1080px,calc(100vw - 64px)); height:min(690px,calc(100dvh - 64px)); border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-overlay); background:var(--golens-surface-canvas); box-shadow:var(--golens-shadow-overlay); }
        iframe:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:3px; }
        @media (max-width:760px) { .backdrop { padding:12px; } iframe { width:calc(100vw - 24px); height:calc(100dvh - 24px); } }
        @media (prefers-reduced-motion:reduce) { .backdrop { backdrop-filter:none; } }
      </style>
      <div class="backdrop" data-action="close-settings-backdrop" role="dialog" aria-modal="true" aria-label="GoLens settings">
        <iframe src="${chrome.runtime.getURL('settings.html')}" title="GoLens settings"></iframe>
      </div>
    `;
    shadow.querySelector('[data-action="close-settings-backdrop"]').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) closeSettingsOverlay();
    });
    const frame = shadow.querySelector('iframe');
    frame.addEventListener('load', () => {
      host.dataset.loaded = 'true';
      frame.focus();
    }, { once: true });
    document.body.append(host);
  }

  function onboardingFeatureIcon(name) {
    if (name === 'brand') {
      return `<span class="feature-icon feature-icon-brand" data-feature-icon="brand" aria-hidden="true"><img src="${chrome.runtime.getURL('assets/icons/golens-32.png')}" alt=""></span>`;
    }
    const icons = {
      focus: {
        tone: 'info',
        body: '<path d="M8 4H5a1 1 0 0 0-1 1v3M16 4h3a1 1 0 0 1 1 1v3M20 16v3a1 1 0 0 1-1 1h-3M8 20H5a1 1 0 0 1-1-1v-3"></path><path d="M8.5 12h7"></path>',
      },
      download: {
        tone: 'brand',
        body: '<path d="M12 3v11m0 0 4-4m-4 4-4-4"></path><path d="M5 17v3h14v-3"></path>',
      },
      hover: {
        tone: 'info',
        body: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6z"></path><circle cx="12" cy="12" r="2.5"></circle>',
      },
      navigate: {
        tone: 'info',
        body: '<rect x="6" y="3" width="12" height="18" rx="6"></rect><path d="M12 3v7M6 10h12"></path>',
      },
      inDiff: {
        tone: 'brand',
        viewBox: '0 0 16 16',
        filled: true,
        body: '<path d="M2 2h2v6a3 3 0 0 0 3 3h4.2L9 8.8 10.4 7 15 11.5 10.4 16 9 14.2l2.2-2.2H7a4 4 0 0 1-4-4V2z"></path>',
      },
      copy: {
        tone: 'info',
        viewBox: '0 0 16 16',
        body: '<rect x="5.25" y="5.25" width="8" height="8" rx="1.25"></rect><path d="M10.75 5.25V3.5c0-.7-.55-1.25-1.25-1.25h-6c-.7 0-1.25.55-1.25 1.25v6c0 .7.55 1.25 1.25 1.25h1.75"></path>',
      },
      testDouble: {
        tone: 'success',
        body: '<path d="M9 3h6M10 3v5l-5 8.5A3 3 0 0 0 7.6 21h8.8a3 3 0 0 0 2.6-4.5L14 8V3M8.5 14h7"></path>',
      },
      rapid: {
        tone: 'brand',
        body: '<path d="M13 2 4 14h7v8l9-12h-7z"></path>',
      },
      fullFile: {
        tone: 'neutral',
        viewBox: '0 0 16 16',
        body: '<path d="M3 1.75h10M3 14.25h10M8 3.25v3.5m0-3.5L6.25 5M8 3.25 9.75 5M8 12.75v-3.5m0 3.5L6.25 11M8 12.75 9.75 11"></path>',
      },
      search: {
        tone: 'info',
        body: '<circle cx="11" cy="11" r="6.5"></circle><path d="m16 16 4.5 4.5"></path>',
      },
      testFile: {
        tone: 'success',
        body: '<path d="M6 3h7l5 5v13H6zM13 3v5h5"></path><path d="m10 13-2 2 2 2m4-4 2 2-2 2"></path>',
      },
      generated: {
        tone: 'muted',
        body: '<path d="M3 3l18 18"></path><path d="M10.6 10.7a2 2 0 0 0 2.7 2.7M9.9 5.3A10.8 10.8 0 0 1 12 5c6 0 9.5 7 9.5 7a15.4 15.4 0 0 1-2.4 3.2M6.6 6.6A16 16 0 0 0 2.5 12s3.5 7 9.5 7a9.7 9.7 0 0 0 3.4-.6"></path>',
      },
      discussion: {
        tone: 'brand',
        body: '<path d="M5 18l-2 3V7a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3z"></path><path d="M9 11h7m-3-3 3 3-3 3"></path>',
      },
      settings: {
        tone: 'neutral',
        body: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"></path><circle cx="16" cy="7" r="2"></circle><circle cx="8" cy="17" r="2"></circle>',
      },
      database: {
        tone: 'info',
        body: '<ellipse cx="12" cy="5" rx="7" ry="3"></ellipse><path d="M5 5v7c0 1.7 3.1 3 7 3s7-1.3 7-3V5M5 12v7c0 1.7 3.1 3 7 3s7-1.3 7-3v-7"></path>',
      },
      replay: {
        tone: 'neutral',
        viewBox: '0 0 16 16',
        body: '<path d="M3 8h9m-3.5-3.5L12 8l-3.5 3.5"></path>',
      },
      lock: {
        tone: 'success',
        body: '<rect x="5" y="10" width="14" height="11" rx="2"></rect><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"></path>',
      },
    };
    const icon = icons[name];
    if (!icon) return '';
    const classes = ['feature-icon', `feature-icon-${icon.tone}`];
    if (icon.filled) classes.push('feature-icon-filled');
    return `<span class="${classes.join(' ')}" data-feature-icon="${name}" aria-hidden="true"><svg viewBox="${icon.viewBox || '0 0 24 24'}">${icon.body}</svg></span>`;
  }

  function showOnboarding() {
    const existing = document.getElementById('golens-onboarding-root');
    if (existing) {
      existing.shadowRoot?.querySelector('[role="tab"][aria-selected="true"]')?.focus();
      return;
    }

    state.onboardingReturnFocus = document.activeElement;
    const host = document.createElement('div');
    host.id = 'golens-onboarding-root';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all:initial; position:fixed; inset:0; z-index:var(--golens-z-modal); color:var(--golens-text-primary); font:14px/1.45 var(--golens-font-sans); color-scheme:dark; }
        * { box-sizing:border-box; }
        .backdrop { position:absolute; inset:0; display:grid; place-items:center; overflow:auto; padding:var(--golens-space-6); background:rgba(9,10,12,.82); backdrop-filter:blur(4px); }
        .dialog { position:relative; display:grid; grid-template-rows:auto minmax(0,1fr) auto; width:min(760px,calc(100vw - 32px)); max-height:min(720px,calc(100dvh - 32px)); overflow:hidden; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-xl); background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-lg); }
        .hero { display:grid; grid-template-columns:64px 1fr; gap:var(--golens-space-4); align-items:center; padding:var(--golens-space-5) var(--golens-space-6); border-bottom:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); }
        .mascot { width:64px; height:64px; object-fit:contain; }
        .eyebrow { margin:0 0 var(--golens-space-1); color:var(--golens-primary-hover); font-size:11px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
        h1 { margin:0; color:var(--golens-text-primary); font-size:24px; line-height:1.15; letter-spacing:-.025em; }
        .intro { max-width:560px; margin:var(--golens-space-2) 0 0; color:var(--golens-text-secondary); text-wrap:pretty; }
        .close { position:absolute; top:var(--golens-space-3); right:var(--golens-space-3); display:grid; place-items:center; width:32px; height:32px; padding:0; border:1px solid transparent; border-radius:var(--golens-radius-sm); background:transparent; color:var(--golens-text-muted); cursor:pointer; font:22px/1 var(--golens-font-sans); transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),color var(--golens-motion-fast),transform var(--golens-motion-fast); }
        .close:hover { border-color:var(--golens-border-default); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
        .close:active { background:var(--golens-surface-pressed); transform:translateY(1px); }
        .tour { display:grid; grid-template-columns:180px minmax(0,1fr); min-height:0; }
        .tour-nav { display:grid; align-content:start; gap:var(--golens-space-1); padding:var(--golens-space-4); border-right:1px solid var(--golens-border-subtle); background:var(--golens-surface-inset); }
        .tour-tab { display:grid; grid-template-columns:28px minmax(0,1fr); gap:var(--golens-space-2); align-items:center; min-height:42px; padding:var(--golens-space-2); border:1px solid transparent; border-radius:var(--golens-radius-sm); background:transparent; color:var(--golens-text-secondary); cursor:pointer; font:650 12px/1.3 var(--golens-font-sans); text-align:left; transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),color var(--golens-motion-fast),transform var(--golens-motion-fast); }
        .tour-tab:hover { border-color:var(--golens-border-default); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
        .tour-tab:active { background:var(--golens-surface-pressed); transform:translateY(1px); }
        .tour-tab[aria-selected="true"] { border-color:color-mix(in srgb,var(--golens-primary) 55%,var(--golens-border-default)); background:var(--golens-primary-soft); color:var(--golens-text-primary); }
        .tab-icon { display:grid; place-items:center; width:28px; height:28px; color:var(--golens-text-muted); }
        .tab-icon svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.75; }
        .tab-icon img { width:24px; height:24px; border-radius:var(--golens-radius-xs); object-fit:contain; filter:grayscale(.5); opacity:.78; }
        .tab-symbol { display:inline-flex; width:auto; min-width:24px; height:20px; align-items:center; justify-content:center; padding:0 3px; border:1px solid currentColor; border-radius:var(--golens-radius-xs); color:var(--golens-info-hover); font:700 9px/1 var(--golens-font-mono); }
        .tour-tab[aria-selected="true"] .tab-icon { color:var(--golens-primary-hover); }
        .tour-tab[aria-selected="true"] .tab-icon img { filter:none; opacity:1; }
        .tour-panels { min-width:0; min-height:0; overflow:hidden; }
        .tour-panel { height:100%; overflow:auto; padding:var(--golens-space-5) var(--golens-space-6) var(--golens-space-6); }
        .tour-panel[hidden] { display:none; }
        .chapter-label { margin:0 0 var(--golens-space-1); color:var(--golens-primary-hover); font-size:10px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; }
        h2 { margin:0; color:var(--golens-text-primary); font-size:19px; line-height:1.2; letter-spacing:-.015em; text-wrap:balance; }
        .chapter-intro { max-width:58ch; margin:var(--golens-space-2) 0 var(--golens-space-4); color:var(--golens-text-secondary); font-size:12px; line-height:1.55; text-wrap:pretty; }
        .feature-list { display:grid; gap:0; margin:0; padding:0; list-style:none; }
        .feature { display:grid; grid-template-columns:40px minmax(0,1fr); gap:var(--golens-space-3); align-items:start; padding:var(--golens-space-3) 0; border-top:1px solid var(--golens-border-subtle); }
        .feature-icon { display:grid; place-items:center; width:40px; height:40px; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-sm); background:var(--golens-surface-raised); color:var(--golens-text-secondary); box-shadow:inset 0 1px 0 color-mix(in srgb,var(--golens-text-primary) 5%,transparent); }
        .feature-icon svg { width:24px; height:24px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.75; }
        .feature-icon-filled svg { fill:currentColor; stroke:none; }
        .feature-icon img { width:30px; height:30px; border-radius:var(--golens-radius-xs); object-fit:contain; }
        .feature-icon-brand { border-color:color-mix(in srgb,var(--golens-primary) 45%,var(--golens-border-default)); background:var(--golens-primary-soft); }
        .feature-icon-info { border-color:color-mix(in srgb,var(--golens-info) 35%,var(--golens-border-default)); background:var(--golens-info-soft); color:var(--golens-info-hover); }
        .feature-icon-success { border-color:color-mix(in srgb,var(--golens-success) 35%,var(--golens-border-default)); background:var(--golens-success-soft); color:var(--golens-success); }
        .feature-icon-muted { color:var(--golens-text-muted); }
        .feature strong { display:block; margin:0 0 2px; color:var(--golens-text-primary); font-size:12px; line-height:1.35; }
        .feature p { max-width:62ch; margin:0; color:var(--golens-text-secondary); font-size:11px; line-height:1.5; text-wrap:pretty; }
        .feature-note { color:var(--golens-text-muted); }
        kbd { min-width:24px; padding:2px 6px; border:1px solid var(--golens-border-strong); border-bottom-width:2px; border-radius:var(--golens-radius-xs); background:var(--golens-surface-inset); color:var(--golens-text-primary); font:700 10px/1.4 var(--golens-font-mono); text-align:center; }
        .footer { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:var(--golens-space-3); align-items:center; padding:var(--golens-space-3) var(--golens-space-5); border-top:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); }
        .tour-progress { margin:0; color:var(--golens-text-muted); font:650 10px/1.4 var(--golens-font-mono); text-align:center; }
        .secondary,.primary { min-height:36px; padding:0 var(--golens-space-4); border-radius:var(--golens-radius-sm); cursor:pointer; font:750 12px/1 var(--golens-font-sans); white-space:nowrap; transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),color var(--golens-motion-fast),transform var(--golens-motion-fast); }
        .secondary { border:1px solid var(--golens-border-default); background:transparent; color:var(--golens-text-secondary); }
        .secondary:hover { border-color:var(--golens-border-strong); background:var(--golens-surface-hover); color:var(--golens-text-primary); }
        .secondary[hidden] { visibility:hidden; display:block; }
        .primary { flex:0 0 auto; min-height:38px; padding:0 var(--golens-space-5); border:1px solid var(--golens-primary); border-radius:var(--golens-radius-sm); background:var(--golens-primary); color:var(--golens-text-inverse); cursor:pointer; font:800 13px/1 var(--golens-font-sans); transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),transform var(--golens-motion-fast); }
        .primary:hover { border-color:var(--golens-primary-hover); background:var(--golens-primary-hover); }
        .secondary:active,.primary:active { transform:translateY(1px); }
        .primary:active { border-color:var(--golens-primary-pressed); background:var(--golens-primary-pressed); }
        button:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:2px; }
        @media (max-width:640px) { .backdrop { padding:var(--golens-space-3); } .dialog { max-height:calc(100dvh - 24px); } .hero { grid-template-columns:48px 1fr; padding:var(--golens-space-4) var(--golens-space-5); } .mascot { width:48px; height:48px; } h1 { padding-right:var(--golens-space-5); font-size:20px; } .tour { grid-template-columns:1fr; grid-template-rows:auto minmax(0,1fr); } .tour-nav { grid-template-columns:repeat(4,minmax(112px,1fr)); overflow-x:auto; padding:var(--golens-space-2) var(--golens-space-3); border-right:0; border-bottom:1px solid var(--golens-border-subtle); } .tour-tab { grid-template-columns:24px minmax(0,1fr); min-height:36px; padding:var(--golens-space-1) var(--golens-space-2); font-size:10px; } .tab-icon { width:24px; height:24px; } .tab-icon svg { width:18px; height:18px; } .tab-icon img { width:22px; height:22px; } .tour-panel { padding:var(--golens-space-4) var(--golens-space-5) var(--golens-space-5); } }
        @media (max-width:420px) { .hero { grid-template-columns:1fr; } .mascot { display:none; } .footer { grid-template-columns:auto 1fr auto; padding-inline:var(--golens-space-3); } .secondary,.primary { padding-inline:var(--golens-space-3); } }
        @media (prefers-reduced-motion:reduce) { .close,.tour-tab,.secondary,.primary { transition:none; } .close:active,.tour-tab:active,.secondary:active,.primary:active { transform:none; } }
      </style>
      <div class="backdrop" data-action="backdrop">
        <section class="dialog" data-onboarding-dialog role="dialog" aria-modal="true" aria-labelledby="golens-onboarding-title" aria-describedby="golens-onboarding-description">
          <button class="close" type="button" data-action="close-onboarding" aria-label="Close quick tour">×</button>
          <header class="hero">
            <img class="mascot" src="${chrome.runtime.getURL('assets/icons/golens-128.png')}" alt="">
            <div>
              <p class="eyebrow">Quick tour</p>
              <h1 id="golens-onboarding-title">Welcome to GoLens for GitLab</h1>
              <p class="intro" id="golens-onboarding-description">Every review tool, grouped into four short chapters so you can find the useful details without memorizing them.</p>
            </div>
          </header>
          <div class="tour">
            <nav class="tour-nav" role="tablist" aria-label="Quick tour chapters">
              <button class="tour-tab" id="golens-tour-tab-controls" type="button" role="tab" aria-selected="true" aria-controls="golens-tour-controls"><span class="tab-icon" aria-hidden="true"><img src="${chrome.runtime.getURL('assets/icons/golens-32.png')}" alt=""></span><span>Page controls</span></button>
              <button class="tour-tab" id="golens-tour-tab-go" type="button" role="tab" aria-selected="false" aria-controls="golens-tour-go" tabindex="-1"><span class="tab-icon" aria-hidden="true"><span class="tab-symbol">Go</span></span><span>Go intelligence</span></button>
              <button class="tour-tab" id="golens-tour-tab-diff" type="button" role="tab" aria-selected="false" aria-controls="golens-tour-diff" tabindex="-1"><span class="tab-icon" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3 1.75h10M3 14.25h10M8 3.25v3.5m0-3.5L6.25 5M8 3.25 9.75 5M8 12.75v-3.5m0 3.5L6.25 11M8 12.75 9.75 11"></path></svg></span><span>Diff helpers</span></button>
              <button class="tour-tab" id="golens-tour-tab-popup" type="button" role="tab" aria-selected="false" aria-controls="golens-tour-popup" tabindex="-1"><span class="tab-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M4 7h10M18 7h2M4 17h2M10 17h10"></path><circle cx="16" cy="7" r="2"></circle><circle cx="8" cy="17" r="2"></circle></svg></span><span>Settings</span></button>
            </nav>
            <div class="tour-panels">
              <section class="tour-panel" id="golens-tour-controls" role="tabpanel" aria-labelledby="golens-tour-tab-controls" tabindex="0">
                <p class="chapter-label">Always beside GitLab’s AI panel</p>
                <h2>Review controls and celebrations</h2>
                <p class="chapter-intro">The compact strip stays with the merge request, even when GitLab navigates without reloading the page.</p>
                <ul class="feature-list">
                  <li class="feature">${onboardingFeatureIcon('brand')}<div><strong>Turn GoLens on or off</strong><p>The logo button controls all GoLens behavior. The same global switch is also available in the extension menu and syncs to every open GitLab tab.</p></div></li>
                    <li class="feature">${onboardingFeatureIcon('focus')}<div><strong>Enter fullscreen review focus</strong><p>Hide GitLab chrome and the file tree, widen the diff, and enlarge code. The mascot puts on review goggles until you press <kbd>Esc</kbd> or use the button again.</p></div></li>
                    <li class="feature">${onboardingFeatureIcon('download')}<div><strong>Cache related MR packages</strong><p>Fetch changed and related Go packages at the merge request’s head commit. The button shows discovery, package counts, completion, errors, and a tiny pitstop when the cache is ready.</p></div></li>
                    <li class="feature">${onboardingFeatureIcon('brand')}<div><strong>Mark review milestones</strong><p>The mascot reacts after GitLab confirms an approval, merge, or final resolved discussion. On Friday after 16:00, finishing or creating an MR unlocks an extra-long beer-kart lap with confetti. Reduced-motion preferences use a static moment.</p></div></li>
                </ul>
              </section>
              <section class="tour-panel" id="golens-tour-go" role="tabpanel" aria-labelledby="golens-tour-tab-go" tabindex="0" hidden>
                <p class="chapter-label">Browser-native Go navigation</p>
                <h2>Inspect and follow symbols</h2>
                <p class="chapter-intro">GoLens indexes commit-pinned source in your browser and refuses to guess when a result is missing or ambiguous.</p>
                <ul class="feature-list">
                  <li class="feature">${onboardingFeatureIcon('hover')}<div><strong>Hover for Go insight</strong><p>See a symbol’s kind, signature, documentation, and source location. Hovering a definition also finds its usages.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('navigate')}<div><strong>Modifier-click to navigate</strong><p><kbd>Cmd</kbd>-click on macOS or <kbd>Ctrl</kbd>-click elsewhere. Uses go to definitions, definitions find usages, and interfaces find implementations.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('search')}<div><strong>Select and revisit occurrences</strong><p>Plain-click a Go identifier to highlight same-spelling occurrences in the loaded diff. Use your previous and next occurrence shortcuts to move between them.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('inDiff')}<div><strong>Stay in the diff when possible</strong><p>Targets already in the diff scroll into view. Other project files open at the exact line in a new tab; packages, built-ins, and standard-library symbols open their directory or documentation.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('navigate')}<div><strong>Retrace semantic jumps</strong><p>Go back and forward through in-diff definition and usage jumps without changing the browser’s page history.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('copy')}<div><strong>Use the small popover tools</strong><p>Move into the result to pin it, copy its <span class="feature-note">file:line:column</span>, expand long signatures, choose ambiguous matches, or press <kbd>Esc</kbd> to close.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('search')}<div><strong>Check the search scope</strong><p>Every usage and implementation result says whether GoLens searched the current package, a limited set of indexed packages, or the complete project. Use <span class="feature-note">Show more</span> for additional matches.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('download')}<div><strong>Search the complete project explicitly</strong><p>Incomplete results can exhaust GitLab’s commit-pinned code search and index only matching Go packages. The progress dialog can be minimized or cancelled, then GoLens refreshes the result when coverage is complete.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('testDouble')}<div><strong>Separate test doubles</strong><p>Implementation results keep production matches first and place structural or asserted test doubles in their own expandable group.</p></div></li>
                </ul>
              </section>
              <section class="tour-panel" id="golens-tour-diff" role="tabpanel" aria-labelledby="golens-tour-tab-diff" tabindex="0" hidden>
                <p class="chapter-label">Small helpers across the merge request</p>
                <h2>Move through large diffs faster</h2>
                <p class="chapter-intro">These helpers use GitLab’s existing UI and metadata, so they remain familiar and reversible.</p>
                <ul class="feature-list">
                  <li class="feature">${onboardingFeatureIcon('rapid')}<div><strong>Use Rapid Diffs automatically</strong><p>When GitLab offers its Rapid Diffs opt-in on the Changes page, GoLens enables it for the review.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('fullFile')}<div><strong>Show a full file</strong><p>Use the expand icon in a file header to reveal all available lines, then switch back to changes-only where GitLab supports it.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('search')}<div><strong>Reach file search from the keyboard</strong><p><kbd>Cmd/Ctrl P</kbd> focuses and selects GitLab’s file search. <kbd>Shift F</kbd> clears it and returns to the diff.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('inDiff')}<div><strong>Move by hunk or file</strong><p>Use individually configurable previous and next shortcuts to cross loaded change blocks and files. Each destination is briefly highlighted.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('testFile')}<div><strong>Spot Go test files</strong><p>Files ending in <span class="feature-note">_test.go</span> receive a subtle green label in the file tree.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('generated')}<div><strong>Optionally hide generated files</strong><p>Enable this in the extension menu to hide files GitLab marks as generated through <span class="feature-note">.gitattributes</span>. Large collapsed files stay visible, and generated-only folders are dimmed.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('discussion')}<div><strong>Jump from overview discussions to code</strong><p>Line discussions on the merge request overview gain a <span class="feature-note">View in changes</span> link to the exact commented line.</p></div></li>
                </ul>
              </section>
              <section class="tour-panel" id="golens-tour-popup" role="tabpanel" aria-labelledby="golens-tour-tab-popup" tabindex="0" hidden>
                <p class="chapter-label">Open from the compact browser menu</p>
                <h2>Tabbed settings and cache control</h2>
                <p class="chapter-intro">Keep active-project caching close, then open the large settings overlay for behavior shared by every GitLab tab.</p>
                <ul class="feature-list">
                  <li class="feature">${onboardingFeatureIcon('settings')}<div><strong>Open the settings overlay</strong><p>Use the gear in the compact browser menu to open a large tabbed settings surface over the active GitLab page. Close it with <kbd>Esc</kbd>, the close button, or the backdrop.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('settings')}<div><strong>Set global review preferences</strong><p>Enable or disable GoLens everywhere and choose whether GitLab-marked generated files should be hidden.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('navigate')}<div><strong>Customize every shortcut</strong><p>Record, clear, or reset each navigation binding separately. Assigning a binding already in use moves it to the newly chosen action.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('lock')}<div><strong>Approve self-hosted GitLab origins</strong><p>GitLab.com works automatically. Add or remove each self-hosted HTTP(S) origin from the extension menu so GoLens only runs where you explicitly allow it.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('download')}<div><strong>Cache the full project</strong><p>Broaden navigation beyond related MR packages. Progress and availability are reported against the active merge request.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('database')}<div><strong>Inspect or clear the source cache</strong><p>See its browser storage size, package count, and source-record count, or remove every cached snapshot at once.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('replay')}<div><strong>Replay this complete tour</strong><p>Open the Help settings page and choose <span class="feature-note">Show quick tour</span> whenever you need a refresher.</p></div></li>
                  <li class="feature">${onboardingFeatureIcon('lock')}<div><strong>Keep repository source local</strong><p>Source stays inside your browser, this extension, and your signed-in GitLab origin. Requests are same-origin and pinned to the merge request commit.</p></div></li>
                </ul>
              </section>
            </div>
          </div>
          <footer class="footer">
            <button class="secondary" type="button" data-action="previous-onboarding" hidden>Back</button>
            <p class="tour-progress" data-tour-progress aria-live="polite">1 of 4 · Page controls</p>
            <button class="primary" type="button" data-action="next-onboarding">Next</button>
          </footer>
        </section>
      </div>
    `;

    const close = () => closeOnboarding();
    const closeButton = shadow.querySelector('[data-action="close-onboarding"]');
    const tabs = [...shadow.querySelectorAll('[role="tab"]')];
    const panels = [...shadow.querySelectorAll('[role="tabpanel"]')];
    const previousButton = shadow.querySelector('[data-action="previous-onboarding"]');
    const primaryButton = shadow.querySelector('[data-action="next-onboarding"]');
    const progress = shadow.querySelector('[data-tour-progress]');
    let activePage = 0;
    const showPage = (index, { focusTab = false } = {}) => {
      activePage = Math.max(0, Math.min(tabs.length - 1, index));
      tabs.forEach((tab, tabIndex) => {
        const active = tabIndex === activePage;
        tab.setAttribute('aria-selected', String(active));
        tab.tabIndex = active ? 0 : -1;
      });
      panels.forEach((panel, panelIndex) => { panel.hidden = panelIndex !== activePage; });
      previousButton.hidden = activePage === 0;
      primaryButton.textContent = activePage === tabs.length - 1 ? 'Start reviewing' : 'Next';
      progress.textContent = `${activePage + 1} of ${tabs.length} · ${tabs[activePage].lastElementChild.textContent.trim()}`;
      if (focusTab) tabs[activePage].focus();
    };
    closeButton.addEventListener('click', close);
    tabs.forEach((tab, index) => tab.addEventListener('click', () => showPage(index)));
    previousButton.addEventListener('click', () => showPage(activePage - 1));
    primaryButton.addEventListener('click', () => {
      if (activePage === tabs.length - 1) close();
      else showPage(activePage + 1);
    });
    shadow.querySelector('[data-action="backdrop"]').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) close();
    });
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.target.getAttribute?.('role') === 'tab' && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const nextPage = event.key === 'Home'
          ? 0
          : event.key === 'End'
          ? tabs.length - 1
          : activePage + (event.key === 'ArrowRight' ? 1 : -1);
        showPage((nextPage + tabs.length) % tabs.length, { focusTab: true });
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [closeButton, ...tabs, previousButton, ...panels, primaryButton]
        .filter((element) => !element.disabled && !element.hidden && !element.closest('[hidden]') && element.tabIndex >= 0);
      const index = focusable.indexOf(shadow.activeElement);
      const next = event.shiftKey
        ? (index <= 0 ? focusable.length - 1 : index - 1)
        : (index === focusable.length - 1 ? 0 : index + 1);
      event.preventDefault();
      focusable[next].focus();
    });
    document.body.append(host);
    showPage(0);
    primaryButton.focus();
  }

  async function showFirstRunOnboarding() {
    const stored = await chrome.storage.local.get({ [ONBOARDING_STORAGE_KEY]: 0 });
    if (stored[ONBOARDING_STORAGE_KEY] >= ONBOARDING_VERSION) return;
    showOnboarding();
    await chrome.storage.local.set({ [ONBOARDING_STORAGE_KEY]: ONBOARDING_VERSION });
  }

  function wireControls(shadow) {
    shadow.querySelector('[data-action="toggle-enabled"]').addEventListener('click', () => setEnabled(!state.enabled, { persist: true }));
    shadow.querySelector('[data-action="focus"]').addEventListener('click', async () => {
      if (!state.enabled) return;
      await toggleReviewFocus();
      renderControlState(shadow);
    });
    shadow.querySelector('[data-action="preload"]').addEventListener('click', preloadMergeRequest);
  }

  function setPreloadState(status, { message = '', progress = null } = {}) {
    state.preload = { status, message, progress };
    renderControlState();
  }

  function renderPreloadState(shadow, enabled) {
    const button = shadow.querySelector('[data-action="preload"]');
    const progressBar = button.querySelector('.preload-progress');
    const fill = progressBar.querySelector('.preload-fill');
    const count = button.querySelector('.preload-count');
    const fillCount = button.querySelector('.preload-fill-count');
    const { status, message, progress } = state.preload;
    const busy = status === 'checking' || status === 'busy';
    const percentage = Number.isFinite(progress?.percentage) ? Math.max(0, Math.min(100, progress.percentage)) : null;
    const indeterminate = busy && (percentage === null || progress?.phase === 'discovering');
    const visualState = status === 'checking' ? 'checking' : status;
    button.dataset.state = visualState;
    button.disabled = !enabled || busy;
    button.classList.toggle('is-indeterminate', indeterminate);
    button.toggleAttribute('aria-busy', busy);
    if (indeterminate || percentage === null) {
      progressBar.removeAttribute('aria-valuenow');
      fill.style.width = '';
    } else {
      progressBar.setAttribute('aria-valuenow', String(percentage));
      fill.style.width = `${percentage}%`;
    }
    const showCount = busy
      && !indeterminate
      && progress?.unit === 'packages'
      && Number.isFinite(progress.completed)
      && Number.isFinite(progress.total)
      && progress.total > 0;
    const countLabel = showCount ? `${progress.completed}/${progress.total}` : '';
    count.textContent = countLabel;
    fillCount.textContent = countLabel;
    count.hidden = !showCount;
    fillCount.hidden = !showCount;
    const countLength = countLabel.replace('/', '').length;
    button.dataset.countSize = countLength > 6 ? 'tiny' : countLength > 4 ? 'small' : 'normal';

    const label = status === 'complete'
      ? (message || 'Related MR cache ready')
      : status === 'busy' || status === 'checking'
      ? (message || 'Checking MR head cache…')
      : status === 'error'
      ? `Cache related MR packages · ${message || 'previous attempt failed'}`
      : 'Cache related MR packages';
    button.title = label;
    button.setAttribute('aria-label', label);
  }

  function renderControlState(shadow = document.getElementById('gitlab-lens-root')?.shadowRoot) {
    if (!shadow) return;
    const enabled = state.enabled;
    const toggle = shadow.querySelector('[data-action="toggle-enabled"]');
    const focus = shadow.querySelector('[data-action="focus"]');
    toggle.setAttribute('aria-pressed', String(enabled));
    toggle.setAttribute('title', enabled ? 'Turn GoLens off' : 'Turn GoLens on');
    toggle.setAttribute('aria-label', enabled ? 'Turn GoLens off' : 'Turn GoLens on');
    toggle.dataset.reviewFocus = String(enabled && inReviewFocus());
    focus.disabled = !enabled;
    focus.setAttribute('aria-pressed', String(enabled && inReviewFocus()));
    renderPreloadState(shadow, enabled);
  }

  async function preloadMergeRequest() {
    if (!state.enabled || state.preload.status === 'checking' || state.preload.status === 'busy') return;
    const navigation = globalThis.GoLensGoNavigation;
    if (!navigation?.preloadMergeRequest) return;
    const runID = ++state.preloadRunID;
    setPreloadState('busy', { message: 'Preparing MR head cache…' });
    try {
      const result = await navigation.preloadMergeRequest((message, progress) => {
        if (runID === state.preloadRunID) setPreloadState('busy', { message, progress });
      });
      if (runID !== state.preloadRunID) return;
      const message = result.searchStatus === 'unavailable'
        ? 'Related cache ready · code search unavailable'
        : result.searchStatus === 'limited'
        ? 'Related cache ready · candidate search limited'
        : result.coverage === 'full' ? 'Full project cached' : 'Related MR cache ready';
      setPreloadState('complete', { message, progress: { percentage: 100 } });
      requestMascotMoment('pitstop');
    } catch (error) {
      if (runID !== state.preloadRunID) return;
      setPreloadState('error', { message: error.message || 'Preload failed' });
    }
  }

  async function refreshPreloadStatus() {
    const navigation = globalThis.GoLensGoNavigation;
    if (!navigation?.mergeRequestPreloadStatus || state.preload.status === 'busy') return;
    const checkID = ++state.preloadCheckID;
    const wasComplete = state.preload.status === 'complete';
    try {
      const result = await navigation.mergeRequestPreloadStatus();
      if (checkID !== state.preloadCheckID || state.preload.status === 'busy') return;
      if (result.status === 'complete') {
        const message = result.searchStatus === 'unavailable'
          ? 'Related cache ready · code search unavailable'
          : result.searchStatus === 'limited'
          ? 'Related cache ready · candidate search limited'
          : result.coverage === 'full' ? 'Full project cached' : 'Related MR cache ready';
        setPreloadState('complete', { message, progress: { percentage: 100 } });
      } else {
        navigation.invalidateCacheState?.();
        setPreloadState('idle');
      }
    } catch (error) {
      if (checkID !== state.preloadCheckID || wasComplete || state.preload.status === 'busy') return;
      setPreloadState('error', { message: error.message || 'Unable to check cache' });
    }
  }

  function normalizeCelebrationStatus(result) {
    return {
      state: String(result?.state || '').toLowerCase(),
      approvers: [...new Set((result?.approvers || []).map(String))],
    };
  }

  async function refreshCelebrationBaseline() {
    const navigation = globalThis.GoLensGoNavigation;
    if (!state.enabled || !state.pageActive || !navigation?.mergeRequestCelebrationStatus) {
      state.celebrationStatus = null;
      return null;
    }
    const pageKey = state.pageKey;
    try {
      const result = normalizeCelebrationStatus(await navigation.mergeRequestCelebrationStatus());
      if (!state.enabled || state.pageKey !== pageKey) return null;
      state.celebrationStatus = result;
      return result;
    } catch {
      if (state.pageKey === pageKey) state.celebrationStatus = null;
      return null;
    }
  }

  function normalizeDiscussionStatus(result) {
    return { unresolved: Math.max(0, Number(result?.unresolved) || 0) };
  }

  async function refreshDiscussionBaseline() {
    const navigation = globalThis.GoLensGoNavigation;
    if (!state.enabled || !state.pageActive || !navigation?.mergeRequestDiscussionStatus) {
      state.discussionStatus = null;
      return null;
    }
    const pageKey = state.pageKey;
    try {
      const result = normalizeDiscussionStatus(await navigation.mergeRequestDiscussionStatus());
      if (!state.enabled || state.pageKey !== pageKey) return null;
      state.discussionStatus = result;
      return result;
    } catch {
      if (state.pageKey === pageKey) state.discussionStatus = null;
      return null;
    }
  }

  function removeCelebrationOverlay() {
    clearTimeout(state.celebrationRemoveTimer);
    state.celebrationRemoveTimer = null;
    document.getElementById('golens-celebration-root')?.remove();
  }

  function cancelCelebrationActivity({ resetStatus = false } = {}) {
    state.celebrationRunID++;
    state.discussionRunID++;
    clearTimeout(state.celebrationPollTimer);
    clearTimeout(state.discussionPollTimer);
    state.celebrationPollTimer = null;
    state.discussionPollTimer = null;
    removeCelebrationOverlay();
    if (resetStatus) {
      state.celebrationStatus = null;
      state.discussionStatus = null;
      state.queuedMascotMoment = '';
    }
  }

  function isFridayAfterFour(date = new Date()) {
    return date.getDay() === 5 && date.getHours() >= 16;
  }

  function requestMascotMoment(kind) {
    if (!state.enabled || !state.pageActive) return;
    if (document.getElementById('golens-onboarding-root') || document.getElementById('golens-settings-root')) {
      state.queuedMascotMoment = kind;
      return;
    }
    showMascotMoment(kind);
  }

  function showMascotMoment(kind) {
    const moments = {
      approved: { asset: 'golens-approved.png', message: 'Approval confirmed', duration: 1700 },
      merged: { asset: 'golens-merged.png', message: 'Merge confirmed', duration: 2000 },
      pitstop: { asset: 'golens-pitstop.png', message: 'Source cache ready', duration: 2100 },
      resolved: { asset: 'golens-discussions-resolved.png', message: 'All discussions resolved', duration: 1900 },
      friday: { asset: 'golens-friday-beer.png', message: 'Friday review complete. Cheers!', duration: 5800 },
    };
    const moment = moments[kind];
    if (!moment) return;
    removeCelebrationOverlay();
    const host = document.createElement('div');
    host.id = 'golens-celebration-root';
    host.dataset.celebration = kind;
    const controlsRect = state.controlsHost?.getBoundingClientRect();
    if (controlsRect) {
      const approvalWidth = Math.min(144, Math.max(104, window.innerWidth * .1));
      const left = Math.max(12, Math.min(window.innerWidth - approvalWidth - 12, controlsRect.left - approvalWidth + 18));
      const top = Math.max(12, Math.min(window.innerHeight - approvalWidth - 12, controlsRect.top + controlsRect.height / 2 - approvalWidth / 2));
      host.style.setProperty('--golens-celebration-x', `${left}px`);
      host.style.setProperty('--golens-celebration-y', `${top}px`);
    }
    const confetti = kind === 'friday'
      ? `<div class="confetti-field" aria-hidden="true">${Array.from({ length: 48 }, (_, index) => {
          const x = (index * 37 + 11) % 101;
          const drift = (index * 53) % 141 - 70;
          const delay = (index * 89) % 1400;
          const fall = 3000 + (index * 137) % 1000;
          const turn = 360 + (index * 47) % 540;
          return `<i class="confetti" style="--x:${x}vw;--drift:${drift}px;--delay:${delay}ms;--fall:${fall}ms;--turn:${turn}deg"></i>`;
        }).join('')}</div>`
      : '';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all:initial; position:fixed; inset:0; z-index:var(--golens-z-overlay); pointer-events:none; contain:layout style; }
        * { box-sizing:border-box; }
        .status { position:absolute; width:1px; height:1px; overflow:hidden; clip-path:inset(50%); white-space:nowrap; }
        .sprite { position:fixed; display:block; object-fit:contain; will-change:transform,opacity; }
        .approved,.resolved { left:var(--golens-celebration-x,calc(100vw - 168px)); top:var(--golens-celebration-y,24px); }
        .approved { width:clamp(104px,10vw,144px); animation:golens-approved 1600ms var(--golens-ease-out) both; }
        .resolved { width:clamp(120px,11vw,156px); animation:golens-resolved 1800ms var(--golens-ease-out) both; }
        .merged,.friday { left:0; bottom:max(12px,env(safe-area-inset-bottom)); width:clamp(240px,30vw,360px); animation:golens-lap 1900ms cubic-bezier(.18,.72,.25,1) both; }
        .friday { width:clamp(260px,32vw,380px); animation:golens-friday-lap 5500ms cubic-bezier(.18,.72,.25,1) both; }
        .pitstop { right:12px; bottom:max(12px,env(safe-area-inset-bottom)); width:clamp(280px,34vw,420px); animation:golens-pitstop 2000ms var(--golens-ease-out) both; }
        .confetti-field { position:fixed; inset:0; overflow:hidden; }
        .confetti { position:absolute; top:-18px; left:var(--x); width:10px; height:6px; border-radius:2px; opacity:0; background:#f39c3d; animation:golens-confetti var(--fall) cubic-bezier(.2,.65,.35,1) var(--delay) both; }
        .confetti:nth-child(5n+2) { background:#77cce5; }
        .confetti:nth-child(5n+3) { background:#f4d35e; }
        .confetti:nth-child(5n+4) { background:#f47c7c; }
        .confetti:nth-child(5n) { background:#9ae6b4; }
        @keyframes golens-approved {
          0% { opacity:0; transform:translate3d(30px,12px,0) scale(.72); }
          18% { opacity:1; transform:translate3d(0,0,0) scale(1); }
          38% { opacity:1; transform:translate3d(-2px,4px,0) rotate(-3deg) scale(1); }
          58% { opacity:1; transform:translate3d(0,0,0) rotate(0) scale(1); }
          78% { opacity:1; transform:translate3d(0,0,0) scale(1); }
          100% { opacity:0; transform:translate3d(24px,10px,0) scale(.85); }
        }
        @keyframes golens-resolved {
          0% { opacity:0; transform:translate3d(28px,8px,0) scale(.78); }
          20% { opacity:1; transform:translate3d(0,0,0) scale(1); }
          42% { opacity:1; transform:translate3d(0,5px,0) rotate(-2deg) scale(.98); }
          60%,80% { opacity:1; transform:translate3d(0,0,0) rotate(0) scale(1); }
          100% { opacity:0; transform:translate3d(20px,8px,0) scale(.86); }
        }
        @keyframes golens-lap {
          0% { opacity:0; transform:translate3d(-110%,0,0) scale(.92); }
          12% { opacity:1; }
          82% { opacity:1; }
          100% { opacity:0; transform:translate3d(calc(100vw + 10%),0,0) scale(1); }
        }
        @keyframes golens-friday-lap {
          0% { opacity:0; transform:translate3d(-110%,0,0) rotate(0) scale(.92); }
          10% { opacity:1; transform:translate3d(10vw,0,0) rotate(-1deg) scale(1); }
          30% { opacity:1; transform:translate3d(34vw,-6px,0) rotate(1deg) scale(1); }
          58% { opacity:1; transform:translate3d(48vw,0,0) rotate(-1deg) scale(1.02); }
          72% { opacity:1; transform:translate3d(61vw,-4px,0) rotate(1deg) scale(1); }
          88% { opacity:1; }
          100% { opacity:0; transform:translate3d(calc(100vw + 10%),0,0) rotate(0) scale(1); }
        }
        @keyframes golens-confetti {
          0% { opacity:0; transform:translate3d(0,-24px,0) rotate(0); }
          10%,86% { opacity:1; }
          100% { opacity:0; transform:translate3d(var(--drift),calc(100vh + 42px),0) rotate(var(--turn)); }
        }
        @keyframes golens-pitstop {
          0% { opacity:0; transform:translate3d(110%,0,0) scale(.94); }
          24% { opacity:1; transform:translate3d(-8px,0,0) scale(1); }
          38%,78% { opacity:1; transform:translate3d(0,0,0) scale(1); }
          100% { opacity:0; transform:translate3d(0,10px,0) scale(.96); }
        }
        @media (max-width:640px) { .approved { width:110px; } .resolved { width:124px; } .merged,.friday { width:260px; } .pitstop { width:300px; } }
        @media (prefers-reduced-motion:reduce) {
          .sprite { will-change:auto; }
          .confetti-field { display:none; }
          .approved,.resolved { animation:golens-celebration-still 900ms ease-out both; }
          .merged { right:12px; left:auto; animation:golens-celebration-still 1200ms ease-out both; }
          .friday { right:12px; left:auto; animation:golens-celebration-still 2200ms ease-out both; }
          .pitstop { animation:golens-celebration-still 1200ms ease-out both; }
          @keyframes golens-celebration-still { 0%,100% { opacity:0; } 12%,82% { opacity:1; } }
        }
      </style>
      <div class="status" role="status" aria-live="polite">${moment.message}</div>
      ${confetti}
      <img class="sprite ${kind}" src="${chrome.runtime.getURL(`assets/celebrations/${moment.asset}`)}" alt="">
    `;
    document.body.append(host);
    state.celebrationRemoveTimer = setTimeout(removeCelebrationOverlay, moment.duration);
  }

  function buttonDetailsForTarget(target) {
    const button = target?.closest?.('button,[role="button"],a[data-testid]');
    if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') return null;
    return {
      button,
      testID: String(button.getAttribute('data-testid') || '').toLowerCase(),
      label: [button.textContent, button.getAttribute('aria-label'), button.title]
        .filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().toLowerCase(),
    };
  }

  function mergeRequestActionForTarget(target) {
    const details = buttonDetailsForTarget(target);
    if (!details) return '';
    const { testID, label } = details;
    if (/unapprove|revoke(?: my)? approval/.test(`${testID} ${label}`)) return '';
    if (/(?:^|[-_])approve(?:[-_]|$)/.test(testID) || /^(?:approve|submit approval)(?:\s|$)/.test(label)) return 'approved';
    if (/(?:^|[-_])merge(?:[-_]|$)/.test(testID) || /^(?:merge|merge immediately|merge when pipeline succeeds|set to auto-merge)(?:\s|$)/.test(label)) return 'merged';
    return '';
  }

  function discussionResolveActionForTarget(target) {
    const details = buttonDetailsForTarget(target);
    if (!details) return false;
    const { testID, label } = details;
    if (/reopen|unresolve/.test(`${testID} ${label}`)) return false;
    return /resolve[-_](?:discussion|thread)/.test(testID)
      || /^(?:resolve discussion|resolve thread)(?:\s|$)/.test(label);
  }

  function createMergeRequestActionForTarget(target) {
    const details = buttonDetailsForTarget(target);
    if (!details) return false;
    return /create[-_]merge[-_]request/.test(details.testID)
      || /^create merge request(?:\s|$)/.test(details.label);
  }

  function rememberFridayMergeRequestCreation() {
    if (!state.enabled || !isGitLab() || !isFridayAfterFour()) return;
    try {
      window.sessionStorage.setItem(FRIDAY_MR_CREATE_STORAGE_KEY, JSON.stringify({
        at: Date.now(),
        projectPath: location.pathname.split('/-/')[0],
      }));
    } catch {
      // A disabled session store only skips this optional Easter egg.
    }
  }

  function consumeFridayMergeRequestCreation() {
    if (!state.enabled || !isFridayAfterFour() || !isMergeRequest()) return false;
    try {
      const raw = window.sessionStorage.getItem(FRIDAY_MR_CREATE_STORAGE_KEY);
      if (!raw) return false;
      window.sessionStorage.removeItem(FRIDAY_MR_CREATE_STORAGE_KEY);
      const pending = JSON.parse(raw);
      const recent = Number.isFinite(pending?.at) && Date.now() - pending.at >= 0 && Date.now() - pending.at < 120000;
      const sameProject = pending?.projectPath && location.pathname.startsWith(`${pending.projectPath}/-/merge_requests/`);
      if (!recent || !sameProject) return false;
      requestMascotMoment('friday');
      return true;
    } catch {
      return false;
    }
  }

  function celebrationReached(action, baseline, current) {
    if (action === 'merged') return baseline.state !== 'merged' && current.state === 'merged';
    const previousApprovers = new Set(baseline.approvers);
    return current.approvers.some((approver) => !previousApprovers.has(approver));
  }

  function scheduleCelebrationPoll(action, baseline, attempt, runID) {
    const delay = CELEBRATION_POLL_INTERVALS_MS[attempt];
    if (delay == null) return;
    state.celebrationPollTimer = setTimeout(async () => {
      if (runID !== state.celebrationRunID || !state.enabled || !state.pageActive) return;
      const navigation = globalThis.GoLensGoNavigation;
      try {
        const current = normalizeCelebrationStatus(await navigation.mergeRequestCelebrationStatus());
        if (runID !== state.celebrationRunID || !state.enabled || !state.pageActive) return;
        state.celebrationStatus = current;
        if (celebrationReached(action, baseline, current)) {
          state.celebrationPollTimer = null;
          requestMascotMoment(isFridayAfterFour() ? 'friday' : action);
          return;
        }
      } catch {
        // GitLab may rerender or briefly reject requests while completing the action.
      }
      scheduleCelebrationPoll(action, baseline, attempt + 1, runID);
    }, delay);
  }

  function armMergeRequestCelebration(action) {
    if (!state.enabled || !state.pageActive || !state.celebrationStatus) return;
    if (!globalThis.GoLensGoNavigation?.mergeRequestCelebrationStatus) return;
    clearTimeout(state.celebrationPollTimer);
    const runID = ++state.celebrationRunID;
    scheduleCelebrationPoll(action, state.celebrationStatus, 0, runID);
  }

  function scheduleDiscussionPoll(baseline, attempt, runID) {
    const delay = CELEBRATION_POLL_INTERVALS_MS[attempt];
    if (delay == null) return;
    state.discussionPollTimer = setTimeout(async () => {
      if (runID !== state.discussionRunID || !state.enabled || !state.pageActive) return;
      const navigation = globalThis.GoLensGoNavigation;
      try {
        const current = normalizeDiscussionStatus(await navigation.mergeRequestDiscussionStatus());
        if (runID !== state.discussionRunID || !state.enabled || !state.pageActive) return;
        state.discussionStatus = current;
        if (baseline.unresolved > 0 && current.unresolved === 0) {
          state.discussionPollTimer = null;
          requestMascotMoment('resolved');
          return;
        }
      } catch {
        // GitLab may briefly rerender a thread while its resolved state is saved.
      }
      scheduleDiscussionPoll(baseline, attempt + 1, runID);
    }, delay);
  }

  function armDiscussionCelebration() {
    if (!state.enabled || !state.pageActive || !state.discussionStatus?.unresolved) return;
    if (!globalThis.GoLensGoNavigation?.mergeRequestDiscussionStatus) return;
    clearTimeout(state.discussionPollTimer);
    const runID = ++state.discussionRunID;
    scheduleDiscussionPoll(state.discussionStatus, 0, runID);
  }

  function onNativeMergeRequestActionClick(event) {
    if (createMergeRequestActionForTarget(event.target)) {
      rememberFridayMergeRequestCreation();
      return;
    }
    if (discussionResolveActionForTarget(event.target)) armDiscussionCelebration();
    const action = mergeRequestActionForTarget(event.target);
    if (action) armMergeRequestCelebration(action);
  }

  async function setEnabled(enabled, { persist = false } = {}) {
    state.enabled = enabled;
    state.settings = { ...state.settings, enabled };
    if (!enabled) {
      state.preloadRunID++;
      state.fullPreloadRunID++;
    }
    renderControlState();
    const persisted = persist ? chrome.storage.sync.set({ enabled }) : Promise.resolve();
    if (enabled && isMergeRequest()) {
      watchForRapidDiffs();
      globalThis.GoLensGoNavigation?.init();
      await Promise.all([refreshCelebrationBaseline(), refreshDiscussionBaseline()]);
    } else {
      await disableGoLens();
    }
    reconcileFullFileButtons();
    reconcileGeneratedDiffFiles();
    reconcileGoTestFileRows();
    reconcileOverviewDiscussionLineLinks();
    renderControlState();
    await persisted;
  }

  function fullPreloadSnapshot() {
    const { status, message, progress } = state.fullPreload;
    return { status, message, progress };
  }

  function startFullProjectPreload() {
    if (state.fullPreload.status === 'busy') return fullPreloadSnapshot();
    const navigation = globalThis.GoLensGoNavigation;
    if (!isMergeRequest() || !navigation?.preloadFullProject) {
      state.fullPreload = { status: 'unavailable', message: 'Open a supported GitLab merge request.', progress: null };
      return fullPreloadSnapshot();
    }
    const runID = ++state.fullPreloadRunID;
    state.fullPreload = { status: 'busy', message: 'Preparing full project cache…', progress: null };
    navigation.preloadFullProject((message, progress) => {
      if (runID === state.fullPreloadRunID) state.fullPreload = { status: 'busy', message, progress };
    }).then(() => {
      if (runID !== state.fullPreloadRunID) return;
      state.fullPreload = { status: 'complete', message: 'Full project cached', progress: { phase: 'ready', percentage: 100 } };
      refreshPreloadStatus();
      requestMascotMoment('pitstop');
    }).catch((error) => {
      if (runID !== state.fullPreloadRunID) return;
      state.fullPreload = { status: 'error', message: error.message || 'Full project cache failed', progress: null };
    });
    return fullPreloadSnapshot();
  }

  async function refreshFullProjectPreloadStatus() {
    if (state.fullPreload.status === 'busy') return fullPreloadSnapshot();
    const navigation = globalThis.GoLensGoNavigation;
    if (!isMergeRequest() || !navigation?.fullProjectPreloadStatus) {
      state.fullPreload = { status: 'unavailable', message: 'Open a supported GitLab merge request.', progress: null };
      return fullPreloadSnapshot();
    }
    try {
      const result = await navigation.fullProjectPreloadStatus();
      state.fullPreload = result.status === 'complete'
        ? { status: 'complete', message: 'Full project cached', progress: { phase: 'ready', percentage: 100 } }
        : { status: 'idle', message: 'Not cached', progress: null };
    } catch (error) {
      state.fullPreload = { status: 'error', message: error.message || 'Unable to check full project cache', progress: null };
    }
    return fullPreloadSnapshot();
  }

  function nativeFileSearch() {
    return document.querySelector('[aria-label="File browser"] input[placeholder]')
      || document.querySelector('[data-testid="file-browser"] input[placeholder]')
      || [...document.querySelectorAll('input[placeholder]')].find((input) => /search\s*\(e\.g\.\s*\*\.vue\)/i.test(input.placeholder));
  }

  function isBlockedShortcutEvent(event) {
    const search = nativeFileSearch();
    const targets = [...event.composedPath(), document.activeElement].filter(Boolean);
    return targets.some((target) => {
      if (target === search) return true;
      const blocked = target?.closest?.('input, textarea, select, [contenteditable], dialog, [role="dialog"], [aria-modal="true"]');
      if (!blocked) return false;
      if (!blocked.matches?.('input, textarea, select, [contenteditable]')) return true;
      return !blocked.disabled && !blocked.readOnly && blocked.getAttribute('contenteditable') !== 'false';
    });
  }

  function focusNativeFileSearch() {
    const search = nativeFileSearch();
    if (!search) return false;
    search.focus();
    search.select();
    return true;
  }

  function closeNativeFileSearch() {
    const search = nativeFileSearch();
    if (!search) return false;
    search.value = '';
    search.dispatchEvent(new Event('input', { bubbles: true }));
    search.blur();
    return true;
  }

  document.addEventListener('keydown', (event) => {
    if (!state.enabled || !isMergeRequest() || event.isComposing || isBlockedShortcutEvent(event)) return;
    const shortcuts = globalThis.GoLensShortcuts;
    const bindings = shortcuts?.mergeBindings(state.settings.shortcutBindings);
    if (!shortcuts || !bindings) return;
    const action = shortcuts.actions.find(({ id }) => shortcuts.matchesEvent(bindings[id], event))?.id;
    if (!action) return;
    let handled = false;
    if (action === 'focusFileSearch') handled = focusNativeFileSearch();
    else if (action === 'clearFileSearch') handled = closeNativeFileSearch();
    else handled = globalThis.GoLensGoNavigation?.runNavigationAction?.(action) === true;
    if (handled) event.preventDefault();
  }, true);
  document.addEventListener('click', onNativeMergeRequestActionClick, true);

  async function toggleReviewFocus() {
    const entering = !inReviewFocus();
    document.documentElement.classList.toggle('gitlab-lens-review-focus', entering);
    if (entering && !document.fullscreenElement) {
      enableRapidDiffs();
      // Fullscreen is best-effort: browsers may reject it when a policy forbids it.
      await document.documentElement.requestFullscreen?.().then(() => {
        state.ownsFullscreen = Boolean(document.fullscreenElement);
      }).catch(() => undefined);
    } else if (!entering && document.fullscreenElement) {
      await document.exitFullscreen?.().catch(() => undefined);
      state.ownsFullscreen = false;
    }
  }

  async function leaveMergeRequestPage() {
    if (!state.pageActive) return;
    state.pageActive = false;
    state.pageKey = '';
    state.preloadCheckID++;
    state.preloadRunID++;
    state.fullPreloadRunID++;
    cancelCelebrationActivity({ resetStatus: true });
    closeOnboarding();
    closeSettingsOverlay({ restoreFocus: false });
    removeFullFileButtons();
    restoreGeneratedDiffFiles();
    restoreGoTestFileRows();
    removeOverviewDiscussionLineLinks();
    await disableGoLens();
    state.controlsHost?.remove();
    state.controlsHost = null;
    state.controlsMounted = false;
    state.preload = { status: 'idle', message: '', progress: null };
    state.fullPreload = { status: 'idle', message: 'Not cached', progress: null };
  }

  async function reconcilePage() {
    state.reconcileTimer = null;
    if (!isGitLab() || !isMergeRequest()) {
      await leaveMergeRequestPage();
      return;
    }

    const pageKey = mergeRequestPageKey();
    if (state.pageActive && state.pageKey !== pageKey) await leaveMergeRequestPage();

    if (!state.pageActive) {
      state.pageActive = true;
      state.pageKey = pageKey;
      createControls();
      await setEnabled(state.settings.enabled);
      await refreshPreloadStatus();
      await showFirstRunOnboarding();
      consumeFridayMergeRequestCreation();
      return;
    }

    createControls();
    reconcileFullFileButtons();
    reconcileGeneratedDiffFiles();
    reconcileGoTestFileRows();
    reconcileOverviewDiscussionLineLinks();
  }

  function schedulePageReconcile() {
    if (state.reconcileTimer) return;
    state.reconcileTimer = setTimeout(() => reconcilePage().catch(() => undefined), 0);
  }

  async function init() {
    if (!isGitLab()) return;
    try {
      state.settings = await chrome.storage.sync.get(defaults);
      state.settings = { ...state.settings, shortcutBindings: globalThis.GoLensShortcuts?.mergeBindings(state.settings.shortcutBindings) || state.settings.shortcutBindings };
    } catch {
      state.settings = defaults;
    }
    state.enabled = state.settings.enabled;
    window.addEventListener('focus', refreshPreloadStatus);
    window.addEventListener('popstate', schedulePageReconcile);
    document.addEventListener('turbo:load', schedulePageReconcile);
    document.addEventListener('pjax:end', schedulePageReconcile);
    document.addEventListener('fullscreenchange', () => {
      if (!state.ownsFullscreen || document.fullscreenElement || !inReviewFocus()) return;
      state.ownsFullscreen = false;
      document.documentElement.classList.remove('gitlab-lens-review-focus');
      renderControlState();
    });
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible') return;
      refreshPreloadStatus();
      schedulePageReconcile();
    });
    new MutationObserver(schedulePageReconcile).observe(document.body, { childList: true, subtree: true });
    chrome.storage.onChanged?.addListener((changes, areaName) => {
      if (areaName !== 'sync') return;
      if (typeof changes.hideGeneratedFiles?.newValue === 'boolean') {
        state.settings = { ...state.settings, hideGeneratedFiles: changes.hideGeneratedFiles.newValue };
      }
      if (changes.shortcutBindings) {
        state.settings = { ...state.settings, shortcutBindings: globalThis.GoLensShortcuts?.mergeBindings(changes.shortcutBindings.newValue) || changes.shortcutBindings.newValue };
      }
      if (changes.enabled && changes.enabled.newValue !== state.enabled) {
        setEnabled(changes.enabled.newValue).catch(() => undefined);
      } else if (changes.hideGeneratedFiles) {
        reconcileGeneratedDiffFiles();
      }
    });
    await reconcilePage();
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'golens-enabled') setEnabled(message.enabled);
    if (message?.type === 'golens-cache-invalidated') {
      globalThis.GoLensGoNavigation?.invalidateCacheState?.();
      state.preloadCheckID++;
      state.preloadRunID++;
      state.fullPreloadRunID++;
      setPreloadState('idle');
      state.fullPreload = { status: 'idle', message: 'Not cached', progress: null };
      sendResponse({ ok: true, result: { invalidated: true } });
    }
    if (message?.type === 'golens-preload-full-project') {
      sendResponse({ ok: true, result: startFullProjectPreload() });
    }
    if (message?.type === 'golens-full-project-status') {
      refreshFullProjectPreloadStatus()
        .then((result) => sendResponse({ ok: true, result }))
        .catch((error) => sendResponse({ ok: false, error: error.message || String(error) }));
      return true;
    }
    if (message?.type === 'golens-show-onboarding') {
      if (!isGitLab() || !isMergeRequest()) {
        sendResponse({ ok: false, error: 'Open a GitLab merge request first.' });
        return;
      }
      closeSettingsOverlay({ restoreFocus: false });
      showOnboarding();
      sendResponse({ ok: true, result: { shown: true } });
    }
    if (message?.type === 'golens-show-settings') {
      if (!isGitLab()) {
        sendResponse({ ok: false, error: 'Open a supported GitLab page first.' });
        return;
      }
      showSettingsOverlay();
      sendResponse({ ok: true, result: { shown: true } });
    }
    if (message?.type === 'golens-close-settings') {
      closeSettingsOverlay();
      sendResponse({ ok: true, result: { closed: true } });
    }
    if (message?.type === 'golens-settings-ready') {
      const host = document.getElementById('golens-settings-root');
      if (host) host.dataset.ready = 'true';
      sendResponse({ ok: Boolean(host), result: { ready: Boolean(host) } });
    }
  });

  init();
})();
