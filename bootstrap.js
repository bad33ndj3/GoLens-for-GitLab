// bootstrap.js — thin content script that loads the real ES-module page
// skeleton (ticket 05, prototype verdict in ticket 04 §7). Its only job is
// `import(chrome.runtime.getURL('page/main.js'))` and mounting it; the
// module graph underneath does the actual work.
//
// SPA navigation: the isolated world does not reliably observe page-world
// `pushState` calls, so re-mounting after an in-page GitLab navigation is
// driven by polling `location.href` (per ticket 04 §7's prototype finding),
// not by hooking `history`.
//
// Message seam (ticket 16). This file is a classic content script, so its
// `chrome.runtime.onMessage` listener exists from the moment the script is
// evaluated. The module graph does not: it is reachable only through an async
// `import()`, so a listener registered *inside* it is absent for the first
// ~15-30ms after page load and, again, for the whole unmount/import/mount gap
// of every SPA re-mount. Ticket 16's first attempt registered there and lost
// every message that landed in those windows — in production, a popup click
// during page load did nothing, silently. So registration lives here, and
// messages are held until a handle exists (`withHandle`).
//
// This listener is also the *responder* for the message types whose feature
// has migrated into the module graph. `page/lifecycle` deliberately never
// calls `sendResponse`, so something outside it has to, and the answer must
// reflect what actually happened: popup.js's `activeTabRequest` throws on
// `!ok` and shows the user the error text. Hence `return true` (keep the
// channel open), await the handle, dispatch, and map the feature's
// kind-discriminated outcome onto the exact `{ ok, result }` / `{ ok, error }`
// envelope content.js used to produce for the same message.
(() => {
  const NAV_POLL_MS = 200;

  // Message types this listener answers. Must stay a subset of
  // page/lifecycle/internal.js's FEATURE_ROUTES whose feature is actually
  // mounted by page/main.js — tests/bootstrap-message-seam.test.js asserts
  // that. Anything outside this set is still forwarded to the module graph,
  // but left for content.js/go-navigation.js to answer: claiming a type they
  // already respond to synchronously would put two responders on one message.
  const RESPONDED_TYPES = [
    'golens-show-settings',
    'golens-close-settings',
    'golens-settings-ready',
    'golens-show-onboarding',
  ];

  let currentHandle = null;
  let mountPromise = null;
  let mountCount = 0;
  // Bumped on every mount attempt so two navigations racing inside one
  // `import()` tick can't both apply: a stale attempt's result is discarded
  // instead of leaking a handle nothing ever unmounts.
  let generation = 0;

  async function mountPage() {
    const myGeneration = ++generation;
    if (currentHandle) {
      currentHandle.unmount();
      currentHandle = null;
    }
    try {
      const mod = await import(chrome.runtime.getURL('page/main.js'));
      if (myGeneration !== generation) return;
      currentHandle = mod.mount();
      mountCount += 1;
      document.documentElement.dataset.golensSkeletonMountCount = String(mountCount);
    } catch (error) {
      if (myGeneration !== generation) return;
      document.documentElement.dataset.golensSkeletonError = String((error && error.message) || error);
    }
  }

  function remount() {
    mountPromise = mountPage();
    return mountPromise;
  }

  // Resolves once the in-flight mount settles, so a message that arrives
  // during page load or mid-re-mount is dispatched against the handle that
  // mount produces instead of being dropped. `mountPage` never rejects; a
  // failed import leaves `currentHandle` null and is answered as a failure.
  async function withHandle() {
    await mountPromise;
    return currentHandle;
  }

  // Mirrors, exactly, the envelopes content.js produced for these three
  // messages before the feature moved (ticket 16). `outcome` is the feature
  // handle's kind-discriminated return value, or `undefined` when the module
  // graph failed to load — the one case content.js could never produce, and
  // the only one that reports a load failure rather than a page-type problem.
  function envelopeFor(type, outcome) {
    const kind = outcome && outcome.kind;
    if (!kind) return { ok: false, error: 'GoLens could not load on this page.' };
    if (type === 'golens-show-settings') {
      if (kind === 'not-gitlab') return { ok: false, error: 'Open a supported GitLab page first.' };
      return { ok: true, result: { shown: true } };
    }
    if (type === 'golens-close-settings') return { ok: true, result: { closed: true } };
    if (type === 'golens-show-onboarding') {
      if (kind === 'not-gitlab') return { ok: false, error: 'Open a GitLab merge request first.' };
      return { ok: true, result: { shown: true } };
    }
    // golens-settings-ready: content.js answered `ok: Boolean(host)`.
    const isReady = kind === 'ready';
    return { ok: isReady, result: { ready: isReady } };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = message && message.type;
    if (!type) return undefined;
    if (RESPONDED_TYPES.indexOf(type) === -1) {
      // Not ours to answer, but the module graph still needs to see it.
      withHandle().then((handle) => { if (handle) handle.dispatch(message); });
      return undefined;
    }
    withHandle().then((handle) => {
      sendResponse(envelopeFor(type, handle && handle.dispatch(message)));
    });
    return true;
  });

  remount();

  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    remount();
  }, NAV_POLL_MS);

  // Test seam only (node imports this file's behavior through a harness);
  // no production code reads it.
  globalThis.GoLensBootstrap = { __test: { RESPONDED_TYPES, envelopeFor } };
})();
