const defaults = { enabled: true, hideGeneratedFiles: false, shortcutCoachEnabled: true, shortcutBindings: globalThis.GoLensShortcuts.defaultBindings() };
const pageMeta = {
  general: ['General', 'Choose how GoLens behaves across GitLab reviews.'],
  shortcuts: ['Keyboard shortcuts', 'Move through large diffs without leaving the keyboard.'],
  access: ['GitLab access', 'Control which self-hosted GitLab origins can run GoLens.'],
  cache: ['Source cache', 'Inspect and manage commit-pinned source stored in this browser.'],
  help: ['Help', 'Open the complete feature guide whenever you need a refresher.'],
};
let activeTabID = null;
let fullCachePoll = null;
let shortcutBindings = globalThis.GoLensShortcuts.defaultBindings();
let recordingShortcut = '';

function shortcutAction(actionID) {
  return globalThis.GoLensShortcuts.actions.find(({ id }) => id === actionID);
}

function showSettingsPage(pageID, { focusTab = false } = {}) {
  const tabs = [...document.querySelectorAll('[data-settings-tab]')];
  const requested = tabs.find((tab) => tab.dataset.settingsTab === pageID) || tabs[0];
  tabs.forEach((tab) => {
    const active = tab === requested;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  });
  document.querySelectorAll('[data-settings-panel]').forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== requested.dataset.settingsTab; });
  const [title, description] = pageMeta[requested.dataset.settingsTab];
  document.querySelector('[data-page-title]').textContent = title;
  document.querySelector('[data-page-description]').textContent = description;
  if (focusTab) requested.focus();
}

function wireSettingsTabs() {
  const tabs = [...document.querySelectorAll('[data-settings-tab]')];
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => showSettingsPage(tab.dataset.settingsTab));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const nextIndex = event.key === 'Home'
        ? 0
        : event.key === 'End'
        ? tabs.length - 1
        : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
      showSettingsPage(tabs[nextIndex].dataset.settingsTab, { focusTab: true });
    });
  });
}

function renderShortcutBindings() {
  for (const button of document.querySelectorAll('[data-shortcut-binding]')) {
    const actionID = button.dataset.shortcutBinding;
    button.textContent = recordingShortcut === actionID ? 'Press keys…' : globalThis.GoLensShortcuts.displayBinding(shortcutBindings[actionID]);
    button.dataset.recording = String(recordingShortcut === actionID);
    button.setAttribute('aria-pressed', String(recordingShortcut === actionID));
    button.closest('.shortcut-row').querySelector('.shortcut-clear').disabled = !shortcutBindings[actionID];
  }
  const preset = document.querySelector('[data-shortcut-preset]');
  if (preset && !recordingShortcut) {
    preset.value = globalThis.GoLensShortcuts.presetForBindings(shortcutBindings);
    document.querySelector('[data-action="apply-shortcut-preset"]').disabled = !preset.value;
  }
}

async function applyShortcutPreset(presetID) {
  const bindings = globalThis.GoLensShortcuts.presetBindings(presetID);
  if (!bindings) return false;
  recordingShortcut = '';
  shortcutBindings = bindings;
  await chrome.storage.sync.set({ shortcutBindings });
  const preset = globalThis.GoLensShortcuts.presets.find(({ id }) => id === presetID);
  document.querySelector('[data-shortcut-status]').textContent = `${preset.label} shortcuts applied. You can customize individual actions below.`;
  renderShortcutBindings();
  return true;
}

async function saveShortcut(actionID, binding) {
  const result = globalThis.GoLensShortcuts.assignBinding(shortcutBindings, actionID, binding);
  shortcutBindings = result.bindings;
  await chrome.storage.sync.set({ shortcutBindings });
  const status = document.querySelector('[data-shortcut-status]');
  const action = shortcutAction(actionID);
  status.textContent = result.displaced
    ? `${action.label} updated; ${shortcutAction(result.displaced).label} is now unassigned.`
    : binding ? `${action.label} updated.` : `${action.label} is now unassigned.`;
  renderShortcutBindings();
}

function wireShortcutControls() {
  const list = document.querySelector('[data-shortcut-list]');
  const presetSelect = document.querySelector('[data-shortcut-preset]');
  const customOption = document.createElement('option');
  customOption.value = '';
  customOption.textContent = 'Custom';
  presetSelect.append(customOption);
  for (const preset of globalThis.GoLensShortcuts.presets) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = `${preset.label} - ${preset.description}`;
    presetSelect.append(option);
  }
  presetSelect.addEventListener('change', () => {
    document.querySelector('[data-action="apply-shortcut-preset"]').disabled = !presetSelect.value;
  });
  for (const action of globalThis.GoLensShortcuts.actions) {
    const row = document.createElement('div');
    row.className = 'shortcut-row';
    row.innerHTML = `<span>${action.label}</span><button class="shortcut-binding" type="button" data-shortcut-binding="${action.id}" aria-pressed="false"></button><button class="shortcut-clear" type="button" aria-label="Clear ${action.label}" title="Clear shortcut">×</button>`;
    row.querySelector('.shortcut-binding').addEventListener('click', () => {
      recordingShortcut = recordingShortcut === action.id ? '' : action.id;
      document.querySelector('[data-shortcut-status]').textContent = recordingShortcut ? 'Press a shortcut. Escape cancels; Backspace clears.' : '';
      renderShortcutBindings();
    });
    row.querySelector('.shortcut-clear').addEventListener('click', () => saveShortcut(action.id, ''));
    list.append(row);
  }
  document.querySelector('[data-action="apply-shortcut-preset"]').addEventListener('click', () => applyShortcutPreset(presetSelect.value));
  document.querySelector('[data-action="reset-shortcuts"]').addEventListener('click', async () => {
    recordingShortcut = '';
    shortcutBindings = globalThis.GoLensShortcuts.defaultBindings();
    await chrome.storage.sync.set({ shortcutBindings });
    document.querySelector('[data-shortcut-status]').textContent = 'GoLens defaults restored.';
    renderShortcutBindings();
  });
  renderShortcutBindings();
}

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
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) throw new Error('Enter a valid HTTP or HTTPS GitLab URL without credentials.');
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

