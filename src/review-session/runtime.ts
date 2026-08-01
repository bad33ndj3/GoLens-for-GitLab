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
type CoachAction = 'focusFileSearch' | 'semanticJump' | 'nextOccurrence' | 'historyBack';
type CoachState = Readonly<{ version: 1; lastHintAt: number; actions: Readonly<Record<string, Readonly<{
  manualUses: number; hintCount: number; lastHintAt: number; lastShortcutUseAt: number; learned: boolean;
}>>> }>;
export type ReviewSessionCoachStoragePort = Readonly<{
  get(): Promise<CoachState>;
  set(state: CoachState): Promise<void>;
  settings(action: CoachAction): Promise<Readonly<{ enabled: boolean; binding: string }>>;
  setEnabled(enabled: boolean): Promise<void>;
}>;
type ReviewSessionCoach = Readonly<{
  consider(action: 'focusFileSearch' | 'semanticJump' | 'nextOccurrence' | 'historyBack'): Promise<Readonly<{ label: string; binding: string }> | null>;
  markShortcutUsed(action: 'focusFileSearch' | 'semanticJump' | 'nextOccurrence' | 'historyBack'): Promise<void>;
  setEnabled(enabled: boolean): Promise<void>;
}>;
export type ReviewSessionHandle = Readonly<{ stop(): Promise<void> }>;

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function createCoach(storage: ReviewSessionCoachStoragePort, now = () => Date.now()): ReviewSessionCoach {
  const labels: Record<CoachAction, string> = { focusFileSearch: 'Focus file search', semanticJump: 'Go to definition or implementation', nextOccurrence: 'Next occurrence', historyBack: 'Go back' };
  let sessionHintShown = false;
  let queue = Promise.resolve();
  const update = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  const mutable = (state: CoachState) => ({ version: 1 as const, lastHintAt: state.lastHintAt, actions: Object.fromEntries(Object.entries(state.actions).map(([id, action]) => [id, { ...action }])) });
  return Object.freeze({
    consider(action: CoachAction) {
      return update(async () => {
        try {
          const [stored, settings] = await Promise.all([storage.get(), storage.settings(action)]);
          const state = mutable(stored);
          const record = state.actions[action] || { manualUses: 0, hintCount: 0, lastHintAt: 0, lastShortcutUseAt: 0, learned: false };
          record.manualUses = Math.min(2, record.manualUses + 1); state.actions[action] = record;
          const timestamp = now();
          const eligible = settings.enabled && !sessionHintShown && !record.learned && record.hintCount < 2 && record.manualUses >= 2
            && Boolean(settings.binding) && (!state.lastHintAt || timestamp - state.lastHintAt >= 24 * 60 * 60 * 1000);
          if (eligible) { record.hintCount += 1; record.lastHintAt = timestamp; state.lastHintAt = timestamp; sessionHintShown = true; }
          await storage.set(state);
          return eligible ? Object.freeze({ label: labels[action], binding: settings.binding }) : null;
        } catch { return null; }
      });
    },
    markShortcutUsed(action: CoachAction) {
      return update(async () => {
        try {
          const state = mutable(await storage.get());
          const record = state.actions[action] || { manualUses: 0, hintCount: 0, lastHintAt: 0, lastShortcutUseAt: 0, learned: false };
          record.lastShortcutUseAt = now(); record.learned = true; state.actions[action] = record;
          await storage.set(state);
        } catch { /* Coaching never interrupts review navigation. */ }
      });
    },
    async setEnabled(enabled: boolean) { try { await storage.setEnabled(enabled); } catch { /* optional */ } },
  });
}

export function runReviewSession({
  host,
  intelligence,
  preferences,
  bookmarks,
  preferencePort,
  coachStorage,
  signal,
}: {
  host: BoundGitLabHost;
  intelligence: Pick<GoIntelligence, 'query'> & Partial<Pick<GoIntelligence, 'ensureCoverage'>>;
  preferences: ReviewSessionPreferences;
  bookmarks?: ReviewSessionBookmarkPort;
  preferencePort?: ReviewSessionPreferencePort;
  coachStorage?: ReviewSessionCoachStoragePort;
  signal?: AbortSignal;
}): ReviewSessionHandle {
  const controller = new AbortController();
  const coach = coachStorage ? createCoach(coachStorage) : undefined;
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
  const coachAction = (event: Extract<SessionRuntimeEvent, { type: 'intent' }>) => event.command === 'focus-file-search' ? 'focusFileSearch'
    : event.command === 'activate-target' || event.command === 'semantic-jump' ? 'semanticJump'
      : event.command === 'select-target' || event.command === 'next-occurrence' ? 'nextOccurrence'
        : event.command === 'history-back' ? 'historyBack' : null;

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
                    : effect.type === 'save-coach-enabled' ? coach?.setEnabled(effect.enabled) || Promise.resolve()
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
      for await (const event of host.events(controller.signal)) {
        await dispatch(event);
        if (event.type !== 'intent' || !coach) continue;
        const action = coachAction(event);
        if (!action) continue;
        const operation = event.source === 'shortcut' ? coach.markShortcutUsed(action) : coach.consider(action).then((tip) => {
          if (tip) return dispatch({ type: 'coach-tip', sessionId, revision: event.revision, label: tip.label, binding: tip.binding });
        });
        let tracked: Promise<void>;
        tracked = operation.catch(() => {}).finally(() => pending.delete(tracked));
        pending.add(tracked);
      }
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
