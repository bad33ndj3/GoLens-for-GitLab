const DATABASE_NAME = 'golens-go-semantic-cache';
const DATABASE_VERSION = 3;
// Bumped from 3 to 4: source records now carry a `verified` marker written
// once at write time (see `stageSnapshotSources`) instead of being
// re-hashed against their Git blob ID on every read/status check. The
// format version is embedded in every store key (`sourceID`/`packageID`/
// `projectID`/`mergeRequestID`), so records written under the previous
// version simply live under different keys and fall through the existing
// format-mismatch path as "absent" — no migration code, no lazy upgrade.
const CACHE_FORMAT_VERSION = 4;
const SOURCES = 'sources';
const PACKAGES = 'packages';
const PROJECTS = 'projects';
// Shared across snapshot construction and statistics instead of a fresh
// `TextEncoder` per file/record.
const ENCODER = new TextEncoder();

function key(...parts) {
  return JSON.stringify(parts);
}

function validBlobID(blobId) {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(blobId || '');
}

function sourceID({ origin, project, blobId }) {
  return validBlobID(blobId) ? key(CACHE_FORMAT_VERSION, origin, project, 'blob', blobId.toLowerCase()) : '';
}

function packageID({ origin, project, ref, packagePath }) {
  return key(CACHE_FORMAT_VERSION, origin, project, ref, packagePath);
}

function projectID({ origin, project, ref }) {
  return key(CACHE_FORMAT_VERSION, origin, project, ref);
}

function mergeRequestID({ origin, project, mergeRequest, ref }) {
  return key(CACHE_FORMAT_VERSION, origin, project, 'mergeRequest', String(mergeRequest), ref);
}

function dirname(path) {
  const index = path.lastIndexOf('/');
  return index < 0 ? '' : path.slice(0, index);
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB request failed'));
  });
}

function transactionResult(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed'));
  });
}

function openDatabase(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      for (const storeName of [SOURCES, PACKAGES, PROJECTS]) {
        if (database.objectStoreNames.contains(storeName)) database.deleteObjectStore(storeName);
        database.createObjectStore(storeName, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Unable to open semantic cache'));
  });
}

function normalizeEntry({ path, blobId = '' }) {
  if (!validBlobID(blobId)) throw new Error(`Git blob ID is missing or invalid for ${path}`);
  return { path, blobId: blobId.toLowerCase() };
}

function normalizeEntries(entries) {
  return entries.map(normalizeEntry);
}

function snapshotFiles(files) {
  return files.map(({ path, blobId = '', source }) => {
    const entry = normalizeEntry({ path, blobId });
    return { ...entry, source, bytes: ENCODER.encode(source).byteLength };
  });
}

async function gitBlobID(source, blobId) {
  if (typeof source !== 'string' || !validBlobID(blobId) || !globalThis.crypto?.subtle) return '';
  const content = ENCODER.encode(source);
  const header = ENCODER.encode(`blob ${content.byteLength}\0`);
  const object = new Uint8Array(header.byteLength + content.byteLength);
  object.set(header);
  object.set(content, header.byteLength);
  const algorithm = blobId.length === 64 ? 'SHA-256' : 'SHA-1';
  const digest = await globalThis.crypto.subtle.digest(algorithm, object);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function validSourceRecord(entry, record) {
  if (!record || typeof record.source !== 'string') return false;
  return await gitBlobID(record.source, entry.blobId) === entry.blobId;
}

// A source record is trusted on the read/status path purely by its stored
// `verified` marker (written once, at write time, by `stageSnapshotSources`)
// and format version — no re-hashing against the Git blob ID on every read.
function verifiedRecord(record) {
  return !!record && record.format === CACHE_FORMAT_VERSION && record.verified === true;
}

function isCurrentManifest(manifest) {
  return !!manifest && manifest.complete === true && manifest.format === CACHE_FORMAT_VERSION;
}

function entriesComplete(entries, records) {
  return entries.every((_entry, index) => verifiedRecord(records[index]));
}

function sourceStats(store) {
  return new Promise((resolve, reject) => {
    let sources = 0;
    let bytes = 0;
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve({ sources, bytes });
      sources++;
      bytes += cursor.value.bytes || ENCODER.encode(cursor.value.source || '').byteLength;
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error('Unable to read semantic cache statistics'));
  });
}

