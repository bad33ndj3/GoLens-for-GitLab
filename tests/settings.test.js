import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Window } from 'happy-dom';

test('tabbed settings manage preferences, shortcuts, host access, cache, and help', async () => {
  const window = new Window({ url: 'chrome-extension://golens/settings.html' });
  window.document.write(await readFile(new URL('../settings.html', import.meta.url), 'utf8'));
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.confirm = () => true;

  let fullStatus = { status: 'idle', message: 'Not cached', progress: null };
  let storageListener;
  const savedSettings = [];
  const tabMessages = [];
  let allowedOrigins = ['http://*/*', 'https://*/*', 'https://gitlab.com/*'];
  const requestedOrigins = [];
  globalThis.chrome = {
    storage: {
      sync: {
        async get(defaults) { return { ...defaults, hideGeneratedFiles: true }; },
        async set(value) { savedSettings.push(value); },
      },
      onChanged: { addListener(listener) { storageListener = listener; } },
    },
    runtime: {
      async sendMessage({ type }) {
        if (type === 'golens-cache-stats') return { ok: true, result: { sources: 1, packages: 1, projects: 0, bytes: 12 } };
        if (type === 'golens-clear-cache') return { ok: true, result: { sources: 1, packages: 1, projects: 0, bytes: 12 } };
        if (type === 'golens-sync-host-access') return { ok: true, result: { origins: [] } };
        return { ok: false, error: 'Unexpected request' };
      },
    },
    permissions: {
      async getAll() { return { origins: [...allowedOrigins] }; },
      async request({ origins }) {
        requestedOrigins.push(...origins);
        allowedOrigins = [...new Set([...allowedOrigins, ...origins])];
        return true;
      },
      async remove({ origins }) {
        allowedOrigins = allowedOrigins.filter((origin) => !origins.includes(origin));
        return true;
      },
    },
    tabs: {
      async query() { return [{ id: 7 }]; },
      async sendMessage(_tabID, message) {
        tabMessages.push(message.type);
        if (message.type === 'golens-preload-full-project') {
          fullStatus = { status: 'busy', message: '1 cached, 1 remaining, 45%', progress: { phase: 'fetching', percentage: 45 } };
        } else if (message.type === 'golens-full-project-status' && fullStatus.status === 'busy') {
          fullStatus = { status: 'complete', message: 'Full project cached', progress: { phase: 'ready', percentage: 100 } };
        }
        return { ok: true, result: fullStatus };
      },
    },
  };

  await import('../shortcut-settings.js?settings-test');
  await import('../settings.js?settings-test');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const tabs = [...window.document.querySelectorAll('[role="tab"]')];
  assert.deepEqual(tabs.map((tab) => tab.textContent.trim()), ['General', 'Shortcuts', 'GitLab access', 'Cache', 'Help']);
  assert.equal(window.document.querySelector('[data-settings-panel="general"]').hidden, false);
  assert.ok(window.document.querySelector('[data-setting="hideGeneratedFiles"]').checked);
  assert.ok(tabMessages.includes('golens-settings-ready'));

  tabs[1].click();
  assert.equal(window.document.querySelector('[data-page-title]').textContent, 'Keyboard shortcuts');
  assert.equal(window.document.querySelectorAll('[data-shortcut-binding]').length, 11);
  const presetSelect = window.document.querySelector('[data-shortcut-preset]');
  assert.deepEqual([...presetSelect.options].map((option) => option.value), ['', 'golens', 'vscode', 'intellij', 'vim']);
  assert.equal(presetSelect.value, 'golens');
  const focusBinding = window.document.querySelector('[data-shortcut-binding="focusFileSearch"]');
  focusBinding.click();
  const primaryModifier = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || '') ? { metaKey: true } : { ctrlKey: true };
  window.document.dispatchEvent(new window.KeyboardEvent('keydown', { code: 'ArrowDown', key: 'ArrowDown', altKey: true, ...primaryModifier, bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(savedSettings.at(-1).shortcutBindings.focusFileSearch, 'Primary+Alt+ArrowDown');
  assert.equal(savedSettings.at(-1).shortcutBindings.nextOccurrence, '');
  assert.equal(presetSelect.value, '');

  presetSelect.value = 'vim';
  presetSelect.dispatchEvent(new window.Event('change'));
  window.document.querySelector('[data-action="apply-shortcut-preset"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(savedSettings.at(-1).shortcutBindings.semanticJump, 'Ctrl+BracketRight');
  assert.equal(savedSettings.at(-1).shortcutBindings.nextOccurrence, 'KeyN');
  assert.equal(presetSelect.value, 'vim');
  assert.match(window.document.querySelector('[data-shortcut-status]').textContent, /Vim-style shortcuts applied/);

  tabs[2].click();
  const hostForm = window.document.querySelector('[data-host-form]');
  hostForm.elements.origin.value = 'https://gitlab.internal/group/project';
  hostForm.dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requestedOrigins, ['https://gitlab.internal/*']);
  assert.match(window.document.querySelector('[data-host-list]').textContent, /https:\/\/gitlab\.internal/);
  window.document.querySelector('[data-host-list] button').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(window.document.querySelector('[data-host-list]').textContent, /No self-hosted origins allowed/);

  tabs[3].click();
  const cacheButton = window.document.querySelector('[data-action="cache-full-project"]');
  cacheButton.click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(cacheButton.textContent, 'Full project cached');
  window.document.querySelector('[data-action="clear-cache"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.match(window.document.querySelector('[data-cache-status]').textContent, /^Cleared /);

  tabs[4].click();
  window.document.querySelector('[data-action="show-onboarding"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(tabMessages.includes('golens-show-onboarding'));

  window.document.querySelector('[data-action="close-settings"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(tabMessages.includes('golens-close-settings'));

  storageListener({ hideGeneratedFiles: { oldValue: true, newValue: false } }, 'sync');
  assert.equal(window.document.querySelector('[data-setting="hideGeneratedFiles"]').checked, false);
});
