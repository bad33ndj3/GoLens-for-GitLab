import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeRepositoryPath,
  folderContainsPath,
  hasCollapseGeneratedFilesLink,
  isGeneratedWarning,
  shouldHideGeneratedFiles,
  shouldHideNoDiff,
  parseNoDiffRules,
  matchesNoDiffPattern,
  isNoDiffPath,
  parseDiffStatBadge,
  parsePageTotal,
  formatNoDiffTotal,
  shouldShowFullFileButtons,
  classifyFolders,
  findRapidFullFileItem,
  viewerIsText,
  fullFileButtonMode,
  matchesFullFileActionLabel,
  isShowingFullFileLabel,
  fullFileButtonView,
} from '../page/features/generated-files.internal.js';

test('normalizeRepositoryPath strips bidi marks, trims, and collapses slash whitespace', () => {
  assert.equal(normalizeRepositoryPath('  svc/generated  '), 'svc/generated');
  assert.equal(normalizeRepositoryPath('svc / generated'), 'svc/generated');
  assert.equal(normalizeRepositoryPath('/svc/generated/'), 'svc/generated');
  assert.equal(normalizeRepositoryPath('svc‎/generated'), 'svc/generated');
});

test('normalizeRepositoryPath is total: never throws on missing input', () => {
  assert.equal(normalizeRepositoryPath(undefined), '');
  assert.equal(normalizeRepositoryPath(null), '');
  assert.equal(normalizeRepositoryPath(''), '');
});

test('folderContainsPath is true only for paths nested one or more segments below the folder', () => {
  assert.equal(folderContainsPath('svc/generated', 'svc/generated/file.go'), true);
  assert.equal(folderContainsPath('svc/generated', 'svc/generated/nested/file.go'), true);
  assert.equal(folderContainsPath('svc/generated', 'svc/generated'), false);
  assert.equal(folderContainsPath('svc/generated', 'svc/other/file.go'), false);
});

test('hasCollapseGeneratedFilesLink matches only the documented help anchor', () => {
  const base = 'https://gitlab.example/group/project/-/merge_requests/1/diffs';
  assert.equal(
    hasCollapseGeneratedFilesLink(['/help/user/project/merge_requests/changes.md#collapse-generated-files'], base),
    true
  );
  assert.equal(
    hasCollapseGeneratedFilesLink(['/help/user/project/merge_requests/changes#collapse-generated-files'], base),
    true
  );
  assert.equal(hasCollapseGeneratedFilesLink(['/help/user/other#collapse-generated-files'], base), false);
  assert.equal(hasCollapseGeneratedFilesLink(['/help/user/project/merge_requests/changes.md#other'], base), false);
});

test('hasCollapseGeneratedFilesLink is total: malformed hrefs are skipped, not thrown', () => {
  assert.doesNotThrow(() => hasCollapseGeneratedFilesLink([':::not a url:::'], 'not-a-base'));
  assert.equal(hasCollapseGeneratedFilesLink([':::not a url:::'], 'not-a-base'), false);
  assert.equal(hasCollapseGeneratedFilesLink(undefined, 'https://gitlab.example'), false);
});

test('isGeneratedWarning requires both the .gitattributes text and the documentation link', () => {
  const base = 'https://gitlab.example/group/project/-/merge_requests/1/diffs';
  const link = ['/help/user/project/merge_requests/changes.md#collapse-generated-files'];
  assert.equal(isGeneratedWarning({ text: 'See .gitattributes', hrefs: link, baseHref: base }), true);
  assert.equal(isGeneratedWarning({ text: 'Large file collapsed', hrefs: link, baseHref: base }), false);
  assert.equal(isGeneratedWarning({ text: 'See .gitattributes', hrefs: [], baseHref: base }), false);
});

test('shouldHideGeneratedFiles gates on enabled, the setting, and being on a diff page', () => {
  assert.equal(shouldHideGeneratedFiles({ enabled: true, hideGeneratedFiles: true, isDiffPage: true }), true);
  assert.equal(shouldHideGeneratedFiles({ enabled: false, hideGeneratedFiles: true, isDiffPage: true }), false);
  assert.equal(shouldHideGeneratedFiles({ enabled: true, hideGeneratedFiles: false, isDiffPage: true }), false);
  assert.equal(shouldHideGeneratedFiles({ enabled: true, hideGeneratedFiles: true, isDiffPage: false }), false);
});

test('shouldHideNoDiff gates on enabled, the new setting, and being on a diff page', () => {
  assert.equal(shouldHideNoDiff({ enabled: true, hideNoDiffAttributes: true, isDiffPage: true }), true);
  assert.equal(shouldHideNoDiff({ enabled: false, hideNoDiffAttributes: true, isDiffPage: true }), false);
  assert.equal(shouldHideNoDiff({ enabled: true, hideNoDiffAttributes: false, isDiffPage: true }), false);
  assert.equal(shouldHideNoDiff({ enabled: true, hideNoDiffAttributes: true, isDiffPage: false }), false);
});

