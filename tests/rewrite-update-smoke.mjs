import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname;
const build = join(root, 'scripts', 'build-extension.mjs');
const extension = join(root, 'dist', 'extension');
const profile = await mkdtemp(join(tmpdir(), 'golens-rewrite-update-'));
const browserPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROME_BIN;
const launch = () => chromium.launchPersistentContext(profile, {
  ...(browserPath ? { executablePath: browserPath } : { channel: 'chromium' }),
  headless: !browserPath,
  args: [...(browserPath ? ['--headless=new'] : []), `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const fixture = `<!doctype html><html><head><meta name="csrf-token" content="fixture"></head><body>
  <div class="layout-page is-merge-request"><div class="ai-panels"><div><nav><div><button aria-label="GitLab Duo">AI</button></div></nav></div></div></div>
  <main data-diffs></main></body></html>`;
const refs = { baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), startSha: 'c'.repeat(40) };

function runBuild(epoch) {
  execFileSync(process.execPath, [build, ...(epoch ? ['--architecture-epoch', String(epoch)] : [])], { cwd: root, stdio: 'inherit' });
}

async function workerFor(context) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const worker of context.serviceWorkers()) {
      const manifest = await worker.evaluate(() => globalThis.chrome?.runtime?.getManifest()).catch(() => null);
      if (manifest?.name === 'GoLens for GitLab') return worker;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('GoLens extension worker did not start');
}

async function routeGitLab(context) {
  await context.route('https://gitlab.com/**', (route) => route.request().url().endsWith('/api/graphql')
    ? route.fulfill({ json: { data: { project: { mergeRequest: { diffRefs: refs } } } } })
    : route.fulfill({ contentType: 'text/html', body: fixture }));
}

let context;
try {
  runBuild(1);
  context = await launch();
  let worker = await workerFor(context);
  await worker.evaluate(async () => {
    await chrome.storage.sync.set({ enabled: false, shortcutBindings: { nextFile: 'KeyQ' } });
    await chrome.storage.local.set({ golensOnboardingVersion: 12, legacyBookmark: true });
    await new Promise((resolve, reject) => {
      const opening = indexedDB.open('golens-go-intelligence-cache', 1);
      opening.onupgradeneeded = () => opening.result.createObjectStore('records', { keyPath: 'id' });
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const transaction = opening.result.transaction('records', 'readwrite');
        transaction.objectStore('records').put({ id: 'legacy' });
        transaction.oncomplete = () => { opening.result.close(); resolve(); };
        transaction.onerror = () => reject(transaction.error);
      };
    });
  });
  await routeGitLab(context);
  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://gitlab.com/group/project/-/merge_requests/42/diffs');
  const notice = page.getByRole('dialog', { name: 'GoLens was rebuilt' });
  try {
    await notice.waitFor({ timeout: 10_000 });
  } catch {
    const state = await page.evaluate(() => ({ roots: [...document.querySelectorAll('[id^="golens"]')].map((node) => node.id), body: document.body.textContent?.slice(0, 200) }));
    const storage = await worker.evaluate(() => Promise.all([chrome.storage.sync.get(), chrome.storage.local.get()]));
    assert.fail(`upgrade notice did not open; state=${JSON.stringify(state)} storage=${JSON.stringify(storage)}`);
  }
  const reset = await worker.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const opening = indexedDB.open('golens-go-intelligence-cache', 1);
      opening.onsuccess = () => resolve(opening.result);
      opening.onerror = () => reject(opening.error);
    });
    const count = await new Promise((resolve, reject) => {
      const request = database.transaction('records').objectStore('records').count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    return Promise.all([chrome.storage.sync.get(), chrome.storage.local.get(), count]);
  });
  assert.deepEqual(reset, [{}, { golensArchitectureEpoch: 1, golensUpgradeNoticePending: true }, 0]);

  await page.keyboard.press('Escape');
  await notice.waitFor({ state: 'detached' });
  await page.evaluate(() => { history.pushState({}, '', '/group/project/-/merge_requests/43/diffs'); dispatchEvent(new Event('turbo:load')); });
  await notice.waitFor();
  await notice.getByRole('button', { name: 'Continue setup' }).click();
  const setup = page.getByRole('dialog', { name: 'Set up GoLens' });
  await setup.waitFor();
  assert.equal((await worker.evaluate(() => chrome.storage.local.get('golensUpgradeNoticePending'))).golensUpgradeNoticePending, false);
  await setup.getByRole('button', { name: 'Finish setup' }).click();
  await page.evaluate(() => { history.pushState({}, '', '/group/project/-/merge_requests/44/diffs'); dispatchEvent(new Event('turbo:load')); });
  await page.waitForTimeout(200);
  assert.equal(await notice.count(), 0);
  console.log('Rewrite extension update passed.');
} finally {
  await context?.close();
  runBuild();
  await rm(profile, { recursive: true, force: true });
}
