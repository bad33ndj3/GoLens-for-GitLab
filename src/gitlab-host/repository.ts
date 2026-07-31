import * as v from 'valibot';

import { commitSha, repositoryKey, repositoryPath, sourceIdentity } from '../domain.ts';
import { normalizeGitLabOrigin } from './access.ts';
import type {
  GoFile,
  HostRead,
  HostReadValue,
  HostSafetyLimit,
  HostUnavailableReason,
  ReadOutcome,
  ReviewDescriptor,
  SearchGoPathsValue,
} from './index.ts';

const PAGE_SIZE = 100;
const PACKAGE_FILE_LIMIT = 200;
const REPOSITORY_PAGE_LIMIT = 1_000;
const DISCUSSION_PAGE_LIMIT = 20;
const SEARCH_PAGE_LIMIT = 100;
const SEARCH_PATH_LIMIT = 10_000;
const object = v.record(v.string(), v.unknown());
const treeEntry = v.object({ type: v.string(), path: v.string(), id: v.optional(v.string()) });
const searchEntry = v.object({ path: v.string() });
const diffEntry = v.object({ new_path: v.string(), deleted_file: v.optional(v.boolean()) });
const filePayload = v.object({ file_path: v.string(), blob_id: v.string(), encoding: v.string(), content: v.string() });

export class HostContractError extends Error {
  override name = 'HostContractError';
}

