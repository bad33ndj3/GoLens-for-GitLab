import assert from 'node:assert/strict';
import test from 'node:test';
import { Window } from 'happy-dom';

const browserWindow = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
globalThis.window = browserWindow;
globalThis.document = browserWindow.document;
globalThis.HTMLElement = browserWindow.HTMLElement;
globalThis.customElements = browserWindow.customElements;
globalThis.CustomEvent = browserWindow.CustomEvent;
const { commitSha, repositoryKey, repositoryPath, sourceIdentity } = await import('../../src/domain.ts');
const { createGitLabHost, reviewDescriptor, showFeatureGuide, showFirstRunSetup, showUpgradeNotice } = await import('../../src/gitlab-host/index.ts');

const headSha = commitSha('a'.repeat(40));
const review = reviewDescriptor({
  identity: {
    origin: 'https://gitlab.example',
    repositoryKey: repositoryKey('https://gitlab.example/group/project'),
    projectPath: repositoryPath('group/project'),
    mergeRequestIid: '42',
    headSha,
  },
  refs: { baseSha: 'b'.repeat(40), startSha: 'c'.repeat(40) },
});

test('bound host reads validated commit-pinned source without exposing GitLab payloads', async () => {
  const requests = [];
  const host = createGitLabHost({
    origin: review.identity.origin,
    window: new Window({ url: review.identity.origin }),
    fetch: async (input, init) => {
      requests.push({ input: String(input), init });
      return new Response(JSON.stringify({
        file_path: 'pkg/main.go',
        blob_id: 'd'.repeat(40),
        content: Buffer.from('package pkg\n').toString('base64'),
        encoding: 'base64',
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const source = sourceIdentity({ repositoryKey: review.identity.repositoryKey, commitSha: headSha });

  const outcome = await host.connect(review, new AbortController().signal).read({
    operation: 'source-file', source, path: repositoryPath('pkg/main.go'),
  }, new AbortController().signal);

  assert.deepEqual(outcome, {
    kind: 'ok',
    value: { path: repositoryPath('pkg/main.go'), contentId: 'd'.repeat(40), text: 'package pkg\n' },
  });
  assert.equal(requests[0].input, `https://gitlab.example/api/v4/projects/group%2Fproject/repository/files/pkg%2Fmain.go?ref=${headSha}`);
  assert.equal(requests[0].init.credentials, 'include');
});

test('bound host rejects a source identity from another repository', async () => {
  const host = createGitLabHost({ origin: review.identity.origin, window: new Window({ url: review.identity.origin }), fetch: async () => new Response() });
  const other = sourceIdentity({ repositoryKey: repositoryKey('https://gitlab.example/other/project'), commitSha: headSha });
  await assert.rejects(host.connect(review, new AbortController().signal).read({
    operation: 'source-file', source: other, path: repositoryPath('pkg/main.go'),
  }, new AbortController().signal), /source identity/i);
});

test('host observes immutable reviews and bound events precede revision-bound intentions', async () => {
  const window = browserWindow;
  window.document.body.innerHTML = '<meta name="csrf-token" content="token"><div class="layout-page is-merge-request"><div class="ai-panels"><nav><button>AI</button></nav></div></div>';
  let headSha = 'a'.repeat(40);
  const host = createGitLabHost({
    origin: 'https://gitlab.example', window,
    fetch: async () => new Response(JSON.stringify({ data: { project: { mergeRequest: { diffRefs: {
      headSha, baseSha: 'b'.repeat(40), startSha: 'c'.repeat(40),
    } } } } }), { status: 200 }),
  });
  const observations = host.observeReviews(new AbortController().signal)[Symbol.asyncIterator]();
  const observed = await observations.next();
  assert.equal(observed.value.identity.headSha, 'a'.repeat(40));
  headSha = 'd'.repeat(40);
  window.document.querySelector('.layout-page').append(window.document.createElement('div'), window.document.createElement('div'));
  const replaced = await observations.next();
  assert.equal(replaced.value.identity.headSha, 'd'.repeat(40));

  const controller = new AbortController();
  const bound = host.connect(replaced.value, controller.signal);
  const events = bound.events(controller.signal)[Symbol.asyncIterator]();
  const initial = await events.next();
  assert.deepEqual({ type: initial.value.type, surface: initial.value.surface }, { type: 'host-revised', surface: 'changes' });

  assert.deepEqual(bound.apply({
    revision: initial.value.revision,
    enabled: true,
    controls: [{ command: 'toggle-enabled', label: 'Turn GoLens off', pressed: true }],
  }), { kind: 'applied' });
  await new Promise((resolve) => setTimeout(resolve));
  const control = window.document.querySelector('golens-host-surface')?.shadowRoot?.querySelector('button');
  assert.ok(control);
  control.click();
  const intent = await events.next();
  assert.deepEqual({ type: intent.value.type, command: intent.value.command, revision: intent.value.revision }, {
    type: 'intent', command: 'toggle-enabled', revision: initial.value.revision,
  });

  window.document.querySelector('.layout-page').append(window.document.createElement('section'));
  const revised = await events.next();
  assert.equal(revised.value.type, 'host-revised');
  assert.notEqual(revised.value.revision, initial.value.revision);
  assert.deepEqual(bound.apply({ revision: initial.value.revision, enabled: false }), {
    kind: 'stale', currentRevision: revised.value.revision,
  });
  controller.abort();
});

test('host offers the full-file icon only for expandable files and places it before Viewed', async () => {
  const window = new Window({ url: 'https://gitlab.example/group/project/-/merge_requests/42/diffs' });
  window.document.body.innerHTML = `<meta name="csrf-token" content="token"><div class="layout-page is-merge-request"><div class="ai-panels"><nav><button>AI</button></nav></div></div>
    <diff-file data-file-data='{"new_path":"pkg/expandable.go"}'><header data-testid="file-title">pkg/expandable.go <button data-click="showFullFile">Show full file</button><label><input type="checkbox"> Viewed</label></header></diff-file>
    <diff-file data-file-data='{"new_path":"pkg/plain.go"}'><header data-testid="file-title">pkg/plain.go <label><input type="checkbox"> Viewed</label></header></diff-file>`;
  const host = createGitLabHost({ origin: 'https://gitlab.example', window, fetch: async () => new Response() });
  const controller = new AbortController();
  const bound = host.connect(review, controller.signal);
  const events = bound.events(controller.signal)[Symbol.asyncIterator]();
  const initial = await events.next();

  assert.deepEqual(initial.value.files, [{ path: repositoryPath('pkg/expandable.go'), full: false }]);
  bound.apply({ revision: initial.value.revision, enabled: true, fullFileControls: initial.value.files });
  await new Promise((resolve) => setTimeout(resolve));

  const viewed = window.document.querySelector('label');
  const control = window.document.querySelector('[data-golens-full-file-control]');
  assert.equal(control?.nextElementSibling, viewed);
  assert.equal(control?.shadowRoot?.querySelector('button')?.getAttribute('aria-label'), 'Show full file pkg/expandable.go');
  controller.abort();
});

test('first-run setup stages choices in an accessible Lit projection and dismisses cleanly', async () => {
  const controller = new AbortController();
  const result = showFirstRunSetup(document, [{ title: 'Hover for Go insight', summary: 'Show proven Go details.' }], false, 'custom', controller.signal);
  const host = document.querySelector('#golens-onboarding-root');
  await host.updateComplete;
  const dialog = host.shadowRoot.querySelector('[role="dialog"]');
  assert.equal(dialog.getAttribute('aria-modal'), 'true');
  const select = host.shadowRoot.querySelector('select');
  const checkbox = host.shadowRoot.querySelector('input[type="checkbox"]');
  select.value = 'vscode'; select.dispatchEvent(new window.Event('change'));
  checkbox.checked = true; checkbox.dispatchEvent(new window.Event('change'));
  host.shadowRoot.querySelector('.primary').click();
  assert.deepEqual(await result, { preset: 'vscode', hideGeneratedFiles: true });
  assert.equal(document.querySelector('#golens-onboarding-root'), null);

  const dismissed = showFirstRunSetup(document, [], false, 'golens', new AbortController().signal);
  const dismissedHost = document.querySelector('#golens-onboarding-root');
  await dismissedHost.updateComplete;
  dismissedHost.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(await dismissed, null);

  const closeGuide = showFeatureGuide(document, [
    { chapter: 'Page controls', title: 'Enable', summary: 'Turn GoLens on.' },
    { chapter: 'Settings', title: 'Privacy', summary: 'Keep source local.' },
  ]);
  const guide = document.querySelector('#golens-feature-guide-root');
  await guide.updateComplete;
  assert.deepEqual([...guide.shadowRoot.querySelectorAll('h3')].map(({ textContent }) => textContent), ['Page controls', 'Settings']);
  closeGuide();
});

test('upgrade notice uses the approved copy and only Continue acknowledges it', async () => {
  const dismissed = showUpgradeNotice(document, new AbortController().signal);
  let host = document.querySelector('#golens-onboarding-root');
  await host.updateComplete;
  assert.equal(host.shadowRoot.querySelector('h2').textContent, 'GoLens was rebuilt');
  assert.equal(host.shadowRoot.querySelector('p').textContent, 'This update reset your GoLens settings, shortcuts, bookmarks, and cached Go source. Your GitLab repositories and GitLab data were not changed.');
  host.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
  assert.equal(await dismissed, false);

  const continued = showUpgradeNotice(document, new AbortController().signal);
  host = document.querySelector('#golens-onboarding-root');
  await host.updateComplete;
  host.shadowRoot.querySelector('.primary').click();
  assert.equal(await continued, true);
});

test('host popover positions above the target element by default when space allows and ignores GoLens attribute mutations', async () => {
  const window = browserWindow;
  window.document.body.innerHTML = `
    <div class="layout-page is-merge-request">
      <div class="ai-panels"><nav><button>AI</button></nav></div>
      <diff-file data-file-data='{"new_path":"pkg/main.go"}'>
        <table>
          <tr role="row">
            <td data-line-number="10">10</td>
            <td class="line_content" role="gridcell"><span class="token">mySymbol</span></td>
          </tr>
        </table>
      </diff-file>
    </div>`;

  const host = createGitLabHost({ origin: 'https://gitlab.example', window, fetch: async () => new Response() });
  const controller = new AbortController();
  const bound = host.connect(review, controller.signal);
  const events = bound.events(controller.signal)[Symbol.asyncIterator]();
  const initial = await events.next();
  const source = sourceIdentity({ repositoryKey: review.identity.repositoryKey, commitSha: review.identity.headSha });

  const tokenSpan = window.document.querySelector('.token');
  tokenSpan.getBoundingClientRect = () => ({ top: 400, left: 100, bottom: 420, right: 180, width: 80, height: 20, x: 100, y: 400, toJSON: () => {} });
  window.innerWidth = 1024;
  window.innerHeight = 768;

  // Trigger pointerover to resolve target token
  tokenSpan.dispatchEvent(new window.MouseEvent('pointerover', { bubbles: true }));
  const intent = await events.next();
  assert.equal(intent.value.type, 'intent');
  assert.equal(intent.value.command, 'hover-target');
  const targetToken = intent.value.target.token;

  // Apply popover surface with selected target
  const applied = bound.apply({
    revision: initial.value.revision,
    enabled: true,
    selected: intent.value.target,
    interactiveTargets: [intent.value.target],
    surface: { kind: 'popover', title: 'mySymbol', body: 'func mySymbol()' },
  });
  assert.equal(applied.kind, 'applied');

  const popoverHost = window.document.querySelector('[data-golens-active-surface]');
  assert.ok(popoverHost);
  // Target top is 400, height 280, gap 6. Expected top: 400 - 6 - 280 = 114px (ABOVE the target token)
  assert.match(popoverHost.style.cssText, /top:\s*114px/);
  assert.match(popoverHost.style.cssText, /left:\s*100px/);

  // Mutate data-golens- attributes multiple times (e.g. 10 times)
  for (let i = 0; i < 10; i++) {
    tokenSpan.setAttribute('data-golens-interactive', String(i));
    popoverHost.setAttribute('data-golens-test', String(i));
  }
  await new Promise((resolve) => setTimeout(resolve, 20));

  // Verify that setting data-golens-* attributes did NOT trigger a host-revised event
  const outcome = bound.apply({
    revision: initial.value.revision,
    enabled: true,
    selected: intent.value.target,
    interactiveTargets: [intent.value.target],
    surface: { kind: 'popover', title: 'mySymbol', body: 'func mySymbol()' },
  });
  assert.equal(outcome.kind, 'unchanged');

  controller.abort();
});

test('host popover fallback anchors to the selected diff side', async () => {
  const window = browserWindow;
  window.document.body.innerHTML = `
    <div class="layout-page is-merge-request">
      <div class="ai-panels"><nav><button>AI</button></nav></div>
      <diff-file data-file-data='{"new_path":"pkg/main.go"}'>
        <table>
          <tr role="row">
            <td class="old_line"><a data-line-number="10" aria-label="Deleted line 10">10</a></td>
            <td class="line_content old" role="gridcell"><span class="old-token">OldSymbol</span></td>
            <td class="new_line"><a data-line-number="10" aria-label="Added line 10">10</a></td>
            <td class="line_content new" role="gridcell"><span class="new-token">NewSymbol</span></td>
          </tr>
        </table>
      </diff-file>
    </div>`;

  const host = createGitLabHost({ origin: 'https://gitlab.example', window, fetch: async () => new Response() });
  const controller = new AbortController();
  const bound = host.connect(review, controller.signal);
  const events = bound.events(controller.signal)[Symbol.asyncIterator]();
  const initial = await events.next();
  const source = sourceIdentity({ repositoryKey: review.identity.repositoryKey, commitSha: review.identity.headSha });

  const oldToken = window.document.querySelector('.old-token');
  const newToken = window.document.querySelector('.new-token');
  oldToken.getBoundingClientRect = () => ({ top: 400, left: 80, bottom: 420, right: 140, width: 60, height: 20, x: 80, y: 400, toJSON: () => {} });
  newToken.getBoundingClientRect = () => ({ top: 400, left: 320, bottom: 420, right: 420, width: 100, height: 20, x: 320, y: 400, toJSON: () => {} });
  window.innerWidth = 1024;
  window.innerHeight = 768;

  const applied = bound.apply({
    revision: initial.value.revision,
    enabled: true,
    selected: {
      revision: initial.value.revision,
      token: 'not-in-map',
      path: repositoryPath('pkg/main.go'),
      side: 'new',
      line: 10,
      identifier: 'NewSymbol',
      source,
    },
    surface: { kind: 'popover', title: 'NewSymbol', body: 'func NewSymbol()' },
  });

  assert.equal(applied.kind, 'applied');
  const popoverHost = window.document.querySelector('[data-golens-active-surface]');
  assert.ok(popoverHost);
  assert.match(popoverHost.style.cssText, /left:\s*320px/);
  controller.abort();
});
