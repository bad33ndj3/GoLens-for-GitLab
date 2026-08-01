import assert from 'node:assert/strict';
import test from 'node:test';

import { createStorageResetCoordinator } from '../src/storage-reset.ts';

function area(initial, log, name) {
  const values = { ...initial };
  return {
    values,
    async get() { log.push(`${name}:get`); return { ...values }; },
    async set(update) { log.push(`${name}:set:${Object.keys(update).join(',')}`); Object.assign(values, update); },
    async clear() { log.push(`${name}:clear`); for (const key of Object.keys(values)) delete values[key]; },
  };
}

test('storage reset is inactive until the architecture switch', async () => {
  const log = [];
  const coordinator = createStorageResetCoordinator({
    epoch: null,
    sync: area({ enabled: false }, log, 'sync'),
    local: area({ bookmark: true }, log, 'local'),
    clearCache: async () => { log.push('cache:clear'); },
  });

  assert.deepEqual(await coordinator.ensure(), { status: 'inactive', upgradeNoticePending: false });
  assert.deepEqual(log, []);
});

test('fresh installation receives the current epoch before storage is read', async () => {
  const log = [];
  const local = area({}, log, 'local');
  const coordinator = createStorageResetCoordinator({ epoch: 1, sync: area({}, log, 'sync'), local, clearCache: async () => {} });
  assert.deepEqual(await coordinator.ensure(), { status: 'reset', upgradeNoticePending: true });
  assert.deepEqual(local.values, { golensArchitectureEpoch: 1, golensUpgradeNoticePending: true });
});

test('storage reset is ordered, restart-safe, and idempotent', async () => {
  const log = [];
  const sync = area({ enabled: false }, log, 'sync');
  const local = area({ golensArchitectureEpoch: 0, bookmark: true }, log, 'local');
  let failOnce = true;
  const options = {
    epoch: 1,
    sync,
    local,
    clearCache: async () => {
      log.push('cache:clear');
      if (failOnce) { failOnce = false; throw new Error('worker stopped'); }
    },
  };

  await assert.rejects(createStorageResetCoordinator(options).ensure(), /worker stopped/);
  assert.equal(local.values.golensArchitectureResetting, true);
  assert.equal(local.values.bookmark, true);

  const coordinator = createStorageResetCoordinator(options);
  assert.deepEqual(await coordinator.ensure(), { status: 'reset', upgradeNoticePending: true });
  assert.deepEqual(local.values, { golensArchitectureEpoch: 1, golensUpgradeNoticePending: true });
  assert.deepEqual(sync.values, {});
  assert.deepEqual(log.slice(-6), [
    'local:get',
    'local:set:golensArchitectureResetting',
    'sync:clear',
    'cache:clear',
    'local:clear',
    'local:set:golensArchitectureEpoch,golensUpgradeNoticePending',
  ]);

  const before = log.length;
  assert.deepEqual(await coordinator.ensure(), { status: 'ready', upgradeNoticePending: true });
  assert.deepEqual(log.slice(before), ['local:get']);
  await coordinator.acknowledgeUpgradeNotice();
  assert.equal(local.values.golensUpgradeNoticePending, false);
  assert.deepEqual(await coordinator.ensure(), { status: 'ready', upgradeNoticePending: false });
});