class UnavailableError extends Error {
  readonly reason: HostUnavailableReason;
  constructor(reason: HostUnavailableReason) { super(reason); this.reason = reason; }
}
class LimitError extends Error {
  readonly limit: HostSafetyLimit;
  constructor(limit: HostSafetyLimit) { super(limit.name); this.limit = limit; }
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function iid(value: unknown): string {
  const result = String(value || '').trim();
  if (!/^\d+$/.test(result)) throw new HostContractError('Invalid merge request IID.');
  return result;
}

export function reviewDescriptor(value: unknown): ReviewDescriptor {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new HostContractError('Invalid review descriptor.');
  const candidate = value as { identity?: Record<string, unknown>; refs?: Record<string, unknown> };
  try {
    const identity = freeze({
      origin: normalizeGitLabOrigin(candidate.identity?.origin),
      repositoryKey: repositoryKey(candidate.identity?.repositoryKey),
      projectPath: repositoryPath(candidate.identity?.projectPath),
      mergeRequestIid: iid(candidate.identity?.mergeRequestIid),
      headSha: commitSha(candidate.identity?.headSha),
    });
    return freeze({ identity, refs: freeze({
      baseSha: commitSha(candidate.refs?.baseSha),
      startSha: commitSha(candidate.refs?.startSha),
    }) });
  } catch (error) {
    if (error instanceof HostContractError) throw error;
    throw new HostContractError('Invalid review descriptor.');
  }
}

function unavailable(status: number): HostUnavailableReason {
  if (status === 401) return 'authentication-required';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  return 'upstream-unavailable';
}

function aborted(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
    || error instanceof Error && error.name === 'AbortError';
}

function goPath(path: string): boolean {
  return path.endsWith('.go') && !path.split('/').some((part) => part === 'vendor' || part === 'testdata');
}

function nextPage(response: Response, page: number, count: number): number {
  const header = response.headers.get('x-next-page');
  if (header) {
    if (!/^\d+$/.test(header)) throw new HostContractError('GitLab returned invalid pagination.');
    const next = Number(header);
    if (next <= page) throw new HostContractError('GitLab returned invalid pagination.');
    return next;
  }
  return count === PAGE_SIZE ? page + 1 : 0;
}

function parse<T>(schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>, value: unknown, name: string): T {
  const result = v.safeParse(schema, value);
  if (!result.success) throw new HostContractError(`GitLab returned invalid ${name}.`);
  return result.output;
}

function decodeSource(value: string): string {
  try {
    const bytes = Uint8Array.from(atob(value.replace(/\s/g, '')), (character) => character.charCodeAt(0));
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HostContractError('GitLab returned invalid source content.');
  }
}

export function createGitLabRepository({
  origin,
  fetch: fetchRequest = globalThis.fetch,
  csrfToken = () => '',
}: {
  origin: string;
  fetch?: typeof globalThis.fetch;
  csrfToken?: () => string;
}) {
  const exactOrigin = normalizeGitLabOrigin(origin);

  async function request(path: string, signal: AbortSignal, init: RequestInit = {}): Promise<Response> {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    let response: Response;
    try {
      response = await fetchRequest(new URL(path, exactOrigin), { credentials: 'include', ...init, signal });
    } catch (error) {
      if (aborted(error)) throw error;
      if (error instanceof TypeError) throw new UnavailableError('offline');
      throw error;
    }
    if (!response.ok) throw new UnavailableError(unavailable(response.status));
    return response;
  }

  async function json(path: string, signal: AbortSignal, init?: RequestInit): Promise<{ response: Response; value: unknown }> {
    const response = await request(path, signal, init);
    try {
      return { response, value: await response.json() };
    } catch {
      throw new HostContractError('GitLab returned invalid JSON.');
    }
  }

  async function resolveReview(input: { projectPath: unknown; mergeRequestIid: unknown }, signal: AbortSignal): Promise<ReadOutcome<ReviewDescriptor>> {
    try {
      const projectPath = repositoryPath(input.projectPath);
      const mergeRequestIid = iid(input.mergeRequestIid);
      const token = csrfToken();
      const { value } = await json('/api/graphql', signal, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-CSRF-Token': token } : {}) },
        body: JSON.stringify({
          query: 'query GoLensMergeRequestRefs($fullPath: ID!, $iid: String!) { project(fullPath: $fullPath) { mergeRequest(iid: $iid) { diffRefs { baseSha headSha startSha } } } }',
          variables: { fullPath: projectPath, iid: mergeRequestIid },
        }),
      });
      const payload = parse(object, value, 'merge request refs');
      const refs = (payload.data as Record<string, unknown> | undefined)?.project as Record<string, unknown> | undefined;
      const mergeRequest = refs?.mergeRequest as Record<string, unknown> | undefined;
      const diffRefs = mergeRequest?.diffRefs as Record<string, unknown> | undefined;
      if (!diffRefs) throw new HostContractError('GitLab returned invalid merge request refs.');
      return { kind: 'ok', value: reviewDescriptor({
        identity: {
          origin: exactOrigin,
          repositoryKey: `${exactOrigin}/${projectPath}`,
          projectPath,
          mergeRequestIid,
          headSha: diffRefs.headSha,
        },
        refs: { baseSha: diffRefs.baseSha, startSha: diffRefs.startSha },
      }) };
    } catch (error) {
      if (error instanceof UnavailableError) return { kind: 'unavailable', reason: error.reason };
      throw error;
    }
  }

