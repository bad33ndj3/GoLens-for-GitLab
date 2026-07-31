import type { CommitSha, RepositoryKey, RepositoryPath, SourceIdentity } from '../domain.ts';
import { createGitLabPage } from './dom.ts';
import { createGitLabRepository, HostContractError, reviewDescriptor } from './repository.ts';

declare const hostRevisionBrand: unique symbol;
declare const hostTargetTokenBrand: unique symbol;
export type HostRevision = number & { readonly [hostRevisionBrand]: true };
export type HostTargetToken = string & { readonly [hostTargetTokenBrand]: true };

export type ReviewDescriptor = Readonly<{
  identity: Readonly<{
    origin: string;
    repositoryKey: RepositoryKey;
    projectPath: RepositoryPath;
    mergeRequestIid: string;
    headSha: CommitSha;
  }>;
  refs: Readonly<{ baseSha: CommitSha; startSha: CommitSha }>;
}>;

export type HostUnavailableReason =
  | 'not-found'
  | 'not-rendered'
  | 'unsupported'
  | 'authentication-required'
  | 'forbidden'
  | 'rate-limited'
  | 'offline'
  | 'upstream-unavailable';

export type HostSafetyLimit = Readonly<{
  name: 'package-files' | 'repository-pages' | 'discussion-pages' | 'full-file-controls' | 'full-file-time';
  maximum: number;
}>;

export type ReadOutcome<T> =
  | Readonly<{ kind: 'ok'; value: T }>
  | Readonly<{ kind: 'unavailable'; reason: HostUnavailableReason }>
  | Readonly<{ kind: 'limit-exceeded'; limit: HostSafetyLimit }>;

export type SourceFileRead = Readonly<{
  operation: 'source-file';
  source: SourceIdentity;
  path: RepositoryPath;
}>;
export type GoFilesRead = Readonly<{
  operation: 'go-files';
  source: SourceIdentity;
  scope:
    | Readonly<{ kind: 'package'; path: RepositoryPath }>
    | Readonly<{ kind: 'project' }>
    | Readonly<{ kind: 'changed-review' }>;
}>;
export type SearchGoPathsRead = Readonly<{
  operation: 'search-go-paths';
  source: SourceIdentity;
  search: string;
  searchType?: 'basic' | 'advanced';
  limits?: Readonly<{ pages?: number; paths?: number }>;
}>;
export type ReviewStatusRead = Readonly<{ operation: 'review-status' }>;
export type HostRead = SourceFileRead | GoFilesRead | SearchGoPathsRead | ReviewStatusRead;

export type SourceFileValue = Readonly<{ path: RepositoryPath; contentId: string; text: string }>;
export type GoFile = Readonly<{ path: RepositoryPath; contentId: string }>;
export type GoFilesValue = Readonly<{ files: readonly GoFile[] }>;
export type SearchGoPathsValue = Readonly<{
  paths: readonly RepositoryPath[];
  coverage: 'complete' | 'limited' | 'unavailable';
  reason?: 'page-limit' | 'path-limit' | HostUnavailableReason;
}>;
export type ReviewStatusValue = Readonly<{ state: string; approvers: readonly string[]; unresolvedDiscussions: number }>;
export type HostReadValue = SourceFileValue | GoFilesValue | SearchGoPathsValue | ReviewStatusValue;

export type DiffTarget = Readonly<{
  revision: HostRevision;
  token: HostTargetToken;
  path: RepositoryPath;
  side: 'old' | 'new';
  line: number;
  column?: number;
  source: SourceIdentity;
}>;

export type HostIntentCommand =
  | 'toggle-enabled' | 'toggle-focus' | 'cache-related' | 'open-bookmarks'
  | 'hover-target' | 'activate-target' | 'dismiss-surface' | 'surface-action'
  | 'toggle-full-file' | 'native-approve' | 'native-merge' | 'semantic-jump'
  | 'focus-file-search' | 'clear-file-search' | 'toggle-bookmark'
  | 'previous-occurrence' | 'next-occurrence' | 'previous-hunk' | 'next-hunk'
  | 'previous-file' | 'next-file' | 'previous-bookmark' | 'next-bookmark'
  | 'history-back' | 'history-forward';
type TargetIntentCommand = 'hover-target' | 'activate-target';
type SimpleIntentCommand = Exclude<HostIntentCommand, TargetIntentCommand | 'surface-action' | 'toggle-full-file'>;
export type HostIntent =
  | Readonly<{ command: SimpleIntentCommand }>
  | Readonly<{ command: TargetIntentCommand; target: DiffTarget }>
  | Readonly<{ command: 'surface-action'; actionId: string }>
  | Readonly<{ command: 'toggle-full-file'; path: RepositoryPath }>;
