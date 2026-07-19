(() => {
  const VERSION = 1;
  const KEY_PREFIX = `golensBookmark:v${VERSION}:`;

  function cleanText(value) { return typeof value === 'string' ? value.trim() : ''; }

  function normalizeScope(value) {
    if (!value || typeof value !== 'object') return null;
    const scope = {
      origin: cleanText(value.origin), project: cleanText(value.project),
      mrIid: cleanText(String(value.mrIid || '')), headSha: cleanText(value.headSha).toLowerCase(),
    };
    return scope.origin && scope.project && scope.mrIid && /^[0-9a-f]{40}$/.test(scope.headSha) ? scope : null;
  }

  function normalizeLocation(value) {
    if (!value || typeof value !== 'object') return null;
    const startLine = Number(value.startLine);
    const endLine = Number(value.endLine ?? value.startLine);
    const location = {
      path: cleanText(value.path).replace(/^\/+|\/+$/g, ''),
      side: value.side === 'old' ? 'old' : value.side === 'new' ? 'new' : '', startLine, endLine,
    };
    return location.path && location.side && Number.isInteger(startLine) && startLine > 0
      && Number.isInteger(endLine) && endLine >= startLine ? location : null;
  }

  function normalizeAnchor(value = {}) {
    const anchor = {
      symbol: cleanText(value.symbol).slice(0, 160),
      selectionHash: cleanText(value.selectionHash).toLowerCase(),
      beforeHash: cleanText(value.beforeHash).toLowerCase(),
      afterHash: cleanText(value.afterHash).toLowerCase(),
    };
    for (const key of ['selectionHash', 'beforeHash', 'afterHash']) {
      if (anchor[key] && !/^[0-9a-f]{64}$/.test(anchor[key])) return null;
    }
    return anchor;
  }

  function normalizeRecord(value) {
    if (!value || typeof value !== 'object' || value.version !== VERSION) return null;
    const scope = normalizeScope(value.scope);
    const location = normalizeLocation(value.location);
    const anchor = normalizeAnchor(value.anchor);
    const id = cleanText(value.id);
    const createdAt = Number(value.createdAt);
    if (!scope || !location || !anchor || !id || !Number.isFinite(createdAt) || createdAt < 0) return null;
    return { version: VERSION, id, createdAt, scope, location, anchor };
  }

  function recordKey(record) {
    const normalized = normalizeRecord(record);
    if (!normalized) return '';
    return `${KEY_PREFIX}${encodeURIComponent(JSON.stringify([
      normalized.scope.origin, normalized.scope.project, normalized.scope.mrIid,
      normalized.scope.headSha, normalized.id,
    ]))}`;
  }

  function sameMergeRequest(left, right) {
    return left?.origin === right?.origin && left?.project === right?.project && left?.mrIid === right?.mrIid;
  }

  function sameLocation(left, right) {
    return left?.path === right?.path && left?.side === right?.side
      && left?.startLine === right?.startLine && left?.endLine === right?.endLine;
  }

  function makeID() {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }

  async function hashText(value) {
    const source = String(value || '').replace(/\r\n?/g, '\n').trim();
    if (!source) return '';
    const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(source));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function createStore({ storage = globalThis.chrome?.storage?.local, storageChanges = globalThis.chrome?.storage?.onChanged, now = () => Date.now(), id = makeID } = {}) {
    async function allRecords() {
      if (!storage?.get) return [];
      const values = await storage.get(null);
      return Object.entries(values || {}).filter(([key]) => key.startsWith(KEY_PREFIX))
        .map(([, value]) => normalizeRecord(value)).filter(Boolean);
    }

    async function list(scope) {
      const normalizedScope = normalizeScope(scope);
      if (!normalizedScope) return [];
      return (await allRecords()).filter((record) => sameMergeRequest(record.scope, normalizedScope))
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    }

    async function put(value) {
      const record = normalizeRecord(value);
      const key = recordKey(record);
      if (!record || !key) throw new Error('Invalid bookmark record.');
      await storage.set({ [key]: record });
      return record;
    }

    async function remove(record) {
      const key = recordKey(record);
      if (!key) return false;
      await storage.remove(key);
      return true;
    }

    async function toggle({ scope, location, anchor = {} }) {
      const normalizedScope = normalizeScope(scope);
      const normalizedLocation = normalizeLocation(location);
      const normalizedAnchor = normalizeAnchor(anchor);
      if (!normalizedScope || !normalizedLocation || !normalizedAnchor) throw new Error('Invalid bookmark location.');
      const existing = (await list(normalizedScope)).find((record) => record.scope.headSha === normalizedScope.headSha && sameLocation(record.location, normalizedLocation));
      if (existing) { await remove(existing); return { action: 'removed', record: existing }; }
      const record = await put({ version: VERSION, id: id(), createdAt: now(), scope: normalizedScope, location: normalizedLocation, anchor: normalizedAnchor });
      return { action: 'added', record };
    }

    async function clear(scope, mode = 'all') {
      const normalizedScope = normalizeScope(scope);
      if (!normalizedScope) return 0;
      const records = (await list(normalizedScope)).filter((record) => {
        const stale = record.scope.headSha !== normalizedScope.headSha;
        return mode === 'all' || (mode === 'stale' ? stale : !stale);
      });
      if (records.length) await storage.remove(records.map(recordKey));
      return records.length;
    }

    async function recover(staleRecord, { scope, location, anchor }) {
      const previous = normalizeRecord(staleRecord);
      const nextScope = normalizeScope(scope);
      const nextLocation = normalizeLocation(location);
      const nextAnchor = normalizeAnchor(anchor);
      if (!previous || !nextScope || !nextLocation || !nextAnchor || !sameMergeRequest(previous.scope, nextScope)) throw new Error('Invalid bookmark recovery.');
      const recovered = await put({ ...previous, scope: nextScope, location: nextLocation, anchor: nextAnchor });
      await remove(previous);
      return recovered;
    }

    function subscribe(listener) {
      if (!storageChanges?.addListener) return () => {};
      const handleChange = (changes, areaName) => {
        if (areaName === 'local' && Object.keys(changes || {}).some((key) => key.startsWith(KEY_PREFIX))) listener(changes);
      };
      storageChanges.addListener(handleChange);
      return () => storageChanges.removeListener?.(handleChange);
    }

    return { list, put, remove, toggle, clear, recover, subscribe };
  }

  globalThis.GoLensBookmarks = { VERSION, KEY_PREFIX, createStore, hashText, normalizeScope, normalizeLocation, normalizeAnchor, normalizeRecord, recordKey, sameMergeRequest, sameLocation };
})();
