// PROTOTYPE — throwaway. Answers ticket 04 §7: can a MV3 contentscript reliably
// dynamic-import real ES modules on a strict-CSP GitLab-like page?
// Run: node experiments/proto-bootstrap-import/run.mjs
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { startFixtureServer } from './fixture-server.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const chrome = process.env.CHROME_BIN || [
  '/Applications/Helium.app/Contents/MacOS/Helium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

if (!chrome || !existsSync(chrome)) {
  console.log('No Chrome/Helium binary found. Set CHROME_BIN.');
  process.exit(1);
}

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const DEADLINE_MS = 20000;

async function devToolsPageTarget(port, deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
      const target = targets.find((t) => t.type === 'page' && t.url.startsWith('http://127.0.0.1'));
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // Chrome may announce its endpoint before targets are ready.
    }
    await delay(50);
  }
  throw new Error('page target did not become available');
}

async function connectDevTools(url) {
  const socket = new WebSocket(url);
  await new Promise((res, rej) => {
    const timeout = setTimeout(() => { socket.close(); rej(new Error('DevTools connect timeout')); }, 10000);
    socket.addEventListener('open', () => { clearTimeout(timeout); res(); }, { once: true });
    socket.addEventListener('error', (e) => { clearTimeout(timeout); rej(e); }, { once: true });
  });
  let id = 0;
  const pending = new Map();
  const consoleErrors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
      consoleErrors.push(message.params.entry.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      consoleErrors.push((message.params.args || []).map((a) => a.value ?? a.description).join(' '));
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((res, rej) => {
    const requestID = ++id;
    const timeout = setTimeout(() => { pending.delete(requestID); rej(new Error(`${method} timed out`)); }, 10000);
    pending.set(requestID, {
      resolve(v) { clearTimeout(timeout); res(v); },
      reject(e) { clearTimeout(timeout); rej(e); },
    });
    socket.send(JSON.stringify({ id: requestID, method, params }));
  });
  return { socket, send, consoleErrors };
}

async function stopBrowser(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((r) => child.once('exit', r)),
    delay(2000).then(() => child.kill('SIGKILL')),
  ]);
}

async function runVariant(label, extensionDir, url) {
  const profile = await mkdtemp(resolve(tmpdir(), 'proto-bootstrap-import-'));
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensionDir}`,
    `--load-extension=${extensionDir}`,
    '--remote-debugging-port=0',
    url,
  ];
  if (process.env.CHROME_NO_SANDBOX === '1') args.push('--no-sandbox');
  const child = spawn(chrome, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let endpointResolved = false;
  const endpoint = new Promise((res, rej) => {
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match && !endpointResolved) { endpointResolved = true; res(match[1]); }
    });
    child.once('exit', (code) => {
      if (!endpointResolved) rej(new Error(`Browser exited before DevTools ready (${code})\n${stderr}`));
    });
  });

  let connection;
  const result = { label, ok: false, report: null, consoleErrors: [], chromeVersion: '', navCount: 0, error: null };
  try {
    const endpointURL = new URL(await Promise.race([
      endpoint,
      delay(15000).then(() => { throw new Error(`Browser DevTools not ready\n${stderr}`); }),
    ]));
    const deadline = Date.now() + DEADLINE_MS;
    const target = await devToolsPageTarget(endpointURL.port, deadline);
    connection = await connectDevTools(target.webSocketDebuggerUrl);
    await connection.send('Log.enable');
    await connection.send('Runtime.enable');

    const version = await fetch(`http://127.0.0.1:${endpointURL.port}/json/version`).then((r) => r.json()).catch(() => null);
    result.chromeVersion = version?.Browser || 'unknown';

    while (Date.now() < deadline) {
      const evaluated = await connection.send('Runtime.evaluate', {
        expression: `(() => {
          const attr = document.documentElement.getAttribute('data-proto-report');
          return { attr, navDone: document.body?.dataset.navDone === 'true' };
        })()`,
        returnByValue: true,
      }).catch(() => null);
      const value = evaluated?.result?.value;
      if (value?.attr) {
        try { result.report = JSON.parse(value.attr); } catch { /* keep polling */ }
      }
      const mountCount = result.report?.events?.filter((e) => e.kind === 'mount').length || 0;
      if (value?.navDone && mountCount >= 4) { result.ok = true; break; }
      await delay(75);
    }
    result.navCount = result.report?.events?.filter((e) => e.kind === 'navigation-detected').length || 0;
    result.consoleErrors = connection.consoleErrors.slice();
  } catch (error) {
    result.error = String(error?.message || error);
  } finally {
    connection?.socket.close();
    await stopBrowser(child);
    await rm(profile, { recursive: true, force: true });
  }
  return result;
}

const server = await startFixtureServer();
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;

try {
  const withWAR = await runVariant('with web_accessible_resources', resolve(here, 'extension'), url);
  const withoutWAR = await runVariant('without web_accessible_resources', resolve(here, 'extension-no-war'), url);

  console.log('\n=== PROTO-BOOTSTRAP-IMPORT REPORT ===\n');
  console.log(`Chrome binary: ${chrome}`);
  console.log(`Chrome version: ${withWAR.chromeVersion || withoutWAR.chromeVersion}`);

  for (const result of [withWAR, withoutWAR]) {
    console.log(`\n--- Variant: ${result.label} ---`);
    if (result.error) {
      console.log(`RUN ERROR: ${result.error}`);
      continue;
    }
    const initialMount = result.report?.events?.find((e) => e.kind === 'mount' && e.reason === 'initial');
    const mountError = result.report?.events?.find((e) => e.kind === 'mount-error');
    console.log(`Aspect 1 (dynamic import under strict CSP): ${initialMount ? 'PASS' : 'FAIL'}${mountError ? ` — error: ${mountError.message}` : ''}`);
    console.log(`Aspect 2 (web_accessible_resources requirement, this variant ${result.label.includes('without') ? 'omits' : 'includes'} it): ${result.label.includes('without')
      ? (initialMount ? 'unexpectedly PASSED without WAR' : 'FAIL as expected (blocked without WAR)')
      : (initialMount ? 'PASS' : 'FAIL')}`);
    console.log(`Aspect 3 (bootstrap-start -> mount timing): ${initialMount ? `PASS — ${initialMount.t}ms` : 'FAIL — no timing captured'}`);
    console.log(`Aspect 4 (SPA pushState re-mount, ${result.navCount}/3 navigations detected): ${result.navCount >= 3 && (result.report?.events?.filter((e) => e.kind === 'mount').length || 0) >= 4 ? 'PASS' : 'FAIL'}`);
    console.log(`Aspect 5 (transitive import of platform/clock.js): ${initialMount?.result?.clockValue ? 'PASS' : 'FAIL'}`);
    if (result.consoleErrors.length) console.log(`Console errors: ${JSON.stringify(result.consoleErrors)}`);
    if (result.report) console.log(`Raw report: ${JSON.stringify(result.report)}`);
    else console.log('No report captured before deadline.');
  }
  console.log('\n=== END REPORT ===\n');
} finally {
  server.close();
}
