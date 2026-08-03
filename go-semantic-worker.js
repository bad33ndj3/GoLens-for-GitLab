import { Language, Parser } from './vendor/web-tree-sitter.js';
import { GoSemanticSourceCache, isCommitSHA } from './go-semantic-cache.js';
import { GoSemanticIndex, INDEX_FORMAT_VERSION } from './go-semantic-core.js';
import { syncSelfHostedContentScripts } from './gitlab-host-access.js';

const INDEX_DATABASE_NAME = 'golens-go-semantic-index';
const INDEX_DATABASE_VERSION = 1;
const INDEXES_STORE = 'indexes';

// packagePath defaults to '' for a whole-project scope; a present
// packagePath keys a package-scoped snapshot separately, so caching one
// package only ever writes that package's data, not the whole project's
// (see GoSemanticIndex.serializeProject's packagePath parameter).
function indexRecordID({ origin = '', project, ref, packagePath = '' }) {
  return JSON.stringify([INDEX_FORMAT_VERSION, origin, project, ref, packagePath]);
}

function openIndexDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(INDEX_DATABASE_NAME, INDEX_DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(INDEXES_STORE)) database.createObjectStore(INDEXES_STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open semantic index store'));
  });
}

// Durable store for GoSemanticIndex.serializeProject blobs, keyed by
// (origin, project, ref) and separate from the source-cache database: a
// restore here skips re-parsing entirely, whereas the source cache always
// feeds raw text back through the parser. A missing indexedDB (as in tests)
// falls back to an in-memory Map, mirroring GoSemanticSourceCache.
export class GoSemanticIndexStore {
  constructor({ indexedDB = globalThis.indexedDB } = {}) {
    this.databasePromise = indexedDB ? openIndexDatabase(indexedDB) : null;
    this.memory = new Map();
  }

  async read(scope) {
    const id = indexRecordID(scope);
    if (!this.databasePromise) return this.memory.get(id)?.blob || null;
    const database = await this.databasePromise;
    const transaction = database.transaction(INDEXES_STORE, 'readonly');
    const store = transaction.objectStore(INDEXES_STORE);
    const record = await new Promise((resolve, reject) => {
      const request = store.get(id);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Unable to read semantic index store'));
    });
    return record?.blob || null;
  }

  async write(scope, blob) {
    const record = { id: indexRecordID(scope), blob };
    if (!this.databasePromise) {
      this.memory.set(record.id, record);
      return;
    }
    const database = await this.databasePromise;
    const transaction = database.transaction(INDEXES_STORE, 'readwrite');
    const complete = new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('Unable to write semantic index store'));
      transaction.onerror = () => reject(transaction.error || new Error('Unable to write semantic index store'));
    });
    transaction.objectStore(INDEXES_STORE).put(record);
    await complete;
  }

  async clear() {
    if (!this.databasePromise) {
      this.memory.clear();
      return;
    }
    const database = await this.databasePromise;
    const transaction = database.transaction(INDEXES_STORE, 'readwrite');
    const complete = new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('Unable to clear semantic index store'));
      transaction.onerror = () => reject(transaction.error || new Error('Unable to clear semantic index store'));
    });
    transaction.objectStore(INDEXES_STORE).clear();
    await complete;
  }
}

let indexPromise;
let mutationQueue = Promise.resolve();
const sourceCache = new GoSemanticSourceCache();
const indexStore = new GoSemanticIndexStore();
const MUTATING_METHODS = new Set([
  'clearCache', 'cachePackage', 'cacheProject', 'cacheMergeRequest', 'indexPackage', 'indexProject',
  'restorePackage', 'restoreProject', 'restoreMergeRequest', 'disposeProject', 'prepareSources',
]);
// Storage-only status reads: side-effect-free since cache reads were made
// batched and non-mutating (ticket 02), so they must not wait behind an
// in-flight caching job's mutation queue at all — not even without
// extending it, which is all removing them from MUTATING_METHODS would
// achieve. Resolution and search deliberately keep waiting on the queue
// (they are simply absent from MUTATING_METHODS, same as before): project
// caching interleaves staging, indexing and writing, and a query that
// bypassed the queue could observe a half-populated index.
const NON_QUEUED_METHODS = new Set(['projectCacheStatus', 'mergeRequestCacheStatus', 'packageCacheStatus']);

function asset(name) {
  const url = new URL(name, import.meta.url);
  return url.protocol === 'file:' ? decodeURIComponent(url.pathname) : url.href;
}

async function semanticIndex() {
  if (!indexPromise) {
    const initialization = (async () => {
      await Parser.init({ locateFile: () => asset('./vendor/web-tree-sitter.wasm') });
      const parser = new Parser();
      parser.setLanguage(await Language.load(asset('./vendor/tree-sitter-go.wasm')));
      return new GoSemanticIndex(parser);
    })();
    indexPromise = initialization.catch((error) => {
      indexPromise = undefined;
      throw error;
    });
  }
  return indexPromise;
}

