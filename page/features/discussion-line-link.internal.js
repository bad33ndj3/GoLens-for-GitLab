// page/features/discussion-line-link.internal.js — pure decision core for
// page/features/discussion-line-link.js. No DOM, no chrome.*, no timers.

// isMergeRequestPath(pathname) -> true for any merge-request path (overview
// or a sub-tab), mirrors content.js's former isMergeRequest(). Total.
export function isMergeRequestPath(pathname) {
  return /\/-\/merge_requests\/\d+/.test(pathname || '');
}

// isMergeRequestDiffPath(pathname, search) -> true specifically for the
// Changes tab, mirrors content.js's former isMergeRequestDiff(). Total.
export function isMergeRequestDiffPath(pathname, search) {
  return /\/-\/merge_requests\/\d+\/diffs(?:$|\/|\?)/.test((pathname || '') + (search || ''));
}

// mergeRequestPageKey({ origin, pathname }) -> `${origin}${mrPath}` for the
// merge-request overview path (no trailing sub-tab), or '' off an MR page.
// Total.
export function mergeRequestPageKey({ origin, pathname }) {
  const match = (pathname || '').match(/^(.*?\/-\/merge_requests\/\d+)/);
  return match ? `${origin}${match[1]}` : '';
}

// matchingDiscussionLineHref(candidateHrefs, { pageKey, baseHref }) -> the
// first candidate href that resolves (against baseHref) to
// `${pageKey}/diffs` with a line-anchor hash, or ''. A malformed href is
// skipped rather than thrown. Total.
export function matchingDiscussionLineHref(candidateHrefs, { pageKey, baseHref }) {
  if (!pageKey) return '';
  for (const href of candidateHrefs || []) {
    try {
      const url = new URL(href, baseHref);
      if (`${url.origin}${url.pathname}` === `${pageKey}/diffs` && url.hash) return url.href;
    } catch {
      // Ignore malformed or non-navigation links rendered by third-party GitLab integrations.
    }
  }
  return '';
}

// shouldShowDiscussionLineLinks({ enabled, isMergeRequest, isDiffPage }) ->
// the top-level gate content.js's reconcileOverviewDiscussionLineLinks used
// to open with. Total.
export function shouldShowDiscussionLineLinks({ enabled, isMergeRequest, isDiffPage }) {
  return Boolean(enabled && isMergeRequest && !isDiffPage);
}

function singleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

export function normalizeReviewText(value) {
  return String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// formatReviewSolution(record) -> one paste-ready agent instruction, or ''
// when any required thread field is missing. JSON string escaping keeps
// quotes and line breaks unambiguous without inventing a custom format.
export function formatReviewSolution(record) {
  const path = singleLine(record?.path);
  const line = Number(record?.line);
  const noteUrl = singleLine(record?.noteUrl);
  const author = singleLine(record?.author).replace(/^@/, '');
  const comment = normalizeReviewText(record?.comment);
  const solution = normalizeReviewText(record?.solution);
  if (!record?.accepted || !path || !Number.isInteger(line) || line < 1 || !noteUrl || !author || !comment) return '';
  const guidance = solution ? ` Optional guidance: ${JSON.stringify(solution)}` : '';
  return `${path}:${line} [${noteUrl} @${author} - ${JSON.stringify(comment)}] - Action: Implement exactly what the reviewer requested.${guidance}`;
}

export function formatReviewSolutionBundle(records) {
  return (records || []).map(formatReviewSolution).filter(Boolean).join('\n\n');
}
