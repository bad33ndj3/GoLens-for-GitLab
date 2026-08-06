// page/main.js — first entry point of the real ES-module page skeleton.
// Loaded via `import(chrome.runtime.getURL('page/main.js'))` from the thin
// bootstrap content script.
//
// Follows the uniform page-module contract:
//   export function mount(ctx) -> handle
// where `handle.unmount()` is total and mount-after-unmount is safe (SPA
// navigation re-mounts this module on every page transition).
//
// `go-navigation.js` and `content.js` are deleted. Every feature below now
// gets a REAL, fully capable `legacy` bag/capability set built from this
// file's own imports and `page/lifecycle/mr-session.js` — there is no more
// "second, inert instance" distinction; each feature mounted here is the only
// instance. Cross-feature needs are wired below via late-bound accessor
// closures onto each handle variable, never a captured value and never
// `globalThis`.
import { createStore as createBookmarkStore, hashText as hashBookmarkText } from '../bookmark-store.js';
import { createClock } from './platform/clock.js';
import { createSettingsStore } from './platform/settings-store.js';
import { createOverlayRegistry } from './platform/overlay-registry.js';
import * as diffDom from './platform/diff-dom.js';
import * as gitlabApiPure from './platform/gitlab-api.js';
import { projectLoadingProgress } from './platform/source-loader.js';
import { start as startLifecycle } from './lifecycle/index.js';
import { createMrSession } from './lifecycle/mr-session.js';
import { mount as mountGeneratedFiles } from './features/generated-files.js';
import { mount as mountSettingsOverlay } from './features/settings-overlay.js';
import { mount as mountOnboarding } from './features/onboarding.js';
import { mount as mountKeyboardNav, offerShortcutCoach } from './features/keyboard-nav.js';
import { mount as mountMrPreload } from './features/mr-preload.js';
import { mount as mountCelebration, requestMoment } from './features/celebration.js';
import { mount as mountProjectSearch } from './features/project-search.js';
import { mount as mountBookmarks } from './features/bookmarks.js';
import { mount as mountCodeIntel } from './features/code-intel.js';
import { mount as mountDiscussionLineLink } from './features/discussion-line-link.js';
import { mount as mountGoTestFileRows } from './features/go-test-file-rows.js';
import { mount as mountControls } from './features/controls.js';

