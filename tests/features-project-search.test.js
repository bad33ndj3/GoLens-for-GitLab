import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Window } from 'happy-dom';
import { mount } from '../page/features/project-search.js';

function buildFixture() {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.write('<!doctype html><html><body></body></html>');
  globalThis.window = window;
  globalThis.document = window.document;
  globalThis.AbortController = window.AbortController || globalThis.AbortController;
  return window;
}

function fakeLegacy(overrides = {}) {
  const calls = { showResult: [], pinPopover: [], toast: [], hidePopover: 0, loadPackage: [], searchProjectBlobPaths: [] };
  return {
    enabled: true,
    isEnabled() { return this.enabled; },
    hidePopover() { calls.hidePopover++; },
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

test('mount(ctx) without ctx.legacy: open()/close() degrade to unavailable instead of throwing', () => {
  buildFixture();
  const handle = mount({});
  assert.deepEqual(handle.open(referencesResult(), pointer), { kind: 'unavailable' });
  assert.deepEqual(handle.close(), { kind: 'unavailable' });
  assert.doesNotThrow(() => handle.unmount());
});

test('open(): missingRef when result.request.ref is absent, no DOM or legacy calls made', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  const outcome = handle.open({ status: 'references', request: {} }, pointer);
  assert.deepEqual(outcome, { kind: 'missingRef' });
  assert.equal(legacy.calls.hidePopover, 0);
  assert.equal(document.getElementById('golens-project-search-root'), null);
});

test('open(): builds a private modal host, hides the legacy popover, shows the dialog', async () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  const outcome = handle.open(referencesResult(), pointer);
  assert.equal(outcome.kind, 'started');
  assert.equal(legacy.calls.hidePopover, 1);
  const host = document.getElementById('golens-project-search-root');
  assert.ok(host, 'modal host was created');
  const shadow = host.shadowRoot;
  assert.equal(shadow.querySelector('.full-search-dialog').getAttribute('aria-modal'), 'true');
  assert.equal(shadow.querySelector('.full-search-backdrop').hidden, false);
  await outcome.ready;
});

test('open(): searches blob-path terms, indexes matching packages, then refreshes the popover result', async () => {
  buildFixture();
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

  const host = document.getElementById('golens-project-search-root');
  assert.equal(host.shadowRoot.querySelector('.full-search-backdrop').hidden, true, 'dialog hidden once refresh completes');
  assert.equal(host.shadowRoot.querySelector('.full-search-chip').hidden, true);
});

