import assert from 'node:assert/strict';
import { test } from 'node:test';

await import('../shortcut-settings.js?shortcut-settings-test');
const shortcuts = globalThis.GoLensShortcuts;

test('normalizes, displays, and matches portable shortcut bindings', () => {
  assert.equal(shortcuts.normalizeBinding('Shift+Alt+BracketRight'), 'Alt+Shift+BracketRight');
  assert.equal(shortcuts.normalizeBinding('Nope+KeyQ'), null);
  assert.equal(shortcuts.mergeBindings({ nextOccurrence: '', unknown: 'KeyX' }).nextOccurrence, '');
  const event = { code: 'BracketRight', altKey: true, shiftKey: false, ctrlKey: false, metaKey: false, repeat: false, isComposing: false };
  assert.equal(shortcuts.matchesEvent('Alt+BracketRight', event), true);
  assert.match(shortcuts.displayBinding('Alt+BracketRight'), /\]/);
  assert.deepEqual(shortcuts.defaultBindings(), {
    focusFileSearch: 'Primary+KeyP',
    clearFileSearch: 'Shift+KeyF',
    semanticJump: 'Primary+F12',
    previousOccurrence: 'Primary+Alt+ArrowUp',
    nextOccurrence: 'Primary+Alt+ArrowDown',
    previousHunk: 'Alt+Shift+F5',
    nextHunk: 'Alt+F5',
    previousFile: 'Alt+PageUp',
    nextFile: 'Alt+PageDown',
    historyBack: 'Ctrl+Minus',
    historyForward: 'Ctrl+Shift+Minus',
  });
});

test('moving a duplicate binding unassigns its previous GoLens action', () => {
  const defaults = shortcuts.defaultBindings();
  const result = shortcuts.assignBinding(defaults, 'focusFileSearch', defaults.nextOccurrence);
  assert.equal(result.bindings.focusFileSearch, defaults.nextOccurrence);
  assert.equal(result.bindings.nextOccurrence, '');
  assert.equal(result.displaced, 'nextOccurrence');
});

test('provides editable GoLens, VS Code, IntelliJ, and Vim-style presets', () => {
  assert.deepEqual(shortcuts.presets.map(({ id }) => id), ['golens', 'vscode', 'intellij', 'vim']);
  assert.equal(shortcuts.presetBindings('vscode').semanticJump, 'Primary+F12');
  assert.equal(shortcuts.presetBindings('intellij').semanticJump, 'Ctrl+KeyB');
  assert.equal(shortcuts.presetBindings('vim').semanticJump, 'Ctrl+BracketRight');
  assert.equal(shortcuts.presetBindings('vim').nextOccurrence, 'KeyN');
  assert.equal(shortcuts.presetBindings('missing'), null);
  assert.equal(shortcuts.presetForBindings(shortcuts.presetBindings('intellij')), 'intellij');
  assert.equal(shortcuts.presetForBindings({ ...shortcuts.defaultBindings(), nextFile: '' }), '');
  for (const preset of shortcuts.presets) {
    const assigned = Object.values(shortcuts.presetBindings(preset.id)).filter(Boolean);
    assert.equal(new Set(assigned).size, assigned.length, `${preset.id} contains duplicate bindings`);
  }
});
