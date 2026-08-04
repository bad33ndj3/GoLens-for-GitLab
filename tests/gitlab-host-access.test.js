import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  DYNAMIC_CONTENT_SCRIPT_ID,
  getHostAccessSyncStatus,
  grantedSelfHostedPatterns,
  normalizeGitLabOrigin,
  originPattern,
  refreshHostAccessStatus,
  syncSelfHostedContentScripts,
} from '../gitlab-host-access.js';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));

function fakeChromeAPI({ origins, registerContentScripts } = {}) {
  const calls = [];
  return {
    calls,
    permissions: { async getAll() { return { origins }; } },
    runtime: { getManifest: () => manifest },
    scripting: {
      async getRegisteredContentScripts() { return [{ id: DYNAMIC_CONTENT_SCRIPT_ID }]; },
      async unregisterContentScripts(options) { calls.push(['unregister', options]); },
      async registerContentScripts(scripts) {
        calls.push(['register', scripts]);
        if (registerContentScripts) return registerContentScripts(scripts);
      },
    },
  };
}

test('manifest limits automatic access to GitLab.com and keeps self-hosted access optional', async () => {
  const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.host_permissions, ['https://gitlab.com/*']);
  assert.deepEqual(manifest.optional_host_permissions, ['http://*/*', 'https://*/*']);
  assert.deepEqual(manifest.content_scripts[0].matches, ['https://gitlab.com/*']);
  assert.deepEqual(manifest.content_scripts[0].js, ['bootstrap.js']);
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
    runtime: { getManifest: () => manifest },
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
  assert.deepEqual(registration.js, manifest.content_scripts[0].js);
  assert.deepEqual(registration.css, manifest.content_scripts[0].css);
  assert.equal(registration.persistAcrossSessions, true);
});

test('dynamic self-hosted registration mirrors the static manifest content script exactly', async () => {
  const chromeAPI = fakeChromeAPI({ origins: ['https://gitlab.example.com/*'] });
  await syncSelfHostedContentScripts(chromeAPI);
  const registration = chromeAPI.calls.find(([kind]) => kind === 'register')[1][0];
  assert.deepEqual(registration.js, manifest.content_scripts[0].js);
  assert.deepEqual(registration.css, manifest.content_scripts[0].css);
  assert.equal(registration.runAt, manifest.content_scripts[0].run_at);
});

test('every js/css file registered for self-hosted origins exists in the repository', async () => {
  // Regression guard for the bug this fix addresses: registerContentScripts
  // was hardcoded to a file list (content.js, go-navigation.js) that no
  // longer existed on disk, so registration silently threw and self-hosted
  // origins got zero functionality. Any future drift between the static
  // manifest content script and this dynamic registration should fail here.
  const chromeAPI = fakeChromeAPI({ origins: ['https://gitlab.example.com/*'] });
  await syncSelfHostedContentScripts(chromeAPI);
  const registration = chromeAPI.calls.find(([kind]) => kind === 'register')[1][0];
  for (const relativePath of [...registration.js, ...registration.css]) {
    assert.ok(existsSync(new URL(`../${relativePath}`, import.meta.url)), `${relativePath} does not exist on disk`);
  }
});

test('reports a registration failure through getHostAccessSyncStatus instead of swallowing it', async () => {
  const chromeAPI = fakeChromeAPI({
    origins: ['https://gitlab.example.com/*'],
    registerContentScripts: () => { throw new Error('scripting.registerContentScripts failed: file not found'); },
  });
  await assert.rejects(syncSelfHostedContentScripts(chromeAPI), /file not found/);
  const status = getHostAccessSyncStatus();
  assert.match(status.error, /file not found/);
  assert.deepEqual(status.matches, []);
});

test('reports a successful sync through getHostAccessSyncStatus', async () => {
  const chromeAPI = fakeChromeAPI({ origins: ['https://gitlab.example.com/*'] });
  const matches = await syncSelfHostedContentScripts(chromeAPI);
  const status = getHostAccessSyncStatus();
  assert.equal(status.error, null);
  assert.deepEqual(status.matches, matches);
});

test('refreshHostAccessStatus resyncs before reporting, so a terminated-and-restarted service worker still answers correctly', async () => {
  // getHostAccessSyncStatus alone would answer from whatever this module instance
  // last recorded; an MV3 service worker can be killed and restarted between syncs,
  // losing that in-memory state. refreshHostAccessStatus must recompute rather than
  // recall, regardless of what a prior sync (in this same test process) left behind.
  const failing = fakeChromeAPI({
    origins: ['https://gitlab.example.com/*'],
    registerContentScripts: () => { throw new Error('scripting.registerContentScripts failed: boom'); },
  });
  const failedStatus = await refreshHostAccessStatus(failing);
  assert.match(failedStatus.error, /boom/);
  assert.deepEqual(failedStatus.matches, []);

  const healthy = fakeChromeAPI({ origins: ['https://gitlab.example.com/*'] });
  const healthyStatus = await refreshHostAccessStatus(healthy);
  assert.equal(healthyStatus.error, null);
  assert.deepEqual(healthyStatus.matches, ['https://gitlab.example.com/*']);
});

test('filters GitLab.com and wildcard declarations from approved origin listings', () => {
  assert.deepEqual(
    grantedSelfHostedPatterns(['https://gitlab.com/*', 'http://*/*', 'https://*/*', 'http://%2A/*', 'https://%2A/*', 'https://gitlab.example.com/group']),
    ['https://gitlab.example.com/*'],
  );
});
