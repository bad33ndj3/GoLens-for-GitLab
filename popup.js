const defaults = { enabled: true, hideGeneratedFiles: false };
let activeTabID = null;
let fullCachePoll = null;

function normalizeGitLabOrigin(value) {
  const candidate = String(value || '').trim();
  if (!candidate) throw new Error('Enter your self-hosted GitLab URL.');
  if (/\*|%2a/i.test(candidate)) throw new Error('Enter one exact GitLab origin, without wildcards.');
  let url;
  try {
    url = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS GitLab URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('Enter a valid HTTP or HTTPS GitLab URL without credentials.');
  }
  return url.origin;
}

function selfHostedPatterns(origins = []) {
  const patterns = new Set();
  for (const value of origins) {
    const candidate = String(value).replace(/\/\*$/, '');
    if (/\*|%2a/i.test(candidate)) continue;
    try {
      const url = new URL(candidate);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) continue;
      if (url.origin !== 'https://gitlab.com') patterns.add(`${url.origin}/*`);
    } catch {
      // Ignore named permissions and malformed legacy values.
    }
  }
  return [...patterns].sort();
}

async function syncHostAccess() {
  const response = await chrome.runtime.sendMessage({ type: 'golens-sync-host-access' });
  if (!response?.ok) throw new Error(response?.error || 'Unable to update GitLab host access.');
}

async function refreshHostAccess() {
  const list = document.querySelector('[data-host-list]');
  const granted = await chrome.permissions.getAll();
  const patterns = selfHostedPatterns(granted.origins);
  list.replaceChildren();
  if (!patterns.length) {
    const empty = document.createElement('p');
    empty.className = 'host-empty';
    empty.textContent = 'No self-hosted origins allowed.';
    list.append(empty);
    return;
  }
  patterns.forEach((pattern) => {
    const origin = new URL(pattern).origin;
    const row = document.createElement('div');
    const label = document.createElement('code');
    label.textContent = origin;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove access to ${origin}`);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      const status = document.querySelector('[data-host-status]');
      try {
        await chrome.permissions.remove({ origins: [pattern] });
        await syncHostAccess();
        status.textContent = `Removed ${origin}. Refresh open tabs to unload GoLens.`;
        await refreshHostAccess();
      } catch (error) {
        status.textContent = error.message || 'Unable to remove this origin.';
        remove.disabled = false;
      }
    });
    row.append(label, remove);
    list.append(row);
  });
}

function wireHostAccess() {
  const form = document.querySelector('[data-host-form]');
  const input = form.elements.origin;
  const status = document.querySelector('[data-host-status]');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    status.textContent = '';
    try {
      const origin = normalizeGitLabOrigin(input.value);
      if (origin === 'https://gitlab.com') {
        status.textContent = 'GitLab.com access is already included.';
        return;
      }
      const pattern = `${origin}/*`;
      const granted = await chrome.permissions.request({ origins: [pattern] });
      if (!granted) {
        status.textContent = `Access to ${origin} was not granted.`;
        return;
      }
      await syncHostAccess();
      input.value = '';
      status.textContent = `Allowed ${origin}. Refresh that GitLab tab to start GoLens.`;
      await refreshHostAccess();
    } catch (error) {
      status.textContent = error.message || 'Unable to add this GitLab origin.';
    } finally {
      button.disabled = false;
    }
  });
}

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
  const panel = document.querySelector('[data-cache-panel]');
  const button = document.querySelector('[data-action="cache-full-project"]');
  const status = document.querySelector('[data-full-cache-status]');
  const progress = document.querySelector('[data-full-cache-progress]');
  const busy = state.status === 'busy';
  const complete = state.status === 'complete';
  const unavailable = state.status === 'unavailable';
  panel.dataset.state = state.status || 'idle';
  button.disabled = busy || complete || unavailable;
  button.dataset.state = state.status || 'idle';
  button.toggleAttribute('aria-busy', busy);
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
  const panel = document.querySelector('[data-cache-panel]');
  const button = document.querySelector('[data-action="clear-cache"]');
  const status = document.querySelector('[data-cache-status]');
  button.addEventListener('click', async () => {
    if (!confirm('Clear all cached GitLab source snapshots?')) return;
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    panel.dataset.clearState = 'busy';
    status.textContent = 'Clearing cache…';
    try {
      const cleared = await cacheRequest('golens-clear-cache');
      status.textContent = `Cleared ${formatBytes(cleared.bytes)} of cached source.`;
      panel.dataset.clearState = 'success';
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
      panel.dataset.clearState = 'error';
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
    }
  });
}

function wireOnboardingControl() {
  const guide = document.querySelector('.guide');
  const button = document.querySelector('[data-action="show-onboarding"]');
  const status = document.querySelector('[data-onboarding-status]');
  button.addEventListener('click', async () => {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    guide.dataset.state = 'busy';
    status.textContent = '';
    try {
      await activeTabRequest('golens-show-onboarding');
      status.textContent = 'Quick tour opened in this tab.';
      guide.dataset.state = 'success';
    } catch (error) {
      status.textContent = error.message || 'Open a GitLab merge request first.';
      guide.dataset.state = 'error';
    } finally {
      button.disabled = false;
      button.removeAttribute('aria-busy');
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
      if (key !== 'enabled') return;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'golens-enabled', enabled: input.checked }).catch(() => undefined);
    });
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    for (const [key, change] of Object.entries(changes)) {
      const input = document.querySelector(`[data-setting="${key}"]`);
      if (input && typeof change.newValue === 'boolean') input.checked = change.newValue;
    }
  });
  wireCacheControls();
  wireHostAccess();
  wireOnboardingControl();
  wireFullProjectControl();
  await refreshHostAccess();
  await refreshFullProjectState();
  await refreshCacheSize();
}

initialise();
