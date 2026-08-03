import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSettingsStore } from '../page/platform/settings-store.js';

function fakeStorage() {
  const areas = { sync: {}, local: {} };
  const setCalls = { sync: [], local: [] };
  let listener = null;
  return {
    sync: {
      async get(defaults) { return { ...defaults, ...areas.sync }; },
      async set(values) {
        setCalls.sync.push(values);
        Object.assign(areas.sync, values);
      },
    },
    local: {
      async get(defaults) { return { ...defaults, ...areas.local }; },
      async set(values) {
        setCalls.local.push(values);
        Object.assign(areas.local, values);
      },
    },
    onChanged: { addListener(fn) { listener = fn; } },
    // test helpers, not part of the chrome.storage surface
    __setCalls: setCalls,
    __fireExternalChange(changes, areaName) { listener?.(changes, areaName); },
  };
}

test('ready() resolves defaults for unset keys, get() returns a sync snapshot', async () => {
  const storage = fakeStorage();
  const store = createSettingsStore({ storage });
  await store.ready();
  assert.equal(store.get('enabled'), true);
  assert.equal(store.get('hideGeneratedFiles'), false);
  assert.equal(store.get('shortcutCoachEnabled'), true);
  assert.deepEqual(store.get('shortcutBindings'), {});
  assert.equal(store.get('golensOnboardingVersion'), 0);
});

test('set(key, value) persists to the key\'s owning area and updates the snapshot immediately', async () => {
  const storage = fakeStorage();
  const store = createSettingsStore({ storage });
  await store.ready();
  await store.set('enabled', false);
  assert.equal(store.get('enabled'), false);
  assert.deepEqual(storage.__setCalls.sync, [{ enabled: false }]);

  await store.set('golensOnboardingVersion', 11);
  assert.equal(store.get('golensOnboardingVersion'), 11);
  assert.deepEqual(storage.__setCalls.local, [{ golensOnboardingVersion: 11 }]);
});

test('synchronous set() calls to the same area coalesce into a single storage.set write', async () => {
  const storage = fakeStorage();
  const store = createSettingsStore({ storage });
  await store.ready();

  await Promise.all([
    store.set('hideGeneratedFiles', true),
    store.set('shortcutBindings', { nextOccurrence: 'F3' }),
  ]);

  assert.equal(storage.__setCalls.sync.length, 1, 'both keys should land in one chrome.storage.sync.set call');
  assert.equal(storage.__setCalls.sync[0].hideGeneratedFiles, true);
  assert.equal(storage.__setCalls.sync[0].shortcutBindings.nextOccurrence, 'F3');
});

test('set() rejects an unknown key', async () => {
  const storage = fakeStorage();
  const store = createSettingsStore({ storage });
  await store.ready();
  assert.throws(() => store.set('notAKey', 1), /unknown key/);
});

test('subscribe(key, fn) fires on external chrome.storage.onChanged writes for that key only', async () => {
  const storage = fakeStorage();
  const store = createSettingsStore({ storage });
  await store.ready();

  const hideGeneratedFilesCalls = [];
  const enabledCalls = [];
  store.subscribe('hideGeneratedFiles', (value) => hideGeneratedFilesCalls.push(value));
  store.subscribe('enabled', (value) => enabledCalls.push(value));

  storage.__fireExternalChange({ hideGeneratedFiles: { oldValue: false, newValue: true } }, 'sync');
  assert.deepEqual(hideGeneratedFilesCalls, [true]);
  assert.deepEqual(enabledCalls, []);
  assert.equal(store.get('hideGeneratedFiles'), true, 'the snapshot should reflect the external write');

  storage.__fireExternalChange({ golensOnboardingVersion: { oldValue: 0, newValue: 11 } }, 'local');
  assert.deepEqual(hideGeneratedFilesCalls, [true]);
  assert.equal(store.get('golensOnboardingVersion'), 11);
});

test('subscribe() ignores changes from a different area or an unrelated key, and unsubscribe() stops delivery', async () => {
  const storage = fakeStorage();
  const store = createSettingsStore({ storage });
  await store.ready();

  const calls = [];
  const unsubscribe = store.subscribe('enabled', (value) => calls.push(value));

  storage.__fireExternalChange({ enabled: { oldValue: true, newValue: true } }, 'local'); // wrong area, same key name doesn't collide here but area must match
  assert.deepEqual(calls, []);

  storage.__fireExternalChange({ hideGeneratedFiles: { oldValue: false, newValue: true } }, 'sync');
  assert.deepEqual(calls, []);

  storage.__fireExternalChange({ enabled: { oldValue: true, newValue: false } }, 'sync');
  assert.deepEqual(calls, [false]);

  unsubscribe();
  storage.__fireExternalChange({ enabled: { oldValue: false, newValue: true } }, 'sync');
  assert.deepEqual(calls, [false], 'no further notifications after unsubscribe');
});

test('ready() only loads storage once even if called multiple times', async () => {
  const storage = fakeStorage();
  let getCount = 0;
  const realGet = storage.sync.get.bind(storage.sync);
  storage.sync.get = async (defaults) => { getCount++; return realGet(defaults); };
  const store = createSettingsStore({ storage });
  await Promise.all([store.ready(), store.ready()]);
  await store.ready();
  assert.equal(getCount, 1);
});
