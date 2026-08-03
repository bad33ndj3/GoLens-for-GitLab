// bootstrap.js — thin content script that loads the real ES-module page
// skeleton (ticket 05, prototype verdict in ticket 04 §7). Its only job is
// `import(chrome.runtime.getURL('page/main.js'))` and mounting it; the
// module graph underneath does the actual work.
//
// SPA navigation: the isolated world does not reliably observe page-world
// `pushState` calls, so re-mounting after an in-page GitLab navigation is
// driven by polling `location.href` (per ticket 04 §7's prototype finding),
// not by hooking `history`.
(() => {
  const NAV_POLL_MS = 200;
  let currentHandle = null;
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

  mountPage();

  let lastHref = location.href;
  setInterval(() => {
    if (location.href === lastHref) return;
    lastHref = location.href;
    mountPage();
  }, NAV_POLL_MS);
})();
