(() => {
  const GO_FILE = /\.go$/i;
  const COMMIT_SHA = /^[0-9a-f]{40}$/i;
  const GO_DOCS_VERSION = 'go1.26.5';
  const IDENTIFIER = /[\p{L}_][\p{L}\p{N}_]*/u;
  const GO_KEYWORDS = new Set(['break', 'default', 'func', 'interface', 'select', 'case', 'defer', 'go', 'map', 'struct', 'chan', 'else', 'goto', 'package', 'switch', 'const', 'fallthrough', 'if', 'range', 'type', 'continue', 'for', 'import', 'return', 'var']);
  const POPOVER_DISMISS_DELAY = 450;
  const RELATED_CACHE_MAX_CANDIDATE_PACKAGES = 10;
  const RELATED_CACHE_MAX_SEARCH_QUERIES = 8;
  const RELATED_CACHE_SEARCH_PAGES = 2;
  const SYMBOL_PRESENTATIONS = {
    interface: { badge: 'I', label: 'Interface', className: 'interface' },
    struct: { badge: 'S', label: 'Struct', className: 'struct' },
    function: { badge: 'F', label: 'Function', className: 'function' },
    method: { badge: 'M', label: 'Method', className: 'method' },
    interfaceMethod: { badge: 'IM', label: 'Interface method', className: 'interface-method' },
    type: { badge: 'T', label: 'Named type', className: 'type' },
    variable: { badge: 'V', label: 'Variable', className: 'variable' },
    field: { badge: 'FD', label: 'Field', className: 'field' },
    constant: { badge: 'C', label: 'Constant', className: 'constant' },
    parameter: { badge: 'P', label: 'Parameter', className: 'parameter' },
    package: { badge: 'PKG', label: 'Package', className: 'package' },
    builtin: { badge: 'F', label: 'Builtin function', className: 'function' },
    external: { badge: 'Go', label: 'External Go documentation', className: 'external' },
  };
  const state = {
    enabled: false,
    port: null,
    rpcID: 0,
    pending: new Map(),
    packages: new Map(),
    projects: new Map(),
    projectProgressListeners: new Map(),
    modulePaths: new Map(),
    refsPromise: null,
    refsKey: '',
    refsFetchedAt: 0,
    hoverTimer: null,
    popoverDismissTimer: null,
    popoverMode: 'hidden',
    popoverTargetKey: '',
    pinnedPopover: false,
    pinnedTargetKey: '',
    activeTarget: null,
    activeElement: null,
    lastErrorToast: '',
    fullSearch: null,
    abortController: null,
    ui: null,
  };

  function projectContext() {
    const parts = location.pathname.split('/').filter(Boolean);
    const marker = parts.indexOf('-');
    if (marker < 2) return null;
    const project = parts.slice(0, marker).join('/');
    return { project, projectBase: `${location.origin}/${project}` };
  }

  function normalizePath(value) {
    return value
      .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
      .replace(/\s*\/\s*/g, '/')
      .trim();
  }

  function dirname(path) {
    const index = path.lastIndexOf('/');
    return index < 0 ? '' : path.slice(0, index);
  }

  function isProjectGoPath(path) {
    if (!GO_FILE.test(path)) return false;
    return !path.split('/').some((part) => part === 'vendor' || part === 'testdata');
  }

  function standardLibraryURL(importPath) {
    return `https://pkg.go.dev/${importPath.split('/').map(encodeURIComponent).join('/')}@${GO_DOCS_VERSION}`;
  }

  function packageDocumentationURL(importPath) {
    return `https://pkg.go.dev/${importPath.split('/').map(encodeURIComponent).join('/')}`;
  }

  function documentationURL(result) {
    if (result.status === 'builtin') return `${standardLibraryURL('builtin')}#${encodeURIComponent(result.symbol)}`;
    return result.status === 'standardLibrary' ? standardLibraryURL(result.importPath) : packageDocumentationURL(result.importPath);
  }

  function projectPackageURL(result) {
    const context = projectContext();
    if (!context || !COMMIT_SHA.test(result.ref || '')) return '';
    const tree = `${context.projectBase}/-/tree/${encodeURIComponent(result.ref)}`;
    return result.packagePath
      ? `${tree}/${result.packagePath.split('/').map(encodeURIComponent).join('/')}`
      : tree;
  }

  function parseBlobLink(anchor, expectedPath = '') {
    if (!anchor?.href) return null;
    const url = new URL(anchor.href, location.href);
    const marker = '/-/blob/';
    const index = url.pathname.indexOf(marker);
    if (index < 0) return null;
    const rest = decodeURIComponent(url.pathname.slice(index + marker.length));
    const normalizedExpected = normalizePath(expectedPath);
    if (normalizedExpected && rest.endsWith(`/${normalizedExpected}`)) {
      return { ref: rest.slice(0, -(normalizedExpected.length + 1)), path: normalizedExpected };
    }
    const match = rest.match(/^([0-9a-f]{40})\/(.+)$/i);
    if (match) return { ref: match[1], path: normalizePath(match[2]) };
    const slash = rest.indexOf('/');
    return slash < 0 ? null : { ref: rest.slice(0, slash), path: normalizePath(rest.slice(slash + 1)) };
  }

  function diffRootFor(node) {
    // Rapid Diffs wraps every file in a <diff-file data-file-data="…">
    // custom element. Prefer that outer element over the inner article so the
    // commit-pinned old/new paths remain available to the resolver.
    return node?.closest('diff-file')
      || node?.closest('.diff-file, [data-testid="diff-file"], [data-testid="rd-diff-file"], [data-file-path], .rd-diff-file')
      || node?.closest('table')?.parentElement;
  }

  function rapidFileData(root) {
    const value = root?.getAttribute?.('data-file-data');
    if (!value) return {};
    try { return JSON.parse(value); } catch { return {}; }
  }

  function fileContextFor(node) {
    const root = diffRootFor(node);
    if (!root) return null;
    const fileData = rapidFileData(root);
    const title = root.querySelector('[data-testid="file-title"], .file-title-name, .diff-file-header a[href*="/-/blob/"], .rd-diff-file-link, [data-testid="rd-diff-file-header"] a[href*="/-/blob/"]');
    const dataPath = root.getAttribute('data-file-path')
      || title?.getAttribute('data-file-path')
      || fileData.new_path
      || fileData.old_path;
    const path = normalizePath(dataPath || title?.textContent || '');
    if (!GO_FILE.test(path)) return null;
    const oldPath = normalizePath(fileData.old_path || path);
    const newPath = normalizePath(fileData.new_path || path);
    const links = [...root.querySelectorAll('a[href*="/-/blob/"]')];
    const link = links.find((candidate) => {
      const parsed = parseBlobLink(candidate, newPath) || parseBlobLink(candidate, oldPath);
      return parsed?.path === newPath || parsed?.path === oldPath;
    }) || links[0];
    const parsed = parseBlobLink(link, newPath) || parseBlobLink(link, oldPath) || parseBlobLink(link, path);
    if (!parsed) return null;
    return { root, path: newPath, oldPath, newPath, packagePath: dirname(newPath), ref: parsed.ref };
  }

  function codeCellFor(target) {
    const direct = target?.closest('td.line_content, td[class*="line-content"], [data-testid="diff-line-content"], [data-testid="rd-diff-line-content"], .rd-diff-code, .rd-diff-line-code');
    if (direct) return direct;
    const cell = target?.closest('td, [role="cell"], [role="gridcell"]');
    if (!cell || cell.querySelector('a[href*="#"]')) return null;
    const row = cell.closest('tr, [role="row"]');
    if (!row?.querySelector('a[href*="#"], [data-line-number]')) return null;
    return cell;
  }

  function lineFromAnchor(anchor) {
    if (!anchor) return 0;
    const data = anchor.getAttribute?.('data-line-number') || anchor.dataset?.lineNumber;
    if (/^\d+$/.test(data || '')) return Number(data);
    const label = `${anchor.getAttribute?.('aria-label') || ''} ${anchor.title || ''}`;
    const labelMatch = label.match(/(?:added|deleted|line)\D*(\d+)\s*$/i);
    if (labelMatch) return Number(labelMatch[1]);
    const text = (anchor.textContent || '').trim();
    if (/^\d+$/.test(text)) return Number(text);
    const hash = anchor.hash || anchor.getAttribute?.('href') || '';
    const hashMatch = hash.match(/(?:_|L)(\d+)$/i);
    return hashMatch ? Number(hashMatch[1]) : 0;
  }

  function lineAnchorFor(root, line) {
    const matches = [...root.querySelectorAll('a[href*="#"], [data-line-number]')]
      .filter((anchor) => lineFromAnchor(anchor) === line);
    return matches.find((anchor) => !/deleted|old/i.test(`${anchor.getAttribute('aria-label') || ''} ${anchor.closest('td, [role="cell"], [role="gridcell"]')?.className || ''}`)) || matches[0] || null;
  }

  function expansionDirectionForLine(line, visibleLines) {
    const lines = [...new Set(visibleLines.filter((candidate) => Number.isFinite(candidate) && candidate > 0))].sort((a, b) => a - b);
    if (!lines.length) return null;
    if (line < lines[0]) return 'up';
    if (line > lines[lines.length - 1]) return 'down';
    return null;
  }

  function waitForDiffUpdate(root) {
    return new Promise((resolve) => {
      let observer;
      const MutationObserverConstructor = root.ownerDocument?.defaultView?.MutationObserver || globalThis.MutationObserver;
      const finish = () => {
        clearTimeout(timeout);
        observer?.disconnect();
        resolve();
      };
      const timeout = setTimeout(finish, 400);
      if (!MutationObserverConstructor) return;
      observer = new MutationObserverConstructor(finish);
      observer.observe(root, { childList: true, subtree: true });
    });
  }

  async function revealLine(root, line) {
    for (let attempt = 0; attempt < 25; attempt++) {
      const target = lineAnchorFor(root, line);
      if (target) return target;
      const visibleLines = [...root.querySelectorAll('a[href*="#"], [data-line-number]')].map(lineFromAnchor);
      const direction = expansionDirectionForLine(line, visibleLines);
      if (!direction) return null;
      const button = [...root.querySelectorAll(`button[data-click="expandLines"][data-expand-direction="${direction}"]`)]
        .find((candidate) => !candidate.disabled);
      if (!button) return null;
      const updated = waitForDiffUpdate(root);
      button.click();
      await updated;
    }
    return lineAnchorFor(root, line);
  }

  function lineContextFor(cell) {
    const row = cell.closest('tr, [role="row"]');
    if (!row) return null;
    const cells = [...row.querySelectorAll(':scope > td, :scope > [role="cell"], :scope > [role="gridcell"]')];
    const cellIndex = Math.max(0, cells.indexOf(cell));
    const preceding = cells.slice(0, cellIndex).reverse();
    for (const candidate of preceding) {
      const anchor = candidate.querySelector('a[href*="#"], [data-line-number]');
      const line = lineFromAnchor(anchor || candidate);
      if (!line) continue;
      const position = cell.getAttribute('data-position') || candidate.getAttribute('data-position') || '';
      const label = `${anchor?.getAttribute('aria-label') || ''} ${candidate.className || ''}`;
      return { line, side: position === 'old' || (!position && /deleted|old/i.test(label)) ? 'old' : 'new' };
    }
    return null;
  }

  function isCodeCharacter(source, character) {
    let state = 'code';
    for (let index = 0; index <= character; index++) {
      const value = source[index] || '';
      const next = source[index + 1] || '';
      if (state === 'lineComment') return false;
      if (state === 'blockComment') {
        if (value === '*' && next === '/') {
          if (index === character || index + 1 === character) return false;
          state = 'code';
          index++;
          continue;
        }
        if (index === character) return false;
        continue;
      }
      if (state === 'string' || state === 'rune' || state === 'rawString') {
        if (index === character) return false;
        if (state !== 'rawString' && value === '\\') {
          if (index + 1 === character) return false;
          index++;
          continue;
        }
        if ((state === 'rawString' && value === '`') || (state === 'string' && value === '"') || (state === 'rune' && value === "'")) state = 'code';
        continue;
      }
      if (value === '/' && next === '/') {
        if (index === character || index + 1 === character) return false;
        state = 'lineComment';
        continue;
      }
      if (value === '/' && next === '*') {
        if (index === character || index + 1 === character) return false;
        state = 'blockComment';
        continue;
      }
      if (value === '"' || value === "'" || value === '`') {
        if (index === character) return false;
        state = value === '"' ? 'string' : value === "'" ? 'rune' : 'rawString';
        continue;
      }
      if (index === character) return true;
    }
    return false;
  }

  function identifierAtCharacter(source, character) {
    if (!isCodeCharacter(source, character)) return null;
    if (!/[\p{L}\p{N}_]/u.test(source[character] || '')) return null;
    let start = Math.min(character, source.length);
    let end = start;
    while (start > 0 && /[\p{L}\p{N}_]/u.test(source[start - 1])) start--;
    while (end < source.length && /[\p{L}\p{N}_]/u.test(source[end])) end++;
    const identifier = source.slice(start, end);
    if (!IDENTIFIER.test(identifier) || identifier !== identifier.match(IDENTIFIER)?.[0] || GO_KEYWORDS.has(identifier)) return null;
    let occurrence = 0;
    let candidate = source.indexOf(identifier);
    while (candidate >= 0 && candidate < start) {
      const before = source[candidate - 1] || '';
      const after = source[candidate + identifier.length] || '';
      if (!/[\p{L}\p{N}_]/u.test(before)
        && !/[\p{L}\p{N}_]/u.test(after)
        && isCodeCharacter(source, candidate)) occurrence++;
      candidate = source.indexOf(identifier, candidate + identifier.length);
    }
    return { identifier, character: start, occurrence };
  }

  function caretElementMatchesIdentifier(element, cell, identifier) {
    if (!element || element === cell) return element === cell;
    return (element.textContent || '').trim() === identifier;
  }

  function caretAtPoint(cell, x, y) {
    let node;
    let offset;
    if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(x, y);
      node = position?.offsetNode;
      offset = position?.offset;
    } else if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(x, y);
      node = range?.startContainer;
      offset = range?.startOffset;
    }
    if (!node || !cell.contains(node)) return null;
    const range = document.createRange();
    range.selectNodeContents(cell);
    try { range.setEnd(node, offset); } catch { return null; }
    const character = range.toString().length;
    const source = cell.textContent || '';
    const identifier = identifierAtCharacter(source, character);
    if (!identifier) return null;
    const element = node.nodeType === 1 ? node : node.parentElement;
    if (!caretElementMatchesIdentifier(element, cell, identifier.identifier)) return null;
    return { ...identifier, element: element === cell ? null : element };
  }

  function identifierFromElement(target, cell) {
    let element = target?.nodeType === 1 ? target : target?.parentElement;
    while (element && element !== cell) {
      const identifier = (element.textContent || '').trim();
      if (identifier && IDENTIFIER.test(identifier) && identifier === identifier.match(IDENTIFIER)?.[0]) {
        const range = document.createRange();
        range.selectNodeContents(cell);
        try { range.setEndBefore(element); } catch { return null; }
        const character = range.toString().length;
        const hit = identifierAtCharacter(cell.textContent || '', character);
        if (!hit || hit.identifier !== identifier) return null;
        return { ...hit, element };
      }
      element = element.parentElement;
    }
    return null;
  }

  function status(kind, message, progress) {
    document.dispatchEvent(new CustomEvent('golens-go-status', {
      detail: { kind, message, ...(progress ? { progress } : {}) },
    }));
  }

  function packageLoadingProgress(phase, completed = 0, total = 0, details = {}) {
    const safeTotal = Math.max(0, Number.isFinite(total) ? Math.floor(total) : 0);
    const safeCompleted = Math.min(safeTotal, Math.max(0, Number.isFinite(completed) ? Math.floor(completed) : 0));
    const percentage = phase === 'ready'
      ? 100
      : phase === 'discovering'
      ? 0
      : phase === 'indexing' || safeTotal === 0
      ? 90
      : Math.round((safeCompleted / safeTotal) * 90);
    return { phase, completed: safeCompleted, total: safeTotal, percentage, ...details };
  }

  function packageLoadingMessage(packagePath, progress) {
    const label = packagePath || 'root package';
    if (progress.phase === 'discovering') return `Preparing ${label}…`;
    if (progress.phase === 'indexing') return `Indexing symbols · ${progress.percentage}% · ${progress.total} / ${progress.total} files`;
    return `Loading ${label} · ${progress.percentage}% · ${progress.completed} / ${progress.total} files`;
  }

  function projectLoadingProgress(phase, completed = 0, total = 0, details = {}) {
    const safeTotal = Math.max(0, Number.isFinite(total) ? Math.floor(total) : 0);
    const safeCompleted = Math.min(safeTotal, Math.max(0, Number.isFinite(completed) ? Math.floor(completed) : 0));
    const percentage = phase === 'ready'
      ? 100
      : phase === 'discovering'
      ? 0
      : phase === 'indexing' || safeTotal === 0
      ? 95
      : Math.round((safeCompleted / safeTotal) * 90);
    return { phase, completed: safeCompleted, total: safeTotal, percentage, ...details };
  }

  function projectLoadingMessage(progress) {
    if (progress.phase === 'discovering') return 'Preparing MR head cache…';
    if (progress.phase === 'indexing') return `Caching and indexing ${progress.total} Go files…`;
    if (progress.phase === 'ready') return 'MR head cache ready';
    if (Number.isFinite(progress.cached) && Number.isFinite(progress.remaining)) {
      return `${progress.cached.toLocaleString()} cached · ${progress.remaining.toLocaleString()} remaining · ${progress.percentage}%`;
    }
    return `Fetching project Go sources · ${progress.percentage}% · ${progress.completed} / ${progress.total} files`;
  }

  function relatedLoadingProgress(phase, completed = 0, total = 0, details = {}) {
    const ranges = {
      changed: [5, 40],
      dependencies: [40, 65],
      candidates: [75, 95],
    };
    const safeTotal = Math.max(0, Number.isFinite(total) ? Math.floor(total) : 0);
    const safeCompleted = Math.min(safeTotal, Math.max(0, Number.isFinite(completed) ? Math.floor(completed) : 0));
    const fraction = Math.max(0, Math.min(1, Number.isFinite(details.packageFraction) ? details.packageFraction : 0));
    let percentage = 0;
    if (phase === 'ready') percentage = 100;
    else if (phase === 'searching') percentage = details.phaseDetail === 'implementations' ? 72 : 68;
    else if (phase === 'saving') percentage = 98;
    else if (ranges[phase]) {
      const [start, end] = ranges[phase];
      const progress = safeTotal ? (safeCompleted + fraction) / safeTotal : 1;
      percentage = Math.round(start + Math.min(1, progress) * (end - start));
    }
    const { packageFraction: _packageFraction, ...rest } = details;
    return { phase, completed: safeCompleted, total: safeTotal, percentage, unit: 'packages', ...rest };
  }

  function relatedLoadingMessage(progress) {
    if (progress.phase === 'discovering') return 'Discovering changed Go packages…';
    if (progress.phase === 'searching') {
      return progress.phaseDetail === 'implementations'
        ? `Finding likely implementations · ${progress.percentage}%`
        : `Finding likely usages · ${progress.percentage}%`;
    }
    if (progress.phase === 'saving') return `Saving related cache · ${progress.percentage}%`;
    if (progress.phase === 'ready') return 'Related MR cache ready';
    const labels = {
      changed: 'Caching changed packages',
      dependencies: 'Caching direct dependencies',
      candidates: 'Caching likely related packages',
    };
    return `${labels[progress.phase] || 'Caching related packages'} · ${progress.percentage}% · ${progress.completed} / ${progress.total} packages`;
  }

  function workerRPC(method, params) {
    if (!state.port) {
      state.port = chrome.runtime.connect({ name: 'golens-go-rpc' });
      state.port.onMessage.addListener((response) => {
        const pending = state.pending.get(response.id);
        if (!pending) return;
        clearTimeout(pending.timeout);
        state.pending.delete(response.id);
        if (response.ok) pending.resolve(response.result);
        else pending.reject(new Error(response.error || 'Go semantic service failed'));
      });
      state.port.onDisconnect.addListener(() => {
        const error = new Error(chrome.runtime.lastError?.message || 'Go semantic service disconnected');
        for (const pending of state.pending.values()) {
          clearTimeout(pending.timeout);
          pending.reject(error);
        }
        state.pending.clear();
        state.port = null;
        state.packages.clear();
        state.projects.clear();
        state.modulePaths.clear();
      });
    }
    const id = ++state.rpcID;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error('Go semantic service timed out'));
      }, ['indexProject', 'cacheProject', 'restoreProject', 'restoreMergeRequest', 'projectCacheStatus', 'mergeRequestCacheStatus', 'cacheMergeRequest', 'packageCacheStatus', 'prepareSources'].includes(method) ? 120000 : 20000);
      state.pending.set(id, { resolve, reject, timeout });
      state.port.postMessage({ id, method, params });
    });
  }

  function authenticatedFetch(input, options = {}) {
    return fetch(input, {
      credentials: 'include',
      ...options,
      signal: state.abortController?.signal,
    });
  }

  function nextPageNumber(response, currentPage, entries) {
    const header = response.headers.get('x-next-page');
    if (/^\d+$/.test(header || '')) return Number(header);
    return entries.length === 100 ? currentPage + 1 : 0;
  }

  async function fetchSource(path, ref) {
    const project = projectContext();
    const url = `${project.projectBase}/-/raw/${encodeURIComponent(ref)}/${path.split('/').map(encodeURIComponent).join('/')}`;
    const response = await authenticatedFetch(url);
    if (!response.ok) throw new Error(`GitLab returned ${response.status} for ${path}`);
    return response.text();
  }

  async function fetchBlob({ path, blobId }, ref) {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i.test(blobId || '')) {
      throw new Error(`GitLab did not provide a valid blob ID for ${path}`);
    }
    const { project } = projectContext();
    const url = `${location.origin}/api/v4/projects/${encodeURIComponent(project)}/repository/blobs/${encodeURIComponent(blobId)}/raw`;
    const response = await authenticatedFetch(url);
    if (!response.ok) throw new Error(`GitLab returned ${response.status} for ${path}`);
    return { path, blobId, source: await response.text() };
  }

  function clearMergeRequestRefs() {
    state.refsPromise = null;
    state.refsKey = '';
    state.refsFetchedAt = 0;
  }

  function refsDisagreeWithFile(refs, fileRef) {
    return COMMIT_SHA.test(fileRef || '')
      && COMMIT_SHA.test(refs?.headSha || '')
      && refs.headSha.toLowerCase() !== fileRef.toLowerCase();
  }

  async function mergeRequestRefs() {
    const context = projectContext();
    const iid = location.pathname.match(/\/-\/merge_requests\/(\d+)/)?.[1];
    const key = `${location.origin}\u0000${context?.project || ''}\u0000${iid || ''}`;
    if (state.refsPromise && state.refsKey === key && Date.now() - state.refsFetchedAt < 15000) return state.refsPromise;
    state.refsKey = key;
    state.refsFetchedAt = Date.now();
    state.refsPromise = (async () => {
      if (!context || !iid) return {};
      const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
      const response = await authenticatedFetch(`${location.origin}/api/graphql`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
        },
        body: JSON.stringify({
          query: 'query GoLensMergeRequestRefs($fullPath: ID!, $iid: String!) { project(fullPath: $fullPath) { mergeRequest(iid: $iid) { diffRefs { baseSha headSha startSha } } } }',
          variables: { fullPath: context.project, iid },
        }),
      });
      if (!response.ok) return {};
      const payload = await response.json();
      return payload.data?.project?.mergeRequest?.diffRefs || {};
    })().catch(() => ({}));
    return state.refsPromise;
  }

  async function mergeRequestRefsForFile(file) {
    let refs = await mergeRequestRefs();
    if (refsDisagreeWithFile(refs, file.ref)) {
      clearMergeRequestRefs();
      refs = await mergeRequestRefs();
    }
    return refs;
  }

  function sourceRefFor(file, line, refs) {
    if (line.side === 'old') return refs.startSha || refs.baseSha || file.ref;
    return COMMIT_SHA.test(file.ref || '') ? file.ref : (refs.headSha || file.ref);
  }

  async function listPackageFiles(packagePath, ref) {
    const { project } = projectContext();
    const encodedProject = encodeURIComponent(project);
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    const files = [];
    for (let page = 1; page;) {
      const url = `${location.origin}/api/v4/projects/${encodedProject}/repository/tree?path=${encodeURIComponent(packagePath)}&ref=${encodeURIComponent(ref)}&per_page=100&page=${page}`;
      const response = await authenticatedFetch(url, { headers: csrf ? { 'X-CSRF-Token': csrf } : {} });
      if (!response.ok) throw new Error(`GitLab source API returned ${response.status}`);
      const entries = await response.json();
      if (!Array.isArray(entries)) throw new Error('GitLab returned an invalid repository tree response');
      files.push(...entries.filter((entry) => entry.type === 'blob' && GO_FILE.test(entry.path)).map((entry) => ({ path: entry.path, blobId: entry.id || '' })));
      if (files.length > 200) throw new Error(`Package ${packagePath || '.'} contains too many Go files`);
      page = nextPageNumber(response, page, entries);
    }
    return files;
  }

  async function listProjectFiles(ref) {
    const { project } = projectContext();
    const encodedProject = encodeURIComponent(project);
    const csrf = document.querySelector('meta[name="csrf-token"]')?.content || '';
    const files = [];
    for (let page = 1; page;) {
      const url = `${location.origin}/api/v4/projects/${encodedProject}/repository/tree?recursive=true&ref=${encodeURIComponent(ref)}&per_page=100&page=${page}`;
      const response = await authenticatedFetch(url, { headers: csrf ? { 'X-CSRF-Token': csrf } : {} });
      if (!response.ok) throw new Error(`GitLab source API returned ${response.status}`);
      const entries = await response.json();
      if (!Array.isArray(entries)) throw new Error('GitLab returned an invalid repository tree response');
      files.push(...entries.filter((entry) => entry.type === 'blob' && isProjectGoPath(entry.path)).map((entry) => ({ path: entry.path, blobId: entry.id || '' })));
      page = nextPageNumber(response, page, entries);
    }
    return files;
  }

  function mergeRequestIID() {
    return location.pathname.match(/\/-\/merge_requests\/(\d+)/)?.[1] || '';
  }

  async function mergeRequestCelebrationStatus() {
    const { project } = projectContext();
    const mergeRequest = mergeRequestIID();
    if (!mergeRequest) throw new Error('GitLab merge request context is unavailable.');
    const encodedProject = encodeURIComponent(project);
    const response = await authenticatedFetch(
      `${location.origin}/api/v4/projects/${encodedProject}/merge_requests/${encodeURIComponent(mergeRequest)}/approvals`,
    );
    if (!response.ok) throw new Error(`GitLab approval API returned ${response.status}`);
    const result = await response.json();
    const approvers = Array.isArray(result.approved_by)
      ? result.approved_by.map((approval) => approval?.user?.id || approval?.user?.username).filter(Boolean).map(String)
      : [];
    return { state: result.state || '', approvers };
  }

  async function mergeRequestDiscussionStatus() {
    const { project } = projectContext();
    const mergeRequest = mergeRequestIID();
    if (!mergeRequest) throw new Error('GitLab merge request context is unavailable.');
    const encodedProject = encodeURIComponent(project);
    let unresolved = 0;
    for (let page = 1; page;) {
      if (page > 20) throw new Error('Merge request has too many discussion pages');
      const response = await authenticatedFetch(
        `${location.origin}/api/v4/projects/${encodedProject}/merge_requests/${encodeURIComponent(mergeRequest)}/discussions?per_page=100&page=${page}`,
      );
      if (!response.ok) throw new Error(`GitLab discussions API returned ${response.status}`);
      const discussions = await response.json();
      if (!Array.isArray(discussions)) throw new Error('GitLab returned invalid merge request discussions');
      unresolved += discussions.filter((discussion) =>
        Array.isArray(discussion?.notes)
        && discussion.notes.some((note) => note?.resolvable && !note?.resolved)
      ).length;
      page = nextPageNumber(response, page, discussions);
    }
    return { unresolved };
  }

  async function listMergeRequestChangedFiles() {
    const { project } = projectContext();
    const mergeRequest = mergeRequestIID();
    if (!mergeRequest) throw new Error('GitLab merge request context is unavailable.');
    const encodedProject = encodeURIComponent(project);
    const files = [];
    for (let page = 1; page;) {
      const url = `${location.origin}/api/v4/projects/${encodedProject}/merge_requests/${encodeURIComponent(mergeRequest)}/diffs?per_page=100&page=${page}`;
      const response = await authenticatedFetch(url);
      if (!response.ok) throw new Error(`GitLab merge request API returned ${response.status}`);
      const entries = await response.json();
      if (!Array.isArray(entries)) throw new Error('GitLab returned an invalid merge request diff response');
      files.push(...entries
        .filter((entry) => !entry.deleted_file && isProjectGoPath(entry.new_path || ''))
        .map((entry) => entry.new_path));
      page = nextPageNumber(response, page, entries);
    }
    return [...new Set(files)];
  }

  async function searchProjectBlobPaths(search, ref, { maxPages = 100, maxPaths = Infinity } = {}) {
    const { project } = projectContext();
    const encodedProject = encodeURIComponent(project);
    const paths = new Set();
    try {
      for (let page = 1; page <= maxPages; page++) {
        const parameters = new URLSearchParams({ scope: 'blobs', search, ref, per_page: '100', page: String(page) });
        const response = await authenticatedFetch(`${location.origin}/api/v4/projects/${encodedProject}/search?${parameters}`);
        if (!response.ok) return { paths: [...paths], status: paths.size ? 'limited' : 'unavailable' };
        const entries = await response.json();
        if (!Array.isArray(entries)) return { paths: [...paths], status: paths.size ? 'limited' : 'unavailable' };
        entries.filter((entry) => isProjectGoPath(entry.path || '')).forEach((entry) => paths.add(entry.path));
        if (paths.size >= maxPaths) return { paths: [...paths].slice(0, maxPaths), status: 'limited' };
        const nextPage = response.headers.get('x-next-page');
        if (nextPage) {
          page = Number(nextPage) - 1;
          continue;
        }
        if (entries.length < 100) return { paths: [...paths], status: 'complete' };
      }
      return { paths: [...paths], status: 'limited' };
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      return { paths: [...paths], status: paths.size ? 'limited' : 'unavailable' };
    }
  }

  async function modulePathFor(ref) {
    const key = `${projectContext().project}\u0000${ref}`;
    if (state.modulePaths.has(key)) return state.modulePaths.get(key);
    try {
      const source = await fetchSource('go.mod', ref);
      const modulePath = source.match(/^\s*module\s+([^\s]+)\s*$/m)?.[1] || '';
      state.modulePaths.set(key, modulePath);
      return modulePath;
    } catch (error) {
      if (error?.name === 'AbortError') throw error;
      state.modulePaths.set(key, '');
      return '';
    }
  }

  async function mapLimit(values, limit, mapper) {
    const results = new Array(values.length);
    let next = 0;
    async function consume() {
      while (next < values.length) {
        const index = next++;
        results[index] = await mapper(values[index], index);
      }
    }
    await Promise.all(Array.from({ length: Math.min(limit, values.length) }, consume));
    return results;
  }

  async function loadPackage(packagePath, ref, onProgress = () => {}) {
    const context = projectContext();
    const key = `${location.origin}\u0000${context.project}\u0000${ref}\u0000${packagePath}`;
    const projectKey = `${location.origin}\u0000${context.project}\u0000${ref}`;
    if (state.projects.has(projectKey)) return state.projects.get(projectKey);
    if (state.packages.has(key)) return state.packages.get(key);
    const promise = (async () => {
      const reportProgress = (progress) => {
        const message = packageLoadingMessage(packagePath, progress);
        status('loading', message, progress);
        onProgress(message, progress);
      };
      reportProgress(packageLoadingProgress('discovering'));
      const cacheStatus = COMMIT_SHA.test(ref)
        ? await workerRPC('packageCacheStatus', { origin: location.origin, project: context.project, ref, packagePath })
        : { status: 'missing' };
      if (cacheStatus.status === 'complete') {
        const cached = await workerRPC('restorePackage', { origin: location.origin, project: context.project, ref, packagePath });
        if (cached.status !== 'cacheMiss') {
          const message = cached.status === 'cacheHit'
            ? `Go intelligence restored from cache · ${cached.definitions} symbols`
            : 'Go intelligence ready';
          status('ready', message, packageLoadingProgress('ready'));
          return { ...cached, cached: cached.files || 0, downloaded: 0 };
        }
      }
      const entries = await listPackageFiles(packagePath, ref);
      const prepared = COMMIT_SHA.test(ref)
        ? await workerRPC('prepareSources', { origin: location.origin, project: context.project, ref, files: entries })
        : { total: entries.length, cached: 0, missing: entries.map((entry) => ({ ...entry, referencedFiles: 1 })) };
      let downloaded = 0;
      let completed = prepared.cached;
      const progressDetails = () => ({
        cached: prepared.cached,
        downloaded,
        remaining: Math.max(0, prepared.total - completed),
      });
      reportProgress(packageLoadingProgress('fetching', completed, prepared.total, progressDetails()));
      const files = await mapLimit(prepared.missing, 6, async (entry) => {
        const file = await fetchBlob(entry, ref);
        const referencedFiles = entry.referencedFiles || 1;
        downloaded += referencedFiles;
        completed += referencedFiles;
        reportProgress(packageLoadingProgress('fetching', completed, prepared.total, progressDetails()));
        return file;
      });
      reportProgress(packageLoadingProgress('indexing', completed, prepared.total, progressDetails()));
      const modulePath = await modulePathFor(ref);
      const result = await workerRPC('cachePackage', { origin: location.origin, project: context.project, ref, packagePath, modulePath, entries, files });
      status('ready', `Go intelligence ready · ${result.definitions} symbols`, packageLoadingProgress('ready', prepared.total, prepared.total));
      return { ...result, cached: prepared.cached, downloaded };
    })().catch((error) => {
      state.packages.delete(key);
      status('error', error.message);
      throw error;
    });
    state.packages.set(key, promise);
    return promise;
  }

  async function loadProject(ref, progress = () => {}) {
    const context = projectContext();
    const key = `${location.origin}\u0000${context.project}\u0000${ref}`;
    if (state.projects.has(key)) {
      state.projectProgressListeners.get(key)?.add(progress);
      return state.projects.get(key);
    }
    const listeners = new Set([progress]);
    state.projectProgressListeners.set(key, listeners);
    const promise = (async () => {
      const reportProgress = (update, message = projectLoadingMessage(update)) => {
        for (const listener of listeners) listener(message, update);
        status(update.phase === 'ready' ? 'ready' : 'loading', message, update);
      };
      reportProgress(projectLoadingProgress('discovering'));
      const cached = await workerRPC('restoreProject', { origin: location.origin, project: context.project, ref });
      if (cached.status !== 'cacheMiss') {
        const message = cached.status === 'cacheHit'
          ? `Go project intelligence restored from cache · ${cached.packages} packages`
          : 'Go project intelligence ready';
        reportProgress(projectLoadingProgress('ready'), message);
        return cached;
      }
      const entries = await listProjectFiles(ref);
      const prepared = COMMIT_SHA.test(ref)
        ? await workerRPC('prepareSources', { origin: location.origin, project: context.project, ref, files: entries })
        : { total: entries.length, cached: 0, missing: entries.map((entry) => ({ ...entry, referencedFiles: 1 })) };
      let downloaded = 0;
      let completed = prepared.cached;
      const progressDetails = () => ({
        cached: prepared.cached,
        downloaded,
        remaining: Math.max(0, prepared.total - completed),
      });
      reportProgress(projectLoadingProgress('fetching', completed, prepared.total, progressDetails()));
      const files = await mapLimit(prepared.missing, 6, async (entry) => {
        const file = await fetchBlob(entry, ref);
        const referencedFiles = entry.referencedFiles || 1;
        downloaded += referencedFiles;
        completed += referencedFiles;
        reportProgress(projectLoadingProgress('fetching', completed, prepared.total, progressDetails()));
        return file;
      });
      reportProgress(projectLoadingProgress('indexing', prepared.total, prepared.total, progressDetails()));
      const modulePath = await modulePathFor(ref);
      const result = await workerRPC('cacheProject', { origin: location.origin, project: context.project, ref, modulePath, entries, files });
      reportProgress(projectLoadingProgress('ready', prepared.total, prepared.total, progressDetails()), `Go project intelligence ready · ${result.packages} packages`);
      return result;
    })().catch((error) => {
      state.projects.delete(key);
      status('error', error.message);
      throw error;
    }).finally(() => {
      state.projectProgressListeners.delete(key);
    });
    state.projects.set(key, promise);
    return promise;
  }

  async function mergeRequestHeadRef() {
    const ref = (await mergeRequestRefs()).headSha || '';
    if (!COMMIT_SHA.test(ref)) {
      state.refsPromise = null;
      state.refsKey = '';
      state.refsFetchedAt = 0;
      throw new Error('Unable to determine the MR head commit.');
    }
    return ref;
  }

  function mergeSearchStatus(current, next) {
    if (current === 'unavailable' || next === 'unavailable') return 'unavailable';
    if (current === 'limited' || next === 'limited') return 'limited';
    return 'complete';
  }

  function relatedReadyMessage(searchStatus) {
    if (searchStatus === 'unavailable') return 'Related cache ready · code search unavailable';
    if (searchStatus === 'limited') return 'Related cache ready · candidate search limited';
    return 'Related MR cache ready';
  }

  async function mergeRequestPreloadStatus() {
    const context = projectContext();
    if (!context) throw new Error('GitLab project context is unavailable.');
    const ref = await mergeRequestHeadRef();
    const mergeRequest = mergeRequestIID();
    const result = await workerRPC('projectCacheStatus', { origin: location.origin, project: context.project, mergeRequest, ref });
    return { ...result, ref };
  }

  async function preloadMergeRequest(progress = () => {}) {
    const context = projectContext();
    if (!context) throw new Error('GitLab project context is unavailable.');
    const ref = await mergeRequestHeadRef();
    const mergeRequest = mergeRequestIID();
    const scope = { origin: location.origin, project: context.project, mergeRequest, ref };
    const cacheStatus = await workerRPC('projectCacheStatus', scope);
    if (cacheStatus.status === 'complete') {
      progress(relatedReadyMessage(cacheStatus.searchStatus), projectLoadingProgress('ready', 0, 0, {
        coverage: cacheStatus.coverage,
        searchStatus: cacheStatus.searchStatus,
      }));
      return { ...cacheStatus, ref };
    }

    const tracker = { files: 0, cached: 0, downloaded: 0 };
    const relations = new Map();
    const loaded = new Set();
    const report = (update, message = relatedLoadingMessage(update)) => progress(message, update);
    const reportDiscovery = (message, details = {}) => report(relatedLoadingProgress('discovering', 0, 0, {
      cached: tracker.cached,
      downloaded: tracker.downloaded,
      remaining: 0,
      packages: loaded.size,
      ...details,
    }), message);
    const loadRelatedPackage = async (packagePath, phase, packageIndex, packageTotal) => {
      const label = packagePath || 'root package';
      const result = await loadPackage(packagePath, ref, (_message, update) => {
        const packageFraction = update.phase === 'discovering' ? 0 : Math.min(1, (update.percentage || 0) / 100);
        const aggregate = relatedLoadingProgress(phase, packageIndex, packageTotal, {
          packageFraction,
          cached: tracker.cached + (update.cached || 0),
          downloaded: tracker.downloaded + (update.downloaded || 0),
          remaining: Math.max(0, (update.total || 0) - (update.completed || 0)),
          packages: loaded.size,
        });
        report(aggregate);
      });
      const files = result.files || 0;
      const downloaded = result.downloaded || 0;
      tracker.files += files;
      tracker.downloaded += downloaded;
      tracker.cached += Number.isFinite(result.cached) ? result.cached : Math.max(0, files - downloaded);
      const relation = await workerRPC('packageRelations', { origin: location.origin, project: context.project, ref, packagePath });
      if (relation.status !== 'relations') throw new Error(`Unable to inspect related package ${label}`);
      relations.set(packagePath, relation);
      loaded.add(packagePath);
      return relation;
    };
    const loadPhase = async (packagePaths, phase) => {
      const pending = [...new Set(packagePaths)].filter((packagePath) => !loaded.has(packagePath)).sort();
      if (!pending.length) {
        report(relatedLoadingProgress(phase, 0, 0, {
          cached: tracker.cached,
          downloaded: tracker.downloaded,
          remaining: 0,
          packages: loaded.size,
        }));
        return;
      }
      for (let index = 0; index < pending.length; index++) {
        await loadRelatedPackage(pending[index], phase, index, pending.length);
        report(relatedLoadingProgress(phase, index + 1, pending.length, {
          cached: tracker.cached,
          downloaded: tracker.downloaded,
          remaining: 0,
          packages: loaded.size,
        }));
      }
    };

    reportDiscovery('Discovering changed Go packages…');
    const changedFiles = await listMergeRequestChangedFiles();
    const seedPackages = [...new Set(changedFiles.map(dirname))].sort();
    await loadPhase(seedPackages, 'changed');

    const directDependencies = [...new Set(seedPackages.flatMap((packagePath) => relations.get(packagePath)?.imports || []))];
    await loadPhase(directDependencies, 'dependencies');

    // The sidebar intentionally performs a bounded candidate search. Deeper
    // traversal stays lazy, while the popup remains the exhaustive option.
    let searchStatus = 'limited';
    const modulePath = await modulePathFor(ref);
    const referencedImports = seedPackages.flatMap((packagePath) => relations.get(packagePath)?.referencedImports || []);
    const relevantInterfaces = new Map();
    for (const packagePath of seedPackages) {
      for (const interfaceRecord of relations.get(packagePath)?.interfaces || []) relevantInterfaces.set(interfaceRecord.identity, interfaceRecord);
    }
    for (const reference of referencedImports) {
      const interfaceRecord = relations.get(reference.packagePath)?.interfaces.find(({ name }) => name === reference.name);
      if (interfaceRecord) relevantInterfaces.set(interfaceRecord.identity, interfaceRecord);
    }

    const searchCache = new Map();
    let searchQueries = 0;
    const searchCandidates = async (query) => {
      if (!searchCache.has(query)) {
        if (searchQueries >= RELATED_CACHE_MAX_SEARCH_QUERIES) return new Set();
        searchQueries++;
        searchCache.set(query, searchProjectBlobPaths(query, ref, {
          maxPages: RELATED_CACHE_SEARCH_PAGES,
          maxPaths: RELATED_CACHE_MAX_CANDIDATE_PACKAGES * 2,
        }));
      }
      const result = await searchCache.get(query);
      searchStatus = mergeSearchStatus(searchStatus, result.status);
      return new Set(result.paths.map(dirname));
    };
    const candidates = new Set();
    if (!modulePath) {
      searchStatus = 'limited';
    } else {
      report(relatedLoadingProgress('searching', 0, 0, { phaseDetail: 'usages' }));
      for (const packagePath of seedPackages) {
        const importPath = [modulePath, packagePath].filter(Boolean).join('/');
        for (const candidate of await searchCandidates(importPath)) candidates.add(candidate);
      }

      report(relatedLoadingProgress('searching', 0, 0, { phaseDetail: 'implementations' }));
      for (const interfaceRecord of relevantInterfaces.values()) {
        for (const candidate of await searchCandidates(interfaceRecord.name)) candidates.add(candidate);
      }
    }

    const boundedCandidates = [...candidates]
      .filter((packagePath) => !loaded.has(packagePath))
      .sort()
      .slice(0, RELATED_CACHE_MAX_CANDIDATE_PACKAGES);
    await loadPhase(boundedCandidates, 'candidates');
    const finalProgress = relatedLoadingProgress('saving', loaded.size, loaded.size, {
      cached: tracker.cached,
      downloaded: tracker.downloaded,
      remaining: 0,
      packages: loaded.size,
      searchStatus,
    });
    report(finalProgress, `Saving related cache · ${loaded.size} packages · ${finalProgress.percentage}%`);
    await workerRPC('cacheMergeRequest', { ...scope, packagePaths: [...loaded], searchStatus });
    const verified = await workerRPC('projectCacheStatus', scope);
    if (verified.status !== 'complete') throw new Error('Related MR sources were indexed but not stored in the persistent cache.');
    progress(relatedReadyMessage(verified.searchStatus), relatedLoadingProgress('ready', loaded.size, loaded.size, {
      cached: tracker.cached,
      downloaded: tracker.downloaded,
      remaining: 0,
      packages: loaded.size,
      searchStatus: verified.searchStatus,
    }));
    return { ...verified, ref };
  }

  async function fullProjectPreloadStatus() {
    const context = projectContext();
    if (!context) throw new Error('GitLab project context is unavailable.');
    const ref = await mergeRequestHeadRef();
    const result = await workerRPC('projectCacheStatus', { origin: location.origin, project: context.project, ref });
    return { ...result, ref };
  }

  async function preloadFullProject(progress = () => {}, requestedRef = '') {
    const context = projectContext();
    if (!context) throw new Error('GitLab project context is unavailable.');
    const ref = requestedRef || await mergeRequestHeadRef();
    if (!COMMIT_SHA.test(ref)) throw new Error('Full-project search requires an immutable commit.');
    const cacheStatus = await workerRPC('projectCacheStatus', { origin: location.origin, project: context.project, ref });
    if (cacheStatus.status !== 'complete') {
      const projectKey = `${location.origin}\u0000${context.project}\u0000${ref}`;
      if (!state.projectProgressListeners.has(projectKey)) state.projects.delete(projectKey);
      await loadProject(ref, progress);
    } else {
      progress('Full project cache ready', projectLoadingProgress('ready'));
    }
    const verified = await workerRPC('projectCacheStatus', { origin: location.origin, project: context.project, ref });
    if (verified.status !== 'complete') throw new Error('Project sources were indexed but not stored in the persistent cache.');
    return { ...verified, ref };
  }

  function invalidateCacheState() {
    state.packages.clear();
    state.projects.clear();
    state.projectProgressListeners.clear();
  }

  async function resolveAt(target, method, onProgress) {
    const file = fileContextFor(target.cell);
    const line = lineContextFor(target.cell);
    const context = projectContext();
    if (!file || !line || !context) return { status: 'unsupported', reason: 'diffContextUnavailable' };
    const refs = await mergeRequestRefsForFile(file);
    const sourcePath = line.side === 'old' ? file.oldPath : file.newPath;
    const packagePath = dirname(sourcePath);
    const ref = sourceRefFor(file, line, refs);
    await loadPackage(packagePath, ref, onProgress);
    const params = {
      origin: location.origin,
      project: context.project,
      ref,
      packagePath,
      path: sourcePath,
      line: line.line,
      character: target.character,
      identifier: target.identifier,
      occurrence: target.occurrence,
    };
    let result = await workerRPC(method, params);
    if (result.status === 'needsPackage') {
      await loadPackage(result.packagePath, ref, onProgress);
      result = await workerRPC(method, params);
    }
    return result;
  }

  function relatedResultScope(restored, packagePath) {
    if (restored?.coverage === 'related') {
      return {
        kind: 'indexedPackages',
        packageCount: restored.packages || 0,
        complete: false,
        searchStatus: restored.searchStatus || 'limited',
      };
    }
    return null;
  }

  async function findReferencesAt(target, definition, cursor = '') {
    const file = fileContextFor(target.cell);
    const line = lineContextFor(target.cell);
    const context = projectContext();
    if (!file || !line || !context) return { status: 'notFound' };
    const refs = await mergeRequestRefsForFile(file);
    const sourcePath = line.side === 'old' ? file.oldPath : file.newPath;
    const packagePath = dirname(sourcePath);
    const ref = sourceRefFor(file, line, refs);
    await loadPackage(packagePath, ref);
    let restored = null;
    if (ref === refs.headSha) {
      restored = await workerRPC('restoreMergeRequest', {
        origin: location.origin,
        project: context.project,
        mergeRequest: mergeRequestIID(),
        ref,
      });
    }
    const result = await workerRPC('findReferences', {
      origin: location.origin,
      project: context.project,
      ref,
      packagePath,
      definition,
      pageSize: 25,
      cursor,
      ...(relatedResultScope(restored, packagePath) ? { scope: relatedResultScope(restored, packagePath) } : {}),
    });
    return { ...result, request: { kind: 'references', target, definition, ref } };
  }

  async function findImplementationsAt(target, definition, progress = () => {}, cursor = '') {
    const file = fileContextFor(target.cell);
    const line = lineContextFor(target.cell);
    const context = projectContext();
    if (!file || !line || !context) return { status: 'notFound' };
    const refs = await mergeRequestRefsForFile(file);
    const ref = sourceRefFor(file, line, refs);
    let restored = null;
    if (ref === refs.headSha) {
      await preloadMergeRequest(progress);
      restored = await workerRPC('restoreMergeRequest', {
        origin: location.origin,
        project: context.project,
        mergeRequest: mergeRequestIID(),
        ref,
      });
    } else {
      await loadPackage(dirname(line.side === 'old' ? file.oldPath : file.newPath), ref, progress);
    }
    const packagePath = dirname(line.side === 'old' ? file.oldPath : file.newPath);
    const result = await workerRPC('findImplementations', {
      origin: location.origin,
      project: context.project,
      ref,
      interfaceDefinition: definition,
      pageSize: 25,
      cursor,
      ...(relatedResultScope(restored, packagePath) ? { scope: relatedResultScope(restored, packagePath) } : {}),
    });
    return { ...result, request: { kind: 'implementations', target, definition, ref } };
  }

  function ensureUI() {
    if (state.ui?.isConnected) return state.ui.shadowRoot;
    const host = document.createElement('div');
    host.id = 'golens-go-intelligence-root';
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        :host { all:initial; position:fixed; z-index:var(--golens-z-popover); inset:0; pointer-events:none; font:12px/1.45 var(--golens-font-sans); color-scheme:dark; }
        * { box-sizing:border-box; }
        .popover { position:fixed; display:none; width:min(460px,calc(100vw - 24px)); max-height:min(420px,calc(100vh - 24px)); overflow:hidden; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-lg); background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-lg); color:var(--golens-text-primary); pointer-events:auto; }
        .popover.show { display:grid; grid-template-rows:auto minmax(0,1fr); }
        .popover-header { display:grid; grid-template-columns:auto minmax(0,1fr) auto; gap:var(--golens-space-2); align-items:center; min-height:46px; padding:var(--golens-space-2) var(--golens-space-3); border-bottom:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); }
        .popover-heading { min-width:0; }
        .popover-title { overflow:hidden; color:var(--golens-text-primary); font-size:12px; font-weight:700; line-height:1.35; text-overflow:ellipsis; white-space:nowrap; }
        .location { overflow:hidden; margin-top:2px; color:var(--golens-text-muted); font:10px/1.3 var(--golens-font-mono); text-overflow:ellipsis; white-space:nowrap; }
        .popover-body { min-height:0; overflow:auto; padding:var(--golens-space-3); }
        .symbol-badge { display:inline-flex; min-width:20px; height:20px; align-items:center; justify-content:center; padding:0 var(--golens-space-1); border:1px solid currentColor; border-radius:var(--golens-radius-xs); background:color-mix(in srgb,currentColor 7%,transparent); font:700 9px/1 var(--golens-font-mono); letter-spacing:-.02em; }
        .symbol-interface,.symbol-interface-method { color:#c586c0; } .symbol-struct { color:#d7ba7d; } .symbol-function { color:#dcdcaa; } .symbol-method,.symbol-type { color:#4ec9b0; } .symbol-variable,.symbol-parameter,.symbol-field { color:#9cdcfe; } .symbol-constant { color:#4fc1ff; } .symbol-package { color:#fc9b6b; } .symbol-external { color:#3794ff; }
        .header-actions { display:flex; align-items:center; gap:2px; }
        .header-action { display:inline-flex; width:28px; height:28px; align-items:center; justify-content:center; padding:0; border:1px solid transparent; border-radius:var(--golens-radius-sm); background:transparent; color:var(--golens-text-secondary); cursor:pointer; transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),color var(--golens-motion-fast),transform var(--golens-motion-fast); }
        .header-action:hover { border-color:var(--golens-border-default); background:var(--golens-surface-hover); color:var(--golens-text-primary); } .header-action:active { background:var(--golens-surface-pressed); transform:translateY(1px); } .header-action:disabled { cursor:not-allowed; opacity:.45; } .header-action[hidden] { display:none; } .header-action svg { width:14px; height:14px; fill:none; stroke:currentColor; stroke-linecap:round; stroke-linejoin:round; stroke-width:1.75; }
        .copy-button .check-icon { display:none; } .copy-button[data-state="copied"] { border-color:var(--golens-success); background:var(--golens-success-soft); color:var(--golens-success); } .copy-button .copy-icon { display:block; } .copy-button[data-state="copied"] .copy-icon { display:none; } .copy-button[data-state="copied"] .check-icon { display:block; }
        .signature-block { margin:0 0 var(--golens-space-3); overflow:hidden; border:1px solid var(--golens-border-subtle); border-radius:var(--golens-radius-sm); background:var(--golens-surface-inset); } .signature-block[hidden] { display:none; }
        .signature { margin:0; padding:var(--golens-space-2) var(--golens-space-3); overflow-wrap:anywhere; color:#dcdcaa; font:600 11px/1.5 var(--golens-font-mono); white-space:pre-wrap; }
        .signature-toggle { width:100%; padding:var(--golens-space-2) var(--golens-space-3); border:0; border-top:1px solid var(--golens-border-subtle); background:var(--golens-surface-raised); color:var(--golens-info-hover); font:650 10px/1.4 var(--golens-font-sans); text-align:left; cursor:pointer; } .signature-toggle:hover { background:var(--golens-surface-hover); color:var(--golens-text-primary); } .signature-toggle:active { background:var(--golens-surface-pressed); } .signature-toggle:disabled { cursor:not-allowed; opacity:.45; } .signature-toggle[hidden] { display:none; }
        .docs:empty,.scope[hidden],.shortcut-hint[hidden] { display:none; }
        .docs { margin:0 0 var(--golens-space-3); color:var(--golens-text-secondary); line-height:1.5; white-space:pre-wrap; }
        .scope { margin:0 0 var(--golens-space-3); padding:6px 8px; border:1px solid var(--golens-border-subtle); border-radius:var(--golens-radius-xs); background:var(--golens-surface-inset); color:var(--golens-text-muted); font:10px/1.4 var(--golens-font-mono); }
        .choices { display:grid; gap:5px; }
        .choice { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:var(--golens-space-2); width:100%; min-height:40px; align-items:center; padding:var(--golens-space-2); border:1px solid var(--golens-border-subtle); border-radius:var(--golens-radius-sm); background:var(--golens-surface-raised); color:var(--golens-text-primary); text-align:left; cursor:pointer; transition:background-color var(--golens-motion-fast),border-color var(--golens-motion-fast),transform var(--golens-motion-fast); }
        .choice:hover { border-color:var(--golens-border-strong); background:var(--golens-surface-hover); } .choice:active { background:var(--golens-surface-pressed); transform:translateY(1px); } .choice:disabled { cursor:not-allowed; opacity:.45; } .choice:focus-visible,.header-action:focus-visible,.signature-toggle:focus-visible,summary:focus-visible { outline:2px solid var(--golens-focus-ring); outline-offset:1px; }
        .choice-copy { min-width:0; } .choice-heading { display:flex; min-width:0; align-items:center; gap:7px; }
        .choice-title { overflow:hidden; color:var(--golens-text-primary); font-weight:650; text-overflow:ellipsis; white-space:nowrap; }
        .choice-context { display:block; margin-top:2px; overflow:hidden; color:var(--golens-text-muted); font:10px/1.35 var(--golens-font-mono); text-overflow:ellipsis; white-space:nowrap; }
        .choice-doc { display:block; margin-top:3px; overflow:hidden; color:var(--golens-text-secondary); font-size:10px; text-overflow:ellipsis; white-space:nowrap; }
        .destination-icon { position:relative; display:inline-flex; width:22px; height:22px; flex:0 0 auto; align-items:center; justify-content:center; border-radius:4px; }
        .destination-icon svg { width:15px; height:15px; } .destination-in-diff { color:var(--golens-primary); } .destination-new-tab { color:var(--golens-info); }
        .choice:hover .destination-icon::after,.choice:focus-visible .destination-icon::after { position:absolute; z-index:2; right:-4px; bottom:calc(100% + 7px); width:max-content; max-width:180px; padding:var(--golens-space-1) var(--golens-space-2); border:1px solid var(--golens-border-strong); border-radius:var(--golens-radius-xs); background:var(--golens-surface-raised); box-shadow:var(--golens-shadow-sm); color:var(--golens-text-primary); content:attr(data-tooltip); font:10px/1.3 var(--golens-font-sans); pointer-events:none; }
        details { margin-top:var(--golens-space-1); } summary { padding:var(--golens-space-2) var(--golens-space-1); border-radius:var(--golens-radius-xs); color:var(--golens-text-secondary); cursor:pointer; } summary:hover { background:var(--golens-surface-hover); color:var(--golens-text-primary); } .test-double-choices { display:grid; gap:5px; margin-top:var(--golens-space-1); }
        .shortcut-hint { display:flex; align-items:center; gap:5px; margin:var(--golens-space-3) 0 0; color:var(--golens-text-muted); font-size:10px; } kbd { display:inline-flex; min-width:17px; min-height:17px; align-items:center; justify-content:center; padding:1px 3px; border:1px solid var(--golens-border-strong); border-bottom-width:2px; border-radius:var(--golens-radius-xs); background:var(--golens-surface-inset); color:var(--golens-text-primary); font:700 9px/1 var(--golens-font-mono); }
        .loading-progress { display:grid; gap:var(--golens-space-2); margin:0 0 var(--golens-space-3); padding:var(--golens-space-2) var(--golens-space-3); border:1px solid color-mix(in srgb,var(--golens-primary) 35%,var(--golens-border-subtle)); border-radius:var(--golens-radius-sm); background:var(--golens-primary-soft); } .loading-progress[hidden] { display:none; } .loading-progress-meta { display:flex; justify-content:space-between; gap:var(--golens-space-2); color:var(--golens-text-primary); font-size:10px; } .loading-progress-phase { overflow:hidden; font-weight:700; text-overflow:ellipsis; white-space:nowrap; } .loading-progress-count { flex:0 0 auto; color:var(--golens-primary-hover); font:700 10px/1.45 var(--golens-font-mono); font-variant-numeric:tabular-nums; } .loading-track { height:4px; overflow:hidden; border-radius:999px; background:var(--golens-surface-pressed); } .loading-track > i { display:block; width:0; height:100%; border-radius:inherit; background:var(--golens-primary); transition:width var(--golens-motion-base); }
        .toast { position:fixed; right:18px; bottom:18px; display:none; max-width:360px; padding:var(--golens-space-2) var(--golens-space-3); border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-md); background:var(--golens-surface-raised); color:var(--golens-text-primary); box-shadow:var(--golens-shadow-md); } .toast.show { display:block; }
        .full-search-backdrop { position:fixed; inset:0; display:grid; place-items:center; padding:20px; background:rgba(0,0,0,.58); pointer-events:auto; } .full-search-backdrop[hidden] { display:none; }
        .full-search-dialog { width:min(480px,100%); padding:var(--golens-space-4); border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-lg); background:var(--golens-surface-panel); box-shadow:var(--golens-shadow-lg); }
        .full-search-header { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--golens-space-3); } .full-search-title { margin:0; font-size:15px; } .full-search-copy { margin:8px 0 14px; color:var(--golens-text-secondary); }
        .full-search-actions { display:flex; justify-content:flex-end; gap:8px; margin-top:14px; } .full-search-actions button,.full-search-chip { padding:7px 10px; border:1px solid var(--golens-border-default); border-radius:var(--golens-radius-sm); background:var(--golens-surface-raised); color:var(--golens-text-primary); cursor:pointer; }
        .full-search-chip { position:fixed; right:18px; bottom:18px; pointer-events:auto; } .full-search-chip[hidden] { display:none; }
        @media (prefers-reduced-motion:reduce) { .header-action,.choice,.loading-track > i { transition:none; } .header-action:active,.choice:active { transform:none; } }
      </style>
      <section class="popover" role="tooltip" aria-labelledby="golens-popover-title">
        <header class="popover-header"><span class="symbol-badge symbol-external" role="img" aria-label="Go symbol" title="Go symbol">Go</span><div class="popover-heading"><div id="golens-popover-title" class="popover-title"></div><div class="location"></div></div><div class="header-actions"><button class="header-action copy-button" type="button" aria-label="Copy source location" title="Copy source location" hidden><svg class="copy-icon" viewBox="0 0 16 16" aria-hidden="true"><rect x="5.25" y="5.25" width="8" height="8" rx="1.25"/><path d="M10.75 5.25V3.5c0-.7-.55-1.25-1.25-1.25h-6c-.7 0-1.25.55-1.25 1.25v6c0 .7.55 1.25 1.25 1.25h1.75"/></svg><svg class="check-icon" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8.25 3.15 3.15L13 4.6"/></svg></button><button class="header-action close-button" type="button" aria-label="Close Go insight" title="Close" hidden><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3l10 10M13 3 3 13"/></svg></button></div></header>
        <div class="popover-body"><div class="loading-progress" hidden role="status" aria-live="polite"><div class="loading-progress-meta"><span class="loading-progress-phase"></span><span class="loading-progress-count"></span></div><div class="loading-track" role="progressbar" aria-label="Go intelligence loading progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div></div><div class="signature-block" hidden><pre id="golens-go-signature" class="signature"></pre><button class="signature-toggle" type="button" aria-controls="golens-go-signature" aria-expanded="false" hidden>Show full signature</button></div><div class="docs"></div><div class="scope" hidden></div><div class="choices"></div><div class="shortcut-hint"><kbd>⌘</kbd><span>or Ctrl + click to go to definition</span></div></div>
      </section>
      <div class="full-search-backdrop" hidden><section class="full-search-dialog" role="dialog" aria-modal="true" aria-labelledby="golens-full-search-title"><div class="full-search-header"><div><h2 id="golens-full-search-title" class="full-search-title">Search complete project</h2><p class="full-search-copy">Caching every Go source at this commit makes absence results conclusive.</p></div><button class="header-action full-search-minimize" type="button" aria-label="Minimize full-project search">−</button></div><div class="loading-progress full-search-progress" role="status" aria-live="polite"><div class="loading-progress-meta"><span class="loading-progress-phase">Preparing project</span><span class="loading-progress-count">0%</span></div><div class="loading-track" role="progressbar" aria-label="Full-project search progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><i></i></div></div><div class="full-search-actions"><button class="full-search-retry" type="button" hidden>Retry</button><button class="full-search-dismiss" type="button">Minimize</button></div></section></div>
      <button class="full-search-chip" type="button" hidden>Project search · 0%</button>
      <div class="toast" role="status"></div>
    `;
    document.body.append(host);
    state.ui = host;
    const popover = shadow.querySelector('.popover');
    popover.addEventListener('pointerenter', () => pinPopover());
    popover.addEventListener('pointerdown', () => pinPopover());
    popover.addEventListener('focusin', () => pinPopover());
    popover.addEventListener('keydown', onKeyDown);
    popover.querySelector('.copy-button').addEventListener('click', (event) => copySourceLocation(event.currentTarget));
    popover.querySelector('.close-button').addEventListener('click', hidePopover);
    shadow.querySelector('.full-search-minimize').addEventListener('click', minimizeFullSearch);
    shadow.querySelector('.full-search-dismiss').addEventListener('click', minimizeFullSearch);
    shadow.querySelector('.full-search-chip').addEventListener('click', restoreFullSearch);
    shadow.querySelector('.full-search-retry').addEventListener('click', runFullSearch);
    return shadow;
  }

  function sourceLocationText(sourceLocation) {
    if (!sourceLocation?.path || !Number.isInteger(sourceLocation.line) || !Number.isInteger(sourceLocation.character)) return '';
    if (sourceLocation.line < 1 || sourceLocation.character < 1) return '';
    return `${sourceLocation.path}:${sourceLocation.line}:${sourceLocation.character}`;
  }

  function sourceLocationForTarget(target) {
    if (!target?.cell || !Number.isInteger(target.character)) return null;
    const file = fileContextFor(target.cell);
    const line = lineContextFor(target.cell);
    if (!file || !line) return null;
    return {
      path: line.side === 'old' ? file.oldPath : file.newPath,
      line: line.line,
      character: target.character + 1,
    };
  }

  function configureSourceCopy(button, sourceLocation = null) {
    const text = sourceLocationText(sourceLocation);
    button.hidden = !text;
    button.dataset.copyText = text;
    button.dataset.state = 'idle';
    button.setAttribute('aria-label', text ? `Copy source location ${text}` : 'Copy source location');
    button.title = text ? `Copy ${text}` : 'Copy source location';
  }

  function fallbackCopyText(text) {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none;';
    document.body.append(textarea);
    textarea.select();
    const copied = document.execCommand?.('copy') === true;
    textarea.remove();
    if (!copied) throw new Error('Clipboard access is unavailable.');
  }

  async function writeClipboardText(text) {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable.');
      await navigator.clipboard.writeText(text);
    } catch {
      fallbackCopyText(text);
    }
  }

  async function copySourceLocation(button) {
    const text = button.dataset.copyText;
    if (!text) return;
    try {
      await writeClipboardText(text);
      button.dataset.state = 'copied';
      button.setAttribute('aria-label', `Copied source location ${text}`);
      button.title = `Copied ${text}`;
      toast(`Copied ${text}`);
      setTimeout(() => {
        if (button.dataset.copyText !== text) return;
        button.dataset.state = 'idle';
        button.setAttribute('aria-label', `Copy source location ${text}`);
        button.title = `Copy ${text}`;
      }, 1800);
    } catch {
      toast('Could not copy the source location.');
    }
  }

  function positionPopover(popover, x, y) {
    const margin = 12;
    const gap = 12;
    const bounds = popover.getBoundingClientRect();
    const width = bounds.width || Math.min(460, innerWidth - margin * 2);
    const height = bounds.height || Math.min(420, innerHeight - margin * 2);
    const left = Math.max(margin, Math.min(x + gap, innerWidth - width - margin));
    const below = y + 18;
    const top = below + height <= innerHeight - margin
      ? below
      : Math.max(margin, y - height - gap);
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;
  }

  function destinationLineForDefinition(definition) {
    return definition.documentationLine || definition.line;
  }

  function visibleDiffRootForDefinition(definition) {
    const matchingRoots = [...document.querySelectorAll('diff-file, .diff-file, [data-testid="diff-file"], [data-testid="rd-diff-file"], [data-file-path]')];
    return matchingRoots.find((candidate) => {
      const data = rapidFileData(candidate);
      const visiblePath = candidate.getAttribute('data-file-path')
        || data.new_path
        || data.old_path
        || candidate.querySelector('[data-testid="file-title"], .file-title-name, .rd-diff-file-link')?.textContent
        || '';
      return normalizePath(visiblePath) === definition.path;
    });
  }

  function definitionDestination(definition) {
    return visibleDiffRootForDefinition(definition)
      ? { kind: 'inDiff', label: 'Jump in this MR diff' }
      : { kind: 'newTab', label: 'Open in a new tab' };
  }

  async function openDefinition(definition) {
    const destinationLine = destinationLineForDefinition(definition);
    const root = visibleDiffRootForDefinition(definition);
    if (root) {
      const line = await revealLine(root, destinationLine);
      const target = line?.closest('tr, [role="row"]') || root;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.animate?.([{ outline: '2px solid #fc6d26' }, { outline: '2px solid transparent' }], { duration: 1600 });
      return;
    }
    const context = projectContext();
    const url = `${context.projectBase}/-/blob/${encodeURIComponent(definition.ref)}/${definition.path.split('/').map(encodeURIComponent).join('/')}#L${destinationLine}`;
    window.open(url, '_blank', 'noopener');
  }

  function symbolPresentation(kind) {
    return SYMBOL_PRESENTATIONS[kind] || SYMBOL_PRESENTATIONS.external;
  }

  function applySymbolBadge(element, kind) {
    const presentation = symbolPresentation(kind);
    element.className = `symbol-badge symbol-${presentation.className}`;
    element.textContent = presentation.badge;
    element.setAttribute('aria-label', presentation.label);
    element.title = presentation.label;
    return element;
  }

  function createSymbolBadge(kind) {
    const badge = document.createElement('span');
    badge.setAttribute('role', 'img');
    return applySymbolBadge(badge, kind);
  }

  function renderSignature(popover, definition = null) {
    const block = popover.querySelector('.signature-block');
    const signature = block.querySelector('.signature');
    const toggle = block.querySelector('.signature-toggle');
    const full = definition?.signature || '';
    const compact = definition?.compactSignature || '';
    block.hidden = !full;
    signature.textContent = compact || full;
    signature.title = compact ? full : '';
    toggle.hidden = !compact;
    toggle.textContent = 'Show full signature';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.onclick = compact ? () => {
      const expanded = toggle.getAttribute('aria-expanded') === 'true';
      signature.textContent = expanded ? compact : full;
      signature.title = expanded ? full : '';
      toggle.textContent = expanded ? 'Show full signature' : 'Collapse signature';
      toggle.setAttribute('aria-expanded', String(!expanded));
    } : null;
  }

  function destinationIcon(destination) {
    const icon = document.createElement('span');
    icon.className = `destination-icon destination-${destination.kind === 'inDiff' ? 'in-diff' : 'new-tab'}`;
    icon.dataset.tooltip = destination.label;
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', destination.label);
    icon.title = destination.label;
    icon.innerHTML = destination.kind === 'inDiff'
      ? '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2 2h2v6a3 3 0 0 0 3 3h4.2L9 8.8 10.4 7 15 11.5 10.4 16 9 14.2l2.2-2.2H7a4 4 0 0 1-4-4V2z"/></svg>'
      : '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M9 2h5v5h-2V5.4L7.7 9.7 6.3 8.3 10.6 4H9V2z"/><path fill="currentColor" d="M3 3h4v2H4v7h7V9h2v5H2V3h1z"/></svg>';
    return icon;
  }

  function choiceButton({ title, fullTitle = title, context = '', documentation = '', kind = '', definition = null, externalURL = '' }) {
    const destination = definition ? definitionDestination(definition) : { kind: 'newTab', label: 'Open in a new tab' };
    const button = document.createElement('button');
    const copy = document.createElement('span');
    const heading = document.createElement('span');
    const titleElement = document.createElement('span');
    button.type = 'button';
    button.className = 'choice';
    button.setAttribute('aria-label', `${fullTitle}. ${destination.label}`);
    copy.className = 'choice-copy';
    heading.className = 'choice-heading';
    titleElement.className = 'choice-title';
    titleElement.textContent = title;
    if (fullTitle !== title) titleElement.title = fullTitle;
    if (kind) heading.append(createSymbolBadge(kind));
    heading.append(titleElement);
    copy.append(heading);
    if (context) {
      const contextElement = document.createElement('span');
      contextElement.className = 'choice-context';
      contextElement.textContent = context;
      contextElement.title = context;
      copy.append(contextElement);
    }
    if (documentation) {
      const docs = document.createElement('span');
      docs.className = 'choice-doc';
      docs.textContent = documentation;
      docs.title = documentation;
      copy.append(docs);
    }
    button.append(copy, destinationIcon(destination));
    button.addEventListener('click', () => {
      hidePopover();
      if (definition) openDefinition(definition);
      else if (externalURL) window.open(externalURL, '_blank', 'noopener');
    });
    return button;
  }

  function implementationGroups(result) {
    const candidates = result.status === 'implementations' ? result.candidates : [];
    return {
      production: candidates.filter((candidate) => !candidate.isTestDouble),
      testDoubles: candidates.filter((candidate) => candidate.isTestDouble),
    };
  }

  function implementationButton(candidate) {
    const confidence = candidate.confidence === 'asserted' ? 'Explicit assertion' : 'Structural match';
    return choiceButton({
      title: candidate.displayName,
      context: `${candidate.path}:${candidate.documentationLine || candidate.line} · ${confidence}`,
      documentation: candidate.documentation?.split('\n')[0] || '',
      kind: candidate.kind || 'type',
      definition: candidate,
    });
  }

  function resultScopeText(scope) {
    if (!scope) return '';
    if (scope.kind === 'fullProject') return `Full project · ${scope.packageCount} indexed package${scope.packageCount === 1 ? '' : 's'} · complete coverage`;
    if (scope.kind === 'indexedPackages') return `${scope.packageCount} indexed package${scope.packageCount === 1 ? '' : 's'} · search coverage is incomplete`;
    return `Current package${scope.packagePath ? ` · ${scope.packagePath || '.'}` : ''}`;
  }

  function absenceText(scope) {
    if (scope?.kind === 'fullProject' && scope.complete) return 'Full project searched; no result exists.';
    if (scope?.kind === 'indexedPackages') return `Not found in ${scope.packageCount} indexed packages. Search coverage is incomplete.`;
    return 'Not found in current package.';
  }

  function resultAction(label, listener) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'choice';
    button.textContent = label;
    button.addEventListener('click', listener);
    return button;
  }

  function updateFullSearchProgress(message, progress = null) {
    const shadow = ensureUI();
    const panel = shadow.querySelector('.full-search-progress');
    const percentage = progress?.percentage ?? 0;
    panel.querySelector('.loading-progress-phase').textContent = message || 'Preparing project';
    panel.querySelector('.loading-progress-count').textContent = `${percentage}%`;
    panel.querySelector('.loading-track').setAttribute('aria-valuenow', String(percentage));
    panel.querySelector('.loading-track i').style.width = `${percentage}%`;
    shadow.querySelector('.full-search-chip').textContent = `Project search · ${percentage}%`;
  }

  function minimizeFullSearch() {
    if (!state.fullSearch) return;
    const shadow = ensureUI();
    shadow.querySelector('.full-search-backdrop').hidden = true;
    const chip = shadow.querySelector('.full-search-chip');
    chip.hidden = false;
    chip.focus();
  }

  function restoreFullSearch() {
    if (!state.fullSearch) return;
    const shadow = ensureUI();
    shadow.querySelector('.full-search-chip').hidden = true;
    shadow.querySelector('.full-search-backdrop').hidden = false;
    shadow.querySelector(state.fullSearch.status === 'error' ? '.full-search-retry' : '.full-search-minimize').focus();
  }

  async function rerunFullSearchQuery(search) {
    if (search.result.request.kind === 'references') {
      return findReferencesAt(search.result.request.target, search.result.request.definition);
    }
    return findImplementationsAt(search.result.request.target, search.result.request.definition);
  }

  async function runFullSearch() {
    const search = state.fullSearch;
    if (!search || search.status === 'busy') return;
    const shadow = ensureUI();
    search.status = 'busy';
    shadow.querySelector('.full-search-retry').hidden = true;
    updateFullSearchProgress('Preparing complete project search');
    try {
      await preloadFullProject(updateFullSearchProgress, search.result.request.ref);
      if (state.fullSearch !== search || !state.enabled) return;
      updateFullSearchProgress('Refreshing semantic result', { percentage: 100 });
      const refreshed = await rerunFullSearchQuery(search);
      if (state.fullSearch !== search || !state.enabled) return;
      state.fullSearch = null;
      shadow.querySelector('.full-search-backdrop').hidden = true;
      shadow.querySelector('.full-search-chip').hidden = true;
      showResult(refreshed, search.pointer);
      pinPopover(search.pointer);
    } catch (error) {
      if (state.fullSearch !== search) return;
      search.status = 'error';
      updateFullSearchProgress(error.message || 'Full-project search failed');
      shadow.querySelector('.full-search-retry').hidden = false;
      restoreFullSearch();
    }
  }

  function openFullSearch(result, pointer) {
    if (!result.request?.ref) return;
    state.fullSearch = { result, pointer, status: 'idle' };
    hidePopover();
    restoreFullSearch();
    runFullSearch();
  }

  async function loadMoreResults(result, pointer, button) {
    button.disabled = true;
    button.textContent = 'Loading more…';
    try {
      const page = result.request.kind === 'references'
        ? await findReferencesAt(result.request.target, result.request.definition, result.nextCursor)
        : await findImplementationsAt(result.request.target, result.request.definition, undefined, result.nextCursor);
      const key = result.request.kind === 'references' ? 'locations' : 'candidates';
      showResult({ ...page, [key]: [...result[key], ...page[key]], request: result.request }, pointer);
      pinPopover(pointer);
    } catch (error) {
      button.disabled = false;
      button.textContent = 'Show more';
      toast(error.message || 'Unable to load more semantic results.');
    }
  }

  function showResult(result, pointer) {
    const shadow = ensureUI();
    const popover = shadow.querySelector('.popover');
    const wasPinned = state.pinnedPopover;
    const loadingProgress = popover.querySelector('.loading-progress');
    const badge = popover.querySelector('.popover-header .symbol-badge');
    const title = popover.querySelector('.popover-title');
    const docs = popover.querySelector('.docs');
    const scope = popover.querySelector('.scope');
    const choices = popover.querySelector('.choices');
    const location = popover.querySelector('.location');
    const copyButton = popover.querySelector('.copy-button');
    const shortcut = popover.querySelector('.shortcut-hint');
    const shortcutHint = shortcut.querySelector('span');
    loadingProgress.hidden = true;
    popover.removeAttribute('aria-busy');
    renderSignature(popover);
    docs.textContent = '';
    scope.textContent = resultScopeText(result.scope);
    scope.hidden = !scope.textContent;
    location.textContent = '';
    configureSourceCopy(copyButton, sourceLocationForTarget(pointer));
    choices.replaceChildren();
    shortcut.hidden = true;
    let shouldPin = false;
    const setHeader = (kind, heading, sourceLocation = '') => {
      applySymbolBadge(badge, kind);
      title.textContent = heading;
      location.textContent = sourceLocation;
      location.title = sourceLocation;
    };
    const setShortcut = (text) => {
      shortcutHint.textContent = text;
      shortcut.hidden = !text;
    };
    if (result.status === 'resolved') {
      setHeader(result.definition.kind, result.definition.name, `${result.definition.path}:${result.definition.line}`);
      renderSignature(popover, result.definition);
      docs.textContent = result.definition.documentation || '';
      if (!result.isDefinition) {
        choices.append(choiceButton({
          title: 'Go to definition',
          context: `${result.definition.path}:${destinationLineForDefinition(result.definition)}`,
          definition: result.definition,
        }));
      }
      setShortcut(result.isDefinition && result.definition.kind === 'interface'
        ? 'or Ctrl + click to find implementations'
        : result.isDefinition ? 'or Ctrl + click to find usages' : 'or Ctrl + click to go to definition');
    } else if (result.status === 'standardLibrary' || result.status === 'packageDocumentation') {
      const url = documentationURL(result);
      setHeader('external', result.symbol, result.importPath);
      renderSignature(popover, { signature: `${result.importPath}.${result.symbol}` });
      docs.textContent = 'Documentation is available on pkg.go.dev.';
      choices.append(choiceButton({ title: 'Open on pkg.go.dev', context: url, externalURL: url }));
      setShortcut('or Ctrl + click to open package documentation');
    } else if (result.status === 'projectPackage') {
      const url = projectPackageURL(result);
      setHeader('package', result.symbol, result.importPath);
      renderSignature(popover, { signature: `package ${result.symbol}` });
      docs.textContent = url
        ? 'Open this package directory at the merge request commit.'
        : 'The package directory is unavailable because the merge request commit could not be verified.';
      if (url) choices.append(choiceButton({
        title: 'Open package directory',
        context: `${result.packagePath || '.'} · ${result.ref.slice(0, 12)}`,
        externalURL: url,
      }));
      setShortcut(url ? 'or Ctrl + click to choose this package directory' : '');
    } else if (result.status === 'builtin') {
      const url = documentationURL(result);
      setHeader('builtin', result.symbol, 'Go builtin');
      renderSignature(popover, { signature: `builtin ${result.symbol}` });
      docs.textContent = 'Documentation is available on pkg.go.dev.';
      choices.append(choiceButton({ title: 'Open on pkg.go.dev', context: url, externalURL: url }));
      setShortcut('or Ctrl + click to open builtin documentation');
    } else if (result.status === 'ambiguous') {
      setHeader('external', result.symbol, `${result.definitions.length} definitions`);
      docs.textContent = result.reason === 'receiverOrSelector'
        ? 'Ambiguous receiver or selector. Choose only when the intended definition is clear.'
        : 'Multiple definitions match. Choose the definition you want to open.';
      result.definitions.forEach((definition) => {
        choices.append(choiceButton({
          title: definition.compactSignature || definition.signature,
          fullTitle: definition.signature,
          context: `${definition.receiver ? `${definition.receiver} · ` : ''}${definition.path}:${definition.line}`,
          kind: definition.kind,
          definition,
        }));
      });
      shouldPin = result.definitions.length > 0;
    } else if (result.status === 'references') {
      const count = `${result.locations.length}${result.hasMore ? '+' : ''}`;
      setHeader(result.definition.kind, `Usages of ${result.definition.name}`, `${result.definition.path}:${result.definition.line}`);
      renderSignature(popover, result.definition);
      docs.textContent = result.locations.length
        ? `${count} usage${result.locations.length === 1 && !result.hasMore ? '' : 's'} in the current search scope.`
        : absenceText(result.scope);
      result.locations.forEach((reference) => {
        choices.append(choiceButton({
          title: reference.path.split('/').pop(),
          context: `${reference.path}:${reference.line}`,
          definition: reference,
        }));
      });
      if (result.hasMore) choices.append(resultAction('Show more', (event) => loadMoreResults(result, pointer, event.currentTarget)));
      shouldPin = result.locations.length > 1;
    } else if (result.status === 'implementations') {
      const groups = implementationGroups(result);
      setHeader('interface', `Implementations of ${result.interfaceDefinition.name}`, `${result.methodCount} required method${result.methodCount === 1 ? '' : 's'}`);
      renderSignature(popover, result.interfaceDefinition);
      docs.textContent = result.candidates.length
        ? `${groups.production.length} production implementation${groups.production.length === 1 ? '' : 's'}${groups.testDoubles.length ? ` and ${groups.testDoubles.length} test double${groups.testDoubles.length === 1 ? '' : 's'}` : ''}.`
        : absenceText(result.scope);
      groups.production.forEach((candidate) => choices.append(implementationButton(candidate)));
      if (groups.testDoubles.length) {
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        const group = document.createElement('div');
        group.className = 'test-double-choices';
        summary.textContent = `Test doubles (${groups.testDoubles.length})`;
        groups.testDoubles.forEach((candidate) => group.append(implementationButton(candidate)));
        details.append(summary, group);
        choices.append(details);
      }
      if (result.hasMore) choices.append(resultAction('Show more', (event) => loadMoreResults(result, pointer, event.currentTarget)));
      shouldPin = result.candidates.length > 0;
    } else if (result.status === 'unsupportedImplementations') {
      setHeader('interface', `Implementations of ${result.interfaceDefinition.name}`);
      renderSignature(popover, result.interfaceDefinition);
      docs.textContent = result.reason === 'buildConstraint'
        ? 'Unsupported build constraint: GoLens cannot safely choose a platform-specific implementation set.'
        : result.reason === 'typeSetConstraint'
        ? 'This interface contains a type-set constraint, which the structural finder cannot evaluate safely.'
        : 'This interface embeds a type that cannot be resolved inside the project.';
    } else if (result.status === 'notFound') {
      setHeader('external', result.symbol || 'Not found');
      docs.textContent = absenceText(result.scope);
    } else if (result.status === 'unsupported') {
      setHeader('external', result.symbol || 'Unsupported');
      docs.textContent = result.reason === 'buildConstraint'
        ? 'Unsupported build constraint: GoLens cannot safely select the active declaration.'
        : 'This semantic relationship is unsupported.';
    } else return false;
    if (result.request && result.scope?.kind !== 'fullProject' && !result.scope?.complete
      && !['buildConstraint', 'typeSetConstraint'].includes(result.reason)) {
      choices.append(resultAction('Search complete project', () => openFullSearch(result, pointer)));
      shouldPin = true;
    }
    popover.classList.add('show');
    positionPopover(popover, pointer.x, pointer.y);
    if (shouldPin || wasPinned) pinPopover(pointer);
    else setPopoverMode('passive', pointer);
    return true;
  }

  function loadingPhaseLabel(phase) {
    if (phase === 'discovering') return 'Preparing package';
    if (phase === 'indexing') return 'Indexing symbols';
    return 'Loading source files';
  }

  function showLoading(message, pointer, progress) {
    const shadow = ensureUI();
    const popover = shadow.querySelector('.popover');
    const wasPinned = state.pinnedPopover;
    const loadingProgress = popover.querySelector('.loading-progress');
    const loadingPhase = loadingProgress.querySelector('.loading-progress-phase');
    const loadingCount = loadingProgress.querySelector('.loading-progress-count');
    const loadingTrack = loadingProgress.querySelector('.loading-track');
    const badge = popover.querySelector('.popover-header .symbol-badge');
    const title = popover.querySelector('.popover-title');
    const docs = popover.querySelector('.docs');
    const choices = popover.querySelector('.choices');
    const location = popover.querySelector('.location');
    const copyButton = popover.querySelector('.copy-button');
    const shortcutHint = popover.querySelector('.shortcut-hint');
    if (progress) {
      loadingProgress.hidden = false;
      loadingPhase.textContent = loadingPhaseLabel(progress.phase);
      loadingCount.textContent = progress.phase === 'discovering'
        ? '0%'
        : `${progress.percentage}% · ${progress.completed} / ${progress.total} files`;
      loadingTrack.setAttribute('aria-valuenow', String(progress.percentage));
      loadingTrack.querySelector('i').style.width = `${progress.percentage}%`;
    } else {
      loadingProgress.hidden = true;
    }
    applySymbolBadge(badge, 'external');
    title.textContent = message;
    renderSignature(popover);
    docs.textContent = '';
    choices.replaceChildren();
    location.textContent = '';
    configureSourceCopy(copyButton, sourceLocationForTarget(pointer));
    shortcutHint.hidden = true;
    popover.setAttribute('aria-busy', 'true');
    popover.classList.add('show');
    positionPopover(popover, pointer.x, pointer.y);
    if (wasPinned) pinPopover(pointer);
    else setPopoverMode('passive', pointer);
  }

  function targetKey(target) {
    if (!target) return '';
    return `${target.cell ? fileContextFor(target.cell)?.path : ''}:${target.cell ? lineContextFor(target.cell)?.line : ''}:${target.character ?? ''}`;
  }

  function cancelPopoverDismissal() {
    clearTimeout(state.popoverDismissTimer);
    state.popoverDismissTimer = null;
  }

  function setPopoverMode(mode, target = null) {
    cancelPopoverDismissal();
    const popover = state.ui?.shadowRoot.querySelector('.popover');
    const key = targetKey(target);
    if (key) state.popoverTargetKey = key;
    state.popoverMode = mode;
    state.pinnedPopover = mode === 'pinned';
    if (state.pinnedPopover) state.pinnedTargetKey = key || state.popoverTargetKey;
    else state.pinnedTargetKey = '';
    if (!popover) return;
    popover.dataset.mode = mode;
    popover.setAttribute('role', state.pinnedPopover ? 'dialog' : 'tooltip');
    if (state.pinnedPopover) popover.setAttribute('aria-modal', 'false');
    else popover.removeAttribute('aria-modal');
    popover.querySelector('.close-button').hidden = !state.pinnedPopover;
  }

  function clearPinnedPopover() {
    if (state.popoverMode === 'hidden') {
      cancelPopoverDismissal();
      state.pinnedPopover = false;
      state.pinnedTargetKey = '';
      return;
    }
    setPopoverMode('passive');
  }

  function pinPopover(target = null) {
    const popover = state.ui?.shadowRoot.querySelector('.popover');
    if (!popover?.classList.contains('show')) return;
    setPopoverMode('pinned', target);
  }

  function schedulePassivePopoverDismissal() {
    if (state.popoverMode !== 'passive' || state.popoverDismissTimer) return false;
    state.popoverDismissTimer = setTimeout(hidePopover, POPOVER_DISMISS_DELAY);
    return true;
  }

  function hidePopover() {
    cancelPopoverDismissal();
    state.popoverMode = 'hidden';
    state.popoverTargetKey = '';
    state.pinnedPopover = false;
    state.pinnedTargetKey = '';
    const popover = state.ui?.shadowRoot.querySelector('.popover');
    popover?.classList.remove('show');
    if (popover) {
      popover.dataset.mode = 'hidden';
      popover.setAttribute('role', 'tooltip');
      popover.removeAttribute('aria-modal');
      popover.querySelector('.close-button').hidden = true;
    }
  }

  function toast(message) {
    const element = ensureUI().querySelector('.toast');
    element.textContent = message;
    element.classList.add('show');
    setTimeout(() => element.classList.remove('show'), 2600);
  }

  function targetAtEvent(event) {
    const cell = codeCellFor(event.target);
    if (!cell || !fileContextFor(cell)) return null;
    const caret = caretAtPoint(cell, event.clientX, event.clientY) || identifierFromElement(event.target, cell);
    return caret ? { ...caret, cell, x: event.clientX, y: event.clientY } : null;
  }

  function markTarget(element) {
    if (state.activeElement === element) return;
    state.activeElement?.removeAttribute('data-golens-go-target');
    state.activeElement = element || null;
    state.activeElement?.setAttribute('data-golens-go-target', '');
  }

  function onMouseMove(event) {
    if (!state.enabled) return;
    if (state.ui && event.composedPath().includes(state.ui)) {
      pinPopover();
      return;
    }
    if (state.pinnedPopover) return;
    const target = targetAtEvent(event);
    const key = targetKey(target);
    if (key === state.activeTarget?.key) {
      cancelPopoverDismissal();
      return;
    }
    clearTimeout(state.hoverTimer);
    if (!target) {
      state.activeTarget = null;
      markTarget(null);
      schedulePassivePopoverDismissal();
      return;
    }
    cancelPopoverDismissal();
    hidePopover();
    state.activeTarget = { key, ...target };
    markTarget(target.element);
    state.hoverTimer = setTimeout(async () => {
      try {
        if (state.activeTarget?.key !== key) return;
        showLoading(`Looking up ${target.identifier}…`, target);
        const result = await resolveAt(target, 'resolveHover', (message, progress) => {
          if (state.activeTarget?.key === key) showLoading(message, target, progress);
        });
        let displayResult = result;
        if (shouldShowReferencesOnHover(result)) {
          showLoading(`Finding usages of ${target.identifier}…`, target);
          displayResult = await findReferencesAt(target, result.definition);
        }
        if (state.activeTarget?.key === key) showResult(displayResult, target);
      } catch (error) {
        if (state.activeTarget?.key === key) hidePopover();
        const message = error.message || 'Go intelligence is unavailable.';
        if (state.lastErrorToast !== message) {
          state.lastErrorToast = message;
          toast(message);
        }
      }
    }, 350);
  }

  function onKeyDown(event) {
    if (event.key !== 'Escape') return;
    const fullSearchOpen = state.ui && !state.ui.shadowRoot.querySelector('.full-search-backdrop').hidden;
    if (fullSearchOpen) {
      event.preventDefault();
      event.stopPropagation();
      minimizeFullSearch();
      return;
    }
    if (state.popoverMode === 'hidden') return;
    event.preventDefault();
    event.stopPropagation();
    hidePopover();
  }

  function eventIsInsideUI(event) {
    return Boolean(state.ui && event.composedPath().includes(state.ui));
  }

  function dismissPinnedPopoverFromOutside(event) {
    if (!state.pinnedPopover || eventIsInsideUI(event)) return false;
    hidePopover();
    return true;
  }

  async function onClick(event) {
    if (!state.enabled || event.button !== 0) return;
    if (eventIsInsideUI(event)) return;
    if (!(event.metaKey || event.ctrlKey)) {
      dismissPinnedPopoverFromOutside(event);
      return;
    }
    const target = targetAtEvent(event);
    if (!target) {
      if (codeCellFor(event.target)) toast('GoLens could not identify a Go symbol on this diff line.');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    hidePopover();
    try {
      showLoading(`Looking up ${target.identifier}…`, target);
      const result = await resolveAt(target, 'resolveDefinition', (message, progress) => showLoading(message, target, progress));
      if (isInterfaceDeclaration(result)) {
        const implementations = await findImplementationsAt(
          target,
          result.definition,
          (message) => showLoading(message, target),
        );
        showResult(implementations, target);
      }
      else if (result.status === 'resolved' && result.isDefinition) {
        showLoading(`Finding usages of ${target.identifier}…`, target);
        const references = await findReferencesAt(target, result.definition);
        if (referenceNavigationAction(references) === 'open') openDefinition(references.locations[0]);
        else showResult(references, target);
      }
      else if (result.status === 'resolved') openDefinition(result.definition);
      else if (result.status === 'projectPackage') {
        showResult(result, target);
        pinPopover(target);
      }
      else if (result.status === 'standardLibrary' || result.status === 'packageDocumentation' || result.status === 'builtin') window.open(documentationURL(result), '_blank', 'noopener');
      else if (['ambiguous', 'notFound', 'unsupported'].includes(result.status)) {
        showResult(result, target);
        pinPopover(target);
      }
      else toast('GoLens could not resolve this symbol safely.');
    } catch (error) {
      hidePopover();
      toast(error.message || 'Go intelligence is unavailable.');
    }
  }

  function init() {
    if (state.enabled || !/\/-\/merge_requests\/\d+/.test(location.pathname)) return;
    state.enabled = true;
    state.abortController = new AbortController();
    document.addEventListener('mousemove', onMouseMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('visibilitychange', refreshMergeRequestRefs, true);
    status('idle', 'Go intelligence · hover code to start');
  }

  function referenceNavigationAction(result) {
    return result.status === 'references' && result.locations.length === 1 && !result.hasMore ? 'open' : 'show';
  }

  function isInterfaceDeclaration(result) {
    return result.status === 'resolved' && result.isDefinition && result.definition.kind === 'interface';
  }

  function shouldShowReferencesOnHover(result) {
    return result.status === 'resolved' && result.isDefinition && result.definition?.kind !== 'interface';
  }

  function teardown() {
    state.enabled = false;
    state.abortController?.abort();
    state.abortController = null;
    clearTimeout(state.hoverTimer);
    clearPinnedPopover();
    markTarget(null);
    document.removeEventListener('mousemove', onMouseMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('visibilitychange', refreshMergeRequestRefs, true);
    const cancellation = new Error('Go intelligence request cancelled');
    for (const pending of state.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(cancellation);
    }
    state.pending.clear();
    state.port?.disconnect();
    state.port = null;
    state.packages.clear();
    state.projects.clear();
    state.projectProgressListeners.clear();
    state.modulePaths.clear();
    state.refsPromise = null;
    state.refsKey = '';
    state.refsFetchedAt = 0;
    state.fullSearch = null;
    state.ui?.remove();
    state.ui = null;
  }

  function refreshMergeRequestRefs() {
    if (document.visibilityState === 'visible') {
      clearMergeRequestRefs();
    }
  }

  globalThis.GoLensGoNavigation = {
    init,
    teardown,
    preloadMergeRequest,
    mergeRequestPreloadStatus,
    mergeRequestCelebrationStatus,
    mergeRequestDiscussionStatus,
    preloadFullProject,
    fullProjectPreloadStatus,
    invalidateCacheState,
    __test: { normalizePath, standardLibraryURL, packageDocumentationURL, documentationURL, projectPackageURL, parseBlobLink, lineFromAnchor, lineAnchorFor, expansionDirectionForLine, revealLine, identifierAtCharacter, caretElementMatchesIdentifier, fileContextFor, codeCellFor, lineContextFor, referenceNavigationAction, isInterfaceDeclaration, shouldShowReferencesOnHover, destinationLineForDefinition, definitionDestination, sourceLocationText, symbolPresentation, implementationGroups, resultScopeText, absenceText, isProjectGoPath, nextPageNumber, mergeSearchStatus, relatedReadyMessage, packageLoadingProgress, packageLoadingMessage, projectLoadingProgress, projectLoadingMessage, relatedLoadingProgress, relatedLoadingMessage, refsDisagreeWithFile, sourceRefFor, showLoading, showResult, pinPopover, schedulePassivePopoverDismissal, dismissPinnedPopoverFromOutside, hidePopover, onKeyDown },
  };
})();
