import type { SourceIdentity } from '../domain.ts';
import type {
  CacheInspection, CacheSnapshot, ClearCacheRequest, ClearOutcome,
  CoverageOutcome, CoverageProgress, CoverageRequest, GoIntelligence,
  SemanticOutcome, SemanticQuery, SourceReader,
} from './index.ts';
import type { CoverageManifest, SourceFile } from './cache.ts';
import { IntelligenceContractError, WORKER_PROTOCOL, parseWorkerResponse, validWorkerValue, type WorkerCommand } from './protocol.ts';

type Event<T> = { addListener(listener: (value: T) => void): void; removeListener(listener: (value: T) => void): void };
type Port = { onMessage: Event<unknown>; onDisconnect: Event<void>; postMessage(value: unknown): void; disconnect?(): void };
type Runtime = { connect(options?: { name?: string }): Port };

class WorkerRestarted extends Error {}
class SourceReaderUnavailable extends Error {}

class Connection {
  readonly #clientId = crypto.randomUUID();
  readonly #pending = new Map<string, { command: WorkerCommand['name']; resolve(value: unknown): void; reject(error: unknown): void }>();
  readonly #port: Port;
  #closed = false;

  constructor(runtime: Runtime) {
    this.#port = runtime.connect({ name: 'golens-go-intelligence' });
    this.#port.onMessage.addListener((value) => this.#message(value));
    this.#port.onDisconnect.addListener(() => this.#disconnect());
  }

  request(source: SourceIdentity | undefined, command: WorkerCommand, operationId: string, signal: AbortSignal): Promise<unknown> {
    if (this.#closed) return Promise.reject(new WorkerRestarted());
    if (signal.aborted) return Promise.reject(new DOMException('Operation aborted.', 'AbortError'));
    const requestId = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.#pending.delete(requestId);
        this.#port.postMessage({ protocol: WORKER_PROTOCOL, clientId: this.#clientId, operationId, cancel: true });
        reject(new DOMException('Operation aborted.', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      this.#pending.set(requestId, {
        command: command.name,
        resolve: (value) => { signal.removeEventListener('abort', abort); resolve(value); },
        reject: (error) => { signal.removeEventListener('abort', abort); reject(error); },
      });
      this.#port.postMessage({
        protocol: WORKER_PROTOCOL, clientId: this.#clientId, requestId, operationId,
        ...(source ? { source } : {}), command,
      });
    });
  }

  #message(value: unknown): void {
    const response = parseWorkerResponse(value);
    if (!response) {
      const error = new IntelligenceContractError('Malformed worker response.');
      for (const pending of this.#pending.values()) pending.reject(error);
      this.#pending.clear();
      return;
    }
    if (response.clientId !== this.#clientId) return;
    const pending = this.#pending.get(response.requestId);
    if (!pending) return;
    this.#pending.delete(response.requestId);
    if (!response.ok) {
      if (response.error.code === 'aborted') pending.reject(new DOMException(response.error.message, 'AbortError'));
      else pending.reject(new IntelligenceContractError(response.error.message));
      return;
    }
    if (!validWorkerValue(pending.command, response.value)) {
      pending.reject(new IntelligenceContractError('Invalid worker response value.'));
      return;
    }
    pending.resolve(response.value);
  }

  #disconnect(): void {
    this.#closed = true;
    for (const pending of this.#pending.values()) pending.reject(new WorkerRestarted());
    this.#pending.clear();
  }
}

