import assert from 'node:assert/strict';
import test from 'node:test';

import { createHostSourceReader, reviewPreferences, startContentEntry } from '../../src/content.ts';
import { commitSha, repositoryKey, repositoryPath } from '../../src/domain.ts';

const source = { repositoryKey: repositoryKey('https://gitlab.com/group/project'), commitSha: commitSha('a'.repeat(40)) };

test('content entry adapts preferences and commit-pinned GitLab reads through public contracts', async () => {
  const reads = [];
  const host = {
    async read(query) {
      reads.push(query);
      if (query.operation === 'go-files') return { kind: 'ok', value: { files: [{ path: repositoryPath('pkg/a.go'), contentId: 'blob-a' }] } };
      if (query.path === 'go.mod') return { kind: 'ok', value: { path: query.path, contentId: 'mod', text: 'module example.com/project\n' } };
      return { kind: 'ok', value: { path: query.path, contentId: 'blob-a', text: 'package pkg\n' } };
    },
  };

  const reader = createHostSourceReader(host, source);
  const discovered = await reader.discover({ goal: 'current-package', packagePath: 'pkg' }, new AbortController().signal);
  assert.equal(discovered.modulePath, 'example.com/project');
  assert.deepEqual(discovered.files, [{ path: 'pkg/a.go', contentId: 'blob-a' }]);
  assert.equal(await reader.read(discovered.files[0], new AbortController().signal), 'package pkg\n');
  assert.ok(reads.every((read) => !('source' in read) || read.source === source));

  const preferences = reviewPreferences({ enabled: true, hideGeneratedFiles: true, shortcutBindings: { nextFile: 'Alt+PageDown' } }, 'other');
  assert.equal(preferences.enabled, true);
  assert.equal(preferences.hideGeneratedFiles, true);
  assert.deepEqual(preferences.shortcuts.find(({ command }) => command === 'next-file'), { command: 'next-file', key: 'PageDown', altKey: true });
});

test('content entry composes replacement sessions and serves Chrome entry messages', async () => {
  let runtimeListener;
  let preferenceListener;
  let nextReview;
  let savedSetup;
  let savedOnboarding;
  const modalOrder = [];
  let noticePending = true;
  const runtime = {
    sendMessage: async () => 'golens:rewrite:pong',
    getURL: (path) => `chrome-extension://id/${path}`,
    onMessage: { addListener(listener) { runtimeListener = listener; }, removeListener(listener) { assert.equal(listener, runtimeListener); } },
  };
  const preferences = { enabled: true, hideGeneratedFiles: false, shortcutCoachEnabled: true, shortcutBindings: { nextFile: 'KeyX' } };
  const storage = {
    preferences: {
      get: async () => preferences,
      set: async (value) => { savedSetup = value; },
      subscribe(listener) { preferenceListener = listener; return () => { preferenceListener = undefined; }; },
    },
    bookmarks: { list: async () => [], toggle: async () => { throw new Error('unused'); } },
    learning: { get: async () => ({ version: 1, lastHintAt: 0, actions: {} }), set: async () => {} },
    onboarding: { get: async () => 0, set: async (value) => { savedOnboarding = value; } },
  };
  const review = (sha) => ({
    identity: { origin: 'https://gitlab.com', repositoryKey: source.repositoryKey, projectPath: repositoryPath('group/project'), mergeRequestIid: '42', headSha: commitSha(sha.repeat(40)) },
    refs: { baseSha: commitSha('b'.repeat(40)), startSha: commitSha('b'.repeat(40)) },
  });
  const first = review('a');
  const second = review('c');
  const host = {
    async *observeReviews(signal) {
      yield first;
      await new Promise((resolve) => { nextReview = resolve; signal.addEventListener('abort', resolve, { once: true }); });
      if (!signal.aborted) yield second;
      await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    },
    connect(descriptor) { return { review: descriptor, read: async () => ({ kind: 'unavailable', reason: 'not-found' }) }; },
  };
  const sessions = [];
  let coachStoragePassed;
  const intelligence = (label) => ({
    query: async () => { throw new Error('unused'); }, ensureCoverage: async () => ({ status: 'ready' }),
    inspectCache: async () => ({ bytes: label, sourceBlobs: 0, packageManifests: 0, projectManifests: 0 }), clearCache: async () => ({ status: 'cleared', bytes: 0 }),
  });
  let opened = 0;
  const entry = await startContentEntry({
    window: { navigator: { platform: 'Linux' }, location: { origin: 'https://gitlab.com' } },
    runtime, storage, host,
    ensureStorage: async () => ({ status: 'ready', upgradeNoticePending: noticePending }),
    acknowledgeUpgradeNotice: async () => { noticePending = false; },
    showUpdate: () => () => {},
    openIntelligence: () => intelligence(++opened),
    startSession: (input) => { sessions.push(input.preferences); coachStoragePassed = input.coachStorage; return { stop: async () => {} }; },
    openSettings: () => () => { modalOrder.push('settings-closed'); },
    showGuide: () => { modalOrder.push('guide-shown'); },
    showUpgrade: async () => { modalOrder.push('upgrade-shown'); return true; },
    showSetup: async (_signal, _hideGeneratedFiles, preset) => { assert.equal(preset, 'custom'); return { preset: 'custom', hideGeneratedFiles: true }; },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(savedSetup.hideGeneratedFiles, true);
  assert.equal(savedSetup.shortcutBindings, undefined);
  assert.equal(savedOnboarding, 13);
  assert.equal(noticePending, false);
  preferenceListener({ ...preferences, enabled: false });
  nextReview();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(sessions.length, 2);
  assert.equal(sessions[1].enabled, false);
  assert.equal(typeof coachStoragePassed.settings, 'function');
  const response = await new Promise((resolve) => runtimeListener({ type: 'golens:rewrite:state' }, {}, resolve));
  assert.equal(response.ok, true);
  assert.equal(response.result.cache.bytes, 2);
  await new Promise((resolve) => runtimeListener({ type: 'golens:rewrite:open-settings' }, {}, resolve));
  await new Promise((resolve) => runtimeListener({ type: 'golens:rewrite:show-guide' }, {}, resolve));
  assert.deepEqual(modalOrder, ['upgrade-shown', 'settings-closed', 'guide-shown']);
  await entry.stop();
});
