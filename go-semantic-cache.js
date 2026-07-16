const DATABASE_NAME = 'golens-go-semantic-cache';
const DATABASE_VERSION = 3;
const CACHE_FORMAT_VERSION = 3;
const SOURCES = 'sources';
const PACKAGES = 'packages';
const PROJECTS = 'projects';

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
    return { ...entry, source, bytes: new TextEncoder().encode(source).byteLength };
  });
}

async function gitBlobID(source, blobId) {
  if (typeof source !== 'string' || !validBlobID(blobId) || !globalThis.crypto?.subtle) return '';
  const encoder = new TextEncoder();
  const content = encoder.encode(source);
  const header = encoder.encode(`blob ${content.byteLength}\0`);
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

function sourceStats(store) {
  return new Promise((resolve, reject) => {
    let sources = 0;
    let bytes = 0;
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return resolve({ sources, bytes });
      sources++;
      bytes += cursor.value.bytes || new TextEncoder().encode(cursor.value.source || '').byteLength;
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

  async writeMergeRequest({ origin, project, mergeRequest, ref, packagePaths, searchStatus = 'complete' }) {
    const paths = [...new Set(packagePaths || [])].sort();
    for (const packagePath of paths) {
      const status = await this.packageStatus({ origin, project, ref, packagePath });
      if (status.status !== 'complete') throw new Error(`Cannot complete MR cache with missing package ${packagePath || '.'}`);
    }
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
    if (!manifest?.complete || manifest.format !== CACHE_FORMAT_VERSION) return { status: 'missing' };
    for (const packagePath of manifest.packagePaths || []) {
      const status = await this.packageStatus({ origin, project, ref, packagePath });
      if (status.status !== 'complete') return { status: 'missing' };
    }
    return {
      status: 'complete',
      format: manifest.format,
      coverage: 'related',
      searchStatus: manifest.searchStatus || 'complete',
      packages: manifest.packagePaths?.length || 0,
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
    const scope = { origin, project, ref, packagePath };
    if (await this.hasSnapshot(PACKAGES, packageID(scope))) return { status: 'complete', format: CACHE_FORMAT_VERSION };
    const projectScope = { origin, project, ref };
    const matchesPackage = (entry) => dirname(entry.path) === packagePath;
    if (await this.hasSnapshot(PROJECTS, projectID(projectScope), matchesPackage, true)) {
      return { status: 'complete', format: CACHE_FORMAT_VERSION };
    }
    return { status: 'missing' };
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
        bytes: [...this.memory[SOURCES].values()].reduce((total, file) => total + (file.bytes || new TextEncoder().encode(file.source).byteLength), 0),
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
    if (!this.databasePromise) return this.memory[storeName].get(id);
    const database = await this.databasePromise;
    return requestResult(database.transaction(storeName, 'readonly').objectStore(storeName).get(id));
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

  async writeSnapshot(storeName, manifest, entries, files) {
    const fileValidity = await Promise.all(files.map((file) => validSourceRecord(file, file)));
    const invalidFile = files.find((_file, index) => !fileValidity[index]);
    if (invalidFile) throw new Error(`Source content does not match Git blob ${invalidFile.blobId} for ${invalidFile.path}`);
    const records = files.map((file) => ({
      id: sourceID({ ...manifest, ...file }),
      blobId: file.blobId,
      source: file.source,
      bytes: file.bytes,
      format: CACHE_FORMAT_VERSION,
    }));
    await this.writeSourceRecords(records);
    const available = await this.readSourceRecords(entries.map((entry) => sourceID({ ...manifest, ...entry })));
    if (!await this.validateSourceRecords(manifest, entries, available)) {
      throw new Error('Cannot complete semantic snapshot with missing or invalid source blobs');
    }

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

  async readSnapshot(storeName, id, predicate = () => true) {
    if (!this.databasePromise) {
      const manifest = this.memory[storeName].get(id);
      if (!manifest?.complete || manifest.format !== CACHE_FORMAT_VERSION) return null;
      const entries = (manifest.entries || []).filter(predicate);
      const files = entries.map((entry) => this.memory[SOURCES].get(sourceID({ ...manifest, ...entry })));
      return await this.validateSourceRecords(manifest, entries, files)
        ? { modulePath: manifest.modulePath, files: files.map(({ source }, index) => ({ path: entries[index].path, source })), format: manifest.format }
        : null;
    }

    const database = await this.databasePromise;
    const manifest = await requestResult(database.transaction(storeName, 'readonly').objectStore(storeName).get(id));
    if (!manifest?.complete || manifest.format !== CACHE_FORMAT_VERSION) return null;
    const entries = (manifest.entries || []).filter(predicate);
    const transaction = database.transaction(SOURCES, 'readonly');
    const complete = transactionResult(transaction);
    const sources = transaction.objectStore(SOURCES);
    const files = await Promise.all(entries.map((entry) => requestResult(sources.get(sourceID({ ...manifest, ...entry })))));
    await complete;
    return await this.validateSourceRecords(manifest, entries, files)
      ? { modulePath: manifest.modulePath, files: files.map(({ source }, index) => ({ path: entries[index].path, source })), format: manifest.format }
      : null;
  }

  async hasSnapshot(storeName, id, predicate = () => true, requireEntries = false) {
    if (!this.databasePromise) {
      const manifest = this.memory[storeName].get(id);
      if (!manifest?.complete || manifest.format !== CACHE_FORMAT_VERSION) return false;
      const entries = (manifest.entries || []).filter(predicate);
      if (requireEntries && !entries.length) return false;
      const files = entries.map((entry) => this.memory[SOURCES].get(sourceID({ ...manifest, ...entry })));
      return this.validateSourceRecords(manifest, entries, files);
    }

    const database = await this.databasePromise;
    const manifest = await requestResult(database.transaction(storeName, 'readonly').objectStore(storeName).get(id));
    if (!manifest?.complete || manifest.format !== CACHE_FORMAT_VERSION) return false;
    const entries = (manifest.entries || []).filter(predicate);
    if (requireEntries && !entries.length) return false;
    const transaction = database.transaction(SOURCES, 'readonly');
    const complete = transactionResult(transaction);
    const sources = transaction.objectStore(SOURCES);
    const files = await Promise.all(entries.map((entry) => requestResult(sources.get(sourceID({ ...manifest, ...entry })))));
    await complete;
    return this.validateSourceRecords(manifest, entries, files);
  }
}

export function isCommitSHA(ref) {
  return /^[0-9a-f]{40}$/i.test(ref || '');
}
