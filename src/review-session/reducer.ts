import type { ControlProjection, DiffTarget, HostEvent, HostProjection, HostRevision } from '../gitlab-host/index.ts';

export type SessionState = Readonly<{
  revision: HostRevision | null;
  enabled: boolean;
  hideGeneratedFiles: boolean;
  focusMode: boolean;
  status?: string;
}>;

export type SessionEffect =
  | Readonly<{ type: 'apply'; projection: HostProjection }>
  | Readonly<{ type: 'perform'; action: 'set-fullscreen' | 'focus-file-search' | 'clear-file-search'; active?: boolean }>
  | Readonly<{ type: 'query'; target: DiffTarget }>;

export function initialSessionState(preferences: { enabled: boolean; hideGeneratedFiles: boolean }): SessionState {
  return Object.freeze({ revision: null, enabled: preferences.enabled, hideGeneratedFiles: preferences.hideGeneratedFiles, focusMode: false });
}

function projection(state: SessionState): HostProjection | null {
  if (state.revision === null) return null;
  return Object.freeze({
    revision: state.revision,
    enabled: state.enabled,
    focusMode: state.focusMode,
    hideGeneratedFiles: state.hideGeneratedFiles,
    controls: Object.freeze([
      { command: 'toggle-enabled', label: state.enabled ? 'Turn GoLens off' : 'Turn GoLens on', pressed: state.enabled },
      { command: 'toggle-focus', label: state.focusMode ? 'Leave review focus' : 'Enter review focus', pressed: state.focusMode, disabled: !state.enabled },
      { command: 'cache-related', label: 'Cache related packages', disabled: !state.enabled },
      { command: 'open-bookmarks', label: 'Open bookmarks', disabled: !state.enabled },
    ] satisfies readonly ControlProjection[]),
    ...(state.status ? { status: state.status } : {}),
  });
}

function reconcile(state: SessionState): readonly SessionEffect[] {
  const next = projection(state);
  return next ? [{ type: 'apply', projection: next }] : [];
}

export function setSessionStatus(state: SessionState, status: string | undefined): Readonly<{ state: SessionState; effects: readonly SessionEffect[] }> {
  const { status: _status, ...rest } = state;
  const next = Object.freeze({ ...rest, ...(status ? { status } : {}) });
  return { state: next, effects: reconcile(next) };
}

export function reduceSession(state: SessionState, event: HostEvent): Readonly<{ state: SessionState; effects: readonly SessionEffect[] }> {
  if (event.type === 'host-revised') {
    if (state.revision !== null && Number(event.revision) <= Number(state.revision)) return { state, effects: [] };
    const { status: _status, ...rest } = state;
    const next = Object.freeze({ ...rest, revision: event.revision, focusMode: false });
    return { state: next, effects: reconcile(next) };
  }
  if (state.revision === null || event.revision !== state.revision) return { state, effects: [] };
  if (event.type === 'fullscreen-changed') {
    const { status: _status, ...rest } = state;
    const next = Object.freeze({ ...rest, focusMode: event.active });
    return { state: next, effects: reconcile(next) };
  }
  if (event.command === 'toggle-enabled') {
    const { status: _status, ...rest } = state;
    const next = Object.freeze({ ...rest, enabled: !state.enabled, focusMode: false });
    return { state: next, effects: reconcile(next) };
  }
  if (event.command === 'toggle-focus' && state.enabled) {
    return { state, effects: [{ type: 'perform', action: 'set-fullscreen', active: !state.focusMode }] };
  }
  if (event.command === 'focus-file-search' || event.command === 'clear-file-search') {
    return { state, effects: [{ type: 'perform', action: event.command }] };
  }
  if ((event.command === 'hover-target' || event.command === 'activate-target') && event.target.identifier && state.enabled) {
    return { state, effects: [{ type: 'query', target: event.target }] };
  }
  if (event.command === 'dismiss-surface') {
    const { status: _status, ...next } = state;
    return { state: next, effects: reconcile(next) };
  }
  return { state, effects: [] };
}