test('open(): dispatches implementations requests through findImplementationsAt, not findReferencesAt', async () => {
  buildFixture();
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

test('open(): a request with no searchable terms fails with the verbatim legacy message and shows Retry', async () => {
  buildFixture();
  const legacy = fakeLegacy();
  const result = referencesResult({ request: { kind: 'references', ref: 'a'.repeat(40), target: {}, definition: {} } });
  const handle = mount({ legacy });
  const outcome = handle.open(result, pointer);
  await outcome.ready;

  const shadow = document.getElementById('golens-project-search-root').shadowRoot;
  assert.equal(shadow.querySelector('.loading-progress-phase').textContent, 'This interface has no searchable methods, so code search cannot prove complete coverage.');
  assert.equal(shadow.querySelector('.full-search-retry').hidden, false);
  assert.equal(shadow.querySelector('.full-search-backdrop').hidden, false, 'dialog stays visible so the error is seen');
  assert.equal(legacy.calls.showResult.length, 0, 'no popover refresh on failure');
});

test('open(): incomplete blob-path coverage fails with the verbatim legacy message', async () => {
  buildFixture();
  const legacy = fakeLegacy({
    async searchProjectBlobPaths() { return { paths: [], status: 'limited' }; },
  });
  const handle = mount({ legacy });
  const outcome = handle.open(referencesResult(), pointer);
  await outcome.ready;

  const shadow = document.getElementById('golens-project-search-root').shadowRoot;
  assert.equal(shadow.querySelector('.loading-progress-phase').textContent, 'GitLab code search could not prove complete coverage for this project.');
  assert.equal(shadow.querySelector('.full-search-retry').hidden, false);
});

test('open(): an infrastructure rejection (e.g. loadPackage failure) surfaces its message and Retry', async () => {
  buildFixture();
  const legacy = fakeLegacy({
    async loadPackage() { throw new Error('Go worker is unavailable.'); },
  });
  const handle = mount({ legacy });
  const outcome = handle.open(referencesResult(), pointer);
  await outcome.ready;

  const shadow = document.getElementById('golens-project-search-root').shadowRoot;
  assert.equal(shadow.querySelector('.loading-progress-phase').textContent, 'Go worker is unavailable.');
  assert.equal(shadow.querySelector('.full-search-retry').hidden, false);
});

test('open(): a rejection with no message falls back to the verbatim default failure text', async () => {
  buildFixture();
  const legacy = fakeLegacy({
    async loadPackage() { throw new Error(); },
  });
  const handle = mount({ legacy });
  const outcome = handle.open(referencesResult(), pointer);
  await outcome.ready;
  const shadow = document.getElementById('golens-project-search-root').shadowRoot;
  assert.equal(shadow.querySelector('.loading-progress-phase').textContent, 'Full-project search failed');
});

test('Retry button re-runs the search after a failure', async () => {
  buildFixture();
  let attempt = 0;
  const legacy = fakeLegacy({
    async searchProjectBlobPaths(term, ref, opts) {
      attempt++;
      legacy.calls.searchProjectBlobPaths.push({ term, ref, opts });
      return attempt === 1 ? { paths: [], status: 'limited' } : { paths: [`${term}/x.go`], status: 'complete' };
    },
  });
  const handle = mount({ legacy });
  const outcome = handle.open(referencesResult(), pointer);
  await outcome.ready;
  const shadow = document.getElementById('golens-project-search-root').shadowRoot;
  assert.equal(shadow.querySelector('.full-search-retry').hidden, false);

  shadow.querySelector('.full-search-retry').click();
  await flush();
  assert.equal(legacy.calls.showResult.length, 1, 'second attempt succeeded and refreshed the popover');
});

test('open(): a second open() aborts the first in-flight search', async () => {
  buildFixture();
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

test('minimize (header button) hides the dialog and shows the progress chip; the chip restores it', async () => {
  buildFixture();
  const legacy = fakeLegacy({
    async searchProjectBlobPaths() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { paths: [], status: 'complete' };
    },
  });
  const handle = mount({ legacy });
  const outcome = handle.open(referencesResult(), pointer);
  const shadow = document.getElementById('golens-project-search-root').shadowRoot;

  shadow.querySelector('.full-search-minimize').click();
  assert.equal(shadow.querySelector('.full-search-backdrop').hidden, true);
  assert.equal(shadow.querySelector('.full-search-chip').hidden, false);

  shadow.querySelector('.full-search-chip').click();
  assert.equal(shadow.querySelector('.full-search-backdrop').hidden, false);
  assert.equal(shadow.querySelector('.full-search-chip').hidden, true);

  await outcome.ready;
});

// go-navigation.js's own document-level Escape handler calls this directly
// (it can no longer reach `.full-search-backdrop` itself once the modal DOM
// moved into this module's own shadow host) for the one case its own
// composedPath-based guard does not already suppress: focus has moved off
// the dialog (e.g. a backdrop click) without closing it. See
// project-search.js's header comment for the full trace of why that branch
// is real, reachable go-navigation.js behavior, not dead code.
test('minimize(): the handle method go-navigation.js\'s Escape handler calls — same DOM effects as the header button', async () => {
  buildFixture();
  const legacy = fakeLegacy({
    async searchProjectBlobPaths() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { paths: [], status: 'complete' };
    },
  });
  const handle = mount({ legacy });
  const outcome = handle.open(referencesResult(), pointer);
  const shadow = document.getElementById('golens-project-search-root').shadowRoot;

  const result = handle.minimize();
  assert.deepEqual(result, { kind: 'minimized' });
  assert.equal(shadow.querySelector('.full-search-backdrop').hidden, true);
  assert.equal(shadow.querySelector('.full-search-chip').hidden, false);

  await outcome.ready;
});

test('minimize(): not-open when nothing is running; unavailable without ctx.legacy', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  assert.deepEqual(handle.minimize(), { kind: 'not-open' });

  const inert = mount({});
  assert.deepEqual(inert.minimize(), { kind: 'unavailable' });
});

test('close(): aborts the in-flight search, hides the dialog, restores the original popover result, and toasts', async () => {
  buildFixture();
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

  const host = document.getElementById('golens-project-search-root');
  assert.equal(host.shadowRoot.querySelector('.full-search-backdrop').hidden, true);
  assert.equal(host.shadowRoot.querySelector('.full-search-chip').hidden, true);

  await outcome.ready;
  // The aborted search's own catch must not re-show an error after close().
  assert.equal(legacy.calls.showResult.length, 1);
});

test('close(): not-open when nothing is running', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  assert.deepEqual(handle.close(), { kind: 'not-open' });
});

test('close({restorePopover: false}): aborts and hides silently, without touching the legacy popover (navigation/unmount cleanup path)', async () => {
  buildFixture();
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

test('the in-dialog Cancel button calls close() with the default (restorePopover: true)', async () => {
  buildFixture();
  const legacy = fakeLegacy({
    async searchProjectBlobPaths() {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { paths: [], status: 'complete' };
    },
  });
  const handle = mount({ legacy });
  const outcome = handle.open(referencesResult(), pointer);
  const shadow = document.getElementById('golens-project-search-root').shadowRoot;
  shadow.querySelector('.full-search-cancel').click();
  assert.equal(legacy.calls.toast.length, 1);
  await outcome.ready;
});

test('unmount(): aborts any in-flight search and removes the modal host; mount-after-unmount is safe', async () => {
  buildFixture();
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
  assert.equal(document.getElementById('golens-project-search-root'), null);
  assert.doesNotThrow(() => handle.unmount());
  await outcome.ready;
  assert.equal(legacy.calls.showResult.length, 0, 'unmount does not touch the legacy popover');

  const legacyB = fakeLegacy();
  const handleB = mount({ legacy: legacyB });
  const outcomeB = handleB.open(referencesResult(), pointer);
  assert.equal(outcomeB.kind, 'started');
  await outcomeB.ready;
  assert.ok(document.getElementById('golens-project-search-root'));
});

test('open() after unmount() degrades to unavailable', () => {
  buildFixture();
  const legacy = fakeLegacy();
  const handle = mount({ legacy });
  handle.unmount();
  assert.deepEqual(handle.open(referencesResult(), pointer), { kind: 'unavailable' });
});
