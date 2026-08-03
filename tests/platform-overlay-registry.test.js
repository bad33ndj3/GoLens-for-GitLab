import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOverlayRegistry } from '../page/platform/overlay-registry.js';

test('isAnyOpen() is false when nothing has claimed', () => {
  const registry = createOverlayRegistry();
  assert.equal(registry.isAnyOpen(), false);
});

test('claim(name) opens the registry; calling its release closes it again', () => {
  const registry = createOverlayRegistry();
  const release = registry.claim('onboarding');
  assert.equal(registry.isAnyOpen(), true);
  release();
  assert.equal(registry.isAnyOpen(), false);
});

test('release() is idempotent: calling it more than once does not desync the count', () => {
  const registry = createOverlayRegistry();
  const release = registry.claim('onboarding');
  release();
  release();
  release();
  assert.equal(registry.isAnyOpen(), false);
});

test('claiming the same name twice requires releasing both claims before isAnyOpen() goes false', () => {
  const registry = createOverlayRegistry();
  const releaseA = registry.claim('onboarding');
  const releaseB = registry.claim('onboarding');
  assert.equal(registry.isAnyOpen(), true);
  releaseA();
  assert.equal(registry.isAnyOpen(), true, 'a second outstanding claim on the same name keeps it open');
  releaseB();
  assert.equal(registry.isAnyOpen(), false);
});

test('two different overlays can both be open; isAnyOpen() stays true until both release', () => {
  const registry = createOverlayRegistry();
  const releaseOnboarding = registry.claim('onboarding');
  const releaseSettings = registry.claim('settings-overlay');
  assert.equal(registry.isAnyOpen(), true);
  releaseOnboarding();
  assert.equal(registry.isAnyOpen(), true, 'the settings overlay claim is still outstanding');
  releaseSettings();
  assert.equal(registry.isAnyOpen(), false);
});

test('state is a module-scoped singleton: every createOverlayRegistry() call observes the same claims', () => {
  // This is the property go-navigation.js and content.js rely on: they are
  // two separate content scripts, each calling createOverlayRegistry()
  // from its own dynamic import() of this module, and must still see each
  // other's claims without any globalThis contract.
  const claimant = createOverlayRegistry();
  const observer = createOverlayRegistry();
  assert.equal(observer.isAnyOpen(), false);
  const release = claimant.claim('onboarding');
  assert.equal(observer.isAnyOpen(), true, 'a claim made through one instance must be visible through another');
  release();
  assert.equal(observer.isAnyOpen(), false);
});

test('subscribe(fn) is notified on every claim/release transition with the new isAnyOpen() value', () => {
  const registry = createOverlayRegistry();
  const events = [];
  const unsubscribe = registry.subscribe((open) => events.push(open));

  const releaseA = registry.claim('onboarding');
  const releaseB = registry.claim('settings-overlay');
  releaseA();
  releaseB();

  assert.deepEqual(events, [true, true, true, false]);
  unsubscribe();
});

test('subscribe(fn) returns an unsubscribe function that stops further notifications', () => {
  const registry = createOverlayRegistry();
  const events = [];
  const unsubscribe = registry.subscribe((open) => events.push(open));
  unsubscribe();
  const release = registry.claim('onboarding');
  release();
  assert.deepEqual(events, [], 'no notifications should arrive after unsubscribing');
});

test("a subscriber's own error does not break other subscribers or the caller", () => {
  const registry = createOverlayRegistry();
  const events = [];
  registry.subscribe(() => { throw new Error('boom'); });
  registry.subscribe((open) => events.push(open));

  assert.doesNotThrow(() => registry.claim('onboarding'));
  assert.deepEqual(events, [true]);
});
