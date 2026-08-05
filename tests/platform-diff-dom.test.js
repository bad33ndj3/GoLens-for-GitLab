import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { Window } from 'happy-dom';
import {
  bumpFileContextGeneration,
  codeCellFor,
  computeFileContext,
  diffFileRoots,
  diffRootFor,
  expansionDirectionForLine,
  fileContextFor,
  flashDestination,
  lineAnchorFor,
  lineContextFor,
  lineFromAnchor,
  navigateToLocation,
  rapidFileData,
  revealLine,
  visibleDiffRootForDefinition,
  waitForDiffUpdate,
} from '../page/platform/diff-dom.js';

// These primitives moved out of go-navigation.js unchanged. This suite covers
// the module directly, including the pieces that are not otherwise tested —
// `computeFileContext`, `diffFileRoots`, `rapidFileData`, `flashDestination`,
// and `bumpFileContextGeneration`'s cache contract.

const SHA = 'a'.repeat(40);

before(() => {
  // `parseBlobLink` resolves blob hrefs against `location.href`, and
  // diffFileRoots/visibleDiffRootForDefinition read the global `document`.
  globalThis.location = {
    href: 'https://gitlab.example/group/project/-/merge_requests/42/diffs',
    origin: 'https://gitlab.example',
    pathname: '/group/project/-/merge_requests/42/diffs',
  };
  globalThis.document = new Window({ url: globalThis.location.href }).document;
});

function mountFixture(html) {
  const window = new Window({ url: globalThis.location.href });
  window.document.body.innerHTML = html;
  globalThis.document = window.document;
  return window;
}

function rapidDiffFile({ sha = SHA, oldPath = 'pkg/cache.go', newPath = 'pkg/cache.go' } = {}) {
  return `
    <div id="diffs">
      <diff-file data-testid="rd-diff-file" data-file-data='{"old_path":"${oldPath}","new_path":"${newPath}"}'>
        <article class="rd-diff-file">
          <a class="rd-diff-file-link" href="https://gitlab.example/group/project/-/blob/${sha}/${newPath}">${newPath}</a>
          <table><tbody><tr>
            <td class="new_line"><a href="#line_7" aria-label="Added line 7">7</a></td>
            <td data-testid="rd-diff-line-content"><span class="id">Target</span>()</td>
          </tr></tbody></table>
        </article>
      </diff-file>
    </div>`;
}

test('resolves the outer Rapid Diffs custom element as the diff root', () => {
  const window = mountFixture(rapidDiffFile());
  const token = window.document.querySelector('.id');
  assert.equal(diffRootFor(token).localName, 'diff-file');
});

test('falls back to a table parent when no diff-file wrapper exists', () => {
  const window = mountFixture('<section id="legacy"><table><tbody><tr><td class="line_content"><span class="id">x</span></td></tr></tbody></table></section>');
  assert.equal(diffRootFor(window.document.querySelector('.id')).id, 'legacy');
});

test('reads Rapid Diffs file metadata and tolerates missing or invalid JSON', () => {
  const window = mountFixture(rapidDiffFile({ oldPath: 'pkg/old.go', newPath: 'pkg/new.go' }));
  assert.deepEqual(rapidFileData(window.document.querySelector('diff-file')), { old_path: 'pkg/old.go', new_path: 'pkg/new.go' });
  assert.deepEqual(rapidFileData(null), {});
  window.document.querySelector('diff-file').setAttribute('data-file-data', '{not json');
  assert.deepEqual(rapidFileData(window.document.querySelector('diff-file')), {});
});

test('computes a commit-pinned file context with separate old and new paths', () => {
  const window = mountFixture(rapidDiffFile({ oldPath: 'pkg/old.go', newPath: 'pkg/new.go' }));
  const root = window.document.querySelector('diff-file');
  assert.deepEqual(
    { ...computeFileContext(root), root: undefined },
    { root: undefined, path: 'pkg/new.go', oldPath: 'pkg/old.go', newPath: 'pkg/new.go', packagePath: 'pkg', ref: SHA },
  );
});

test('returns no file context for non-Go files', () => {
  const window = mountFixture(rapidDiffFile({ oldPath: 'docs/readme.md', newPath: 'docs/readme.md' }));
  assert.equal(computeFileContext(window.document.querySelector('diff-file')), null);
});

