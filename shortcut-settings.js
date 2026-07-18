(() => {
  const ACTIONS = [
    { id: 'focusFileSearch', label: 'Focus file search', defaultBinding: 'Primary+KeyP' },
    { id: 'clearFileSearch', label: 'Clear file search', defaultBinding: 'Shift+KeyF' },
    { id: 'semanticJump', label: 'Go to definition or implementation', defaultBinding: 'Primary+F12' },
    { id: 'previousOccurrence', label: 'Previous occurrence', defaultBinding: 'Primary+Alt+ArrowUp' },
    { id: 'nextOccurrence', label: 'Next occurrence', defaultBinding: 'Primary+Alt+ArrowDown' },
    { id: 'previousHunk', label: 'Previous hunk', defaultBinding: 'Alt+Shift+F5' },
    { id: 'nextHunk', label: 'Next hunk', defaultBinding: 'Alt+F5' },
    { id: 'previousFile', label: 'Previous file', defaultBinding: 'Alt+PageUp' },
    { id: 'nextFile', label: 'Next file', defaultBinding: 'Alt+PageDown' },
    { id: 'historyBack', label: 'Go back', defaultBinding: 'Ctrl+Minus' },
    { id: 'historyForward', label: 'Go forward', defaultBinding: 'Ctrl+Shift+Minus' },
  ];
  const ACTION_IDS = new Set(ACTIONS.map(({ id }) => id));
  const PRESETS = [
    { id: 'golens', label: 'GoLens', description: 'Browser-safe IDE defaults' },
    { id: 'vscode', label: 'VS Code', description: 'VS Code navigation conventions' },
    { id: 'intellij', label: 'IntelliJ IDEA', description: 'IntelliJ Windows/Linux keymap conventions' },
    { id: 'vim', label: 'Vim-style', description: 'Single-key Vim navigation, without modes' },
  ];
  const PRESET_BINDINGS = {
    vscode: {
      focusFileSearch: 'Primary+KeyP', clearFileSearch: 'Shift+KeyF', semanticJump: 'Primary+F12',
      previousOccurrence: 'Shift+F3', nextOccurrence: 'F3',
      previousHunk: 'Alt+Shift+F5', nextHunk: 'Alt+F5',
      previousFile: 'Ctrl+PageUp', nextFile: 'Ctrl+PageDown',
      historyBack: 'Ctrl+Minus', historyForward: 'Ctrl+Shift+Minus',
    },
    intellij: {
      focusFileSearch: 'Ctrl+Shift+KeyN', clearFileSearch: 'Shift+KeyF', semanticJump: 'Ctrl+KeyB',
      previousOccurrence: 'Shift+F3', nextOccurrence: 'F3',
      previousHunk: 'Ctrl+Alt+Shift+ArrowUp', nextHunk: 'Ctrl+Alt+Shift+ArrowDown',
      previousFile: 'Alt+ArrowLeft', nextFile: 'Alt+ArrowRight',
      historyBack: 'Ctrl+Alt+ArrowLeft', historyForward: 'Ctrl+Alt+ArrowRight',
    },
    vim: {
      focusFileSearch: 'Slash', clearFileSearch: '', semanticJump: 'Ctrl+BracketRight',
      previousOccurrence: 'Shift+KeyN', nextOccurrence: 'KeyN',
      previousHunk: 'BracketLeft', nextHunk: 'BracketRight',
      previousFile: 'Ctrl+KeyP', nextFile: 'Ctrl+KeyN',
      historyBack: 'Ctrl+KeyO', historyForward: 'Ctrl+KeyI',
    },
  };
  const MODIFIER_ORDER = ['Primary', 'Ctrl', 'Alt', 'Shift', 'Meta'];
  const CODE_LABELS = { BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓', Space: 'Space', Escape: 'Esc' };

  function isMac() { return /Mac|iPhone|iPad/.test(globalThis.navigator?.platform || ''); }
  function defaultBindings() { return Object.fromEntries(ACTIONS.map(({ id, defaultBinding }) => [id, defaultBinding])); }
  PRESET_BINDINGS.golens = defaultBindings();

  function presetBindings(presetID) {
    const preset = PRESET_BINDINGS[presetID];
    return preset ? { ...preset } : null;
  }

  function presetForBindings(bindings) {
    const normalized = mergeBindings(bindings);
    return PRESETS.find(({ id }) => {
      const preset = PRESET_BINDINGS[id];
      return ACTIONS.every(({ id: actionID }) => normalized[actionID] === preset[actionID]);
    })?.id || '';
  }

  function normalizeBinding(binding) {
    if (binding === '') return '';
    if (typeof binding !== 'string') return null;
    const parts = binding.split('+').filter(Boolean);
    const code = parts.pop();
    if (!code || !/^(?:Key[A-Z]|Digit\d|F(?:[1-9]|1[0-2])|BracketLeft|BracketRight|Minus|Equal|Comma|Period|Slash|Semicolon|Quote|Backquote|Backslash|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|Space|Enter|Escape|Backspace|Delete|Tab)$/.test(code)) return null;
    const modifiers = [...new Set(parts)];
    if (modifiers.some((part) => !MODIFIER_ORDER.includes(part))) return null;
    modifiers.sort((a, b) => MODIFIER_ORDER.indexOf(a) - MODIFIER_ORDER.indexOf(b));
    return [...modifiers, code].join('+');
  }

  function mergeBindings(value) {
    const merged = defaultBindings();
    if (!value || typeof value !== 'object' || Array.isArray(value)) return merged;
    for (const [id, binding] of Object.entries(value)) {
      if (!ACTION_IDS.has(id)) continue;
      const normalized = normalizeBinding(binding);
      if (normalized !== null) merged[id] = normalized;
    }
    return merged;
  }

  function bindingForEvent(event) {
    if (!event?.code || /^(?:Control|Shift|Alt|Meta)(?:Left|Right)$/.test(event.code)) return '';
    const modifiers = [];
    const primaryDown = isMac() ? event.metaKey : event.ctrlKey;
    if (primaryDown) modifiers.push('Primary');
    if (event.ctrlKey && (isMac() || !primaryDown)) modifiers.push('Ctrl');
    if (event.altKey) modifiers.push('Alt');
    if (event.shiftKey) modifiers.push('Shift');
    if (event.metaKey && (!isMac() || !primaryDown)) modifiers.push('Meta');
    return normalizeBinding([...modifiers, event.code].join('+')) || '';
  }

  function matchesEvent(binding, event) { return Boolean(binding) && !event.repeat && !event.isComposing && bindingForEvent(event) === normalizeBinding(binding); }

  function displayBinding(binding) {
    const normalized = normalizeBinding(binding);
    if (!normalized) return 'Unassigned';
    const parts = normalized.split('+');
    const code = parts.pop();
    const labels = parts.map((part) => part === 'Primary' ? (isMac() ? '⌘' : 'Ctrl') : part === 'Meta' ? (isMac() ? '⌘' : 'Meta') : part === 'Alt' ? (isMac() ? '⌥' : 'Alt') : part);
    const key = CODE_LABELS[code] || code.replace(/^Key/, '').replace(/^Digit/, '');
    return [...labels, key].join(isMac() ? ' ' : '+');
  }

  function assignBinding(bindings, actionID, binding) {
    const next = mergeBindings(bindings);
    const normalized = normalizeBinding(binding);
    if (!ACTION_IDS.has(actionID) || normalized === null) return { bindings: next, displaced: '' };
    let displaced = '';
    if (normalized) {
      for (const [id, current] of Object.entries(next)) {
        if (id !== actionID && current === normalized) { next[id] = ''; displaced = id; }
      }
    }
    next[actionID] = normalized;
    return { bindings: next, displaced };
  }

  globalThis.GoLensShortcuts = { actions: ACTIONS.map((action) => ({ ...action })), presets: PRESETS.map((preset) => ({ ...preset })), defaultBindings, presetBindings, presetForBindings, mergeBindings, normalizeBinding, bindingForEvent, matchesEvent, displayBinding, assignBinding };
})();
