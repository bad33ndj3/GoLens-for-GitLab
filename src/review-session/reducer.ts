import type { CoverageOutcome, CoverageProgress, CoverageRequest, SemanticOutcome, SemanticQuery, SemanticSnapshotRevision, SourceLocation } from '../go-intelligence/index.ts';
import type { ActionOutcome, ActiveSurfaceProjection, BookmarkSelection, ControlProjection, DiffTarget, FullFileControlProjection, HostEvent, HostProjection, HostRevision, ShortcutProjection } from '../gitlab-host/index.ts';

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
  locations?: readonly SourceLocation[];
}>;

type SemanticRetry = Readonly<Pick<SemanticWork, 'target' | 'purpose' | 'request'>>;

type NavigationLocation = Readonly<{ source: DiffTarget['source']; path: DiffTarget['path']; line: number }>;
type HistoryPoint = DiffTarget | NavigationLocation;

export type SessionState = Readonly<{
  sessionId: string;
  source: DiffTarget['source'];
  oldSource: DiffTarget['source'] | undefined;
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
  queryCoverageOperationId: number | undefined;
  coverageRetry: SemanticRetry | undefined;
  bookmarkOperationId: number | undefined;
  reviewOperationId: number | undefined;
  navigationOperationId: number | undefined;
  fullFileOperationId: number | undefined;
  selected: DiffTarget | undefined;
  targets: readonly DiffTarget[];
  occurrences: readonly SourceLocation[];
  fullFileControls: readonly FullFileControlProjection[];
  choices: readonly NavigationLocation[];
  externalUrl: string | undefined;
  bookmarks: readonly SessionBookmark[];
  history: readonly HistoryPoint[];
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
  | Readonly<{ action: 'open-destination'; destination: Readonly<{ kind: 'documentation'; url: string }> }>
  | Readonly<{ action: 'set-full-file'; path: DiffTarget['path']; full: boolean }>;

export type SessionEffect =
  | Readonly<{ type: 'apply'; projection: HostProjection }>
  | (Readonly<{ type: 'perform'; operationId: number }> & PerformEffect)
  | (Readonly<{ type: 'query' }> & SemanticWork)
  | Readonly<{ type: 'cache-related'; operationId: number; revision: HostRevision }>
  | Readonly<{ type: 'ensure-query-coverage'; operationId: number; revision: HostRevision; retry: SemanticRetry; request: CoverageRequest }>
  | Readonly<{ type: 'cancel-query-coverage' }>
  | Readonly<{ type: 'cancel-workflows' }>
  | Readonly<{ type: 'load-bookmarks'; operationId: number; revision: HostRevision; open: boolean }>
  | Readonly<{ type: 'toggle-bookmark'; operationId: number; revision: HostRevision; bookmark: BookmarkSelection }>
  | Readonly<{ type: 'read-review-status'; operationId: number; revision: HostRevision; milestone: 'approval' | 'merge' }>
  | Readonly<{ type: 'navigate-source'; operationId: number; revision: HostRevision; from: DiffTarget; destination: NavigationLocation }>
  | Readonly<{ type: 'save-enabled'; enabled: boolean }>
  | Readonly<{ type: 'save-coach-enabled'; enabled: boolean }>;

export type SessionRuntimeEvent =
  | HostEvent
  | Readonly<{ type: 'preferences-changed'; preferences: SessionPreferences }>
  | Readonly<{ type: 'semantic-completed'; sessionId: string; revision: HostRevision; operationId: number; outcome: SemanticOutcome }>
  | Readonly<{ type: 'semantic-failed'; sessionId: string; revision: HostRevision; operationId: number }>
  | Readonly<{ type: 'coverage-progress'; sessionId: string; revision: HostRevision; operationId: number; progress: CoverageProgress }>
  | Readonly<{ type: 'coverage-completed'; sessionId: string; revision: HostRevision; operationId: number; outcome: { status: string; source: DiffTarget['source']; snapshot: string } }>
  | Readonly<{ type: 'query-coverage-progress'; sessionId: string; revision: HostRevision; operationId: number; progress: CoverageProgress }>
  | Readonly<{ type: 'query-coverage-completed'; sessionId: string; revision: HostRevision; operationId: number; outcome: CoverageOutcome }>
  | Readonly<{ type: 'bookmarks-loaded'; sessionId: string; revision: HostRevision; operationId: number; bookmarks: readonly SessionBookmark[]; open: boolean }>
  | Readonly<{ type: 'bookmark-toggled'; sessionId: string; revision: HostRevision; operationId: number; bookmarks: readonly SessionBookmark[]; action: 'added' | 'removed' }>
  | Readonly<{ type: 'review-status-read'; sessionId: string; revision: HostRevision; operationId: number; milestone: 'approval' | 'merge'; confirmed: boolean }>
  | Readonly<{ type: 'source-navigation-completed'; sessionId: string; revision: HostRevision; operationId: number; from: DiffTarget; destination: NavigationLocation }>
  | Readonly<{ type: 'full-file-completed'; sessionId: string; revision: HostRevision; operationId: number; path: DiffTarget['path']; full: boolean; outcome: ActionOutcome }>
  | Readonly<{ type: 'coach-tip'; sessionId: string; revision: HostRevision; label: string; binding: string }>;

function withoutTransient(state: SessionState): SessionState {
  return Object.freeze({ ...state, cacheBusy: false, semantic: undefined, cacheOperationId: undefined, queryCoverageOperationId: undefined, coverageRetry: undefined, bookmarkOperationId: undefined, reviewOperationId: undefined, navigationOperationId: undefined, fullFileOperationId: undefined, selected: undefined,
    targets: [], occurrences: [], choices: [], externalUrl: undefined, bookmarks: [], history: [], historyIndex: -1, status: undefined, announcement: undefined, surface: undefined, destination: undefined });
}

export function initialSessionState(sessionId: string, source: DiffTarget['source'], preferences: SessionPreferences, oldSource?: DiffTarget['source']): SessionState {
  return Object.freeze({
    sessionId, source, oldSource, revision: null, enabled: preferences.enabled, hideGeneratedFiles: preferences.hideGeneratedFiles,
    shortcuts: preferences.shortcuts || [], focusMode: false, cacheBusy: false, nextOperationId: 1,
    semantic: undefined, snapshot: undefined, cacheOperationId: undefined, queryCoverageOperationId: undefined, coverageRetry: undefined, bookmarkOperationId: undefined, reviewOperationId: undefined, navigationOperationId: undefined, fullFileOperationId: undefined, selected: undefined,
    targets: [], occurrences: [], fullFileControls: [], choices: [], externalUrl: undefined, bookmarks: [], history: [], historyIndex: -1,
    status: undefined, announcement: undefined, surface: undefined, destination: undefined,
  });
}

function sameSource(left: DiffTarget['source'], right: DiffTarget['source']): boolean {
  return left.repositoryKey === right.repositoryKey && left.commitSha === right.commitSha;
}

function targetFor(state: SessionState, location: { path: string; line: number }, source: DiffTarget['source']): DiffTarget | undefined {
  return state.targets.find((target) => target.path === location.path && target.line === location.line
    && (!('column' in location) || !target.column || target.column === location.column) && sameSource(target.source, source));
}

function bookmarkTokens(state: SessionState): readonly DiffTarget['token'][] {
  return state.targets.filter((target) => state.bookmarks.some((bookmark) => bookmark.scope.headSha === state.source.commitSha
    && bookmark.location.path === target.path && bookmark.location.side === target.side
    && target.line >= bookmark.location.startLine && target.line <= bookmark.location.endLine)).map(({ token }) => token);
}

function idleFullFileControls(controls: readonly FullFileControlProjection[]) {
  return controls.map(({ busy: _busy, ...control }) => control);
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
    bookmarkLocations: state.bookmarks.filter(({ scope, location }) => scope.headSha === state.source.commitSha && (location.side === 'new' || state.oldSource)).map(({ location }) => ({
      source: location.side === 'old' ? state.oldSource! : state.source, path: location.path as DiffTarget['path'], line: location.startLine,
    })),
    fullFileControls: state.fullFileControls,
    ...(state.destination ? { destination: state.destination } : {}),
    ...(state.selected ? { selected: state.selected } : {}),
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

function startQuery(state: SessionState, target: DiffTarget, purpose: SemanticWork['purpose'], request: SemanticQuery, expectedSnapshot?: string, locations?: readonly SourceLocation[]) {
  const snapshot = expectedSnapshot || state.snapshot;
  const work: SemanticWork = Object.freeze({ operationId: state.nextOperationId, target, purpose, request,
    ...(snapshot ? { expectedSnapshot: snapshot } : {}), ...(locations ? { locations } : {}) });
  return result(Object.freeze({ ...state, semantic: work, nextOperationId: state.nextOperationId + 1, status: purpose === 'hover' ? undefined : 'Resolving Go symbol…' }), [{ type: 'query', ...work }]);
}

function navigate(state: SessionState, from: DiffTarget, destination: DiffTarget) {
  const history = state.historyIndex >= 0 ? [...state.history.slice(0, state.historyIndex + 1), destination] : [from, destination];
  const operationId = state.nextOperationId;
  return result(Object.freeze({ ...state, selected: destination, destination: destination.token, history, historyIndex: history.length - 1,
    nextOperationId: operationId + 1, status: undefined }), [{ type: 'perform', action: 'reveal-target', target: destination, operationId }]);
}

function navigateSource(state: SessionState, from: DiffTarget, destination: NavigationLocation) {
  const operationId = state.nextOperationId;
  return result(Object.freeze({ ...state, navigationOperationId: operationId, nextOperationId: operationId + 1, status: undefined }), [{
    type: 'navigate-source', operationId, revision: from.revision, from, destination,
  }]);
}

function semanticStatus(outcome: SemanticOutcome): string | undefined {
  if (outcome.status === 'resolved') return outcome.symbol.signature;
  if (outcome.status === 'missing') return undefined;
  if (outcome.status === 'coverage-insufficient') return `Coverage insufficient: ${outcome.reason}`;
  if (outcome.status === 'unavailable') return `Go Intelligence unavailable: ${outcome.reason}`;
  return outcome.status.replace(/-/g, ' ');
}

function packagePath(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf('/')));
}