test('caches file context per diff root until the generation is bumped', () => {
  const newSha = 'b'.repeat(40);
  const window = mountFixture(rapidDiffFile());
  const root = window.document.querySelector('diff-file');
  const cell = window.document.querySelector('[data-testid="rd-diff-line-content"]');
  assert.equal(fileContextFor(cell).ref, SHA);

  root.querySelector('a.rd-diff-file-link').setAttribute('href', `https://gitlab.example/group/project/-/blob/${newSha}/pkg/cache.go`);
  assert.equal(fileContextFor(cell).ref, SHA, 'a second read hits the cache without re-resolving');

  bumpFileContextGeneration();
  assert.equal(fileContextFor(cell).ref, newSha, 'bumping the generation invalidates the cached context');
});

test('caches negative file-context results too', () => {
  const window = mountFixture(rapidDiffFile({ oldPath: 'docs/readme.md', newPath: 'docs/readme.md' }));
  const cell = window.document.querySelector('[data-testid="rd-diff-line-content"]');
  assert.equal(fileContextFor(cell), null);
  assert.equal(fileContextFor(cell), null);
});

test('returns no file context for a node outside any diff root', () => {
  mountFixture('<p id="loose">not a diff</p>');
  assert.equal(fileContextFor(globalThis.document.querySelector('#loose')), null);
});

test('finds the code cell for a token and rejects line-number cells', () => {
  const window = mountFixture(rapidDiffFile());
  const cell = codeCellFor(window.document.querySelector('.id'));
  assert.equal(cell.getAttribute('data-testid'), 'rd-diff-line-content');
  assert.equal(codeCellFor(window.document.querySelector('td.new_line a')), null);
});

test('reads line numbers from data attributes, labels, text, and hashes', () => {
  const window = mountFixture(`
    <table><tbody><tr>
      <td><a id="data" data-line-number="12"></a></td>
      <td><a id="label" aria-label="Added line 34"></a></td>
      <td><a id="text">56</a></td>
      <td><a id="hash" href="#diff-content_78"></a></td>
      <td><a id="none"></a></td>
    </tr></tbody></table>`);
  const at = (id) => window.document.querySelector(`#${id}`);
  assert.equal(lineFromAnchor(at('data')), 12);
  assert.equal(lineFromAnchor(at('label')), 34);
  assert.equal(lineFromAnchor(at('text')), 56);
  assert.equal(lineFromAnchor(at('hash')), 78);
  assert.equal(lineFromAnchor(at('none')), 0);
  assert.equal(lineFromAnchor(null), 0);
});

test('prefers the requested side when both diff sides carry the same line number', () => {
  const window = mountFixture(`
    <table><tbody><tr>
      <td class="old_line"><a href="#old_12" aria-label="Deleted line 12">12</a></td>
      <td class="new_line"><a href="#new_12" aria-label="Added line 12">12</a></td>
    </tr></tbody></table>`);
  const root = window.document.body;
  assert.equal(lineAnchorFor(root, 12, 'old').getAttribute('aria-label'), 'Deleted line 12');
  assert.equal(lineAnchorFor(root, 12, 'new').getAttribute('aria-label'), 'Added line 12');
  assert.equal(lineAnchorFor(root, 12).getAttribute('aria-label'), 'Added line 12', 'defaults to the new side');
  assert.equal(lineAnchorFor(root, 99), null);
});

test('decides which way a collapsed hunk must expand', () => {
  assert.equal(expansionDirectionForLine(12, [30, 31, 32]), 'up');
  assert.equal(expansionDirectionForLine(48, [30, 31, 32]), 'down');
  assert.equal(expansionDirectionForLine(31, [30, 31, 32]), null);
  assert.equal(expansionDirectionForLine(31, []), null);
  assert.equal(expansionDirectionForLine(31, [0, NaN]), null, 'ignores non-line values');
});

test('resolves waitForDiffUpdate on the first mutation of the observed root', async () => {
  const window = mountFixture('<section class="diff-file"><table><tbody></tbody></table></section>');
  const root = window.document.querySelector('.diff-file');
  const updated = waitForDiffUpdate(root);
  root.querySelector('tbody').insertAdjacentHTML('beforeend', '<tr><td>added</td></tr>');
  await updated;
});

test('expands a collapsed diff hunk until the requested line is visible', async () => {
  const window = mountFixture(`
    <section class="diff-file"><table><tbody>
      <tr><td><a href="#line_30" aria-label="Added line 30">30</a></td></tr>
    </tbody></table>
    <button type="button" data-click="expandLines" data-expand-direction="up">Show lines before</button></section>`);
  const root = window.document.querySelector('.diff-file');
  root.querySelector('button').addEventListener('click', () => {
    root.querySelector('tbody').insertAdjacentHTML('afterbegin', '<tr><td><a href="#line_12" aria-label="Added line 12">12</a></td></tr>');
  });
  const line = await revealLine(root, 12);
  assert.equal(line?.getAttribute('aria-label'), 'Added line 12');
});

