// platform/rpc-client — the one port to the worker. Hides: {id,method,params}
// framing, port lifecycle/reconnect, in-flight bookkeeping, the test-only
// postMessage fallback transport. Per ticket 04 §2:
//   createRpcClient({ connect, onDisconnect }) -> {
//     query: { resolveDefinition, resolveHover, findReferences,
//              findImplementations, packageRelations },
//     cache: { cacheStats, projectCacheStatus, mergeRequestCacheStatus,
//              packageCacheStatus, prepareSources, clearCache, cachePackage,
//              cacheProject, cacheMergeRequest, restorePackage,
//              restoreProject, restoreMergeRequest },
//     index: { indexPackage, indexProject, disposeProject },
//     dispose(),
//   }
//
// Every method is async, params is an object 1:1 with today's wire params;
// wire payloads do not change. Infra failures (port gone, timeout, a thrown
// exception on the worker side) reject with RpcUnavailableError — domain
// outcomes stay ordinary `kind`-discriminated return values produced by the
// worker itself and are passed through unchanged.
//
// `onDisconnect` is a deviation from ticket 04 §2's literal signature (which
// lists only `connect`), added because go-navigation.js's temporary bridge
// owns package/project promise caches that must be invalidated when the
// worker's service instance restarts — the same notification the old inline
// `port.onDisconnect` listener drove. It fires once per disconnect, after all
// in-flight calls have been rejected, and never fires from `dispose()`
// (matching today's behaviour: a caller-initiated `port.disconnect()` does
// not invoke Chrome's `onDisconnect` listener either).

const METHOD_NAMESPACE = {
  resolveDefinition: 'query',
  resolveHover: 'query',
  findReferences: 'query',
  findImplementations: 'query',
  packageRelations: 'query',

  cacheStats: 'cache',
  projectCacheStatus: 'cache',
  mergeRequestCacheStatus: 'cache',
  packageCacheStatus: 'cache',
  prepareSources: 'cache',
  clearCache: 'cache',
  cachePackage: 'cache',
  cacheProject: 'cache',
  cacheMergeRequest: 'cache',
  restorePackage: 'cache',
  restoreProject: 'cache',
  restoreMergeRequest: 'cache',

  indexPackage: 'index',
  indexProject: 'index',
  disposeProject: 'index',
};

// Same wire methods that carry the long timeout today (go-navigation.js's
// former `workerRPC`), preserved verbatim.
const LONG_TIMEOUT_METHODS = new Set([
  'indexProject', 'cacheProject', 'restoreProject', 'restoreMergeRequest',
  'projectCacheStatus', 'mergeRequestCacheStatus', 'cacheMergeRequest',
  'packageCacheStatus', 'prepareSources',
]);

const LONG_TIMEOUT_MS = 120000;
const SHORT_TIMEOUT_MS = 20000;

export class RpcUnavailableError extends Error {}

export function createRpcClient({ connect, onDisconnect } = {}) {
  let port = null;
  let rpcID = 0;
  const pending = new Map();

  function ensurePort() {
    if (port) return port;
    port = connect();
    port.onMessage.addListener((response) => {
      const call = pending.get(response.id);
      if (!call) return;
      clearTimeout(call.timeout);
      pending.delete(response.id);
      if (response.ok) call.resolve(response.result);
      else call.reject(new RpcUnavailableError(response.error || 'Go semantic service failed'));
    });
    port.onDisconnect.addListener(() => {
      const error = new RpcUnavailableError(
        globalThis.chrome?.runtime?.lastError?.message || 'Go semantic service disconnected',
      );
      for (const call of pending.values()) {
        clearTimeout(call.timeout);
        call.reject(error);
      }
      pending.clear();
      port = null;
      onDisconnect?.();
    });
    return port;
  }

  function call(method, params) {
    const activePort = ensurePort();
    const id = ++rpcID;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new RpcUnavailableError('Go semantic service timed out'));
      }, LONG_TIMEOUT_METHODS.has(method) ? LONG_TIMEOUT_MS : SHORT_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timeout });
      activePort.postMessage({ id, method, params });
    });
  }

  function namespaceOf(methods) {
    const ns = {};
    for (const method of methods) ns[method] = (params) => call(method, params);
    return ns;
  }

  const query = namespaceOf(['resolveDefinition', 'resolveHover', 'findReferences', 'findImplementations', 'packageRelations']);
  const cache = namespaceOf(['cacheStats', 'projectCacheStatus', 'mergeRequestCacheStatus', 'packageCacheStatus', 'prepareSources', 'clearCache', 'cachePackage', 'cacheProject', 'cacheMergeRequest', 'restorePackage', 'restoreProject', 'restoreMergeRequest']);
  const index = namespaceOf(['indexPackage', 'indexProject', 'disposeProject']);

  // `reason` lets the bridge preserve today's teardown-specific rejection
  // text ("Go intelligence request cancelled") instead of the generic
  // disconnect message — a second addendum to ticket 04 §2 alongside
  // `onDisconnect`, for the same reason: the wire contract is unaffected,
  // only the message surfaced through the existing infra-failure rejection.
  function dispose({ reason } = {}) {
    for (const call of pending.values()) {
      clearTimeout(call.timeout);
      call.reject(new RpcUnavailableError(reason || 'Go semantic service disconnected'));
    }
    pending.clear();
    port?.disconnect();
    port = null;
  }

  return { query, cache, index, dispose };
}

// Exposed for go-navigation.js's temporary bridge, which still dispatches by
// a dynamic wire-method-name string (e.g. `resolveAt(target, 'resolveHover',
// …)`) rather than calling `client.query.resolveHover(...)` directly.
export function methodNamespace(method) {
  return METHOD_NAMESPACE[method];
}
