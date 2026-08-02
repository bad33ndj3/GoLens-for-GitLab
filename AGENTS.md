# Repository Guidelines

## Project Structure & Module Organization

GoLens for GitLab is a TypeScript Manifest V3 browser extension built with esbuild into four compiled entries.

- `src/content.ts` detects GitLab merge requests, mounts the AI-sidebar control strip, owns focus mode and file-search shortcuts, and renders first-run onboarding. Compiled to `content.js` (IIFE format).
- `src/worker.ts` is the service worker entry; it initialises Go Intelligence and coordinates architecture storage resets. Compiled to `worker.js` (ESM).
- `src/popup.ts` defines compact active-review controls. Compiled to `popup.js` (ESM).
- `src/settings.ts` defines the tabbed settings iframe including self-hosted origin approval and dynamic content-script registration. Compiled to `settings.js` (ESM).
- `src/gitlab-host/` owns the GitLab DOM adapter, page projection, diff file mounting, and the full-file Lit surface.
- `src/go-intelligence/` owns semantic symbol resolution, the Tree-sitter Go index, cache, and worker RPC protocol.
- `src/review-session/` owns the Review Session orchestrator: lifecycle, state, shortcuts, and bookmark navigation.
- `src/domain.ts`, `src/feature-catalog.ts`, `src/shortcuts.ts`, `src/user-storage.ts` are shared modules.
- `src/popup.html`, `src/popup.css`, `src/settings.html`, `src/settings.css`, `src/gitlab-lens.css`, `src/golens-theme.css` are static UI assets copied into the build output.
- `tests/` contains Node unit tests and Playwright browser smoke tests.
- `tests/contracts/`, `tests/entrypoints/`, `tests/private/`, `tests/architecture/` contain module and contract tests for the rewrite.
- `assets/` contains extension artwork. `vendor/` contains checked-in Tree-sitter runtime files and the Go grammar.
- `experiments/` documents non-production investigations; do not make production behavior depend on them.

## Build, Test, and Development Commands

- `npm install` installs development-only test and parser dependencies (requires Node 24).
- `npm test` runs all `node:test` suites in `tests/*.test.js` and `tests/**/*.test.js`.
- `npm run test:rewrite-browser` loads the built extension in Playwright against local GitLab fixtures.
- `npm run check` performs syntax checks, type checks, import rules, unit tests, a build, and browser smoke tests. Run this before submitting changes.
- `npm run build` compiles `src/` to `dist/extension/` with architecture epoch 1 active.
- `npm run vendor:parser` refreshes `vendor/` after parser dependency changes. Commit the regenerated artifacts and license updates together.

For manual testing, run `npm run build` then load `dist/extension/` through `chrome://extensions` using **Load unpacked**, then open a GitLab merge-request Changes page.

## Runtime & User Workflow

The manifest injects `content.js` automatically on GitLab.com. Self-hosted GitLab origins require explicit user approval and persistent dynamic content-script registration through `settings.js`. `content.ts` must still confirm the page is GitLab before changing it and only mounts page controls on an individual merge request. The controls live in a Shadow DOM immediately after GitLab's AI-panel button; never fall back to mounting them on the document body.

GitLab navigation can replace the current merge request without reinjecting content scripts. Keep page setup and teardown idempotent, reconcile Turbo/PJAX DOM changes, propagate `chrome.storage.sync` changes to every open tab, and cancel in-flight source requests when a page or GoLens session ends. Exiting browser fullscreen with Escape must also leave review focus.

The four page controls, from top to bottom, turn GoLens on or off, enter or leave fullscreen review focus, cache related Go packages for the MR head, and open MR-local bookmarks. Hover a Go identifier for its signature and documentation. Plain-click selects its loaded-diff occurrences; Cmd-click on macOS or Ctrl-click elsewhere resolves definitions, usages, or interface implementations, and `Cmd/Ctrl+F12` performs the same action for the selected occurrence by default. Configurable shortcuts move between occurrences, hunks, files, bookmarks, and in-diff semantic history; settings can apply GoLens, VS Code, IntelliJ IDEA, or non-modal Vim-style keymaps before editing individual actions. Contextual shortcut tips may teach a configured binding after the equivalent manual action, with local learning state, a session and time cooldown, and a synced enablement preference. `Cmd/Ctrl+P` focuses GitLab's file search and `Shift+F` clears it by default. The compact toolbar popup owns global enablement, active-project cache status, full-project caching, and the settings entry point. Its gear opens the large tabbed `settings.html` extension iframe inside `#golens-settings-root`; that surface owns review preferences, shortcuts, self-hosted origin approval, cache management, and tour replay.