  function bind(value: ReviewDescriptor) {
    const review = reviewDescriptor(value);
    if (review.identity.origin !== exactOrigin) throw new HostContractError('Review origin does not match GitLab Host origin.');
    if (review.identity.repositoryKey !== `${exactOrigin}/${review.identity.projectPath}`) {
      throw new HostContractError('Review repository identity does not match its origin and project.');
    }
    const encodedProject = encodeURIComponent(review.identity.projectPath);

    function checkSource(value: unknown) {
      let source;
      try { source = sourceIdentity(value); } catch { throw new HostContractError('Invalid source identity.'); }
      if (source.repositoryKey !== review.identity.repositoryKey) throw new HostContractError('Source identity does not match the bound review.');
      if (![review.identity.headSha, review.refs.baseSha, review.refs.startSha].includes(source.commitSha)) {
        throw new HostContractError('Source identity does not belong to the bound review.');
      }
      return source;
    }

    async function listTree(query: Extract<HostRead, { operation: 'go-files' }>, signal: AbortSignal): Promise<GoFile[]> {
      const source = checkSource(query.source);
      const files: GoFile[] = [];
      for (let page = 1; page;) {
        if (page > REPOSITORY_PAGE_LIMIT) throw new LimitError({ name: 'repository-pages', maximum: REPOSITORY_PAGE_LIMIT });
        const parameters = new URLSearchParams({ ref: source.commitSha, per_page: String(PAGE_SIZE), page: String(page) });
        if (query.scope.kind === 'package') parameters.set('path', query.scope.path);
        else parameters.set('recursive', 'true');
        const result = await json(`/api/v4/projects/${encodedProject}/repository/tree?${parameters}`, signal);
        const entries = parse(v.array(treeEntry), result.value, 'repository tree');
        for (const entry of entries) {
          if (entry.type !== 'blob' || !goPath(entry.path)) continue;
          if (!entry.id || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(entry.id)) throw new HostContractError('GitLab returned an invalid content identity.');
          files.push(freeze({ path: repositoryPath(entry.path), contentId: entry.id.toLowerCase() }));
        }
        if (query.scope.kind === 'package' && files.length > PACKAGE_FILE_LIMIT) {
          throw new LimitError({ name: 'package-files', maximum: PACKAGE_FILE_LIMIT });
        }
        page = nextPage(result.response, page, entries.length);
      }
      return files;
    }

    async function changedFiles(query: Extract<HostRead, { operation: 'go-files' }>, signal: AbortSignal): Promise<GoFile[]> {
      const source = checkSource(query.source);
      if (source.commitSha !== review.identity.headSha) throw new HostContractError('Changed review files require the review head source identity.');
      const paths = new Set<string>();
      for (let page = 1; page;) {
        if (page > REPOSITORY_PAGE_LIMIT) throw new LimitError({ name: 'repository-pages', maximum: REPOSITORY_PAGE_LIMIT });
        const result = await json(`/api/v4/projects/${encodedProject}/merge_requests/${review.identity.mergeRequestIid}/diffs?per_page=${PAGE_SIZE}&page=${page}`, signal);
        const entries = parse(v.array(diffEntry), result.value, 'merge request diffs');
        for (const entry of entries) if (!entry.deleted_file && goPath(entry.new_path)) paths.add(entry.new_path);
        page = nextPage(result.response, page, entries.length);
      }
      return Promise.all([...paths].map(async (path) => {
        const result = await json(`/api/v4/projects/${encodedProject}/repository/files/${encodeURIComponent(path)}?ref=${source.commitSha}`, signal);
        const file = parse(filePayload, result.value, 'repository file');
        if (file.file_path !== path || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(file.blob_id)) throw new HostContractError('GitLab returned an invalid content identity.');
        return freeze({ path: repositoryPath(path), contentId: file.blob_id.toLowerCase() });
      }));
    }

    async function search(query: Extract<HostRead, { operation: 'search-go-paths' }>, signal: AbortSignal): Promise<SearchGoPathsValue> {
      const source = checkSource(query.source);
      const pages = Math.min(SEARCH_PAGE_LIMIT, Math.max(1, query.limits?.pages ?? SEARCH_PAGE_LIMIT));
      const pathLimit = Math.min(SEARCH_PATH_LIMIT, Math.max(1, query.limits?.paths ?? SEARCH_PATH_LIMIT));
      const paths = new Set<string>();
      try {
        for (let page = 1; page <= pages; page++) {
          const parameters = new URLSearchParams({ scope: 'blobs', search: query.search, ref: source.commitSha, per_page: String(PAGE_SIZE), page: String(page) });
          if (query.searchType) parameters.set('search_type', query.searchType);
          const result = await json(`/api/v4/projects/${encodedProject}/search?${parameters}`, signal);
          const entries = parse(v.array(searchEntry), result.value, 'project search');
          for (const entry of entries) if (goPath(entry.path)) paths.add(entry.path);
          const following = nextPage(result.response, page, entries.length);
          if (!following && paths.size <= pathLimit) return freeze({ paths: freeze([...paths].map(repositoryPath)), coverage: 'complete' });
          if (paths.size >= pathLimit) return freeze({ paths: freeze([...paths].slice(0, pathLimit).map(repositoryPath)), coverage: 'limited', reason: 'path-limit' });
          if (page === pages) return freeze({ paths: freeze([...paths].map(repositoryPath)), coverage: 'limited', reason: 'page-limit' });
          page = following - 1;
        }
      } catch (error) {
        if (error instanceof UnavailableError) return freeze({ paths: freeze([...paths].map(repositoryPath)), coverage: paths.size ? 'limited' : 'unavailable', reason: error.reason });
        throw error;
      }
      return freeze({ paths: freeze([...paths].map(repositoryPath)), coverage: 'limited', reason: 'page-limit' });
    }

    async function status(signal: AbortSignal) {
      const approvalsResult = await json(`/api/v4/projects/${encodedProject}/merge_requests/${review.identity.mergeRequestIid}/approvals`, signal);
      const approvals = parse(object, approvalsResult.value, 'merge request approvals');
      const approvedBy = Array.isArray(approvals.approved_by) ? approvals.approved_by : [];
      const approvers = approvedBy.map((approval) => {
        const user = (approval as Record<string, unknown>)?.user as Record<string, unknown> | undefined;
        return user?.id ?? user?.username;
      }).filter((value): value is string | number => typeof value === 'string' || typeof value === 'number').map(String);
      let unresolvedDiscussions = 0;
      for (let page = 1; page;) {
        if (page > DISCUSSION_PAGE_LIMIT) throw new LimitError({ name: 'discussion-pages', maximum: DISCUSSION_PAGE_LIMIT });
        const result = await json(`/api/v4/projects/${encodedProject}/merge_requests/${review.identity.mergeRequestIid}/discussions?per_page=${PAGE_SIZE}&page=${page}`, signal);
        const discussions = parse(v.array(object), result.value, 'merge request discussions');
        unresolvedDiscussions += discussions.filter((discussion) => Array.isArray(discussion.notes) && discussion.notes.some((note) => {
          const record = note as Record<string, unknown>;
          return record.resolvable === true && record.resolved !== true;
        })).length;
        page = nextPage(result.response, page, discussions.length);
      }
      return freeze({ state: typeof approvals.state === 'string' ? approvals.state : '', approvers: freeze(approvers), unresolvedDiscussions });
    }

    async function read(query: HostRead, signal: AbortSignal): Promise<ReadOutcome<HostReadValue>> {
      try {
        if (query.operation === 'source-file') {
          const source = checkSource(query.source);
          const result = await json(`/api/v4/projects/${encodedProject}/repository/files/${encodeURIComponent(query.path)}?ref=${source.commitSha}`, signal);
          const file = parse(filePayload, result.value, 'repository file');
          if (file.file_path !== query.path || file.encoding !== 'base64' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(file.blob_id)) {
            throw new HostContractError('GitLab returned an invalid repository file.');
          }
          return { kind: 'ok', value: freeze({ path: query.path, contentId: file.blob_id.toLowerCase(), text: decodeSource(file.content) }) };
        }
        if (query.operation === 'go-files') return { kind: 'ok', value: freeze({ files: freeze(query.scope.kind === 'changed-review' ? await changedFiles(query, signal) : await listTree(query, signal)) }) };
        if (query.operation === 'search-go-paths') return { kind: 'ok', value: await search(query, signal) };
        return { kind: 'ok', value: await status(signal) };
      } catch (error) {
        if (error instanceof UnavailableError) return { kind: 'unavailable', reason: error.reason };
        if (error instanceof LimitError) return { kind: 'limit-exceeded', limit: error.limit };
        throw error;
      }
    }

    return freeze({ review, read });
  }

  return freeze({ resolveReview, bind });
}
