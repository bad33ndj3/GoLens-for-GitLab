import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mount } from '../page/features/project-search.js';

function fakeLegacy(overrides = {}) {
  const calls = {
    showResult: [],
    pinPopover: [],
    toast: [],
    showSearchProgress: [],
    loadPackage: [],
    searchProjectBlobPaths: [],
  };
  return {
    enabled: true,
    isEnabled() { return this.enabled; },
    showSearchProgress(message, pointer) { calls.showSearchProgress.push({ message, pointer }); },
    showResult(result, pointer) { calls.showResult.push({ result, pointer }); },
    pinPopover(pointer) { calls.pinPopover.push(pointer); },
    toast(message) { calls.toast.push(message); },
    async searchProjectBlobPaths(term, ref, opts) {
      calls.searchProjectBlobPaths.push({ term, ref, opts });
      return { paths: [`${term}/impl.go`], status: 'complete' };
    },
    async loadPackage(packagePath, ref, onProgress, signal) {
      calls.loadPackage.push({ packagePath, ref, signal });
      return { files: 1, downloaded: 1 };
    },
    async findReferencesAt(target, definition, cursor, scope) {
      return { status: 'references', definition, locations: [], scope, request: { kind: 'references' } };
    },
    async findImplementationsAt(target, definition, progress, cursor, scope) {
      return { status: 'implementations', interfaceDefinition: definition, scope };
    },
    calls,
    ...overrides,
  };
}

function referencesResult(extra = {}) {
  return {
    status: 'references',
    definition: { name: 'Run' },
    request: { kind: 'references', ref: 'a'.repeat(40), target: { key: 't1' }, definition: { name: 'Run' } },
    ...extra,
  };
}

const pointer = { key: 'pointer-1' };