function wireCacheControls() {
  const fullButton = document.querySelector('[data-action="cache-full-project"]');
  fullButton.addEventListener('click', async () => {
    fullButton.disabled = true;
    try {
      renderFullProjectState(await activeTabRequest('golens-preload-full-project'));
    } catch (error) {
      renderFullProjectState({ status: 'error', message: error.message || 'Unable to start full project cache.', progress: null });
    }
  });
  const panel = document.querySelector('[data-cache-panel]');
  const clearButton = document.querySelector('[data-action="clear-cache"]');
  const status = document.querySelector('[data-cache-status]');
  clearButton.addEventListener('click', async () => {
    if (!confirm('Clear all cached GitLab source snapshots?')) return;
    clearButton.disabled = true;
    panel.dataset.clearState = 'busy';
    status.textContent = 'Clearing cache…';
    try {
      const cleared = await cacheRequest('golens-clear-cache');
      status.textContent = `Cleared ${formatBytes(cleared.bytes)} of cached source.`;
      panel.dataset.clearState = 'success';
      try { await activeTabRequest('golens-cache-invalidated'); } catch { /* The cache is still cleared. */ }
      await Promise.all([refreshCacheSize(), refreshFullProjectState()]);
    } catch (error) {
      status.textContent = error.message || 'Unable to clear cache.';
      panel.dataset.clearState = 'error';
    } finally {
      clearButton.disabled = false;
    }
  });
}

function wireOverlayControls() {
  document.querySelector('[data-action="close-settings"]').addEventListener('click', () => activeTabRequest('golens-close-settings').catch(() => window.close()));
  document.querySelector('[data-action="show-onboarding"]').addEventListener('click', async () => {
    const status = document.querySelector('[data-onboarding-status]');
    try {
      await activeTabRequest('golens-show-onboarding');
    } catch (error) {
      status.textContent = error.message || 'Open a GitLab merge request first.';
    }
  });
  document.addEventListener('keydown', (event) => {
    if (recordingShortcut) {
      event.preventDefault();
      event.stopPropagation();
      if (event.code === 'Escape') {
        recordingShortcut = '';
        document.querySelector('[data-shortcut-status]').textContent = 'Recording cancelled.';
        renderShortcutBindings();
        return;
      }
      if (['Backspace', 'Delete'].includes(event.code)) {
        const actionID = recordingShortcut;
        recordingShortcut = '';
        saveShortcut(actionID, '');
        return;
      }
      const binding = globalThis.GoLensShortcuts.bindingForEvent(event);
      if (!binding) return;
      const actionID = recordingShortcut;
      recordingShortcut = '';
      saveShortcut(actionID, binding);
      return;
    }
    if (event.key === 'Escape') {
      activeTabRequest('golens-close-settings').catch(() => window.close());
      return;
    }
    if (event.key !== 'Tab') return;
    const focusable = [...document.querySelectorAll('button:not(:disabled),input:not(:disabled)')]
      .filter((element) => !element.closest('[hidden]'));
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, true);
}

async function initialise() {
  const settings = await chrome.storage.sync.get(defaults);
  shortcutBindings = globalThis.GoLensShortcuts.mergeBindings(settings.shortcutBindings);
  document.querySelectorAll('[data-setting]').forEach((input) => {
    const key = input.dataset.setting;
    input.checked = settings[key];
    input.addEventListener('change', async () => {
      await chrome.storage.sync.set({ [key]: input.checked });
      if (key !== 'enabled') return;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) chrome.tabs.sendMessage(tab.id, { type: 'golens-enabled', enabled: input.checked }).catch(() => undefined);
    });
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'sync') return;
    if (changes.shortcutBindings) {
      shortcutBindings = globalThis.GoLensShortcuts.mergeBindings(changes.shortcutBindings.newValue);
      renderShortcutBindings();
    }
    for (const [key, change] of Object.entries(changes)) {
      const input = document.querySelector(`[data-setting="${key}"]`);
      if (input && typeof change.newValue === 'boolean') input.checked = change.newValue;
    }
  });
  wireSettingsTabs();
  showSettingsPage(document.querySelector('[role="tab"][aria-selected="true"]')?.dataset.settingsTab);
  wireShortcutControls();
  wireHostAccess();
  wireCacheControls();
  wireOverlayControls();
  await Promise.all([refreshHostAccess(), refreshFullProjectState(), refreshCacheSize()]);
  document.querySelector('[role="tab"][aria-selected="true"]')?.focus();
  activeTabRequest('golens-settings-ready').catch(() => undefined);
}

initialise();
