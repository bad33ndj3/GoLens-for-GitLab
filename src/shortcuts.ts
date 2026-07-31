export const ACTIONS = Object.freeze([
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
  { id: 'toggleBookmark', label: 'Toggle bookmark', defaultBinding: 'Alt+KeyM' },
  { id: 'previousBookmark', label: 'Previous bookmark', defaultBinding: 'Alt+Comma' },
  { id: 'nextBookmark', label: 'Next bookmark', defaultBinding: 'Alt+Period' },
] as const);

export type ShortcutAction = typeof ACTIONS[number]['id'];
export type ShortcutBindings = Record<ShortcutAction, string>;
export type ShortcutPlatform = 'mac' | 'other';

export const PRESETS = Object.freeze([
  { id: 'golens', label: 'GoLens', description: 'Browser-safe IDE defaults' },
  { id: 'vscode', label: 'VS Code', description: 'VS Code navigation conventions' },
  { id: 'intellij', label: 'IntelliJ IDEA', description: 'IntelliJ Windows/Linux keymap conventions' },
  { id: 'vim', label: 'Vim-style', description: 'Single-key Vim navigation, without modes' },
] as const);

const ACTION_IDS = new Set<string>(ACTIONS.map(({ id }) => id));
const MODIFIERS = ['Primary', 'Ctrl', 'Alt', 'Shift', 'Meta'];
const KEY_CODE = /^(?:Key[A-Z]|Digit\d|F(?:[1-9]|1[0-2])|BracketLeft|BracketRight|Minus|Equal|Comma|Period|Slash|Semicolon|Quote|Backquote|Backslash|ArrowLeft|ArrowRight|ArrowUp|ArrowDown|Home|End|PageUp|PageDown|Space|Enter|Escape|Backspace|Delete|Tab)$/;

const PRESET_BINDINGS: Record<string, ShortcutBindings> = {
  golens: defaultBindings(),
  vscode: {
    ...defaultBindings(), previousOccurrence: 'Shift+F3', nextOccurrence: 'F3',
    previousFile: 'Ctrl+PageUp', nextFile: 'Ctrl+PageDown',
  },
  intellij: {
    ...defaultBindings(), focusFileSearch: 'Ctrl+Shift+KeyN', semanticJump: 'Ctrl+KeyB',
    previousOccurrence: 'Shift+F3', nextOccurrence: 'F3',
    previousHunk: 'Ctrl+Alt+Shift+ArrowUp', nextHunk: 'Ctrl+Alt+Shift+ArrowDown',
    previousFile: 'Alt+ArrowLeft', nextFile: 'Alt+ArrowRight',
    historyBack: 'Ctrl+Alt+ArrowLeft', historyForward: 'Ctrl+Alt+ArrowRight',
  },
  vim: {
    ...defaultBindings(), focusFileSearch: 'Slash', clearFileSearch: '', semanticJump: 'Ctrl+BracketRight',
    previousOccurrence: 'Shift+KeyN', nextOccurrence: 'KeyN', previousHunk: 'BracketLeft', nextHunk: 'BracketRight',
    previousFile: 'Ctrl+KeyP', nextFile: 'Ctrl+KeyN', historyBack: 'Ctrl+KeyO', historyForward: 'Ctrl+KeyI',
  },
};

export function defaultBindings(): ShortcutBindings {
  return Object.fromEntries(ACTIONS.map(({ id, defaultBinding }) => [id, defaultBinding])) as ShortcutBindings;
}

export function normalizeBinding(value: unknown): string | null {
  if (value === '') return '';
  if (typeof value !== 'string') return null;
  const parts = value.split('+').filter(Boolean);
  const code = parts.pop();
  if (!code || !KEY_CODE.test(code)) return null;
  const modifiers = [...new Set(parts)];
  if (modifiers.some((part) => !MODIFIERS.includes(part))) return null;
  modifiers.sort((left, right) => MODIFIERS.indexOf(left) - MODIFIERS.indexOf(right));
  return [...modifiers, code].join('+');
}

export function mergeBindings(value: unknown): ShortcutBindings {
  const merged = defaultBindings();
  if (!value || typeof value !== 'object' || Array.isArray(value)) return merged;
  for (const [id, binding] of Object.entries(value)) {
    const normalized = normalizeBinding(binding);
    if (ACTION_IDS.has(id) && normalized !== null) merged[id as ShortcutAction] = normalized;
  }
  return merged;
}

export function presetBindings(id: string): ShortcutBindings | null {
  return PRESET_BINDINGS[id] ? { ...PRESET_BINDINGS[id] } : null;
}

export function presetForBindings(value: unknown): string {
  const bindings = mergeBindings(value);
  return PRESETS.find(({ id }) => ACTIONS.every(({ id: action }) => bindings[action] === PRESET_BINDINGS[id]?.[action]))?.id || '';
}

export function assignBinding(value: unknown, action: string, binding: unknown): { bindings: ShortcutBindings; displaced: string } {
  const bindings = mergeBindings(value);
  const normalized = normalizeBinding(binding);
  if (!ACTION_IDS.has(action) || normalized === null) return { bindings, displaced: '' };
  let displaced = '';
  if (normalized) {
    for (const candidate of ACTIONS) {
      if (candidate.id !== action && bindings[candidate.id] === normalized) {
        bindings[candidate.id] = '';
        displaced = candidate.id;
      }
    }
  }
  bindings[action as ShortcutAction] = normalized;
  return { bindings, displaced };
}

type ShortcutEvent = Readonly<{
  code: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  shiftKey?: boolean;
  repeat?: boolean;
  isComposing?: boolean;
}>;

export function bindingForEvent(event: ShortcutEvent, platform: ShortcutPlatform): string {
  if (!event.code || /^(?:Control|Shift|Alt|Meta)(?:Left|Right)$/.test(event.code)) return '';
  const primary = platform === 'mac' ? event.metaKey : event.ctrlKey;
  const modifiers = [];
  if (primary) modifiers.push('Primary');
  if (event.ctrlKey && (platform === 'mac' || !primary)) modifiers.push('Ctrl');
  if (event.altKey) modifiers.push('Alt');
  if (event.shiftKey) modifiers.push('Shift');
  if (event.metaKey && (platform !== 'mac' || !primary)) modifiers.push('Meta');
  return normalizeBinding([...modifiers, event.code].join('+')) || '';
}

export function matchesEvent(binding: string, event: ShortcutEvent, platform: ShortcutPlatform): boolean {
  return Boolean(binding) && !event.repeat && !event.isComposing && bindingForEvent(event, platform) === normalizeBinding(binding);
}

type ShortcutContext = {
  closest?(selector: string): ShortcutContext | null;
  matches?(selector: string): boolean;
  disabled?: boolean;
  readOnly?: boolean;
  getAttribute?(name: string): string | null;
};

export function isBlockedShortcutContext(path: readonly unknown[]): boolean {
  return path.some((item) => {
    if (!item || typeof item !== 'object') return false;
    const element = item as ShortcutContext;
    const blocked = element.closest?.('input, textarea, select, [contenteditable], dialog, [role="dialog"], [aria-modal="true"]') || element;
    if (!blocked.matches?.('input, textarea, select, [contenteditable]')) {
      return Boolean(blocked.matches?.('dialog, [role="dialog"], [aria-modal="true"]'));
    }
    return !blocked.disabled && !blocked.readOnly && blocked.getAttribute?.('contenteditable') !== 'false';
  });
}