function projectManifestCount(store) {
  return new Promise((resolve, reject) => {
    let projects = 0;
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve(projects);
      if (!cursor.value.mergeRequest) projects++;
      cursor.continue();
    };
    request.onerror = () => reject(request.error || new Error('Unable to count semantic project snapshots'));
  });
}

export class GoSemanticSourceCache {
  constructor({ indexedDB = globalThis.indexedDB } = {}) {
    this.indexedDB = indexedDB;
    this.databasePromise = indexedDB ? openDatabase(indexedDB) : null;
    this.memory = {
      [SOURCES]: new Map(),
      [PACKAGES]: new Map(),
      [PROJECTS]: new Map(),
    };
  }

  async writePackage({ origin, project, ref, packagePath, modulePath = '', entries, files = [] }) {
    const normalizedEntries = normalizeEntries(entries || files);
    const manifest = {
      id: packageID({ origin, project, ref, packagePath }),
      origin,
      project,
      ref,
      packagePath,
      modulePath,
      entries: normalizedEntries,
      format: CACHE_FORMAT_VERSION,
      complete: true,
      updatedAt: Date.now(),
    };
    await this.writeSnapshot(PACKAGES, manifest, normalizedEntries, snapshotFiles(files));
  }

  async writeProject({ origin, project, ref, modulePath = '', entries, files = [] }) {
    const normalizedEntries = normalizeEntries(entries || files);
    const manifest = {
      id: projectID({ origin, project, ref }),
      origin,
      project,
      ref,
      modulePath,
      entries: normalizedEntries,
      format: CACHE_FORMAT_VERSION,
      complete: true,
      updatedAt: Date.now(),
    };
    await this.writeSnapshot(PROJECTS, manifest, normalizedEntries, snapshotFiles(files));
  }

  async stageProject({ origin, project, ref, modulePath = '', entries, files = [] }) {
    const normalizedEntries = normalizeEntries(entries || files);
    const manifest = { origin, project, ref, modulePath, format: CACHE_FORMAT_VERSION };
    const available = await this.stageSnapshotSources(manifest, normalizedEntries, snapshotFiles(files));
    return {
      modulePath,
      files: available.map(({ source }, index) => ({ path: normalizedEntries[index].path, source })),
    };
  }

  async writeMergeRequest({ origin, project, mergeRequest, ref, packagePaths, searchStatus = 'complete' }) {
    const paths = [...new Set(packagePaths || [])].sort();
    const statuses = await this.packageStatusesFor({ origin, project, ref, packagePaths: paths });
    const incomplete = paths.find((packagePath) => statuses.get(packagePath)?.status !== 'complete');
    if (incomplete !== undefined) throw new Error(`Cannot complete MR cache with missing package ${incomplete || '.'}`);
    const manifest = {
      id: mergeRequestID({ origin, project, mergeRequest, ref }),
      origin,
      project,
      mergeRequest: String(mergeRequest),
      ref,
      packagePaths: paths,
      searchStatus,
      format: CACHE_FORMAT_VERSION,
      complete: true,
      updatedAt: Date.now(),
    };
    await this.writeManifest(PROJECTS, manifest);
    return manifest;
  }

  async readPackage({ origin, project, ref, packagePath }) {
    const scope = { origin, project, ref, packagePath };
    const packageSnapshot = await this.readSnapshot(PACKAGES, packageID(scope));
    if (packageSnapshot) return packageSnapshot;
    const projectScope = { origin, project, ref };
    const matchesPackage = (entry) => dirname(entry.path) === packagePath;
    const projectSnapshot = await this.readSnapshot(PROJECTS, projectID(projectScope), matchesPackage);
    return projectSnapshot?.files.length ? projectSnapshot : null;
  }

  async readProject({ origin, project, ref }) {
    const scope = { origin, project, ref };
    return this.readSnapshot(PROJECTS, projectID(scope));
  }

  async hasProject({ origin, project, ref }) {
    return (await this.projectStatus({ origin, project, ref })).status === 'complete';
  }