test('parseNoDiffRules keeps file order and marks only exact -diff / diff=false attributes', () => {
  const { rules, truncated } = parseNoDiffRules('# comment\n\n*.gen.go -diff\nkeep.go diff=true\n*.min.js diff=false\n');
  assert.equal(truncated, false);
  assert.deepEqual(rules, [
    { pattern: '*.gen.go', noDiff: true },
    { pattern: 'keep.go', noDiff: false },
    { pattern: '*.min.js', noDiff: true },
  ]);
});

test('parseNoDiffRules is total and caps input explicitly instead of silently indexing a partial package', () => {
  assert.deepEqual(parseNoDiffRules(undefined), { rules: [], truncated: false });
  assert.deepEqual(parseNoDiffRules(''), { rules: [], truncated: false });
  assert.doesNotThrow(() => parseNoDiffRules(null));
  const manyLines = `${Array.from({ length: 501 }, (_, index) => `file${index}.go -diff`).join('\n')}\n`;
  const capped = parseNoDiffRules(manyLines);
  assert.equal(capped.rules.length, 500);
  assert.equal(capped.truncated, true);
  assert.equal(parseNoDiffRules(`${'x'.repeat(100 * 1024 + 1)} -diff`).truncated, true);
});

test('matchesNoDiffPattern: a pattern without a slash matches basenames, with * staying inside one segment', () => {
  assert.equal(matchesNoDiffPattern('*.gen.go', 'svc/a.gen.go'), true);
  assert.equal(matchesNoDiffPattern('*.gen.go', 'svc/a.go'), false);
  assert.equal(matchesNoDiffPattern('*.gen.go', 'a.gen.go'), true);
  assert.equal(matchesNoDiffPattern('docs/*.md', 'docs/a.md'), true);
  assert.equal(matchesNoDiffPattern('docs/*.md', 'docs/a/b.md'), false);
});

test('matchesNoDiffPattern: leading slashes anchor to the root, ** spans directories, ? one character', () => {
  assert.equal(matchesNoDiffPattern('/root.go', 'root.go'), true);
  assert.equal(matchesNoDiffPattern('/root.go', 'sub/root.go'), false);
  assert.equal(matchesNoDiffPattern('**/*.gen.go', 'svc/nested/a.gen.go'), true);
  assert.equal(matchesNoDiffPattern('**/*.gen.go', 'a.gen.go'), true);
  assert.equal(matchesNoDiffPattern('a?c.go', 'svc/abc.go'), true);
  assert.equal(matchesNoDiffPattern('a?c.go', 'svc/ac.go'), false);
  assert.equal(matchesNoDiffPattern('a?c.go', 'svc/abbc.go'), false);
});

test('matchesNoDiffPattern: a trailing slash matches a directory prefix', () => {
  assert.equal(matchesNoDiffPattern('build/', 'build/a.go'), true);
  assert.equal(matchesNoDiffPattern('build/', 'src/build/a.go'), true);
  assert.equal(matchesNoDiffPattern('build/', 'builder/a.go'), false);
  assert.equal(matchesNoDiffPattern('docs/build/', 'docs/build/a.go'), true);
  assert.equal(matchesNoDiffPattern('docs/build/', 'other/build/a.go'), false);
});

test('matchesNoDiffPattern rejects unknown glob syntax and never throws', () => {
  assert.equal(matchesNoDiffPattern('*.{go,js}', 'a.go'), false);
  assert.equal(matchesNoDiffPattern('[abc].go', 'a.go'), false);
  assert.equal(matchesNoDiffPattern('(a).go', 'a.go'), false);
  assert.equal(matchesNoDiffPattern('a!b.go', 'a!b.go'), false);
  assert.equal(matchesNoDiffPattern('', 'a.go'), false);
  assert.equal(matchesNoDiffPattern(undefined, 'a.go'), false);
  assert.equal(matchesNoDiffPattern('*.go', ''), false);
  assert.doesNotThrow(() => matchesNoDiffPattern(null, null));
});

test('matchesNoDiffPattern strips a leading ! without inverting (negation lives in isNoDiffPath)', () => {
  assert.equal(matchesNoDiffPattern('!*.go', 'a.go'), true);
});

