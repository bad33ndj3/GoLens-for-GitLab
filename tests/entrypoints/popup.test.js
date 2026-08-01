import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';

import { startPopupEntry } from '../../src/popup.ts';

test('popup entry exposes enablement, cache state, and settings intentions', async () => {
  const window = new Window();
  window.document.body.innerHTML = '<input data-setting="enabled" type="checkbox"><button data-action="show-settings"></button><button data-action="cache-full-project"></button><output data-cache-size></output><p data-full-cache-status></p>';
  const updates = [];
  const intentions = [];
  await startPopupEntry({
    document: window.document,
    preferences: { get: async () => ({ enabled: true }), set: async (value) => updates.push(value), subscribe: () => () => {} },
    request: async (type) => {
      intentions.push(type);
      return type === 'golens:rewrite:state' ? { active: true, cache: { bytes: 1536 }, fullProject: false } : {};
    },
    ensureStorage: async () => {},
    close: () => {},
  });

  const enabled = window.document.querySelector('[data-setting="enabled"]');
  assert.equal(enabled.checked, true);
  enabled.checked = false;
  enabled.dispatchEvent(new window.Event('change'));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(updates, [{ enabled: false }]);
  assert.equal(window.document.querySelector('[data-cache-size]').textContent, '1.5 KB');
  window.document.querySelector('[data-action="cache-full-project"]').click();
  window.document.querySelector('[data-action="show-settings"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(intentions.includes('golens:rewrite:cache-full-project'));
  assert.ok(intentions.includes('golens:rewrite:open-settings'));
});
