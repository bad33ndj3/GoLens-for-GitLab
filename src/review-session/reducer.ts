import type { CoverageProgress, SemanticOutcome, SemanticQuery, SemanticSnapshotRevision, SourceLocation } from '../go-intelligence/index.ts';
import type { ActiveSurfaceProjection, ControlProjection, DiffTarget, FullFileControlProjection, HostEvent, HostProjection, HostRevision, ShortcutProjection } from '../gitlab-host/index.ts';

export type SessionBookmark = Readonly<{
  id: string;
  scope: Readonly<{ origin: string; project: string; mergeRequest: string; headSha: string }>;
  location: Readonly<{ path: string; side: 'old' | 'new'; startLine: number; endLine: number }>;
}>;

export type SessionPreferences = Readonly<{
  enabled: boolean;
  hideGeneratedFiles: boolean;
  shortcuts?: readonly ShortcutProjection[];
}>;

type SemanticWork = Readonly<{
  operationId: number;
  target: DiffTarget;
  purpose: 'hover' | 'select' | 'activate' | 'selection' | 'continuation';
  request: SemanticQuery;
  expectedSnapshot?: SemanticSnapshotRevision;
}>;

export type SessionState = Readonly<{
  sessionId: string;
  source: DiffTarget['source'];
  revision: HostRevision | null;
  enabled: boolean;
  hideGeneratedFiles: boolean;
  shortcuts: readonly ShortcutProjection[];
  focusMode: boolean;
  cacheBusy: boolean;
  nextOperationId: number;
  semantic: SemanticWork | undefined;
  snapshot: SemanticSnapshotRevision | undefined;
  cacheOperationId: number | undefined;
  bookmarkOperationId: number | undefined;
  reviewOperationId: number | undefined;
  selected: DiffTarget | undefined;
  targets: readonly DiffTarget[];
  occurrences: readonly SourceLocation[];
  fullFileControls: readonly FullFileControlProjection[];
  choices: readonly DiffTarget[];
  bookmarks: readonly SessionBookmark[];
  history: readonly DiffTarget[];
  historyIndex: number;
  status: string | undefined;
  announcement: string | undefined;
  surface: ActiveSurfaceProjection | undefined;
  destination: DiffTarget['token'] | undefined;
}>;

type PerformEffect =
  | Readonly<{ action: 'set-fullscreen'; active: boolean }>
  | Readonly<{ action: 'focus-file-search' | 'clear-file-search' }>
  | Readonly<{ action: 'reveal-target'; target: DiffTarget }>
  | Readonly<{ action: 'reveal-source'; source: DiffTarget['source']; path: DiffTarget['path']; line: number }>
  | Readonly<{ action: 'navigate-relative'; kind: 'occurrence' | 'hunk' | 'file' | 'bookmark'; direction: 'previous' | 'next' }>
  | Readonly<{ action: 'set-full-file'; path: DiffTarget['path']; full: boolean }>;

export type SessionEffect =
  | Readonly<{ type: 'apply'; projection: HostProjection }>
  | (Readonly<{ type: 'perform'; operationId: number }> & PerformEffect)
  | (Readonly<{ type: 'query' }> & SemanticWork)
  | Readonly<{ type: 'cache-related'; operationId: number; revision: HostRevision }>
  | Readonly<{ type: 'load-bookmarks'; operationId: number; revision: HostRevision; open: boolean }>
  | Readonly<{ type: 'toggle-bookmark'; operationId: number; revision: HostRevision; target: DiffTarget }>
  | Readonly<{ type: 'read-review-status'; operationId: number; revision: HostRevision; milestone: 'approval' | 'merge' }>
  | Readonly<{ type: 'save-enabled'; enabled: boolean }>;

