import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let extensionRoot = root;
const chrome = process.env.CHROME_BIN || [
  '/Applications/Helium.app/Contents/MacOS/Helium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find(existsSync);

if (!existsSync(chrome)) {
  console.log('browser smoke skipped: Chrome not found');
  process.exit(0);
}

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const DEVTOOLS_TIMEOUT_MS = 30000;

async function devToolsTarget(port, expectedURL, deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
      const target = targets.find((candidate) => candidate.type === 'page' && candidate.url.startsWith(expectedURL));
      if (target?.webSocketDebuggerUrl) return target;
    } catch {
      // Chrome may announce its endpoint before the target list is ready.
    }
    await delay(50);
  }
  throw new Error(`Browser target did not become available for ${expectedURL}`);
}

async function connectDevTools(url) {
  const socket = new WebSocket(url);
  await new Promise((resolveOpen, rejectOpen) => {
    const timeout = setTimeout(() => {
      socket.close();
      rejectOpen(new Error('DevTools connection timed out'));
    }, DEVTOOLS_TIMEOUT_MS);
    socket.addEventListener('open', () => {
      clearTimeout(timeout);
      resolveOpen();
    }, { once: true });
    socket.addEventListener('error', (error) => {
      clearTimeout(timeout);
      rejectOpen(error);
    }, { once: true });
  });
  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolveSend, rejectSend) => {
    const requestID = ++id;
    const timeout = setTimeout(() => {
      pending.delete(requestID);
      rejectSend(new Error(`DevTools ${method} timed out for ${url}`));
    }, DEVTOOLS_TIMEOUT_MS);
    pending.set(requestID, {
      resolve(value) { clearTimeout(timeout); resolveSend(value); },
      reject(error) { clearTimeout(timeout); rejectSend(error); },
    });
    try {
      socket.send(JSON.stringify({ id: requestID, method, params }));
    } catch (error) {
      clearTimeout(timeout);
      pending.delete(requestID);
      rejectSend(error);
    }
  });
  return { socket, send };
}

async function sendExtensionTabMessage(port, pageURL, messageType, deadline) {
  let connection;
  try {
    while (Date.now() < deadline) {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json()).catch(() => []);
      const worker = targets.find((candidate) => candidate.type === 'service_worker' && candidate.url.endsWith('/go-semantic-worker.js'));
      if (!worker?.webSocketDebuggerUrl) {
        await delay(50);
        continue;
      }
      connection = await connectDevTools(worker.webSocketDebuggerUrl);
      const result = await connection.send('Runtime.evaluate', {
        expression: `(async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((candidate) => candidate.active && candidate.url === ${JSON.stringify(pageURL)})
            || tabs.find((candidate) => candidate.url === ${JSON.stringify(pageURL)});
          if (!tab?.id) return { ok:false, error:'fixture tab unavailable' };
          try { return await chrome.tabs.sendMessage(tab.id, { type:${JSON.stringify(messageType)} }); }
          catch (error) { return { ok:false, error:error.message }; }
        })()`,
        awaitPromise: true,
        returnByValue: true,
      });
      if (result.result.value?.ok) return result.result.value;
      connection.socket.close();
      connection = null;
      await delay(50);
    }
    throw new Error(`Extension message ${messageType} did not reach ${pageURL}`);
  } finally {
    connection?.socket.close();
  }
}

async function stopBrowser(child) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolveExit) => child.once('exit', resolveExit)),
    delay(2000).then(() => child.kill('SIGKILL')),
  ]);
}

