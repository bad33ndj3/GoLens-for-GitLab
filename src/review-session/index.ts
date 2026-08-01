import type { GoIntelligence } from '../go-intelligence/index.ts';
import type { BoundGitLabHost } from '../gitlab-host/index.ts';
import { runReviewSession, type ReviewSessionBookmarkPort, type ReviewSessionHandle, type ReviewSessionPreferences } from './runtime.ts';

export type { ReviewSessionBookmark, ReviewSessionBookmarkPort, ReviewSessionHandle, ReviewSessionPreferences } from './runtime.ts';

export function startReviewSession({
  host,
  intelligence,
  preferences,
  bookmarks,
  savePreferences,
  signal,
}: {
  host: BoundGitLabHost;
  intelligence: Pick<GoIntelligence, 'query'> & Partial<Pick<GoIntelligence, 'ensureCoverage'>>;
  preferences: ReviewSessionPreferences;
  bookmarks?: ReviewSessionBookmarkPort;
  savePreferences?: (update: Partial<ReviewSessionPreferences>) => Promise<void>;
  signal?: AbortSignal;
}): ReviewSessionHandle {
  return runReviewSession({ host, intelligence, preferences, ...(bookmarks ? { bookmarks } : {}), ...(savePreferences ? { savePreferences } : {}), ...(signal ? { signal } : {}) });
}
