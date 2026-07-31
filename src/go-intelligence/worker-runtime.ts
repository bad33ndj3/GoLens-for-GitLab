import { Language, Parser } from 'web-tree-sitter';

import { repositoryPath, type RepositoryPath, type SourceIdentity } from '../domain.ts';
import type { Coverage, CoverageOutcome, CoverageRequest, SemanticOutcome, SemanticQuery } from './index.ts';
import { GoIntelligenceCache, type CoverageManifest, type RestoredCoverage } from './cache.ts';
import {
  IntelligenceContractError, WORKER_PROTOCOL, parseCancelMessage, parseWorkerRequest, validWorkerValue, workerError,
  type WorkerCommand, type WorkerRequest, type WorkerResponse,
} from './protocol.ts';
import { SemanticSnapshotIndex, semanticQueryFingerprint } from './semantic-index.ts';

type Event<T> = { addListener(listener: (value: T) => void): void; removeListener?(listener: (value: T) => void): void };
type Port = { onMessage: Event<unknown>; onDisconnect: Event<void>; postMessage(value: unknown): void };
type WorkerRuntime = { onConnect: Event<Port>; getURL?(path: string): string };
type ParserLike = Awaited<ReturnType<typeof defaultParser>>;

class MutationScheduler {
  readonly #sources = new Map<string, Promise<unknown>>();
  #barrier: Promise<unknown> = Promise.resolve();

