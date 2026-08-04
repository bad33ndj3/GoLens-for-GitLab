# Repository Guidelines

## Project Structure & Module Organization

GoLens for GitLab is a dependency-light Manifest V3 browser extension.

- `bootstrap.js` is the only page content script with real logic: a thin classic script that does
  `import(chrome.runtime.getURL('page/main.js'))`, re-mounts on SPA navigation (a 200ms
  `location.href` poll — the isolated world does not see page-world `pushState`), and owns the
  `chrome.runtime.onMessage` listener.
- `page/` is the ES-module page graph, loaded only through `bootstrap.js`:
  - `page/main.js` constructs the platform services, lists the features, and injects every
    cross-feature capability.
  - `page/lifecycle/` is the imperative shell, not a feature: `index.js` (mount/unmount ordering,
    `enabled` gating), `internal.js` (`FEATURE_ROUTES` message routing, pure), `mr-session.js`
    (merge-request activation latch, SPA reconcile loop, diff `MutationObserver`, and the shared
    `gitlabApi`/`sourceLoader`/`toast`/`workerRPC` instances).
  - `page/platform/` holds `clock`, `diff-dom`, `gitlab-api`, `overlay-registry`, `rpc-client`,
    `settings-store`, `source-loader`, `toast`.
  - `page/features/` holds one module per user-facing feature: `bookmarks`, `celebration`,
    `code-intel`, `controls`, `discussion-line-link`, `generated-files`, `go-test-file-rows`,
    `keyboard-nav`, `mr-preload`, `onboarding`, `project-search`, `settings-overlay`. A
    `*.internal.js` sibling holds that feature's pure decision functions (functional core); the
    `*.js` file is the shell that executes effects.
- `bookmark-store.js` and `shortcut-settings.js` are legacy classic content scripts, injected by the
  manifest ahead of `bootstrap.js`. They are the only sanctioned `globalThis` contracts
  (`GoLensBookmarks`, `GoLensShortcuts`, `GoLensShortcutCoach`) because `settings.js` and the page
  graph both need them and neither can import the other. Do not add new ones. The intended end state
  is that these two contracts disappear; nothing has been done toward that yet.
