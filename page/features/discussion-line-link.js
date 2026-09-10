// page/features/discussion-line-link.js — overview-page line-discussion tools:
// the "View in changes" link and local, paste-ready agent review instructions.
// the generated-files.js pattern: pure decision core in
// discussion-line-link.internal.js, DOM/timers/subscriptions in this shell,
// fully self-contained once mounted (no reconcile() on the handle).
//
// Self-contained page-change observation, same as generated-files.js: its
// own MutationObserver plus the same event set content.js used to funnel
// into its retired schedulePageReconcile (popstate/turbo:load/pjax:end/
// visibilitychange), debounced through platform/clock at the same 50ms
// delay content.js used. Reacts to settings.subscribe('enabled').
import { createClock } from '../platform/clock.js';
import { writeClipboardText } from '../platform/clipboard.js';
import { lineFromAnchor } from '../platform/diff-dom.js';
import {
  formatReviewSolutionBundle,
  isMergeRequestPath,
  isMergeRequestDiffPath,
  mergeRequestPageKey,
  matchingDiscussionLineHref,
  normalizeReviewText,
  shouldShowDiscussionLineLinks,
} from './discussion-line-link.internal.js';

const RECONCILE_DEBOUNCE_MS = 50;
const REVIEW_STORAGE_VERSION = 1;
const REVIEW_STORAGE_PREFIX = `golensReview:v${REVIEW_STORAGE_VERSION}:`;

const CANDIDATE_HREF_SELECTOR =
  '.discussion-header .note-header-info a[href], .discussion-header .note-header a[href], .diff-file-header a[href], [data-testid="file-title"] a[href]';
const DISCUSSION_HEADER_SELECTOR = '.discussion-header .note-header-info, .discussion-header .note-header';
const DISCUSSION_SELECTOR = '[data-testid="discussion-content"].js-discussion-container';
const LINK_MARK = 'golensDiscussionLineLink';
const LINK_SELECTOR = '[data-golens-discussion-line-link]';
const DRAFT_MARK = 'golensDiscussionDraft';
const DRAFT_SELECTOR = '[data-golens-discussion-draft]';
const NOTE_BODY_SELECTOR = '[data-testid="note-body"], .note-text, .note-body .md, .note-body';
const SUGGESTION_SELECTOR = '.md-suggestion, [data-testid="suggestion-content"], [data-testid="suggestion-diff"], [data-suggestion]';
const SUGGESTION_ACTION_SELECTOR = '.suggestion-actions, .js-suggestion-actions, [data-testid*="suggestion-action"], [data-testid*="suggestion-apply"]';
const NOTE_LINK_SELECTOR = 'a[href*="#note_"]';
const AUTHOR_SELECTOR = '[data-username], [data-testid="author-link"], .js-user-link, .author-link';
const FILE_PATH_SELECTOR = '[data-file-path], [data-testid="file-title"], .file-title-name, .diff-file-header a[href], .rd-diff-file-link';

