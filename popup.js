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
  const output = document.querySelector('[data-cache-size]');
  try {
    const stats = await cacheRequest('golens-cache-stats');
    output.textContent = formatBytes(stats.bytes);
    output.title = `${stats.sources} stored source records across ${stats.packages} package snapshots and ${stats.projects} project snapshots`;
  } catch {
    output.textContent = 'Unavailable';
    output.removeAttribute('title');
  }
}

async function activeTabRequest(type) {
  if (!activeTabID) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTabID = tab?.id || null;
  }
  if (!activeTabID) throw new Error('Open a supported GitLab page.');
  const response = await chrome.tabs.sendMessage(activeTabID, { type });
  if (!response?.ok) throw new Error(response?.error || 'The active GitLab tab did not respond.');
  return response.result;
}

function stopFullCachePolling() {
  if (fullCachePoll) clearInterval(fullCachePoll);
  fullCachePoll = null;
}

function renderFullProjectState(state) {
  const panel = document.querySelector('[data-cache-panel]');
  const button = document.querySelector('[data-action="cache-full-project"]');
  const status = document.querySelector('[data-full-cache-status]');
  const progress = document.querySelector('[data-full-cache-progress]');
  const context = document.querySelector('[data-page-context]');
  const busy = state.status === 'busy';
  const complete = state.status === 'complete';
  const unavailable = state.status === 'unavailable';
  panel.dataset.state = state.status || 'idle';
  button.disabled = busy || complete || unavailable;
  button.dataset.state = state.status || 'idle';
  button.toggleAttribute('aria-busy', busy);
  button.textContent = complete ? 'Full project cached' : busy ? 'Caching full project…' : 'Cache full project';
  status.textContent = state.message || (complete ? 'Full-project results are ready.' : 'Full-project results are not cached yet.');
  context.textContent = unavailable ? 'No active MR' : 'Active MR';
  const percentage = Number.isFinite(state.progress?.percentage) ? state.progress.percentage : null;
  progress.hidden = !busy;
  if (percentage === null || state.progress?.phase === 'discovering') progress.removeAttribute('value');
  else progress.value = Math.max(0, Math.min(100, percentage));
  if (busy) startFullCachePolling();
  else stopFullCachePolling();
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

function wireSettingsControl() {
  const button = document.querySelector('[data-action="show-settings"]');
  const status = document.querySelector('[data-settings-status]');
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = '';
    try {
      await activeTabRequest('golens-show-settings');
      window.close();
    } catch (error) {
      status.textContent = error.message || 'Open a supported GitLab page first.';
      button.disabled = false;
    }
  });
}

async function initialise() {
  const settings = await chrome.storage.sync.get(defaults);
  const enabled = document.querySelector('[data-setting="enabled"]');
  enabled.checked = settings.enabled;
  enabled.addEventListener('change', async () => {
    await chrome.storage.sync.set({ enabled: enabled.checked });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'golens-enabled', enabled: enabled.checked }).catch(() => undefined);
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'sync' && typeof changes.enabled?.newValue === 'boolean') enabled.checked = changes.enabled.newValue;
  });
  wireSettingsControl();
  wireFullProjectControl();
  await Promise.all([refreshFullProjectState(), refreshCacheSize()]);
}

initialise();
