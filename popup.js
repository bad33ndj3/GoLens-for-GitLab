import { createFullProjectCacheController } from './extension-cache-ui.js';

const defaults = { enabled: true };
const cacheUI = createFullProjectCacheController({
  panel: document.querySelector('[data-cache-panel]'),
  button: document.querySelector('[data-action="cache-full-project"]'),
  status: document.querySelector('[data-full-cache-status]'),
  progress: document.querySelector('[data-full-cache-progress]'),
  sizeOutput: document.querySelector('[data-cache-size]'),
  context: document.querySelector('[data-page-context]'),
  idleMessage: 'Full-project results are not cached yet.',
  completeMessage: 'Full-project results are ready.',
});

function wireSettingsControl() {
  const button = document.querySelector('[data-action="show-settings"]');
  const status = document.querySelector('[data-settings-status]');
  button.addEventListener('click', async () => {
    button.disabled = true;
    status.textContent = '';
    try {
      await cacheUI.activeTabRequest('golens-show-settings');
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
  cacheUI.wireFullProjectControl();
  await Promise.all([cacheUI.refreshFullProjectState(), cacheUI.refreshCacheSize()]);
}

initialise();