export type SessionRuntimeEvent =
  | HostEvent
  | Readonly<{ type: 'preferences-changed'; preferences: SessionPreferences }>
  | Readonly<{ type: 'semantic-completed'; sessionId: string; revision: HostRevision; operationId: number; outcome: SemanticOutcome }>
  | Readonly<{ type: 'semantic-failed'; sessionId: string; revision: HostRevision; operationId: number }>
  | Readonly<{ type: 'coverage-progress'; sessionId: string; revision: HostRevision; operationId: number; progress: CoverageProgress }>
  | Readonly<{ type: 'coverage-completed'; sessionId: string; revision: HostRevision; operationId: number; outcome: { status: string; source: DiffTarget['source']; snapshot: string } }>
  | Readonly<{ type: 'bookmarks-loaded'; sessionId: string; revision: HostRevision; operationId: number; bookmarks: readonly SessionBookmark[]; open: boolean }>
  | Readonly<{ type: 'bookmark-toggled'; sessionId: string; revision: HostRevision; operationId: number; bookmarks: readonly SessionBookmark[]; action: 'added' | 'removed' }>
  | Readonly<{ type: 'review-status-read'; sessionId: string; revision: HostRevision; operationId: number; milestone: 'approval' | 'merge'; confirmed: boolean }>;

function withoutTransient(state: SessionState): SessionState {
  return Object.freeze({ ...state, cacheBusy: false, semantic: undefined, cacheOperationId: undefined, bookmarkOperationId: undefined, reviewOperationId: undefined, selected: undefined,
    targets: [], occurrences: [], fullFileControls: [], choices: [], bookmarks: [], history: [], historyIndex: -1, status: undefined, announcement: undefined, surface: undefined, destination: undefined });
}

export function initialSessionState(sessionId: string, source: DiffTarget['source'], preferences: SessionPreferences): SessionState {
  return Object.freeze({
    sessionId, source, revision: null, enabled: preferences.enabled, hideGeneratedFiles: preferences.hideGeneratedFiles,
    shortcuts: preferences.shortcuts || [], focusMode: false, cacheBusy: false, nextOperationId: 1,
    semantic: undefined, snapshot: undefined, cacheOperationId: undefined, bookmarkOperationId: undefined, reviewOperationId: undefined, selected: undefined,
    targets: [], occurrences: [], fullFileControls: [], choices: [], bookmarks: [], history: [], historyIndex: -1,
    status: undefined, announcement: undefined, surface: undefined, destination: undefined,
  });
}

function sameSource(left: DiffTarget['source'], right: DiffTarget['source']): boolean {
  return left.repositoryKey === right.repositoryKey && left.commitSha === right.commitSha;
}

function targetFor(state: SessionState, location: { path: string; line: number }, source: DiffTarget['source']): DiffTarget | undefined {
  return state.targets.find((target) => target.path === location.path && target.line === location.line && sameSource(target.source, source));
}

function bookmarkTokens(state: SessionState): readonly DiffTarget['token'][] {
  return state.targets.filter((target) => state.bookmarks.some((bookmark) => bookmark.scope.headSha === target.source.commitSha
    && bookmark.location.path === target.path && bookmark.location.side === target.side
    && target.line >= bookmark.location.startLine && target.line <= bookmark.location.endLine)).map(({ token }) => token);
}

function projection(state: SessionState): HostProjection | null {
  if (state.revision === null) return null;
  return Object.freeze({
    revision: state.revision,
    enabled: state.enabled,
    focusMode: state.focusMode,
    hideGeneratedFiles: state.hideGeneratedFiles,
    decorateTestFiles: true,
    controls: Object.freeze([
      { command: 'toggle-enabled', label: state.enabled ? 'Turn GoLens off' : 'Turn GoLens on', pressed: state.enabled },
      { command: 'toggle-focus', label: state.focusMode ? 'Leave review focus' : 'Enter review focus', pressed: state.focusMode, disabled: !state.enabled },
      { command: 'cache-related', label: 'Cache related packages', busy: state.cacheBusy, disabled: !state.enabled },
      { command: 'open-bookmarks', label: 'Open bookmarks', disabled: !state.enabled },
    ] satisfies readonly ControlProjection[]),
    shortcuts: state.shortcuts,
    interactiveTargets: state.targets,
    occurrenceLocations: state.occurrences.map((location) => ({ ...location, source: state.source })),
    bookmarks: bookmarkTokens(state),
    bookmarkLocations: state.bookmarks.filter(({ scope }) => scope.headSha === state.source.commitSha).map(({ location }) => ({
      source: state.source, path: location.path as DiffTarget['path'], line: location.startLine,
    })),
    fullFileControls: state.fullFileControls,
    ...(state.destination ? { destination: state.destination } : {}),
    ...(state.status ? { status: state.status } : {}),
    ...(state.announcement ? { announcement: state.announcement } : {}),
    ...(state.surface ? { surface: state.surface } : {}),
  });
}