export function mount(ctx = {}) {
  const clock = ctx.clock || createClock();
  const settings = ctx.settings || createSettingsStore();
  const overlays = ctx.overlays || createOverlayRegistry();
  const root = document.documentElement;

  // Test/observability hook only — no user-visible behavior. Proves the
  // module graph loaded and mounted (and, via the mount count set by the
  // bootstrap script, that it re-mounts after SPA navigation).
  root.dataset.golensPageSkeletonMounted = 'true';
  root.dataset.golensPageSkeletonMountedAt = String(clock.now());

  // Late-bound handle variables (batch 1's platform-services decision:
  // accessors, never captured values). Each is assigned by the wrapping
  // `mount` below, in the array order features actually mount in — but every
  // reader here is a closure invoked later (a click, a keydown, a message),
  // long after every feature in the list below has finished mounting, so
  // mount order relative to a *reader's* position in the list never matters.
  let bookmarksHandle = null;
  let codeIntelHandle = null;
  let projectSearchHandle = null;
  let mrPreloadHandle = null;
  let controlsHandle = null;

  const session = createMrSession({
    clock: ctx.mrSessionClock,
    getSettings: () => settings,
    getControlsHandle: () => controlsHandle,
    getBookmarksHandle: () => bookmarksHandle,
    getCodeIntelHandle: () => codeIntelHandle,
  });

  function trackHandle(setter, mountFn) {
    return (featureCtx) => {
      const handle = mountFn(featureCtx);
      setter(handle);
      return handle;
    };
  }

  const lifecycle = startLifecycle({
    platform: { clock, settings, overlays },
    features: [
      { name: 'generated-files', mount: mountGeneratedFiles },
      { name: 'settings-overlay', mount: mountSettingsOverlay },
      { name: 'onboarding', mount: mountOnboarding },
      {
        name: 'keyboard-nav',
        mount: mountKeyboardNav,
        // Capabilities: keyboard-nav.js can't reach the other features' state
        // any other way without a feature -> feature edge.
        capabilities: {
          // Code-intel.js's own five navigation actions
          // (semanticJump/previousOccurrence/nextOccurrence/historyBack/
          // historyForward).
          navigationAction: (action) => codeIntelHandle?.navigationAction?.(action) === true,
          // The three bookmark actions (toggleBookmark/previousBookmark/
          // nextBookmark) — go-navigation.js's former runNavigationAction() is
          // gone; this closure reproduces its exact body (the selected-
          // occurrence fallback chain, then bookmarksHandle.toggleAtSelection/
          // navigate) directly against the real handles instead of a
          // globalThis bridge (a feature -> feature edge is removed here, not
          // relocated).
          runLegacyNavigationAction: (action) => {
            // go-navigation.js's former runNavigationAction() gated its whole
            // body on `state.enabled` — the MR-activation latch (distinct from
            // the settings `enabled` flag keyboard-nav.js already gates on).
            // Preserved verbatim: gate on session activation, not the settings
            // flag, or these three actions would fire on an inactive session.
            if (!session.isActive()) return false;
            if (action === 'toggleBookmark') {
              const selectedTarget = codeIntelHandle?.selectedOccurrenceSourceLocation?.() ?? null;
              const fallback = selectedTarget
                ? { path: selectedTarget.path, side: selectedTarget.side, startLine: selectedTarget.line, endLine: selectedTarget.line }
                : null;
              bookmarksHandle?.toggleAtSelection(fallback);
              return true;
            }
            if (action === 'previousBookmark') { void bookmarksHandle?.navigate(-1); return true; }
            if (action === 'nextBookmark') { void bookmarksHandle?.navigate(1); return true; }
            return false;
          },
          legacyToast: {
            message: (text) => session.toast.toast(text),
            shortcutHint: (hint) => session.toast.showShortcutCoachHint(hint),
            isShowing: () => session.toast.isToastShowing(),
          },
          // Document-level Escape routing to the popover — see this file's
          // own onEscapeKeyDown wiring below in keyboard-nav.js for why it
          // lives there rather than a new lifecycle-level keydown listener.
          handleCodeIntelEscape: (event) => codeIntelHandle?.handleEscape?.(event),
          // GitHub issue #5's diff-view toggle: controls.js owns the DOM
          // interaction with GitLab's own preferences dropdown; this
          // closure reaches its handle the same way runLegacyNavigationAction
          // above reaches bookmarksHandle — a feature -> feature edge would
          // be forbidden without it.
          toggleDiffView: () => controlsHandle?.toggleDiffView?.() === true,
        },
      },
      {
        name: 'mr-preload',
        mount: trackHandle((handle) => { mrPreloadHandle = handle; }, mountMrPreload),
        capabilities: {
          legacy: {
            projectContext: gitlabApiPure.projectContext,
            mergeRequestHeadRef: (...args) => session.gitlabApi.mergeRequestHeadRef(...args),
            mergeRequestIID: gitlabApiPure.mergeRequestIID,
            workerRPC: session.workerRPC,
            loadPackage: (...args) => session.sourceLoader.loadPackage(...args),
            loadProject: (...args) => session.sourceLoader.loadProject(...args),
            listMergeRequestChangedFiles: (...args) => session.gitlabApi.listMergeRequestChangedFiles(...args),
            modulePathFor: (...args) => session.gitlabApi.modulePathFor(...args),
            searchProjectBlobPaths: (...args) => session.gitlabApi.searchProjectBlobPaths(...args),
            projectLoadingProgress,
            // Both used to reach into `state.packages`/`state.projects`/
            // `state.projectProgressListeners` directly. The source-loader
            // instance owns those caches, and with them the "never drop a
            // project load that still has subscribers" rule.
            forgetStaleProjectCache(scope) {
              session.sourceLoader.forgetStaleProject(scope);
            },
            resetCaches() {
              session.sourceLoader.reset();
            },
          },
        },
      },
      { name: 'celebration', mount: mountCelebration },
      {
        name: 'project-search',
        mount: trackHandle((handle) => { projectSearchHandle = handle; }, mountProjectSearch),
        capabilities: {
          legacy: {
            searchProjectBlobPaths: (...args) => session.gitlabApi.searchProjectBlobPaths(...args),
            loadPackage: (...args) => session.sourceLoader.loadPackage(...args),
            findReferencesAt: (target, definition, cursor = '', scopeOverride = null) =>
              codeIntelHandle ? codeIntelHandle.findReferences(target, definition, cursor, scopeOverride) : Promise.resolve({ status: 'notFound' }),
            findImplementationsAt: (target, definition, progress = () => {}, cursor = '', scopeOverride = null) =>
              codeIntelHandle ? codeIntelHandle.findImplementations(target, definition, progress, cursor, scopeOverride) : Promise.resolve({ status: 'notFound' }),
            showResult: (result, pointer) => (codeIntelHandle ? codeIntelHandle.showResult(result, pointer) : false),
            pinPopover: (target = null) => codeIntelHandle?.pinPopover(target),
            showSearchProgress: (message, pointer) => codeIntelHandle?.showSearchProgress?.(message, pointer),
            toast: (message) => session.toast.toast(message),
            isEnabled: () => session.isActive(),
          },
        },
      },
      {
        name: 'bookmarks',
        mount: trackHandle((handle) => { bookmarksHandle = handle; }, mountBookmarks),
        capabilities: {
          bookmarkStore: createBookmarkStore(),
          hashText: hashBookmarkText,
          legacy: {
            projectContext: gitlabApiPure.projectContext,
            mergeRequestIID: gitlabApiPure.mergeRequestIID,
            mergeRequestRefs: (...args) => session.gitlabApi.mergeRequestRefs(...args),
            clearMergeRequestRefs: (...args) => session.gitlabApi.clearMergeRequestRefs(...args),
            diffFileRoots: diffDom.diffFileRoots,
            diffRootFor: diffDom.diffRootFor,
            rapidFileData: diffDom.rapidFileData,
            parseBlobLink: gitlabApiPure.parseBlobLink,
            codeCellFor: diffDom.codeCellFor,
            lineContextFor: diffDom.lineContextFor,
            fetchSource: (...args) => session.gitlabApi.fetchSource(...args),
            navigateToLocation: (...args) => diffDom.navigateToLocation(...args),
            waitForDiffUpdate: (...args) => diffDom.waitForDiffUpdate(...args),
            lineAnchorFor: (...args) => diffDom.lineAnchorFor(...args),
            toast: (message) => session.toast.toast(message),
            isEnabled: () => session.isActive(),
            // The hovered target's source location is code-intel.js's own
            // state — forwards to its selectedSymbolLocation() handle method
            // instead of reading it directly.
            selectedSymbolLocation: () => codeIntelHandle?.selectedSymbolLocation?.() ?? null,
          },
        },
      },
      {
        name: 'code-intel',
        mount: trackHandle((handle) => { codeIntelHandle = handle; }, mountCodeIntel),
        capabilities: {
          legacy: {
            fileContextFor: diffDom.fileContextFor,
            lineContextFor: diffDom.lineContextFor,
            codeCellFor: diffDom.codeCellFor,
            diffFileRoots: diffDom.diffFileRoots,
            projectContext: gitlabApiPure.projectContext,
            documentationURL: gitlabApiPure.documentationURL,
            projectPackageURL: gitlabApiPure.projectPackageURL,
            visibleDiffRootForDefinition: (...args) => diffDom.visibleDiffRootForDefinition(...args),
            navigateToLocation: (...args) => diffDom.navigateToLocation(...args),
            loadPackage: (...args) => session.sourceLoader.loadPackage(...args),
            preloadMergeRequest: (progress = () => {}) => mrPreloadHandle.preloadMergeRequest({ progress }),
            mergeRequestRefsForFile: (...args) => session.gitlabApi.mergeRequestRefsForFile(...args),
            mergeRequestIID: gitlabApiPure.mergeRequestIID,
            sourceRefFor: gitlabApiPure.sourceRefFor,
            dirname: gitlabApiPure.dirname,
            workerRPC: session.workerRPC,
            toast: (message) => session.toast.toast(message),
            offerShortcutCoach: (actionID) => offerShortcutCoach(actionID),
            requestFrame: (fn) => session.requestFrame(fn),
            searchCompleteProject: (result, pointer) => projectSearchHandle?.open?.(result, pointer),
            cancelSearch: () => projectSearchHandle?.cancel?.(),
          },
        },
      },
      { name: 'discussion-line-link', mount: mountDiscussionLineLink },
      { name: 'go-test-file-rows', mount: mountGoTestFileRows },
      {
        name: 'controls',
        mount: trackHandle((handle) => { controlsHandle = handle; }, mountControls),
        capabilities: {
          legacy: {
            preloadMergeRequest: (progress = () => {}) => mrPreloadHandle.preloadMergeRequest({ progress }),
            mergeRequestPreloadStatus: () => mrPreloadHandle.preloadStatus(),
            preloadFullProject: (progress = () => {}, requestedRef = '') => mrPreloadHandle.preloadFullProject({ progress, ref: requestedRef }),
            fullProjectPreloadStatus: () => mrPreloadHandle.fullProjectStatus(),
            invalidateCacheState: () => mrPreloadHandle.invalidateCache(),
            init: session.activate,
            teardown: session.deactivate,
            bookmarks: () => bookmarksHandle,
            enableRapidDiffs: () => undefined, // rapid-diffs stays controls.js's own, see its header
            watchForRapidDiffs: () => undefined,
            triggerPitstopMoment: () => requestMoment('pitstop'),
            schedulePageReconcile: () => session.schedulePageReconcile(),
            toast: (message) => session.toast.toast(message),
          },
        },
      },
    ],
    // Opt out of lifecycle's own chrome.runtime.onMessage registration:
    // bootstrap.js registers synchronously, before this module graph even
    // finishes importing, and feeds messages in through `dispatch` below.
    // Registering here as well would dispatch every message twice.
    runtime: null,
  });

  session.start();

  let unmounted = false;
  return {
    dispatch: lifecycle.dispatch,
    unmount() {
      if (unmounted) return;
      unmounted = true;
      session.stop();
      lifecycle.stop();
      delete root.dataset.golensPageSkeletonMounted;
      delete root.dataset.golensPageSkeletonMountedAt;
    },
  };
}
