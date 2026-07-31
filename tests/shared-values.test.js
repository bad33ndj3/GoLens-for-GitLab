import assert from 'node:assert/strict';
import test from 'node:test';

import {
  commitSha,
  repositoryKey,
  repositoryPath,
  sourceIdentity,
} from '../src/domain.ts';
import { FEATURE_CATALOG, featuresFor, guideChapters } from '../src/feature-catalog.ts';
import {
  assignBinding,
  bindingForEvent,
  defaultBindings,
  isBlockedShortcutContext,
  matchesEvent,
  mergeBindings,
  presetBindings,
  presetForBindings,
  PRESETS,
} from '../src/shortcuts.ts';
import { createUserStorage } from '../src/user-storage.ts';

function memoryArea(seed = {}) {
  const values = { ...seed };
  return {
    values,
    async get(keys) {
      if (keys === null) return { ...values };
      if (typeof keys === 'string') return { [keys]: values[keys] };
      return { ...(keys || {}), ...values };
    },
    async set(next) { Object.assign(values, next); },
    async remove(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete values[key];
    },
  };
}

test('shared source values validate and remain immutable', () => {
  assert.equal(repositoryKey('https://gitlab.example/group/project'), 'https://gitlab.example/group/project');
  assert.equal(commitSha('A'.repeat(40)), 'a'.repeat(40));
  assert.equal(repositoryPath('cmd/golens/main.go'), 'cmd/golens/main.go');
  assert.throws(() => repositoryKey('  '));
  assert.throws(() => commitSha('main'));
  assert.throws(() => repositoryPath('../secret.go'));

  const source = sourceIdentity({
    repositoryKey: 'https://gitlab.example/group/project',
    commitSha: 'a'.repeat(40),
  });
  assert.ok(Object.isFrozen(source));
  assert.throws(() => { source.commitSha = 'b'.repeat(40); });
});

test('shortcut rules keep presets editable, unique, portable, and out of blocked contexts', () => {
  assert.deepEqual(PRESETS.map(({ id }) => id), ['golens', 'vscode', 'intellij', 'vim']);
  assert.equal(presetBindings('vim')?.nextOccurrence, 'KeyN');
  assert.equal(presetForBindings(presetBindings('intellij')), 'intellij');

  const defaults = defaultBindings();
  const moved = assignBinding(defaults, 'focusFileSearch', defaults.nextOccurrence);
  assert.equal(moved.bindings.nextOccurrence, '');
  assert.equal(moved.displaced, 'nextOccurrence');

  const event = { code: 'KeyP', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, repeat: false, isComposing: false };
  assert.equal(bindingForEvent(event, 'other'), 'Primary+KeyP');
  assert.equal(matchesEvent('Primary+KeyP', event, 'other'), true);
  assert.equal(matchesEvent('Primary+KeyP', { ...event, repeat: true }, 'other'), false);
  assert.equal(bindingForEvent({ ...event, ctrlKey: false, metaKey: true }, 'mac'), 'Primary+KeyP');
  assert.equal(isBlockedShortcutContext([{ matches: (selector) => selector.includes('input'), disabled: false, readOnly: false, getAttribute: () => null }]), true);
  assert.equal(isBlockedShortcutContext([{ matches: () => false }]), false);
});

test('feature catalog is one complete, unique guide with a setup subset', () => {
  const ids = FEATURE_CATALOG.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(FEATURE_CATALOG.length, 31);
  assert.ok(featuresFor('setup').every((feature) => feature.audiences.includes('guide')));
  assert.deepEqual(featuresFor('setup').filter(({ id }) => ['enable', 'related-cache', 'generated-files', 'keymaps'].includes(id)).map(({ id }) => id), [
    'enable', 'related-cache', 'generated-files', 'keymaps',
  ]);
  assert.equal([...guideChapters().values()].flat().length, FEATURE_CATALOG.length);
  assert.ok(FEATURE_CATALOG.every(({ chapter, title, summary }) => chapter && title && summary));
});

