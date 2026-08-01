import assert from 'node:assert/strict';
import test from 'node:test';

import { startWorkerEntry } from '../../src/worker.ts';

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