function resultScope(index, params, mode) {
  const supplied = params.scope;
  if (supplied && ['currentPackage', 'indexedPackages', 'completeProjectSearch', 'fullProject'].includes(supplied.kind)) {
    const inferred = index.searchScope({ ...params, mode });
    return {
      kind: supplied.kind,
      packagePath: supplied.packagePath || '',
      packageCount: inferred.packageCount,
      complete: ['completeProjectSearch', 'fullProject'].includes(supplied.kind) ? supplied.complete === true : supplied.complete !== false,
      ...(supplied.searchStatus ? { searchStatus: supplied.searchStatus } : {}),
      ...(supplied.strategy ? { strategy: supplied.strategy } : {}),
    };
  }
  return index.searchScope({ ...params, mode });
}

function withResultScope(index, params, mode, result) {
  return { ...result, scope: resultScope(index, params, mode) };
}

// Snapshots every package currently indexed for (origin, project, ref) into
// the durable index store, so the next worker start can restore it without
// re-parsing. Only ever called for commit-pinned scopes (mirroring the
// source cache), and only after a successful index mutation.
async function persistIndex(index, scope) {
  const blob = index.serializeProject(scope);
  if (blob) await indexStore.write(scope, blob);
}

// Attempts to populate `index` from the durable store before falling back to
// the source cache's reparse path. Returns the restore summary on success or
// null on a store miss / format-version mismatch, leaving the index
// untouched in the null case so the existing reparse path remains the
// correctness backstop.
async function restoreFromIndexStore(index, scope) {
  const blob = await indexStore.read(scope);
  if (!blob) return null;
  return index.restoreIndex(blob);
}

async function performDispatch(method, params = {}) {
  if (!method) throw new Error('Semantic worker method is required');
  if (method === 'cacheStats') return sourceCache.stats();
  if (method === 'prepareSources') {
    if (!isCommitSHA(params.ref)) {
      return { total: params.files?.length || 0, cached: 0, missing: (params.files || []).map((file) => ({ ...file, referencedFiles: 1 })) };
    }
    return sourceCache.prepareSources(params);
  }
  if (method === 'projectCacheStatus') {
    if (!isCommitSHA(params.ref)) return { status: 'missing' };
    return params.mergeRequest ? sourceCache.mergeRequestStatus(params) : sourceCache.projectStatus(params);
  }
  if (method === 'mergeRequestCacheStatus') {
    if (!isCommitSHA(params.ref)) return { status: 'missing' };
    return sourceCache.mergeRequestStatus(params);
  }
  if (method === 'packageCacheStatus') {
    if (!isCommitSHA(params.ref)) return { status: 'missing' };
    // Warm path: the package is already indexed in memory, so skip the
    // storage round trip entirely. Only consult the index if it's already
    // initialized — checking here must never force the WASM parser to load.
    if (indexPromise && (await indexPromise).hasPackage(params)) return { status: 'complete' };
    return sourceCache.packageStatus(params);
  }
  if (method === 'clearCache') {
    const cleared = await sourceCache.clear();
    await indexStore.clear();
    if (indexPromise) (await semanticIndex()).clear();
    return cleared;
  }
  const index = await semanticIndex();
  if (method === 'indexPackage') return index.indexPackage(params);
  if (method === 'indexProject') return index.indexProject(params);
  if (method === 'restorePackage') {
    if (!isCommitSHA(params.ref)) return { status: 'cacheMiss' };
    if (index.hasPackage(params)) return { status: 'memoryHit' };
    const restored = await restoreFromIndexStore(index, params);
    if (restored && index.hasPackage(params)) return { ...restored, status: 'cacheHit' };
    const snapshot = await sourceCache.readPackage(params);
    if (!snapshot) return { status: 'cacheMiss' };
    const result = index.indexPackage({ ...params, ...snapshot });
    await persistIndex(index, params);
    return { ...result, status: 'cacheHit' };
  }
  if (method === 'restoreProject') {
    if (!isCommitSHA(params.ref)) return { status: 'cacheMiss' };
    if (index.hasProject(params)) return { status: 'memoryHit' };
    const restored = await restoreFromIndexStore(index, params);
    if (restored && index.hasProject(params)) return { ...restored, status: 'cacheHit' };
    const snapshot = await sourceCache.readProject(params);
    if (!snapshot) return { status: 'cacheMiss' };
    const result = index.indexProject({ ...params, ...snapshot });
    await persistIndex(index, params);
    return { ...result, status: 'cacheHit' };
  }
  if (method === 'restoreMergeRequest') {
    if (!isCommitSHA(params.ref)) return { status: 'cacheMiss' };
    const manifest = await sourceCache.readMergeRequest(params);
    if (!manifest) return { status: 'cacheMiss' };
    if (manifest.coverage === 'full') {
      if (index.hasProject(params)) return { status: 'memoryHit', coverage: 'full' };
      const restored = await restoreFromIndexStore(index, params);
      if (restored && index.hasProject(params)) return { ...restored, status: 'cacheHit', coverage: 'full' };
      const snapshot = await sourceCache.readProject(params);
      if (!snapshot) return { status: 'cacheMiss' };
      const result = index.indexProject({ ...params, ...snapshot });
      await persistIndex(index, params);
      return { ...result, status: 'cacheHit', coverage: 'full' };
    }
    const initiallyMissing = manifest.packagePaths.filter((packagePath) => !index.hasPackage({ ...params, packagePath }));
    for (const packagePath of initiallyMissing) {
      if (!index.hasPackage({ ...params, packagePath })) await restoreFromIndexStore(index, { ...params, packagePath });
      if (!index.hasPackage({ ...params, packagePath })) {
        const snapshot = await sourceCache.readPackage({ ...params, packagePath });
        if (!snapshot) return { status: 'cacheMiss' };
        index.indexPackage({ ...params, packagePath, ...snapshot });
        // Package-scoped, matching cachePackage: caching one package's worth
        // of durable work should never re-serialize the whole scope.
        await persistIndex(index, { ...params, packagePath });
      }
    }
    // Read back from the index rather than accumulating indexPackage's
    // per-call results, since a package restored from the durable store
    // never runs indexPackage in this call — this way every package's count
    // is counted the same way regardless of which path supplied it.
    const definitions = manifest.packagePaths.reduce((total, packagePath) => total + index.packageDefinitionCount({ ...params, packagePath }), 0);
    return {
      status: initiallyMissing.length ? 'cacheHit' : 'memoryHit',
      coverage: 'related',
      searchStatus: manifest.searchStatus,
      packages: manifest.packagePaths.length,
      definitions,
    };
  }
  if (method === 'cachePackage') {
    if (!isCommitSHA(params.ref)) return index.indexPackage(params);
    await sourceCache.writePackage(params);
    const snapshot = await sourceCache.readPackage(params);
    if (!snapshot) throw new Error('Cached Go package snapshot is incomplete');
    const result = index.indexPackage({ ...params, ...snapshot });
    // Package-scoped: caching one package must not re-serialize the whole
    // project's index (see GoSemanticIndex.serializeProject's packagePath).
    await persistIndex(index, params);
    return result;
  }
  if (method === 'cacheProject') {
    if (!isCommitSHA(params.ref)) return index.indexProject(params);
    const staged = await sourceCache.stageProject(params);
    const result = index.indexProject({ ...params, ...staged });
    try {
      await sourceCache.writeProject(params);
      const snapshot = await sourceCache.readProject(params);
      if (!snapshot) throw new Error('Cached Go project snapshot is incomplete');
      await persistIndex(index, params);
      return result;
    } catch (error) {
      index.disposeProject(params);
      throw error;
    }
  }
  if (method === 'cacheMergeRequest') {
    if (!isCommitSHA(params.ref)) return { status: 'missing' };
    await sourceCache.writeMergeRequest(params);
    return sourceCache.mergeRequestStatus(params);
  }
  if (method === 'packageRelations') return index.packageRelations(params);
  if (method === 'resolveDefinition' || method === 'resolveHover') {
    return withResultScope(index, params, 'package', index.resolve(params));
  }
  if (method === 'findReferences') return withResultScope(index, params, 'project', index.findReferences(params));
  if (method === 'findImplementations') return withResultScope(index, params, 'project', index.findImplementations(params));
  if (method === 'disposeProject') return index.disposeProject(params);
  throw new Error(`Unknown semantic worker method: ${method}`);
}