async function runBrowserAttempt(url, completionExpression, profile, { extensionMessage = '' } = {}) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${extensionRoot}`,
    `--load-extension=${extensionRoot}`,
    '--remote-debugging-port=0',
    url,
  ];
  if (process.env.CHROME_NO_SANDBOX === '1') args.push('--no-sandbox');
  const child = spawn(chrome, args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  let endpointResolved = false;
  const endpoint = new Promise((resolveEndpoint, rejectEndpoint) => {
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
      const match = stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match && !endpointResolved) {
        endpointResolved = true;
        resolveEndpoint(match[1]);
      }
    });
    child.once('exit', (code) => {
      if (!endpointResolved) rejectEndpoint(new Error(`Browser exited before DevTools was ready (${code})\n${stderr}`));
    });
  });

  let connection;
  let html = '';
  try {
    const endpointURL = new URL(await Promise.race([
      endpoint,
      delay(15000).then(() => { throw new Error(`Browser DevTools did not become ready\n${stderr}`); }),
    ]));
    const deadline = Date.now() + 30000;
    const target = await devToolsTarget(endpointURL.port, url, deadline);
    connection = await connectDevTools(target.webSocketDebuggerUrl);
    if (extensionMessage) await sendExtensionTabMessage(endpointURL.port, url, extensionMessage, deadline);
    while (Date.now() < deadline) {
      try {
        const completion = await connection.send('Runtime.evaluate', {
          expression: `Boolean(${completionExpression})`,
          returnByValue: true,
        });
        if (completion.result.value) {
          const snapshot = await connection.send('Runtime.evaluate', {
            expression: 'document.documentElement.outerHTML',
            returnByValue: true,
          });
          html = snapshot.result.value;
          return { stdout: html, stderr };
        }
      } catch {
        // Reloads briefly destroy the execution context; the next poll retries.
      }
      await delay(50);
    }
    try {
      const snapshot = await connection.send('Runtime.evaluate', {
        expression: 'document.documentElement.outerHTML',
        returnByValue: true,
      });
      html = snapshot.result.value || '';
    } catch {
      // Preserve stderr and the latest available HTML in the timeout error.
    }
    throw new Error(`Browser scenario timed out\n${stderr}\n${html}`);
  } finally {
    connection?.socket.close();
    await stopBrowser(child);
  }
}

async function runBrowser(url, completionExpression, profile, options = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await runBrowserAttempt(url, completionExpression, profile, options);
    } catch (error) {
      const retryable = error.message?.startsWith('Browser DevTools did not become ready')
        || error.message?.startsWith('DevTools connection timed out')
        || /^DevTools .* timed out/.test(error.message || '');
      if (!retryable || attempt === 1) throw error;
    }
  }
}

const baseSha = 'a'.repeat(40);
const sha = 'b'.repeat(40);
const secondSha = 'c'.repeat(40);
const rawRequests = [];
const blobRequests = [];
const blobID = (content) => createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest('hex');
const source = `package contracts

