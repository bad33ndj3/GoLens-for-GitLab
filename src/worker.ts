import { startGoIntelligenceWorker } from './go-intelligence/index.ts';

type WorkerRuntime = Pick<typeof chrome.runtime, 'onMessage'>;

export function startWorkerEntry({ start = startGoIntelligenceWorker, runtime = chrome.runtime as WorkerRuntime } = {}): () => void {
  start();
  const listener = (message: unknown, _sender: unknown, sendResponse: (response: unknown) => void) => {
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