test('isNoDiffPath applies last-match-wins with !-negation inverting the rule', () => {
  const rules = parseNoDiffRules('*.gen.go -diff\nkeep.gen.go diff\n').rules;
  assert.equal(isNoDiffPath(rules, 'svc/a.gen.go'), true);
  assert.equal(isNoDiffPath(rules, 'svc/keep.gen.go'), false);
  assert.equal(isNoDiffPath(rules, 'svc/a.go'), false);
  const negated = parseNoDiffRules('*.gen.go -diff\n!keep.gen.go -diff\n').rules;
  assert.equal(isNoDiffPath(negated, 'svc/other.gen.go'), true);
  assert.equal(isNoDiffPath(negated, 'svc/keep.gen.go'), false);
  assert.equal(isNoDiffPath([], 'a.gen.go'), false);
  assert.equal(isNoDiffPath(null, 'a.gen.go'), false);
  assert.equal(isNoDiffPath(rules, ''), false);
  assert.doesNotThrow(() => isNoDiffPath(undefined, undefined));
});

test('parseDiffStatBadge reads compact, wordy, single-sided, and unicode-minus stats', () => {
  assert.deepEqual(parseDiffStatBadge('+12 -5'), { added: 12, deleted: 5 });
  assert.deepEqual(parseDiffStatBadge('+ 12 - 3'), { added: 12, deleted: 3 });
  assert.deepEqual(parseDiffStatBadge('+12 −5'), { added: 12, deleted: 5 });
  assert.deepEqual(parseDiffStatBadge('12 additions, 3 deletions'), { added: 12, deleted: 3 });
  assert.deepEqual(parseDiffStatBadge('1 addition'), { added: 1, deleted: 0 });
  assert.deepEqual(parseDiffStatBadge('3 deletions'), { added: 0, deleted: 3 });
  assert.deepEqual(parseDiffStatBadge('+5'), { added: 5, deleted: 0 });
  assert.deepEqual(parseDiffStatBadge('-4'), { added: 0, deleted: 4 });
  assert.equal(parseDiffStatBadge('no changes'), null);
  assert.equal(parseDiffStatBadge(''), null);
  assert.equal(parseDiffStatBadge(undefined), null);
  assert.doesNotThrow(() => parseDiffStatBadge(null));
});

test('parseDiffStatBadge reads split container text ("+ 2840") but never a bare count', () => {
  assert.deepEqual(parseDiffStatBadge('+ 2840'), { added: 2840, deleted: 0 });
  assert.deepEqual(parseDiffStatBadge('- 12'), { added: 0, deleted: 12 });
  assert.equal(parseDiffStatBadge('2840'), null, 'a bare count carries no side info — the shell reads it via its js-file-*-line testid, never this parser');
});

test('parsePageTotal shares the badge parser', () => {
  assert.deepEqual(parsePageTotal('Showing 2 changed files +15 -7'), { added: 15, deleted: 7 });
  assert.equal(parsePageTotal('nothing to parse here'), null);
});

test('formatNoDiffTotal renders the recalculated remainder, clamped and gated', () => {
  assert.equal(
    formatNoDiffTotal({ pageAdded: 10, pageDeleted: 5, hiddenAdded: 4, hiddenDeleted: 2 }),
    '· zonder -diff: 6+ 3-'
  );
  assert.equal(
    formatNoDiffTotal({ pageAdded: 2, pageDeleted: 1, hiddenAdded: 5, hiddenDeleted: 9 }),
    '· zonder -diff: 0+ 0-'
  );
  assert.equal(formatNoDiffTotal({ pageAdded: 10, pageDeleted: 5, hiddenAdded: 0, hiddenDeleted: 0 }), null);
  assert.equal(formatNoDiffTotal({ pageAdded: null, pageDeleted: 5, hiddenAdded: 4, hiddenDeleted: 2 }), null);
  assert.equal(formatNoDiffTotal({}), null);
  assert.equal(formatNoDiffTotal(), null);
});

test('shouldShowFullFileButtons gates on enabled and being on a diff page', () => {
  assert.equal(shouldShowFullFileButtons({ enabled: true, isDiffPage: true }), true);
  assert.equal(shouldShowFullFileButtons({ enabled: false, isDiffPage: true }), false);
  assert.equal(shouldShowFullFileButtons({ enabled: true, isDiffPage: false }), false);
});

test('classifyFolders marks a folder generated only when every contained file is hidden', () => {
  const [mixed, generated] = classifyFolders({
    folders: [{ folderPath: 'svc/mixed', expanded: true }, { folderPath: 'svc/generated', expanded: true }],
    allFilePaths: ['svc/mixed/a.go', 'svc/mixed/b.go', 'svc/generated/c.go'],
    hiddenFilePaths: new Set(['svc/mixed/b.go', 'svc/generated/c.go']),
    autoCollapsedFolderPaths: new Set(),
  });
  assert.equal(mixed.onlyContainsHidden, false, 'a folder with any visible file is not marked generated');
  assert.equal(generated.onlyContainsHidden, true);
});

