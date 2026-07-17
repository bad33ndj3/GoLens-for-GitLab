import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { Window } from 'happy-dom';

test('popup starts full-project caching in the active MR tab and restores completion', async () => {
  const window = new Window({ url: 'chrome-extension://golens/popup.html' });
  const html = await readFile(new URL('../popup.html', import.meta.url), 'utf8');
  window.document.write(html);
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.confirm = () => true;
  assert.equal(window.document.title, 'GoLens for GitLab');
  assert.equal(window.document.querySelector('.plugin-switch span').textContent, 'GoLens for GitLab');
  assert.equal(window.document.querySelector('link[href="golens-theme.css"]').rel, 'stylesheet');
  assert.match(window.document.querySelector('.identity img').src, /assets\/icons\/golens-32\.png$/);
  assert.equal(window.document.querySelector('[data-cache-panel]').dataset.state, 'idle');
  assert.ok(window.document.querySelector('[data-action="clear-cache"]').classList.contains('destructive-action'));

  let fullStatus = { status: 'idle', message: 'Not cached', progress: null };
  let requestedDefaults;
  let storageListener;
  const savedSettings = [];
  const tabMessages = [];
  globalThis.chrome = {
    storage: {
      sync: {
        async get(defaults) {
          requestedDefaults = defaults;
          return { ...defaults, hideGeneratedFiles: true };
        },
        async set(value) { savedSettings.push(value); },
      },
      onChanged: { addListener(listener) { storageListener = listener; } },
    },
    runtime: {
      async sendMessage({ type }) {
        if (type === 'golens-cache-stats') return { ok: true, result: { sources: 1, packages: 1, projects: 0, bytes: 12 } };
        return { ok: true, result: { sources: 0, packages: 0, projects: 0, bytes: 0 } };
      },
    },
    tabs: {
      async query() { return [{ id: 7 }]; },
      async sendMessage(_tabID, message) {
        tabMessages.push(message.type);
        if (message.type === 'golens-preload-full-project') {
          fullStatus = { status: 'busy', message: '1 cached · 1 remaining · 45%', progress: { phase: 'fetching', percentage: 45 } };
        } else if (message.type === 'golens-full-project-status' && fullStatus.status === 'busy') {
          fullStatus = { status: 'complete', message: 'Full project cached', progress: { phase: 'ready', percentage: 100 } };
        }
        return { ok: true, result: fullStatus };
      },
    },
  };

  await import('../popup.js?popup-test');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(requestedDefaults, { enabled: true, hideGeneratedFiles: false });
  const generatedFilesSetting = window.document.querySelector('[data-setting="hideGeneratedFiles"]');
  assert.ok(generatedFilesSetting.checked);
  assert.match(window.document.querySelector('.preferences').textContent, /\.gitattributes/);
  assert.match(window.document.querySelector('.preferences').textContent, /large collapsed files remain visible/);

  generatedFilesSetting.checked = false;
  generatedFilesSetting.dispatchEvent(new window.Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(savedSettings.at(-1), { hideGeneratedFiles: false });
  assert.equal(tabMessages.includes('golens-enabled'), false);

  storageListener({ hideGeneratedFiles: { oldValue: false, newValue: true } }, 'sync');
  assert.ok(generatedFilesSetting.checked);

  const button = window.document.querySelector('[data-action="cache-full-project"]');
  assert.equal(button.disabled, false);
  assert.equal(button.dataset.state, 'idle');
  assert.equal(window.document.querySelector('[data-full-cache-status]').textContent, 'Not cached');

  button.click();
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(button.textContent, 'Full project cached');
  assert.equal(button.disabled, true);
  assert.equal(button.dataset.state, 'complete');
  assert.equal(window.document.querySelector('[data-cache-panel]').dataset.state, 'complete');
  assert.equal(button.hasAttribute('aria-busy'), false);
  assert.ok(tabMessages.includes('golens-preload-full-project'));
  assert.ok(tabMessages.filter((type) => type === 'golens-full-project-status').length >= 2);

  const clearButton = window.document.querySelector('[data-action="clear-cache"]');
  clearButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(window.document.querySelector('[data-cache-panel]').dataset.clearState, 'success');
  assert.match(window.document.querySelector('[data-cache-status]').textContent, /^Cleared /);
  assert.equal(clearButton.hasAttribute('aria-busy'), false);

  window.document.querySelector('[data-action="show-onboarding"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(tabMessages.includes('golens-show-onboarding'));
  assert.equal(window.document.querySelector('[data-onboarding-status]').textContent, 'Quick tour opened in this tab.');
  assert.equal(window.document.querySelector('.guide').dataset.state, 'success');
});
