# Observable GoLens behaviour contract

This catalogue is the rewrite's parity floor. It records externally observable
outcomes and safety properties of the current extension, not its internal
module boundaries. The replacement may change implementation details, reset
stored data as allowed by the map, and improve explicitly approved semantics,
but every item below must either remain true or be called out as an intentional
product change before the rewrite merges.

Evidence was taken from the shipped manifest and runtime, the user-facing
feature guide, privacy and security policies, package and release scripts, CI
workflows, and the current automated tests. The evidence column names the
primary executable or policy source; tests are the preferred acceptance
evidence where they exist.

## 1. Activation and GitLab page lifecycle

| Contract | Primary evidence |
| --- | --- |
| GoLens is a Manifest V3 Chromium extension. GitLab.com receives static content scripts at `document_idle`; a self-hosted origin receives the same script and stylesheet set only after explicit origin approval and persistent dynamic registration. | `manifest.json`; `gitlab-host-access.js`; `tests/gitlab-host-access.test.js` |
| A content script confirms that the page is actually GitLab before changing it and activates page controls only on an individual merge request. | `content.js:isGitLab`, `isMergeRequest`; `tests/browser-smoke.mjs` |
| The four controls mount in a Shadow DOM immediately after GitLab's AI-panel button. If that anchor is late, GoLens waits; it never falls back to the document body. | `content.js:mountControlsInAiPanels`; `tests/browser-smoke.mjs` |
| The controls, top to bottom, toggle GoLens, toggle fullscreen review focus, cache MR-related packages, and open MR-local bookmarks. | `content.js:createControls`; `tests/content-bookmarks.test.js`; `tests/browser-smoke.mjs` |
| Global enablement applies immediately to open tabs. Disabling tears down Go navigation and GoLens projections without deleting cached source; re-enabling reconciles the current page and retained cache state. | `content.js:setEnabled`; `popup.js`; `settings.js`; `tests/popup.test.js`; `tests/browser-smoke.mjs` |
| GitLab Turbo/PJAX navigation and diff DOM replacement are reconciled idempotently. Leaving or replacing an MR cancels page activity, closes overlays, removes projections, and prevents stale async work from changing the new page. | `content.js:reconcilePage`, `leaveMergeRequestPage`; `go-navigation.js:init`, `teardown`; `tests/browser-smoke.mjs` |
| GoLens automatically accepts GitLab's Rapid Diffs opt-in when offered on an MR Changes page. | `content.js:enableRapidDiffs`; feature guide in `content.js` |

## 2. Review controls, overlays, and diff helpers

| Contract | Primary evidence |
| --- | --- |
| Review focus uses browser fullscreen, hides GitLab chrome, widens the diff, uses a 14px code size, and exits through the focus button, Escape/fullscreen exit, disablement, or page leave. Previous presentation is restored. | `content.js:toggleReviewFocus`; `gitlab-lens.css`; `tests/browser-smoke.mjs` |
| Related-package caching works at the MR head only, begins with an indeterminate state, switches to monotonic determinate package progress, reports completion, survives reload, and can finish while GoLens is disabled. | `content.js:preloadMergeRequest`; `go-navigation.js:preloadMergeRequest`; `tests/go-navigation-context.test.js`; `tests/browser-smoke.mjs` |
| Cache completion, the final resolved discussion, confirmed approval, and confirmed merge trigger mascot moments. Friday MR creation/approval/merge after 16:00 uses the beer-kart moment. Reduced-motion users receive a static treatment. | `content.js:showMascotMoment`, celebration polling; `tests/content-celebrations.test.js`; `tests/content-friday.test.js` |
| GoLens offers an idempotent “Show full file” control for Rapid and legacy diffs, expands hidden hunks in place, can return to changes-only where GitLab supports it, exposes busy/error state, and never navigates away. Expansion is bounded by a 500-control safety limit and a 15-second wait. | `content.js:reconcileFullFileButtons`; `tests/content-full-file.test.js`; `tests/browser-smoke.mjs` |
| `Cmd/Ctrl+P` focuses GitLab file search and `Shift+F` clears it and returns focus by default. Shortcuts do not consume keystrokes in editors, inputs, or other blocked interactive contexts. | `content.js:focusNativeFileSearch`, `isBlockedShortcutEvent`; `tests/content-shortcuts.test.js` |
| Configured shortcuts move to previous/next occurrence, hunk, file, bookmark, and semantic-history entry. Destinations are briefly highlighted and empty states are announced. | `shortcut-settings.js`; `go-navigation.js:runNavigationAction`; feature guide in `content.js` |
| `_test.go` entries receive a subtle file-tree marker. Optionally hidden generated files are recognized from GitLab's `.gitattributes` warning, while large collapsed files remain visible and generated-only folders are reconciled. | `content.js:reconcileGoTestFileRows`, `reconcileGeneratedDiffFiles`; `tests/content-onboarding.test.js` |
| Overview line discussions receive an exact “View in changes” link to the commented old/new-side line. The helper is removed when GoLens is inactive. | `content.js:reconcileOverviewDiscussionLineLinks`; `tests/content-discussion-links.test.js` |

