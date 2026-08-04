// page/features/discussion-line-link.js — the "View in changes" link GoLens
// adds to overview-page line discussions (ticket 32; boundary from ticket 03
// §2, interface from ticket 04 §3). Carved out of content.js following the
// generated-files.js precedent (ticket 13): pure decision core in
// discussion-line-link.internal.js, DOM/timers/subscriptions in this shell,
// fully self-contained once mounted (no reconcile() on the handle).
//
// Self-contained page-change observation, same as generated-files.js: its
// own MutationObserver plus the same event set content.js used to funnel
// into its retired schedulePageReconcile (popstate/turbo:load/pjax:end/
// visibilitychange), debounced through platform/clock at the same 50ms
// delay content.js used. Reacts to settings.subscribe('enabled').
import { createClock } from '../platform/clock.js';
import {
  isMergeRequestPath,
  isMergeRequestDiffPath,
  mergeRequestPageKey,
  matchingDiscussionLineHref,
  shouldShowDiscussionLineLinks,
} from './discussion-line-link.internal.js';

const RECONCILE_DEBOUNCE_MS = 50;

const CANDIDATE_HREF_SELECTOR =
  '.discussion-header .note-header-info a[href], .discussion-header .note-header a[href], .diff-file-header a[href], [data-testid="file-title"] a[href]';
const DISCUSSION_HEADER_SELECTOR = '.discussion-header .note-header-info, .discussion-header .note-header';
const DISCUSSION_SELECTOR = '[data-testid="discussion-content"].js-discussion-container';
const LINK_MARK = 'golensDiscussionLineLink';
const LINK_SELECTOR = '[data-golens-discussion-line-link]';

export function mount(ctx) {
  const settings = ctx.settings;
  const clock = ctx.clock || createClock();
  const doc = document;
  const win = window;
  const loc = location;

  let unmounted = false;
  let enabled = false;

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
    link.textContent = 'View in changes';
    link.title = 'Open the commented line in the Changes tab';
    link.setAttribute('aria-label', 'Open commented line in Changes');
    header.append(link);
  }

  function removeDiscussionLinks() {
    doc.querySelectorAll(LINK_SELECTOR).forEach((link) => link.remove());
  }

  function reconcile() {
    if (unmounted) return;
    const show = shouldShowDiscussionLineLinks({
      enabled,
      isMergeRequest: isMergeRequestPath(loc.pathname),
      isDiffPage: isMergeRequestDiffPath(loc.pathname, loc.search),
    });
    if (!show) {
      removeDiscussionLinks();
      return;
    }
    doc.querySelectorAll(DISCUSSION_SELECTOR).forEach(mountDiscussionLink);
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
    settings.ready().then(() => {
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
      removeDiscussionLinks();
    },
  };
}
