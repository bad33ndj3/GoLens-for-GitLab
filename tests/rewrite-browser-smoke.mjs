import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname;
const extension = join(root, 'dist', 'extension');
const profile = await mkdtemp(join(tmpdir(), 'golens-rewrite-browser-'));
const browserPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || process.env.CHROME_BIN;
const headSha = 'a'.repeat(40);
const replacementSha = 'c'.repeat(40);
const baseSha = 'b'.repeat(40);
const sources = new Map([
  ['go.mod', 'module example.com/project\n'],
  ['pkg/service.go', `package pkg

type Runner interface { Run() }
func Target() {}
func Use() { Target() }
`],
  ['other/runner.go', `package other

import "example.com/project/pkg"
type Service struct{}
func (Service) Run() {}
var _ pkg.Runner = Service{}
`],
]);
const contentId = (source) => createHash('sha1').update(`blob ${Buffer.byteLength(source)}\0`).update(source).digest('hex');
const sourcePayload = (path) => ({ file_path: path, blob_id: contentId(sources.get(path)), encoding: 'base64', content: Buffer.from(sources.get(path)).toString('base64') });

function diffFile(path, mode = 'rapid', generated = false) {
  const rootAttributes = mode === 'rapid'
    ? `data-testid="rd-diff-file" data-file-data='${JSON.stringify({ old_path: path, new_path: path })}'`
    : `class="diff-file file-holder" data-path="${path}"`;
  return `<diff-file ${rootAttributes}>
    <header data-testid="file-title">${path}<button data-click="showFullFile" onclick="this.closest('diff-file').dataset.expanded='true';this.dataset.click='showChanges'">Native full file</button></header>
    ${generated ? '<div data-testid="diff-file-warning">Generated via .gitattributes <a href="/help/user/project/merge_requests/changes#collapse-generated-files">details</a></div>' : ''}
    <table><tbody>
      <tr role="row" class="new"><td><a data-line-number="3" aria-label="new line 3">3</a></td><td class="line_content"><span>type</span> <span data-symbol="runner">Runner</span> <span>interface</span></td></tr>
      <tr role="row" class="new"><td><a data-line-number="4" aria-label="new line 4">4</a></td><td class="line_content"><span>func</span> <span data-symbol="target-definition">Target</span><span>()</span></td></tr>
      <tr role="row" class="new"><td><a data-line-number="5" aria-label="new line 5">5</a></td><td class="line_content"><span>func Use() { </span><span data-symbol="target-use">Target</span><span>() }</span></td></tr>
    </tbody></table>
  </diff-file>`;
}

function fixture() {
  return `<!doctype html><html><head><meta name="csrf-token" content="fixture"></head><body>
    <div class="layout-page is-merge-request"><div class="ai-panels"><div><nav><div><button aria-label="GitLab Duo">AI</button></div></nav></div></div></div>
    <button data-rapid onclick="document.documentElement.dataset.rapidAccepted='true'">Try Rapid Diffs</button>
    <input data-testid="file-search" aria-label="File search" value="service.go">
    <main data-diffs>${diffFile('pkg/service.go')}${diffFile('pkg/generated.go', 'legacy', true)}</main>
  </body></html>`;
}

async function waitForRoundTrip(worker) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (await worker.evaluate(() => globalThis.__golensRewriteRoundTrip === true)) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail('content script did not reach the extension worker');
}