## 3. Go inspection and navigation

| Contract | Primary evidence |
| --- | --- |
| Only identifiers in loaded Go diff code are interactive. Punctuation, adjacent caret snapping, comments/strings and other non-code tokens, and Go keywords do not resolve. Repeated rendered names keep stable source-role identity. | `go-navigation.js:identifierAtCharacter`; `tests/go-navigation-context.test.js`; `tests/go-semantic-core.test.js` |
| Hovering a resolvable symbol shows an IDE-style kind badge, compact signature, documentation, source location, and appropriate usages. Hovering a declaration shows usages rather than a redundant definition preview. | `go-navigation.js:showResult`; `tests/go-navigation-context.test.js` |
| A type reference can show its **full type body** for a multiline struct or interface. Bodies longer than 40 lines use progressive reveal rather than overwhelming the popover. | `go-semantic-core.js`; `go-navigation.js:renderSignature`; `tests/go-semantic-core.test.js` |
| Plain-click selects identifier-boundary occurrences in loaded Go diff code. It highlights them and supports ordered previous/next navigation without conflating same-spelling symbols in the semantic index. | `go-navigation.js:selectSymbol`; `tests/go-navigation-context.test.js`; `tests/go-semantic-core.test.js` |
| `Cmd/Ctrl`-click and the configurable semantic-jump shortcut (default `Cmd/Ctrl+F12`) resolve definitions, references/usages, or interface implementations. A sole target opens directly; multiple targets remain an explicit choice. | `go-navigation.js:onClick`, `navigateSemanticTarget`; `tests/go-navigation-context.test.js`; `tests/browser-smoke.mjs` |
| In-diff destinations scroll into view, expanding a collapsed hunk or file if necessary. Other project destinations open a commit-pinned GitLab URL; standard-library, third-party, and predeclared targets open versioned or anchored Go documentation as appropriate. | `go-navigation.js:navigateToLocation`, `openDefinition`; `tests/go-navigation-context.test.js` |
| Successful in-diff jumps enter a GoLens-local back/forward history independent of browser history. | `go-navigation.js:recordSemanticJump`, `navigateHistory`; feature guide in `content.js` |
| The popover distinguishes same-diff and new-tab destinations, can be pinned, stays open while the pointer enters it, copies `file:line:column`, exposes choices and signature expansion, and closes with its button or Escape. | `go-navigation.js:ensureUI`, `configureSourceCopy`; `tests/go-navigation-context.test.js`; `tests/browser-smoke.mjs` |
| Results state their proven coverage: current package, indexed packages, complete commit-pinned search, or full project. Incomplete coverage offers an explicit cancellable full-project search and cancellation preserves the incomplete result rather than implying absence. | `go-semantic-worker.js:resultScope`; `go-navigation.js:openFullSearch`; `tests/go-navigation-context.test.js`; `tests/browser-smoke.mjs` |
| Production interface implementations are listed before a separately expandable test-double group. | `go-navigation.js:implementationGroups`; `tests/go-navigation-context.test.js` |

## 4. Safe semantic outcomes and known limits

These are correctness contracts, not opportunities to “improve” by guessing.