async function flush(times = 20) {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

test('mount(ctx) without ctx.legacy: open()/close()/cancel() degrade to unavailable instead of throwing', () => {
  const handle = mount({});
  assert.deepEqual(handle.open(referencesResult(), pointer), { kind: 'unavailable' });
  assert.deepEqual(handle.close(), { kind: 'unavailable' });
  assert.deepEqual(handle.cancel(), { kind: 'unavailable' });
  assert.doesNotThrow(() => handle.unmount());
});

test('open(): missingRef when result.request.ref is absent, no legacy calls made', () => {
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  const outcome = handle.open({ status: 'references', request: {} }, pointer);
  assert.deepEqual(outcome, { kind: 'missingRef' });
  assert.equal(legacy.calls.showSearchProgress.length, 0);
});

test('open(): calls legacy.showSearchProgress synchronously, before ready resolves', async () => {
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  const outcome = handle.open(referencesResult(), pointer);
  assert.equal(outcome.kind, 'started');
  assert.deepEqual(legacy.calls.showSearchProgress, [{ message: 'Searching complete project…', pointer }]);
  await outcome.ready;
});

test('open(): searches blob-path terms, indexes matching packages, then refreshes the popover result', async () => {
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  const outcome = handle.open(referencesResult(), pointer);
  await outcome.ready;
  await flush();

  assert.deepEqual(legacy.calls.searchProjectBlobPaths.map((c) => c.term), ['Run']);
  assert.deepEqual(legacy.calls.searchProjectBlobPaths[0].opts, { maxPages: Infinity, maxPaths: Infinity, searchType: 'basic', signal: legacy.calls.searchProjectBlobPaths[0].opts.signal });
  assert.deepEqual(legacy.calls.loadPackage.map((c) => c.packagePath), ['Run']);
  assert.equal(legacy.calls.showResult.length, 1);
  assert.equal(legacy.calls.showResult[0].result.status, 'references');
  assert.equal(legacy.calls.showResult[0].pointer, pointer);
  assert.deepEqual(legacy.calls.pinPopover, [pointer]);
});

test('open(): dispatches implementations requests through findImplementationsAt, not findReferencesAt', async () => {
  const legacy = fakeLegacy();
  const result = {
    status: 'implementations',
    interfaceDefinition: { name: 'Runner' },
    searchTerms: ['Runner'],
    request: { kind: 'implementations', ref: 'b'.repeat(40), target: { key: 't2' }, definition: { name: 'Runner' } },
  };
  const handle = mount({ legacy });
  const outcome = handle.open(result, pointer);
  await outcome.ready;
  assert.equal(legacy.calls.showResult[0].result.status, 'implementations');
});

test('open(): a request with no searchable terms toasts the verbatim legacy message and restores the original result', async () => {
  const legacy = fakeLegacy();
  const original = referencesResult({ request: { kind: 'references', ref: 'a'.repeat(40), target: {}, definition: {} } });
  const handle = mount({ legacy });
  const outcome = handle.open(original, pointer);
  await outcome.ready;

  assert.deepEqual(legacy.calls.toast, ['This interface has no searchable methods, so code search cannot prove complete coverage.']);
  assert.equal(legacy.calls.showResult.length, 1);
  assert.equal(legacy.calls.showResult[0].result, original);
  assert.deepEqual(legacy.calls.pinPopover, [pointer]);
});

test('open(): incomplete blob-path coverage toasts the verbatim legacy message and restores the original result', async () => {
  const legacy = fakeLegacy({
    async searchProjectBlobPaths() { return { paths: [], status: 'limited' }; },
  });
  const original = referencesResult();
  const handle = mount({ legacy });
  const outcome = handle.open(original, pointer);
  await outcome.ready;

  assert.deepEqual(legacy.calls.toast, ['GitLab code search could not prove complete coverage for this project.']);
  assert.equal(legacy.calls.showResult.length, 1);
  assert.equal(legacy.calls.showResult[0].result, original);
});

test('open(): an infrastructure rejection (e.g. loadPackage failure) surfaces its message and restores the original result', async () => {
  const legacy = fakeLegacy({
    async loadPackage() { throw new Error('Go worker is unavailable.'); },
  });
  const original = referencesResult();
  const handle = mount({ legacy });
  const outcome = handle.open(original, pointer);
  await outcome.ready;

  assert.deepEqual(legacy.calls.toast, ['Go worker is unavailable.']);
  assert.equal(legacy.calls.showResult.length, 1);
  assert.equal(legacy.calls.showResult[0].result, original);
});

test('open(): a rejection with no message falls back to the verbatim default failure text', async () => {
  const legacy = fakeLegacy({
    async loadPackage() { throw new Error(); },
  });
  const handle = mount({ legacy });
  const outcome = handle.open(referencesResult(), pointer);
  await outcome.ready;
  assert.deepEqual(legacy.calls.toast, ['Full-project search failed']);
});

test('open(): a second open() aborts the first in-flight search', async () => {
  const abortedSignals = [];
  const legacy = fakeLegacy({
    async searchProjectBlobPaths(term, ref, { signal }) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      abortedSignals.push(signal.aborted);
      return { paths: [], status: 'complete' };
    },
  });
  const handle = mount({ legacy });
  const first = handle.open(referencesResult(), pointer);
  const second = handle.open(referencesResult({ request: { kind: 'references', ref: 'c'.repeat(40), target: {}, definition: { name: 'Other' } } }), pointer);
  await Promise.all([first.ready, second.ready]);
  assert.equal(abortedSignals[0], true, 'the first search observed its own signal aborted');
});

