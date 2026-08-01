import { repositoryPath, type SourceIdentity } from './domain.ts';
import { featuresFor } from './feature-catalog.ts';
import { createGitLabHost, showExtensionSettings, showFeatureGuide, showFirstRunSetup, showStorageResetProgress, showUpgradeNotice, type BoundGitLabHost, type GitLabHost, type HostReadValue, type ReviewDescriptor, type ShortcutProjection } from './gitlab-host/index.ts';
import { openGoIntelligence, type Coverage, type CoverageRequest, type GoIntelligence, type SourceContent, type SourceReader } from './go-intelligence/index.ts';
import { startReviewSession, type ReviewSessionHandle, type ReviewSessionPreferences } from './review-session/index.ts';
import { ACTIONS, mergeBindings, presetBindings, presetForBindings, type ShortcutPlatform } from './shortcuts.ts';
import { createUserStorage } from './user-storage.ts';
import { acknowledgeUpgradeNotice as acknowledgeStoredUpgrade, ensureStorageReady, type StorageResetState } from './storage-reset.ts';

const COMMANDS = {
  focusFileSearch: 'focus-file-search', clearFileSearch: 'clear-file-search', semanticJump: 'semantic-jump',
  previousOccurrence: 'previous-occurrence', nextOccurrence: 'next-occurrence', previousHunk: 'previous-hunk', nextHunk: 'next-hunk',
  previousFile: 'previous-file', nextFile: 'next-file', historyBack: 'history-back', historyForward: 'history-forward',
  toggleBookmark: 'toggle-bookmark', previousBookmark: 'previous-bookmark', nextBookmark: 'next-bookmark',
} as const;
const REWRITE_ONBOARDING_VERSION = 13;

type StoredPreferences = Readonly<{ enabled: boolean; hideGeneratedFiles: boolean; shortcutBindings: Readonly<Record<string, string>> }>;

function shortcutProjection(command: ShortcutProjection['command'], binding: string, platform: ShortcutPlatform): ShortcutProjection | null {
  if (!binding) return null;
  const parts = binding.split('+');
  const key = parts.pop();
  if (!key) return null;
  const modifiers = new Set(parts);
  return Object.freeze({ command, key, ...(modifiers.has('Primary') ? platform === 'mac' ? { metaKey: true } : { ctrlKey: true } : {}),
    ...(modifiers.has('Ctrl') ? { ctrlKey: true } : {}), ...(modifiers.has('Alt') ? { altKey: true } : {}),
    ...(modifiers.has('Shift') ? { shiftKey: true } : {}), ...(modifiers.has('Meta') ? { metaKey: true } : {}) });
}

export function reviewPreferences(preferences: StoredPreferences, platform: ShortcutPlatform): ReviewSessionPreferences {
  const bindings = mergeBindings(preferences.shortcutBindings);
  return Object.freeze({
    enabled: preferences.enabled,
    hideGeneratedFiles: preferences.hideGeneratedFiles,
    shortcuts: ACTIONS.map(({ id }) => shortcutProjection(COMMANDS[id], bindings[id], platform)).filter((value): value is ShortcutProjection => Boolean(value)),
  });
}

function okValue(outcome: Awaited<ReturnType<BoundGitLabHost['read']>>): HostReadValue {
  if (outcome.kind !== 'ok') throw new Error('GitLab source is unavailable.');
  return outcome.value;
}

function packagePaths(files: readonly SourceContent[]): readonly string[] {
  return [...new Set(files.map(({ path }) => String(path).split('/').slice(0, -1).join('/')))];
}

function coverageFor(request: CoverageRequest, files: readonly SourceContent[]): Coverage {
  const paths = packagePaths(files);
  const base = { complete: true, packageCount: paths.length, packagePaths: paths };
  if (request.goal === 'current-package') return Object.freeze({ ...base, scope: 'current-package' });
  if (request.goal === 'full-project') return Object.freeze({ ...base, scope: 'full-project' });
  if (request.goal === 'complete-query') return Object.freeze({ ...base, scope: 'complete-project-search', queryFingerprint: JSON.stringify(request.query || null), searchStrategy: 'project-go-files' });
  return Object.freeze({ ...base, scope: 'indexed-packages' });
}