| Contract | Primary evidence |
| --- | --- |
| Missing, ambiguous, unsupported, or insufficiently covered symbols return an explicit typed outcome and do not navigate speculatively. Absence is described only within the proven search scope. | `go-semantic-core.js`; `go-navigation.js:absenceText`; `tests/go-semantic-core.test.js`; `tests/go-navigation-context.test.js` |
| Unknown selector receivers produce typed member choices instead of a guessed member. Duplicate declarations remain ambiguous. Unresolved embedding and type-set constraints do not produce guessed implementations. | `tests/go-semantic-core.test.js` |
| Package functions, methods, fields, parameters, constants, variables, named types, packages, and builtins retain distinct Go namespaces and readable symbol kinds. Lexical shadowing and local binding lifetime are respected. | `go-semantic-core.js`; `tests/go-semantic-core.test.js` |
| Go aliases, generics and instantiated receivers, explicit and promoted receivers, embedded interfaces, pointer/value method sets, version-suffixed imports, UTF-8 parser versus UTF-16 browser columns, short-declaration redeclarations, and range assignments retain their tested resolution behaviour. | `tests/go-semantic-core.test.js`; `tests/fixtures/semantic-regressions/` |
| Every required interface method, including inherited embedded-interface methods, contributes to candidate-package discovery. Implementation results include context/confidence and have stable pagination. | `go-navigation.js:implementationSearchTerms`; `go-semantic-core.js`; semantic and navigation tests |
| External `_test` packages remain outside the production package namespace even when files share a directory. Generated test doubles may be identified but do not outrank production implementations. | `tests/go-semantic-core.test.js`; semantic regression fixtures |
| Build constraints and dot imports remain explicit safe limitations. Affected resolution must be missing or ambiguous, never confident guesswork. | repository guidelines; semantic regression fixtures |
| Reference and implementation pagination is stable, duplicate-free, supports more than 50 results, and does not rescan unrelated identifiers. Reindexing drops stale candidates. | `tests/go-semantic-core.test.js` |
| Callable signatures truncate only at complete parameter boundaries; attached declaration documentation and complete type bodies retain their structural meaning. | `go-semantic-core.js`; `tests/go-semantic-core.test.js` |

## 5. Source acquisition, compatibility, and failure boundaries

| Contract | Primary evidence |
| --- | --- |
| Repository requests use the signed-in tab's same-origin GitLab session. They carry no GoLens token, do not cross origins, and fetch source only at the MR's immutable full commit SHA (old-side source may use the start/base SHA). | `go-navigation.js:authenticatedFetch`, `sourceRefFor`; `PRIVACY.md`; `SECURITY.md` |
| Ref/path extraction supports current Rapid Diffs and legacy diffs, split old/new rows, deleted rows, accessible line labels, anchor hashes, blob links, paths with bidi/spacing artifacts, and branch names containing slashes. A commit-pinned DOM ref wins when GitLab exposes a stale MR ref. | `go-navigation.js:fileContextFor`, `lineContextFor`; `tests/go-navigation-context.test.js` |
| Repository tree, MR diff, discussion, and search pagination follow GitLab pagination headers. Where GitLab omits headers, a documented page-size fallback continues until a short page. | `go-navigation.js:nextPageNumber`; `tests/go-navigation-context.test.js` |
| Package listing fails explicitly above 200 Go files rather than indexing a partial package. Discussion polling fails explicitly above 20 pages. Project search returns `complete`, `limited`, or `unavailable` coverage and remains cancellable. | `go-navigation.js:listPackageFiles`, `mergeRequestDiscussionStatus`, `searchProjectBlobPaths` |
| Full-project eligibility includes `.go` files but excludes `vendor` and `testdata` trees. Deleted MR files are not loaded as new-side project sources. | `go-navigation.js:isProjectGoPath`, `listMergeRequestChangedFiles`; `tests/go-navigation-context.test.js` |
| Related-package discovery is intentionally bounded to 10 candidate packages, 8 search queries, and 2 search pages; its coverage state must disclose the resulting limit. | constants and preload flow in `go-navigation.js`; navigation tests |
| In-flight source work is abortable on cancellation, disablement, or session/page teardown. A disconnected MV3 worker port rejects outstanding RPC rather than hanging or returning stale results. | `go-navigation.js:workerRPC`, preload/search abort handling; `tests/go-semantic-service-worker.test.js` |
| Worker mutations and cache clearing are serialized. Unknown worker methods report an error without crashing the protocol. | `go-semantic-worker.js:dispatch`; `tests/go-semantic-worker.test.js` |

## 6. Bookmarks

| Contract | Primary evidence |
| --- | --- |
| A bookmark is an MR-local old- or new-side line or contiguous range within one file and side. Users can toggle it from the gutter/selection/shortcut, navigate previous/next, and remove individual, current-head, stale-head, or all entries through the accessible drawer. | `go-navigation.js` bookmark functions; `content.js:showBookmarkDrawer`; bookmark tests |
| Bookmark markers coexist with GitLab comment buttons and survive diff DOM replacement and extension reload. Old and new lines with the same number remain distinct. | `tests/content-bookmarks.test.js`; `tests/go-navigation-context.test.js`; `tests/browser-smoke.mjs` |
| Records are isolated by origin, project, MR IID, and head SHA. They contain path, side, range, timestamps, optional bounded symbol text, and SHA-256 selection/before/after fingerprints—never source excerpts. | `bookmark-store.js`; `PRIVACY.md`; `tests/bookmark-store.test.js` |
| A stale bookmark recovers only when its bounded context has one safe match. Recovery writes the new record before deleting the old one; ambiguous or missing matches remain stale. | `bookmark-store.js`; `go-navigation.js:recoverBookmark`; bookmark and navigation tests |

