import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';

test('renders a compact, dismissible shortcut tip and can disable future tips', async () => {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.location = window.location;
  globalThis.innerWidth = 1280;
  globalThis.innerHeight = 800;
  globalThis.matchMedia = () => ({ matches: false });
  let coachEnabled = true;
  globalThis.GoLensShortcutCoach = {
    async setEnabled(enabled) { coachEnabled = enabled; return true; },
  };

  await import('../go-navigation.js?shortcut-coach-ui-test');
  // Ticket 17: showShortcutCoachHint() no longer looks up the message from
  // an actionID itself (that decision moved to
  // page/features/keyboard-nav.js) — it renders whatever message it is
  // handed, which is now this test's job to supply.
  const helpers = globalThis.GoLensGoNavigation.__test;
  assert.equal(helpers.showShortcutCoachHint({ actionID: 'semanticJump', message: 'Open the selected symbol directly from the keyboard.', displayBinding: 'Ctrl+F12' }), true);

  const shadow = window.document.getElementById('golens-go-intelligence-root').shadowRoot;
  const tip = shadow.querySelector('.toast');
  assert.equal(tip.dataset.kind, 'shortcut');
  assert.match(tip.querySelector('.toast-message').textContent, /selected symbol directly/);
  assert.equal(tip.querySelector('.toast-binding').textContent, 'Ctrl+F12');
  assert.equal(tip.classList.contains('show'), true);

  shadow.querySelector('[data-action="shortcut-tip-dismiss"]').click();
  assert.equal(tip.classList.contains('show'), false);

  assert.equal(helpers.showShortcutCoachHint({ actionID: 'focusFileSearch', message: "Focus GitLab's file search without reaching for the mouse.", displayBinding: 'Ctrl+P' }), true);
  shadow.querySelector('[data-action="shortcut-tip-disable"]').click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(coachEnabled, false);
  assert.match(tip.querySelector('.toast-message').textContent, /re-enable them in settings/);
});
