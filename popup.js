const defaults = { enabled: true };
let activeTabID = null;
let fullCachePoll = null;

function formatBytes(bytes) {
  if (!bytes) return 'Empty';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

async function cacheRequest(type) {
  const response = await chrome.runtime.sendMessage({ type });
  if (!response?.ok) throw new Error(response?.error || 'Cache request failed');
  return response.result;
}

async function refreshCacheSize() {
  const size = document.querySelector('[data-cache-size]');
  try {
    const stats = await cacheRequest('golens-cache-stats');
    size.textContent = formatBytes(stats.bytes);
    size.title = `${stats.sources} stored source records across ${stats.packages} package snapshots and ${stats.projects} project snapshots`;
  } catch {
    size.textContent = 'Unavailable';
    size.removeAttribute('title');
  }
}

async function activeTabRequest(type) {
  if (!activeTabID) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabID = tab?.id || null;
  }
  if (!activeTabID) throw new Error('Open a GitLab merge request to cache its project.');
  const response = await chrome.tabs.sendMessage(activeTabID, { type });
  if (!response?.ok) throw new Error(response?.error || 'Project cache request failed');
  return response.result;
}

function renderFullProjectState(state) {
  const button = document.querySelector('[data-action="cache-full-project"]');
  const status = document.querySelector('[data-full-cache-status]');
  const progress = document.querySelector('[data-full-cache-progress]');
  const busy = state.status === 'busy';
  const complete = state.status === 'complete';
  const unavailable = state.status === 'unavailable';
  button.disabled = busy || complete || unavailable;
  button.textContent = complete ? 'Full project cached' : busy ? 'Caching full project…' : 'Cache full project';
  status.textContent = state.message || (complete ? 'Cached' : 'Not cached');
  const percentage = Number.isFinite(state.progress?.percentage) ? state.progress.percentage : null;
  progress.hidden = !busy;
  if (percentage === null || state.progress?.phase === 'discovering') {
    progress.removeAttribute('value');
  } else {
    progress.value = Math.max(0, Math.min(100, percentage));
  }
  if (busy) startFullCachePolling();
  else stopFullCachePolling();
}

function stopFullCachePolling() {
  if (fullCachePoll) clearInterval(fullCachePoll);
  fullCachePoll = null;
}

function startFullCachePolling() {
  if (fullCachePoll) return;
  fullCachePoll = setInterval(async () => {
    try {
      const state = await activeTabRequest('golens-full-project-status');
      renderFullProjectState(state);
      if (state.status === 'complete') await refreshCacheSize();
    } catch (error) {
      renderFullProjectState({ status: 'error', message: error.message || 'Unable to read project cache status.', progress: null });
    }
  }, 400);
}

async function refreshFullProjectState() {
  try {
    renderFullProjectState(await activeTabRequest('golens-full-project-status'));
  } catch {
    renderFullProjectState({ status: 'unavailable', message: 'Open a supported GitLab merge request.', progress: null });
  }
}

function wireFullProjectControl() {
  const button = document.querySelector('[data-action="cache-full-project"]');
  button.addEventListener('click', async () => {
    button.disabled = true;
    try {
      renderFullProjectState(await activeTabRequest('golens-preload-full-project'));
    } catch (error) {
      renderFullProjectState({ status: 'error', message: error.message || 'Unable to start full project cache.', progress: null });
    }
  });
}

function wireCacheControls() {
  const button = document.querySelector('[data-action="clear-cache"]');
  const status = document.querySelector('[data-cache-status]');
  button.addEventListener('click', async () => {
    if (!confirm('Clear all cached GitLab source snapshots?')) return;
    button.disabled = true;
    status.textContent = 'Clearing cache…';
    try {
      const cleared = await cacheRequest('golens-clear-cache');
      status.textContent = `Cleared ${formatBytes(cleared.bytes)} of cached source.`;
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (tab?.id) await chrome.tabs.sendMessage(tab.id, { type: 'golens-cache-invalidated' });
      } catch {
        // The active tab may not host GoLens; the cache has still been cleared.
      }
      await refreshCacheSize();
      await refreshFullProjectState();
    } catch (error) {
      status.textContent = error.message || 'Unable to clear cache.';
    } finally {
      button.disabled = false;
    }
  });
}

function wireOnboardingControl() {
  const button = document.querySelector('[data-action="show-onboarding"]');
  const status = document.querySelector('[data-onboarding-status]');
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = '';
    try {
      await activeTabRequest('golens-show-onboarding');
      status.textContent = 'Quick tour opened in this tab.';
    } catch (error) {
      status.textContent = error.message || 'Open a GitLab merge request first.';
    } finally {
      button.disabled = false;
    }
  });
}

async function initialise() {
  const settings = await chrome.storage.sync.get(defaults);
  for (const input of document.querySelectorAll('[data-setting]')) {
    const key = input.dataset.setting;
    input.checked = settings[key];
    input.addEventListener('change', async () => {
      await chrome.storage.sync.set({ [key]: input.checked });
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'golens-enabled', enabled: input.checked }).catch(() => undefined);
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync' || !changes.enabled) return;
    const input = document.querySelector('[data-setting="enabled"]');
    if (input) input.checked = changes.enabled.newValue;
  });
  wireCacheControls();
  wireOnboardingControl();
  wireFullProjectControl();
  await refreshFullProjectState();
  await refreshCacheSize();
}

initialise();
