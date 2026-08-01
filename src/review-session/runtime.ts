import type { CoverageOutcome, GoIntelligence } from '../go-intelligence/index.ts';
import type { BoundGitLabHost, HostAction, HostRevision } from '../gitlab-host/index.ts';
import { initialSessionState, reduceSession, type SessionBookmark, type SessionEffect, type SessionPreferences, type SessionRuntimeEvent } from './reducer.ts';

export type ReviewSessionPreferences = SessionPreferences;
export type ReviewSessionBookmark = SessionBookmark;
export type ReviewSessionBookmarkPort = Readonly<{
  list(scope: { origin: string; project: string; mergeRequest: string }): Promise<readonly SessionBookmark[]>;
  toggle(input: { scope: unknown; location: unknown; anchor?: unknown }): Promise<{ action: 'added' | 'removed'; record: SessionBookmark }>;
}>;
export type ReviewSessionPreferencePort = Readonly<{
  subscribe(listener: (preferences: ReviewSessionPreferences) => void): () => void;
  set(update: Partial<ReviewSessionPreferences>): Promise<void>;
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
  preferencePort,
  signal,
}: {
  host: BoundGitLabHost;
  intelligence: Pick<GoIntelligence, 'query'> & Partial<Pick<GoIntelligence, 'ensureCoverage'>>;
  preferences: ReviewSessionPreferences;
  bookmarks?: ReviewSessionBookmarkPort;
  preferencePort?: ReviewSessionPreferencePort;
  signal?: AbortSignal;
}): ReviewSessionHandle {
  const controller = new AbortController();
  const sessionId = crypto.randomUUID();
  let state = initialSessionState(sessionId, {
    repositoryKey: host.review.identity.repositoryKey,
    commitSha: host.review.identity.headSha,
  }, preferences, host.review.refs.startSha || host.review.refs.baseSha ? {
    repositoryKey: host.review.identity.repositoryKey,
    commitSha: host.review.refs.startSha || host.review.refs.baseSha!,
  } : undefined);
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
  const abortable = <T>(operation: Promise<T>, operationSignal: AbortSignal): Promise<T> => {
    if (operationSignal.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(new DOMException('Aborted', 'AbortError'));
      operationSignal.addEventListener('abort', abort, { once: true });
      operation.then(resolve, reject).finally(() => operationSignal.removeEventListener('abort', abort));
    });
  };

  const dispatch = async (event: SessionRuntimeEvent): Promise<void> => {
    if (controller.signal.aborted) return;
    if (event.type === 'host-revised') {
      for (const [name, scope] of scopes) if (name !== 'preferences') scope.abort();
    }
    const reduced = reduceSession(state, event);
    state = reduced.state;
    for (const effect of reduced.effects) run(effect);
  };

  const perform = async (effect: Extract<SessionEffect, { type: 'perform' }>) => {
    if (state.revision === null || controller.signal.aborted) return;
    const revision = state.revision;
    const { type: _type, operationId, ...action } = effect;
    const signal = scoped(`action:${action.action}`);
    const outcome = await host.perform({ ...action, revision, operationId: `${sessionId}:${operationId}` } as HostAction, signal);
    if (action.action === 'set-full-file') {
      await dispatch({ type: 'full-file-completed', sessionId, revision, operationId, path: action.path, full: action.full, outcome });
    }
    if (action.action === 'reveal-source' && outcome.kind !== 'completed' && outcome.kind !== 'unchanged') {
      await host.perform({ action: 'open-destination', destination: { kind: 'source', source: action.source, path: action.path, line: action.line },
        revision: state.revision, operationId: `${sessionId}:${operationId}:fallback` }, signal);
    }
  };

  const query = async (effect: Extract<SessionEffect, { type: 'query' }>) => {
    const scope = effect.purpose === 'hover' ? 'semantic:hover' : effect.purpose === 'selection' || effect.purpose === 'select' ? 'semantic:selection' : 'semantic:navigation';
    if (scope !== 'semantic:hover') scopes.get('semantic:hover')?.abort();
    const outcome = await intelligence.query(effect.request, scoped(scope));
    await dispatch({ type: 'semantic-completed', sessionId, revision: effect.target.revision, operationId: effect.operationId, outcome });
  };

  const ensureQueryCoverage = async (effect: Extract<SessionEffect, { type: 'ensure-query-coverage' }>) => {
    if (!intelligence.ensureCoverage) {
      await dispatch({ type: 'query-coverage-completed', sessionId, revision: effect.revision, operationId: effect.operationId, outcome: {
        status: 'unavailable', reason: 'Coverage is unavailable.', source: effect.retry.target.source, snapshot: state.snapshot || '',
        coverage: { scope: 'current-package', complete: false, packageCount: 0, packagePaths: [] },
      } });
      return;
    }
    const outcome = await intelligence.ensureCoverage({ goal: 'complete-query', query: effect.retry.request }, (progress) => {
      if (current(effect.revision)) void dispatch({ type: 'query-coverage-progress', sessionId, revision: effect.revision, operationId: effect.operationId, progress });
    }, scoped('coverage:query'));
    await dispatch({ type: 'query-coverage-completed', sessionId, revision: effect.revision, operationId: effect.operationId, outcome });
  };

  const bookmarkScope = () => ({
    origin: host.review.identity.origin,
    project: String(host.review.identity.projectPath),
    mergeRequest: host.review.identity.mergeRequestIid,
    headSha: String(host.review.identity.headSha),
  });
  const loadBookmarks = async (effect: Extract<SessionEffect, { type: 'load-bookmarks' }>) => {
    if (!bookmarks) return;
    const records = await abortable(bookmarks.list(bookmarkScope()), scoped('bookmarks'));
    if (current(effect.revision)) await dispatch({ type: 'bookmarks-loaded', sessionId, revision: effect.revision, operationId: effect.operationId, bookmarks: records, open: effect.open });
  };
  const toggleBookmark = async (effect: Extract<SessionEffect, { type: 'toggle-bookmark' }>) => {
    if (!bookmarks) return;
    const signal = scoped('bookmarks');
    const outcome = await abortable(bookmarks.toggle({
      scope: bookmarkScope(),
      location: effect.bookmark.location,
      anchor: effect.bookmark.anchor,
    }), signal);
    const records = await abortable(bookmarks.list(bookmarkScope()), signal);
    if (current(effect.revision)) await dispatch({ type: 'bookmark-toggled', sessionId, revision: effect.revision, operationId: effect.operationId, bookmarks: records, action: outcome.action });
  };
  const cacheRelated = async (effect: Extract<SessionEffect, { type: 'cache-related' }>) => {
    if (!intelligence.ensureCoverage) throw new Error('Coverage is unavailable.');
    const signal = scoped('coverage');
    const files = await host.read({ operation: 'go-files', source: {
      repositoryKey: host.review.identity.repositoryKey, commitSha: host.review.identity.headSha,
    }, scope: { kind: 'changed-review' } }, signal);
    if (files.kind !== 'ok') {
      await dispatch({ type: 'coverage-completed', sessionId, revision: effect.revision, operationId: effect.operationId,
        outcome: { status: 'unavailable', source: { repositoryKey: host.review.identity.repositoryKey, commitSha: host.review.identity.headSha }, snapshot: '' } });
      return;
    }
    if (!('files' in files.value)) throw new TypeError('Go files read returned the wrong value.');
    const outcome: CoverageOutcome = await intelligence.ensureCoverage({ goal: 'related-review', changedPaths: files.value.files.map(({ path }) => path) }, (progress) => {
      if (current(effect.revision)) void dispatch({ type: 'coverage-progress', sessionId, revision: effect.revision, operationId: effect.operationId, progress });
    }, signal);
    await dispatch({ type: 'coverage-completed', sessionId, revision: effect.revision, operationId: effect.operationId, outcome });
  };
  const readReviewStatus = async (effect: Extract<SessionEffect, { type: 'read-review-status' }>) => {
    const outcome = await host.read({ operation: 'review-status' }, scoped('review-status'));
    const confirmed = outcome.kind === 'ok' && 'state' in outcome.value
      && (effect.milestone === 'merge' ? /merged/i.test(outcome.value.state) : outcome.value.approvers.length > 0);
    await dispatch({ type: 'review-status-read', sessionId, revision: effect.revision, operationId: effect.operationId, milestone: effect.milestone, confirmed });
  };
  const navigateSource = async (effect: Extract<SessionEffect, { type: 'navigate-source' }>) => {
    const signal = scoped('action:reveal-source');
    const outcome = await host.perform({ action: 'reveal-source', ...effect.destination, revision: effect.revision,
      operationId: `${sessionId}:${effect.operationId}` }, signal);
    if (outcome.kind === 'completed' || outcome.kind === 'unchanged') {
      await dispatch({ type: 'source-navigation-completed', sessionId, revision: effect.revision, operationId: effect.operationId,
        from: effect.from, destination: effect.destination });
    } else {
      await host.perform({ action: 'open-destination', destination: { kind: 'source', ...effect.destination }, revision: effect.revision,
        operationId: `${sessionId}:${effect.operationId}:fallback` }, signal);
    }
  };

  let terminate = (_failure = false) => {};

  const failed = (effect: SessionEffect) => (error: unknown) => {
    if (aborted(error) || controller.signal.aborted) return;
    terminate(true);
  };

  const run = (effect: SessionEffect) => {
    if (controller.signal.aborted) return;
    if (effect.type === 'apply') host.apply(effect.projection);
    else if (effect.type === 'cancel-query-coverage') scopes.get('coverage:query')?.abort();
    else if (effect.type === 'cancel-workflows') {
      for (const [name, scope] of scopes) if (name !== 'preferences') scope.abort();
    }
    else {
      const operation = effect.type === 'perform' ? perform(effect)
        : effect.type === 'query' ? query(effect)
          : effect.type === 'cache-related' ? cacheRelated(effect)
            : effect.type === 'ensure-query-coverage' ? ensureQueryCoverage(effect)
            : effect.type === 'load-bookmarks' ? loadBookmarks(effect)
              : effect.type === 'toggle-bookmark' ? toggleBookmark(effect)
                : effect.type === 'read-review-status' ? readReviewStatus(effect)
                  : effect.type === 'navigate-source' ? navigateSource(effect)
                    : preferencePort ? abortable(preferencePort.set({ enabled: effect.enabled }), scoped('preferences')) : Promise.resolve();
      let tracked: Promise<void>;
      tracked = operation.catch(failed(effect)).finally(() => pending.delete(tracked));
      pending.add(tracked);
    }
  };

  let unsubscribePreferences: (() => void) | undefined;
  terminate = (failure = false) => {
    if (failure && state.revision !== null) host.apply({ revision: state.revision, enabled: true, status: 'GoLens stopped after an internal error.' });
    unsubscribePreferences?.();
    controller.abort();
    for (const scope of scopes.values()) scope.abort();
  };
  const running = (async () => {
    try {
      for await (const event of host.events(controller.signal)) await dispatch(event);
    } catch (error) {
      if (!controller.signal.aborted && !aborted(error)) terminate(true);
    }
  })();
  unsubscribePreferences = preferencePort?.subscribe((next) => { void dispatch({ type: 'preferences-changed', preferences: next }); });
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    terminate();
    await running;
    await Promise.allSettled([...pending]);
  };
  if (signal) {
    if (signal.aborted) void stop();
    else signal.addEventListener('abort', () => void stop(), { once: true });
  }
  return Object.freeze({ stop });
}