function result(state: SessionState, effects: readonly SessionEffect[] = []): Readonly<{ state: SessionState; effects: readonly SessionEffect[] }> {
  const next = projection(state);
  return { state, effects: next ? [{ type: 'apply', projection: next }, ...effects] : effects };
}

function remember(state: SessionState, target: DiffTarget): SessionState {
  const targets = state.targets.some(({ token }) => token === target.token) ? state.targets : [...state.targets, target];
  return Object.freeze({ ...state, targets, selected: target });
}

function startQuery(state: SessionState, target: DiffTarget, purpose: SemanticWork['purpose'], request: SemanticQuery, expectedSnapshot?: string) {
  const snapshot = expectedSnapshot || state.snapshot;
  const work: SemanticWork = Object.freeze({ operationId: state.nextOperationId, target, purpose, request, ...(snapshot ? { expectedSnapshot: snapshot } : {}) });
  return result(Object.freeze({ ...state, semantic: work, nextOperationId: state.nextOperationId + 1, status: purpose === 'hover' ? undefined : 'Resolving Go symbol…' }), [{ type: 'query', ...work }]);
}

function navigate(state: SessionState, from: DiffTarget, destination: DiffTarget) {
  const history = state.historyIndex >= 0 ? [...state.history.slice(0, state.historyIndex + 1), destination] : [from, destination];
  const operationId = state.nextOperationId;
  return result(Object.freeze({ ...state, selected: destination, destination: destination.token, history, historyIndex: history.length - 1,
    nextOperationId: operationId + 1, status: undefined }), [{ type: 'perform', action: 'reveal-target', target: destination, operationId }]);
}

function semanticStatus(outcome: SemanticOutcome): string | undefined {
  if (outcome.status === 'resolved') return outcome.symbol.signature;
  if (outcome.status === 'missing') return undefined;
  if (outcome.status === 'coverage-insufficient') return `Coverage insufficient: ${outcome.reason}`;
  if (outcome.status === 'unavailable') return `Go Intelligence unavailable: ${outcome.reason}`;
  return outcome.status.replace(/-/g, ' ');
}

