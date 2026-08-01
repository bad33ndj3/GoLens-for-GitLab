import { startGoIntelligenceWorker } from './go-intelligence/index.ts';
import { ACTIVE_ARCHITECTURE_EPOCH, createStorageResetCoordinator } from './storage-reset.ts';

type WorkerRuntime = Pick<typeof chrome.runtime, 'onMessage'>;

export function startWorkerEntry({
  start = startGoIntelligenceWorker,
  runtime = chrome.runtime as WorkerRuntime,
  sync = chrome.storage.sync,
  local = chrome.storage.local,
  epoch = ACTIVE_ARCHITECTURE_EPOCH,
} = {}): () => void {
  const intelligence = start();
  const reset = createStorageResetCoordinator({ epoch, sync, local, clearCache: intelligence.clearCache });
  const listener = (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => {
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'golens:rewrite:ensure-storage') {
      (globalThis as typeof globalThis & { __golensRewriteRoundTrip?: boolean }).__golensRewriteRoundTrip = true;
      void reset.ensure().then((value) => sendResponse({ ok: true, value }), (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'GoLens storage reset failed.' }));
      return true;
    }
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'golens:rewrite:acknowledge-upgrade') {
      void reset.acknowledgeUpgradeNotice().then(() => sendResponse({ ok: true }), (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'GoLens upgrade acknowledgement failed.' }));
      return true;
    }
    if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'golens:rewrite:ping') {
      (globalThis as typeof globalThis & { __golensRewriteRoundTrip?: boolean }).__golensRewriteRoundTrip = true;
      sendResponse('golens:rewrite:pong');
    }
    return false;
  };
  runtime.onMessage.addListener(listener);
  return () => runtime.onMessage.removeListener(listener);
}

if (typeof chrome !== 'undefined') startWorkerEntry();
