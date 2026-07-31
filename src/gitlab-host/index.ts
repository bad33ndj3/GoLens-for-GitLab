import type { CommitSha, RepositoryKey, RepositoryPath, SourceIdentity } from '../domain.ts';
import { createGitLabRepository, HostContractError, reviewDescriptor } from './repository.ts';

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
  name: 'package-files' | 'repository-pages' | 'discussion-pages';
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

export interface BoundGitLabHost {
  readonly review: ReviewDescriptor;
  read(query: HostRead, signal: AbortSignal): Promise<ReadOutcome<HostReadValue>>;
}

export interface GitLabHost {
  connect(review: ReviewDescriptor): BoundGitLabHost;
}

export type GitLabHostOptions = Readonly<{
  origin: string;
  fetch?: typeof globalThis.fetch;
  csrfToken?: () => string;
}>;

export function createGitLabHost(options: GitLabHostOptions): GitLabHost {
  const repository = createGitLabRepository(options);
  return { connect: (review) => repository.bind(review) };
}

export { registerRewriteContentScript } from './access.ts';
export { HostContractError, reviewDescriptor };
