export function formatBytes(bytes) {
  if (!bytes) return 'Empty';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

export async function cacheRequest(type) {
  const response = await chrome.runtime.sendMessage({ type });
  if (!response?.ok) throw new Error(response?.error || 'Cache request failed');
  return response.result;
}

export function createFullProjectCacheController({
  panel,
  button,
  status,
  progress,
  sizeOutput,
  context,
  idleMessage,
  completeMessage,
  unavailableMessage = 'Open a supported GitLab merge request.',
}) {
  let activeTabID = null;
  let fullCachePoll = null;

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

  async function refreshCacheSize() {
    try {
      const stats = await cacheRequest('golens-cache-stats');
      sizeOutput.textContent = formatBytes(stats.bytes);
      sizeOutput.title = `${stats.sources} stored source records across ${stats.packages} package snapshots and ${stats.projects} project snapshots`;
    } catch {
      sizeOutput.textContent = 'Unavailable';
      sizeOutput.removeAttribute('title');
    }
  }

  function stopFullCachePolling() {
    if (fullCachePoll) clearInterval(fullCachePoll);
    fullCachePoll = null;
  }

  function renderFullProjectState(state) {
    const busy = state.status === 'busy';
    const complete = state.status === 'complete';
    const unavailable = state.status === 'unavailable';
    panel.dataset.state = state.status || 'idle';
    button.disabled = busy || complete || unavailable;
    button.dataset.state = state.status || 'idle';
    button.toggleAttribute('aria-busy', busy);
    button.textContent = complete ? 'Full project cached' : busy ? 'Caching full project…' : 'Cache full project';
    status.textContent = state.message || (complete ? completeMessage : idleMessage);
    if (context) context.textContent = unavailable ? 'No active MR' : 'Active MR';
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
      renderFullProjectState({ status: 'unavailable', message: unavailableMessage, progress: null });
    }
  }

  function wireFullProjectControl() {
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        renderFullProjectState(await activeTabRequest('golens-preload-full-project'));
      } catch (error) {
        renderFullProjectState({ status: 'error', message: error.message || 'Unable to start full project cache.', progress: null });
      }
    });
  }

  return {
    activeTabRequest,
    refreshCacheSize,
    refreshFullProjectState,
    wireFullProjectControl,
  };
}
