(() => {
  const defaults = { enabled: true };
  const ONBOARDING_VERSION = 1;
  const ONBOARDING_STORAGE_KEY = 'golensOnboardingVersion';
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

  function inReviewFocus() {
    return document.documentElement.classList.contains('gitlab-lens-review-focus');
  }

  async function disableGoLens() {
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
        :host { all:initial; position:relative; display:inline-block; } * { box-sizing:border-box; }
        .controls { display:grid; gap:6px; }
        button { display:grid; place-items:center; width:32px; height:32px; overflow:hidden; padding:0; border:1px solid rgba(255,188,145,.48); border-radius:8px; background:#241c19; box-shadow:0 4px 13px rgba(0,0,0,.25); cursor:pointer; transition:transform .15s ease, border-color .15s ease, filter .15s ease, opacity .15s ease; }
        button:hover:not(:disabled) { border-color:#fc6d26; transform:translateY(-1px); } button:focus-visible { outline:2px solid #fc6d26; outline-offset:2px; }
        button img { width:100%; height:100%; object-fit:cover; } .golens-toggle:not([aria-pressed="true"]) { filter:grayscale(1); opacity:.62; border-color:#6b6966; }
        .focus-toggle img { transform:scale(1.6); } .focus-toggle[aria-pressed="true"] { border-color:#fc6d26; box-shadow:0 0 0 2px rgba(252,109,38,.22),0 4px 13px rgba(0,0,0,.25); } .focus-toggle:disabled { cursor:not-allowed; filter:grayscale(1); opacity:.42; }
        .preload-toggle { position:relative; color:#ffc5a6; }
        .preload-toggle svg { display:none; width:20px; height:20px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:2; }
        .preload-toggle[data-state="idle"] .preload-idle, .preload-toggle[data-state="error"] .preload-idle, .preload-toggle[data-state="complete"] .preload-check { display:block; }
        .preload-toggle[data-state="checking"] .preload-progress, .preload-toggle[data-state="busy"] .preload-progress { display:block; }
        .preload-toggle[data-state="complete"] { color:#8bd49c; border-color:rgba(139,212,156,.72); box-shadow:0 0 0 2px rgba(139,212,156,.14),0 4px 13px rgba(0,0,0,.25); }
        .preload-toggle[data-state="error"] { color:#ff8d8d; border-color:rgba(255,141,141,.66); }
        .preload-toggle[data-state="checking"], .preload-toggle[data-state="busy"] { cursor:progress; opacity:1; }
        .preload-toggle:disabled:not([data-state="checking"]):not([data-state="busy"]) { cursor:not-allowed; filter:grayscale(1); opacity:.42; }
        .preload-progress { position:absolute; inset:0; display:none; overflow:hidden; background:#241c19; }
        .preload-fill { position:absolute; z-index:2; inset:0 auto 0 0; width:0; overflow:hidden; background:#fc6d26; transition:width .2s ease-out; }
        .preload-count, .preload-fill-count { position:absolute; inset:0; display:flex; width:30px; align-items:center; justify-content:center; font:850 9px/1 ui-monospace,SFMono-Regular,Menlo,monospace; font-variant-numeric:tabular-nums; letter-spacing:-.06em; pointer-events:none; }
        .preload-count { z-index:1; color:#ffe1d1; }
        .preload-fill-count { color:#2a1308; }
        .preload-count[hidden], .preload-fill-count[hidden] { display:none; }
        .preload-toggle[data-count-size="small"] :is(.preload-count,.preload-fill-count) { font-size:8px; }
        .preload-toggle[data-count-size="tiny"] :is(.preload-count,.preload-fill-count) { font-size:7px; letter-spacing:-.1em; }
        .preload-toggle.is-indeterminate .preload-fill { width:42%; animation:preload-sweep 1s ease-in-out infinite; transition:none; }
        @keyframes preload-sweep { from { transform:translateX(-110%); } to { transform:translateX(250%); } }
        @media (prefers-reduced-motion:reduce) { .preload-toggle.is-indeterminate .preload-fill { animation-duration:2s; } .preload-fill { transition:none; } }
      </style>
      <div class="controls">
        <button class="golens-toggle" data-action="toggle-enabled" aria-pressed="false"><img src="${chrome.runtime.getURL('assets/golens-icon.png')}" alt=""></button>
        <button class="focus-toggle" data-action="focus" title="Full screen mode" aria-label="Full screen mode" aria-pressed="false"><img src="${chrome.runtime.getURL('assets/golens-eyestrain.png')}" alt=""></button>
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
  }

  function showOnboarding() {
    const existing = document.getElementById('golens-onboarding-root');
    if (existing) {
      existing.shadowRoot?.querySelector('[data-action="dismiss-onboarding"]')?.focus();
      return;
    }

    state.onboardingReturnFocus = document.activeElement;
    const host = document.createElement('div');
    host.id = 'golens-onboarding-root';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all:initial; position:fixed; inset:0; z-index:2147483647; color:#f7f3ef; font:14px/1.45 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
        * { box-sizing:border-box; }
        .backdrop { position:absolute; inset:0; display:grid; place-items:center; overflow:auto; padding:24px; background:rgba(9,10,10,.78); backdrop-filter:blur(4px); }
        .dialog { position:relative; width:min(580px,calc(100vw - 32px)); overflow:hidden; border:1px solid #4a4541; border-radius:16px; background:#1b1c1c; box-shadow:0 24px 80px rgba(0,0,0,.58); }
        .hero { display:grid; grid-template-columns:96px 1fr; gap:18px; align-items:center; padding:24px 26px 19px; background:radial-gradient(circle at 12% 0%,rgba(0,173,216,.19),transparent 48%),linear-gradient(135deg,#211d1b,#1b1c1c 65%); }
        .mascot { width:96px; height:96px; object-fit:contain; filter:drop-shadow(0 9px 18px rgba(0,0,0,.28)); }
        .eyebrow { margin:0 0 4px; color:#ff9c65; font-size:11px; font-weight:800; letter-spacing:.12em; text-transform:uppercase; }
        h1 { margin:0; color:#fff; font-size:25px; line-height:1.15; letter-spacing:-.025em; }
        .intro { max-width:390px; margin:8px 0 0; color:#cfc9c3; }
        .close { position:absolute; top:12px; right:12px; display:grid; place-items:center; width:32px; height:32px; padding:0; border:0; border-radius:8px; background:transparent; color:#bcb5ae; cursor:pointer; font:22px/1 inherit; }
        .close:hover { background:#343231; color:#fff; }
        .steps { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; padding:18px 20px 12px; }
        .step { min-width:0; padding:14px; border:1px solid #3d3a38; border-radius:10px; background:#242424; }
        .step-icon { display:grid; place-items:center; width:34px; height:34px; margin-bottom:10px; border-radius:9px; background:#322925; color:#ff9c65; font-weight:850; }
        .step-icon.go { background:#17323a; color:#58cbe8; }
        .step-icon svg { width:20px; height:20px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:2; }
        h2 { margin:0 0 5px; color:#fff; font-size:14px; line-height:1.25; }
        .step p { margin:0; color:#bdb7b1; font-size:12px; line-height:1.45; }
        .tips { display:flex; flex-wrap:wrap; gap:7px 14px; align-items:center; margin:0 20px; padding:12px 0; border-top:1px solid #383634; color:#aaa39d; font-size:12px; }
        .tip { display:flex; align-items:center; gap:6px; }
        kbd { min-width:24px; padding:2px 6px; border:1px solid #5d5854; border-bottom-width:2px; border-radius:5px; background:#2c2b2a; color:#eee9e4; font:700 10px/1.4 inherit; text-align:center; }
        .footer { display:flex; justify-content:space-between; gap:16px; align-items:center; padding:14px 20px 18px; }
        .privacy { margin:0; color:#8f8983; font-size:11px; }
        .primary { flex:0 0 auto; min-height:38px; padding:0 17px; border:0; border-radius:8px; background:#fc6d26; color:#1b100b; cursor:pointer; font:800 13px/1 inherit; box-shadow:0 5px 18px rgba(252,109,38,.2); }
        .primary:hover { background:#ff8144; transform:translateY(-1px); }
        button:focus-visible { outline:2px solid #54cbed; outline-offset:2px; }
        @media (max-width:560px) { .hero { grid-template-columns:70px 1fr; padding:20px; } .mascot { width:70px; height:70px; } h1 { font-size:21px; } .steps { grid-template-columns:1fr; } .step { display:grid; grid-template-columns:34px 1fr; column-gap:11px; } .step-icon { grid-row:1 / span 2; margin:0; } .footer { align-items:flex-end; } }
        @media (prefers-reduced-motion:reduce) { .primary:hover { transform:none; } }
      </style>
      <div class="backdrop" data-action="backdrop">
        <section class="dialog" data-onboarding-dialog role="dialog" aria-modal="true" aria-labelledby="golens-onboarding-title" aria-describedby="golens-onboarding-description">
          <button class="close" type="button" data-action="close-onboarding" aria-label="Close quick tour">×</button>
          <header class="hero">
            <img class="mascot" src="${chrome.runtime.getURL('assets/golens-icon.png')}" alt="">
            <div>
              <p class="eyebrow">Quick tour</p>
              <h1 id="golens-onboarding-title">Welcome to GoLens for GitLab</h1>
              <p class="intro" id="golens-onboarding-description">A calmer, Go-aware workspace for reviewing GitLab merge requests.</p>
            </div>
          </header>
          <div class="steps">
            <article class="step">
              <span class="step-icon" aria-hidden="true">1</span>
              <h2>Focus the review</h2>
              <p>Use the three buttons beside GitLab’s AI control to toggle GoLens, enter fullscreen focus, or cache MR context.</p>
            </article>
            <article class="step">
              <span class="step-icon go" aria-hidden="true">Go</span>
              <h2>Explore the code</h2>
              <p>Hover Go identifiers for details. Cmd-click or Ctrl-click to find definitions, usages, and implementations.</p>
            </article>
            <article class="step">
              <span class="step-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 3v11m0 0 4-4m-4 4-4-4"></path><path d="M5 17v3h14v-3"></path></svg></span>
              <h2>Cache ahead</h2>
              <p>Cache related packages from the page, or the full project from the extension menu, for broader Go navigation.</p>
            </article>
          </div>
          <div class="tips" aria-label="Keyboard shortcuts">
            <span class="tip"><kbd>⌘/Ctrl P</kbd> Find a file</span>
            <span class="tip"><kbd>Shift F</kbd> Clear file search</span>
          </div>
          <footer class="footer">
            <p class="privacy">Source stays in your browser and signed-in GitLab session.</p>
            <button class="primary" type="button" data-action="dismiss-onboarding">Start reviewing</button>
          </footer>
        </section>
      </div>
    `;

    const close = () => closeOnboarding();
    const closeButton = shadow.querySelector('[data-action="close-onboarding"]');
    const primaryButton = shadow.querySelector('[data-action="dismiss-onboarding"]');
    closeButton.addEventListener('click', close);
    primaryButton.addEventListener('click', close);
    shadow.querySelector('[data-action="backdrop"]').addEventListener('click', (event) => {
      if (event.target === event.currentTarget) close();
    });
    shadow.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [closeButton, primaryButton];
      const index = focusable.indexOf(shadow.activeElement);
      const next = event.shiftKey
        ? (index <= 0 ? focusable.length - 1 : index - 1)
        : (index === focusable.length - 1 ? 0 : index + 1);
      event.preventDefault();
      focusable[next].focus();
    });
    document.body.append(host);
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
    } else {
      await disableGoLens();
    }
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
    if (!state.enabled || !isMergeRequest() || event.isComposing) return;
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'p' && focusNativeFileSearch()) {
      event.preventDefault();
    }
    if (event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'f' && closeNativeFileSearch()) {
      event.preventDefault();
    }
  }, true);

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
    closeOnboarding();
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
      return;
    }

    createControls();
  }

  function schedulePageReconcile() {
    if (state.reconcileTimer) return;
    state.reconcileTimer = setTimeout(() => reconcilePage().catch(() => undefined), 0);
  }

  async function init() {
    if (!isGitLab()) return;
    try {
      state.settings = await chrome.storage.sync.get(defaults);
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
      if (areaName === 'sync' && changes.enabled && changes.enabled.newValue !== state.enabled) {
        setEnabled(changes.enabled.newValue).catch(() => undefined);
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
      showOnboarding();
      sendResponse({ ok: true, result: { shown: true } });
    }
  });

  init();
})();
