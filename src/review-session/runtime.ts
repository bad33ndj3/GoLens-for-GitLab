import type { BoundGitLabHost } from '../gitlab-host/index.ts';
import type { GoIntelligence, SemanticOutcome } from '../go-intelligence/index.ts';
import { initialSessionState, reduceSession, setSessionStatus, type SessionEffect } from './reducer.ts';

export type ReviewSessionPreferences = Readonly<{
  enabled: boolean;
  hideGeneratedFiles: boolean;
}>;

export type ReviewSessionHandle = Readonly<{ stop(): Promise<void> }>;

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function runReviewSession({
  host,
  intelligence,
  preferences,
  signal,
}: {
  host: BoundGitLabHost;
  intelligence: Pick<GoIntelligence, 'query'>;
  preferences: ReviewSessionPreferences;
  signal?: AbortSignal;
}): ReviewSessionHandle {
  const controller = new AbortController();
  const sessionId = crypto.randomUUID();
  let state = initialSessionState(preferences);
  let operation = 0;
  let queryController: AbortController | null = null;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    queryController?.abort();
    controller.abort();
    await running.catch((error) => { if (!aborted(error)) throw error; });
  };
  if (signal) signal.addEventListener('abort', () => void stop(), { once: true });

  const perform = async (effect: Extract<SessionEffect, { type: 'perform' }>) => {
    if (state.revision === null || controller.signal.aborted) return;
    const base = { revision: state.revision, operationId: `${sessionId}:${effect.action}:${state.revision}` };
    if (effect.action === 'set-fullscreen') await host.perform({ ...base, action: effect.action, active: Boolean(effect.active) }, controller.signal);
    else await host.perform({ ...base, action: effect.action }, controller.signal);
  };
  const apply = (effect: Extract<SessionEffect, { type: 'apply' }>) => { if (!controller.signal.aborted) host.apply(effect.projection); };
  const query = async (effect: Extract<SessionEffect, { type: 'query' }>) => {
    const target = effect.target;
    const operationId = ++operation;
    queryController?.abort();
    const current = new AbortController();
    queryController = current;
    controller.signal.addEventListener('abort', () => current.abort(), { once: true });
    const outcome: SemanticOutcome = await intelligence.query({
      operation: 'resolve-symbol', path: target.path, line: target.line, column: target.column || 1, identifier: target.identifier!,
    }, current.signal);
    if (controller.signal.aborted || current.signal.aborted || queryController !== current || operationId !== operation || state.revision !== target.revision
      || outcome.source.repositoryKey !== target.source.repositoryKey || outcome.source.commitSha !== target.source.commitSha) return;
    const status = outcome.status === 'resolved' ? outcome.symbol.signature : outcome.status === 'missing' ? undefined : outcome.status;
    if (status) {
      const reduced = setSessionStatus(state, status);
      state = reduced.state;
      for (const effect of reduced.effects) if (effect.type === 'apply') apply(effect);
    }
  };
  const dispatch = async (event: Parameters<typeof reduceSession>[1]) => {
    if (event.type === 'host-revised') queryController?.abort();
    const reduced = reduceSession(state, event);
    state = reduced.state;
    for (const effect of reduced.effects) {
      if (effect.type === 'apply') apply(effect);
      else if (effect.type === 'perform') await perform(effect);
      else void query(effect).catch((error) => {
        if (!aborted(error) && !controller.signal.aborted && state.revision !== null) {
          const reduced = setSessionStatus(state, 'Go Intelligence is unavailable.');
          state = reduced.state;
          for (const next of reduced.effects) if (next.type === 'apply') apply(next);
        }
      });
    }
  };
  const running = (async () => {
    try {
      for await (const event of host.events(controller.signal)) await dispatch(event);
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    }
  })();
  return Object.freeze({ stop });
}