## 7. Settings, shortcuts, onboarding, and accessibility

| Contract | Primary evidence |
| --- | --- |
| The popup is compact and exposes global enablement, active-MR context, full-project cache state/progress, cache size, and a gear that opens settings inside the active GitLab page. | `popup.html`, `popup.js`; `tests/popup.test.js` |
| Settings is a large iframe overlay with General, Shortcuts, GitLab access, Cache, and Help tabs. It can close by button, backdrop, Escape, or message and returns focus. | `settings.html`, `settings.js`; `content.js:showSettingsOverlay`; `tests/settings.test.js`; browser smoke |
| General settings control enablement, generated-file hiding, and contextual shortcut tips. Shortcuts can apply GoLens, VS Code, IntelliJ IDEA, or non-modal Vim-style presets, then assign, clear, or reset every individual action. Assigning a duplicate binding unassigns its previous action. | `settings.html`; `shortcut-settings.js`; shortcut tests |
| The 14 configurable actions are file-search focus/clear, semantic jump, previous/next occurrence, hunk, file and bookmark, semantic-history back/forward, and bookmark toggle. Portable `Primary` displays as Command on macOS and Ctrl elsewhere; repeats and composing events do not match. | `shortcut-settings.js`; `tests/shortcut-settings.test.js` |
| Contextual coaching covers file search, semantic jump, next occurrence, and history back after two equivalent manual uses. It shows at most one hint per review session, respects a 24-hour global cooldown, caps each action at two hints, retires an action after shortcut use, and can be disabled from the tip or settings. Failure to save learning state never interrupts review navigation. | `shortcut-settings.js:createShortcutCoach`; `tests/shortcut-settings.test.js`; `tests/shortcut-coach-ui.test.js` |
| First-run setup appears once per onboarding version on the first supported MR. It stages a keymap and generated-file choice, saves both only on completion, preserves custom bindings, and leaves synchronized preferences unchanged if dismissed. Settings Help always opens the complete four-chapter reference. | `content.js:showSetupOnboarding`, `showOnboarding`; `tests/content-onboarding.test.js` |
| Onboarding, the feature guide, bookmark drawer, full-search UI, Go result UI, and settings are keyboard reachable and use labelled ARIA dialogs/tablists/tabpanels/status regions where interactive. Modal overlays trap Tab, support Escape, and restore focus. | runtime markup in `content.js`, `popup.html`, `settings.html`; onboarding, settings, bookmark, navigation, and browser tests |
| Tab lists support click plus Left/Right/Home/End navigation and roving `tabindex`. Dynamic progress and status text use `role=status`, `aria-live`, `aria-busy`, and native progress elements as appropriate. | `content.js`; `settings.js`; popup/settings markup and tests |
| Icon-only controls have accessible names/tooltips, decorative images are empty-alt or hidden, selected/toggle states expose `aria-selected` or `aria-pressed`, and visible focus rings remain. | runtime and static markup; `tests/browser-smoke.mjs` |
| Reduced-motion preferences remove motion or replace it with static states for overlays, transitions, destination effects, and celebrations. | `gitlab-lens.css`; inline overlay styles in `content.js` |

## 8. Storage, privacy, and permissions

