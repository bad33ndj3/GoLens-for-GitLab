import type { CoverageOutcome, GoIntelligence } from '../go-intelligence/index.ts';
import type { BoundGitLabHost, HostAction, HostRevision } from '../gitlab-host/index.ts';
import { initialSessionState, reduceSession, type SessionBookmark, type SessionEffect, type SessionPreferences, type SessionRuntimeEvent } from './reducer.ts';

export type ReviewSessionPreferences = SessionPreferences;
export type ReviewSessionBookmark = SessionBookmark;
export type ReviewSessionBookmarkPort = Readonly<{
  list(scope: { origin: string; project: string; mergeRequest: string }): Promise<readonly SessionBookmark[]>;
  toggle(input: { scope: unknown; location: unknown; anchor?: unknown }): Promise<{ action: 'added' | 'removed'; record: SessionBookmark }>;
}>;
export type ReviewSessionHandle = Readonly<{ stop(): Promise<void> }>;

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function runReviewSession({
  host,
  intelligence,
  preferences,
  bookmarks,
  savePreferences,
  signal,
}: {
  host: BoundGitLabHost;
  intelligence: Pick<GoIntelligence, 'query'> & Partial<Pick<GoIntelligence, 'ensureCoverage'>>;
  preferences: ReviewSessionPreferences;
  bookmarks?: ReviewSessionBookmarkPort;
  savePreferences?: (update: Partial<ReviewSessionPreferences>) => Promise<void>;
  signal?: AbortSignal;
}): ReviewSessionHandle {
  const controller = new AbortController();
  const sessionId = crypto.randomUUID();
  let state = initialSessionState(sessionId, {
    repositoryKey: host.review.identity.repositoryKey,
    commitSha: host.review.identity.headSha,
  }, preferences);
  let stopped = false;
  const scopes = new Map<string, AbortController>();
  const pending = new Set<Promise<void>>();

  const scoped = (name: string) => {
    scopes.get(name)?.abort();
    const child = new AbortController();
    if (controller.signal.aborted) child.abort();
    else controller.signal.addEventListener('abort', () => child.abort(), { once: true });
    scopes.set(name, child);
    return child.signal;
  };
  const current = (revision: HostRevision) => !controller.signal.aborted && state.revision === revision;

  const dispatch = async (event: SessionRuntimeEvent): Promise<void> => {
    if (controller.signal.aborted) return;
    if (event.type === 'host-revised') scopes.get('semantic')?.abort();
    const reduced = reduceSession(state, event);
    state = reduced.state;
    for (const effect of reduced.effects) run(effect);
  };

  const perform = async (effect: Extract<SessionEffect, { type: 'perform' }>) => {
    if (state.revision === null || controller.signal.aborted) return;
    const { type: _type, operationId, ...action } = effect;
    await host.perform({ ...action, revision: state.revision, operationId: `${sessionId}:${operationId}` } as HostAction, scoped(`action:${action.action}`));
  };

  const query = async (effect: Extract<SessionEffect, { type: 'query' }>) => {
    const outcome = await intelligence.query(effect.request, scoped('semantic'));
    await dispatch({ type: 'semantic-completed', sessionId, revision: effect.target.revision, operationId: effect.operationId, outcome });
  };

  const bookmarkScope = () => ({
    origin: host.review.identity.origin,
    project: String(host.review.identity.projectPath),
    mergeRequest: host.review.identity.mergeRequestIid,
    headSha: String(host.review.identity.headSha),
  });
  const loadBookmarks = async (effect: Extract<SessionEffect, { type: 'load-bookmarks' }>) => {
    if (!bookmarks) return;
    const records = await bookmarks.list(bookmarkScope());
    if (current(effect.revision)) await dispatch({ type: 'bookmarks-loaded', sessionId, revision: effect.revision, operationId: effect.operationId, bookmarks: records, open: effect.open });
  };
  const toggleBookmark = async (effect: Extract<SessionEffect, { type: 'toggle-bookmark' }>) => {
    if (!bookmarks) return;
    const outcome = await bookmarks.toggle({
      scope: bookmarkScope(),
      location: { path: effect.target.path, side: effect.target.side, startLine: effect.target.line, endLine: effect.target.line },
      anchor: { symbol: effect.target.identifier || '', selectionHash: '', beforeHash: '', afterHash: '' },
    });
    const records = await bookmarks.list(bookmarkScope());
    if (current(effect.revision)) await dispatch({ type: 'bookmark-toggled', sessionId, revision: effect.revision, operationId: effect.operationId, bookmarks: records, action: outcome.action });
  };
  const cacheRelated = async (effect: Extract<SessionEffect, { type: 'cache-related' }>) => {
    if (!intelligence.ensureCoverage) throw new Error('Coverage is unavailable.');
    const signal = scoped('coverage');
    const files = await host.read({ operation: 'go-files', source: {
      repositoryKey: host.review.identity.repositoryKey, commitSha: host.review.identity.headSha,
    }, scope: { kind: 'changed-review' } }, signal);
    if (files.kind !== 'ok' || !('files' in files.value)) throw new Error('Changed Go files are unavailable.');
    const outcome: CoverageOutcome = await intelligence.ensureCoverage({ goal: 'related-review', changedPaths: files.value.files.map(({ path }) => path) }, (progress) => {
      if (current(effect.revision)) void dispatch({ type: 'coverage-progress', sessionId, revision: effect.revision, operationId: effect.operationId, progress });
    }, signal);
    await dispatch({ type: 'coverage-completed', sessionId, revision: effect.revision, operationId: effect.operationId, outcome });
  };

  const failed = (effect: SessionEffect) => (error: unknown) => {
    if (aborted(error) || controller.signal.aborted) return;
    if (effect.type === 'query') void dispatch({ type: 'semantic-failed', sessionId, revision: effect.target.revision, operationId: effect.operationId });
    if (effect.type === 'cache-related') void dispatch({ type: 'coverage-completed', sessionId, revision: effect.revision, operationId: effect.operationId,
      outcome: { status: 'unavailable', source: { repositoryKey: host.review.identity.repositoryKey, commitSha: host.review.identity.headSha }, snapshot: '' } });
  };

  const run = (effect: SessionEffect) => {
    if (controller.signal.aborted) return;
    if (effect.type === 'apply') host.apply(effect.projection);
    else {
      const operation = effect.type === 'perform' ? perform(effect)
        : effect.type === 'query' ? query(effect)
          : effect.type === 'cache-related' ? cacheRelated(effect)
            : effect.type === 'load-bookmarks' ? loadBookmarks(effect)
              : effect.type === 'toggle-bookmark' ? toggleBookmark(effect)
                : savePreferences?.({ enabled: effect.enabled }) || Promise.resolve();
      let tracked: Promise<void>;
      tracked = operation.catch(failed(effect)).finally(() => pending.delete(tracked));
      pending.add(tracked);
    }
  };

  const running = (async () => {
    try {
      for await (const event of host.events(controller.signal)) await dispatch(event);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    controller.abort();
    for (const scope of scopes.values()) scope.abort();
    await running.catch((error) => { if (!aborted(error)) throw error; });
    await Promise.allSettled([...pending]);
  };
  if (signal) {
    if (signal.aborted) void stop();
    else signal.addEventListener('abort', () => void stop(), { once: true });
  }
  return Object.freeze({ stop });
}
