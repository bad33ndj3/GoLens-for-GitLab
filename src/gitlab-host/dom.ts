import { repositoryPath, sourceIdentity } from '../domain.ts';
import { HostContractError } from './repository.ts';
import { activeSurface, controlsSurface, fullFileSurface, type SurfaceIntent } from './surfaces.ts';
import type {
  ActionOutcome, ApplyOutcome, BoundGitLabHost, DiffTarget, HostAction, HostEvent, HostIntent, HostIntentCommand,
  HostProjection, HostRead, HostReadValue, HostRevision, HostTargetToken, ReadOutcome, ReviewDescriptor, ShortcutProjection,
} from './index.ts';

type ReviewResult = ReadOutcome<ReviewDescriptor>;
type Read = (query: HostRead, signal: AbortSignal) => Promise<ReadOutcome<HostReadValue>>;

class AsyncQueue<T> implements AsyncIterable<T> {
  #values: T[] = [];
  #waiting: { resolve(value: IteratorResult<T>): void; reject(error: unknown): void }[] = [];
  #closed = false;
  #error: unknown;
  push(value: T): void { const waiter = this.#waiting.shift(); if (waiter) waiter.resolve({ value, done: false }); else if (!this.#closed) this.#values.push(value); }
  close(): void { this.#closed = true; for (const waiter of this.#waiting.splice(0)) waiter.resolve({ value: undefined, done: true }); }
  fail(error: unknown): void { this.#error = error; this.#closed = true; for (const waiter of this.#waiting.splice(0)) waiter.reject(error); }
  [Symbol.asyncIterator](): AsyncIterator<T> { return { next: () => {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve({ value, done: false });
    if (this.#error) return Promise.reject(this.#error);
    if (this.#closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve, reject) => this.#waiting.push({ resolve, reject }));
  } }; }
}

function surface(window: Window): 'overview' | 'changes' | 'other' {
  if (/\/-\/merge_requests\/\d+\/diffs(?:\/|$)/.test(window.location.pathname)) return 'changes';
  if (/\/-\/merge_requests\/\d+(?:\/|$)/.test(window.location.pathname)) return 'overview';
  return 'other';
}

function reviewLocation(window: Window): { projectPath: string; mergeRequestIid: string } | null {
  if (!window.document.querySelector('meta[name="csrf-token"]') || !window.document.querySelector('.layout-page,.ai-panels,[data-testid="super-sidebar"]')) return null;
  const match = window.location.pathname.match(/^\/(.+?)\/-\/merge_requests\/(\d+)/);
  return match ? { projectPath: match[1]!, mergeRequestIid: match[2]! } : null;
}

function sameReview(left: ReviewDescriptor | null, right: ReviewDescriptor | null): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function golensMutation(mutation: MutationRecord): boolean {
  if (mutation.type === 'attributes') {
    const attr = mutation.attributeName || '';
    if (attr.startsWith('data-golens-')) return true;
    const target = mutation.target as Element;
    if (target?.tagName?.startsWith('GOLENS-') || target?.hasAttribute?.('data-golens-active-surface')) return true;
  }
  const nodes = [...mutation.addedNodes, ...mutation.removedNodes];
  return nodes.length > 0 && nodes.every((node) => node.nodeType === 1 && ((node as Element).tagName.startsWith('GOLENS-')
    || (node as Element).matches('[data-golens-status],[data-golens-full-file-control],[data-golens-active-surface]')
    || (node as Element).hasAttribute?.('data-golens-')
    || (node as Element).closest?.('golens-host-surface,golens-full-file-button,golens-bookmark-marker,[data-golens-active-surface]') !== null));
}

function fileRoots(document: Document): Element[] {
  return [...document.querySelectorAll('diff-file[data-file-data],diff-file[data-testid="rd-diff-file"],.diff-file.file-holder,[data-testid="diff-file"]')];
}

function normalizedPath(root: Element): string {
  try {
    const data = JSON.parse((root as HTMLElement).dataset.fileData || '{}') as Record<string, unknown>;
    const value = data.new_path || data.old_path;
    if (typeof value === 'string') return value.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().replace(/\s*\/\s*/g, '/');
  } catch { /* legacy DOM uses title text */ }
  const value = (root as HTMLElement).dataset.path || root.querySelector('[data-testid="file-title"],.file-title-name,.rd-diff-file-link')?.textContent || '';
  return value.replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '').trim().replace(/\s*\/\s*/g, '/');
}

function pathsForRoot(root: Element): { oldPath: string; newPath: string } {
  try {
    const data = JSON.parse((root as HTMLElement).dataset.fileData || '{}') as Record<string, unknown>;
    const fallback = normalizedPath(root);
    return {
      oldPath: typeof data.old_path === 'string' ? repositoryPath(data.old_path) : fallback,
      newPath: typeof data.new_path === 'string' ? repositoryPath(data.new_path) : fallback,
    };
  } catch {
    const path = normalizedPath(root);
    return { oldPath: path, newPath: path };
  }
}

function generated(root: Element, window: Window): boolean {
  return [...root.querySelectorAll('[data-testid="diff-file-warning"],.collapsed-file-warning,.rd-no-preview')].some((warning) => {
    if (!warning.textContent?.includes('.gitattributes')) return false;
    return [...warning.querySelectorAll('a[href]')].some((link) => {
      try {
        const url = new URL(link.getAttribute('href') || '', window.location.href);
        return url.hash === '#collapse-generated-files' && /\/help\/user\/project\/merge_requests\/changes/.test(url.pathname);
      } catch { return false; }
    });
  });
}

function rootForPath(document: Document, path: string): Element | undefined {
  return fileRoots(document).find((root) => normalizedPath(root) === path);
}

function lineNumber(node: Element | null): number {
  if (!node) return 0;
  const direct = node.getAttribute('data-line-number');
  if (/^\d+$/.test(direct || '')) return Number(direct);
  const text = `${node.getAttribute('aria-label') || ''} ${node.textContent || ''} ${node.getAttribute('href') || ''}`;
  return Number(text.match(/(?:line\D*|_|L)(\d+)\D*$/i)?.[1] || (node.textContent || '').trim().match(/^\d+$/)?.[0] || 0);
}

function targetElement(root: Element, line: number, side: 'old' | 'new'): Element | null {
  const candidates = [...root.querySelectorAll('[data-line-number],a[href*="#"]')].filter((node) => lineNumber(node) === line);
  const preferred = candidates.find((node) => {
    const label = `${node.getAttribute('aria-label') || ''} ${node.closest('td,[role="cell"]')?.className || ''}`;
    return side === 'old' ? /old|deleted/i.test(label) : !/old|deleted/i.test(label);
  });
  return preferred || candidates[0] || null;
}

function codeCellForSide(row: Element, side: 'old' | 'new'): Element | null {
  const cells = [...row.querySelectorAll('.line_content,[data-testid="diff-line-content"],[role="gridcell"]')];
  if (!cells.length) return null;
  const sideMatch = cells.find((cell) => {
    const label = `${cell.className || ''} ${cell.closest('td,[role="cell"]')?.className || ''} ${cell.getAttribute('aria-label') || ''}`;
    return side === 'old' ? /old|deleted/i.test(label) : !/old|deleted/i.test(label);
  });
  return sideMatch || cells[0] || null;
}

export function createGitLabPage({
  window,
  resolveReview,
}: {
  window: Window;
  resolveReview(input: { projectPath: unknown; mergeRequestIid: unknown }, signal: AbortSignal): Promise<ReviewResult>;
}) {
  const document = window.document;
  const MutationObserverConstructor = (window as unknown as { MutationObserver: typeof MutationObserver }).MutationObserver;
  const EventConstructor = (window as unknown as { Event: typeof Event }).Event;

  function observeReviews(signal: AbortSignal): AsyncIterable<ReviewDescriptor | null> {
    const queue = new AsyncQueue<ReviewDescriptor | null>();
    let last: ReviewDescriptor | null | undefined;
    let scheduled = false;
    let run = 0;
    const reconcile = async () => {
      scheduled = false;
      const generation = ++run;
      try {
        const location = reviewLocation(window);
        let next: ReviewDescriptor | null = null;
        if (location) {
          const result = await resolveReview(location, signal);
          if (result.kind === 'ok') next = result.value;
        }
        if (signal.aborted || generation !== run || sameReview(last ?? null, next) && last !== undefined) return;
        last = next;
        queue.push(next);
      } catch (error) {
        if (!signal.aborted) queue.fail(error);
      }
    };
    const schedule = () => { if (!scheduled) { scheduled = true; queueMicrotask(() => void reconcile()); } };
    const observer = new MutationObserverConstructor((mutations) => { if (!mutations.length || !mutations.every(golensMutation)) schedule(); });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('popstate', schedule, { signal });
    window.addEventListener('hashchange', schedule, { signal });
    window.addEventListener('turbo:load', schedule, { signal });
    window.addEventListener('pjax:end', schedule, { signal });
    signal.addEventListener('abort', () => { observer.disconnect(); queue.close(); }, { once: true });
    schedule();
    return queue;
  }

  function connect(review: ReviewDescriptor, signal: AbortSignal, read: Read): BoundGitLabHost {
    let revision = 1 as HostRevision;
    const events = new AsyncQueue<HostEvent>();
    const elements = new Map<HostTargetToken, Element>();
    const operations = new Map<string, ActionOutcome>();
    let projectionKey = '';
    let shortcuts: readonly ShortcutProjection[] = [];
    let revisionScheduled = false;
    let tokenSequence = 0;
    const tokens = new WeakMap<Element, HostTargetToken>();
    let pointerAnchor: Readonly<{ token: HostTargetToken; x: number; y: number }> | undefined;

    const fileControls = () => fileRoots(document).flatMap((root) => {
      const action = root.querySelector('button[data-click="showFullFile"]:not(:disabled),button[data-click="showChanges"]:not(:disabled),.js-unfold-all:not(:disabled),button[data-click="expandLines"]:not(:disabled)');
      try { return action ? [{ path: repositoryPath(normalizedPath(root)), full: Boolean(root.querySelector('button[data-click="showChanges"]')) }] : []; } catch { return []; }
    });
    const emitRevision = () => events.push({ type: 'host-revised', revision, surface: surface(window), files: fileControls() });
    emitRevision();

    const revise = () => {
      if (revisionScheduled || signal.aborted) return;
      revisionScheduled = true;
      queueMicrotask(() => {
        revisionScheduled = false;
        if (signal.aborted) return;
        removeProjection();
        revision = (Number(revision) + 1) as HostRevision;
        elements.clear();
        projectionKey = '';
        shortcuts = [];
        emitRevision();
      });
    };
    const observer = new MutationObserverConstructor((mutations: MutationRecord[]) => {
      if (!mutations.length || mutations.every(golensMutation)) return;
      revise();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const emitIntent = (intent: HostIntent, source: 'manual' | 'shortcut' = 'manual') => events.push({ type: 'intent', revision, source, ...intent });
    const onFullscreen = () => events.push({ type: 'fullscreen-changed', revision, active: Boolean(document.fullscreenElement) });
    document.addEventListener('fullscreenchange', onFullscreen, { signal });

    function diffTarget(node: EventTarget | null): DiffTarget | null {
      if (!(node instanceof (window as unknown as { Element: typeof Element }).Element)) return null;
      const root = node.closest('diff-file,.diff-file,[data-testid="diff-file"],[data-testid="rd-diff-file"]');
      const row = node.closest('tr,[role="row"]');
      if (!root || !row) return null;
      const cell = node.closest('td,[role="cell"],[role="gridcell"]');
      const old = /old|deleted/i.test(`${cell?.className || ''} ${cell?.getAttribute('data-position') || ''}`);
      const anchors = [...row.querySelectorAll('[data-line-number],a[href*="#"]')];
      const anchor = anchors.find((candidate) => {
        const label = `${candidate.getAttribute('aria-label') || ''} ${candidate.closest('td,[role="cell"]')?.className || ''}`;
        return old ? /old|deleted/i.test(label) : !/old|deleted/i.test(label);
      }) || anchors[0];
      const line = lineNumber(anchor || row);
      if (!line) return null;
      const paths = pathsForRoot(root);
      let path;
      try { path = repositoryPath(old ? paths.oldPath : paths.newPath); } catch { return null; }
      let token = tokens.get(node);
      if (!token) {
        token = `${revision}:${++tokenSequence}` as HostTargetToken;
        tokens.set(node, token);
        elements.set(token, node);
      }
      const source = sourceIdentity({
        repositoryKey: review.identity.repositoryKey,
        commitSha: old ? review.refs.startSha || review.refs.baseSha : review.identity.headSha,
      });
      const identifier = node.textContent?.trim();
      const codeCell = node.closest('.line_content,[data-testid="diff-line-content"],[role="gridcell"]') || cell;
      let column = 1;
      let occurrence = 0;
      if (identifier && codeCell && codeCell !== node) {
        const walker = document.createTreeWalker(codeCell, (window as unknown as { NodeFilter: typeof NodeFilter }).NodeFilter.SHOW_TEXT);
        let text = walker.nextNode();
        while (text && !node.contains(text)) { column += text.textContent?.length || 0; text = walker.nextNode(); }
        const rendered = [...codeCell.querySelectorAll('*')].filter((candidate) => candidate.textContent?.trim() === identifier);
        occurrence = Math.max(0, rendered.findIndex((candidate) => candidate === node || candidate.contains(node)));
      }
      return Object.freeze({ revision, token, path, side: old ? 'old' : 'new', line,
        ...(identifier && /^[A-Za-z_]\w*$/.test(identifier) ? { identifier, column, occurrence } : {}), source });
    }

    const hashText = async (value: string) => {
      const normalized = value.replace(/\r\n?/g, '\n').trim();
      if (!normalized) return '';
      return [...new Uint8Array(await window.crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized)))]
        .map((byte) => byte.toString(16).padStart(2, '0')).join('');
    };
    async function selectedBookmark() {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed || !selection.anchorNode || !selection.focusNode) return undefined;
      const element = (node: Node) => node.nodeType === 1 ? node as Element : node.parentElement;
      const anchor = diffTarget(element(selection.anchorNode));
      const focus = diffTarget(element(selection.focusNode));
      if (!anchor || !focus || anchor.path !== focus.path || anchor.side !== focus.side || anchor.source.commitSha !== focus.source.commitSha) return undefined;
      const root = rootForPath(document, anchor.path);
      if (!root) return undefined;
      const startLine = Math.min(anchor.line, focus.line);
      const endLine = Math.max(anchor.line, focus.line);
      const textAt = (line: number) => targetElement(root, line, anchor.side)?.closest('tr,[role="row"]')
        ?.querySelector('.line_content,[data-testid="diff-line-content"],[role="gridcell"]:last-child')?.textContent;
      const lines: string[] = [];
      for (let line = startLine; line <= endLine; line++) {
        const text = textAt(line);
        if (text === undefined) return undefined;
        lines.push(text);
      }
      return Object.freeze({
        location: { path: anchor.path, side: anchor.side, startLine, endLine },
        anchor: { symbol: '', selectionHash: await hashText(lines.join('\n')), beforeHash: await hashText(textAt(startLine - 1) || ''), afterHash: await hashText(textAt(endLine + 1) || '') },
      });
    }

    function removeProjection(): void {
      document.querySelectorAll('golens-host-surface:not(#golens-onboarding-root):not(#golens-feature-guide-root)').forEach((node) => node.remove());
      document.querySelectorAll('[data-golens-generated-hidden],[data-golens-generated-file-row],[data-golens-generated-folder],[data-golens-test-file],[data-golens-go-test-file-row],[data-golens-full-file],[data-golens-interactive],[data-golens-occurrence],[data-golens-bookmark],[data-golens-destination]').forEach((node) => {
        for (const name of [...node.getAttributeNames()].filter((name) => name.startsWith('data-golens-'))) node.removeAttribute(name);
      });
      document.querySelectorAll('[data-golens-status]').forEach((node) => node.remove());
      document.querySelectorAll('[data-golens-full-file-control]').forEach((node) => node.remove());
      document.documentElement.removeAttribute('data-golens-review-focus');
    }

    function apply(next: HostProjection): ApplyOutcome {
      if (next.revision !== revision) return { kind: 'stale', currentRevision: revision };
      const key = JSON.stringify(next);
      if (key === projectionKey) return { kind: 'unchanged' };
      removeProjection();
      projectionKey = key;
      shortcuts = next.shortcuts || [];
      if (!next.enabled) return { kind: 'applied' };
      document.documentElement.toggleAttribute('data-golens-review-focus', Boolean(next.focusMode));
      const rapidOptIn = [...document.querySelectorAll<HTMLButtonElement>('button')].find((button) => /^try\s+rapid\s+diffs\b/i.test(button.textContent?.trim() || '') && !button.disabled);
      if (surface(window) === 'changes') rapidOptIn?.click();
      if (next.controls?.length) {
        const container = document.querySelector('.layout-page.is-merge-request > .ai-panels,div.ai-panels');
        const anchor = container?.querySelector(':scope > div > nav > div > button,nav > div > button,nav button');
        if (anchor) {
          const host = controlsSurface(document, next.controls);
          anchor.after(host);
        }
      }
      const allPaths = new Set<string>();
      const generatedPaths = new Set<string>();
      for (const root of fileRoots(document)) {
        const path = normalizedPath(root);
        if (path) allPaths.add(path);
        if (next.hideGeneratedFiles && generated(root, window)) {
          generatedPaths.add(path);
          root.setAttribute('data-golens-generated-hidden', '');
          if (root.id) for (const row of document.querySelectorAll<HTMLElement>('[data-file-row]')) {
            if (row.dataset.fileRow === root.id) row.setAttribute('data-golens-generated-file-row', '');
          }
        }
        if (next.decorateTestFiles && path.endsWith('_test.go')) root.setAttribute('data-golens-test-file', '');
        if (next.decorateTestFiles && path.endsWith('_test.go')) for (const row of document.querySelectorAll<HTMLElement>('[data-file-row]')) {
          if ([row.title, row.getAttribute('aria-label'), row.textContent].some((value) => value?.includes(path))) row.setAttribute('data-golens-go-test-file-row', '');
        }
        const fullFile = next.fullFileControls?.find((control) => control.path === path);
        if (fullFile) {
          const header = root.querySelector('[data-testid="file-title"],.file-title-name,.file-header') || root;
          const control = fullFileSurface(document, fullFile);
          control.dataset.golensFullFileControl = '';
          const viewed = [...root.querySelectorAll('label,[role="checkbox"]')].find((element) => /\bviewed\b/i.test(element.textContent || ''));
          if (viewed) viewed.before(control); else header.append(control);
        }
      }
      if (next.hideGeneratedFiles) for (const folder of document.querySelectorAll<HTMLElement>('[data-testid="file-row"].folder')) {
        const folderPath = (folder.title || '').trim().replace(/\s*\/\s*/g, '/').replace(/^\/+|\/+$/g, '');
        const descendants = [...allPaths].filter((path) => path.startsWith(`${folderPath}/`));
        if (folderPath && descendants.length && descendants.every((path) => generatedPaths.has(path))) folder.setAttribute('data-golens-generated-folder', '');
      }
      for (const target of next.interactiveTargets || []) {
        const element = elements.get(target.token);
        if (element?.isConnected) element.setAttribute('data-golens-interactive', '');
      }
      for (const [tokens, name] of [[next.occurrences, 'data-golens-occurrence'], [next.bookmarks, 'data-golens-bookmark']] as const) {
        for (const token of tokens || []) elements.get(token)?.setAttribute(name, '');
      }
      for (const [locations, name] of [[next.occurrenceLocations, 'data-golens-occurrence'], [next.bookmarkLocations, 'data-golens-bookmark']] as const) {
        for (const location of locations || []) sourceElement(location.source, location.path, location.line)?.setAttribute(name, '');
      }
      if (next.destination) elements.get(next.destination)?.setAttribute('data-golens-destination', '');
      if (next.status || next.announcement) {
        const status = document.createElement('div');
        status.dataset.golensStatus = '';
        status.hidden = true;
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.textContent = next.announcement || next.status || '';
        document.documentElement.append(status);
      }
      if (next.surface) {
        const host = activeSurface(document, next.surface);
        host.dataset.golensActiveSurface = '';
        if (next.surface.kind === 'popover') {
          const width = 440;
          const height = 280;
          let left: number | undefined;
          let top: number | undefined;
          let targetEl: Element | null = null;
          if (next.selected) {
            const tokenEl = elements.get(next.selected.token);
            if (tokenEl?.isConnected) {
              targetEl = tokenEl;
            } else {
              const root = fileRoots(document).find((r) => normalizedPath(r) === next.selected?.path);
              if (root) {
                const lineEl = targetElement(root, next.selected.line, next.selected.side);
                const row = lineEl?.closest('tr,[role="row"]');
                if (row) {
                  const codeCell = codeCellForSide(row, next.selected.side);
                  if (codeCell && next.selected.identifier) {
                    const matches = [...codeCell.querySelectorAll('*')].filter((el) => el.textContent?.trim() === next.selected?.identifier);
                    targetEl = matches[next.selected.occurrence || 0] || matches[0] || codeCell;
                  } else {
                    targetEl = codeCell || lineEl;
                  }
                }
              }
            }
          }
          const rect = targetEl?.isConnected ? targetEl.getBoundingClientRect() : undefined;
          const usableRect = rect && rect.width > 0 && rect.height > 0 && !(rect.top === 0 && rect.left === 0) ? rect : undefined;
          const pointer = next.selected && pointerAnchor?.token === next.selected.token ? pointerAnchor : undefined;
          if (usableRect) {
            const gap = 6;
            left = Math.max(12, Math.min(window.innerWidth - width - 12, usableRect.left));
            top = (usableRect.top - gap - height >= 12)
              ? usableRect.top - gap - height
              : Math.min(window.innerHeight - height - 12, usableRect.bottom + gap);
          } else if (pointer) {
            const gap = 18;
            left = Math.max(12, Math.min(window.innerWidth - width - 12, pointer.x));
            const below = pointer.y + gap;
            top = (below + height <= window.innerHeight - 12) ? below : Math.max(12, pointer.y - gap - height);
          }
          host.style.cssText = left !== undefined && top !== undefined
            ? `position:fixed; z-index:2147483647; left:${left}px; top:${top}px; pointer-events:auto;`
            : `position:fixed; z-index:2147483647; right:24px; top:72px; pointer-events:auto;`;
        }
        document.documentElement.append(host);
      }
      return { kind: 'applied' };
    }

    function actionTarget(target: DiffTarget): Element | null {
      if (target.revision !== revision) return null;
      return elements.get(target.token) || null;
    }

    function sourceElement(source: DiffTarget['source'], path: DiffTarget['path'], line: number): Element | null {
      const root = rootForPath(document, path);
      if (!root) return null;
      const old = source.commitSha !== review.identity.headSha;
      for (const row of root.querySelectorAll('tr,[role="row"]')) {
        const anchors = [...row.querySelectorAll('[data-line-number],a[href*="#"]')];
        const matching = anchors.find((candidate) => {
          const label = `${candidate.getAttribute('aria-label') || ''} ${candidate.closest('td,[role="cell"]')?.className || ''}`;
          return lineNumber(candidate) === line && (old ? /old|deleted/i.test(label) : !/old|deleted/i.test(label));
        });
        if (matching || (!anchors.length && lineNumber(row) === line)) return row;
      }
      return null;
    }

    function relativeElements(kind: 'occurrence' | 'hunk' | 'file' | 'bookmark'): Element[] {
      if (kind === 'file') return fileRoots(document);
      if (kind === 'hunk') {
        const explicit = [...document.querySelectorAll('[data-hunk-lines],.diff-hunk,[data-testid="diff-hunk"],[data-testid="rd-diff-hunk"]')];
        if (explicit.length) return explicit;
        const hunks: Element[] = [];
        for (const file of fileRoots(document)) {
          let previousChanged = false;
          for (const row of file.querySelectorAll('tr,[role="row"]')) {
            const changed = row.matches('.new,.old,.added,.deleted,[data-hunk-lines]')
              || Boolean(row.querySelector('.new,.old,.added,.deleted,[data-hunk-lines]'));
            if (changed && !previousChanged) hunks.push(row);
            previousChanged = changed;
          }
        }
        return hunks;
      }
      return [...document.querySelectorAll(kind === 'occurrence' ? '[data-golens-occurrence]' : '[data-golens-bookmark]')];
    }

    async function perform(action: HostAction, actionSignal: AbortSignal): Promise<ActionOutcome> {
      if (action.revision !== revision) return { kind: 'stale', currentRevision: revision };
      const previous = operations.get(action.operationId);
      if (previous) return previous.kind === 'completed' ? { kind: 'unchanged' } : previous;
      if (actionSignal.aborted) throw new DOMException('Aborted', 'AbortError');
      let outcome: ActionOutcome = { kind: 'completed' };
      if (action.action === 'set-fullscreen') {
        if (action.active === Boolean(document.fullscreenElement)) outcome = { kind: 'unchanged' };
        else if (action.active && document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
        else if (!action.active && document.exitFullscreen) await document.exitFullscreen();
        else outcome = { kind: 'unavailable', reason: 'unsupported' };
      } else if (action.action === 'focus-file-search' || action.action === 'clear-file-search') {
        const input = document.querySelector<HTMLInputElement>('[data-testid="file-search"],input[placeholder*="file" i],input[aria-label*="file" i]');
        if (!input) outcome = { kind: 'unavailable', reason: 'not-rendered' };
        else if (action.action === 'focus-file-search') input.focus();
        else { input.value = ''; input.dispatchEvent(new EventConstructor('input', { bubbles: true })); }
      } else if (action.action === 'reveal-target') {
        if (!elements.has(action.target.token)) {
          outcome = { kind: 'unavailable', reason: 'not-rendered' };
          operations.set(action.operationId, outcome);
          return outcome;
        }
        let element = actionTarget(action.target);
        const root = rootForPath(document, action.target.path);
        let controls = 0;
        const deadline = Date.now() + 15_000;
        while (!element && root && controls < 500 && Date.now() < deadline) {
          if (actionSignal.aborted) throw new DOMException('Aborted', 'AbortError');
          const button = root.querySelector<HTMLButtonElement>('button[data-click="expandLines"],.js-unfold-all,button[data-click="showFullFile"]:not([disabled])');
          if (!button) break;
          button.click(); controls++;
          await new Promise((resolve) => window.setTimeout(resolve));
          element = actionTarget(action.target);
        }
        if (!element) outcome = controls >= 500 ? { kind: 'limit-exceeded', limit: { name: 'full-file-controls', maximum: 500 } } : Date.now() >= deadline ? { kind: 'limit-exceeded', limit: { name: 'full-file-time', maximum: 15_000 } } : { kind: 'unavailable', reason: 'not-rendered' };
        else element.scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      } else if (action.action === 'reveal-source') {
        const element = sourceElement(action.source, action.path, action.line);
        if (!element) outcome = { kind: 'unavailable', reason: 'not-rendered' };
        else element.scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      } else if (action.action === 'navigate-relative') {
        const candidates = relativeElements(action.kind);
        if (!candidates.length) outcome = { kind: 'unavailable', reason: 'not-rendered' };
        else {
          const selected = document.querySelector('[data-golens-destination]');
          const current = selected ? candidates.findIndex((candidate) => candidate === selected || candidate.contains(selected)) : -1;
          const index = current < 0 ? (action.direction === 'previous' ? candidates.length - 1 : 0)
            : (current + (action.direction === 'previous' ? candidates.length - 1 : 1)) % candidates.length;
          const destination = candidates[index]!;
          document.querySelectorAll('[data-golens-destination]').forEach((element) => element.removeAttribute('data-golens-destination'));
          destination.scrollIntoView?.({ behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
          destination.setAttribute('data-golens-destination', '');
        }
      } else if (action.action === 'set-full-file') {
        const root = rootForPath(document, action.path);
        const button = root?.querySelector<HTMLButtonElement>(action.full ? 'button[data-click="showFullFile"],.js-unfold-all' : 'button[data-click="showChanges"]');
        if (!button) outcome = { kind: 'unavailable', reason: 'not-rendered' }; else button.click();
      } else if (action.action === 'open-destination') {
        let url: URL;
        if (action.destination.kind === 'source') {
          if (action.destination.source.repositoryKey !== review.identity.repositoryKey) throw new HostContractError('Destination source identity does not match the bound review.');
          url = new URL(`/${review.identity.projectPath}/-/blob/${action.destination.source.commitSha}/${action.destination.path}${action.destination.line ? `#L${action.destination.line}` : ''}`, review.identity.origin);
        } else {
          url = new URL(action.destination.url);
          if (url.protocol !== 'https:') throw new HostContractError('Documentation destination must use HTTPS.');
        }
        window.open(url, '_blank', 'noopener');
      } else if (action.action === 'copy-source-location') {
        try { await window.navigator.clipboard.writeText(action.text); } catch { outcome = { kind: 'unavailable', reason: 'unsupported' }; }
      }
      operations.set(action.operationId, outcome);
      return outcome;
    }

    const onClick = (event: Event) => {
      const HTMLElementConstructor = (window as unknown as { HTMLElement: typeof HTMLElement }).HTMLElement;
      const button = event.composedPath().find((node) => node instanceof HTMLElementConstructor && /approve|merge/i.test(`${(node as HTMLElement).dataset.testid || ''} ${(node as HTMLElement).textContent || ''}`));
      if (button) emitIntent({ command: /merge/i.test((button as HTMLElement).textContent || '') ? 'native-merge' : 'native-approve' });
      const mouse = event as MouseEvent;
      if (mouse.metaKey || mouse.ctrlKey) {
        const target = diffTarget(event.target);
        if (target) { event.preventDefault(); emitIntent({ command: 'activate-target', target }); }
      } else {
        const target = diffTarget(event.target);
        if (target) emitIntent({ command: 'select-target', target });
      }
    };
    const onSurfaceIntent = (event: Event) => {
      const detail = (event as CustomEvent<SurfaceIntent>).detail;
      emitIntent(detail);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!projectionKey) return;
      const blocked = event.composedPath().some((node) => node instanceof (window as unknown as { Element: typeof Element }).Element
        && (node as Element).matches('input,textarea,select,[contenteditable],dialog,[role="dialog"],[aria-modal="true"]'));
      if (blocked) return;
      const shortcut = shortcuts.find((candidate) =>
        (candidate.key === event.code || candidate.key.toLowerCase() === event.key.toLowerCase())
        && (!candidate.code || candidate.code === event.code)
        && Boolean(candidate.altKey) === event.altKey && Boolean(candidate.ctrlKey) === event.ctrlKey
        && Boolean(candidate.metaKey) === event.metaKey && Boolean(candidate.shiftKey) === event.shiftKey);
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut.command === 'toggle-bookmark') void selectedBookmark().then((bookmark) => emitIntent({ command: 'toggle-bookmark', ...(bookmark ? { bookmark } : {}) }, 'shortcut'));
      else emitIntent({ command: shortcut.command }, 'shortcut');
    };
    const onPointerOver = (event: Event) => {
      const target = diffTarget(event.target);
      if (!target) return;
      pointerAnchor = Object.freeze({ token: target.token, x: (event as PointerEvent).clientX, y: (event as PointerEvent).clientY });
      emitIntent({ command: 'hover-target', target });
    };
    document.addEventListener('click', onClick, { capture: true, signal });
    document.addEventListener('pointerover', onPointerOver, { capture: true, signal });
    document.addEventListener('golens-intent', onSurfaceIntent, { signal });
    document.addEventListener('keydown', onKeyDown, { capture: true, signal });
    signal.addEventListener('abort', () => { observer.disconnect(); removeProjection(); events.close(); }, { once: true });

    return Object.freeze({
      review,
      events(eventSignal: AbortSignal) {
        if (eventSignal.aborted) events.close();
        else eventSignal.addEventListener('abort', () => events.close(), { once: true });
        return events;
      },
      apply, perform, read,
    });
  }

  return Object.freeze({ observeReviews, connect });
}
