export const GITLAB_DOT_COM_PATTERN = 'https://gitlab.com/*';
export const DYNAMIC_CONTENT_SCRIPT_ID = 'golens-self-hosted-gitlab';
let syncQueue = Promise.resolve();

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

async function performContentScriptSync(chromeAPI) {
  if (!chromeAPI?.permissions?.getAll || !chromeAPI?.scripting?.getRegisteredContentScripts) return [];
  const granted = await chromeAPI.permissions.getAll();
  const staticMatches = new Set((chromeAPI.runtime?.getManifest?.().content_scripts || []).flatMap((script) => script.matches || []));
  const matches = grantedSelfHostedPatterns(granted.origins).filter((pattern) => !staticMatches.has(pattern));
  const registered = await chromeAPI.scripting.getRegisteredContentScripts({ ids: [DYNAMIC_CONTENT_SCRIPT_ID] });
  if (registered.length) await chromeAPI.scripting.unregisterContentScripts({ ids: [DYNAMIC_CONTENT_SCRIPT_ID] });
  if (matches.length) {
    await chromeAPI.scripting.registerContentScripts([{
      id: DYNAMIC_CONTENT_SCRIPT_ID,
      matches,
      js: ['go-navigation.js', 'content.js'],
      css: ['golens-theme.css', 'gitlab-lens.css'],
      runAt: 'document_idle',
      persistAcrossSessions: true,
    }]);
  }
  return matches;
}

export function syncSelfHostedContentScripts(chromeAPI = globalThis.chrome) {
  const operation = syncQueue.then(() => performContentScriptSync(chromeAPI));
  syncQueue = operation.catch(() => undefined);
  return operation;
}
