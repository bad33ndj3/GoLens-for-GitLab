import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { Window } from 'happy-dom';

let helpers;

before(async () => {
  globalThis.location = {
    href: 'https://gitlab.example/group/project/-/merge_requests/42/diffs',
    origin: 'https://gitlab.example',
    pathname: '/group/project/-/merge_requests/42/diffs',
  };
  await import('../bookmark-store.js?go-navigation-context-test');
  await import('../go-navigation.js');
  helpers = globalThis.GoLensGoNavigation.__test;
});

test('normalizes GitLab file-title spacing and bidi markers', () => {
  assert.equal(helpers.normalizePath('svc/ snapshot/\u200e pkg/search.go'), 'svc/snapshot/pkg/search.go');
});

test('builds version-pinned Go documentation URLs for root and nested standard packages', () => {
  const cases = {
    fmt: 'https://pkg.go.dev/fmt@go1.26.5',
    'net/http': 'https://pkg.go.dev/net/http@go1.26.5',
    'crypto/tls': 'https://pkg.go.dev/crypto/tls@go1.26.5',
    'net/http/pprof': 'https://pkg.go.dev/net/http/pprof@go1.26.5',
  };
  for (const [importPath, expectedURL] of Object.entries(cases)) {
    assert.equal(helpers.standardLibraryURL(importPath), expectedURL);
  }
});