test('gives up on revealing a line when no expansion control remains', async () => {
  const window = mountFixture('<section class="diff-file"><table><tbody></tbody></table></section>');
  assert.equal(await revealLine(window.document.querySelector('.diff-file'), 12), null);
});

test('expands a collapsed middle hunk (no direction) using its own fold control', async () => {
  const window = mountFixture(`
    <section class="diff-file"><table><tbody>
      <tr><td><a href="#line_10" aria-label="Added line 10">10</a></td></tr>
      <tr class="match"><td><button type="button" data-click="expandLines" data-expand-direction="down">Expand hunk</button></td></tr>
      <tr><td><a href="#line_40" aria-label="Added line 40">40</a></td></tr>
    </tbody></table></section>`);
  const root = window.document.querySelector('.diff-file');
  root.querySelector('button').addEventListener('click', () => {
    root.querySelector('tbody').insertAdjacentHTML('beforeend', '<tr><td><a href="#line_25" aria-label="Added line 25">25</a></td></tr>');
  });
  const line = await revealLine(root, 25);
  assert.equal(line?.getAttribute('aria-label'), 'Added line 25');
});

test('expands the fold nearest the target line, not the first control in document order', async () => {
  const window = mountFixture(`
    <section class="diff-file"><table><tbody>
      <tr class="match"><td><button type="button" data-click="expandLines" data-expand-direction="up">Expand top</button></td></tr>
      <tr><td><a href="#line_10" aria-label="Added line 10">10</a></td></tr>
      <tr class="match"><td><button type="button" data-click="expandLines" data-expand-direction="down">Expand middle</button></td></tr>
      <tr><td><a href="#line_40" aria-label="Added line 40">40</a></td></tr>
    </tbody></table></section>`);
  const root = window.document.querySelector('.diff-file');
  const [topButton, middleButton] = root.querySelectorAll('button');
  topButton.addEventListener('click', () => {
    root.querySelector('tbody').insertAdjacentHTML('afterbegin', '<tr><td><a href="#line_1" aria-label="Added line 1">1</a></td></tr>');
  });
  middleButton.addEventListener('click', () => {
    middleButton.closest('tr').insertAdjacentHTML('afterend', '<tr><td><a href="#line_25" aria-label="Added line 25">25</a></td></tr>');
  });
  const line = await revealLine(root, 25);
  assert.equal(line?.getAttribute('aria-label'), 'Added line 25');
  assert.equal(topButton.isConnected, true, 'the unrelated top-of-file control should not have been clicked');
});

test('expands a single-line fold even when the old/new side numbering diverges around it', async () => {
  // Side-by-side row carries both an old- and new-side anchor. Old numbering
  // runs ahead of new here (prior deletions), so naively reading "the first
  // anchor in the row" for before/after would pick the old side and see
  // before=15/after=16 straddling nothing around new-side target line 10 —
  // exactly the single-line-fold regression this test guards against.
  const window = mountFixture(`
    <section class="diff-file"><table><tbody>
      <tr class="match"><td><button type="button" data-click="expandLines" data-expand-direction="up">Expand top</button></td></tr>
      <tr>
        <td><a href="#old_15" data-position="old" aria-label="Line 15">15</a></td>
        <td><a href="#new_9" data-position="new" aria-label="Added line 9">9</a></td>
      </tr>
      <tr class="match"><td><button type="button" data-click="expandLines" data-expand-direction="down">Expand fold</button></td></tr>
      <tr>
        <td><a href="#old_16" data-position="old" aria-label="Line 16">16</a></td>
        <td><a href="#new_11" data-position="new" aria-label="Added line 11">11</a></td>
      </tr>
    </tbody></table></section>`);
  const root = window.document.querySelector('.diff-file');
  const [topButton, foldButton] = root.querySelectorAll('button');
  foldButton.addEventListener('click', () => {
    foldButton.closest('tr').insertAdjacentHTML('afterend', '<tr><td></td><td><a href="#new_10" data-position="new" aria-label="Added line 10">10</a></td></tr>');
  });
  const line = await revealLine(root, 10, 'new');
  assert.equal(line?.getAttribute('aria-label'), 'Added line 10');
  assert.equal(topButton.isConnected, true, 'the unrelated top-of-file control should not have been clicked');
});

