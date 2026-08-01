import type { BoundGitLabHost, GitLabHost } from './gitlab-host/index.ts';
import type { ReviewSessionHandle } from './review-session/index.ts';

export async function runReviewSessionComposition({
  host,
  start,
  signal,
}: {
  host: GitLabHost;
  start(bound: BoundGitLabHost, signal: AbortSignal): ReviewSessionHandle;
  signal: AbortSignal;
}): Promise<void> {
  let active: Readonly<{ handle: ReviewSessionHandle; controller: AbortController }> | null = null;
  let identity = '';
  const stopActive = async () => {
    const current = active;
    active = null;
    current?.controller.abort();
    await current?.handle.stop();
  };
  try {
    for await (const review of host.observeReviews(signal)) {
      if (signal.aborted) break;
      const nextIdentity = review ? JSON.stringify(review.identity) : '';
      if (nextIdentity === identity) continue;
      await stopActive();
      identity = nextIdentity;
      if (review) {
        const controller = new AbortController();
        signal.addEventListener('abort', () => controller.abort(), { once: true });
        active = { controller, handle: start(host.connect(review, controller.signal), controller.signal) };
      }
    }
  } finally {
    await stopActive();
  }
}

if (/\/-\/merge_requests\/\d+(?:\/|$)/.test(location.pathname)) {
  void chrome.runtime.sendMessage({ type: 'golens:rewrite:ping' }).catch(() => {});
}