  async projectStatus({ origin, project, ref }) {
    const scope = { origin, project, ref };
    if (await this.hasSnapshot(PROJECTS, projectID(scope))) return { status: 'complete', format: CACHE_FORMAT_VERSION };
    return { status: 'missing' };
  }

  async mergeRequestStatus({ origin, project, mergeRequest, ref }) {
    const projectStatus = await this.projectStatus({ origin, project, ref });
    if (projectStatus.status === 'complete') {
      return { ...projectStatus, coverage: 'full', searchStatus: 'complete' };
    }
    const id = mergeRequestID({ origin, project, mergeRequest, ref });
    const manifest = await this.readManifest(PROJECTS, id);
    if (!isCurrentManifest(manifest)) return { status: 'missing' };
    const packagePaths = manifest.packagePaths || [];
    // One batched status check across every package the MR touches instead
    // of a sequential `packageStatus` round trip per package.
    const statuses = await this.packageStatusesFor({ origin, project, ref, packagePaths });
    if (packagePaths.some((packagePath) => statuses.get(packagePath)?.status !== 'complete')) {
      return { status: 'missing' };
    }
    return {
      status: 'complete',
      format: manifest.format,
      coverage: 'related',
      searchStatus: manifest.searchStatus || 'complete',
      packages: packagePaths.length || 0,
    };
  }

  async readMergeRequest({ origin, project, mergeRequest, ref }) {
    const status = await this.mergeRequestStatus({ origin, project, mergeRequest, ref });
    if (status.status !== 'complete') return null;
    if (status.coverage === 'full') return { coverage: 'full', searchStatus: 'complete', packagePaths: [] };
    const manifest = await this.readManifest(PROJECTS, mergeRequestID({ origin, project, mergeRequest, ref }));
    return {
      coverage: 'related',
      searchStatus: manifest.searchStatus || 'complete',
      packagePaths: [...(manifest.packagePaths || [])],
    };
  }

  async packageStatus({ origin, project, ref, packagePath }) {
    const statuses = await this.packageStatusesFor({ origin, project, ref, packagePaths: [packagePath] });
    return statuses.get(packagePath);
  }

  // Batched status check for any number of packages against the same
  // (origin, project, ref) scope. Reads each package's own manifest in one
  // transaction; only the packages whose own manifest is missing or stale
  // fall back to the project manifest, and that manifest is read at most
  // once for the whole batch rather than once per package. All source
  // records referenced by any package are then read in a single further
  // transaction. Used by `packageStatus` (batch of one), `mergeRequestStatus`
  // and `writeMergeRequest` so none of them pay a storage round trip per
  // package.
  async packageStatusesFor({ origin, project, ref, packagePaths }) {
    const paths = [...new Set(packagePaths || [])];
    const projectScope = { origin, project, ref };
    const packageManifests = await this.readManifests(
      PACKAGES,
      paths.map((packagePath) => packageID({ ...projectScope, packagePath })),
    );

    const needsProjectFallback = packageManifests.some((manifest) => !isCurrentManifest(manifest));
    const [projectManifest] = needsProjectFallback ? await this.readManifests(PROJECTS, [projectID(projectScope)]) : [];

    const plans = paths.map((packagePath, index) => {
      const manifest = packageManifests[index];
      if (isCurrentManifest(manifest)) {
        const entries = manifest.entries || [];
        return { packagePath, requireEntries: false, entries };
      }
      const matchesPackage = (entry) => dirname(entry.path) === packagePath;
      const entries = isCurrentManifest(projectManifest) ? (projectManifest.entries || []).filter(matchesPackage) : [];
      return { packagePath, requireEntries: true, entries };
    }).map((plan) => ({ ...plan, sourceIDs: plan.entries.map((entry) => sourceID({ ...projectScope, ...entry })) }));

    const allIDs = plans.flatMap((plan) => plan.sourceIDs);
    const allRecords = await this.readSourceRecords(allIDs);
    const recordByID = new Map(allIDs.map((id, index) => [id, allRecords[index]]));

    const statuses = new Map();
    for (const plan of plans) {
      const records = plan.sourceIDs.map((id) => recordByID.get(id));
      const complete = (!plan.requireEntries || plan.entries.length > 0) && entriesComplete(plan.entries, records);
      statuses.set(plan.packagePath, complete ? { status: 'complete', format: CACHE_FORMAT_VERSION } : { status: 'missing' });
    }
    return statuses;
  }

