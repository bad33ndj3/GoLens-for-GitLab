// platform/settings-store — the one seam for `chrome.storage` access. Hides
// area layout (sync vs local), `onChanged` plumbing, and default-merging
// behind a small key/value contract so callers never touch `chrome.storage`
// directly. Contract:
//   createSettingsStore() -> { get(key), ready(), subscribe(key, fn), set(key, value) }
//
// Key ownership is a convention this module documents but does not enforce:
// `enabled` belongs to lifecycle, `hideGeneratedFiles` to
// features/generated-files, `shortcutBindings`/`shortcutCoachEnabled` to this
// module itself (the seam toward `settings.js`/`shortcut-settings.js`, which
// stay out of scope and keep writing those keys directly for now).
import { defaultBindings } from '../../shortcut-settings.js';

const SCHEMA = {
  enabled: { area: 'sync', default: true },
  hideGeneratedFiles: { area: 'sync', default: false },
  shortcutCoachEnabled: { area: 'sync', default: true },
  shortcutBindings: {
    area: 'sync',
    default: () => defaultBindings(),
  },
  golensOnboardingVersion: { area: 'local', default: 0 },
};

function resolveDefault(entry) {
  return typeof entry.default === 'function' ? entry.default() : entry.default;
}

export function createSettingsStore({ storage = globalThis.chrome?.storage } = {}) {
  const snapshot = {};
  const listeners = new Map(); // key -> Set<fn>
  const pendingWrites = new Map(); // area -> { values, promise }
  let readyPromise = null;

  function notify(key, value) {
    for (const fn of listeners.get(key) || []) {
      try {
        fn(value);
      } catch {
        // A subscriber's own error must not break the others or the listener.
      }
    }
  }

  async function load() {
    const defaultsByArea = new Map();
    for (const [key, entry] of Object.entries(SCHEMA)) {
      if (!defaultsByArea.has(entry.area)) defaultsByArea.set(entry.area, {});
      defaultsByArea.get(entry.area)[key] = resolveDefault(entry);
    }
    for (const [area, areaDefaults] of defaultsByArea) {
      const values = await storage[area].get(areaDefaults);
      Object.assign(snapshot, values);
    }
    storage.onChanged?.addListener((changes, areaName) => {
      for (const [key, entry] of Object.entries(SCHEMA)) {
        if (entry.area !== areaName || !(key in changes)) continue;
        snapshot[key] = changes[key].newValue;
        notify(key, snapshot[key]);
      }
    });
  }

  function ready() {
    if (!readyPromise) readyPromise = load();
    return readyPromise;
  }

  function get(key) {
    return snapshot[key];
  }

  function subscribe(key, fn) {
    if (!listeners.has(key)) listeners.set(key, new Set());
    listeners.get(key).add(fn);
    return () => listeners.get(key)?.delete(fn);
  }

  // Writes a key, persisting it to its owning area. Calls made synchronously
  // (in the same microtask turn) against the same area are coalesced into a
  // single `chrome.storage.<area>.set` call, so callers that stage several
  // keys together (e.g. saving a settings form) still produce one write.
  function set(key, value) {
    const entry = SCHEMA[key];
    if (!entry) throw new Error(`settings-store: unknown key "${key}"`);
    snapshot[key] = value;
    let batch = pendingWrites.get(entry.area);
    if (!batch) {
      batch = { values: {} };
      batch.promise = Promise.resolve().then(async () => {
        pendingWrites.delete(entry.area);
        await storage[entry.area].set(batch.values);
      });
      pendingWrites.set(entry.area, batch);
    }
    batch.values[key] = value;
    return batch.promise;
  }

  return { get, ready, subscribe, set };
}