test('close(): aborts the in-flight search, restores the original popover result, and toasts', async () => {
  const legacy = fakeLegacy({
    async searchProjectBlobPaths(term, ref, { signal }) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { paths: [], status: 'complete' };
    },
  });
  const handle = mount({ legacy });
  const original = referencesResult();
  const outcome = handle.open(original, pointer);

  const closed = handle.close();
  assert.deepEqual(closed, { kind: 'closed' });
  assert.equal(legacy.calls.showResult.length, 1);
  assert.equal(legacy.calls.showResult[0].result, original, 'restores the ORIGINAL, unrefreshed result');
  assert.deepEqual(legacy.calls.pinPopover, [pointer]);
  assert.deepEqual(legacy.calls.toast, ['Complete project search cancelled. Coverage remains incomplete.']);

  await outcome.ready;
  // The aborted search's own catch must not re-show/re-toast after close().
  assert.equal(legacy.calls.showResult.length, 1);
});

test('close(): not-open when nothing is running', () => {
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  assert.deepEqual(handle.close(), { kind: 'not-open' });
});

test('close({restorePopover: false}): aborts and returns closed silently, without touching the legacy popover (navigation/unmount cleanup path)', async () => {
  const legacy = fakeLegacy({
    async searchProjectBlobPaths(term, ref, { signal }) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { paths: [], status: 'complete' };
    },
  });
  const handle = mount({ legacy });
  const outcome = handle.open(referencesResult(), pointer);
  const closed = handle.close({ restorePopover: false });
  assert.deepEqual(closed, { kind: 'closed' });
  assert.equal(legacy.calls.showResult.length, 0);
  assert.equal(legacy.calls.pinPopover.length, 0);
  assert.equal(legacy.calls.toast.length, 0);
  await outcome.ready;
});

test('cancel(): aborts the in-flight search, toasts, and does NOT restore the popover result (unlike close())', async () => {
  const legacy = fakeLegacy({
    async searchProjectBlobPaths(term, ref, { signal }) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { paths: [], status: 'complete' };
    },
  });
  const handle = mount({ legacy });
  const outcome = handle.open(referencesResult(), pointer);

  const cancelled = handle.cancel();
  assert.deepEqual(cancelled, { kind: 'closed' });
  assert.deepEqual(legacy.calls.toast, ['Complete project search cancelled. Coverage remains incomplete.']);
  assert.equal(legacy.calls.showResult.length, 0);
  assert.equal(legacy.calls.pinPopover.length, 0);

  await outcome.ready;
});

test('cancel(): not-open when nothing is running', () => {
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  assert.deepEqual(handle.cancel(), { kind: 'not-open' });
});

test('cancel(): unavailable without ctx.legacy', () => {
  const handle = mount({});
  assert.deepEqual(handle.cancel(), { kind: 'unavailable' });
});

test('cancel(): the aborted search\'s own catch must not double-toast after cancel()', async () => {
  const legacy = fakeLegacy({
    async searchProjectBlobPaths(term, ref, { signal }) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { paths: [], status: 'complete' };
    },
  });
  const handle = mount({ legacy });
  const outcome = handle.open(referencesResult(), pointer);
  handle.cancel();
  await outcome.ready;
  assert.equal(legacy.calls.toast.length, 1, 'only cancel()\'s own toast, not a second one from the aborted search catch');
});

test('unmount(): aborts any in-flight search; mount-after-unmount is safe', async () => {
  const legacy = fakeLegacy({
    async searchProjectBlobPaths(term, ref, { signal }) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      return { paths: [], status: 'complete' };
    },
  });
  const handle = mount({ legacy });
  const outcome = handle.open(referencesResult(), pointer);
  handle.unmount();
  assert.doesNotThrow(() => handle.unmount());
  await outcome.ready;
  assert.equal(legacy.calls.showResult.length, 0, 'unmount does not touch the legacy popover');

  const legacyB = fakeLegacy();
  const handleB = mount({ legacy: legacyB });
  const outcomeB = handleB.open(referencesResult(), pointer);
  assert.equal(outcomeB.kind, 'started');
  await outcomeB.ready;
});

test('open() after unmount() degrades to unavailable', () => {
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  handle.unmount();
  assert.deepEqual(handle.open(referencesResult(), pointer), { kind: 'unavailable' });
});