export function mount(ctx) {
  const settings = ctx.settings;
  const clock = ctx.clock || createClock();
  const doc = document;
  const win = window;
  const loc = location;
  const copyText = ctx.copyText || ((text) => writeClipboardText(text, { doc, clipboard: navigator.clipboard }));
  const reviewStorage = ctx.reviewStorage || globalThis.chrome?.storage?.local;

  let unmounted = false;
  let enabled = false;
  let activePageKey = mergeRequestPageKey({ origin: loc.origin, pathname: loc.pathname });
  const drafts = new Map();
  const savedDrafts = new Map();
  const listeners = new Set();

  function snapshot() {
    return [...drafts.values()].filter((record) => record.accepted);
  }

  function reviewCommentText(commentNode) {
    const clone = commentNode.cloneNode(true);
    clone.querySelectorAll(SUGGESTION_ACTION_SELECTOR).forEach((node) => node.remove());
    clone.querySelectorAll(SUGGESTION_SELECTOR).forEach((suggestion) => {
      if (suggestion.parentElement?.closest(SUGGESTION_SELECTOR)) return;
      const code = suggestion.getAttribute('data-suggestion')
        || suggestion.querySelector('[data-testid="suggestion-code"], pre code, pre, code')?.textContent;
      if (code?.trim()) suggestion.replaceWith(doc.createTextNode(`\n\nSuggested change:\n${code.trim()}\n`));
    });
    return normalizeReviewText(clone.textContent);
  }

  function notify() {
    const value = snapshot();
    listeners.forEach((listener) => listener(value));
  }

  function storageKey(noteUrl) {
    return `${REVIEW_STORAGE_PREFIX}${encodeURIComponent(noteUrl)}`;
  }

  async function loadSavedDrafts() {
    if (!reviewStorage?.get) return;
    const values = await reviewStorage.get(null);
    Object.entries(values || {}).forEach(([key, value]) => {
      if (!key.startsWith(REVIEW_STORAGE_PREFIX) || value?.version !== REVIEW_STORAGE_VERSION
        || typeof value.noteUrl !== 'string' || key !== storageKey(value.noteUrl)) return;
      savedDrafts.set(value.noteUrl, {
        accepted: value.accepted === true,
        solution: typeof value.solution === 'string' ? value.solution : '',
      });
    });
  }

  function persist(record) {
    if (!reviewStorage?.set) return;
    const key = storageKey(record.noteUrl);
    const value = record.accepted || record.solution.trim()
      ? {
          version: REVIEW_STORAGE_VERSION,
          noteUrl: record.noteUrl,
          accepted: record.accepted,
          solution: record.solution,
        }
      : null;
    if (value) savedDrafts.set(record.noteUrl, value);
    else savedDrafts.delete(record.noteUrl);
    const pending = value ? reviewStorage.set({ [key]: value }) : reviewStorage.remove?.(key);
    pending?.catch((error) => console.warn('GoLens could not save review guidance.', error));
  }

  function discussionLineTarget(discussion) {
    if (!discussion.querySelector('.diff-file tr.line_holder')) return '';
    const pageKey = mergeRequestPageKey({ origin: loc.origin, pathname: loc.pathname });
    const hrefs = [...discussion.querySelectorAll(CANDIDATE_HREF_SELECTOR)].map((a) => a.getAttribute('href'));
    return matchingDiscussionLineHref(hrefs, { pageKey, baseHref: loc.href });
  }

  function mountDiscussionLink(discussion) {
    if (discussion.querySelector(LINK_SELECTOR)) return;
    const href = discussionLineTarget(discussion);
    const header = discussion.querySelector(DISCUSSION_HEADER_SELECTOR);
    if (!href || !header) return;
    const link = doc.createElement('a');
    link.className = 'gitlab-lens-discussion-line-link';
    link.dataset[LINK_MARK] = '';
    link.href = href;
    link.textContent = 'View';
    link.title = 'Open the commented line in the Changes tab';
    link.setAttribute('aria-label', 'Open commented line in Changes');
    header.append(link);
  }

  function discussionMetadata(discussion) {
    const lineTarget = discussionLineTarget(discussion);
    const noteLink = [...discussion.querySelectorAll(NOTE_LINK_SELECTOR)].find((link) => {
      try { return /^#note_\d+$/.test(new URL(link.href, loc.href).hash); } catch { return false; }
    });
    const authorNode = discussion.querySelector(AUTHOR_SELECTOR);
    const commentNode = discussion.querySelector(NOTE_BODY_SELECTOR);
    const diff = discussion.querySelector('.diff-file');
    const fileNode = diff?.querySelector(FILE_PATH_SELECTOR);
    const lineNode = discussion.querySelector('.line_holder .new_line, .line_holder .old_line, .line_holder [data-line-number]');
    const path = (fileNode?.getAttribute('data-file-path') || fileNode?.textContent || '')
      .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
      .replace(/\s*\/\s*/g, '/')
      .trim();
    const author = (authorNode?.getAttribute('data-username') || authorNode?.textContent || '').trim().replace(/^@/, '');
    const line = lineFromAnchor(lineNode) || lineFromAnchor({
      getAttribute: (name) => name === 'href' ? lineTarget : '',
      textContent: '',
      title: '',
    });
    const comment = commentNode && reviewCommentText(commentNode);
    if (!lineTarget || !noteLink || !path || !line || !author || !comment) return null;
    return {
      path,
      line,
      noteUrl: new URL(noteLink.href, loc.href).href,
      author,
      comment,
    };
  }

  function mountDiscussionDraft(discussion) {
    if (discussion.querySelector(DRAFT_SELECTOR)) return;
    const metadata = discussionMetadata(discussion);
    const header = discussion.querySelector(DISCUSSION_HEADER_SELECTOR);
    if (!metadata || !header) return;

    const existing = drafts.get(metadata.noteUrl) || savedDrafts.get(metadata.noteUrl);
    const record = { ...metadata, accepted: existing?.accepted || false, solution: existing?.solution || '' };
    drafts.set(metadata.noteUrl, record);

    const actions = doc.createElement('span');
    actions.className = 'gitlab-lens-discussion-actions';
    actions.dataset[DRAFT_MARK] = '';

    const acceptButton = doc.createElement('button');
    acceptButton.type = 'button';
    acceptButton.className = 'gitlab-lens-discussion-accept';
    acceptButton.dataset.golensAction = 'accept-review';
    const renderAcceptButton = () => {
      acceptButton.textContent = record.accepted ? 'Accepted' : 'Accept';
      acceptButton.setAttribute('aria-pressed', String(record.accepted));
      acceptButton.title = record.accepted
        ? 'Remove this comment from the agent batch'
        : 'Add this comment to the agent batch exactly as requested';
    };
    renderAcceptButton();

    const guidanceButton = doc.createElement('button');
    guidanceButton.type = 'button';
    guidanceButton.className = 'gitlab-lens-discussion-draft-toggle';
    guidanceButton.setAttribute('aria-expanded', 'false');
    const renderGuidanceButton = () => {
      const hasGuidance = Boolean(record.solution.trim());
      guidanceButton.textContent = hasGuidance ? 'Guided' : 'Guidance';
      guidanceButton.dataset.hasGuidance = String(hasGuidance);
      guidanceButton.title = hasGuidance ? 'Edit saved optional guidance' : 'Add optional guidance';
    };
    renderGuidanceButton();

    const editor = doc.createElement('div');
    editor.className = 'gitlab-lens-discussion-draft';
    editor.dataset[DRAFT_MARK] = '';
    editor.hidden = true;
    const id = `golens-solution-${new URL(metadata.noteUrl).hash.slice(1)}`;
    editor.id = id;
    guidanceButton.setAttribute('aria-controls', id);

    const label = doc.createElement('label');
    label.textContent = `Optional guidance for @${metadata.author}`;
    const textarea = doc.createElement('textarea');
    textarea.rows = 3;
    textarea.placeholder = 'Add context only if the reviewer’s instruction needs clarification';
    textarea.value = record.solution;
    textarea.setAttribute('aria-label', `Optional guidance for @${metadata.author}`);
    label.append(textarea);
    editor.append(label);

    const privacy = doc.createElement('small');
    privacy.textContent = 'Stored in this tab only. Nothing is sent to GitLab.';
    editor.append(privacy);

    acceptButton.addEventListener('click', () => {
      record.accepted = !record.accepted;
      renderAcceptButton();
      editor.hidden = true;
      guidanceButton.setAttribute('aria-expanded', 'false');
      persist(record);
      notify();
    });
    guidanceButton.addEventListener('click', () => {
      editor.hidden = !editor.hidden;
      guidanceButton.setAttribute('aria-expanded', String(!editor.hidden));
      if (!editor.hidden) textarea.focus();
    });
    textarea.addEventListener('input', () => {
      record.solution = textarea.value;
      if (record.solution.trim()) record.accepted = true;
      renderAcceptButton();
      renderGuidanceButton();
      persist(record);
      notify();
    });
    editor.addEventListener('focusout', (event) => {
      if (editor.contains(event.relatedTarget) || event.relatedTarget === guidanceButton) return;
      editor.hidden = true;
      guidanceButton.setAttribute('aria-expanded', 'false');
    });

    const lineLink = header.querySelector(LINK_SELECTOR);
    if (lineLink) actions.append(lineLink);
    actions.append(acceptButton, guidanceButton);
    header.append(actions);
    header.after(editor);
  }

  function removeDiscussionTools() {
    doc.querySelectorAll(`${LINK_SELECTOR}, ${DRAFT_SELECTOR}`).forEach((node) => node.remove());
  }

  function reconcile() {
    if (unmounted) return;
    const pageKey = mergeRequestPageKey({ origin: loc.origin, pathname: loc.pathname });
    if (pageKey !== activePageKey) {
      activePageKey = pageKey;
      drafts.clear();
      notify();
    }
    const show = shouldShowDiscussionLineLinks({
      enabled,
      isMergeRequest: isMergeRequestPath(loc.pathname),
      isDiffPage: isMergeRequestDiffPath(loc.pathname, loc.search),
    });
    if (!show) {
      removeDiscussionTools();
      return;
    }
    doc.querySelectorAll(DISCUSSION_SELECTOR).forEach((discussion) => {
      mountDiscussionLink(discussion);
      mountDiscussionDraft(discussion);
    });
  }

  const scheduleReconcile = clock.debounceIdle(reconcile, { delayMs: RECONCILE_DEBOUNCE_MS });

  const observer = new MutationObserver(scheduleReconcile);
  observer.observe(doc.body, { childList: true, subtree: true });

  const onVisibilityChange = () => {
    if (doc.visibilityState === 'visible') scheduleReconcile();
  };
  win.addEventListener('popstate', scheduleReconcile);
  doc.addEventListener('turbo:load', scheduleReconcile);
  doc.addEventListener('pjax:end', scheduleReconcile);
  doc.addEventListener('visibilitychange', onVisibilityChange);

  let unsubscribeEnabled = null;
  if (settings) {
    const ready = reviewStorage?.get
      ? Promise.all([
          settings.ready(),
          loadSavedDrafts().catch((error) => console.warn('GoLens could not load saved review guidance.', error)),
        ])
      : settings.ready();
    ready.then(() => {
      if (unmounted) return;
      enabled = Boolean(settings.get('enabled'));
      reconcile();
      unsubscribeEnabled = settings.subscribe('enabled', (value) => {
        enabled = Boolean(value);
        reconcile();
      });
    });
  }

  return {
    snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async copyBundle() {
      const records = snapshot();
      const text = formatReviewSolutionBundle(records);
      if (!text) return { kind: 'empty' };
      await copyText(text);
      return { kind: 'copied', count: records.length, text };
    },
    unmount() {
      if (unmounted) return;
      unmounted = true;
      scheduleReconcile.cancel();
      observer.disconnect();
      win.removeEventListener('popstate', scheduleReconcile);
      doc.removeEventListener('turbo:load', scheduleReconcile);
      doc.removeEventListener('pjax:end', scheduleReconcile);
      doc.removeEventListener('visibilitychange', onVisibilityChange);
      unsubscribeEnabled?.();
      listeners.clear();
      removeDiscussionTools();
    },
  };
}
