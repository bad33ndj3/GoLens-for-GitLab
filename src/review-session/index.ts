import type { GoIntelligence } from '../go-intelligence/index.ts';
import type { BoundGitLabHost } from '../gitlab-host/index.ts';
import { runReviewSession, type ReviewSessionBookmarkPort, type ReviewSessionHandle, type ReviewSessionPreferencePort, type ReviewSessionPreferences } from './runtime.ts';

export type { ReviewSessionBookmark, ReviewSessionBookmarkPort, ReviewSessionHandle, ReviewSessionPreferencePort, ReviewSessionPreferences } from './runtime.ts';

export function startReviewSession({
  host,
  intelligence,
  preferences,
  bookmarks,
  preferencePort,
  signal,
}: {
  host: BoundGitLabHost;
  intelligence: Pick<GoIntelligence, 'query'> & Partial<Pick<GoIntelligence, 'ensureCoverage'>>;
  preferences: ReviewSessionPreferences;
  bookmarks?: ReviewSessionBookmarkPort;
  preferencePort?: ReviewSessionPreferencePort;
  signal?: AbortSignal;
}): ReviewSessionHandle {
  return runReviewSession({ host, intelligence, preferences, ...(bookmarks ? { bookmarks } : {}), ...(preferencePort ? { preferencePort } : {}), ...(signal ? { signal } : {}) });
}
