import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isGitLabPage, isMergeRequestPath, shouldShowFirstRun, onboardingFeatureIcon } from '../page/features/onboarding.internal.js';

test('isGitLabPage: gitlab_url alone is enough', () => {
  assert.equal(isGitLabPage({ hasGitlabGlobal: true, hasCsrfMeta: false, hasAppShell: false }), true);
});

test('isGitLabPage: csrf meta plus app shell is enough without gitlab_url', () => {
  assert.equal(isGitLabPage({ hasGitlabGlobal: false, hasCsrfMeta: true, hasAppShell: true }), true);
});

test('isGitLabPage: csrf meta alone is not enough', () => {
  assert.equal(isGitLabPage({ hasGitlabGlobal: false, hasCsrfMeta: true, hasAppShell: false }), false);
});

test('isGitLabPage: nothing present is not a GitLab page', () => {
  assert.equal(isGitLabPage({ hasGitlabGlobal: false, hasCsrfMeta: false, hasAppShell: false }), false);
});

test('isMergeRequestPath matches a merge-request path and rejects everything else', () => {
  assert.equal(isMergeRequestPath('/group/project/-/merge_requests/42'), true);
  assert.equal(isMergeRequestPath('/group/project/-/merge_requests/42/diffs'), true);
  assert.equal(isMergeRequestPath('/group/project/-/issues'), false);
  assert.equal(isMergeRequestPath(''), false);
  assert.equal(isMergeRequestPath(undefined), false);
});

test('shouldShowFirstRun: stored version below current shows onboarding', () => {
  assert.equal(shouldShowFirstRun(0, 11), true);
  assert.equal(shouldShowFirstRun(10, 11), true);
});

test('shouldShowFirstRun: stored version at or above current does not show onboarding', () => {
  assert.equal(shouldShowFirstRun(11, 11), false);
  assert.equal(shouldShowFirstRun(12, 11), false);
});

test('shouldShowFirstRun: a missing stored version (undefined) shows onboarding', () => {
  assert.equal(shouldShowFirstRun(undefined, 11), true);
});

test('onboardingFeatureIcon: brand uses the threaded-in icon URL', () => {
  const markup = onboardingFeatureIcon('brand', { brandIconUrl: 'chrome-extension://golens/assets/icons/golens-32.png' });
  assert.match(markup, /data-feature-icon="brand"/);
  assert.match(markup, /src="chrome-extension:\/\/golens\/assets\/icons\/golens-32\.png"/);
});

test('onboardingFeatureIcon: a known non-brand name renders an inline svg', () => {
  const markup = onboardingFeatureIcon('hover');
  assert.match(markup, /data-feature-icon="hover"/);
  assert.match(markup, /<svg/);
});

test('onboardingFeatureIcon: an unknown name renders nothing', () => {
  assert.equal(onboardingFeatureIcon('does-not-exist'), '');
});
