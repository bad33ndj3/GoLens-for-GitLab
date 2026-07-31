export type FeatureAudience = 'setup' | 'guide';
export type FeatureChapter = 'Page controls' | 'Go Intelligence' | 'Diff helpers' | 'Settings';
export type FeatureDefinition = Readonly<{
  id: string;
  chapter: FeatureChapter;
  title: string;
  summary: string;
  audiences: readonly FeatureAudience[];
  control?: 'enable' | 'focus' | 'related-cache' | 'bookmarks';
  shortcut?: string;
}>;

const entries = [
  ['enable', 'Page controls', 'Turn GoLens on or off', 'Control GoLens globally across open GitLab tabs.', ['setup', 'guide'], 'enable'],
  ['focus', 'Page controls', 'Enter fullscreen review focus', 'Hide GitLab chrome and widen the diff until focus mode ends.', ['setup', 'guide'], 'focus'],
  ['related-cache', 'Page controls', 'Cache related MR packages', 'Cache changed and related Go packages at the merge request head.', ['setup', 'guide'], 'related-cache'],
  ['bookmarks', 'Page controls', 'Keep local MR bookmarks', 'Revisit private line and range bookmarks for this merge request.', ['setup', 'guide'], 'bookmarks'],
  ['milestones', 'Page controls', 'Mark review milestones', 'Show reduced-motion-safe mascot moments for completed review milestones.', ['guide']],
  ['hover', 'Go Intelligence', 'Hover for Go insight', 'Show proven signature, documentation, location, usages, and full type bodies.', ['setup', 'guide']],
  ['semantic-navigation', 'Go Intelligence', 'Navigate by click or shortcut', 'Follow definitions, usages, and implementations without speculative results.', ['setup', 'guide'], undefined, 'semanticJump'],
  ['occurrences', 'Go Intelligence', 'Select and revisit occurrences', 'Select loaded-diff occurrences and move between them.', ['setup', 'guide'], undefined, 'nextOccurrence'],
  ['in-diff-navigation', 'Go Intelligence', 'Stay in the diff when possible', 'Prefer loaded destinations before opening source outside the diff.', ['guide']],
  ['semantic-history', 'Go Intelligence', 'Retrace semantic jumps', 'Move backward and forward through in-diff semantic history.', ['guide'], undefined, 'historyBack'],
  ['popover-tools', 'Go Intelligence', 'Use the small popover tools', 'Copy details or open proven semantic destinations from compact results.', ['guide']],
  ['coverage', 'Go Intelligence', 'Check the Coverage', 'See whether Coverage proves results across the diff, related packages, or full project.', ['guide']],
  ['full-search', 'Go Intelligence', 'Search the complete project explicitly', 'Expand Coverage only after an explicit full-project request.', ['guide']],
  ['test-doubles', 'Go Intelligence', 'Separate test doubles', 'Keep production and external test packages in distinct namespaces.', ['guide']],
  ['rapid-diffs', 'Diff helpers', 'Use Rapid Diffs automatically', 'Accept GitLab Rapid Diffs when it is offered on Changes.', ['guide']],
  ['full-file', 'Diff helpers', 'Show a full file', 'Expand hidden hunks in place within bounded safety limits.', ['guide']],
  ['file-search', 'Diff helpers', 'Reach file search from the keyboard', 'Focus or clear GitLab file search with configurable shortcuts.', ['guide'], undefined, 'focusFileSearch'],
  ['hunk-file-navigation', 'Diff helpers', 'Move by hunk or file', 'Navigate previous and next hunks or files from the keyboard.', ['guide'], undefined, 'nextHunk'],
  ['bookmark-ranges', 'Diff helpers', 'Bookmark lines and ranges', 'Mark old- or new-side lines and contiguous ranges.', ['guide'], undefined, 'toggleBookmark'],
  ['go-tests', 'Diff helpers', 'Spot Go test files', 'Mark _test.go files subtly in the file tree.', ['guide']],
  ['generated-files', 'Diff helpers', 'Optionally hide generated files', 'Hide only files GitLab marks as generated while retaining large files.', ['setup', 'guide']],
  ['discussion-links', 'Diff helpers', 'Jump from overview discussions to code', 'Open exact old- or new-side lines from overview discussions.', ['guide']],
  ['settings-overlay', 'Settings', 'Open the settings overlay', 'Manage GoLens without leaving the active review.', ['guide']],
  ['preferences', 'Settings', 'Set global review preferences', 'Synchronize enablement, generated files, and shortcut coaching.', ['guide']],
  ['keymaps', 'Settings', 'Choose a familiar keymap', 'Apply a preset and then edit any individual shortcut.', ['setup', 'guide']],
  ['self-hosted', 'Settings', 'Approve self-hosted GitLab origins', 'Grant only explicit HTTP or HTTPS GitLab origins.', ['guide']],
  ['full-project-cache', 'Settings', 'Cache the full project', 'Cache commit-pinned source for complete project coverage.', ['guide']],
  ['cache-admin', 'Settings', 'Inspect or clear the source cache', 'Review local cache size and clear it explicitly.', ['guide']],
  ['bookmark-privacy', 'Settings', 'Keep bookmarks private', 'Store only minimal locations and context fingerprints, never source excerpts.', ['guide']],
  ['feature-guide', 'Settings', 'Replay this complete tour', 'Open the complete four-chapter reference at any time.', ['guide']],
  ['source-privacy', 'Settings', 'Keep repository source local', 'Keep source in the signed-in browser and extension storage.', ['guide']],
] as const;

export const FEATURE_CATALOG: readonly FeatureDefinition[] = Object.freeze(entries.map(([id, chapter, title, summary, audiences, control, shortcut]) => Object.freeze({
  id, chapter, title, summary, audiences: Object.freeze([...audiences]), ...(control ? { control } : {}), ...(shortcut ? { shortcut } : {}),
})) as FeatureDefinition[]);

export function featuresFor(audience: FeatureAudience): readonly FeatureDefinition[] {
  return FEATURE_CATALOG.filter((feature) => feature.audiences.includes(audience));
}

export function guideChapters(): ReadonlyMap<FeatureChapter, readonly FeatureDefinition[]> {
  const chapters = new Map<FeatureChapter, FeatureDefinition[]>();
  for (const feature of featuresFor('guide')) chapters.set(feature.chapter, [...(chapters.get(feature.chapter) || []), feature]);
  return chapters;
}