test('user storage validates malformed records, syncs preferences, and stores no source excerpts', async () => {
  const sync = memoryArea({
    enabled: 'yes',
    hideGeneratedFiles: true,
    shortcutCoachEnabled: null,
    shortcutBindings: { nextOccurrence: 'Nope+KeyQ', nextFile: '' },
  });
  const local = memoryArea({
    golensOnboardingVersion: -4,
    golensShortcutCoach: { lastHintAt: 'yesterday', actions: { focusFileSearch: { learned: true } } },
    golensCelebration: { at: 'soon', repositoryKey: 'repo' },
    'golensBookmark:v1:broken': { source: 'private source excerpt' },
  });
  let changed;
  const changes = {
    addListener(listener) { changed = listener; },
    removeListener(listener) { assert.equal(listener, changed); },
  };
  const storage = createUserStorage({ sync, local, changes, normalizeShortcutBindings: mergeBindings });

  assert.deepEqual(await storage.preferences.get(), {
    enabled: true,
    hideGeneratedFiles: true,
    shortcutCoachEnabled: true,
    shortcutBindings: { ...defaultBindings(), nextFile: '' },
  });
  await storage.preferences.set({ enabled: false });
  assert.equal(sync.values.enabled, false);
  const preferenceUpdates = [];
  const unsubscribe = storage.preferences.subscribe((value) => preferenceUpdates.push(value));
  sync.values.enabled = true;
  changed({ enabled: { newValue: true } }, 'sync');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(preferenceUpdates[0].enabled, true);
  unsubscribe();

  assert.equal(await storage.onboarding.get(), 0);
  assert.deepEqual(await storage.learning.get(), { version: 1, lastHintAt: 0, actions: {} });
  assert.equal(await storage.celebration.get(), null);
  assert.deepEqual(await storage.bookmarks.list({ origin: 'https://gitlab.example', project: 'group/project', mergeRequest: '42' }), []);

  const record = await storage.bookmarks.toggle({
    scope: { origin: 'https://gitlab.example', project: 'group/project', mergeRequest: '42', headSha: 'a'.repeat(40) },
    location: { path: 'main.go', side: 'new', startLine: 8, endLine: 9 },
    anchor: { symbol: 'run', selectionHash: '1'.repeat(64), beforeHash: '', afterHash: '' },
  });
  assert.equal(record.action, 'added');
  assert.equal(JSON.stringify(local.values).includes('private source excerpt'), true, 'malformed foreign data is left untouched');
  assert.equal(JSON.stringify(record).includes('source'), false);
});

test('bookmark recovery writes the replacement before removing stale data', async () => {
  const events = [];
  const sync = memoryArea();
  const local = memoryArea();
  local.set = async (next) => { events.push('set'); Object.assign(local.values, next); };
  local.remove = async (keys) => {
    events.push('remove');
    for (const key of Array.isArray(keys) ? keys : [keys]) delete local.values[key];
  };
  let nextID = 0;
  const storage = createUserStorage({
    sync,
    local,
    changes: { addListener() {}, removeListener() {} },
    normalizeShortcutBindings: mergeBindings,
    id: () => `bookmark-${++nextID}`,
    now: () => nextID,
  });
  const stale = (await storage.bookmarks.toggle({
    scope: { origin: 'https://gitlab.example', project: 'group/project', mergeRequest: '42', headSha: 'a'.repeat(40) },
    location: { path: 'main.go', side: 'new', startLine: 8 },
  })).record;

  events.length = 0;
  const currentScope = { ...stale.scope, headSha: 'b'.repeat(40) };
  await storage.bookmarks.recover(stale, { scope: currentScope, location: { ...stale.location, startLine: 12, endLine: 12 }, anchor: stale.anchor });
  assert.deepEqual(events, ['set', 'remove']);
  assert.equal((await storage.bookmarks.list(currentScope))[0].location.startLine, 12);
  assert.equal(await storage.bookmarks.clear(currentScope, 'current'), 1);
  assert.deepEqual(await storage.bookmarks.list(currentScope), []);
});