  source<T>(source: SourceIdentity, work: () => Promise<T>): Promise<T> {
    const key = JSON.stringify(source);
    const previous = this.#sources.get(key) || Promise.resolve();
    const result = Promise.all([this.#barrier, previous]).then(work);
    this.#sources.set(key, result.catch(() => {}));
    return result;
  }

  query(source: SourceIdentity): Promise<unknown> {
    return Promise.all([this.#barrier, this.#sources.get(JSON.stringify(source)) || Promise.resolve()]);
  }

  clear<T>(work: () => Promise<T>): Promise<T> {
    const result = Promise.all([this.#barrier, ...this.#sources.values()]).then(work);
    this.#barrier = result.catch(() => {});
    return result;
  }
}

async function defaultParser(runtime: WorkerRuntime): Promise<Parser> {
  await Parser.init({ locateFile: (name: string) => runtime.getURL?.(`vendor/${name}`) || `vendor/${name}` });
  const parser = new Parser();
  parser.setLanguage(await Language.load(runtime.getURL?.('vendor/tree-sitter-go.wasm') || 'vendor/tree-sitter-go.wasm'));
  return parser;
}

async function revision(manifest: CoverageManifest): Promise<string> {
  const value = JSON.stringify([
    manifest.source, manifest.modulePath, manifest.coverage,
    manifest.files.map(({ path, contentId }) => [path, contentId]),
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function aborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Operation aborted.', 'AbortError');
}

export function createGoIntelligenceWorkerRuntime({
  cache = new GoIntelligenceCache(),
  createParser,
}: {
  cache?: GoIntelligenceCache;
  createParser: () => Promise<ParserLike>;
}) {
  const snapshots = new Map<string, SemanticSnapshotIndex>();
  const scheduler = new MutationScheduler();
  let parser: Promise<ParserLike> | null = null;
  const key = (source: SourceIdentity) => JSON.stringify(source);

  async function build(restored: RestoredCoverage, signal: AbortSignal): Promise<SemanticSnapshotIndex> {
    aborted(signal);
    parser ||= createParser().catch((error) => { parser = null; throw error; });
    const index = new SemanticSnapshotIndex(await parser, restored.source, await revision(restored), restored.coverage);
    const files = restored.sources.map(({ path, source }) => ({ path, source }));
    if (restored.coverage.scope === 'current-package') {
      index.indexPackage(restored.coverage.packagePaths[0] || '', files, restored.modulePath);
    } else {
      index.indexProject(restored.modulePath, files);
    }
    aborted(signal);
    return index;
  }

  async function snapshot(source: SourceIdentity, path: RepositoryPath, signal: AbortSignal): Promise<SemanticSnapshotIndex | null> {
    const existing = snapshots.get(key(source));
    if (existing && (existing.coverage.scope === 'full-project' || existing.coverage.packagePaths.includes(dirname(path)))) return existing;
    const restored = await cache.restore(source, path);
    if (!restored) return null;
    const rebuilt = await build(restored, signal);
    snapshots.set(key(source), rebuilt);
    return rebuilt;
  }

  async function execute(request: WorkerRequest, signal: AbortSignal): Promise<unknown> {
    const { command, source } = request;
    if (command.name === 'clear-cache') {
      return scheduler.clear(async () => {
        const previous = await cache.clear();
        snapshots.clear();
        return Object.freeze({ status: 'cleared', ...previous });
      });
    }
    if (command.name === 'inspect-cache') {
      return cache.inspect(command.inspection.scope === 'source' ? source : undefined);
    }
    if (!source) throw new IntelligenceContractError('Worker command requires a source identity.');
    const manifestSource = command.name === 'publish-coverage' ? command.manifest.source
      : command.name === 'prepare-coverage' ? command.manifest?.source : undefined;
    if (manifestSource && !sameSource(source, manifestSource)) {
      throw new IntelligenceContractError('Worker source identity does not match the Coverage manifest.');
    }
    if (command.name === 'query') {
      await scheduler.query(source);
      const path = command.query.operation === 'resolve-symbol' ? command.query.path : command.query.symbol.path;
      const current = await snapshot(source, path, signal);
      if (!current) {
        return Object.freeze({
          status: 'coverage-insufficient', source, snapshot: 'empty',
          coverage: { scope: 'indexed-packages' as const, complete: false, packageCount: 0, packagePaths: [] },
          required: 'current-package', reason: 'No semantic snapshot is published.',
        }) satisfies SemanticOutcome;
      }
      return current.query(command.query);
    }
    if (command.name === 'dispose-memory') {
      snapshots.delete(key(source));
      return Object.freeze({ status: 'ok' });
    }
    return scheduler.source(source, async () => {
      aborted(signal);
      if (command.name === 'prepare-coverage') {
        if (command.manifest) {
          const prepared = await cache.prepare(command.manifest);
          return Object.freeze({ status: 'prepared', ...prepared });
        }
        const restored = await cache.restore(source, requestPath(command.request), (coverage) => satisfies(coverage, command.request));
        if (!restored) return Object.freeze({ status: 'missing' });
        const candidate = await build(restored, signal);
        snapshots.set(key(source), candidate);
        return Object.freeze({ status: 'ready', source, snapshot: candidate.revision, coverage: candidate.coverage });
      }
      if (command.name === 'store-sources') {
        for (const file of command.files) {
          aborted(signal);
          await cache.stage(source, [file], signal);
        }
        return Object.freeze({ status: 'ok' });
      }
      const staged = await cache.prepare(command.manifest);
      if (staged.missing.length) throw new IntelligenceContractError('Coverage manifest is incomplete.');
      const candidate = await buildFromStaged(command.manifest, signal);
      aborted(signal); // Commit point: cancellation after this check cannot roll publication back.
      await cache.publish(command.manifest);
      snapshots.set(key(source), candidate);
      return Object.freeze({
        status: 'ready', source, snapshot: candidate.revision, coverage: candidate.coverage,
      }) satisfies CoverageOutcome;
    });
  }

  async function buildFromStaged(manifest: CoverageManifest, signal: AbortSignal): Promise<SemanticSnapshotIndex> {
    const restored = await cache.materialize(manifest);
    if (!restored) throw new IntelligenceContractError('Coverage source disappeared before publication.');
    return build(restored, signal);
  }

  return { execute };
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function sameSource(left: SourceIdentity, right: SourceIdentity): boolean {
  return left.repositoryKey === right.repositoryKey && left.commitSha === right.commitSha;
}

function queryPath(query: SemanticQuery | undefined): RepositoryPath | undefined {
  if (!query) return undefined;
  return query.operation === 'resolve-symbol' ? query.path : query.symbol.path;
}

function requestPath(request: CoverageRequest): RepositoryPath | undefined {
  if (request.goal === 'current-package' && request.packagePath !== undefined) {
    return repositoryPath(request.packagePath ? `${request.packagePath}/_` : '_');
  }
  if (request.goal === 'related-review') return request.changedPaths?.[0];
  if (request.goal === 'complete-query') return queryPath(request.query);
  return undefined;
}

function satisfies(coverage: Coverage, request: CoverageRequest): boolean {
  if (coverage.scope === 'full-project' && coverage.complete) return true;
  if (request.goal === 'full-project') return false;
  if (request.goal === 'current-package') {
    return coverage.complete && request.packagePath !== undefined && coverage.packagePaths.includes(request.packagePath);
  }
  if (request.goal === 'related-review') {
    const packages = new Set((request.changedPaths || []).map(dirname));
    return coverage.scope === 'indexed-packages' && [...packages].every((path) => coverage.packagePaths.includes(path));
  }
  return coverage.scope === 'complete-project-search' && coverage.complete && request.query !== undefined
    && coverage.queryFingerprint === semanticQueryFingerprint(request.query);
}

export function startGoIntelligenceWorker({
  runtime = chrome.runtime as unknown as WorkerRuntime,
  cache = new GoIntelligenceCache(),
  createParser = () => defaultParser(runtime),
}: {
  runtime?: WorkerRuntime;
  cache?: GoIntelligenceCache;
  createParser?: () => Promise<ParserLike>;
} = {}): void {
  const worker = createGoIntelligenceWorkerRuntime({ cache, createParser });
  runtime.onConnect.addListener((port) => {
    const operations = new Map<string, AbortController>();
    port.onDisconnect.addListener(() => {
      for (const controller of operations.values()) controller.abort();
      operations.clear();
    });
    port.onMessage.addListener((value) => {
      const cancellation = parseCancelMessage(value);
      if (cancellation) {
        operations.get(cancellation.operationId)?.abort();
        return;
      }
      const raw = value as Record<string, unknown> | null;
      const request = parseWorkerRequest(value);
      const clientId = typeof raw?.clientId === 'string' ? raw.clientId : 'invalid';
      const requestId = typeof raw?.requestId === 'string' ? raw.requestId : 'invalid';
      if (!request) {
        const protocol = raw?.protocol === WORKER_PROTOCOL ? 'unknown-command' : 'protocol-mismatch';
        port.postMessage({ protocol: WORKER_PROTOCOL, clientId, requestId, ok: false, error: workerError(protocol, 'Invalid worker request.') });
        return;
      }
      const controller = new AbortController();
      operations.set(request.operationId, controller);
      void worker.execute(request, controller.signal).then((result) => {
        const response: WorkerResponse = validWorkerValue(request.command.name, result)
          ? { protocol: WORKER_PROTOCOL, clientId: request.clientId, requestId: request.requestId, ok: true, value: result }
          : { protocol: WORKER_PROTOCOL, clientId: request.clientId, requestId: request.requestId, ok: false, error: workerError('contract-error', 'Invalid worker result.') };
        port.postMessage(response);
      }, (error) => {
        const abort = error instanceof DOMException && error.name === 'AbortError';
        port.postMessage({
          protocol: WORKER_PROTOCOL, clientId: request.clientId, requestId: request.requestId, ok: false,
          error: workerError(abort ? 'aborted' : 'contract-error', error instanceof Error ? error.message : 'Worker command failed.'),
        });
      }).finally(() => operations.delete(request.operationId));
    });
  });
}
