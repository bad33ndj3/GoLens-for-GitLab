import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Window } from 'happy-dom';

test('compact popup controls enablement, project caching, and the settings overlay', async () => {
  const window = new Window({ url: 'chrome-extension://golens/popup.html' });
  window.document.write(await readFile(new URL('../popup.html', import.meta.url), 'utf8'));
  globalThis.window = window;
  globalThis.document = window.document;

  let popupClosed = false;
  window.close = () => { popupClosed = true; };
  let fullStatus = { status: 'idle', message: 'Not cached', progress: null };
  let storageListener;
  const savedSettings = [];
  const tabMessages = [];
  globalThis.chrome = {
    storage: {
      sync: {
        async get(defaults) { return { ...defaults, enabled: true }; },
        async set(value) { savedSettings.push(value); },
      },
      onChanged: { addListener(listener) { storageListener = listener; } },
    },
    runtime: {
      async sendMessage({ type }) {
        if (type === 'golens-cache-stats') return { ok: true, result: { sources: 2, packages: 1, projects: 0, bytes: 1280 } };
        return { ok: false, error: 'Unexpected request' };
      },
    },
    tabs: {
      async query() { return [{ id: 7 }]; },
      async sendMessage(_tabID, message) {
        tabMessages.push(message.type);
        if (message.type === 'golens-show-settings') return { ok: true, result: { shown: true } };
        if (message.type === 'golens-preload-full-project') {
          fullStatus = { status: 'busy', message: '1 cached, 1 remaining, 45%', progress: { phase: 'fetching', percentage: 45 } };
        } else if (message.type === 'golens-full-project-status' && fullStatus.status === 'busy') {
          fullStatus = { status: 'complete', message: 'Full project cached', progress: { phase: 'ready', percentage: 100 } };
        }
        return { ok: true, result: fullStatus };
      },
    },
  };

  await import('../popup.js?compact-popup-test');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(window.document.body.clientWidth >= 0, true);
  assert.match(window.document.querySelector('.identity img').src, /assets\/icons\/golens-32\.png$/);
  assert.ok(window.document.querySelector('[data-setting="enabled"]').checked);
  assert.equal(window.document.querySelector('[data-action="show-settings"]').getAttribute('aria-label'), 'Open GoLens settings');
  assert.equal(window.document.querySelector('[data-cache-size]').textContent, '1.3 KB');
  assert.equal(window.document.querySelector('[data-full-cache-status]').textContent, 'Not cached');
  assert.equal(window.document.querySelector('[data-shortcut-list]'), null, 'the compact popup does not render settings forms');

  const enabled = window.document.querySelector('[data-setting="enabled"]');
  enabled.checked = false;
  enabled.dispatchEvent(new window.Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(savedSettings.at(-1), { enabled: false });
  assert.ok(tabMessages.includes('golens-enabled'));
  storageListener({ enabled: { oldValue: false, newValue: true } }, 'sync');
  assert.ok(enabled.checked);

  const cacheButton = window.document.querySelector('[data-action="cache-full-project"]');
  cacheButton.click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(cacheButton.textContent, 'Full project cached');
  assert.ok(tabMessages.includes('golens-preload-full-project'));

  window.document.querySelector('[data-action="show-settings"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(tabMessages.includes('golens-show-settings'));
  assert.equal(popupClosed, true);
});
