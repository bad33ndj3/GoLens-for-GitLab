import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  normalizeRepositoryPath,
  folderContainsPath,
  hasCollapseGeneratedFilesLink,
  isGeneratedWarning,
  shouldHideGeneratedFiles,
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
