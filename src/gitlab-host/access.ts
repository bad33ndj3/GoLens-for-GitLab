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

export function registerRewriteContentScript(id: string, matches: string[]): Promise<void> {
  return chrome.scripting.registerContentScripts([{
    id,
    matches,
    ...contentScript,
    runAt: 'document_idle',
  }]);
}