export function createGoIntelligence({
  source,
  reader,
  runtime,
}: {
  source: SourceIdentity;
  reader: SourceReader;
  runtime: Runtime;
}): GoIntelligence {
  let connection = new Connection(runtime);
  const emptyCoverage = Object.freeze({
    scope: 'indexed-packages' as const, complete: false, packageCount: 0, packagePaths: Object.freeze([] as string[]),
  });
  type Subscriber = { listener: (update: CoverageProgress) => void; signal: AbortSignal };
  type CoverageTask = { controller: AbortController; subscribers: Set<Subscriber>; promise: Promise<CoverageOutcome> };
  const coverageTasks = new Map<string, CoverageTask>();
  const unavailable = (reason: string): CoverageOutcome => Object.freeze({
    status: 'unavailable', source, snapshot: 'unavailable', coverage: emptyCoverage, reason,
  });

  async function retryAfterWorkerRestart<T>(run: (send: (command: WorkerCommand, signal: AbortSignal) => Promise<unknown>) => Promise<T>, signal: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const operationId = crypto.randomUUID();
      try {
        return await run((command, currentSignal) => connection.request(
          command.name === 'clear-cache' || command.name === 'inspect-cache' && command.inspection.scope === 'global' ? undefined : source,
          command, operationId, currentSignal,
        ));
      } catch (error) {
        if (!(error instanceof WorkerRestarted) || attempt === 1 || signal.aborted) throw error;
        connection = new Connection(runtime);
      }
    }
  }

  function progress(listeners: Set<Subscriber>, signal: AbortSignal) {
    let completed = 0;
    return (phase: CoverageProgress['phase'], update: Partial<CoverageProgress> = {}) => {
      if (signal.aborted) return;
      completed = Math.max(completed, update.completed ?? completed);
      const value = Object.freeze({ phase, completed, cached: 0, downloaded: 0, packageCount: 0, ...update });
      for (const subscriber of listeners) if (!subscriber.signal.aborted) subscriber.listener(value);
    };
  }

  async function loadCoverage(request: CoverageRequest, listeners: Set<Subscriber>, signal: AbortSignal): Promise<CoverageOutcome> {
    try {
      return await retryAfterWorkerRestart(async (send) => {
        const report = progress(listeners, signal);
        report('checking-cache');
        const restored = await send({ name: 'prepare-coverage', request }, signal) as CoverageOutcome | { status: 'missing' };
        if (restored.status === 'ready') {
          report('ready', { packageCount: restored.coverage.packageCount });
          return restored;
        }
        report('discovering');
        let discovered;
        try {
          discovered = await reader.discover(request, signal);
        } catch (error) {
          if (signal.aborted) throw error;
          throw new SourceReaderUnavailable();
        }
        const manifest: CoverageManifest = Object.freeze({ source, ...discovered });
        const prepared = await send({ name: 'prepare-coverage', request, manifest }, signal) as {
          status: 'prepared'; cached: number; missing: readonly typeof manifest.files[number][];
        };
        const total = manifest.files.length;
        report('fetching', { completed: prepared.cached, total, cached: prepared.cached, remainingFiles: prepared.missing.length, packageCount: manifest.coverage.packageCount });
        const files: SourceFile[] = [];
        for (const entry of prepared.missing) {
          let content;
          try {
            content = await reader.read(entry, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            throw new SourceReaderUnavailable();
          }
          files.push(Object.freeze({ ...entry, source: content }));
          report('fetching', { completed: prepared.cached + files.length, total, cached: prepared.cached, downloaded: files.length, remainingFiles: prepared.missing.length - files.length, packageCount: manifest.coverage.packageCount });
        }
        if (files.length) await send({ name: 'store-sources', files }, signal);
        report('indexing', { completed: total, total, cached: prepared.cached, downloaded: files.length, remainingFiles: 0, packageCount: manifest.coverage.packageCount });
        report('publishing', { completed: total, total, cached: prepared.cached, downloaded: files.length, remainingFiles: 0, packageCount: manifest.coverage.packageCount });
        const result = await send({ name: 'publish-coverage', manifest }, signal) as CoverageOutcome;
        report('ready', { completed: total, total, cached: prepared.cached, downloaded: files.length, remainingFiles: 0, packageCount: manifest.coverage.packageCount });
        return result;
      }, signal);
    } catch (error) {
      if (error instanceof WorkerRestarted) {
        return unavailable('worker-restarted');
      }
      if (error instanceof SourceReaderUnavailable) return unavailable('source-reader-unavailable');
      throw error;
    }
  }

  function ensureCoverage(request: CoverageRequest, listener: (update: CoverageProgress) => void, signal: AbortSignal): Promise<CoverageOutcome> {
    if (signal.aborted) return Promise.reject(new DOMException('Operation aborted.', 'AbortError'));
    const requestKey = JSON.stringify(request);
    const subscriber = { listener, signal };
    let task = coverageTasks.get(requestKey);
    if (!task) {
      const controller = new AbortController();
      const subscribers = new Set([subscriber]);
      const created: CoverageTask = {
        controller,
        subscribers,
        promise: Promise.resolve().then(() => loadCoverage(request, subscribers, controller.signal)),
      };
      task = created;
      coverageTasks.set(requestKey, task);
      task.promise = task.promise.finally(() => {
        if (coverageTasks.get(requestKey) === created) coverageTasks.delete(requestKey);
      });
    } else {
      task.subscribers.add(subscriber);
    }
    return new Promise((resolve, reject) => {
      const abort = () => {
        task!.subscribers.delete(subscriber);
        if (!task!.subscribers.size) task!.controller.abort();
        reject(new DOMException('Operation aborted.', 'AbortError'));
      };
      signal.addEventListener('abort', abort, { once: true });
      task!.promise.then(resolve, reject).finally(() => {
        signal.removeEventListener('abort', abort);
        task!.subscribers.delete(subscriber);
      });
    });
  }

  return {
    ensureCoverage,

    async query(request: SemanticQuery, signal: AbortSignal): Promise<SemanticOutcome> {
      try {
        return await retryAfterWorkerRestart(async (send) => send({ name: 'query', query: request }, signal) as Promise<SemanticOutcome>, signal);
      } catch (error) {
        if (error instanceof WorkerRestarted) {
          return Object.freeze({
            status: 'unavailable', source, snapshot: 'unavailable',
            coverage: emptyCoverage,
            reason: 'worker-restarted',
          });
        }
        throw error;
      }
    },

    inspectCache(request: CacheInspection, signal: AbortSignal): Promise<CacheSnapshot> {
      return retryAfterWorkerRestart(async (send) => send({ name: 'inspect-cache', inspection: request }, signal) as Promise<CacheSnapshot>, signal);
    },

    clearCache(request: ClearCacheRequest, signal: AbortSignal): Promise<ClearOutcome> {
      return retryAfterWorkerRestart(async (send) => send({ name: 'clear-cache', request }, signal) as Promise<ClearOutcome>, signal);
    },
  };
}