test('classifyFolders only marks auto-collapse the first time a folder becomes hidden-only, and requires it be expanded to collapse', () => {
  const alreadyCollapsed = classifyFolders({
    folders: [{ folderPath: 'svc/generated', expanded: true }],
    allFilePaths: ['svc/generated/c.go'],
    hiddenFilePaths: new Set(['svc/generated/c.go']),
    autoCollapsedFolderPaths: new Set(['svc/generated']),
  })[0];
  assert.equal(alreadyCollapsed.onlyContainsHidden, true);
  assert.equal(alreadyCollapsed.markAutoCollapsed, false, 'already recorded, so no re-mark');
  assert.equal(alreadyCollapsed.shouldCollapse, false);

  const collapsedButNotExpanded = classifyFolders({
    folders: [{ folderPath: 'svc/generated', expanded: false }],
    allFilePaths: ['svc/generated/c.go'],
    hiddenFilePaths: new Set(['svc/generated/c.go']),
    autoCollapsedFolderPaths: new Set(),
  })[0];
  assert.equal(collapsedButNotExpanded.markAutoCollapsed, true, 'still recorded as auto-collapsed');
  assert.equal(collapsedButNotExpanded.shouldCollapse, false, 'not expanded, so nothing to collapse');
});

test('classifyFolders is total: never throws on empty/missing inputs', () => {
  assert.doesNotThrow(() => classifyFolders({}));
  assert.deepEqual(classifyFolders({}), []);
});

test('findRapidFullFileItem finds a top-level showFullFile item', () => {
  const item = { text: 'Show full file', extraAttrs: { 'data-click': 'showFullFile' } };
  assert.equal(findRapidFullFileItem([{ text: 'Other' }, item]), item);
});

test('findRapidFullFileItem finds a nested showFullFile item', () => {
  const item = { text: 'Show full file', extraAttrs: { 'data-click': 'showFullFile' } };
  assert.equal(findRapidFullFileItem([{ text: 'Group', items: [{ text: 'Other' }, item] }]), item);
});

test('findRapidFullFileItem returns null when nothing matches', () => {
  assert.equal(findRapidFullFileItem([{ text: 'Other' }]), null);
  assert.equal(findRapidFullFileItem(undefined), null);
  assert.equal(findRapidFullFileItem([]), null);
});

test('viewerIsText is true only for text_* viewers', () => {
  assert.equal(viewerIsText({ viewer: 'text_inline' }), true);
  assert.equal(viewerIsText({ viewer: 'image' }), false);
  assert.equal(viewerIsText({}), false);
  assert.equal(viewerIsText(undefined), false);
});

test('fullFileButtonMode reads data-full off the native item', () => {
  assert.equal(fullFileButtonMode({ extraAttrs: { 'data-full': 'true' } }), 'changes');
  assert.equal(fullFileButtonMode({ extraAttrs: {} }), 'full');
  assert.equal(fullFileButtonMode(null), 'full');
});

test('matchesFullFileActionLabel matches both legacy dropdown labels, case-insensitively', () => {
  assert.equal(matchesFullFileActionLabel('Show full file'), true);
  assert.equal(matchesFullFileActionLabel('show CHANGES only'), true);
  assert.equal(matchesFullFileActionLabel('  Show full file  '), true);
  assert.equal(matchesFullFileActionLabel('Delete file'), false);
});

test('isShowingFullFileLabel is true only for the "show full file" label', () => {
  assert.equal(isShowingFullFileLabel('Show full file'), true);
  assert.equal(isShowingFullFileLabel('Show changes only'), false);
});

test('fullFileButtonView derives label/state/disabled from mode and busy', () => {
  assert.deepEqual(fullFileButtonView({ mode: 'full' }), {
    mode: 'full', state: 'idle', disabled: false, ariaBusy: false,
    title: 'Show full file', ariaLabel: 'Show full file',
  });
  assert.deepEqual(fullFileButtonView({ mode: 'changes' }), {
    mode: 'changes', state: 'idle', disabled: false, ariaBusy: false,
    title: 'Show changes only', ariaLabel: 'Show changes only',
  });
  assert.deepEqual(fullFileButtonView({ mode: 'complete' }), {
    mode: 'complete', state: 'complete', disabled: true, ariaBusy: false,
    title: 'Full file shown', ariaLabel: 'Full file shown',
  });
  assert.deepEqual(fullFileButtonView({ mode: 'full', busy: true }), {
    mode: 'full', state: 'busy', disabled: true, ariaBusy: true,
    title: 'Expanding full file…', ariaLabel: 'Expanding full file',
  });
  assert.deepEqual(fullFileButtonView({ mode: 'full', label: 'Could not expand full file' }), {
    mode: 'full', state: 'idle', disabled: false, ariaBusy: false,
    title: 'Could not expand full file', ariaLabel: 'Could not expand full file',
  });
});