- `worker/index-core.js` contains the parser-backed Go symbol index, `worker/source-cache.js` its
  IndexedDB source cache; `worker/dispatch.js` exposes both through the extension service worker
  (`manifest.json`'s `background.service_worker`).
- `popup.*` defines compact active-review controls; `settings.*` defines the tabbed settings iframe;
  `extension-cache-ui.js` is the cache-control widget both share and `gitlab-host-access.js` the
  self-hosted-origin approval shared by `settings.js` and the service worker. `golens-theme.css`,
  `gitlab-lens.css`, and `manifest.json` complete the extension UI and configuration.
- `tests/` contains Node unit tests, the headless browser smoke test, and the performance benchmark harness (`tests/benchmarks/`).
- `assets/` contains extension artwork. `vendor/` contains checked-in Tree-sitter runtime files and the Go grammar.
- `experiments/` documents non-production investigations; do not make production behavior depend on them.
- `scripts/` contains `package-extension.mjs` (zips the shippable files into `dist/`), `release-extension.mjs` (tags and pushes a release), `vendor-parser.mjs`, and `benchmark.mjs`.
- `docs/benchmarks/` holds the performance baseline and comparison output produced by `npm run bench`; see `docs/benchmarks/README.md`.

## Module Boundaries

The page graph has one allowed dependency direction: `lifecycle → features/* → platform`. Forbidden,
without exception:

- `feature → feature`. A feature that needs another feature's state gets it as a capability that
  `page/main.js` injects at mount, as a late-bound accessor closure — never a captured value.
- `feature → lifecycle`, and `platform → feature` or `platform → lifecycle`.
- `page → worker` other than through `page/platform/rpc-client.js`.
- Any new `globalThis` contract between modules. The three legacy ones listed above are the whole
  set; `globalThis.GoLensBootstrap` is a test seam no production code reads.

Each module owns its state through `mount(ctx) → { unmount, …≤5 methods }`: no module-level mutable
globals, and `unmount()` must be total and safe to re-mount after. Each `chrome.storage` key has one
owner and others subscribe rather than write: `enabled` → `page/lifecycle`, `hideGeneratedFiles` →
`page/features/generated-files`, `shortcutBindings`/`shortcutCoachEnabled` →
`page/platform/settings-store`. That last one is not fully enforced yet: `settings.js` still writes
`shortcutBindings` to `chrome.storage.sync` directly. Do not add new writers.

Domain outcomes are `kind`-discriminated return values from a closed set; exceptions are for
infrastructure failure only, never a silent early return. `bootstrap.js` is the sole responder for
the message types in its `RESPONDED_TYPES`, which must stay a subset of `page/lifecycle/internal.js`'s
`FEATURE_ROUTES` — `tests/bootstrap-message-seam.test.js` pins that. Two responders on one message
means one of them loses.

## Build, Test, and Development Commands

- `npm install` installs development-only test and parser dependencies.
- `npm test` runs all `node:test` suites in `tests/*.test.js`.
- `npm run test:browser` loads the unpacked extension in Chrome or Helium against a local GitLab fixture.
- `npm run check` performs syntax checks, unit tests, and the browser smoke test. Run this before submitting changes.
- `npm run vendor:parser` refreshes `vendor/` after parser dependency changes. Commit the regenerated artifacts and license updates together.
- `npm run bench` runs the performance benchmark harness against the hot paths tracked in `docs/benchmarks/`; see `docs/benchmarks/README.md` for baseline/comparison usage.
- `npm run package` builds the distributable extension zip into `dist/` (gitignored).
- `npm run release` tags and pushes a release from `package.json`'s version and `manifest.json`.

For manual testing, load the repository through `chrome://extensions` using **Load unpacked**, then refresh a GitLab merge-request Changes page.

## Runtime & User Workflow

The manifest injects `shortcut-settings.js` and `bookmark-store.js` with the stylesheets, then `bootstrap.js`, automatically on GitLab.com; `page/*` ships as a web-accessible resource so the dynamic `import()` resolves. Self-hosted GitLab origins require explicit user approval and persistent dynamic content-script registration through `gitlab-host-access.js`. `page/lifecycle/mr-session.js` must still confirm the page is GitLab before changing it and only activates on an individual merge request. The controls live in a Shadow DOM immediately after GitLab's AI-panel button; never fall back to mounting them on the document body.

GitLab navigation can replace the current merge request without reinjecting content scripts. Keep page setup and teardown idempotent, reconcile Turbo/PJAX DOM changes, propagate `chrome.storage.sync` changes to every open tab, and cancel in-flight source requests when a page or GoLens session ends. Exiting browser fullscreen with Escape must also leave review focus.

The four page controls, from top to bottom, turn GoLens on or off, enter or leave fullscreen review focus, cache related Go packages for the MR head, and open MR-local bookmarks. Hover a Go identifier for its signature and documentation. Plain-click selects its loaded-diff occurrences; Cmd-click on macOS or Ctrl-click elsewhere resolves definitions, usages, or interface implementations, and `Cmd/Ctrl+F12` performs the same action for the selected occurrence by default. Configurable shortcuts move between occurrences, hunks, files, bookmarks, and in-diff semantic history; settings can apply GoLens, VS Code, IntelliJ IDEA, or non-modal Vim-style keymaps before editing individual actions. Contextual shortcut tips may teach a configured binding after the equivalent manual action, with local learning state, a session and time cooldown, and a synced enablement preference. `Cmd/Ctrl+P` focuses GitLab's file search and `Shift+F` clears it by default. The compact toolbar popup owns global enablement, active-project cache status, full-project caching, and the settings entry point. Its gear opens the large tabbed `settings.html` extension iframe inside `#golens-settings-root`; that surface owns review preferences, shortcuts, self-hosted origin approval, cache management, and tour replay.

Keep source access same-origin and commit-pinned. `page/platform/gitlab-api.js` and `source-loader.js` fetch through the signed-in GitLab session and `page/platform/rpc-client.js` sends semantic work to `worker/dispatch.js`; the worker parses with checked-in Tree-sitter assets and persists source snapshots in IndexedDB. `chrome.storage.sync.enabled` owns the global preference. `chrome.storage.local.golensOnboardingVersion` owns per-install onboarding state. Versioned `golensBookmark:` records own minimal MR-local bookmark locations and hashed recovery context; they never contain source excerpts. Popup-to-tab messages are received in `bootstrap.js`, not in the module graph: a listener registered inside `page/` is absent for the first ~15-30ms after page load and again for every unmount/import/mount gap of an SPA re-mount, so messages landing there are silently lost. `bootstrap.js` holds them until a handle exists, then dispatches. Cache statistics and clearing are worker messages.

Follow GitLab pagination headers when present and retain the documented page-size fallback because GitLab.com can omit some pagination headers. A directory safety limit must fail explicitly rather than silently indexing a partial package. Keep production packages and external `_test` packages in separate semantic namespaces even though their files share a directory. Build constraints and dot imports remain explicit safe limitations: return missing or ambiguous results instead of guessing.

## Onboarding Contract

The first supported GitLab MR shows a short setup flow once per installation. It asks for a shortcut preset and whether to hide GitLab-marked generated files, then teaches the essential interactions. Staged choices save together only when setup finishes; dismissing setup must leave synchronized preferences unchanged. The settings Help page's **Open feature guide** button must always open the complete reference. Keep both modes isolated in `#golens-onboarding-root` Shadow DOM, keyboard accessible as ARIA modal dialogs, dismissible with Escape, and visually aligned with the compact dark/orange/cyan extension UI. Keep their copy synchronized with shipped controls and shortcuts; do not document legacy checklist, dock, dashboard, or `?` help behavior that is not present in production.

Treat the Help reference as the complete user-facing feature inventory, including small helpers and popup-only controls. Keep first-run setup limited to consequential preferences and essential interactions. Every added, removed, or changed user-visible behavior must update the relevant reference chapter and `tests/features-onboarding.test.js` in the same change; if a behavior genuinely should not be taught, record the reason in the PR description. Keep related capabilities grouped into short navigable chapters rather than one dense screen. When first-run setup changes materially, increment `ONBOARDING_VERSION` in `page/features/onboarding.js` so existing installations see the updated setup once.

## Coding Style & Naming Conventions

Use modern JavaScript modules where supported, two-space indentation, semicolons, single quotes, and `camelCase` identifiers. Use `UPPER_SNAKE_CASE` for module constants and descriptive kebab-case asset names such as `golens-icon.png`. Everything under `page/` uses real `import`/`export`; there is no bundler, so an import path must resolve as written at runtime. Keep browser integration in the feature and platform shells and semantic logic DOM-independent in `worker/index-core.js`. There is no automatic formatter; match surrounding code and keep changes narrowly scoped.

## Testing Guidelines

Tests use Node's built-in `node:test` and `assert`; DOM fixtures use `happy-dom`. Name tests `*.test.js` and browser scenarios `*-smoke.mjs`. Add regression coverage for GitLab DOM variants, ref/path extraction, worker protocols, and symbol-resolution edge cases. Never allow missing or ambiguous symbols to navigate speculatively.

Page modules test in two halves, matching the functional-core/shell split: `tests/<feature>-internal.test.js` covers the pure decision functions and `tests/features-<feature>.test.js` the mounted shell; platform services use `tests/platform-<name>.test.js`. Put compact popup DOM, storage, and active-tab message coverage in `tests/popup.test.js`; put tabbed settings, permission, cache, and replay coverage in `tests/settings.test.js`. Cover onboarding first-show, persistence, accessibility, overlay mounting, and replay in a focused Happy DOM test; reserve `tests/browser-smoke.mjs` for real extension injection and GitLab integration.

## Commit & Pull Request Guidelines

Use a short, imperative commit subject, for example `Rename extension to GoLens`. Keep commits focused and explain user-visible behavior in the PR description. Include linked issues when available, test results, and screenshots or recordings for the control strip, onboarding, hover, focus-mode, or GitLab layout changes.

## Security & Privacy

Keep repository source inside the browser, extension, and signed-in GitLab origin. Do not add tokens, remote analytics, repository-content uploads, or broad new permissions without explicit justification. Preserve commit-pinned navigation and same-origin authenticated requests.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in GitHub Issues for this repository. See `docs/agents/issue-tracker.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.