function semanticCompletion(state: SessionState, event: Extract<SessionRuntimeEvent, { type: 'semantic-completed' }>) {
  const work = state.semantic;
  if (!work || event.sessionId !== state.sessionId || event.operationId !== work.operationId || event.revision !== state.revision
    || !sameSource(event.outcome.source, state.source) || !sameSource(work.target.source, state.source)
    || ((work.expectedSnapshot || state.snapshot) && event.outcome.snapshot !== (work.expectedSnapshot || state.snapshot))) return { state, effects: [] };
  const cleared = Object.freeze({ ...state, semantic: undefined, snapshot: event.outcome.snapshot });
  if (event.outcome.status === 'resolved' && work.purpose === 'select') {
    return startQuery(cleared, work.target, 'selection', { operation: 'find-references', symbol: event.outcome.symbol.identity }, event.outcome.snapshot);
  }
  if (event.outcome.status === 'resolved' && work.purpose === 'activate') {
    const destination = targetFor(cleared, event.outcome.symbol.identity, event.outcome.source);
    if (!event.outcome.isDefinition && destination) return navigate(cleared, work.target, destination);
    if (!event.outcome.isDefinition) {
      const operationId = cleared.nextOperationId;
      return result(Object.freeze({ ...cleared, nextOperationId: operationId + 1, status: undefined }), [{
        type: 'perform', action: 'reveal-source', source: event.outcome.source, path: event.outcome.symbol.identity.path,
        line: event.outcome.symbol.identity.line, operationId,
      }]);
    }
    const operation = event.outcome.symbol.identity.kind === 'interface' ? 'find-implementations' : 'find-references';
    const request: SemanticQuery = operation === 'find-implementations'
      ? { operation, symbol: event.outcome.symbol.identity }
      : { operation, symbol: event.outcome.symbol.identity };
    return startQuery(cleared, work.target, 'continuation', request, event.outcome.snapshot);
  }
  if ((event.outcome.status === 'references' || event.outcome.status === 'implementations') && (work.purpose === 'continuation' || work.purpose === 'selection')) {
    const locations = event.outcome.status === 'references'
      ? event.outcome.locations
      : event.outcome.candidates.map(({ definition }) => definition.identity);
    if (work.purpose === 'selection') return result(Object.freeze({ ...cleared, occurrences: locations, announcement: `${locations.length} occurrence${locations.length === 1 ? '' : 's'} selected.` }));
    const destinations = locations.map((location) => targetFor(cleared, location, event.outcome.source)).filter((target): target is DiffTarget => Boolean(target));
    if (destinations.length === 1) return navigate(cleared, work.target, destinations[0]!);
    const surface = Object.freeze({ kind: 'popover' as const, title: 'Go destinations', body: destinations.length ? `${destinations.length} destinations in this diff.` : 'No loaded destination in this diff.',
      actions: destinations.map(({ token, path, line }) => ({ id: `destination:${token}`, label: `${path}:${line}` })) });
    return result(Object.freeze({ ...cleared, choices: destinations, surface, status: semanticStatus(event.outcome) }));
  }
  const status = semanticStatus(event.outcome);
  const surface = event.outcome.status === 'resolved'
    ? Object.freeze({ kind: 'popover' as const, title: event.outcome.symbol.signature, body: event.outcome.symbol.documentation || `${event.outcome.symbol.identity.path}:${event.outcome.symbol.identity.line}` })
    : undefined;
  return result(Object.freeze({ ...cleared, ...(status ? { status } : {}), ...(surface ? { surface } : {}) }));
}

