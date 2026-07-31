import type { RepositoryPath, SourceIdentity } from '../domain.ts';
import type { CacheSnapshot, Coverage } from './index.ts';

export type SourceEntry = Readonly<{ path: RepositoryPath; contentId: string }>;
export type SourceFile = SourceEntry & Readonly<{ source: string }>;
export type CoverageManifest = Readonly<{
  source: SourceIdentity;
  modulePath: string;
  coverage: Coverage;
  files: readonly SourceEntry[];
}>;
export type RestoredCoverage = CoverageManifest & Readonly<{ sources: readonly SourceFile[] }>;

type BlobRecord = { id: string; repositoryKey: string; contentId: string; source: string; bytes: number };
type ManifestRecord = CoverageManifest & { id: string; kind: 'package' | 'project' };
type RecordValue = BlobRecord | ManifestRecord;

const DATABASE_NAME = 'golens-go-intelligence-cache';
const DATABASE_VERSION = 1;
const STORE = 'records';

function contentId(value: string): string {
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(value)) throw new TypeError('Invalid Git content identity.');
  return value.toLowerCase();
}

function sourceKey(source: SourceIdentity, id: string): string {
  return JSON.stringify(['blob', source.repositoryKey, contentId(id)]);
}

function manifestKey(manifest: CoverageManifest): string {
  const coverage = manifest.coverage;
  const identity = coverage.scope === 'current-package' ? ['package', coverage.packagePaths[0] || '']
    : coverage.scope === 'complete-project-search' ? ['search', coverage.queryFingerprint]
      : coverage.scope === 'indexed-packages' ? ['related', ...[...coverage.packagePaths].sort()]
        : ['project'];
  return JSON.stringify(['manifest', manifest.source.repositoryKey, manifest.source.commitSha, ...identity]);
}

async function gitBlobId(source: string, expected: string): Promise<string> {
  const encoder = new TextEncoder();
  const content = encoder.encode(source);
  const header = encoder.encode(`blob ${content.byteLength}\0`);
  const object = new Uint8Array(header.byteLength + content.byteLength);
  object.set(header);
  object.set(content, header.byteLength);
  const hash = await crypto.subtle.digest(expected.length === 64 ? 'SHA-256' : 'SHA-1', object);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function request<T>(value: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    value.onsuccess = () => resolve(value.result);
    value.onerror = () => reject(value.error || new Error('IndexedDB request failed.'));
  });
}

function transaction(value: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    value.oncomplete = () => resolve();
    value.onabort = () => reject(value.error || new Error('IndexedDB transaction aborted.'));
    value.onerror = () => reject(value.error || new Error('IndexedDB transaction failed.'));
  });
}

async function open(indexedDB: IDBFactory): Promise<IDBDatabase> {
  const opening = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  opening.onupgradeneeded = () => {
    const database = opening.result;
    if (database.objectStoreNames.contains(STORE)) database.deleteObjectStore(STORE);
    database.createObjectStore(STORE, { keyPath: 'id' });
  };
  return request(opening);
}

export class GoIntelligenceCache {
  readonly #memory = new Map<string, RecordValue>();
  readonly #database: Promise<IDBDatabase> | null;

  constructor(indexedDB: IDBFactory | undefined = globalThis.indexedDB) {
    this.#database = indexedDB ? open(indexedDB) : null;
  }

  async #get<T extends RecordValue>(id: string): Promise<T | undefined> {
    if (!this.#database) return this.#memory.get(id) as T | undefined;
    const database = await this.#database;
    return request(database.transaction(STORE, 'readonly').objectStore(STORE).get(id)) as Promise<T | undefined>;
  }

