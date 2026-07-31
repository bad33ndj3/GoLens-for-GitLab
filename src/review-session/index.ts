import type { GoIntelligence } from '../go-intelligence/index.ts';
import type { BoundGitLabHost } from '../gitlab-host/index.ts';
import { runReviewSession, type ReviewSessionHandle, type ReviewSessionPreferences } from './runtime.ts';

export type { ReviewSessionHandle, ReviewSessionPreferences } from './runtime.ts';

export function startReviewSession({
  host,
  intelligence,
  preferences,
  signal,
}: {
  host: BoundGitLabHost;
  intelligence: Pick<GoIntelligence, 'query'>;
  preferences: ReviewSessionPreferences;
  signal?: AbortSignal;
}): ReviewSessionHandle {
  return runReviewSession({ host, intelligence, preferences, ...(signal ? { signal } : {}) });
}
