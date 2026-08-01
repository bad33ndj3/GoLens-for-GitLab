import contentScript from './content-script-registration.json' with { type: 'json' };

export function normalizeGitLabOrigin(value: unknown): string {
  const candidate = String(value || '').trim();
  if (!candidate) throw new Error('Enter your self-hosted GitLab URL.');
  if (/\*|%2a/i.test(candidate)) throw new Error('Enter one exact GitLab origin, without wildcards.');
  let url: URL;
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

export function registerRewriteContentScript(id: string, matches: string[], scripting = chrome.scripting): Promise<void> {
  return scripting.registerContentScripts([{
    id,
    matches,
    ...contentScript,
    runAt: 'document_idle',
  }]);
}

const DYNAMIC_ID = 'golens-self-hosted-gitlab-rewrite';

function grantedPatterns(origins: readonly string[] = []): string[] {
  const patterns = new Set<string>();
  for (const value of origins) {
    try {
      const origin = normalizeGitLabOrigin(value.replace(/\/\*$/, ''));
      if (origin !== 'https://gitlab.com') patterns.add(`${origin}/*`);
    } catch { /* Ignore unrelated and malformed host permissions. */ }
  }
  return [...patterns].sort();
}

export function createSelfHostedAccess(api: Pick<typeof chrome, 'permissions' | 'scripting'> = chrome) {
  async function list(): Promise<readonly string[]> {
    return grantedPatterns((await api.permissions.getAll()).origins);
  }
  async function sync(): Promise<void> {
    const matches = await list();
    const registered = await api.scripting.getRegisteredContentScripts({ ids: [DYNAMIC_ID] });
    if (registered.length) await api.scripting.unregisterContentScripts({ ids: [DYNAMIC_ID] });
    if (matches.length) await registerRewriteContentScript(DYNAMIC_ID, [...matches], api.scripting);
  }
  return Object.freeze({
    list,
    async add(value: unknown): Promise<void> {
      const origin = normalizeGitLabOrigin(value);
      if (origin === 'https://gitlab.com') return;
      if (!await api.permissions.request({ origins: [`${origin}/*`] })) throw new Error(`Access to ${origin} was not granted.`);
      await sync();
    },
    async remove(pattern: string): Promise<void> {
      await api.permissions.remove({ origins: [pattern] });
      await sync();
    },
  });
}
