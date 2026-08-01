import type { GoIntelligence } from '../go-intelligence/index.ts';
import type { BoundGitLabHost } from '../gitlab-host/index.ts';
import { runReviewSession, type ReviewSessionBookmarkPort, type ReviewSessionCoachStoragePort, type ReviewSessionHandle, type ReviewSessionPreferencePort, type ReviewSessionPreferences } from './runtime.ts';

export type { ReviewSessionBookmark, ReviewSessionBookmarkPort, ReviewSessionCoachStoragePort, ReviewSessionHandle, ReviewSessionPreferencePort, ReviewSessionPreferences } from './runtime.ts';

export function startReviewSession({
  host,
  intelligence,
  preferences,
  bookmarks,
  preferencePort,
  coachStorage,
  signal,
}: {
  host: BoundGitLabHost;
  intelligence: Pick<GoIntelligence, 'query'> & Partial<Pick<GoIntelligence, 'ensureCoverage'>>;
  preferences: ReviewSessionPreferences;
  bookmarks?: ReviewSessionBookmarkPort;
  preferencePort?: ReviewSessionPreferencePort;
  coachStorage?: ReviewSessionCoachStoragePort;
  signal?: AbortSignal;
}): ReviewSessionHandle {
  return runReviewSession({ host, intelligence, preferences, ...(bookmarks ? { bookmarks } : {}), ...(preferencePort ? { preferencePort } : {}), ...(coachStorage ? { coachStorage } : {}), ...(signal ? { signal } : {}) });
}
