import assert from 'node:assert/strict';
import { test } from 'node:test';

await import('../bookmark-store.js?bookmark-store-test');
const bookmarks = globalThis.GoLensBookmarks;

function memoryStorage(events = []) {
  const values = {};
  return {
    values,
    async get(keys) {
      if (keys === null) return { ...values };
      if (typeof keys === 'string') return { [keys]: values[keys] };
      return { ...(keys || {}), ...values };
    },
    async set(next) { events.push(['set', Object.keys(next)]); Object.assign(values, next); },
    async remove(keys) {
      const list = Array.isArray(keys) ? keys : [keys];
      events.push(['remove', list]);
      list.forEach((key) => delete values[key]);
    },
  };
}

const scope = {
  origin: 'https://gitlab.example',
  project: 'group/project',
  mrIid: '42',
  headSha: 'a'.repeat(40),
};
const location = { path: 'README.md', side: 'new', startLine: 8, endLine: 9 };
const anchor = { selectionHash: '1'.repeat(64), beforeHash: '2'.repeat(64), afterHash: '3'.repeat(64), symbol: '' };

test('validates bookmark scope, location, and bounded recovery metadata', async () => {
  assert.deepEqual(bookmarks.normalizeScope(scope), scope);
  assert.equal(bookmarks.normalizeScope({ ...scope, headSha: 'main' }), null);
  assert.deepEqual(bookmarks.normalizeLocation(location), location);
  assert.equal(bookmarks.normalizeLocation({ ...location, endLine: 7 }), null);
  assert.equal(bookmarks.normalizeAnchor({ selectionHash: 'source text' }), null);
  assert.match(await bookmarks.hashText('line\r\n'), /^[0-9a-f]{64}$/);
});

test('stores each bookmark separately and isolates merge requests and heads', async () => {
  const storage = memoryStorage();
  let nextID = 0;
  const store = bookmarks.createStore({ storage, id: () => `bookmark-${++nextID}`, now: () => 100 });
  const added = await store.toggle({ scope, location, anchor });
  assert.equal(added.action, 'added');
  assert.equal(Object.keys(storage.values).length, 1);
  assert.ok(Object.keys(storage.values)[0].startsWith(bookmarks.KEY_PREFIX));

  const otherHead = { ...scope, headSha: 'b'.repeat(40) };
  await store.toggle({ scope: otherHead, location: { ...location, startLine: 12, endLine: 12 }, anchor });
  assert.equal((await store.list(scope)).length, 2, 'all heads of the same MR are returned for stale handling');
  assert.equal((await store.list({ ...scope, mrIid: '43' })).length, 0);

  const removed = await store.toggle({ scope, location, anchor });
  assert.equal(removed.action, 'removed');
  assert.equal((await store.list(scope)).length, 1);
});

test('clears current, stale, or all records and recovers with write before delete', async () => {
  const events = [];
  const storage = memoryStorage(events);
  let nextID = 0;
  const store = bookmarks.createStore({ storage, id: () => `bookmark-${++nextID}`, now: () => nextID });
  const stale = (await store.toggle({ scope, location, anchor })).record;
  const currentScope = { ...scope, headSha: 'b'.repeat(40) };
  await store.toggle({ scope: currentScope, location: { ...location, startLine: 15, endLine: 15 }, anchor });
  assert.equal(await store.clear(currentScope, 'current'), 1);
  assert.equal((await store.list(currentScope)).length, 1);

  events.length = 0;
  await store.recover(stale, { scope: currentScope, location: { ...location, startLine: 10, endLine: 11 }, anchor });
  assert.equal(events[0][0], 'set');
  assert.equal(events[1][0], 'remove');
  assert.equal((await store.list(currentScope))[0].scope.headSha, currentScope.headSha);
  assert.equal(await store.clear(currentScope, 'stale'), 0);
  assert.equal(await store.clear(currentScope, 'all'), 1);
});

test('notifies only for bookmark changes in local storage', () => {
  let listener;
  let calls = 0;
  const storageChanges = {
    addListener(next) { listener = next; },
    removeListener(next) { assert.equal(next, listener); },
  };
  const store = bookmarks.createStore({ storage: memoryStorage(), storageChanges });
  const unsubscribe = store.subscribe(() => calls++);
  listener({ enabled: { newValue: true } }, 'sync');
  listener({ golensOnboardingVersion: { newValue: 11 } }, 'local');
  listener({ [`${bookmarks.KEY_PREFIX}record`]: { newValue: {} } }, 'local');
  assert.equal(calls, 1);
  unsubscribe();
});