let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    ...(browserPath ? { executablePath: browserPath } : { channel: 'chromium' }),
    headless: !browserPath,
    reducedMotion: 'reduce',
    args: [...(browserPath ? ['--headless=new'] : []), `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const page = context.pages()[0] || await context.newPage();
  const browserErrors = [];
  const requests = [];
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  let sourceReads = 0;
  const sourceRequests = [];
  await context.route('https://gitlab.com/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    requests.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === '/api/graphql') {
      const iid = JSON.parse(request.postData() || '{}').variables?.iid;
      const currentHead = iid === '43' ? replacementSha : headSha;
      requests.push(`graphql iid=${iid}`);
      return route.fulfill({ json: { data: { project: { mergeRequest: { diffRefs: { baseSha, startSha: baseSha, headSha: currentHead } } } } } });
    }
    if (/\/repository\/tree$/.test(url.pathname)) {
      const entries = [...sources].filter(([path]) => path.endsWith('.go')).map(([path, source]) => ({ type: 'blob', path, id: contentId(source) }));
      return route.fulfill({ json: entries, headers: { 'x-next-page': '' } });
    }
    if (/^\/api\/v4\/projects\/[^/]+\/merge_requests\/\d+\/diffs$/.test(url.pathname)) return route.fulfill({ json: [{ new_path: 'pkg/service.go' }] });
    const fileMatch = url.pathname.match(/\/repository\/files\/(.+)$/);
    if (fileMatch) {
      const path = decodeURIComponent(fileMatch[1]);
      sourceReads++;
      sourceRequests.push(path);
      await new Promise((resolve) => setTimeout(resolve, path === 'other/runner.go' ? 180 : 60));
      return sources.has(path) ? route.fulfill({ json: sourcePayload(path) }) : route.fulfill({ status: 404, json: {} });
    }
    if (/\/approvals$/.test(url.pathname)) return route.fulfill({ json: { state: 'opened', approved_by: [] } });
    if (/\/discussions$/.test(url.pathname) || /\/search$/.test(url.pathname)) return route.fulfill({ json: [] });
    return route.fulfill({ contentType: 'text/html', body: fixture() });
  });

  await page.goto('https://gitlab.com/group/project/-/merge_requests/42/diffs');
  const primaryModifier = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control');
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await waitForRoundTrip(worker);
  assert.match(worker.url(), /\/worker\.js$/);
  const setup = page.locator('#golens-onboarding-root');
  try {
    await setup.getByRole('dialog', { name: 'Set up GoLens' }).waitFor({ timeout: 10_000 });
  } catch {
    const state = await page.evaluate(() => ({ url: location.href, uuid: typeof crypto.randomUUID, meta: Boolean(document.querySelector('meta[name="csrf-token"]')), shell: Boolean(document.querySelector('.layout-page,.ai-panels,[data-testid="super-sidebar"]')), golens: [...document.querySelectorAll('[id^="golens"],golens-host-surface')].map((node) => `${node.tagName}#${node.id}`), body: document.body.innerHTML.slice(0, 300) }));
    const stored = await worker.evaluate(() => Promise.all([chrome.storage.local.get(), chrome.storage.sync.get()]));
    const entry = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true });
      try { return {
        state: await chrome.tabs.sendMessage(tab.id, { type: 'golens:rewrite:state' }),
        guide: await chrome.tabs.sendMessage(tab.id, { type: 'golens:rewrite:show-guide' }),
      }; } catch (error) { return String(error); }
    });
    assert.fail(`setup did not open; state=${JSON.stringify(state)}; entry=${JSON.stringify(entry)}; storage=${JSON.stringify(stored)}; requests=${requests.join(', ')}; errors=${browserErrors.join(' | ')}`);
  }
  assert.equal(await setup.locator('.surface').evaluate((node) => getComputedStyle(node).transitionDuration), '0s');
  await setup.getByRole('checkbox').check();
  await setup.getByRole('button', { name: 'Finish setup' }).click();
  await setup.waitFor({ state: 'detached' });

  const controls = page.getByRole('navigation', { name: 'GoLens review controls' }).getByRole('button');
  await assert.doesNotReject(() => controls.first().waitFor());
  assert.deepEqual(await controls.evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))), [
    'Turn GoLens off', 'Enter review focus', 'Cache related packages', 'Open bookmarks',
  ]);
  assert.equal(await page.locator('html').getAttribute('data-rapid-accepted'), 'true');
  assert.equal(await page.locator('[data-path="pkg/generated.go"]').getAttribute('data-golens-generated-hidden'), '');
  assert.equal(await page.locator('[data-golens-full-file-control]').count(), 2);

  await page.getByRole('button', { name: 'Show full file pkg/service.go' }).click();
  await page.locator('diff-file[data-expanded="true"]').waitFor();
  assert.match(page.url(), /\/diffs$/);

  await page.getByRole('button', { name: 'Enter review focus' }).click();
  await page.locator('html[data-golens-review-focus]').waitFor();
  await page.evaluate(() => document.exitFullscreen());
  await page.locator('html:not([data-golens-review-focus])').waitFor();

  await page.keyboard.press(`${primaryModifier}+p`);
  assert.equal(await page.locator('[data-testid="file-search"]').evaluate((input) => input === document.activeElement), true);
  await page.locator('[data-testid="file-search"]').fill('service.go');
  await page.locator('body').click({ position: { x: 1, y: 1 } });
  await page.keyboard.press('Shift+f');
  assert.equal(await page.locator('[data-testid="file-search"]').inputValue(), '');

  const cache = page.getByRole('button', { name: 'Cache related packages' });
  await cache.click();
  await page.locator('[data-golens-status]').filter({ hasText: 'Caching related packages' }).waitFor({ state: 'attached' });
  await page.getByRole('button', { name: 'Turn GoLens off' }).click();
  await page.getByRole('navigation', { name: 'GoLens review controls' }).waitFor({ state: 'detached' });
  await worker.evaluate(() => chrome.storage.sync.set({ enabled: true }));
  await page.getByRole('button', { name: 'Cache related packages' }).waitFor();
  await page.getByRole('button', { name: 'Cache related packages' }).click();
  await page.locator('[data-golens-status]').filter({ hasText: 'Related package cache is ready.' }).waitFor({ state: 'attached' });
  const coldReads = sourceReads;
  await page.getByRole('button', { name: 'Cache related packages' }).click();
  await page.waitForTimeout(250);
  await page.locator('[data-golens-status]').filter({ hasText: 'Related package cache is ready.' }).waitFor({ state: 'attached' });
  assert.equal(sourceReads, coldReads + 1, `warm Coverage read more than changed-file metadata: ${sourceRequests.join(', ')}`);

  const semanticDiff = page.locator('diff-file').first();
  await semanticDiff.locator('[data-symbol="target-definition"]').hover();
  const hoverSurface = page.locator('[data-golens-active-surface]').getByRole('region');
  await hoverSurface.waitFor();
  assert.match(await hoverSurface.textContent(), /Target/);
  await semanticDiff.locator('[data-symbol="target-definition"]').click();
  await page.keyboard.press('Alt+m');
  await page.locator('[data-golens-status]').filter({ hasText: 'Bookmark added.' }).waitFor({ state: 'attached' });
  await page.getByRole('button', { name: 'Open bookmarks' }).click();
  await page.getByRole('dialog', { name: 'MR bookmarks' }).waitFor();
  await page.getByRole('button', { name: 'Close MR bookmarks' }).click();

  await semanticDiff.locator('[data-symbol="runner"]').click({ modifiers: [primaryModifier] });
  const coverage = page.locator('[data-golens-active-surface]');
  try {
    await coverage.getByText('More coverage needed').waitFor({ timeout: 10_000 });
  } catch {
    const semanticState = await page.evaluate(() => ({ surfaces: [...document.querySelectorAll('[data-golens-active-surface]')].map((node) => node.shadowRoot?.textContent), statuses: [...document.querySelectorAll('[data-golens-status]')].map((node) => node.textContent) }));
    assert.fail(`interface coverage did not open: ${JSON.stringify(semanticState)}`);
  }
  await coverage.getByRole('button', { name: 'Search full project' }).click();
  await coverage.getByRole('button', { name: 'Cancel' }).waitFor();
  await coverage.getByRole('button', { name: 'Cancel' }).click();
  await coverage.getByRole('button', { name: 'Search full project' }).waitFor();

  const replacement = diffFile('pkg/service.go', 'legacy');
  await page.locator('[data-diffs]').evaluate((root, markup) => { root.innerHTML = markup; }, replacement);
  await page.getByRole('navigation', { name: 'GoLens review controls' }).waitFor();
  assert.equal(await page.getByRole('navigation', { name: 'GoLens review controls' }).count(), 1);
  assert.equal(await page.locator('[data-golens-bookmark]').count(), 1);

  await page.evaluate(() => { history.pushState({}, '', '/group/project/-/merge_requests/43/diffs'); dispatchEvent(new Event('turbo:load')); });
  await page.getByRole('navigation', { name: 'GoLens review controls' }).waitFor();
  assert.equal(await page.locator('[data-golens-active-surface]').count(), 0);

  const extensionOrigin = worker.url().replace(/\/worker\.js$/, '');
  const popup = await context.newPage();
  await popup.goto(`${extensionOrigin}/popup.html`);
  await popup.locator('html[data-golens-rewrite-popup="ready"]').waitFor();
  assert.equal(await popup.getByRole('button', { name: 'Open GoLens settings' }).count(), 1);
  await popup.close();

  const settings = await context.newPage();
  await settings.goto(`${extensionOrigin}/settings.html`);
  await settings.locator('html[data-golens-rewrite-settings="ready"]').waitFor();
  const tabs = settings.getByRole('tab');
  assert.deepEqual((await tabs.allTextContents()).map((label) => label.trim()), ['General', 'Shortcuts', 'GitLab access', 'Cache', 'Help']);
  await tabs.first().press('End');
  assert.equal(await tabs.last().getAttribute('aria-selected'), 'true');
  await settings.getByRole('tab', { name: 'GitLab access' }).click();
  await settings.getByRole('textbox', { name: 'GitLab origin' }).fill('ftp://gitlab.example.com');
  await settings.getByRole('button', { name: 'Allow origin' }).click();
  await settings.getByRole('status').filter({ hasText: 'valid HTTP or HTTPS' }).waitFor();
  await settings.close();

  await page.bringToFront();
  await worker.evaluate(async (url) => {
    const [tab] = await chrome.tabs.query({ url });
    await chrome.tabs.sendMessage(tab.id, { type: 'golens:rewrite:open-settings' });
  }, page.url());
  const overlay = page.locator('#golens-settings-root');
  await overlay.getByRole('dialog', { name: 'GoLens settings' }).waitFor();
  await overlay.locator('iframe').contentFrame().locator('body').press('Escape');
  await overlay.waitFor({ state: 'detached' });

  const maximumDelay = await page.locator('[data-diffs]').evaluate(async (root) => {
    let maximum = 0;
    let previous = performance.now();
    const timer = setInterval(() => { const now = performance.now(); maximum = Math.max(maximum, now - previous); previous = now; }, 0);
    for (let batch = 0; batch < 10; batch++) {
      const fragment = document.createDocumentFragment();
      for (let index = 0; index < 20; index++) {
        const file = document.createElement('diff-file');
        file.dataset.fileData = JSON.stringify({ new_path: `stream/${batch}-${index}.go` });
        fragment.append(file);
      }
      root.append(fragment);
      await new Promise((resolve) => setTimeout(resolve));
    }
    clearInterval(timer);
    return maximum;
  });
  assert.ok(maximumDelay < 40, `rewrite stalled streamed diff rendering for ${maximumDelay.toFixed(1)}ms`);

  console.log('Rewrite Playwright parity passed.');
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