  async prepareSources({ origin, project, ref, files }) {
    const entries = normalizeEntries(files);
    const grouped = new Map();
    for (const entry of entries) {
      const id = sourceID({ origin, project, ref, ...entry });
      const group = grouped.get(id) || { id, entry, files: 0 };
      group.files++;
      grouped.set(id, group);
    }

    const groups = [...grouped.values()];
    const existing = await this.readSourceRecords(groups.map(({ id }) => id));
    const valid = await Promise.all(groups.map(({ entry }, index) => validSourceRecord(entry, existing[index])));
    const invalidIDs = groups.filter((_group, index) => existing[index] && !valid[index]).map(({ id }) => id);
    await this.deleteSourceRecords(invalidIDs);
    const available = new Set(groups.filter((_group, index) => valid[index]).map(({ id }) => id));
    const missingGroups = groups.filter(({ id }) => !available.has(id));
    return {
      total: entries.length,
      cached: entries.length - missingGroups.reduce((total, group) => total + group.files, 0),
      missing: missingGroups.map(({ entry, files: referencedFiles }) => ({ ...entry, referencedFiles })),
    };
  }

  async stats() {
    if (!this.databasePromise) {
      return {
        sources: this.memory[SOURCES].size,
        packages: this.memory[PACKAGES].size,
        projects: [...this.memory[PROJECTS].values()].filter((manifest) => !manifest.mergeRequest).length,
        bytes: [...this.memory[SOURCES].values()].reduce((total, file) => total + (file.bytes || ENCODER.encode(file.source).byteLength), 0),
      };
    }

    const database = await this.databasePromise;
    const transaction = database.transaction([SOURCES, PACKAGES, PROJECTS], 'readonly');
    const complete = transactionResult(transaction);
    const [source, packages, projects] = await Promise.all([
      sourceStats(transaction.objectStore(SOURCES)),
      requestResult(transaction.objectStore(PACKAGES).count()),
      projectManifestCount(transaction.objectStore(PROJECTS)),
    ]);
    await complete;
    return { ...source, packages, projects };
  }

  async clear() {
    const previous = await this.stats();
    if (!this.databasePromise) {
      Object.values(this.memory).forEach((store) => store.clear());
      return previous;
    }

    const database = await this.databasePromise;
    const transaction = database.transaction([SOURCES, PACKAGES, PROJECTS], 'readwrite');
    const complete = transactionResult(transaction);
    transaction.objectStore(SOURCES).clear();
    transaction.objectStore(PACKAGES).clear();
    transaction.objectStore(PROJECTS).clear();
    await complete;
    return previous;
  }

  async readSourceRecords(ids) {
    if (!ids.length) return [];
    if (!this.databasePromise) return ids.map((id) => this.memory[SOURCES].get(id));
    const database = await this.databasePromise;
    const transaction = database.transaction(SOURCES, 'readonly');
    const complete = transactionResult(transaction);
    const store = transaction.objectStore(SOURCES);
    const records = await Promise.all(ids.map((id) => requestResult(store.get(id))));
    await complete;
    return records;
  }

  async writeSourceRecords(records) {
    if (!records.length) return;
    if (!this.databasePromise) {
      records.forEach((record) => this.memory[SOURCES].set(record.id, record));
      return;
    }
    const database = await this.databasePromise;
    const transaction = database.transaction(SOURCES, 'readwrite');
    const complete = transactionResult(transaction);
    const store = transaction.objectStore(SOURCES);
    records.forEach((record) => store.put(record));
    await complete;
  }

  async deleteSourceRecords(ids) {
    if (!ids.length) return;
    if (!this.databasePromise) {
      ids.forEach((id) => this.memory[SOURCES].delete(id));
      return;
    }
    const database = await this.databasePromise;
    const transaction = database.transaction(SOURCES, 'readwrite');
    const complete = transactionResult(transaction);
    const store = transaction.objectStore(SOURCES);
    ids.forEach((id) => store.delete(id));
    await complete;
  }

  async readManifest(storeName, id) {
    return (await this.readManifests(storeName, [id]))[0];
  }