export type HostEvent =
  | Readonly<{ type: 'host-revised'; revision: HostRevision; surface: 'overview' | 'changes' | 'other' }>
  | (Readonly<{ type: 'intent'; revision: HostRevision }> & HostIntent)
  | Readonly<{ type: 'fullscreen-changed'; revision: HostRevision; active: boolean }>;

export type ControlProjection = Readonly<{
  command: Extract<HostIntentCommand, 'toggle-enabled' | 'toggle-focus' | 'cache-related' | 'open-bookmarks'>;
  label: string;
  pressed?: boolean;
  busy?: boolean;
  disabled?: boolean;
}>;
export type ActiveSurfaceProjection = Readonly<{
  kind: 'dialog' | 'popover' | 'status';
  title: string;
  body?: string;
  modal?: boolean;
  actions?: readonly Readonly<{ id: string; label: string; primary?: boolean }>[];
}>;
export type FullFileControlProjection = Readonly<{
  path: RepositoryPath;
  full: boolean;
  busy?: boolean;
  error?: string;
}>;
export type ShortcutProjection = Readonly<{
  command: SimpleIntentCommand;
  key: string;
  code?: string;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}>;
export type HostProjection = Readonly<{
  revision: HostRevision;
  enabled: boolean;
  focusMode?: boolean;
  controls?: readonly ControlProjection[];
  hideGeneratedFiles?: boolean;
  decorateTestFiles?: boolean;
  fullFileControls?: readonly FullFileControlProjection[];
  shortcuts?: readonly ShortcutProjection[];
  interactiveTargets?: readonly DiffTarget[];
  occurrences?: readonly HostTargetToken[];
  bookmarks?: readonly HostTargetToken[];
  destination?: HostTargetToken;
  status?: string;
  announcement?: string;
  surface?: ActiveSurfaceProjection;
}>;

export type ApplyOutcome =
  | Readonly<{ kind: 'applied' | 'unchanged' }>
  | Readonly<{ kind: 'stale'; currentRevision: HostRevision }>;
type HostActionBase = Readonly<{ revision: HostRevision; operationId: string }>;
export type HostAction = HostActionBase & (
  | Readonly<{ action: 'set-fullscreen'; active: boolean }>
  | Readonly<{ action: 'focus-file-search' | 'clear-file-search' }>
  | Readonly<{ action: 'reveal-target'; target: DiffTarget }>
  | Readonly<{ action: 'set-full-file'; path: RepositoryPath; full: boolean }>
  | Readonly<{ action: 'open-destination'; destination: Readonly<{ kind: 'source'; source: SourceIdentity; path: RepositoryPath; line?: number }> | Readonly<{ kind: 'documentation'; url: string }> }>
  | Readonly<{ action: 'copy-source-location'; text: string }>
);
export type ActionOutcome =
  | Readonly<{ kind: 'completed' | 'unchanged' }>
  | Readonly<{ kind: 'stale'; currentRevision: HostRevision }>
  | Readonly<{ kind: 'unavailable'; reason: HostUnavailableReason }>
  | Readonly<{ kind: 'limit-exceeded'; limit: HostSafetyLimit }>;

export interface BoundGitLabHost {
  readonly review: ReviewDescriptor;
  events(signal: AbortSignal): AsyncIterable<HostEvent>;
  apply(projection: HostProjection): ApplyOutcome;
  perform(action: HostAction, signal: AbortSignal): Promise<ActionOutcome>;
  read(query: HostRead, signal: AbortSignal): Promise<ReadOutcome<HostReadValue>>;
}

export interface GitLabHost {
  observeReviews(signal: AbortSignal): AsyncIterable<ReviewDescriptor | null>;
  connect(review: ReviewDescriptor, signal: AbortSignal): BoundGitLabHost;
}

export type GitLabHostOptions = Readonly<{
  origin: string;
  fetch?: typeof globalThis.fetch;
  csrfToken?: () => string;
  window?: Window;
}>;

export function createGitLabHost(options: GitLabHostOptions): GitLabHost {
  const repository = createGitLabRepository(options);
  const page = createGitLabPage({
    window: options.window || globalThis.window,
    resolveReview: repository.resolveReview,
  });
  return {
    observeReviews: page.observeReviews,
    connect(review, signal) {
      const boundRepository = repository.bind(review);
      return page.connect(boundRepository.review, signal, boundRepository.read);
    },
  };
}

export { registerRewriteContentScript } from './access.ts';
export { HostContractError, reviewDescriptor };
