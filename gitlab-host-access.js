export const GITLAB_DOT_COM_PATTERN = 'https://gitlab.com/*';
export const DYNAMIC_CONTENT_SCRIPT_ID = 'golens-self-hosted-gitlab';
let syncQueue = Promise.resolve();
// Last outcome of performContentScriptSync, kept so a caller that did not
// itself trigger the sync (a fresh settings page load, the startup sync, a
// chrome.permissions.onAdded/onRemoved event) can still learn whether
// self-hosted origins are actually registered. Without this, a failure from
// those background-triggered syncs was reachable only by the
// syncQueue.catch(() => undefined) used to keep the queue chain alive, which
// discarded it.
let lastSyncStatus = { matches: [], error: null };

export function getHostAccessSyncStatus() {
  return { matches: [...lastSyncStatus.matches], error: lastSyncStatus.error };
}

export function normalizeGitLabOrigin(value) {
  const candidate = String(value || '').trim();
  if (!candidate) throw new Error('Enter your self-hosted GitLab URL.');
  if (/\*|%2a/i.test(candidate)) throw new Error('Enter one exact GitLab origin, without wildcards.');
  let url;
  try {
    url = new URL(candidate.includes('://') ? candidate : `https://${candidate}`);
  } catch {
    throw new Error('Enter a valid HTTP or HTTPS GitLab URL.');
  }
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error('Enter a valid HTTP or HTTPS GitLab URL without credentials.');
  }
  return url.origin;
}

export function originPattern(origin) {
  return `${normalizeGitLabOrigin(origin)}/*`;
}

export function grantedSelfHostedPatterns(origins = []) {
  const patterns = new Set();
  for (const value of origins) {
    const candidate = String(value).replace(/\/\*$/, '');
    if (/\*|%2a/i.test(candidate)) continue;
    try {
      const url = new URL(candidate);
      if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) continue;
      const pattern = `${url.origin}/*`;
      if (pattern !== GITLAB_DOT_COM_PATTERN) patterns.add(pattern);
    } catch {
      // Ignore non-host permissions and malformed legacy values.
    }
  }
  return [...patterns].sort();
}

// Self-hosted origins get the exact same content script the manifest
// registers statically for gitlab.com (see manifest.json's content_scripts):
// deriving js/css from the manifest instead of a second hardcoded list keeps
// the two registrations from drifting apart, which is how this broke before
// (content.js/go-navigation.js were replaced by bootstrap.js in the static
// entry but never updated here).
function staticContentScriptFiles(chromeAPI) {
  const [script] = chromeAPI.runtime?.getManifest?.().content_scripts || [];
  if (!script) throw new Error('manifest.json declares no static content script to mirror.');
  return { js: script.js || [], css: script.css || [], runAt: script.run_at || 'document_idle' };
}

async function performContentScriptSync(chromeAPI) {
  if (!chromeAPI?.permissions?.getAll || !chromeAPI?.scripting?.getRegisteredContentScripts) return [];
  const granted = await chromeAPI.permissions.getAll();
  const staticMatches = new Set((chromeAPI.runtime?.getManifest?.().content_scripts || []).flatMap((script) => script.matches || []));
  const matches = grantedSelfHostedPatterns(granted.origins).filter((pattern) => !staticMatches.has(pattern));
  const registered = await chromeAPI.scripting.getRegisteredContentScripts({ ids: [DYNAMIC_CONTENT_SCRIPT_ID] });
  if (registered.length) await chromeAPI.scripting.unregisterContentScripts({ ids: [DYNAMIC_CONTENT_SCRIPT_ID] });
  try {
    if (matches.length) {
      const { js, css, runAt } = staticContentScriptFiles(chromeAPI);
      await chromeAPI.scripting.registerContentScripts([{
        id: DYNAMIC_CONTENT_SCRIPT_ID,
        matches,
        js,
        css,
        runAt,
        persistAcrossSessions: true,
      }]);
    }
    lastSyncStatus = { matches, error: null };
  } catch (error) {
    lastSyncStatus = { matches: [], error: error instanceof Error ? error.message : String(error) };
    throw error;
  }
  return matches;
}

export function syncSelfHostedContentScripts(chromeAPI = globalThis.chrome) {
  const operation = syncQueue.then(() => performContentScriptSync(chromeAPI));
  syncQueue = operation.catch(() => undefined);
  return operation;
}

// The status a caller reads (e.g. the settings host-access UI) must be
// current even when nothing in this module instance has synced yet: an MV3
// service worker terminates after ~30s idle and loses lastSyncStatus on
// restart, so a status request re-syncs (registration is idempotent) instead
// of trusting whatever this fresh instance happens to already know.
export async function refreshHostAccessStatus(chromeAPI = globalThis.chrome) {
  await syncSelfHostedContentScripts(chromeAPI).catch(() => undefined);
  return getHostAccessSyncStatus();
}