// Runner performs work.
type Runner interface { Run() error }
`;
const projectSources = new Map([
  ['contracts/runner.go', source],
  ['service/runner.go', 'package service\n\nimport "example.com/project/contracts"\n\ntype Runner struct{}\nvar _ contracts.Runner = (*Runner)(nil)\nfunc (*Runner) Run() error { return nil }\n'],
  ['internal/mocks/runner.go', 'package mocks\n\ntype Runner struct{}\nfunc (*Runner) Run() error { return nil }\n'],
  ['unrelated/other.go', 'package unrelated\n\nfunc Other() {}\n'],
]);
const sharedBlobIDs = new Map([...projectSources].map(([path, content]) => [path, blobID(content)]));
const changedServiceSource = 'package service\n\nimport "example.com/project/contracts"\n\ntype Runner struct{}\nvar _ contracts.Runner = (*Runner)(nil)\nfunc (*Runner) Run() error { return nil }\nfunc (*Runner) Version() int { return 2 }\n';
const changedServiceBlobID = blobID(changedServiceSource);
const blobSources = new Map([
  ...[...projectSources].map(([path, content]) => [sharedBlobIDs.get(path), content]),
  [changedServiceBlobID, changedServiceSource],
]);

const html = `<!doctype html>
<html><head><meta name="csrf-token" content="fixture"><style>body{font:16px monospace}.line_content{padding:20px}</style></head>
<body>
  <div class="super-sidebar"></div>
  <div class="layout-page is-merge-request"><div class="ai-panels"><div><nav><div><button>AI</button></div></nav></div></div></div>
  <diff-file data-testid="rd-diff-file" data-file-data='{"viewer":"text_inline","old_path":"contracts/runner.go","new_path":"contracts/runner.go"}'>
    <article class="rd-diff-file">
      <header class="rd-diff-file-header" data-testid="rd-diff-file-header">
        <h2><a class="rd-diff-file-link" href="/group/project/-/blob/${sha}/contracts/runner.go">contracts/runner.go</a></h2>
        <div class="rd-diff-file-info">
          <div class="rd-diff-file-options-menu"><div data-options-menu><script type="application/json">[{"text":"Show full file","extraAttrs":{"data-click":"showFullFile"}}]</script></div></div>
        </div>
      </header>
      <table><tbody><tr><td class="new_line"><a href="#line_hash_A4" aria-label="Added line 4">4</a></td><td class="line_content">type <span id="go-target">Runner</span> interface { Run() error }</td></tr></tbody></table>
    </article>
  </diff-file>
  <diff-file data-testid="rd-diff-file" data-file-data='{"viewer":"text_inline","old_path":"service/runner.go","new_path":"service/runner.go"}'>
    <article class="rd-diff-file">
      <header class="rd-diff-file-header" data-testid="rd-diff-file-header"><h2><a class="rd-diff-file-link" href="/group/project/-/blob/${sha}/service/runner.go">service/runner.go</a></h2></header>
      <table><tbody><tr><td class="new_line"><a href="#line_hash_B3" aria-label="Added line 3">3</a></td><td class="line_content">type <span>Runner</span> struct{}</td></tr></tbody></table>
    </article>
  </diff-file>
  <script>
    document.addEventListener('golens-go-status', (event) => {
      document.body.dataset.goStatus = event.detail?.kind || 'event';
      document.body.dataset.goMessage = event.detail?.message || '';
      if ((event.detail?.message || '').includes('Go project intelligence ready')) document.body.dataset.goProjectReady = 'true';
    });
    const sharing = new URLSearchParams(location.search).has('sharing');
    const reloaded = !sharing && sessionStorage.getItem('golens-preload-complete') === 'true';
    let clicked = false;
    let controlsTested = false;
    let completionTested = false;
    let popoverTested = false;
    let sharingStarted = false;
    let fullFileTested = false;
    let bookmarkTested = false;
    document.addEventListener('click', (event) => {
      const button = event.target.closest?.('[data-golens-full-file][data-click="showFullFile"]');
      if (!button || fullFileTested) return;
      fullFileTested = true;
      const before = location.href;
      const row = document.createElement('tr');
      row.dataset.fullFileContext = 'true';
      row.innerHTML = '<td class="new_line"><a aria-label="Line 1">1</a></td><td class="line_content">package contracts</td>';
      button.closest('diff-file').querySelector('tbody').prepend(row);
      document.body.dataset.fullFileInline = String(Boolean(document.querySelector('[data-full-file-context]')));
      document.body.dataset.fullFileStayedInDiff = String(location.href === before);
      document.body.dataset.fullFileLabel = button.getAttribute('aria-label') || '';
      document.body.dataset.fullFileButtonCount = String(document.querySelectorAll('[data-golens-full-file]').length);
    });
    const fullFileWatch = setInterval(() => {
      const button = document.querySelector('diff-file [data-golens-full-file]');
      if (!button || fullFileTested) return;
      button.click();
      clearInterval(fullFileWatch);
    }, 20);
    const startPreloadWhenReady = (preload) => {
      if (!reloaded && !sessionStorage.getItem('golens-bookmark-added')) {
        setTimeout(() => startPreloadWhenReady(preload), 50);
        return;
      }
      if (!preload || (preload.dataset.state !== 'idle' && preload.dataset.state !== 'error')) {
        setTimeout(() => startPreloadWhenReady(preload), 50);
        return;
      }
      preload.click();
      document.body.dataset.preloadIndeterminate = String(preload.classList.contains('is-indeterminate'));
    };
    const bookmarkWatch = setInterval(() => {
      if (sharing || bookmarkTested) return;
      const marker = document.querySelector('diff-file .golens-bookmark-marker');
      const controls = document.getElementById('gitlab-lens-root')?.shadowRoot;
      const bookmarkControl = controls?.querySelector('[data-action="bookmarks"]');
      if (!marker || !bookmarkControl) return;
      if (!reloaded) {
        if (!sessionStorage.getItem('golens-bookmark-requested')) {
          sessionStorage.setItem('golens-bookmark-requested', 'true');
          marker.click();
          return;
        }
        if (document.querySelector('diff-file .golens-bookmark-marker[aria-pressed="true"]')) {
          sessionStorage.setItem('golens-bookmark-added', 'true');
        }
        return;
      }
      if (marker.getAttribute('aria-pressed') !== 'true' || bookmarkControl.querySelector('.bookmark-count')?.textContent !== '1') return;
      bookmarkControl.click();
      const drawer = document.getElementById('golens-bookmark-drawer-root')?.shadowRoot;
      if (!drawer?.textContent.includes('contracts/runner.go')) return;
      document.body.dataset.bookmarkReloaded = 'true';
      document.body.dataset.bookmarkDrawer = String(drawer.querySelector('[role="dialog"]')?.getAttribute('aria-label') === 'MR bookmarks');
      const tbody = document.querySelector('diff-file tbody');
      tbody.innerHTML = '<tr><td class="new_line"><a href="#line_hash_A4" aria-label="Added line 4">4</a></td><td class="line_content">type <span id="go-target">Runner</span> interface { Run() error }</td></tr>';
      setTimeout(() => {
        const restored = tbody.querySelectorAll('.golens-bookmark-marker[aria-pressed="true"]');
        document.body.dataset.bookmarkDomReconciled = String(restored.length === 1);
        bookmarkTested = true;
        clearInterval(bookmarkWatch);
      }, 150);
    }, 25);
    const preloadWatch = setInterval(() => {
      const controls = document.getElementById('gitlab-lens-root')?.shadowRoot;
      const preload = controls?.querySelector('[data-action="preload"]');
      if (!preload) return;
      document.body.dataset.preloadCurrentState = preload.dataset.state || '';
      if (sharing && !sharingStarted && (preload.dataset.state === 'idle' || preload.dataset.state === 'error')) {
        sharingStarted = true;
        preload.click();
      }
      const progress = preload.querySelector('[role="progressbar"]');
      const count = preload.querySelector('.preload-count');
      const percentage = Number(progress?.getAttribute('aria-valuenow'));
      if (preload.dataset.state === 'busy') document.body.dataset.preloadBusy = 'true';
      if (sharing && preload.dataset.state === 'busy' && preload.title.includes('Caching likely related packages')) {
        document.body.dataset.sharedCacheProgress = 'true';
      }
      if (preload.dataset.state === 'busy' && !count?.hidden && count?.textContent.includes('/')) {
        sessionStorage.setItem('golens-preload-count', count.textContent);
      }
      if (percentage > 0 && percentage < 100) document.body.dataset.preloadDeterminate = 'true';
      if (preload.dataset.state !== 'complete' || completionTested) return;
      completionTested = true;
      if (sharing) {
        document.body.dataset.sharedCacheComplete = 'true';
        clearInterval(preloadWatch);
        return;
      }
      if (!reloaded) {
        sessionStorage.setItem('golens-preload-busy', document.body.dataset.preloadBusy || 'false');
        sessionStorage.setItem('golens-preload-indeterminate', document.body.dataset.preloadIndeterminate || 'false');
        sessionStorage.setItem('golens-preload-determinate', document.body.dataset.preloadDeterminate || 'false');
        sessionStorage.setItem('golens-preload-complete', 'true');
        location.reload();
        return;
      }
      document.body.dataset.preloadBusy = sessionStorage.getItem('golens-preload-busy') || 'false';
      document.body.dataset.preloadIndeterminate = sessionStorage.getItem('golens-preload-indeterminate') || 'false';
      document.body.dataset.preloadDeterminate = sessionStorage.getItem('golens-preload-determinate') || 'false';
      document.body.dataset.preloadCount = sessionStorage.getItem('golens-preload-count') || '';
      document.body.dataset.preloadAfterReload = 'true';
      const toggle = controls.querySelector('[data-action="toggle-enabled"]');
      const focus = controls.querySelector('[data-action="focus"]');
      const verifyCompletedControls = () => {
        if (toggle?.getAttribute('aria-pressed') !== 'true') {
          setTimeout(verifyCompletedControls, 50);
          return;
        }
        focus?.click();
        document.body.dataset.focusActive = String(document.documentElement.classList.contains('gitlab-lens-review-focus'));
        document.body.dataset.focusCodeFontSize = getComputedStyle(document.querySelector('.line_content')).fontSize;
        toggle?.click();
        setTimeout(() => {
          document.body.dataset.disabledFocus = String(focus?.disabled);
          document.body.dataset.disabledToggle = toggle?.getAttribute('aria-pressed') || '';
          document.body.dataset.focusCleared = String(!document.documentElement.classList.contains('gitlab-lens-review-focus'));
          document.body.dataset.restoredCodeFontSize = getComputedStyle(document.querySelector('.line_content')).fontSize;
          document.body.dataset.preloadCompleteWhileOff = String(preload.dataset.state === 'complete');
          toggle?.click();
          setTimeout(() => {
            document.body.dataset.enabledToggle = toggle?.getAttribute('aria-pressed') || '';
            document.body.dataset.preloadCompleteAfterEnable = String(preload.dataset.state === 'complete');
          }, 300);
        }, 300);
      };
      verifyCompletedControls();
      clearInterval(preloadWatch);
    }, 20);
    const hover = setInterval(() => {
      const controls = document.getElementById('gitlab-lens-root')?.shadowRoot;
      const readyToggle = controls?.querySelector('[data-action="toggle-enabled"]');
      const readyPreload = controls?.querySelector('[data-action="preload"]');
      const preloadReady = ['idle', 'error', 'complete'].includes(readyPreload?.dataset.state);
      if (controls && !controlsTested && readyToggle?.getAttribute('aria-pressed') === 'true' && preloadReady) {
        controlsTested = true;
        const toggle = readyToggle;
        const focus = controls.querySelector('[data-action="focus"]');
        const preload = controls.querySelector('[data-action="preload"]');
        document.body.dataset.controlCount = String(controls.querySelectorAll('button').length);
        document.body.dataset.dockPresent = String(Boolean(controls.querySelector('.dock')));
        document.body.dataset.focusTitle = focus?.title || '';
        document.body.dataset.focusIconSvg = String(Boolean(focus?.querySelector('svg')));
        document.body.dataset.focusIconRaster = String(Boolean(focus?.querySelector('img')));
        document.body.dataset.brandIconSmall = String(toggle?.querySelector('img')?.src.endsWith('/assets/icons/golens-32.png'));
        document.body.dataset.themeSurface = getComputedStyle(document.getElementById('gitlab-lens-root')).getPropertyValue('--golens-surface-panel').trim();
        document.body.dataset.preloadLast = String(controls.querySelector('.controls')?.lastElementChild === preload);
        document.body.dataset.bookmarkLast = String(controls.querySelector('.controls')?.lastElementChild === controls.querySelector('[data-action="bookmarks"]'));
        if (!reloaded && !sharing) {
          focus?.click();
          document.body.dataset.focusActive = String(document.documentElement.classList.contains('gitlab-lens-review-focus'));
          document.body.dataset.focusCodeFontSize = getComputedStyle(document.querySelector('.line_content')).fontSize;
          focus?.click();
          document.body.dataset.restoredCodeFontSize = getComputedStyle(document.querySelector('.line_content')).fontSize;
          startPreloadWhenReady(preload);
        }
      }
      if (sharing || !reloaded) return;
      const target = document.getElementById('go-target');
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(new MouseEvent('mousemove', { bubbles:true, clientX:rect.left + rect.width / 2, clientY:rect.top + rect.height / 2 }));
      if (document.body.dataset.goStatus === 'ready' && !clicked) {
        clicked = true;
        target.dispatchEvent(new MouseEvent('click', { bubbles:true, button:0, ctrlKey:true, clientX:rect.left + rect.width / 2, clientY:rect.top + rect.height / 2 }));
      }
      if (popoverTested) clearInterval(hover);
    }, 500);
    const popoverWatch = setInterval(() => {
      if (popoverTested) return;
      const goUI = document.getElementById('golens-go-intelligence-root')?.shadowRoot;
      const popover = goUI?.querySelector('.popover');
      if (!popover || goUI.querySelector('.popover-title')?.textContent !== 'Implementations of Runner') return;
      popoverTested = true;
      popover.dispatchEvent(new PointerEvent('pointerenter'));
      popover.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: 2, clientY: 2 }));
      setTimeout(() => {
        document.body.dataset.goPopoverStable = String(popover.classList.contains('show'));
        document.body.dataset.goPopoverRole = popover.getAttribute('role') || '';
        document.body.dataset.goPopoverBadge = goUI.querySelector('.popover-header .symbol-badge')?.textContent || '';
        document.body.dataset.goPopoverCloseVisible = String(!goUI.querySelector('.close-button')?.hidden);
        document.body.dataset.goScope = goUI.querySelector('.scope')?.textContent || '';
        document.body.dataset.goFullSearchAction = String([...goUI.querySelectorAll('.choices button')].some((button) => button.textContent === 'Search complete project'));
        document.body.dataset.goFullSearchModal = String(goUI.querySelector('.full-search-dialog')?.getAttribute('aria-modal') === 'true');
        document.body.dataset.goInDiffDestination = String(Boolean(goUI.querySelector('.destination-in-diff')));
        document.body.dataset.goNewTabDestination = String(Boolean(goUI.querySelector('.destination-new-tab')));
        const targetStyle = getComputedStyle(document.getElementById('go-target'));
        document.body.dataset.goTargetColor = targetStyle.color;
        document.body.dataset.goTargetDecoration = targetStyle.textDecorationLine;
        document.body.dataset.goTargetOutline = targetStyle.outlineStyle;
        const fullSearchAction = [...goUI.querySelectorAll('.choices button')].find((button) => button.textContent === 'Search complete project');
        fullSearchAction?.click();
        document.body.dataset.goFullSearchOpened = String(!goUI.querySelector('.full-search-backdrop')?.hidden);
        document.body.dataset.goFullSearchCancelVisible = String(Boolean(goUI.querySelector('.full-search-cancel')));
        goUI.querySelector('.full-search-cancel')?.click();
        document.body.dataset.goFullSearchCancelled = String(goUI.querySelector('.full-search-backdrop')?.hidden && goUI.querySelector('.scope')?.textContent.includes('incomplete'));
        goUI.querySelector('.choices .choice')?.click();
        document.body.dataset.goChoiceClosedPopover = String(!popover.classList.contains('show'));
        const shortcutTarget = document.getElementById('go-target');
        const shortcutRect = shortcutTarget.getBoundingClientRect();
        shortcutTarget.dispatchEvent(new MouseEvent('click', { bubbles:true, button:0, clientX:shortcutRect.left + shortcutRect.width / 2, clientY:shortcutRect.top + shortcutRect.height / 2 }));
        const primary = /Mac|iPhone|iPad/.test(navigator.platform) ? { metaKey:true } : { ctrlKey:true };
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key:'F12', code:'F12', ...primary, bubbles:true, cancelable:true }));
        const shortcutWatch = setInterval(() => {
          if (!popover.classList.contains('show') || goUI.querySelector('.popover-title')?.textContent !== 'Implementations of Runner') return;
          document.body.dataset.goSemanticShortcut = 'true';
          clearInterval(shortcutWatch);
        }, 50);
        clearInterval(popoverWatch);
      }, 700);
    }, 50);
  </script>