function semanticCompletion(state: SessionState, event: Extract<SessionRuntimeEvent, { type: 'semantic-completed' }>) {
  const work = state.semantic;
  if (!work || event.sessionId !== state.sessionId || event.operationId !== work.operationId || event.revision !== state.revision
    || !sameSource(event.outcome.source, state.source) || !sameSource(work.target.source, state.source)
    || (event.outcome.status !== 'stale-page' && (work.expectedSnapshot || state.snapshot)
      && event.outcome.snapshot !== (work.expectedSnapshot || state.snapshot))) return { state, effects: [] };
  const cleared = Object.freeze({ ...state, semantic: undefined, coverageRetry: undefined, snapshot: event.outcome.snapshot });
  if (event.outcome.status === 'stale-page' && (work.request.operation === 'find-references' || work.request.operation === 'find-implementations')) {
    const { pageToken: _pageToken, ...request } = work.request;
    return startQuery(cleared, work.target, work.purpose, request, event.outcome.snapshot);
  }
  if (event.outcome.status === 'resolved' && work.purpose === 'select') {
    return startQuery(cleared, work.target, 'selection', { operation: 'find-references', symbol: event.outcome.symbol.identity }, event.outcome.snapshot);
  }
  if (event.outcome.status === 'resolved' && work.purpose === 'activate') {
    const destination = targetFor(cleared, event.outcome.symbol.identity, event.outcome.source);
    if (!event.outcome.isDefinition && destination) return navigate(cleared, work.target, destination);
    if (!event.outcome.isDefinition) {
      return navigateSource(cleared, work.target, { source: event.outcome.source, path: event.outcome.symbol.identity.path, line: event.outcome.symbol.identity.line });
    }
    const operation = event.outcome.symbol.identity.kind === 'interface' ? 'find-implementations' : 'find-references';
    const request: SemanticQuery = operation === 'find-implementations'
      ? { operation, symbol: event.outcome.symbol.identity }
      : { operation, symbol: event.outcome.symbol.identity };
    return startQuery(cleared, work.target, 'continuation', request, event.outcome.snapshot);
  }
  if (event.outcome.status === 'coverage-insufficient') {
    let request: SemanticQuery = work.request;
    if (work.request.operation !== 'resolve-symbol') {
      const { pageToken: _pageToken, ...firstPage } = work.request;
      request = firstPage;
    }
    const coverageRetry = Object.freeze({ target: work.target, purpose: work.purpose, request });
    if (event.outcome.required === 'current-package') {
      const operationId = state.nextOperationId;
      return result(Object.freeze({ ...cleared, cacheBusy: true, queryCoverageOperationId: operationId, coverageRetry, nextOperationId: operationId + 1 }), [
        { type: 'ensure-query-coverage', operationId, revision: state.revision!, retry: coverageRetry,
          request: { goal: 'current-package', packagePath: packagePath(work.target.path) } },
      ]);
    }
    const surface = Object.freeze({ kind: 'popover' as const, title: 'More coverage needed', body: event.outcome.reason,
      actions: [{ id: 'complete-coverage', label: 'Search full project' }] });
    return result(Object.freeze({ ...cleared, coverageRetry, surface, status: `Coverage insufficient: ${event.outcome.reason}` }));
  }
  if ((event.outcome.status === 'references' || event.outcome.status === 'implementations') && (work.purpose === 'continuation' || work.purpose === 'selection')) {
    const locations = event.outcome.status === 'references'
      ? event.outcome.locations
      : event.outcome.candidates.map(({ definition }) => definition.identity);
    const allLocations = [...new Map([...(work.locations || []), ...locations].map((location) => [`${location.path}:${location.line}:${location.column}`, location])).values()];
    if (event.outcome.nextPageToken) {
      const request: SemanticQuery = event.outcome.status === 'references'
        ? { operation: 'find-references', symbol: event.outcome.symbol, pageToken: event.outcome.nextPageToken }
        : { operation: 'find-implementations', symbol: event.outcome.symbol, pageToken: event.outcome.nextPageToken };
      return startQuery(cleared, work.target, work.purpose, request, event.outcome.snapshot, allLocations);
    }
    if (work.purpose === 'selection') {
      const selected = { path: work.target.path, line: work.target.line, column: work.target.column || 1 };
      const occurrences = [...new Map([selected, ...allLocations].map((location) => [`${location.path}:${location.line}:${location.column}`, location])).values()];
      return result(Object.freeze({ ...cleared, occurrences, announcement: `${occurrences.length} occurrence${occurrences.length === 1 ? '' : 's'} selected.` }));
    }
    const destinations = allLocations.map(({ path, line }) => ({ source: event.outcome.source, path, line }));
    if (destinations.length === 1) {
      const target = targetFor(cleared, destinations[0]!, event.outcome.source);
      return target ? navigate(cleared, work.target, target) : navigateSource(cleared, work.target, destinations[0]!);
    }
    const surface = Object.freeze({ kind: 'popover' as const, title: 'Go destinations', body: destinations.length ? `${destinations.length} destinations.` : 'No destination found.',
      actions: destinations.map(({ path, line }, index) => ({ id: `destination:${index}`, label: `${path}:${line}` })) });
    return result(Object.freeze({ ...cleared, choices: destinations, surface, status: semanticStatus(event.outcome) }));
  }
  if (event.outcome.status === 'ambiguous') {
    const choices = event.outcome.candidates.map(({ identity }) => ({ source: event.outcome.source, path: identity.path, line: identity.line }));
    const surface = Object.freeze({ kind: 'popover' as const, title: 'Choose a Go definition', body: `${choices.length} definitions match.`,
      actions: choices.map(({ path, line }, index) => ({ id: `destination:${index}`, label: `${path}:${line}` })) });
    return result(Object.freeze({ ...cleared, choices, surface, status: 'ambiguous' }));
  }
  if (event.outcome.status === 'external') {
    const packagePath = event.outcome.packageKind === 'builtin' ? 'builtin' : event.outcome.importPath;
    const externalUrl = packagePath ? `https://pkg.go.dev/${packagePath}#${encodeURIComponent(event.outcome.symbol)}` : undefined;
    const surface = Object.freeze({ kind: 'popover' as const, title: event.outcome.symbol, body: `${event.outcome.packageKind} Go symbol.`,
      ...(externalUrl ? { actions: [{ id: 'external-documentation', label: 'Open documentation' }] } : {}) });
    return result(Object.freeze({ ...cleared, externalUrl, surface, status: 'external' }));
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
    const disabling = state.enabled && !event.preferences.enabled;
    const operationId = state.nextOperationId;
    return result(Object.freeze({ ...state, enabled: event.preferences.enabled, hideGeneratedFiles: event.preferences.hideGeneratedFiles,
      shortcuts: event.preferences.shortcuts || state.shortcuts, nextOperationId: leaveFocus ? operationId + 1 : operationId,
      ...(disabling ? { semantic: undefined, queryCoverageOperationId: undefined, coverageRetry: undefined, cacheBusy: false, cacheOperationId: undefined,
        fullFileOperationId: undefined, fullFileControls: idleFullFileControls(state.fullFileControls), selected: undefined, occurrences: [], choices: [], externalUrl: undefined,
        surface: undefined, status: undefined, announcement: undefined } : {}) }), [
      ...(disabling ? [{ type: 'cancel-workflows' as const }] : []),
      ...(leaveFocus ? [{ type: 'perform' as const, action: 'set-fullscreen' as const, active: false, operationId }] : []),
    ]);
  }
  if (event.type === 'coach-tip') {
    if (event.sessionId !== state.sessionId || event.revision !== state.revision) return { state, effects: [] };
    return result(Object.freeze({ ...state, surface: Object.freeze({ kind: 'popover', title: 'Shortcut tip', body: `Use ${event.binding} for ${event.label.toLowerCase()}.`, actions: [{ id: 'disable-coach', label: 'Turn off tips' }] }) }));
  }
  if (event.type === 'host-revised') {
    if (state.revision !== null && Number(event.revision) <= Number(state.revision)) return { state, effects: [] };
    const operationId = state.nextOperationId;
    const controls = event.files || state.fullFileControls;
    const next = Object.freeze({ ...withoutTransient(state), revision: event.revision, fullFileControls: controls, nextOperationId: operationId + 1 });
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
  if (event.type === 'query-coverage-progress') {
    if (event.sessionId !== state.sessionId || event.revision !== state.revision || event.operationId !== state.queryCoverageOperationId) return { state, effects: [] };
    const { completed, total, phase } = event.progress;
    const status = total === undefined ? `Expanding search coverage: ${phase}…` : `Expanding search coverage: ${completed} of ${total}.`;
    return result(Object.freeze({ ...state, status }));
  }
  if (event.type === 'query-coverage-completed') {
    if (event.sessionId !== state.sessionId || event.revision !== state.revision || event.operationId !== state.queryCoverageOperationId
      || !sameSource(event.outcome.source, state.source)) return { state, effects: [] };
    const retry = state.coverageRetry;
    const next = Object.freeze({ ...state, cacheBusy: false, queryCoverageOperationId: undefined, snapshot: event.outcome.snapshot || state.snapshot });
    if (event.outcome.status === 'ready' && retry) return startQuery(Object.freeze({ ...next, surface: undefined }), retry.target, retry.purpose, retry.request, event.outcome.snapshot);
    if (state.surface === undefined) return result(Object.freeze({ ...next, status: 'Could not index the current package.' }));
    const surface = retry ? Object.freeze({ kind: 'popover' as const, title: 'More coverage needed', body: event.outcome.reason || 'Full-project search is unavailable.',
      actions: [{ id: 'complete-coverage', label: 'Try again' }] }) : state.surface;
    return result(Object.freeze({ ...next, surface, status: 'Full-project search is unavailable.' }));
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
  if (event.type === 'source-navigation-completed') {
    if (event.sessionId !== state.sessionId || event.revision !== state.revision || event.operationId !== state.navigationOperationId) return { state, effects: [] };
    const history = state.historyIndex >= 0 ? [...state.history.slice(0, state.historyIndex + 1), event.destination] : [event.from, event.destination];
    return result(Object.freeze({ ...state, history, historyIndex: history.length - 1 }));
  }
  if (event.type === 'full-file-completed') {
    if (event.sessionId !== state.sessionId || event.revision !== state.revision || event.operationId !== state.fullFileOperationId) return { state, effects: [] };
    const failed = event.outcome.kind !== 'completed' && event.outcome.kind !== 'unchanged';
    const controls = state.fullFileControls.map((control) => {
      if (control.path !== event.path) return control;
      const { busy: _busy, error: _error, ...idle } = control;
      return { ...idle, full: failed ? idle.full : event.full, ...(failed ? { error: 'Full file is unavailable.' } : {}) };
    });
    return result(Object.freeze({ ...state, fullFileOperationId: undefined, fullFileControls: controls }));
  }
  if (state.revision === null || event.revision !== state.revision) return { state, effects: [] };
  if (event.type === 'fullscreen-changed') return result(Object.freeze({ ...state, focusMode: event.active, status: undefined }));

  if (event.command === 'toggle-enabled') {
    const operationId = state.nextOperationId;
    const enabled = !state.enabled;
    return result(Object.freeze({ ...state, enabled, nextOperationId: operationId + 1,
      ...(!enabled ? { semantic: undefined, queryCoverageOperationId: undefined, coverageRetry: undefined, cacheBusy: false, cacheOperationId: undefined,
        fullFileOperationId: undefined, fullFileControls: idleFullFileControls(state.fullFileControls), selected: undefined, occurrences: [], choices: [], externalUrl: undefined,
        surface: undefined, status: undefined, announcement: undefined } : {}) }), [
      { type: 'save-enabled', enabled },
      ...(!enabled ? [{ type: 'cancel-workflows' as const }] : []),
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
    if (event.command === 'hover-target' && ((state.semantic?.purpose !== undefined && state.semantic.purpose !== 'hover')
      || state.queryCoverageOperationId !== undefined)) return { state, effects: [] };
    const supersedesCoverage = event.command !== 'hover-target' && state.queryCoverageOperationId !== undefined;
    const next = remember(supersedesCoverage ? Object.freeze({
      ...state,
      queryCoverageOperationId: undefined,
      coverageRetry: undefined,
      cacheBusy: false,
      surface: undefined,
    }) : state, event.target);
    const started = startQuery(next, event.target, event.command === 'hover-target' ? 'hover' : event.command === 'select-target' ? 'select' : 'activate', {
      operation: 'resolve-symbol', path: event.target.path, line: event.target.line, column: event.target.column || 1, identifier: event.target.identifier,
      ...(event.target.occurrence === undefined ? {} : { occurrence: event.target.occurrence }),
    });
    return supersedesCoverage ? { ...started, effects: [{ type: 'cancel-query-coverage' }, ...started.effects] } : started;
  }
  if (event.command === 'semantic-jump' && state.selected?.identifier && state.enabled) {
    const supersedesCoverage = state.queryCoverageOperationId !== undefined;
    const started = startQuery(supersedesCoverage ? Object.freeze({
      ...state,
      queryCoverageOperationId: undefined,
      coverageRetry: undefined,
      cacheBusy: false,
      surface: undefined,
    }) : state, state.selected, 'activate', { operation: 'resolve-symbol', path: state.selected.path, line: state.selected.line, column: state.selected.column || 1, identifier: state.selected.identifier,
      ...(state.selected.occurrence === undefined ? {} : { occurrence: state.selected.occurrence }) });
    return supersedesCoverage ? { ...started, effects: [{ type: 'cancel-query-coverage' }, ...started.effects] } : started;
  }
  if (event.command === 'cache-related' && state.enabled) {
    const operationId = state.nextOperationId;
    return result(Object.freeze({ ...state, cacheBusy: true, cacheOperationId: operationId, nextOperationId: operationId + 1, status: 'Caching related packages…' }), [{ type: 'cache-related', operationId, revision: state.revision }]);
  }
  if (event.command === 'open-bookmarks') {
    const operationId = state.nextOperationId;
    return { state: Object.freeze({ ...state, bookmarkOperationId: operationId, nextOperationId: operationId + 1 }), effects: [{ type: 'load-bookmarks', operationId, revision: state.revision, open: true }] };
  }
  if (event.command === 'toggle-bookmark' && (event.bookmark || state.selected)) {
    const operationId = state.nextOperationId;
    const bookmark = event.bookmark || {
      location: { path: state.selected!.path, side: state.selected!.side, startLine: state.selected!.line, endLine: state.selected!.line },
      anchor: { symbol: state.selected!.identifier || '', selectionHash: '', beforeHash: '', afterHash: '' },
    };
    return { state: Object.freeze({ ...state, bookmarkOperationId: operationId, nextOperationId: operationId + 1 }), effects: [{ type: 'toggle-bookmark', operationId, revision: state.revision, bookmark }] };
  }
  if (event.command === 'toggle-full-file') {
    const current = state.fullFileControls.find(({ path }) => path === event.path);
    const full = !current?.full;
    const controls = [...state.fullFileControls.filter(({ path }) => path !== event.path), { path: event.path, full: current?.full || false, busy: true }];
    const operationId = state.nextOperationId;
    return result(Object.freeze({ ...state, fullFileControls: controls, fullFileOperationId: operationId, nextOperationId: operationId + 1 }), [
      { type: 'perform', action: 'set-full-file', path: event.path, full, operationId },
    ]);
  }
  if (event.command === 'surface-action') {
    if (event.actionId === 'disable-coach') {
      return result(Object.freeze({ ...state, surface: undefined }), [{ type: 'save-coach-enabled', enabled: false }]);
    }
    if (event.actionId === 'complete-coverage' && state.coverageRetry) {
      const operationId = state.nextOperationId;
      const surface = Object.freeze({ ...state.surface!, actions: [{ id: 'cancel-coverage', label: 'Cancel' }] });
      return result(Object.freeze({ ...state, queryCoverageOperationId: operationId, nextOperationId: operationId + 1, surface, status: 'Expanding search coverage…' }), [
        { type: 'ensure-query-coverage', operationId, revision: state.revision, retry: state.coverageRetry,
          request: { goal: 'complete-query', query: state.coverageRetry.request } },
      ]);
    }
    if (event.actionId === 'cancel-coverage' && state.coverageRetry) {
      const surface = Object.freeze({ ...state.surface!, actions: [{ id: 'complete-coverage', label: 'Search full project' }] });
      return result(Object.freeze({ ...state, cacheBusy: false, queryCoverageOperationId: undefined, surface, status: 'Coverage expansion cancelled.' }), [{ type: 'cancel-query-coverage' }]);
    }
    if (event.actionId === 'external-documentation' && state.externalUrl) {
      const operationId = state.nextOperationId;
      return { state: Object.freeze({ ...state, nextOperationId: operationId + 1 }), effects: [{ type: 'perform', action: 'open-destination',
        destination: { kind: 'documentation', url: state.externalUrl }, operationId }] };
    }
    const index = Number(event.actionId.match(/^destination:(\d+)$/)?.[1]);
    const destination = Number.isInteger(index) ? state.choices[index] : undefined;
    if (!destination || !state.selected) return { state, effects: [] };
    const target = targetFor(state, destination, destination.source);
    return target ? navigate(state, state.selected, target) : navigateSource(state, state.selected, destination);
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
    if ('token' in target) return result(Object.freeze({ ...state, historyIndex: index, selected: target, destination: target.token, nextOperationId: operationId + 1 }), [{ type: 'perform', action: 'reveal-target', target, operationId }]);
    return result(Object.freeze({ ...state, historyIndex: index, destination: undefined, nextOperationId: operationId + 1 }), [{
      type: 'perform', action: 'reveal-source', source: target.source, path: target.path, line: target.line, operationId,
    }]);
  }
  if (event.command === 'dismiss-surface') {
    return result(Object.freeze({ ...state, choices: [], externalUrl: undefined, surface: undefined, status: undefined, announcement: undefined }));
  }
  return { state, effects: [] };
}
