import { Language, Parser } from './vendor/web-tree-sitter.js';
import { GoSemanticSourceCache, isCommitSHA } from './go-semantic-cache.js';
import { GoSemanticIndex } from './go-semantic-core.js';
import { syncSelfHostedContentScripts } from './gitlab-host-access.js';

let indexPromise;
let mutationQueue = Promise.resolve();
const sourceCache = new GoSemanticSourceCache();
const MUTATING_METHODS = new Set([
  'clearCache', 'cachePackage', 'cacheProject', 'cacheMergeRequest', 'indexPackage', 'indexProject',
  'restorePackage', 'restoreProject', 'restoreMergeRequest', 'disposeProject', 'prepareSources',
  'projectCacheStatus', 'mergeRequestCacheStatus', 'packageCacheStatus',
]);

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
    return sourceCache.packageStatus(params);
  }
  if (method === 'clearCache') {
    const cleared = await sourceCache.clear();
    if (indexPromise) (await semanticIndex()).clear();
    return cleared;
  }
  const index = await semanticIndex();
  if (method === 'indexPackage') return index.indexPackage(params);
  if (method === 'indexProject') return index.indexProject(params);
  if (method === 'restorePackage') {
    if (!isCommitSHA(params.ref)) return { status: 'cacheMiss' };
    if (index.hasPackage(params)) return { status: 'memoryHit' };
    const snapshot = await sourceCache.readPackage(params);
    if (!snapshot) return { status: 'cacheMiss' };
    return { ...index.indexPackage({ ...params, ...snapshot }), status: 'cacheHit' };
  }
  if (method === 'restoreProject') {
    if (!isCommitSHA(params.ref)) return { status: 'cacheMiss' };
    if (index.hasProject(params)) return { status: 'memoryHit' };
    const snapshot = await sourceCache.readProject(params);
    if (!snapshot) return { status: 'cacheMiss' };
    return { ...index.indexProject({ ...params, ...snapshot }), status: 'cacheHit' };
  }
  if (method === 'restoreMergeRequest') {
    if (!isCommitSHA(params.ref)) return { status: 'cacheMiss' };
    const manifest = await sourceCache.readMergeRequest(params);
    if (!manifest) return { status: 'cacheMiss' };
    if (manifest.coverage === 'full') {
      if (index.hasProject(params)) return { status: 'memoryHit', coverage: 'full' };
      const snapshot = await sourceCache.readProject(params);
      if (!snapshot) return { status: 'cacheMiss' };
      return { ...index.indexProject({ ...params, ...snapshot }), status: 'cacheHit', coverage: 'full' };
    }
    const missing = manifest.packagePaths.filter((packagePath) => !index.hasPackage({ ...params, packagePath }));
    let definitions = 0;
    for (const packagePath of missing) {
      const snapshot = await sourceCache.readPackage({ ...params, packagePath });
      if (!snapshot) return { status: 'cacheMiss' };
      definitions += index.indexPackage({ ...params, packagePath, ...snapshot }).definitions;
    }
    return {
      status: missing.length ? 'cacheHit' : 'memoryHit',
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
    return index.indexPackage({ ...params, ...snapshot });
  }
  if (method === 'cacheProject') {
    if (!isCommitSHA(params.ref)) return index.indexProject(params);
    await sourceCache.writeProject(params);
    const snapshot = await sourceCache.readProject(params);
    if (!snapshot) throw new Error('Cached Go project snapshot is incomplete');
    return index.indexProject({ ...params, ...snapshot });
  }
  if (method === 'cacheMergeRequest') {
    if (!isCommitSHA(params.ref)) return { status: 'missing' };
    await sourceCache.writeMergeRequest(params);
    return sourceCache.mergeRequestStatus(params);
  }
  if (method === 'packageRelations') return index.packageRelations(params);
  if (method === 'resolveDefinition' || method === 'resolveHover') return index.resolve(params);
  if (method === 'findReferences') return index.findReferences(params);
  if (method === 'findImplementations') return index.findImplementations(params);
  if (method === 'disposeProject') return index.disposeProject(params);
  throw new Error(`Unknown semantic worker method: ${method}`);
}

function dispatch(method, params = {}) {
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
