import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const prototypeRoot = dirname(fileURLToPath(import.meta.url));
const browserPath = process.env.CHROME_BIN || [
  '/Applications/Helium.app/Contents/MacOS/Helium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);
const scratchRoot = await mkdtemp(resolve(tmpdir(), 'golens-playwright-prototype-'));
const extensionRoot = resolve(scratchRoot, 'extension');
const profileRoot = resolve(scratchRoot, 'profile');

// This copy is the prototype's deliberately tiny stand-in for the rewrite build.
await cp(resolve(prototypeRoot, 'extension'), extensionRoot, { recursive: true });

const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><html><body><main>GitLab fixture</main></body></html>');
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const fixtureURL = `http://127.0.0.1:${server.address().port}/group/project/-/merge_requests/42/diffs`;

let context;
try {
  context = await chromium.launchPersistentContext(profileRoot, {
    ...(browserPath ? { executablePath: browserPath } : {}),
    headless: true,
    args: [
      `--disable-extensions-except=${extensionRoot}`,
      `--load-extension=${extensionRoot}`,
    ],
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto(fixtureURL);
  await page.locator('body[data-golens-prototype="service-worker"]').waitFor();

  const workers = context.serviceWorkers();
  assert.equal(workers.length, 1, 'expected one MV3 service worker');
  assert.match(workers[0].url(), /^chrome-extension:\/\/.+\/worker\.js$/);

  console.log(JSON.stringify({
    assembledExtension: extensionRoot,
    fixtureURL,
    contentToWorkerRoundTrip: await page.locator('body').getAttribute('data-golens-prototype'),
    serviceWorker: workers[0].url(),
  }, null, 2));
} finally {
  await context?.close();
  server.close();
  await rm(scratchRoot, { recursive: true, force: true });
}