| Store or boundary | Contract | Primary evidence |
| --- | --- | --- |
| `chrome.storage.sync` | Stores `enabled`, `hideGeneratedFiles`, `shortcutCoachEnabled`, and `shortcutBindings`. Changes reconcile across open tabs. | `content.js`, `popup.js`, `settings.js` |
| `chrome.storage.local` | Stores `golensOnboardingVersion`, `golensShortcutCoach`, bounded Friday MR-creation state, and one versioned `golensBookmark:v1:` record per bookmark. None contains cached source. | `content.js`; `shortcut-settings.js`; `bookmark-store.js`; `PRIVACY.md` |
| IndexedDB | Database `golens-go-semantic-cache`, schema/cache format v3, stores content-addressed source blobs plus package, project, and MR manifests isolated by origin/project/commit. Source blob content is verified against Git SHA-1 or SHA-256 before reuse; corrupt or incomplete data is purged or treated as a miss. | `go-semantic-cache.js`; `tests/go-semantic-cache.test.js` |
| Cache lifecycle | Unchanged blobs may be shared across commits within the same project, never across projects/origins. Renames retain current paths. Cache status is complete only while every referenced blob is intact. Users can inspect size/counts and clear all snapshots and in-memory indexes. | `go-semantic-cache.js`; cache and worker tests |
| Permissions | Required permissions are `storage`, `unlimitedStorage`, and `scripting`; automatic host access is only `https://gitlab.com/*`. Optional HTTP(S) host access supports exact self-hosted origins. No wildcard input, embedded credentials, non-HTTP scheme, or GitLab.com duplicate is accepted as a self-hosted grant. | `manifest.json`; `gitlab-host-access.js`; host-access tests |
| Network/privacy | There is no developer backend, analytics, advertising, telemetry, repository upload, or token collection. Repository and MR API calls go only to the active GitLab origin. Chrome sync may be processed by the browser vendor; source and bookmarks otherwise stay local to the profile. | `PRIVACY.md`; `SECURITY.md`; runtime fetch code |
| Web-accessible resources | Only settings, required icons, and celebration assets are exposed to HTTP(S) pages. Extension pages permit self-hosted scripts and WebAssembly evaluation required by checked-in Tree-sitter assets; objects remain blocked. | `manifest.json` |

## 9. Packaging, validation, and release operations

| Contract | Primary evidence |
| --- | --- |
| Development uses Node 24 in CI. `npm run check:syntax` syntax-checks all production and operational JavaScript; `npm test` runs every `tests/*.test.js`; `npm run test:browser` runs real unpacked-extension injection against local GitLab fixtures. `npm run check` runs all three. | `package.json`; `.github/workflows/ci.yml` |
| Unit/contract coverage includes content projections, onboarding, popup/settings, shortcuts/coaching, permissions, bookmarks, semantic parsing/resolution, worker protocol, durable cache, release guardrails, and GitLab context variants. | `tests/*.test.js` |
| Browser smoke verifies real MV3 injection, settings iframe loading, the four-control order, reload/DOM-replacement resilience, focus/full-file/cache/semantic interactions, accessibility affordances, commit-pinned source reuse across MRs, and a streamed large-diff main-thread delay below 40ms. Transient DevTools startup/connection timeouts receive one retry. | `tests/browser-smoke.mjs` |
| CI regenerates vendored Tree-sitter assets and requires a clean `vendor/` diff, runs syntax/unit checks, retries browser smoke once at the job level, checks manifest/package version equality, builds the archive, and verifies the zip. Dependency review fails at moderate severity or above. | `.github/workflows/ci.yml`; `.github/workflows/dependency-review.yml` |
| Packaging creates `dist/golens-for-gitlab-v<manifest-version>.zip` from an explicit allowlist: legal/privacy notices, manifest, runtime/UI files, icons/celebrations, and vendored parser assets. Tests, docs, screenshots, sources not in the allowlist, and development dependencies are excluded. | `scripts/package-extension.mjs` |
| `npm run release` requires equal valid Chrome versions, a clean `main`, an upstream at the same commit, and a passing full check. It creates and pushes an annotated `v<version>` tag; a failed push removes the local tag. | `scripts/release-extension.mjs`; `tests/release-extension.test.js` |
| Tag-triggered release CI verifies tag/version equality and ancestry on `main`, revalidates vendored assets and the complete check, packages and verifies the archive, then publishes a generated-notes GitHub release containing the zip. | `.github/workflows/release.yml` |
| Production dependencies remain browser-local and checked in where required: Tree-sitter runtime/Go grammar are vendored with third-party notices; package dependencies are development/test tooling only. | `package.json`; `vendor/`; `THIRD_PARTY_NOTICES.md` |

## 10. Rewrite acceptance use

The rewrite plan must turn this catalogue into executable parity evidence:

1. Map each contract row to a retained, adapted, or newly added automated test.
2. Keep policy-only claims (`PRIVACY.md`, `SECURITY.md`, permissions and release
   constraints) as explicit review checklist items where runtime testing is not
   proportionate.
3. Mark any deliberate behaviour change in the migration specification before
   implementation; silence is not approval to drop an item.
4. Treat the current 40ms streamed-large-diff bound as the legacy floor until
   “Set performance budgets” establishes the replacement budgets.
5. Preserve safe missing/ambiguous/limited outcomes even if an additive
   semantic improvement changes which inputs can be resolved confidently.