export function createHostSourceReader(host: Pick<BoundGitLabHost, 'read'>, source: SourceIdentity): SourceReader {
  return Object.freeze({
    async discover(request: CoverageRequest, signal: AbortSignal) {
      const scope = request.goal === 'current-package' && request.packagePath !== undefined
        ? { kind: 'package' as const, path: repositoryPath(request.packagePath) }
        : request.goal === 'related-review' ? { kind: 'changed-review' as const } : { kind: 'project' as const };
      const value = okValue(await host.read({ operation: 'go-files', source, scope }, signal));
      if (!('files' in value)) throw new TypeError('Go files read returned the wrong value.');
      const files = value.files.map(({ path, contentId }) => Object.freeze({ path, contentId }));
      let modulePath = '';
      const moduleOutcome = await host.read({ operation: 'source-file', source, path: repositoryPath('go.mod') }, signal);
      if (moduleOutcome.kind === 'limit-exceeded') throw new Error('GitLab source safety limit exceeded.');
      if (moduleOutcome.kind === 'unavailable' && moduleOutcome.reason !== 'not-found') throw new Error(`GitLab root module is unavailable: ${moduleOutcome.reason}.`);
      if (moduleOutcome.kind === 'ok') {
        if (!('text' in moduleOutcome.value)) throw new TypeError('Source file read returned the wrong value.');
        modulePath = moduleOutcome.value.text.match(/^\s*module\s+(\S+)/m)?.[1] || '';
      }
      return Object.freeze({ modulePath, coverage: coverageFor(request, files), files: Object.freeze(files) });
    },
    async read(file: SourceContent, signal: AbortSignal) {
      const value = okValue(await host.read({ operation: 'source-file', source, path: file.path }, signal));
      if (!('text' in value) || value.contentId !== file.contentId) throw new Error('GitLab source changed during the commit-pinned read.');
      return value.text;
    },
  });
}

export async function runReviewSessionComposition({ host, start, signal }: {
  host: GitLabHost;
  start(bound: BoundGitLabHost, signal: AbortSignal): ReviewSessionHandle;
  signal: AbortSignal;
}): Promise<void> {
  let active: Readonly<{ handle: ReviewSessionHandle; controller: AbortController }> | null = null;
  let identity: ReviewDescriptor['identity'] | null = null;
  const stopActive = async () => {
    const current = active;
    active = null;
    current?.controller.abort();
    await current?.handle.stop();
  };
  try {
    for await (const review of host.observeReviews(signal)) {
      if (signal.aborted) break;
      const nextIdentity = review?.identity || null;
      if ((!nextIdentity && !identity) || (nextIdentity && identity
        && nextIdentity.origin === identity.origin && nextIdentity.repositoryKey === identity.repositoryKey
        && nextIdentity.projectPath === identity.projectPath && nextIdentity.mergeRequestIid === identity.mergeRequestIid
        && nextIdentity.headSha === identity.headSha)) continue;
      await stopActive();
      identity = nextIdentity;
      if (review) {
        const controller = new AbortController();
        signal.addEventListener('abort', () => controller.abort(), { once: true });
        active = { controller, handle: start(host.connect(review, controller.signal), controller.signal) };
      }
    }
  } finally {
    await stopActive();
  }
}