</body></html>`;

const overviewHtml = `<!doctype html>
<html><head><meta name="csrf-token" content="fixture"></head>
<body>
  <div class="layout-page is-merge-request">
    <div class="ai-panels"><div><nav><div><button type="button">AI</button></div></nav></div></div>
    <div data-testid="discussion-content" class="js-discussion-container">
      <div class="discussion-header">
        <div class="note-header-info">
          <a href="/group/project/-/merge_requests/44/diffs?diff_id=77&amp;start_sha=abc#filehash_0_12">an old version of the diff</a>
        </div>
      </div>
      <div class="diff-file">
        <table><tbody><tr class="line_holder"><td>12</td><td>commented line</td></tr></tbody></table>
      </div>
    </div>
  </div>
</body></html>`;

const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  if (url.pathname === '/group/project/-/merge_requests/44') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(overviewHtml);
    return;
  }
  if (url.pathname === '/group/project/-/merge_requests/42/diffs' || url.pathname === '/group/project/-/merge_requests/43/diffs') {
    response.setHeader('content-type', 'text/html; charset=utf-8');
    response.end(html);
    return;
  }
  if (url.pathname === '/api/graphql') {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const iid = JSON.parse(body || '{}').variables?.iid;
      const headSha = iid === '43' ? secondSha : sha;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ data: { project: { mergeRequest: { diffRefs: { baseSha, startSha: baseSha, headSha } } } } }));
    });
    return;
  }
  if (url.pathname.startsWith('/api/v4/projects/') && url.pathname.endsWith('/repository/tree')) {
    response.setHeader('content-type', 'application/json');
    const ref = url.searchParams.get('ref');
    const packagePath = url.searchParams.get('path') || '';
    const paths = url.searchParams.get('recursive') === 'true'
      ? [...projectSources.keys(), 'vendor/example.com/dependency/ignored.go', 'pkg/testdata/ignored.go']
      : [...projectSources.keys()].filter((path) => dirname(path) === packagePath);
    response.end(JSON.stringify(paths.map((path) => ({
      type: 'blob',
      path,
      id: ref === secondSha && path === 'service/runner.go'
        ? changedServiceBlobID
        : sharedBlobIDs.get(path) || '9'.repeat(40),
    }))));
    return;
  }
  if (url.pathname.startsWith('/api/v4/projects/') && (
    url.pathname.endsWith('/merge_requests/42/diffs') || url.pathname.endsWith('/merge_requests/43/diffs')
  )) {
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify([{ old_path: 'contracts/runner.go', new_path: 'contracts/runner.go', deleted_file: false }]));
    return;
  }
  if (url.pathname.startsWith('/api/v4/projects/') && url.pathname.endsWith('/search')) {
    const query = url.searchParams.get('search') || '';
    const paths = query === 'example.com/project/contracts'
      ? ['service/runner.go']
      : query === 'Run(' || query === 'Runner'
      ? ['contracts/runner.go', 'service/runner.go', 'internal/mocks/runner.go']
      : [];
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(paths.map((path) => ({ path }))));
    return;
  }
  const blobMatch = url.pathname.match(/\/repository\/blobs\/([0-9a-f]{40})\/raw$/);
  if (blobMatch && blobSources.has(blobMatch[1])) {
    const blobId = blobMatch[1];
    blobRequests.push(blobId);
    response.setHeader('content-type', 'text/plain; charset=utf-8');
    const delay = 80 + [...blobSources.keys()].indexOf(blobId) * 60;
    setTimeout(() => response.end(blobSources.get(blobId)), delay);
    return;
  }
  const rawMatch = url.pathname.match(/^\/group\/project\/-\/raw\/([0-9a-f]{40})\/(.+)$/);
  if (rawMatch) {
    const [, ref, path] = rawMatch;
    rawRequests.push({ ref, path });
    if (projectSources.has(path)) {
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      const delay = 80 + [...projectSources.keys()].indexOf(path) * 80;
      setTimeout(() => response.end(projectSources.get(path)), delay);
      return;
    }
    if (path === 'go.mod') {
      response.setHeader('content-type', 'text/plain; charset=utf-8');
      response.end('module example.com/project\n');
      return;
    }
  }
  response.statusCode = 404;
  response.end('not found');
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const port = server.address().port;
const profile = await mkdtemp(resolve(tmpdir(), 'golens-smoke-'));
const smokeRoot = await mkdtemp(resolve(tmpdir(), 'golens-smoke-extension-'));
extensionRoot = resolve(smokeRoot, 'extension');
await cp(root, extensionRoot, {
  recursive: true,
  filter(source) {
    const relative = source.slice(root.length).replace(/^\//, '');
    const topLevel = relative.split('/')[0];
    return !['.git', '.agents', '.github', 'dist', 'docs', 'node_modules', 'tests'].includes(topLevel);
  },
});
const smokeManifestPath = resolve(extensionRoot, 'manifest.json');
const smokeManifest = JSON.parse(await readFile(smokeManifestPath, 'utf8'));
smokeManifest.host_permissions = [`http://127.0.0.1/*`];
smokeManifest.content_scripts[0].matches = [`http://127.0.0.1/*`];
await writeFile(smokeManifestPath, `${JSON.stringify(smokeManifest, null, 2)}\n`);

