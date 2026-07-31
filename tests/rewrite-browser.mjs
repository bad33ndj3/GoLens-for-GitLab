import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';

const root = new URL('..', import.meta.url).pathname;
const extension = join(root, 'dist', 'extension');
const profile = await mkdtemp(join(tmpdir(), 'golens-rewrite-browser-'));
const browserPath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><html><body><main>GitLab fixture</main></body></html>');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const fixtureURL = `http://127.0.0.1:${server.address().port}/`;

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
    headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const page = context.pages()[0] || await context.newPage();
  await page.route('https://gitlab.com/**', async (route) => route.fulfill({
    contentType: 'text/html',
    body: await (await fetch(fixtureURL)).text(),
  }));
  await page.goto('https://gitlab.com/group/project/-/merge_requests/42/diffs');
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await waitForRoundTrip(worker);
  assert.match(worker.url(), /\/worker\.js$/);
  console.log('Rewrite content-to-worker round trip passed.');
} finally {
  await context?.close();
  server.close();
  await rm(profile, { recursive: true, force: true });
}
