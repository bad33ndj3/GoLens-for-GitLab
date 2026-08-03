import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPageTransition, routeMessage } from '../page/lifecycle/internal.js';

test('classifyPageTransition(url, prev) returns "initial" when there is no prior url', () => {
  assert.equal(classifyPageTransition('https://gitlab.com/a', null), 'initial');
  assert.equal(classifyPageTransition('https://gitlab.com/a', undefined), 'initial');
});

test('classifyPageTransition(url, prev) returns "unchanged" for the same url', () => {
  assert.equal(classifyPageTransition('https://gitlab.com/a', 'https://gitlab.com/a'), 'unchanged');
});

test('classifyPageTransition(url, prev) returns "navigation" for a different url', () => {
  assert.equal(classifyPageTransition('https://gitlab.com/b', 'https://gitlab.com/a'), 'navigation');
});

test('classifyPageTransition is total: never throws on odd input', () => {
  assert.doesNotThrow(() => classifyPageTransition('', ''));
  assert.doesNotThrow(() => classifyPageTransition(undefined, undefined));
});

test('routeMessage routes golens-enabled to the lifecycle itself, not a feature', () => {
  assert.deepEqual(routeMessage({ type: 'golens-enabled', enabled: false }), { kind: 'lifecycle', action: 'setEnabled' });
});

test('routeMessage routes known feature message types to {feature, action}', () => {
  assert.deepEqual(routeMessage({ type: 'golens-cache-invalidated' }), { kind: 'routed', feature: 'mr-preload', action: 'invalidateCache' });
  assert.deepEqual(routeMessage({ type: 'golens-preload-full-project' }), { kind: 'routed', feature: 'mr-preload', action: 'preloadFullProject' });
  assert.deepEqual(routeMessage({ type: 'golens-full-project-status' }), { kind: 'routed', feature: 'mr-preload', action: 'fullProjectStatus' });
  assert.deepEqual(routeMessage({ type: 'golens-show-onboarding' }), { kind: 'routed', feature: 'onboarding', action: 'show' });
  assert.deepEqual(routeMessage({ type: 'golens-show-settings' }), { kind: 'routed', feature: 'settings-overlay', action: 'show' });
  assert.deepEqual(routeMessage({ type: 'golens-close-settings' }), { kind: 'routed', feature: 'settings-overlay', action: 'close' });
  assert.deepEqual(routeMessage({ type: 'golens-settings-ready' }), { kind: 'routed', feature: 'settings-overlay', action: 'ready' });
});

test('routeMessage returns {kind: "unrouted"} for unknown or malformed messages', () => {
  assert.deepEqual(routeMessage({ type: 'golens-something-else' }), { kind: 'unrouted' });
  assert.deepEqual(routeMessage({}), { kind: 'unrouted' });
  assert.deepEqual(routeMessage(undefined), { kind: 'unrouted' });
  assert.deepEqual(routeMessage(null), { kind: 'unrouted' });
  assert.deepEqual(routeMessage('not-an-object'), { kind: 'unrouted' });
});