try {
  const overviewURL = `http://127.0.0.1:${port}/group/project/-/merge_requests/44`;
  const overview = await runBrowser(overviewURL, `
    document.querySelector('[data-golens-discussion-line-link]')?.href.includes('#filehash_0_12')
  `, profile);
  assert.match(
    overview.stdout,
    /data-golens-discussion-line-link=""[^>]+href="http:\/\/127\.0\.0\.1:\d+\/group\/project\/-\/merge_requests\/44\/diffs\?diff_id=77&amp;start_sha=abc#filehash_0_12"/,
    `overview discussion button did not preserve GitLab's exact line target\n${overview.stderr}`
  );

  const settings = await runBrowser(overviewURL, `
    document.getElementById('golens-settings-root')?.dataset.loaded === 'true'
      && document.getElementById('golens-settings-root')?.dataset.ready === 'true'
      && document.getElementById('golens-settings-root')?.shadowRoot?.querySelector('iframe')?.src.endsWith('/settings.html')
  `, profile, { extensionMessage: 'golens-show-settings' });
  assert.match(settings.stdout, /id="golens-settings-root" data-loaded="true" data-ready="true"/, `settings overlay iframe did not load inside GitLab\n${settings.stderr}`);

  const firstURL = `http://127.0.0.1:${port}/group/project/-/merge_requests/42/diffs`;
  const { stdout, stderr } = await runBrowser(firstURL, `
    document.body?.dataset.preloadAfterReload === 'true'
      && document.body?.dataset.enabledToggle === 'true'
      && document.body?.dataset.goChoiceClosedPopover === 'true'
      && document.body?.dataset.goSemanticShortcut === 'true'
      && document.body?.dataset.fullFileInline === 'true'
      && document.body?.dataset.bookmarkDomReconciled === 'true'
  `, profile);
  assert.match(stdout, /id="gitlab-lens-root"/, `extension shell was not injected\n${stderr}`);
  assert.match(stdout, /data-control-count="4"/, `the four direct controls were not injected\n${stderr}`);
  assert.match(stdout, /data-preload-last="false"/, `preload unexpectedly remained the bottom sidebar control\n${stderr}`);
  assert.match(stdout, /data-bookmark-last="true"/, `bookmarks are not the bottom sidebar control\n${stderr}`);
  assert.match(stdout, /data-bookmark-reloaded="true"/, `bookmark state did not survive a real extension reload\n${stderr}`);
  assert.match(stdout, /data-bookmark-drawer="true"/, `bookmark drawer did not expose its accessible dialog\n${stderr}`);
  assert.match(stdout, /data-bookmark-dom-reconciled="true"/, `bookmark marker did not survive diff DOM replacement\n${stderr}`);
  assert.match(stdout, /data-dock-present="false"/, `expandable dock is still present\n${stderr}`);
  assert.match(stdout, /data-focus-title="Full screen mode"/, `focus button is missing its tooltip\n${stderr}`);
  assert.match(stdout, /data-focus-icon-svg="true"/, `focus button is missing its semantic SVG icon\n${stderr}`);
  assert.match(stdout, /data-focus-icon-raster="false"/, `focus button still uses a raster image\n${stderr}`);
  assert.match(stdout, /data-brand-icon-small="true"/, `control rail is not using the optimized mascot asset\n${stderr}`);
  assert.match(stdout, /data-theme-surface="#[0-9a-f]{6}"/, `shared GoLens theme tokens were not injected\n${stderr}`);
  assert.match(stdout, /data-full-file-inline="true"/, `full-file control did not reveal inline context\n${stderr}`);
  assert.match(stdout, /data-full-file-stayed-in-diff="true"/, `full-file control navigated away from the diff\n${stderr}`);
  assert.match(stdout, /data-full-file-label="Show full file"/, `full-file control is missing its accessible label\n${stderr}`);
  assert.match(stdout, /data-full-file-button-count="1"/, `full-file control was injected more than once\n${stderr}`);
  assert.match(stdout, /data-focus-active="true"/, `focus button did not enable focus mode\n${stderr}`);
  assert.match(stdout, /data-focus-code-font-size="14px"/, `focus mode did not set code to 14px\n${stderr}`);
  assert.match(stdout, /data-restored-code-font-size="16px"/, `leaving focus mode did not restore the code font size\n${stderr}`);
  assert.match(stdout, /data-preload-busy="true"/, `preload did not show busy progress\n${stderr}`);
  assert.match(stdout, /data-preload-indeterminate="true"/, `preload did not start with indeterminate progress\n${stderr}`);
  assert.match(stdout, /data-preload-determinate="true"/, `preload did not switch to linear determinate progress\n${stderr}`);
  assert.match(stdout, /data-preload-count="\d+\/\d+"/, `preload did not show its package count inside the control\n${stderr}`);
  assert.match(stdout, /data-preload-after-reload="true"/, `preload completion did not survive reload\n${stderr}`);
  assert.match(stdout, /data-preload-complete-while-off="true"/, `disabling GoLens discarded the preload check\n${stderr}`);
  assert.match(stdout, /data-preload-complete-after-enable="true"/, `re-enabling GoLens discarded the preload check\n${stderr}`);
  assert.match(stdout, /data-go-semantic-shortcut="true"/, `the selected-symbol semantic shortcut did not reuse implementation navigation\n${stderr}`);
  assert.match(stdout, /data-go-status="(?:loading|ready)"/, `Go source loading did not start\n${stderr}`);
  assert.doesNotMatch(stdout, /data-go-status="error"/, 'browser integration reported an error');
  assert.match(stdout, /data-go-popover-stable="true"/, `the pinned Go popover closed while moving into it\n${stderr}`);
  assert.match(stdout, /data-go-popover-role="dialog"/, `the interactive Go popover was not exposed as a dialog\n${stderr}`);
  assert.match(stdout, /data-go-popover-badge="I"/, `the implementation popover did not expose its interface badge\n${stderr}`);
  assert.match(stdout, /data-go-popover-close-visible="true"/, `the pinned Go popover did not expose a close button\n${stderr}`);
  assert.match(stdout, /data-go-scope="[^"]*(?:indexed package|Full project)[^"]*"/, `semantic results did not expose their search scope\n${stderr}`);
  assert.match(stdout, /data-go-full-search-action="true"/, `incomplete semantic results did not expose the full-project action\n${stderr}`);
  assert.match(stdout, /data-go-full-search-modal="true"/, `the full-project search modal is not accessible\n${stderr}`);
  assert.match(stdout, /data-go-full-search-opened="true"/, `the full-project search modal did not open\n${stderr}`);
  assert.match(stdout, /data-go-full-search-cancel-visible="true"/, `the full-project search modal did not expose Cancel\n${stderr}`);
  assert.match(stdout, /data-go-full-search-cancelled="true"/, `cancelling full-project search did not preserve incomplete coverage\n${stderr}`);
  assert.match(stdout, /data-go-in-diff-destination="true"/, `the same-diff destination icon was not rendered\n${stderr}`);
  assert.match(stdout, /data-go-new-tab-destination="true"/, `the new-tab destination icon was not rendered\n${stderr}`);
  assert.match(stdout, /data-go-target-color="rgb\(119, 204, 229\)"/, `recognized Go symbols did not receive the semantic link color\n${stderr}`);
  assert.match(stdout, /data-go-target-decoration="underline"/, `recognized Go symbols were not underlined\n${stderr}`);
  assert.match(stdout, /data-go-target-outline="none"/, `recognized Go symbols still received an outline\n${stderr}`);
  assert.match(stdout, /data-go-choice-closed-popover="true"/, `successful navigation did not close the Go popover\n${stderr}`);
  assert.equal(rawRequests.some(({ ref }) => ref === baseSha), false, 'preload fetched the MR base revision');
  assert.equal(rawRequests.filter((request) => request.ref === sha && request.path === 'go.mod').length, 1, 'go.mod was downloaded more than once across reload');
  for (const blobId of sharedBlobIDs.values()) {
    const expected = blobId === sharedBlobIDs.get('unrelated/other.go') ? 0 : 1;
    assert.equal(blobRequests.filter((request) => request === blobId).length, expected, `${blobId} had an unexpected related-cache download count`);
  }

  const sharingURL = `http://127.0.0.1:${port}/group/project/-/merge_requests/43/diffs?sharing=1`;
  const sharing = await runBrowser(sharingURL, `
    document.body?.dataset.sharedCacheComplete === 'true'
  `, profile);
  assert.match(sharing.stdout, /data-shared-cache-progress="true"/, `second MR did not report shared cache reuse\n${sharing.stderr}`);
  assert.match(sharing.stdout, /data-shared-cache-complete="true"/, `second MR preload did not complete\n${sharing.stderr}`);
  for (const [path, blobId] of sharedBlobIDs) {
    const expected = path === 'unrelated/other.go' ? 0 : 1;
    assert.equal(blobRequests.filter((request) => request === blobId).length, expected, `${path} was downloaded unexpectedly for the second MR`);
  }
  assert.equal(blobRequests.filter((request) => request === changedServiceBlobID).length, 1, 'changed source blob was not downloaded exactly once');
  assert.equal(rawRequests.filter((request) => request.ref === secondSha && request.path === 'go.mod').length, 1, 'second MR did not fetch its commit-specific go.mod once');

  console.log('browser injection smoke passed');
} finally {
  server.close();
  await rm(profile, { recursive: true, force: true });
  await rm(smokeRoot, { recursive: true, force: true });
}