export function reduceSession(state: SessionState, event: SessionRuntimeEvent): Readonly<{ state: SessionState; effects: readonly SessionEffect[] }> {
  if (event.type === 'preferences-changed') {
    const leaveFocus = state.enabled && !event.preferences.enabled && state.focusMode && state.revision !== null;
    const operationId = state.nextOperationId;
    return result(Object.freeze({ ...state, enabled: event.preferences.enabled, hideGeneratedFiles: event.preferences.hideGeneratedFiles,
      shortcuts: event.preferences.shortcuts || state.shortcuts, nextOperationId: leaveFocus ? operationId + 1 : operationId }), leaveFocus
      ? [{ type: 'perform', action: 'set-fullscreen', active: false, operationId }] : []);
  }
  if (event.type === 'host-revised') {
    if (state.revision !== null && Number(event.revision) <= Number(state.revision)) return { state, effects: [] };
    const operationId = state.nextOperationId;
    const next = Object.freeze({ ...withoutTransient(state), revision: event.revision, nextOperationId: operationId + 1 });
    return result(Object.freeze({ ...next, bookmarkOperationId: operationId }), [{ type: 'load-bookmarks', operationId, revision: event.revision, open: false }]);
  }
  if (event.type === 'semantic-completed') return semanticCompletion(state, event);
  if (event.type === 'semantic-failed') {
    if (event.sessionId !== state.sessionId || event.revision !== state.revision || event.operationId !== state.semantic?.operationId) return { state, effects: [] };
    return result(Object.freeze({ ...state, semantic: undefined, status: 'Go Intelligence is unavailable.' }));
  }
  if (event.type === 'coverage-progress') {
    if (event.sessionId !== state.sessionId || event.revision !== state.revision || event.operationId !== state.cacheOperationId) return { state, effects: [] };
    const { completed, total, phase } = event.progress;
    const status = total === undefined ? `Caching related packages: ${phase}…` : `Caching related packages: ${completed} of ${total}.`;
    return result(Object.freeze({ ...state, status }));
  }
  if (event.type === 'coverage-completed') {
    if (event.sessionId !== state.sessionId || event.revision !== state.revision || event.operationId !== state.cacheOperationId
      || !sameSource(event.outcome.source, state.source)) return { state, effects: [] };
    return result(Object.freeze({ ...state, cacheBusy: false, cacheOperationId: undefined, snapshot: event.outcome.snapshot || state.snapshot,
      status: event.outcome.status === 'ready' ? 'Related package cache is ready.' : 'Related package cache is unavailable.' }));
  }
  if (event.type === 'bookmarks-loaded' || event.type === 'bookmark-toggled') {
    if (event.sessionId !== state.sessionId || event.revision !== state.revision || event.operationId !== state.bookmarkOperationId) return { state, effects: [] };
    const currentBookmarks = event.bookmarks.filter(({ scope }) => scope.headSha === state.source.commitSha).length;
    const surface = event.type === 'bookmarks-loaded' && event.open
      ? Object.freeze({ kind: 'dialog' as const, title: 'MR bookmarks', body: `${currentBookmarks} current bookmark${currentBookmarks === 1 ? '' : 's'}.`, modal: true })
      : state.surface;
    const announcement = event.type === 'bookmark-toggled' ? `Bookmark ${event.action}.` : state.announcement;
    return result(Object.freeze({ ...state, bookmarks: event.bookmarks, ...(surface ? { surface } : {}), ...(announcement ? { announcement } : {}) }));
  }
  if (event.type === 'review-status-read') {
    if (event.sessionId !== state.sessionId || event.revision !== state.revision || event.operationId !== state.reviewOperationId) return { state, effects: [] };
    return event.confirmed ? result(Object.freeze({ ...state, announcement: `${event.milestone === 'approval' ? 'Approval' : 'Merge'} confirmed.` })) : { state, effects: [] };
  }
  if (state.revision === null || event.revision !== state.revision) return { state, effects: [] };
  if (event.type === 'fullscreen-changed') return result(Object.freeze({ ...state, focusMode: event.active, status: undefined }));

  if (event.command === 'toggle-enabled') {
    const operationId = state.nextOperationId;
    const enabled = !state.enabled;
    return result(Object.freeze({ ...state, enabled, nextOperationId: operationId + 1 }), [
      { type: 'save-enabled', enabled },
      ...(state.focusMode ? [{ type: 'perform' as const, action: 'set-fullscreen' as const, active: false, operationId }] : []),
    ]);
  }
  if (event.command === 'toggle-focus' && state.enabled) {
    const operationId = state.nextOperationId;
    return { state: Object.freeze({ ...state, nextOperationId: operationId + 1 }), effects: [{ type: 'perform', action: 'set-fullscreen', active: !state.focusMode, operationId }] };
  }
  if (event.command === 'focus-file-search' || event.command === 'clear-file-search') {
    const operationId = state.nextOperationId;
    return { state: Object.freeze({ ...state, nextOperationId: operationId + 1 }), effects: [{ type: 'perform', action: event.command, operationId }] };
  }
  if ((event.command === 'hover-target' || event.command === 'select-target' || event.command === 'activate-target') && event.target.identifier && state.enabled) {
    if (!sameSource(event.target.source, state.source)) return { state, effects: [] };
    const next = remember(state, event.target);
    return startQuery(next, event.target, event.command === 'hover-target' ? 'hover' : event.command === 'select-target' ? 'select' : 'activate', {
      operation: 'resolve-symbol', path: event.target.path, line: event.target.line, column: event.target.column || 1, identifier: event.target.identifier,
    });
  }
  if (event.command === 'semantic-jump' && state.selected?.identifier && state.enabled) {
    return startQuery(state, state.selected, 'activate', { operation: 'resolve-symbol', path: state.selected.path, line: state.selected.line, column: state.selected.column || 1, identifier: state.selected.identifier });
  }
  if (event.command === 'cache-related' && state.enabled) {
    const operationId = state.nextOperationId;
    return result(Object.freeze({ ...state, cacheBusy: true, cacheOperationId: operationId, nextOperationId: operationId + 1, status: 'Caching related packages…' }), [{ type: 'cache-related', operationId, revision: state.revision }]);
  }
  if (event.command === 'open-bookmarks') {
    const operationId = state.nextOperationId;
    return { state: Object.freeze({ ...state, bookmarkOperationId: operationId, nextOperationId: operationId + 1 }), effects: [{ type: 'load-bookmarks', operationId, revision: state.revision, open: true }] };
  }
  if (event.command === 'toggle-bookmark' && state.selected) {
    const operationId = state.nextOperationId;
    return { state: Object.freeze({ ...state, bookmarkOperationId: operationId, nextOperationId: operationId + 1 }), effects: [{ type: 'toggle-bookmark', operationId, revision: state.revision, target: state.selected }] };
  }
  if (event.command === 'toggle-full-file') {
    const current = state.fullFileControls.find(({ path }) => path === event.path);
    const full = !current?.full;
    const controls = [...state.fullFileControls.filter(({ path }) => path !== event.path), { path: event.path, full }];
    const operationId = state.nextOperationId;
    return result(Object.freeze({ ...state, fullFileControls: controls, nextOperationId: operationId + 1 }), [
      { type: 'perform', action: 'set-full-file', path: event.path, full, operationId },
    ]);
  }
  if (event.command === 'surface-action') {
    const target = state.choices.find(({ token }) => event.actionId === `destination:${token}`);
    return target && state.selected ? navigate(state, state.selected, target) : { state, effects: [] };
  }
  if (event.command === 'native-approve' || event.command === 'native-merge') {
    const operationId = state.nextOperationId;
    return { state: Object.freeze({ ...state, reviewOperationId: operationId, nextOperationId: operationId + 1 }), effects: [{
      type: 'read-review-status', operationId, revision: state.revision, milestone: event.command === 'native-approve' ? 'approval' : 'merge',
    }] };
  }
  if (event.command === 'previous-occurrence' || event.command === 'next-occurrence'
    || event.command === 'previous-hunk' || event.command === 'next-hunk'
    || event.command === 'previous-file' || event.command === 'next-file'
    || event.command === 'previous-bookmark' || event.command === 'next-bookmark') {
    const direction = event.command.startsWith('previous-') ? 'previous' : 'next';
    const kind = event.command.slice(event.command.indexOf('-') + 1) as 'occurrence' | 'hunk' | 'file' | 'bookmark';
    const operationId = state.nextOperationId;
    return { state: Object.freeze({ ...state, nextOperationId: operationId + 1 }), effects: [{ type: 'perform', action: 'navigate-relative', kind, direction, operationId }] };
  }
  if ((event.command === 'history-back' || event.command === 'history-forward') && state.history.length) {
    const index = Math.max(0, Math.min(state.history.length - 1, state.historyIndex + (event.command === 'history-back' ? -1 : 1)));
    const target = state.history[index]!;
    const operationId = state.nextOperationId;
    return result(Object.freeze({ ...state, historyIndex: index, selected: target, destination: target.token, nextOperationId: operationId + 1 }), [{ type: 'perform', action: 'reveal-target', target, operationId }]);
  }
  if (event.command === 'dismiss-surface') {
    return result(Object.freeze({ ...state, choices: [], surface: undefined, status: undefined, announcement: undefined }));
  }
  return { state, effects: [] };
}