  async readManifests(storeName, ids) {
    if (!ids.length) return [];
    if (!this.databasePromise) return ids.map((id) => this.memory[storeName].get(id));
    const database = await this.databasePromise;
    const transaction = database.transaction(storeName, 'readonly');
    const complete = transactionResult(transaction);
    const store = transaction.objectStore(storeName);
    const records = await Promise.all(ids.map((id) => requestResult(store.get(id))));
    await complete;
    return records;
  }

  async writeManifest(storeName, manifest) {
    if (!this.databasePromise) {
      this.memory[storeName].set(manifest.id, manifest);
      return;
    }
    const database = await this.databasePromise;
    const transaction = database.transaction(storeName, 'readwrite');
    const complete = transactionResult(transaction);
    transaction.objectStore(storeName).put(manifest);
    await complete;
  }

  async validateSourceRecords(manifest, entries, records) {
    const valid = await Promise.all(entries.map((entry, index) => validSourceRecord(entry, records[index])));
    const invalidIDs = entries.filter((_entry, index) => records[index] && !valid[index])
      .map((entry) => sourceID({ ...manifest, ...entry }));
    await this.deleteSourceRecords(invalidIDs);
    return valid.every(Boolean);
  }

  async stageSnapshotSources(manifest, entries, files) {
    const fileValidity = await Promise.all(files.map((file) => validSourceRecord(file, file)));
    const invalidFile = files.find((_file, index) => !fileValidity[index]);
    if (invalidFile) throw new Error(`Source content does not match Git blob ${invalidFile.blobId} for ${invalidFile.path}`);
    const records = files.map((file) => ({
      id: sourceID({ ...manifest, ...file }),
      blobId: file.blobId,
      source: file.source,
      bytes: file.bytes,
      format: CACHE_FORMAT_VERSION,
      // Verification happens here, once, at write time. Read and status
      // paths trust this marker instead of re-hashing the source against
      // its Git blob ID on every call.
      verified: true,
    }));
    await this.writeSourceRecords(records);
    const available = await this.readSourceRecords(entries.map((entry) => sourceID({ ...manifest, ...entry })));
    if (!await this.validateSourceRecords(manifest, entries, available)) {
      throw new Error('Cannot complete semantic snapshot with missing or invalid source blobs');
    }
    return available;
  }

  async writeSnapshot(storeName, manifest, entries, files) {
    await this.stageSnapshotSources(manifest, entries, files);

    if (!this.databasePromise) {
      this.memory[storeName].set(manifest.id, manifest);
      return;
    }

    const database = await this.databasePromise;
    const transaction = database.transaction(storeName, 'readwrite');
    const complete = transactionResult(transaction);
    transaction.objectStore(storeName).put(manifest);
    await complete;
  }

  // Side-effect-free: trusts each source record's `verified` marker (set
  // once at write time) and its format version instead of re-hashing the
  // source against its Git blob ID, and never deletes anything it finds
  // stale — pruning of records that fail verification belongs to the
  // explicitly-mutating operations (`prepareSources`, `stageSnapshotSources`),
  // not to a read.
  async readSnapshot(storeName, id, predicate = () => true) {
    const manifest = await this.readManifest(storeName, id);
    if (!isCurrentManifest(manifest)) return null;
    const entries = (manifest.entries || []).filter(predicate);
    const files = await this.readSourceRecords(entries.map((entry) => sourceID({ ...manifest, ...entry })));
    if (!entriesComplete(entries, files)) return null;
    return {
      modulePath: manifest.modulePath,
      files: files.map(({ source }, index) => ({ path: entries[index].path, source })),
      format: manifest.format,
    };
  }

  // Same trust-the-marker, no-mutation contract as `readSnapshot`, without
  // materializing file contents.
  async hasSnapshot(storeName, id, predicate = () => true, requireEntries = false) {
    const manifest = await this.readManifest(storeName, id);
    if (!isCurrentManifest(manifest)) return false;
    const entries = (manifest.entries || []).filter(predicate);
    if (requireEntries && !entries.length) return false;
    const files = await this.readSourceRecords(entries.map((entry) => sourceID({ ...manifest, ...entry })));
    return entriesComplete(entries, files);
  }
}

export function isCommitSHA(ref) {
  return /^[0-9a-f]{40}$/i.test(ref || '');
}
