import contentScript from './content-script-registration.json';

export function registerRewriteContentScript(id: string, matches: string[]): Promise<void> {
  return chrome.scripting.registerContentScripts([{
    id,
    matches,
    ...contentScript,
    runAt: 'document_idle',
  }]);
}