test('reads merge and approval state from the authenticated GitLab endpoint', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, options) => {
    request = { input, options };
    return {
      ok: true,
      async json() {
        return {
          state: 'merged',
          approved_by: [
            { user: { id: 17, username: 'reviewer' } },
            { user: { username: 'fallback-reviewer' } },
          ],
        };
      },
    };
  };
  try {
    assert.deepEqual(
      await globalThis.GoLensGoNavigation.mergeRequestCelebrationStatus(),
      { state: 'merged', approvers: ['17', 'fallback-reviewer'] },
    );
    assert.equal(
      request.input,
      'https://gitlab.example/api/v4/projects/group%2Fproject/merge_requests/42/approvals',
    );
    assert.equal(request.options.credentials, 'include');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('counts unresolved merge request discussions across GitLab API pages', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  const pages = [
    {
      next: '2',
      discussions: [
        { notes: [{ resolvable: true, resolved: false }] },
        { notes: [{ resolvable: true, resolved: true }] },
      ],
    },
    {
      next: '',
      discussions: [
        { notes: [{ resolvable: false, resolved: false }] },
        { notes: [{ resolvable: true, resolved: false }, { resolvable: true, resolved: true }] },
      ],
    },
  ];
  globalThis.fetch = async (input, options) => {
    requests.push({ input, options });
    const page = pages[requests.length - 1];
    return {
      ok: true,
      headers: { get(name) { return name === 'x-next-page' ? page.next : ''; } },
      async json() { return page.discussions; },
    };
  };
  try {
    assert.deepEqual(
      await globalThis.GoLensGoNavigation.mergeRequestDiscussionStatus(),
      { unresolved: 2 },
    );
    assert.deepEqual(requests.map((request) => request.input), [
      'https://gitlab.example/api/v4/projects/group%2Fproject/merge_requests/42/discussions?per_page=100&page=1',
      'https://gitlab.example/api/v4/projects/group%2Fproject/merge_requests/42/discussions?per_page=100&page=2',
    ]);
    assert.ok(requests.every((request) => request.options.credentials === 'include'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('builds a Go documentation URL for versioned third-party modules', () => {
  assert.equal(helpers.packageDocumentationURL('github.com/gofrs/uuid/v5'), 'https://pkg.go.dev/github.com/gofrs/uuid/v5');
});

test('builds an anchored documentation URL for predeclared Go functions', () => {
  assert.equal(helpers.documentationURL({ status: 'builtin', symbol: 'len' }), 'https://pkg.go.dev/builtin@go1.26.5#len');
});

test('builds commit-pinned GitLab tree URLs for project packages', () => {
  const ref = 'a'.repeat(40);
  assert.equal(
    helpers.projectPackageURL({ ref, packagePath: 'svc/snapshot/internal/core/entity' }),
    `https://gitlab.example/group/project/-/tree/${ref}/svc/snapshot/internal/core/entity`,
  );
  assert.equal(helpers.projectPackageURL({ ref: 'main', packagePath: 'svc/snapshot' }), '');
});

test('does not resolve identifiers when the pointer is on call punctuation', () => {
  const source = 'target(value, other)';
  assert.deepEqual(helpers.identifierAtCharacter(source, source.indexOf('target')), { identifier: 'target', character: 0, occurrence: 0 });
  assert.equal(helpers.identifierAtCharacter(source, source.indexOf('(')), null);
  assert.equal(helpers.identifierAtCharacter(source, source.indexOf(',')), null);
  assert.equal(helpers.identifierAtCharacter(source, source.indexOf(')')), null);
});

test('numbers repeated rendered identifiers so source offsets cannot switch symbol roles', () => {
  const source = 'Foo := source.Foo; Foo()';
  const positions = [...source.matchAll(/Foo/g)].map((match) => match.index);
  assert.deepEqual(
    positions.map((character) => helpers.identifierAtCharacter(source, character)?.occurrence),
    [0, 1, 2],
  );
});

test('rejects caret hits that snap from punctuation to an adjacent identifier', () => {
  const window = new Window({ url: globalThis.location.href });
  window.document.body.innerHTML = '<code><span class="operator">&amp;</span><span class="identifier">model</span><span class="operator">.</span><span class="identifier">ContractLabel</span></code>';
  const cell = window.document.querySelector('code');
  assert.equal(helpers.caretElementMatchesIdentifier(cell.querySelector('.operator'), cell, 'model'), false);
  assert.equal(helpers.caretElementMatchesIdentifier(cell.querySelector('.identifier'), cell, 'model'), true);
  assert.equal(helpers.caretElementMatchesIdentifier(cell, cell, 'model'), true);
});

test('does not resolve Go-looking text inside non-code tokens', () => {
  const source = 'target(*service, 42, "stringValue") // commentValue';
  assert.equal(helpers.identifierAtCharacter(source, source.indexOf('*')), null);
  assert.equal(helpers.identifierAtCharacter(source, source.indexOf('42')), null);
  assert.equal(helpers.identifierAtCharacter(source, source.indexOf('stringValue')), null);
  assert.equal(helpers.identifierAtCharacter(source, source.indexOf('commentValue')), null);
});

test('does not resolve Go language keywords', () => {
  assert.equal(helpers.identifierAtCharacter('func target() {}', 0), null);
  assert.equal(helpers.identifierAtCharacter('return target', 0), null);
});

test('extracts a commit and file path from a blob link', () => {
  const sha = 'a'.repeat(40);
  const result = helpers.parseBlobLink(
    { href: `https://gitlab.example/group/project/-/blob/${sha}/svc/search/search.go` },
    'svc/search/search.go',
  );
  assert.deepEqual(result, { ref: sha, path: 'svc/search/search.go' });
});

test('preserves source branches containing slashes when the path is known', () => {
  const result = helpers.parseBlobLink(
    { href: 'https://gitlab.example/group/project/-/blob/caspers/feature/search/svc/search/search.go' },
    'svc/search/search.go',
  );
  assert.deepEqual(result, { ref: 'caspers/feature/search', path: 'svc/search/search.go' });
});

test('detects stale MR refs and prefers a commit-pinned DOM ref for new-side source', () => {
  const staleHead = 'a'.repeat(40);
  const domHead = 'b'.repeat(40);
  const startSha = 'c'.repeat(40);
  const refs = { headSha: staleHead, startSha, baseSha: 'd'.repeat(40) };
  const file = { ref: domHead };

  assert.equal(helpers.refsDisagreeWithFile(refs, domHead), true);
  assert.equal(helpers.refsDisagreeWithFile({ ...refs, headSha: domHead }, domHead), false);
  assert.equal(helpers.refsDisagreeWithFile(refs, 'feature/branch'), false);
  assert.equal(helpers.sourceRefFor(file, { side: 'new' }, refs), domHead);
  assert.equal(helpers.sourceRefFor(file, { side: 'old' }, refs), startSha);
  assert.equal(helpers.sourceRefFor({ ref: 'feature/branch' }, { side: 'new' }, refs), staleHead);
});

test('reads Rapid Diffs line numbers from accessible labels and hashes', () => {
  const accessible = {
    getAttribute(name) { return name === 'aria-label' ? 'Added line 77' : ''; },
    title: '', dataset: {}, textContent: '', hash: '',
  };
  assert.equal(helpers.lineFromAnchor(accessible), 77);

  const hashOnly = {
    getAttribute() { return ''; },
    title: '', dataset: {}, textContent: '', hash: '#diff-content-abc_92',
  };
  assert.equal(helpers.lineFromAnchor(hashOnly), 92);
});

test('tolerates GitLab line cells without an anchor hash', () => {
  const window = new Window({ url: globalThis.location.href });
  const lineCell = window.document.createElement('div');
  assert.equal(helpers.lineFromAnchor(lineCell), 0);
  lineCell.dataset.lineNumber = '41';
  assert.equal(helpers.lineFromAnchor(lineCell), 41);
});

test('chooses the needed Rapid Diffs expansion direction for a hidden destination line', () => {
  assert.equal(helpers.expansionDirectionForLine(12, [30, 31, 32]), 'up');
  assert.equal(helpers.expansionDirectionForLine(48, [30, 31, 32]), 'down');
  assert.equal(helpers.expansionDirectionForLine(31, [30, 31, 32]), null);
});

test('opens a sole usage directly and shows a list for multiple usages', () => {
  assert.equal(helpers.referenceNavigationAction({ status: 'references', locations: [{}] }), 'open');
  assert.equal(helpers.referenceNavigationAction({ status: 'references', locations: [{}, {}] }), 'show');
});

test('formats concrete source locations for compact LLM context', () => {
  assert.equal(
    helpers.sourceLocationText({ path: 'svc/snapshot/pkg/search.go', line: 24, character: 7 }),
    'svc/snapshot/pkg/search.go:24:7',
  );
  assert.equal(helpers.sourceLocationText({ path: 'svc/snapshot/pkg/search.go', line: 24 }), '');
  assert.equal(helpers.sourceLocationText({ path: 'svc/snapshot/pkg/search.go', line: 0, character: 7 }), '');
});

test('shows usages rather than a definition preview when hovering a declaration', () => {
  assert.equal(helpers.shouldShowReferencesOnHover({ status: 'resolved', isDefinition: true }), true);
  assert.equal(helpers.shouldShowReferencesOnHover({ status: 'resolved', isDefinition: false }), false);
});

test('reports monotonic determinate package progress for empty, single-file, and concurrent loads', () => {
  assert.deepEqual(helpers.packageLoadingProgress('discovering'), {
    phase: 'discovering', completed: 0, total: 0, percentage: 0,
  });
  assert.deepEqual(helpers.packageLoadingProgress('indexing', 0, 0), {
    phase: 'indexing', completed: 0, total: 0, percentage: 90,
  });
  assert.deepEqual(helpers.packageLoadingProgress('ready', 1, 1), {
    phase: 'ready', completed: 1, total: 1, percentage: 100,
  });
  assert.deepEqual(helpers.packageLoadingProgress('fetching', 1, 1), {
    phase: 'fetching', completed: 1, total: 1, percentage: 90,
  });

  const updates = [0, 1, 2, 3].map((completed) => helpers.packageLoadingProgress('fetching', completed, 3));
  assert.deepEqual(updates.map((update) => update.percentage), [0, 30, 60, 90]);
  assert.equal(updates.every((update, index) => index === 0 || update.percentage >= updates[index - 1].percentage), true);
  assert.equal(
    helpers.packageLoadingMessage('pkg/search', updates[2]),
    'Loading pkg/search · 60% · 2 / 3 files',
  );
});

test('reports determinate full-project preload progress through cache completion', () => {
  const updates = [0, 1, 2, 3].map((completed) => helpers.projectLoadingProgress('fetching', completed, 3));
  assert.deepEqual(updates.map((update) => update.percentage), [0, 30, 60, 90]);
  assert.deepEqual(helpers.projectLoadingProgress('indexing', 3, 3), {
    phase: 'indexing', completed: 3, total: 3, percentage: 95,
  });
  assert.deepEqual(helpers.projectLoadingProgress('ready', 3, 3), {
    phase: 'ready', completed: 3, total: 3, percentage: 100,
  });
  assert.equal(
    helpers.projectLoadingMessage(updates[2]),
    'Fetching project Go sources · 60% · 2 / 3 files',
  );
  const reused = helpers.projectLoadingProgress('fetching', 1800, 2000, {
    cached: 1800,
    downloaded: 0,
    remaining: 200,
  });
  assert.equal(reused.percentage, 81);
  assert.equal(helpers.projectLoadingMessage(reused), '1,800 cached · 200 remaining · 81%');
});

test('reports MR-related preload progress in fixed linear package phases', () => {
  const updates = [
    helpers.relatedLoadingProgress('discovering'),
    helpers.relatedLoadingProgress('changed', 0, 2),
    helpers.relatedLoadingProgress('changed', 1, 2),
    helpers.relatedLoadingProgress('changed', 2, 2),
    helpers.relatedLoadingProgress('dependencies', 0, 1),
    helpers.relatedLoadingProgress('dependencies', 1, 1),
    helpers.relatedLoadingProgress('searching', 0, 0, { phaseDetail: 'usages' }),
    helpers.relatedLoadingProgress('searching', 0, 0, { phaseDetail: 'implementations' }),
    helpers.relatedLoadingProgress('candidates', 0, 2),
    helpers.relatedLoadingProgress('candidates', 1, 2),
    helpers.relatedLoadingProgress('candidates', 2, 2),
    helpers.relatedLoadingProgress('saving', 4, 4),
    helpers.relatedLoadingProgress('ready', 4, 4),
  ];
  assert.deepEqual(updates.map(({ percentage }) => percentage), [0, 5, 23, 40, 40, 65, 68, 72, 75, 85, 95, 98, 100]);
  assert.equal(updates.every((update, index) => index === 0 || update.percentage >= updates[index - 1].percentage), true);
  assert.equal(
    helpers.relatedLoadingMessage(helpers.relatedLoadingProgress('candidates', 1, 2)),
    'Caching likely related packages · 85% · 1 / 2 packages',
  );
});

test('preserves the most restrictive optional search coverage state', () => {
  assert.equal(helpers.mergeSearchStatus('complete', 'limited'), 'limited');
  assert.equal(helpers.mergeSearchStatus('limited', 'complete'), 'limited');
  assert.equal(helpers.mergeSearchStatus('limited', 'unavailable'), 'unavailable');
  assert.equal(helpers.relatedReadyMessage('unavailable'), 'Related cache ready · code search unavailable');
});

test('routes interface declarations to implementations without searching on hover', () => {
  const result = { status: 'resolved', isDefinition: true, definition: { kind: 'interface' } };
  assert.equal(helpers.isInterfaceDeclaration(result), true);
  assert.equal(helpers.shouldShowReferencesOnHover(result), false);
  assert.equal(helpers.isInterfaceDeclaration({ ...result, isDefinition: false }), false);
  assert.equal(helpers.isInterfaceDeclaration({ ...result, definition: { kind: 'type' } }), false);
});

test('groups production implementations ahead of collapsed test doubles', () => {
  const production = { displayName: 'service.Runner', isTestDouble: false };
  const mock = { displayName: '*mocks.Runner', isTestDouble: true };
  assert.deepEqual(
    helpers.implementationGroups({ status: 'implementations', candidates: [production, mock] }),
    { production: [production], testDoubles: [mock] },
  );
});

test('describes absence only within the proven semantic scope', () => {
  assert.equal(helpers.absenceText({ kind: 'currentPackage', packagePath: 'service', packageCount: 1 }), 'Not found in current package.');
  assert.equal(
    helpers.absenceText({ kind: 'indexedPackages', packageCount: 12, complete: false }),
    'Not found in 12 indexed packages. Search coverage is incomplete.',
  );
  assert.equal(
    helpers.absenceText({ kind: 'fullProject', packageCount: 40, complete: true }),
    'Full project searched; no result exists.',
  );
  assert.equal(
    helpers.resultScopeText({ kind: 'indexedPackages', packageCount: 12, complete: false }),
    '12 indexed packages · search coverage is incomplete',
  );
});

test('maps every Go symbol kind to a readable IDE-style badge', () => {
  const cases = {
    interface: ['I', 'Interface'],
    struct: ['S', 'Struct'],
    function: ['F', 'Function'],
    method: ['M', 'Method'],
    interfaceMethod: ['IM', 'Interface method'],
    type: ['T', 'Named type'],
    variable: ['V', 'Variable'],
    field: ['FD', 'Field'],
    constant: ['C', 'Constant'],
    parameter: ['P', 'Parameter'],
    package: ['PKG', 'Package'],
    external: ['Go', 'External Go documentation'],
  };
  for (const [kind, [badge, label]] of Object.entries(cases)) {
    assert.deepEqual(
      { badge: helpers.symbolPresentation(kind).badge, label: helpers.symbolPresentation(kind).label },
      { badge, label },
    );
  }
});

test('renders stable IDE-style GoDoc, implementation, and navigation popovers', async () => {
  const window = new Window({ url: globalThis.location.href });
  const sha = 'a'.repeat(40);
  globalThis.document = window.document;
  globalThis.innerWidth = 1000;
  globalThis.innerHeight = 800;
  window.document.body.innerHTML = `
    <section class="diff-file" data-file-path="service/current.go">
      <a href="/group/project/-/blob/${sha}/service/current.go">service/current.go</a>
      <table><tbody><tr><td class="new_line"><a href="#L44" aria-label="Added line 44">44</a></td><td class="line_content">current target</td></tr></tbody></table>
    </section>
    <section class="diff-file" data-file-path="service/run.go"></section>
    <section class="diff-file" data-file-path="service/runner.go"></section>
  `;
  const currentPointer = {
    x: 10,
    y: 10,
    cell: window.document.querySelector('.line_content'),
    character: 8,
  };
  helpers.showLoading('Loading pkg/search · 60% · 2 / 3 files', currentPointer, {
    phase: 'fetching', completed: 2, total: 3, percentage: 60,
  });
  const shadow = window.document.querySelector('#golens-go-intelligence-root').shadowRoot;
  const popover = shadow.querySelector('.popover');
  const visualContract = shadow.querySelector('style').textContent;
  assert.match(visualContract, /var\(--golens-surface-panel\)/);
  assert.match(visualContract, /var\(--golens-focus-ring\)/);
  assert.doesNotMatch(visualContract, /Inter/);
  assert.equal(popover.getAttribute('aria-busy'), 'true');
  assert.match(shadow.querySelector('.popover-title').textContent, /Loading pkg\/search/);
  assert.equal(popover.getAttribute('role'), 'tooltip');
  assert.equal(shadow.querySelector('.loading-progress').hidden, false);
  assert.equal(shadow.querySelector('.loading-progress-count').textContent, '60% · 2 / 3 files');
  assert.equal(shadow.querySelector('.loading-track').getAttribute('aria-valuenow'), '60');
  assert.equal(shadow.querySelector('.loading-track i').style.width, '60%');

  assert.equal(helpers.schedulePassivePopoverDismissal(), true);
  popover.dispatchEvent(new window.Event('pointerenter'));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(popover.classList.contains('show'), true, 'entering during the grace period keeps the popover open');
  assert.equal(popover.getAttribute('role'), 'dialog');
  assert.equal(shadow.querySelector('.close-button').hidden, false);
  assert.equal(helpers.schedulePassivePopoverDismissal(), false, 'pinned popovers never receive a mouse-leave timeout');
  helpers.hidePopover();

  helpers.showResult({
    status: 'resolved',
    isDefinition: false,
    definition: {
      name: 'Run',
      kind: 'function',
      signature: 'func Run() error',
      documentation: 'Run performs the operation.',
      path: 'service/run.go',
      line: 12,
      column: 6,
      ref: 'b'.repeat(40),
    },
  }, currentPointer);
  const docs = shadow.querySelector('.docs');
  const signature = shadow.querySelector('.signature');
  assert.equal(docs.textContent, 'Run performs the operation.');
  assert.equal(signature.closest('.signature-block').nextElementSibling, docs);
  assert.equal(shadow.querySelector('.popover-header .symbol-badge').textContent, 'F');
  assert.equal(shadow.querySelector('.popover-title').textContent, 'Run');
  assert.equal(shadow.querySelector('.destination-icon').classList.contains('destination-in-diff'), true);
  assert.equal(shadow.querySelector('.destination-icon').getAttribute('aria-label'), 'Jump in this MR diff');
  assert.equal(helpers.definitionDestination({ path: 'service/run.go' }).kind, 'inDiff');
  assert.equal(helpers.definitionDestination({ path: 'service/elsewhere.go' }).kind, 'newTab');
  const copyButton = shadow.querySelector('.copy-button');
  const closeButton = shadow.querySelector('.close-button');
  assert.equal(copyButton.hidden, false);
  assert.equal(copyButton.dataset.copyText, 'service/current.go:44:9');
  assert.equal(copyButton.nextElementSibling, closeButton, 'copy action stays immediately left of close');
  let copiedText = '';
  window.document.execCommand = (command) => {
    if (command !== 'copy') return false;
    copiedText = window.document.querySelector('textarea').value;
    return true;
  };
  copyButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(copiedText, 'service/current.go:44:9');
  assert.equal(copyButton.dataset.state, 'copied');
  assert.match(shadow.querySelector('.toast').textContent, /Copied service\/current\.go:44:9/);

  const fullSignature = 'func NewContractService(db *gorm.DB, invoiceCreditor InvoiceCreditor, emailClient EmailClient, metrics ContractMetrics, legacyContractRepository LegacyContractRepository) *ContractService';
  const compactSignature = 'func NewContractService(db *gorm.DB, invoiceCreditor InvoiceCreditor, … +3 parameters) *ContractService';
  helpers.showResult({
    status: 'resolved',
    isDefinition: false,
    definition: {
      name: 'NewContractService',
      kind: 'function',
      signature: fullSignature,
      compactSignature,
      documentation: '',
      path: 'service/contracts.go',
      line: 20,
      ref: 'b'.repeat(40),
    },
  }, currentPointer);
  const signatureToggle = shadow.querySelector('.signature-toggle');
  assert.equal(signature.textContent, compactSignature);
  assert.equal(signature.title, fullSignature);
  assert.equal(signatureToggle.hidden, false);
  assert.equal(signatureToggle.getAttribute('aria-expanded'), 'false');
  signatureToggle.click();
  assert.equal(signature.textContent, fullSignature);
  assert.equal(signatureToggle.textContent, 'Collapse signature');
  assert.equal(signatureToggle.getAttribute('aria-expanded'), 'true');

  helpers.showResult({
    status: 'references',
    definition: { name: 'NewContractService', kind: 'function', signature: fullSignature, compactSignature, path: 'service/contracts.go', line: 20 },
    locations: [],
    hasMore: false,
  }, currentPointer);
  assert.equal(signature.textContent, compactSignature, 'usage results reset long signatures to collapsed');
  assert.equal(signatureToggle.getAttribute('aria-expanded'), 'false');

  popover.dispatchEvent(new window.Event('pointerdown'));
  assert.equal(popover.getAttribute('role'), 'dialog');
  assert.equal(helpers.dismissPinnedPopoverFromOutside({ composedPath: () => [window.document.body] }), true);
  assert.equal(popover.classList.contains('show'), false);

  helpers.showResult({
    status: 'resolved',
    isDefinition: false,
    definition: { name: 'Run', kind: 'function', signature: 'func Run() error', documentation: '', path: 'service/run.go', line: 12, ref: 'b'.repeat(40) },
  }, currentPointer);
  shadow.querySelector('.choice').dispatchEvent(new window.Event('focusin', { bubbles: true }));
  assert.equal(popover.getAttribute('role'), 'dialog');
  helpers.onKeyDown(new window.KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
  assert.equal(popover.classList.contains('show'), false);

  helpers.showResult({
    status: 'implementations',
    interfaceDefinition: { name: 'Runner', signature: 'type Runner interface { Run() error }', path: 'service/runner.go', line: 1, column: 6 },
    methodCount: 1,
    candidates: [
      { displayName: 'service.Runner', kind: 'struct', matchedMethods: 1, methodCount: 1, confidence: 'asserted', path: 'service/runner.go', ref: 'b'.repeat(40), line: 4, documentationLine: 3, documentation: 'Runner handles production work.', isTestDouble: false },
      { displayName: '*mocks.Runner', kind: 'struct', matchedMethods: 1, methodCount: 1, confidence: 'structural', path: 'internal/mocks/runner.go', ref: 'b'.repeat(40), line: 5, documentationLine: 0, documentation: '', isTestDouble: true },
    ],
  }, currentPointer);
  assert.equal(popover.hasAttribute('aria-busy'), false);
  assert.equal(shadow.querySelector('.loading-progress').hidden, true);
  assert.equal(shadow.querySelector('.popover-title').textContent, 'Implementations of Runner');
  assert.equal(copyButton.dataset.copyText, 'service/current.go:44:9');
  assert.equal(shadow.querySelector('.popover-header .symbol-badge').textContent, 'I');
  assert.match(shadow.querySelector('.choices button').textContent, /service\.Runner.*service\/runner\.go:3.*Explicit assertion/s);
  assert.match(shadow.querySelector('.choice-doc').textContent, /production work/);
  assert.equal(shadow.querySelector('.choices button .symbol-badge').textContent, 'S');
  assert.equal(shadow.querySelector('.choices button .destination-icon').classList.contains('destination-in-diff'), true);
  assert.equal(shadow.querySelector('.test-double-choices .destination-icon').classList.contains('destination-new-tab'), true);
  assert.equal(shadow.querySelector('details').open, false);
  assert.equal(shadow.querySelector('summary').textContent, 'Test doubles (1)');
  assert.equal(popover.getAttribute('role'), 'dialog');
  assert.equal(helpers.schedulePassivePopoverDismissal(), false);

  shadow.querySelector('.close-button').click();
  assert.equal(popover.classList.contains('show'), false);

  helpers.showResult({
    status: 'projectPackage',
    symbol: 'entity',
    importPath: 'gitlab.com/energyzero/backend/backend/svc/snapshot/internal/core/entity',
    packagePath: 'svc/snapshot/internal/core/entity',
    ref: 'b'.repeat(40),
  }, currentPointer);
  assert.equal(shadow.querySelector('.popover-header .symbol-badge').textContent, 'PKG');
  assert.equal(copyButton.dataset.copyText, 'service/current.go:44:9');
  assert.equal(shadow.querySelector('.popover-title').textContent, 'entity');
  assert.equal(shadow.querySelector('.choices button .choice-title').textContent, 'Open package directory');
  assert.match(shadow.querySelector('.choice-context').textContent, /^svc\/snapshot\/internal\/core\/entity/);

  helpers.showResult({
    status: 'unsupportedImplementations',
    reason: 'typeSetConstraint',
    interfaceDefinition: { name: 'Number' },
  }, currentPointer);
  assert.match(shadow.querySelector('.docs').textContent, /type-set constraint/);

  helpers.showResult({
    status: 'references',
    definition: { name: 'Run', kind: 'function', path: 'service/run.go', line: 12 },
    locations: [],
    hasMore: false,
    scope: { kind: 'indexedPackages', packageCount: 12, complete: false, searchStatus: 'limited' },
    request: { kind: 'references', ref: 'b'.repeat(40), target: currentPointer, definition: { name: 'Run' } },
  }, currentPointer);
  assert.equal(shadow.querySelector('.docs').textContent, 'Not found in 12 indexed packages. Search coverage is incomplete.');
  assert.equal(shadow.querySelector('.scope').textContent, '12 indexed packages · search coverage is incomplete');
  assert.equal([...shadow.querySelectorAll('.choices button')].at(-1).textContent, 'Search complete project');
  assert.equal(shadow.querySelector('.full-search-dialog').getAttribute('aria-modal'), 'true');
  assert.equal(shadow.querySelector('.full-search-minimize').getAttribute('aria-label'), 'Minimize full-project search');

  helpers.showResult({
    status: 'implementations',
    interfaceDefinition: { name: 'Runner' },
    methodCount: 1,
    candidates: [],
    hasMore: false,
    scope: { kind: 'fullProject', packageCount: 40, complete: true, searchStatus: 'complete' },
  }, currentPointer);
  assert.equal(shadow.querySelector('.docs').textContent, 'Full project searched; no result exists.');
  assert.equal(shadow.querySelector('.choices').textContent.includes('Search complete project'), false);
});

test('includes project Go sources but excludes vendor and testdata trees', () => {
  assert.equal(helpers.isProjectGoPath('service/runner.go'), true);
  assert.equal(helpers.isProjectGoPath('service/runner_test.go'), true);
  assert.equal(helpers.isProjectGoPath('vendor/example.com/lib/runner.go'), false);
  assert.equal(helpers.isProjectGoPath('pkg/testdata/broken.go'), false);
  assert.equal(helpers.isProjectGoPath('README.md'), false);
});

test('uses GitLab pagination headers and falls back when headers are omitted', () => {
  const response = (nextPage = '') => ({ headers: new Headers(nextPage ? { 'x-next-page': nextPage } : {}) });
  assert.equal(helpers.nextPageNumber(response('7'), 2, Array(100)), 7);
  assert.equal(helpers.nextPageNumber(response(), 2, Array(100)), 3);
  assert.equal(helpers.nextPageNumber(response(), 2, Array(12)), 0);
});

test('exhausts commit-pinned basic code search and supports cancellation', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, { signal } = {}) => {
      requests.push(String(url));
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const page = Number(new URL(url).searchParams.get('page'));
      const entries = page === 1
        ? Array.from({ length: 100 }, (_value, index) => ({ path: `pkg${index}/runner.go` }))
        : [{ path: 'final/runner.go' }];
      return {
        ok: true,
        headers: { get: (name) => name.toLowerCase() === 'x-next-page' && page === 1 ? '2' : '' },
        async json() { return entries; },
      };
    };
    const complete = await helpers.searchProjectBlobPaths('Run', 'a'.repeat(40), {
      maxPages: Infinity, maxPaths: Infinity, searchType: 'basic',
    });
    assert.equal(complete.status, 'complete');
    assert.equal(complete.paths.length, 101);
    assert.equal(requests.length, 2);
    const parameters = new URL(requests[0]).searchParams;
    assert.equal(parameters.get('ref'), 'a'.repeat(40));
    assert.equal(parameters.get('search_type'), 'basic');

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      helpers.searchProjectBlobPaths('Run', 'a'.repeat(40), { maxPages: Infinity, signal: controller.signal }),
      { name: 'AbortError' },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('opens documented declarations at their attached comment', () => {
  assert.equal(helpers.destinationLineForDefinition({ line: 12, documentationLine: 10 }), 10);
  assert.equal(helpers.destinationLineForDefinition({ line: 12, documentationLine: 0 }), 12);
});

test('prefers the new-side line when a split diff has matching old and new line numbers', () => {
  const window = new Window({ url: globalThis.location.href });
  window.document.body.innerHTML = `
    <table><tbody><tr>
      <td class="old_line"><a href="#old_12" aria-label="Deleted line 12">12</a></td>
      <td class="new_line"><a href="#new_12" aria-label="Added line 12">12</a></td>
    </tr></tbody></table>
  `;
  assert.equal(helpers.lineAnchorFor(window.document.body, 12).getAttribute('aria-label'), 'Added line 12');
});

test('expands a collapsed diff hunk until the definition line is visible', async () => {
  const window = new Window({ url: globalThis.location.href });
  window.document.body.innerHTML = `
    <section class="diff-file"><table><tbody>
      <tr><td><a href="#line_30" aria-label="Added line 30">30</a></td></tr>
    </tbody></table>
    <button type="button" data-click="expandLines" data-expand-direction="up">Show lines before</button></section>
  `;
  const root = window.document.querySelector('.diff-file');
  root.querySelector('button').addEventListener('click', () => {
    root.querySelector('tbody').insertAdjacentHTML('afterbegin', '<tr><td><a href="#line_12" aria-label="Added line 12">12</a></td></tr>');
  });
  const line = await helpers.revealLine(root, 12);
  assert.equal(line?.getAttribute('aria-label'), 'Added line 12');
});

test('extracts file and new-line context from a Rapid Diffs row', () => {
  const window = new Window({ url: globalThis.location.href });
  window.document.body.innerHTML = `
    <section class="diff-file">
      <header class="diff-file-header"><a class="file-title-name" href="https://gitlab.example/group/project/-/blob/${'b'.repeat(40)}/svc/search/search.go">svc/ search/ search.go</a></header>
      <table><tbody><tr><td><a href="#diff-content_31" aria-label="Added line 31">31</a></td><td class="line_content"><span>Target()</span></td></tr></tbody></table>
    </section>
  `;
  const token = window.document.querySelector('.line_content span');
  const cell = helpers.codeCellFor(token);
  assert.equal(cell.className, 'line_content');
  assert.deepEqual(
    helpers.fileContextFor(cell),
    {
      root: window.document.querySelector('.diff-file'),
      path: 'svc/search/search.go',
      oldPath: 'svc/search/search.go',
      newPath: 'svc/search/search.go',
      packagePath: 'svc/search',
      ref: 'b'.repeat(40),
    },
  );
  assert.deepEqual(helpers.lineContextFor(cell), { line: 31, side: 'new' });
});

test('marks deleted diff rows as old-side source', () => {
  const window = new Window({ url: globalThis.location.href });
  window.document.body.innerHTML = '<table><tbody><tr><td class="old_line"><a href="#diff-content_12" aria-label="Deleted line 12">12</a></td><td class="line_content old"><span>Removed()</span></td></tr></tbody></table>';
  const cell = window.document.querySelector('.line_content');
  assert.deepEqual(helpers.lineContextFor(cell), { line: 12, side: 'old' });
});

test('uses Rapid Diffs position metadata for parallel old and new source lines', () => {
  const window = new Window({ url: globalThis.location.href });
  window.document.body.innerHTML = `
    <table><tbody><tr>
      <td class="rd-line-number" data-position="old"><a class="rd-line-link" data-line-number="40" aria-label="Line 40"></a></td>
      <td class="rd-line-content" data-position="old"><span id="old-err">err</span></td>
      <td class="rd-line-number" data-position="new"><a class="rd-line-link" data-line-number="45" aria-label="Line 45"></a></td>
      <td class="rd-line-content" data-position="new"><span id="new-err">err</span></td>
    </tr></tbody></table>
  `;
  assert.deepEqual(helpers.lineContextFor(window.document.querySelector('#old-err').closest('td')), { line: 40, side: 'old' });
  assert.deepEqual(helpers.lineContextFor(window.document.querySelector('#new-err').closest('td')), { line: 45, side: 'new' });
});

test('extracts paths and file context from current Rapid Diffs custom elements', () => {
  const window = new Window({ url: globalThis.location.href });
  const sha = 'c'.repeat(40);
  window.document.body.innerHTML = `
    <diff-file data-testid="rd-diff-file" data-file-data='{"viewer":"text_inline","old_path":"pkg/old.go","new_path":"pkg/new.go"}'>
      <article class="rd-diff-file">
        <header class="rd-diff-file-header" data-testid="rd-diff-file-header">
          <h2 class="rd-diff-file-title"><a class="rd-diff-file-link" href="https://gitlab.example/group/project/-/blob/${sha}/pkg/new.go">pkg/new.go</a></h2>
        </header>
        <table><tbody><tr><td class="new_line"><a href="#line_hash_A9" aria-label="Added line 9">9</a></td><td class="line_content"><span>Target</span>()</td></tr></tbody></table>
      </article>
    </diff-file>
  `;
  const token = window.document.querySelector('.line_content span');
  const cell = helpers.codeCellFor(token);
  assert.equal(helpers.fileContextFor(cell).root.localName, 'diff-file');
  assert.deepEqual(
    { ...helpers.fileContextFor(cell), root: undefined },
    {
      root: undefined,
      path: 'pkg/new.go',
      oldPath: 'pkg/old.go',
      newPath: 'pkg/new.go',
      packagePath: 'pkg',
      ref: sha,
    },
  );
  assert.deepEqual(helpers.lineContextFor(cell), { line: 9, side: 'new' });
});

test('finds identifier-boundary occurrences only in loaded Go diff code', () => {
  const previousDocument = globalThis.document;
  const previousNodeFilter = globalThis.NodeFilter;
  const window = new Window({ url: globalThis.location.href });
  const sha = 'd'.repeat(40);
  window.document.body.innerHTML = `
    <section class="diff-file" data-file-path="pkg/run.go">
      <a class="file-title-name" href="https://gitlab.example/group/project/-/blob/${sha}/pkg/run.go">pkg/run.go</a>
      <table><tbody>
        <tr class="new"><td class="new_line"><a aria-label="Added line 1">1</a></td><td class="line_content">Run Runner Run</td></tr>
        <tr><td class="new_line"><a aria-label="Added line 2">2</a></td><td class="line_content"><span>Run</span>()</td></tr>
      </tbody></table>
    </section>`;
  globalThis.document = window.document;
  globalThis.NodeFilter = window.NodeFilter;
  try {
    const occurrences = helpers.occurrenceRanges('Run');
    assert.equal(occurrences.length, 3);
    const keyboardTarget = helpers.targetForOccurrence(occurrences[2], 'Run');
    assert.deepEqual(
      { identifier: keyboardTarget.identifier, character: keyboardTarget.character, occurrence: keyboardTarget.occurrence },
      { identifier: 'Run', character: 0, occurrence: 0 },
    );
    assert.equal(keyboardTarget.cell, occurrences[2].cell);
    assert.equal(helpers.identifierBoundary('_'), false);
    assert.equal(helpers.hunkTargets().length, 1);
    assert.equal(helpers.locationKey({ path: 'pkg/run.go', line: 2 }), 'pkg/run.go:2:new');
  } finally {
    globalThis.document = previousDocument;
    globalThis.NodeFilter = previousNodeFilter;
  }
});

test('extracts distinct old and new bookmark locations for non-Go diff lines', () => {
  const window = new Window({ url: globalThis.location.href });
  const sha = 'e'.repeat(40);
  window.document.body.innerHTML = `
    <section class="diff-file" data-file-path="README.md">
      <a class="file-title-name" href="https://gitlab.example/group/project/-/blob/${sha}/README.md">README.md</a>
      <table><tbody><tr>
        <td class="old_line"><a href="#old_12" aria-label="Deleted line 12">12</a></td><td class="line_content old">old</td>
        <td class="new_line"><a href="#new_12" aria-label="Added line 12">12</a></td><td class="line_content new">new</td>
      </tr></tbody></table>
    </section>`;
  assert.deepEqual(helpers.bookmarkLocationForNode(window.document.querySelector('.old_line')), {
    path: 'README.md', side: 'old', startLine: 12, endLine: 12,
  });
  assert.deepEqual(helpers.bookmarkLocationForNode(window.document.querySelector('.new_line')), {
    path: 'README.md', side: 'new', startLine: 12, endLine: 12,
  });
  assert.equal(helpers.bookmarkFileContextFor(window.document.querySelector('.line_content')).newPath, 'README.md');
});

test('accepts only contiguous bookmark selections within one file and side', () => {
  const previousDocument = globalThis.document;
  const previousGetSelection = globalThis.getSelection;
  const window = new Window({ url: globalThis.location.href });
  const sha = 'f'.repeat(40);
  window.document.body.innerHTML = `
    <section class="diff-file" data-file-path="docs/review.md">
      <a class="file-title-name" href="https://gitlab.example/group/project/-/blob/${sha}/docs/review.md">docs/review.md</a>
      <table><tbody>
        <tr><td class="new_line"><a aria-label="Added line 4">4</a></td><td class="line_content" id="line-4">first</td></tr>
        <tr><td class="new_line"><a aria-label="Added line 5">5</a></td><td class="line_content" id="line-5">second</td></tr>
      </tbody></table>
    </section>`;
  globalThis.document = window.document;
  globalThis.getSelection = () => window.getSelection();
  try {
    const selection = window.getSelection();
    const range = window.document.createRange();
    range.setStart(window.document.getElementById('line-4').firstChild, 0);
    range.setEnd(window.document.getElementById('line-5').firstChild, 6);
    selection.removeAllRanges();
    selection.addRange(range);
    assert.deepEqual(helpers.bookmarkSelectionState(), {
      location: { path: 'docs/review.md', side: 'new', startLine: 4, endLine: 5 }, invalid: false,
    });
  } finally {
    globalThis.document = previousDocument;
    globalThis.getSelection = previousGetSelection;
  }
});

test('recovers stale bookmarks only from one safe context match', async () => {
  const hash = globalThis.GoLensBookmarks.hashText;
  const original = ['before()', 'Target(old)', 'after()'];
  const record = {
    location: { path: 'pkg/review.go', side: 'new', startLine: 2, endLine: 2 },
    anchor: {
      symbol: 'Target',
      selectionHash: await hash(original[1]),
      beforeHash: await hash(original[0]),
      afterHash: await hash(original[2]),
    },
  };
  const moved = ['header', 'before()', 'Target(new)', 'after()', 'footer'];
  const unique = await helpers.bookmarkRecoveryCandidates(moved, record);
  assert.equal(unique.length, 1);
  assert.equal(unique[0].index, 2);
  assert.notEqual(unique[0].anchor.selectionHash, record.anchor.selectionHash, 'both adjacent lines may safely recover an edited bookmarked line');

  const ambiguous = await helpers.bookmarkRecoveryCandidates([...moved, ...moved], record);
  assert.equal(ambiguous.length, 2);
  assert.equal((await helpers.bookmarkRecoveryCandidates(['before()', 'Other()', 'after()'], record)).length, 0, 'the stored symbol remains a required constraint');
});