test('picks the side GitLab marks via data-position, even without an old/deleted label or class', () => {
  const window = mountFixture(`
    <table><tbody><tr>
      <td data-position="old"><a data-line-number="12">12</a></td>
      <td data-position="new"><a data-line-number="12">12</a></td>
    </tr></tbody></table>`);
  const root = window.document.body;
  const [oldAnchor, newAnchor] = root.querySelectorAll('a');
  assert.equal(lineAnchorFor(root, 12, 'old'), oldAnchor, 'data-position="old" must win with no label/class to fall back on');
  assert.equal(lineAnchorFor(root, 12, 'new'), newAnchor);
  assert.equal(lineAnchorFor(root, 12), newAnchor, 'defaults to the new side');
});

test('falls back to the legacy .js-unfold controls when Rapid Diffs markup is absent', async () => {
  const window = mountFixture(`
    <section class="diff-file"><table><tbody>
      <tr><td><a href="#line_30" aria-label="Added line 30">30</a></td></tr>
    </tbody></table>
    <a class="js-unfold" href="#">Show lines before</a></section>`);
  const root = window.document.querySelector('.diff-file');
  root.querySelector('.js-unfold').addEventListener('click', () => {
    root.querySelector('tbody').insertAdjacentHTML('afterbegin', '<tr><td><a href="#line_12" aria-label="Added line 12">12</a></td></tr>');
  });
  const line = await revealLine(root, 12);
  assert.equal(line?.getAttribute('aria-label'), 'Added line 12');
});

test('matches a definition path against the loaded diff roots', () => {
  const window = mountFixture(rapidDiffFile({ oldPath: 'pkg/old.go', newPath: 'pkg/new.go' }));
  assert.equal(visibleDiffRootForDefinition({ path: 'pkg/new.go' }), window.document.querySelector('diff-file'));
  assert.equal(visibleDiffRootForDefinition({ path: 'pkg/old.go' }), window.document.querySelector('diff-file'));
  assert.equal(visibleDiffRootForDefinition({ path: 'pkg/absent.go' }), undefined);
});

test('lists diff roots without double-counting the Rapid Diffs inner article', () => {
  const window = mountFixture(`${rapidDiffFile()}<section class="diff-file" id="legacy"></section>`);
  const roots = diffFileRoots();
  assert.deepEqual(roots.map((root) => root.id || root.localName), ['diff-file', 'legacy']);
  assert.equal(window.document.querySelectorAll('.rd-diff-file').length, 1, 'the inner article exists but is not a root');
});

test('flashes a destination row with the navigation attribute', () => {
  const window = mountFixture('<table><tbody><tr id="row"><td>x</td></tr></tbody></table>');
  const row = window.document.querySelector('#row');
  flashDestination(row);
  assert.equal(row.hasAttribute('data-golens-navigation-destination'), true);
  flashDestination(null);
});

test('navigates to a location inside the loaded diff and reports success', async () => {
  const window = mountFixture(rapidDiffFile());
  const scrolled = [];
  window.document.querySelector('tr').scrollIntoView = (options) => scrolled.push(options);
  assert.equal(await navigateToLocation({ path: 'pkg/cache.go', line: 7, side: 'new' }), true);
  assert.deepEqual(scrolled, [{ behavior: 'smooth', block: 'center' }]);
  assert.equal(window.document.querySelector('tr').hasAttribute('data-golens-navigation-destination'), true);
});

test('reports failure when the location is not in the loaded diff', async () => {
  mountFixture(rapidDiffFile());
  assert.equal(await navigateToLocation({ path: 'pkg/absent.go', line: 7 }), false);
});

test('reads the line and side belonging to a code cell', () => {
  const window = mountFixture(`
    <table><tbody><tr>
      <td class="rd-line-number" data-position="old"><a class="rd-line-link" data-line-number="40" aria-label="Line 40"></a></td>
      <td class="rd-line-content" data-position="old"><span id="old-err">err</span></td>
      <td class="rd-line-number" data-position="new"><a class="rd-line-link" data-line-number="45" aria-label="Line 45"></a></td>
      <td class="rd-line-content" data-position="new"><span id="new-err">err</span></td>
    </tr></tbody></table>`);
  assert.deepEqual(lineContextFor(window.document.querySelector('#old-err').closest('td')), { line: 40, side: 'old' });
  assert.deepEqual(lineContextFor(window.document.querySelector('#new-err').closest('td')), { line: 45, side: 'new' });
});

test('returns no line context for a cell outside a row', () => {
  const window = mountFixture('<div id="loose">x</div>');
  assert.equal(lineContextFor(window.document.querySelector('#loose')), null);
});
