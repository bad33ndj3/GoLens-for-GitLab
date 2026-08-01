import assert from 'node:assert/strict';
import test from 'node:test';

import { startWorkerEntry } from '../../src/worker.ts';
import { createStorageResetCoordinator } from '../../src/user-storage.ts';

function storageArea(initial, log, name) {
  const values = { ...initial };
  return {
    values,
    async get() { log.push(`${name}:get`); return { ...values }; },
    async set(update) { log.push(`${name}:set:${Object.keys(update).join(',')}`); Object.assign(values, update); },
    async clear() { log.push(`${name}:clear`); for (const key of Object.keys(values)) delete values[key]; },
  };
}

test('worker entry starts Go Intelligence and answers the entry health check', () => {
  let starts = 0;
  let listener;
  const area = { get: async () => ({}), set: async () => {}, clear: async () => {} };
  const intelligence = { clearCache: async () => ({}) };
  const stop = startWorkerEntry({
    start: () => { starts += 1; return intelligence; },
    sync: area,
    local: area,
    runtime: { onMessage: { addListener(value) { listener = value; }, removeListener(value) { assert.equal(value, listener); } } },
  });
  let response;
  assert.equal(listener({ type: 'golens:rewrite:ping' }, {}, (value) => { response = value; }), false);
  assert.equal(response, 'golens:rewrite:pong');
  assert.equal(listener({ type: 'golens:rewrite:ensure-storage' }, {}, () => {}), true);
  assert.equal(starts, 1);
  stop();
});

test('architecture reset stays inactive until the switch', async () => {
  const log = [];
  const reset = createStorageResetCoordinator({ epoch: null, sync: storageArea({}, log, 'sync'), local: storageArea({}, log, 'local'), clearCache: async () => {} });
  assert.deepEqual(await reset.ensure(), { status: 'inactive', upgradeNoticePending: false });
  assert.deepEqual(log, []);
});

test('architecture reset is ordered, restart-safe, and idempotent', async () => {
  const log = [];
  const sync = storageArea({ enabled: false }, log, 'sync');
  const local = storageArea({ golensArchitectureEpoch: 0, bookmark: true }, log, 'local');
  let failOnce = true;
  const options = { epoch: 1, sync, local, clearCache: async () => { log.push('cache:clear'); if (failOnce) { failOnce = false; throw new Error('worker stopped'); } } };
  await assert.rejects(createStorageResetCoordinator(options).ensure(), /worker stopped/);
  assert.equal(local.values.golensArchitectureResetting, true);

  const reset = createStorageResetCoordinator(options);
  assert.deepEqual(await reset.ensure(), { status: 'reset', upgradeNoticePending: true });
  assert.deepEqual(local.values, { golensArchitectureEpoch: 1, golensUpgradeNoticePending: true });
  assert.deepEqual(sync.values, {});
  const before = log.length;
  assert.deepEqual(await reset.ensure(), { status: 'ready', upgradeNoticePending: true });
  assert.deepEqual(log.slice(before), ['local:get']);
  await reset.acknowledgeUpgradeNotice();
  assert.equal(local.values.golensUpgradeNoticePending, false);
});

test('fresh installation receives the current architecture epoch', async () => {
  const log = [];
  const local = storageArea({}, log, 'local');
  const reset = createStorageResetCoordinator({ epoch: 1, sync: storageArea({}, log, 'sync'), local, clearCache: async () => {} });
  assert.equal((await reset.ensure()).status, 'reset');
  assert.deepEqual(local.values, { golensArchitectureEpoch: 1, golensUpgradeNoticePending: true });
});
