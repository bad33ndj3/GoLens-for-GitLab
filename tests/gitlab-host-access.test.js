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

// Stateful fake: getRegisteredContentScripts reflects whatever the most
// recent register/unregister call actually did, the way chrome.scripting
// behaves (and, with persistAcrossSessions:true, keeps behaving across a
// service-worker restart) — needed so tests can tell "we attempted to
// register" apart from "chrome.scripting currently has this registered".
function fakeChromeAPI({ origins, registerContentScripts } = {}) {
  const calls = [];
  let registration = null;
  return {
    calls,
    permissions: { async getAll() { return { origins }; } },
    runtime: { getManifest: () => manifest },
    scripting: {
      async getRegisteredContentScripts() { return registration ? [registration] : []; },
      async unregisterContentScripts(options) {
        calls.push(['unregister', options]);
        registration = null;
      },
      async registerContentScripts(scripts) {
        calls.push(['register', scripts]);
        if (registerContentScripts) return registerContentScripts(scripts);
        registration = { id: scripts[0].id, matches: scripts[0].matches };
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

test('refreshHostAccessStatus reads live chrome.scripting registration, so a persisted registration survives a service-worker restart without needing to resync', async () => {
  // persistAcrossSessions:true means chrome keeps a successful registration across an MV3
  // service-worker restart even though this module's in-memory lastSyncStatus is gone. This
  // chromeAPI's "chrome.scripting" already has the registration from a run before this test
  // ever calls syncSelfHostedContentScripts against it, standing in for that restart.
  const chromeAPI = fakeChromeAPI({ origins: ['https://gitlab.example.com/*'] });
  await syncSelfHostedContentScripts(chromeAPI);
  const registerCallsAfterSync = chromeAPI.calls.filter(([kind]) => kind === 'register').length;

  const status = await refreshHostAccessStatus(chromeAPI);
  assert.deepEqual(status.matches, ['https://gitlab.example.com/*']);
  // A status read must not itself register/unregister anything: it answers from chrome's
  // current registration, it does not perform a fresh sync (which would risk leaving the
  // origin unregistered if a re-register attempt failed midway through a mere status check).
  assert.equal(chromeAPI.calls.filter(([kind]) => kind === 'register').length, registerCallsAfterSync);
});

test('refreshHostAccessStatus reports a granted-but-not-yet-registered origin as inactive, and carries the last sync failure reason', async () => {
  const neverSynced = fakeChromeAPI({ origins: ['https://gitlab.example.com/*'] });
  const beforeAnySync = await refreshHostAccessStatus(neverSynced);
  assert.deepEqual(beforeAnySync.matches, [], 'granted permission alone must not read as an active registration');

  const failing = fakeChromeAPI({
    origins: ['https://gitlab.example.com/*'],
    registerContentScripts: () => { throw new Error('scripting.registerContentScripts failed: boom'); },
  });
  await assert.rejects(syncSelfHostedContentScripts(failing));
  const failedStatus = await refreshHostAccessStatus(failing);
  assert.match(failedStatus.error, /boom/);
  assert.deepEqual(failedStatus.matches, []);
});

test('filters GitLab.com and wildcard declarations from approved origin listings', () => {
  assert.deepEqual(
    grantedSelfHostedPatterns(['https://gitlab.com/*', 'http://*/*', 'https://*/*', 'http://%2A/*', 'https://%2A/*', 'https://gitlab.example.com/group']),
    ['https://gitlab.example.com/*'],
  );
});