  async #put(records: readonly RecordValue[]): Promise<void> {
    if (!records.length) return;
    if (!this.#database) {
      for (const record of records) this.#memory.set(record.id, record);
      return;
    }
    const database = await this.#database;
    const active = database.transaction(STORE, 'readwrite');
    const done = transaction(active);
    for (const record of records) active.objectStore(STORE).put(record);
    await done;
  }

  async #delete(ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    if (!this.#database) {
      for (const id of ids) this.#memory.delete(id);
      return;
    }
    const database = await this.#database;
    const active = database.transaction(STORE, 'readwrite');
    const done = transaction(active);
    for (const id of ids) active.objectStore(STORE).delete(id);
    await done;
  }

  async #all(): Promise<RecordValue[]> {
    if (!this.#database) return [...this.#memory.values()];
    const database = await this.#database;
    return request(database.transaction(STORE, 'readonly').objectStore(STORE).getAll()) as Promise<RecordValue[]>;
  }

  async #valid(source: SourceIdentity, entry: SourceEntry): Promise<BlobRecord | null> {
    const id = sourceKey(source, entry.contentId);
    const record = await this.#get<BlobRecord>(id);
    if (record && await gitBlobId(record.source, entry.contentId) === contentId(entry.contentId)) return record;
    if (record) {
      const affected = (await this.#all()).filter((value): value is ManifestRecord => 'kind' in value
        && value.source.repositoryKey === source.repositoryKey
        && value.files.some((file) => sourceKey(value.source, file.contentId) === id));
      await this.#delete([id, ...affected.map(({ id: manifestId }) => manifestId)]);
    }
    return null;
  }

  async prepare(manifest: CoverageManifest): Promise<{ cached: number; missing: readonly SourceEntry[] }> {
    const valid = await Promise.all(manifest.files.map((entry) => this.#valid(manifest.source, entry)));
    return {
      cached: valid.filter(Boolean).length,
      missing: Object.freeze(manifest.files.filter((_entry, index) => !valid[index])),
    };
  }

  async stage(source: SourceIdentity, files: readonly SourceFile[], signal?: AbortSignal): Promise<void> {
    const records = await Promise.all(files.map(async (file): Promise<BlobRecord> => {
      const expected = contentId(file.contentId);
      if (await gitBlobId(file.source, expected) !== expected) {
        throw new Error(`Source content does not match Git content identity for ${file.path}.`);
      }
      return {
        id: sourceKey(source, expected), repositoryKey: source.repositoryKey, contentId: expected,
        source: file.source, bytes: new TextEncoder().encode(file.source).byteLength,
      };
    }));
    if (signal?.aborted) throw new DOMException('Operation aborted.', 'AbortError');
    await this.#put(records);
  }

  async publish(manifest: CoverageManifest): Promise<RestoredCoverage> {
    const restored = await this.#restore(manifest);
    if (!restored) throw new Error('Cannot publish Coverage with missing or corrupt source.');
    const record: ManifestRecord = {
      ...manifest,
      files: Object.freeze(manifest.files.map((entry) => Object.freeze({ ...entry, contentId: contentId(entry.contentId) }))),
      coverage: Object.freeze({ ...manifest.coverage, packagePaths: Object.freeze([...manifest.coverage.packagePaths]) }),
      id: manifestKey(manifest),
      kind: manifest.coverage.scope === 'current-package' ? 'package' : 'project',
    };
    await this.#put([record]);
    return restored;
  }

  async materialize(manifest: CoverageManifest): Promise<RestoredCoverage | null> {
    return this.#restore(manifest);
  }

  async restore(
    source: SourceIdentity,
    path?: RepositoryPath,
    accepts: (coverage: Coverage) => boolean = () => true,
  ): Promise<RestoredCoverage | null> {
    const manifests = (await this.#all()).filter((record): record is ManifestRecord => 'kind' in record
      && record.source.repositoryKey === source.repositoryKey && record.source.commitSha === source.commitSha)
      .filter((record) => !path || record.coverage.scope === 'full-project'
        || record.coverage.packagePaths.includes(dirname(path)))
      .filter((record) => accepts(record.coverage))
      .sort((left, right) => coverageRank(right.coverage) - coverageRank(left.coverage)
        || right.coverage.packageCount - left.coverage.packageCount);
    for (const manifest of manifests) {
      const restored = await this.#restore(manifest);
      if (restored) return restored;
      await this.#delete([manifest.id]);
    }
    return null;
  }

  async #restore(manifest: CoverageManifest): Promise<RestoredCoverage | null> {
    const records = await Promise.all(manifest.files.map((entry) => this.#valid(manifest.source, entry)));
    if (records.some((record) => !record)) return null;
    return Object.freeze({
      ...manifest,
      sources: Object.freeze(records.map((record, index) => Object.freeze({
        ...manifest.files[index]!, source: record!.source,
      }))),
    });
  }

  async inspect(source?: SourceIdentity): Promise<CacheSnapshot> {
    const records = await this.#all();
    const boundManifests = source
      ? records.filter((record): record is ManifestRecord => 'kind' in record
        && record.source.repositoryKey === source.repositoryKey && record.source.commitSha === source.commitSha)
      : [];
    const boundBlobs = new Set(boundManifests.flatMap((manifest) => manifest.files.map((entry) => sourceKey(manifest.source, entry.contentId))));
    const selected = source
      ? records.filter((record) => boundManifests.includes(record as ManifestRecord) || boundBlobs.has(record.id))
      : records;
    const blobs = selected.filter((record): record is BlobRecord => 'contentId' in record);
    const manifests = selected.filter((record): record is ManifestRecord => 'kind' in record);
    return Object.freeze({
      sourceBlobs: blobs.length,
      packageManifests: manifests.filter(({ kind }) => kind === 'package').length,
      projectManifests: manifests.filter(({ kind }) => kind === 'project').length,
      bytes: blobs.reduce((total, blob) => total + blob.bytes, 0),
    });
  }

  async clear(): Promise<CacheSnapshot> {
    const previous = await this.inspect();
    if (!this.#database) this.#memory.clear();
    else {
      const database = await this.#database;
      const active = database.transaction(STORE, 'readwrite');
      const done = transaction(active);
      active.objectStore(STORE).clear();
      await done;
    }
    return previous;
  }

  // Test-only corruption hook stays private to this package.
  corrupt(contentIdentity: string): void {
    const record = [...this.#memory.values()].find((value): value is BlobRecord => 'contentId' in value && value.contentId === contentIdentity);
    if (record) record.source += '\ncorrupt';
  }
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function coverageRank(coverage: Coverage): number {
  if (coverage.scope === 'full-project') return 4;
  if (coverage.scope === 'complete-project-search') return 3;
  if (coverage.scope === 'indexed-packages') return 2;
  return 1;
}