export async function startContentEntry({
  window: pageWindow = globalThis.window,
  runtime = chrome.runtime,
  storage = createUserStorage({ normalizeShortcutBindings: mergeBindings }),
  host = createGitLabHost({ origin: pageWindow.location.origin, window: pageWindow }),
  openIntelligence = openGoIntelligence,
  startSession = startReviewSession,
  openSettings = () => showExtensionSettings(pageWindow, runtime.getURL('settings.html')),
  showGuide = () => showFeatureGuide(pageWindow.document, featuresFor('guide')),
  showSetup = (signal: AbortSignal, hideGeneratedFiles: boolean, preset: string) => showFirstRunSetup(pageWindow.document, featuresFor('setup'), hideGeneratedFiles, preset, signal),
  showUpgrade = (signal: AbortSignal) => showUpgradeNotice(pageWindow.document, signal),
  ensureStorage = () => ensureStorageReady(runtime),
  acknowledgeUpgradeNotice = () => acknowledgeStoredUpgrade(runtime),
  showUpdate = () => showStorageResetProgress(pageWindow.document),
}: {
  window?: Window;
  runtime?: typeof chrome.runtime;
  storage?: ReturnType<typeof createUserStorage>;
  host?: GitLabHost;
  openIntelligence?: typeof openGoIntelligence;
  startSession?: typeof startReviewSession;
  openSettings?: () => unknown;
  showGuide?: () => unknown;
  showSetup?: (signal: AbortSignal, hideGeneratedFiles: boolean, preset: string) => Promise<Readonly<{ preset: string; hideGeneratedFiles: boolean }> | null>;
  showUpgrade?: (signal: AbortSignal) => Promise<boolean>;
  ensureStorage?: () => Promise<StorageResetState>;
  acknowledgeUpgradeNotice?: () => Promise<void>;
  showUpdate?: () => () => void;
} = {}): Promise<ReviewSessionHandle> {
  const closeUpdate = showUpdate();
  const resetState = await ensureStorage().finally(closeUpdate);
  const controller = new AbortController();
  const platform: ShortcutPlatform = /Mac/.test(pageWindow.navigator.platform) ? 'mac' : 'other';
  let active: { intelligence: GoIntelligence; signal: AbortSignal; progress?: unknown; fullProject: boolean } | null = null;
  let closeSettings: (() => void) | null = null;
  let preferences = await storage.preferences.get();
  let onboardingVersion = await storage.onboarding.get();
  let setupRunning = false;
  let upgradeNoticePending = resetState.upgradeNoticePending;
  let upgradeDismissed = false;
  const preferenceListeners = new Set<(value: ReviewSessionPreferences) => void>();
  const unsubscribePreferences = storage.preferences.subscribe((next) => {
    preferences = next;
    const projected = reviewPreferences(next, platform);
    for (const listener of preferenceListeners) listener(projected);
  });
  const startSetup = (signal: AbortSignal) => {
    if (setupRunning || upgradeDismissed || (!upgradeNoticePending && onboardingVersion >= REWRITE_ONBOARDING_VERSION)) return;
    setupRunning = true;
    void (async () => {
      try {
        if (upgradeNoticePending) {
          const continued = await showUpgrade(signal);
          if (signal.aborted) return;
          if (!continued) { upgradeDismissed = true; return; }
          try { await acknowledgeUpgradeNotice(); } catch (error) { upgradeDismissed = true; throw error; }
          upgradeNoticePending = false;
        }
        if (onboardingVersion >= REWRITE_ONBOARDING_VERSION) return;
        const choice = await showSetup(signal, preferences.hideGeneratedFiles, presetForBindings(preferences.shortcutBindings) || 'custom');
        if (signal.aborted) return;
        if (choice) {
          const shortcutBindings = presetBindings(choice.preset);
          const update = { hideGeneratedFiles: choice.hideGeneratedFiles, ...(shortcutBindings ? { shortcutBindings } : {}) };
          await storage.preferences.set(update);
          preferences = { ...preferences, ...update };
        }
        await storage.onboarding.set(REWRITE_ONBOARDING_VERSION);
        onboardingVersion = REWRITE_ONBOARDING_VERSION;
      } finally {
        setupRunning = false;
        if ((upgradeNoticePending || onboardingVersion < REWRITE_ONBOARDING_VERSION) && active && !active.signal.aborted) startSetup(active.signal);
      }
    })().catch(() => {});
  };
  const running = runReviewSessionComposition({ host, signal: controller.signal, start(bound, signal) {
    const source = { repositoryKey: bound.review.identity.repositoryKey, commitSha: bound.review.identity.headSha };
    const intelligence = openIntelligence({ source, reader: createHostSourceReader(bound, source), runtime: runtime as never });
    active = { intelligence, signal, fullProject: false };
    const handle = startSession({ host: bound, intelligence, preferences: reviewPreferences(preferences, platform), bookmarks: storage.bookmarks,
      coachStorage: {
        get: storage.learning.get,
        set: storage.learning.set,
        async settings(action) { const current = await storage.preferences.get(); return { enabled: current.shortcutCoachEnabled, binding: mergeBindings(current.shortcutBindings)[action] }; },
        setEnabled: (enabled) => storage.preferences.set({ shortcutCoachEnabled: enabled }),
      },
      preferencePort: {
        subscribe(listener) { preferenceListeners.add(listener); return () => preferenceListeners.delete(listener); },
        set: storage.preferences.set,
      }, signal });
    startSetup(signal);
    return { async stop() { await handle.stop(); if (active?.intelligence === intelligence) active = null; } };
  } });
  const listener = (message: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
    if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string' || !message.type.startsWith('golens:rewrite:')) return false;
    const respond = async () => {
      if (message.type === 'golens:rewrite:ping') return 'golens:rewrite:pong';
      if (message.type === 'golens:rewrite:open-settings') { const close = openSettings(); closeSettings = typeof close === 'function' ? close as () => void : null; return {}; }
      if (message.type === 'golens:rewrite:show-guide') { closeSettings?.(); closeSettings = null; showGuide(); return {}; }
      const current = active;
      if (!current) throw new Error('Open a supported GitLab merge request.');
      if (message.type === 'golens:rewrite:state') return { active: true, cache: await current.intelligence.inspectCache({ scope: 'source' }, current.signal), fullProject: current.fullProject, progress: current.progress };
      if (message.type === 'golens:rewrite:cache-full-project') {
        const outcome = await current.intelligence.ensureCoverage({ goal: 'full-project' }, (progress) => { if (active === current) current.progress = progress; }, current.signal);
        if (active !== current || current.signal.aborted) throw new DOMException('Review Session replaced.', 'AbortError');
        current.fullProject = outcome.status === 'ready';
        return { outcome, cache: await current.intelligence.inspectCache({ scope: 'source' }, current.signal) };
      }
      if (message.type === 'golens:rewrite:clear-cache') { current.fullProject = false; return { cache: await current.intelligence.clearCache({ scope: 'global' }, current.signal) }; }
      throw new Error('Unknown GoLens entry intention.');
    };
    void respond().then((result) => sendResponse({ ok: true, result }), (error: unknown) => sendResponse({ ok: false, error: error instanceof Error ? error.message : 'GoLens request failed.' }));
    return true;
  };
  runtime.onMessage.addListener(listener);
  return Object.freeze({ async stop() { controller.abort(); closeSettings?.(); unsubscribePreferences(); runtime.onMessage.removeListener(listener); await running; } });
}

if (typeof chrome !== 'undefined' && typeof window !== 'undefined') void startContentEntry().catch((error) => console.error('GoLens failed to start.', error));
