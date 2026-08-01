import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';

import { startSettingsEntry } from '../../src/settings.ts';

test('settings entry saves preferences and renders the complete feature catalog', async () => {
  const window = new Window();
  window.document.body.innerHTML = '<input data-setting="hideGeneratedFiles" type="checkbox"><section data-feature-guide></section><button data-action="clear-cache"></button><button data-action="show-onboarding"></button><p data-cache-status></p>';
  const updates = [];
  const requests = [];
  await startSettingsEntry({
    document: window.document,
    preferences: { get: async () => ({ enabled: true, hideGeneratedFiles: false, shortcutCoachEnabled: true, shortcutBindings: {} }), set: async (value) => updates.push(value), subscribe: () => () => {} },
    request: async (type) => { requests.push(type); return type === 'golens:rewrite:state' ? { cache: { bytes: 0 } } : { cache: { bytes: 0 } }; },
    access: { list: async () => [], add: async () => {}, remove: async () => {} },
  });

  const generated = window.document.querySelector('[data-setting="hideGeneratedFiles"]');
  generated.checked = true;
  generated.dispatchEvent(new window.Event('change'));
  window.document.querySelector('[data-action="clear-cache"]').click();
  window.document.querySelector('[data-action="show-onboarding"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(updates, [{ hideGeneratedFiles: true }]);
  assert.ok(window.document.querySelector('[data-feature-guide]').textContent.includes('Keep repository source local'));
  assert.ok(requests.includes('golens:rewrite:clear-cache'));
  assert.ok(requests.includes('golens:rewrite:show-guide'));
});
