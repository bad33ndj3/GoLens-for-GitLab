import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  DYNAMIC_CONTENT_SCRIPT_ID,
  grantedSelfHostedPatterns,
  normalizeGitLabOrigin,
  originPattern,
  syncSelfHostedContentScripts,
} from '../gitlab-host-access.js';

test('manifest limits automatic access to GitLab.com and keeps self-hosted access optional', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['https://gitlab.com/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://gitlab.com/*']);
  assert.deepEqual(manifest.content_scripts[0].js, ['shortcut-settings.js', 'go-navigation.js', 'content.js']);
  assert.ok(manifest.permissions.includes('scripting'));
});

test('normalizes user-approved GitLab origins without broadening paths', () => {
  assert.equal(normalizeGitLabOrigin('gitlab.example.com/group/project'), 'https://gitlab.example.com');
  assert.equal(normalizeGitLabOrigin('http://gitlab.internal:8080/root'), 'http://gitlab.internal:8080');
  assert.equal(originPattern('https://gitlab.example.com/path'), 'https://gitlab.example.com/*');
  assert.throws(() => normalizeGitLabOrigin('ftp://gitlab.example.com'), /HTTP or HTTPS/);
  assert.throws(() => normalizeGitLabOrigin('https://user:secret@gitlab.example.com'), /without credentials/);
  assert.throws(() => normalizeGitLabOrigin('https://*'), /without wildcards/);
  assert.throws(() => normalizeGitLabOrigin('https://%2A'), /without wildcards/);
});

test('registers content scripts only for granted self-hosted origins', async () => {
  const calls = [];
  const chromeAPI = {
    permissions: {
      async getAll() {
        return { origins: ['http://*/*', 'https://*/*', 'https://gitlab.com/*', 'https://gitlab.example.com/*', 'http://gitlab.internal:8080/*'] };
      },
    },
    scripting: {
      async getRegisteredContentScripts() { return [{ id: DYNAMIC_CONTENT_SCRIPT_ID }]; },
      async unregisterContentScripts(options) { calls.push(['unregister', options]); },
      async registerContentScripts(scripts) { calls.push(['register', scripts]); },
    },
  };

  const matches = await syncSelfHostedContentScripts(chromeAPI);
  assert.deepEqual(matches, ['http://gitlab.internal:8080/*', 'https://gitlab.example.com/*']);
  assert.deepEqual(calls[0], ['unregister', { ids: [DYNAMIC_CONTENT_SCRIPT_ID] }]);
  const registration = calls[1][1][0];
  assert.equal(registration.id, DYNAMIC_CONTENT_SCRIPT_ID);
  assert.deepEqual(registration.matches, matches);
  assert.deepEqual(registration.js, ['shortcut-settings.js', 'go-navigation.js', 'content.js']);
  assert.deepEqual(registration.css, ['golens-theme.css', 'gitlab-lens.css']);
  assert.equal(registration.persistAcrossSessions, true);
});

test('filters GitLab.com and wildcard declarations from approved origin listings', () => {
  assert.deepEqual(
    grantedSelfHostedPatterns(['https://gitlab.com/*', 'http://*/*', 'https://*/*', 'http://%2A/*', 'https://%2A/*', 'https://gitlab.example.com/group']),
    ['https://gitlab.example.com/*'],
  );
});
