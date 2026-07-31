declare const repositoryKeyBrand: unique symbol;
declare const commitShaBrand: unique symbol;
declare const repositoryPathBrand: unique symbol;

export type RepositoryKey = string & { readonly [repositoryKeyBrand]: true };
export type CommitSha = string & { readonly [commitShaBrand]: true };
export type RepositoryPath = string & { readonly [repositoryPathBrand]: true };
export type SourceIdentity = Readonly<{
  repositoryKey: RepositoryKey;
  commitSha: CommitSha;
}>;

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TypeError(`Invalid ${name}.`);
  return value.trim();
}

export function repositoryKey(value: unknown): RepositoryKey {
  return text(value, 'repository key') as RepositoryKey;
}

export function commitSha(value: unknown): CommitSha {
  const sha = text(value, 'commit SHA');
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new TypeError('Invalid commit SHA.');
  return sha.toLowerCase() as CommitSha;
}

export function repositoryPath(value: unknown): RepositoryPath {
  const path = text(value, 'repository path');
  if (path.startsWith('/') || path.includes('\\') || path.includes('\0') || path.split('/').some((part) => !part || part === '.' || part === '..')) {
    throw new TypeError('Invalid repository path.');
  }
  return path as RepositoryPath;
}

export function sourceIdentity(value: unknown): SourceIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid source identity.');
  const candidate = value as Record<string, unknown>;
  return Object.freeze({
    repositoryKey: repositoryKey(candidate.repositoryKey),
    commitSha: commitSha(candidate.commitSha),
  });
}