function dispatch(method, params = {}) {
  if (NON_QUEUED_METHODS.has(method)) return performDispatch(method, params);
  if (!MUTATING_METHODS.has(method)) return mutationQueue.then(() => performDispatch(method, params));
  const operation = mutationQueue.then(() => performDispatch(method, params));
  mutationQueue = operation.catch(() => undefined);
  return operation;
}

function respondToRuntimeMessage(message, sendResponse) {
  if (message?.type === 'golens-sync-host-access') {
    syncSelfHostedContentScripts()
      .then((origins) => sendResponse({ ok: true, result: { origins } }))
      .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  if (message?.type !== 'golens-cache-stats' && message?.type !== 'golens-clear-cache') return false;
  const method = message.type === 'golens-cache-stats' ? 'cacheStats' : 'clearCache';
  dispatch(method)
    .then((result) => sendResponse({ ok: true, result }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  return true;
}

globalThis.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => respondToRuntimeMessage(message, sendResponse));
globalThis.chrome?.permissions?.onAdded?.addListener(() => syncSelfHostedContentScripts().catch(() => undefined));
globalThis.chrome?.permissions?.onRemoved?.addListener(() => syncSelfHostedContentScripts().catch(() => undefined));
syncSelfHostedContentScripts().catch(() => undefined);

if (globalThis.chrome?.runtime?.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'golens-go-rpc') return;
    port.onMessage.addListener(({ id, method, params }) => {
      dispatch(method, params)
        .then((result) => port.postMessage({ id, ok: true, result }))
        .catch((error) => port.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) }));
    });
  });
} else {
  self.addEventListener('message', async (event) => {
    const { id, method, params } = event.data || {};
    if (!id || !method) return;
    try {
      self.postMessage({ id, ok: true, result: await dispatch(method, params) });
    } catch (error) {
      self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
