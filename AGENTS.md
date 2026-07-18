# Repository Guidelines

## Project Structure & Module Organization

GoLens for GitLab is a dependency-light Manifest V3 browser extension.

- `content.js` detects GitLab merge requests, mounts the three-button AI-sidebar control strip, owns focus mode and file-search shortcuts, and renders first-run onboarding.
- `go-navigation.js` connects diff interactions to GitLab source fetching and semantic RPC.
- `go-semantic-core.js` contains the parser-backed Go symbol index; `go-semantic-worker.js` exposes it through the extension service worker.
- `popup.*` defines compact active-review controls; `settings.*` defines the tabbed settings iframe; `gitlab-lens.css` and `manifest.json` complete the extension UI and configuration.
- `tests/` contains Node unit tests and the headless browser smoke test.
- `assets/` contains extension artwork. `vendor/` contains checked-in Tree-sitter runtime files and the Go grammar.
- `experiments/` documents non-production investigations; do not make production behavior depend on them.

## Build, Test, and Development Commands

- `npm install` installs development-only test and parser dependencies.
- `npm test` runs all `node:test` suites in `tests/*.test.js`.
- `npm run test:browser` loads the unpacked extension in Chrome or Helium against a local GitLab fixture.
- `npm run check` performs syntax checks, unit tests, and the browser smoke test. Run this before submitting changes.
- `npm run vendor:parser` refreshes `vendor/` after parser dependency changes. Commit the regenerated artifacts and license updates together.

For manual testing, load the repository through `chrome://extensions` using **Load unpacked**, then refresh a GitLab merge-request Changes page.

## Runtime & User Workflow

The manifest injects `go-navigation.js` and `content.js` automatically on GitLab.com. Self-hosted GitLab origins require explicit user approval and persistent dynamic content-script registration through `gitlab-host-access.js`. `content.js` must still confirm the page is GitLab before changing it and only mounts page controls on an individual merge request. The controls live in a Shadow DOM immediately after GitLab's AI-panel button; never fall back to mounting them on the document body.

GitLab navigation can replace the current merge request without reinjecting content scripts. Keep page setup and teardown idempotent, reconcile Turbo/PJAX DOM changes, propagate `chrome.storage.sync` changes to every open tab, and cancel in-flight source requests when a page or GoLens session ends. Exiting browser fullscreen with Escape must also leave review focus.

The three page controls, from top to bottom, turn GoLens on or off, enter or leave fullscreen review focus, and cache related Go packages for the MR head. Hover a Go identifier for its signature and documentation. Plain-click selects its loaded-diff occurrences; Cmd-click on macOS or Ctrl-click elsewhere resolves definitions, usages, or interface implementations, and `Cmd/Ctrl+F12` performs the same action for the selected occurrence by default. Configurable shortcuts move between occurrences, hunks, files, and in-diff semantic history; settings can apply GoLens, VS Code, IntelliJ IDEA, or non-modal Vim-style keymaps before editing individual actions. Contextual shortcut tips may teach a configured binding after the equivalent manual action, with local learning state, a session and time cooldown, and a synced enablement preference. `Cmd/Ctrl+P` focuses GitLab's file search and `Shift+F` clears it by default. The compact toolbar popup owns global enablement, active-project cache status, full-project caching, and the settings entry point. Its gear opens the large tabbed `settings.html` extension iframe inside `#golens-settings-root`; that surface owns review preferences, shortcuts, self-hosted origin approval, cache management, and tour replay.

Keep source access same-origin and commit-pinned. `go-navigation.js` fetches through the signed-in GitLab session and sends semantic work to `go-semantic-worker.js`; the worker parses with checked-in Tree-sitter assets and persists source snapshots in IndexedDB. `chrome.storage.sync.enabled` owns the global preference. `chrome.storage.local.golensOnboardingVersion` owns per-install onboarding state. Popup-to-tab messages belong in `content.js`; cache statistics and clearing are worker messages.

Follow GitLab pagination headers when present and retain the documented page-size fallback because GitLab.com can omit some pagination headers. A directory safety limit must fail explicitly rather than silently indexing a partial package. Keep production packages and external `_test` packages in separate semantic namespaces even though their files share a directory. Build constraints and dot imports remain explicit safe limitations: return missing or ambiguous results instead of guessing.

## Onboarding Contract

The first supported GitLab MR shows a short setup flow once per installation. It asks for a shortcut preset and whether to hide GitLab-marked generated files, then teaches the essential interactions. Staged choices save together only when setup finishes; dismissing setup must leave synchronized preferences unchanged. The settings Help page's **Open feature guide** button must always open the complete reference. Keep both modes isolated in `#golens-onboarding-root` Shadow DOM, keyboard accessible as ARIA modal dialogs, dismissible with Escape, and visually aligned with the compact dark/orange/cyan extension UI. Keep their copy synchronized with shipped controls and shortcuts; do not document legacy checklist, dock, dashboard, or `?` help behavior that is not present in production.

Treat the Help reference as the complete user-facing feature inventory, including small helpers and popup-only controls. Keep first-run setup limited to consequential preferences and essential interactions. Every added, removed, or changed user-visible behavior must update the relevant reference chapter and `tests/content-onboarding.test.js` in the same change; if a behavior genuinely should not be taught, record the reason in the PR description. Keep related capabilities grouped into short navigable chapters rather than one dense screen. When first-run setup changes materially, increment `ONBOARDING_VERSION` in `content.js` so existing installations see the updated setup once.

## Coding Style & Naming Conventions

Use modern JavaScript modules where supported, two-space indentation, semicolons, single quotes, and `camelCase` identifiers. Use `UPPER_SNAKE_CASE` for module constants and descriptive kebab-case asset names such as `golens-icon.png`. Keep browser integration in `go-navigation.js` and semantic logic DOM-independent in `go-semantic-core.js`. There is no automatic formatter; match surrounding code and keep changes narrowly scoped.

## Testing Guidelines

Tests use Node's built-in `node:test` and `assert`; DOM fixtures use `happy-dom`. Name tests `*.test.js` and browser scenarios `*-smoke.mjs`. Add regression coverage for GitLab DOM variants, ref/path extraction, worker protocols, and symbol-resolution edge cases. Never allow missing or ambiguous symbols to navigate speculatively.

Put compact popup DOM, storage, and active-tab message coverage in `tests/popup.test.js`; put tabbed settings, permission, cache, and replay coverage in `tests/settings.test.js`. Cover onboarding first-show, persistence, accessibility, overlay mounting, and replay in a focused Happy DOM test; reserve `tests/browser-smoke.mjs` for real extension injection and GitLab integration.

## Commit & Pull Request Guidelines

Use a short, imperative commit subject, for example `Rename extension to GoLens`. Keep commits focused and explain user-visible behavior in the PR description. Include linked issues when available, test results, and screenshots or recordings for the control strip, onboarding, hover, focus-mode, or GitLab layout changes.

## Security & Privacy

Keep repository source inside the browser, extension, and signed-in GitLab origin. Do not add tokens, remote analytics, repository-content uploads, or broad new permissions without explicit justification. Preserve commit-pinned navigation and same-origin authenticated requests.
