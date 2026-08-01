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
const { createGitLabHost, reviewDescriptor, showFeatureGuide, showFirstRunSetup } = await import('../../src/gitlab-host/index.ts');

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
