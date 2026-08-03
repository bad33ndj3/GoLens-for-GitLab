// Minimal in-memory IndexedDB fake, covering only the surface
// `go-semantic-cache.js` actually uses: `indexedDB.open` with
// `onupgradeneeded`, object stores with `get`/`put`/`delete`/`clear`/
// `count`/`openCursor`, and transactions with `oncomplete`.
//
// Real IndexedDB requests never resolve synchronously — every request
// completes on a later task, and a transaction auto-commits once its
// queued requests have all settled and no new one was queued in the same
// tick. This fake reproduces that shape with an artificial per-request
// delay (`REQUEST_DELAY_MS`, via `setImmediate` — a macrotask, not a
// microtask) so that sequential vs. batched IDB access patterns actually
// show up in benchmark timings, matching finding #5
// (`mergeRequestStatus` looping `packageStatus` sequentially).
//
// Only used by benchmarks: production code always talks to the real
// `globalThis.indexedDB` (or the in-memory Map fallback inside
// `GoSemanticSourceCache` when no `indexedDB` is supplied).

const REQUEST_DELAY_MS = 1;

function scheduleRequestWork(work) {
  setTimeout(work, REQUEST_DELAY_MS);
}

function makeRequest() {
  return { result: undefined, error: undefined, onsuccess: null, onerror: null };
}

function fulfil(request, result) {
  request.result = result;
  scheduleRequestWork(() => request.onsuccess?.());
}

class FakeObjectStore {
  constructor(transaction, records) {
    this.transaction = transaction;
    this.records = records;
  }

  get(id) {
    const request = makeRequest();
    this.transaction._track();
    scheduleRequestWork(() => {
      request.result = this.records.get(id);
      request.onsuccess?.();
      this.transaction._settle();
    });
    return request;
  }

  put(record) {
    const request = makeRequest();
    this.transaction._track();
    scheduleRequestWork(() => {
      this.records.set(record.id, record);
      fulfil(request, record.id);
      this.transaction._settle();
    });
    return request;
  }

  delete(id) {
    const request = makeRequest();
    this.transaction._track();
    scheduleRequestWork(() => {
      this.records.delete(id);
      request.onsuccess?.();
      this.transaction._settle();
    });
    return request;
  }

  clear() {
    const request = makeRequest();
    this.transaction._track();
    scheduleRequestWork(() => {
      this.records.clear();
      request.onsuccess?.();
      this.transaction._settle();
    });
    return request;
  }

  count() {
    const request = makeRequest();
    this.transaction._track();
    scheduleRequestWork(() => {
      request.result = this.records.size;
      request.onsuccess?.();
      this.transaction._settle();
    });
    return request;
  }

  openCursor() {
    const request = makeRequest();
    const entries = [...this.records.values()];
    let index = 0;
    this.transaction._track();
    const step = () => {
      if (index >= entries.length) {
        request.result = null;
        request.onsuccess?.();
        this.transaction._settle();
        return;
      }
      const value = entries[index++];
      request.result = {
        value,
        continue: () => {
          this.transaction._track();
          scheduleRequestWork(step);
        },
      };
      // onsuccess runs synchronously here; if the handler calls
      // cursor.continue() (the usual pattern), that re-tracks the
      // transaction as pending *before* we settle this step below, so the
      // net pending count stays accurate.
      request.onsuccess?.();
      this.transaction._settle();
    };
    scheduleRequestWork(step);
    return request;
  }
}

class FakeTransaction {
  constructor(database, storeNames) {
    this.database = database;
    this.storeNames = storeNames;
    this.oncomplete = null;
    this.onabort = null;
    this.onerror = null;
    this.error = null;
    this._pending = 0;
    this._settledOnce = false;
    // A transaction with zero requests must still complete.
    queueMicrotask(() => this._maybeComplete());
  }

  objectStore(name) {
    if (!this.storeNames.includes(name)) throw new Error(`Transaction does not include store ${name}`);
    return new FakeObjectStore(this, this.database.stores.get(name));
  }

  _track() {
    this._pending++;
    this._settledOnce = true;
  }

  _settle() {
    this._pending--;
    this._maybeComplete();
  }

  _maybeComplete() {
    if (this._pending > 0 || this._completed) return;
    // Give any synchronously-chained request another tick to register
    // before declaring the transaction done, mirroring real IDB
    // auto-commit semantics.
    queueMicrotask(() => {
      if (this._pending > 0 || this._completed) return;
      this._completed = true;
      this.oncomplete?.();
    });
  }
}

class FakeDatabase {
  constructor() {
    this.stores = new Map();
    this.objectStoreNames = {
      contains: (name) => this.stores.has(name),
    };
  }

  createObjectStore(name) {
    this.stores.set(name, new Map());
  }

  deleteObjectStore(name) {
    this.stores.delete(name);
  }

  transaction(storeNames, _mode) {
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    return new FakeTransaction(this, names);
  }
}

/** A drop-in fake for `globalThis.indexedDB`, scoped to one fresh database per instance. */
export class FakeIndexedDB {
  open(_name, _version) {
    const request = makeRequest();
    const database = new FakeDatabase();
    request.result = database;
    scheduleRequestWork(() => {
      request.onupgradeneeded?.({ target: request });
      scheduleRequestWork(() => request.onsuccess?.());
    });
    return request;
  }
}