Keep source access same-origin and commit-pinned. `src/gitlab-host/` fetches through the signed-in GitLab session; `src/go-intelligence/` owns parsing, indexing, and IndexedDB persistence in the worker. `chrome.storage.sync.enabled` owns the global preference. `chrome.storage.local.golensOnboardingVersion` owns per-install onboarding state. Versioned `golensBookmark:` records own minimal MR-local bookmark locations and hashed recovery context; they never contain source excerpts. Popup-to-tab messages belong in `src/content.ts`; cache statistics and clearing are worker messages.

Follow GitLab pagination headers when present and retain the documented page-size fallback because GitLab.com can omit some pagination headers. A directory safety limit must fail explicitly rather than silently indexing a partial package. Keep production packages and external `_test` packages in separate semantic namespaces even though their files share a directory. Build constraints and dot imports remain explicit safe limitations: return missing or ambiguous results instead of guessing.

## Onboarding Contract

The first supported GitLab MR shows a short setup flow once per installation. It asks for a shortcut preset and whether to hide GitLab-marked generated files, then teaches the essential interactions. Staged choices save together only when setup finishes; dismissing setup must leave synchronized preferences unchanged. The settings Help page's **Open feature guide** button must always open the complete reference. Keep both modes isolated in `#golens-onboarding-root` Shadow DOM, keyboard accessible as ARIA modal dialogs, dismissible with Escape, and visually aligned with the compact dark/orange/cyan extension UI. Keep their copy synchronized with shipped controls and shortcuts; do not document legacy checklist, dock, dashboard, or `?` help behavior that is not present in production.

Treat the Help reference as the complete user-facing feature inventory, including small helpers and popup-only controls. Keep first-run setup limited to consequential preferences and essential interactions. Every added, removed, or changed user-visible behavior must update the relevant reference chapter and `tests/contracts/content.test.js` in the same change; if a behavior genuinely should not be taught, record the reason in the PR description. Keep related capabilities grouped into short navigable chapters rather than one dense screen. When first-run setup changes materially, increment `ONBOARDING_VERSION` in `src/content.ts` so existing installations see the updated setup once.

## Coding Style & Naming Conventions

Use TypeScript with two-space indentation, semicolons, single quotes, and `camelCase` identifiers. Use `UPPER_SNAKE_CASE` for module constants and descriptive kebab-case asset names such as `golens-icon.png`. Keep GitLab DOM integration in `src/gitlab-host/` and semantic logic DOM-independent in `src/go-intelligence/`. Use Valibot at untrusted runtime boundaries and typed discriminated unions for expected outcomes. Use Lit only for GoLens-owned Shadow DOM elements; GitLab-owned DOM remains behind imperative adapters. There is no automatic formatter; match surrounding code and keep changes narrowly scoped.

## Testing Guidelines

Tests use Node's built-in `node:test` and `assert`; DOM fixtures use `happy-dom`. Name unit tests `*.test.js` and browser scenarios `*-smoke.mjs`. Add regression coverage for GitLab DOM variants, ref/path extraction, worker protocols, and symbol-resolution edge cases. Never allow missing or ambiguous symbols to navigate speculatively.

Put contract-level coverage in `tests/contracts/`; put entry-point coverage in `tests/entrypoints/`; put private implementation tests in `tests/private/`; reserve `tests/rewrite-browser-smoke.mjs` and `tests/rewrite-update-smoke.mjs` for real extension injection and GitLab integration.

## Commit & Pull Request Guidelines

Use a short, imperative commit subject, for example `Rename extension to GoLens`. Keep commits focused and explain user-visible behavior in the PR description. Include linked issues when available, test results, and screenshots or recordings for the control strip, onboarding, hover, focus-mode, or GitLab layout changes.

## Security & Privacy

Keep repository source inside the browser, extension, and signed-in GitLab origin. Do not add tokens, remote analytics, repository-content uploads, or broad new permissions without explicit justification. Preserve commit-pinned navigation and same-origin authenticated requests.

## Agent skills

### Issue tracker

Issues and PRDs are tracked as local Markdown under `.scratch/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Triage uses the default canonical labels. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository. See `docs/agents/domain.md`.

## Build Requirement

Always run `npm run build` after making any source change before declaring the task done. A passing build confirms TypeScript compiles and all four extension entry points bundle without errors.
