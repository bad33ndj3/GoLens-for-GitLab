# 03 — Define target module boundaries and dependency rules

Label: `wayfinder:grilling`
Status: resolved
Assignee: claude
**Blocked by:** 02 — Model the current dependency structure and architectural pressure points

## Question

Given the current dependency structure and pressure points (ticket 02), what should the target module
boundaries be — decided fresh, **not** inherited from `caspers/rewrite-extension-architecture`'s
Review Session / GitLab Host / Go Intelligence split, which is explicitly ignored per user instruction?

Resolve, via `/grilling` and `/domain-modeling`:
- What are the modules, and what does each one own (its single responsibility, stated as what it
  hides, not what it does)?
- What is the allowed dependency direction between them? Which imports are forbidden?
- How do policy/decision logic and infrastructure/side effects get separated, given what ticket 02
  found interleaved?
- How is state ownership and lifecycle made explicit per module (today: globals, DOM, worker
  messages, `chrome.storage`)?
- Which of today's cycles/hubs must be broken, and roughly how (without designing the full interface
  yet — that's ticket 04)?

## Answer

Resolved via `/grilling` (six decisions, each confirmed by the user) against the ticket 02 dependency
map. All decisions are fresh; nothing is inherited from `caspers/rewrite-extension-architecture`.

### 1. Decomposition axis: feature slices over a platform layer

Not horizontal layers, not a coarse 5→8 file split. Ticket 02's diagnosis is that unrelated features
share one file and one `state` object each — so the cut is per feature, giving locality (one feature
= one module = one test surface). Policy/infra separation happens *inside* each slice (§4), not as a
repo-wide layer.

### 2. Module list and what each hides

Page context:

| Module | Hides |
|---|---|
| `page/lifecycle` | How page transitions are detected and classified, how `enabled` gates everything, how extension messages (`golens-*` via `chrome.runtime.onMessage`) route to features, and mount/unmount ordering. Owns `reconcilePage`. Not a feature — the imperative shell that wires features. |
| `page/features/code-intel` | How hover/click resolution, the popover, and occurrence highlighting work — one user-facing feature, one deep module; the popover and highlighting are implementation detail, not separate modules. |
| `page/features/project-search` | The "search complete project" modal and its search flow. |
| `page/features/keyboard-nav` | Hunk/file keyboard navigation and shortcut-coach offering. |
| `page/features/mr-preload` | MR-scoped preloading and its status polling. |
| `page/features/bookmarks` | Bookmark anchoring, recovery, and the drawer (today split across both hub files). |
| `page/features/onboarding` | The first-run flow. |
| `page/features/settings-overlay` | The in-page settings overlay. |
| `page/features/celebration` | MR "mascot" celebration polling. |
| `page/features/generated-files` | Generated-file hiding and the full-file button. |
| `page/platform` | `rpc-client` (the one port to the worker), `settings-store`, `clock`/`debounceIdle` (today duplicated), `overlay-registry` (who has an overlay open), DOM-root registry. |

Worker context keeps its confirmed leaf/leaf/hub shape, renamed by role: `worker/dispatch` (RPC
transports + method routing), `worker/index-core` (`GoSemanticIndex`), `worker/source-cache`
(`GoSemanticSourceCache`).

### 3. Dependency direction and forbidden imports

Allowed: `lifecycle → features/* → platform`; worker: `dispatch → index-core | source-cache`.
Cross-feature needs become capabilities that lifecycle injects at mount, or platform services
features subscribe to (e.g. keyboard-nav asks `overlay-registry.isOverlayOpen()` instead of reading
another feature's DOM).

Forbidden: `feature → feature`, `feature → lifecycle`, `platform → feature/lifecycle`,
`page → worker` except through `platform/rpc-client`, any `globalThis` contract between modules.

### 4. Policy vs side effects: functional core, imperative shell — per module

Each module gets pure decision functions (return a plan/classification as data; no DOM, no
`chrome.*`, no IndexedDB) and one thin shell that executes effects. This is an internal seam for
tests, not part of the module's interface. Applies to the ticket 02 §6 offenders, e.g.
`preloadMergeRequest` → `planPreload(diff)`, `reconcilePage` → `classifyPageTransition(url, prev)`,
worker `performDispatch` → routing (pure) vs persist/rollback (shell). No repo-wide command
framework.

### 5. State ownership and lifecycle

- **In-memory:** no module-level mutable globals; `mount(ctx)` creates the module's private state
  and returns `unmount()`, which fully tears it down.
- **`chrome.storage` keys get one owner each**, others read via subscribe and never write a foreign
  key: `enabled` → lifecycle; `hideGeneratedFiles` → generated-files;
  `shortcutBindings`/`shortcutCoachEnabled` → `platform/settings-store` (also the seam toward
  `settings.js`/`shortcut-settings.js`, which already write them).
- **DOM roots:** creator owns them; other modules observe only through the overlay-registry, never
  by querying another module's elements.
- The dead `golens-go-status` event is deleted, not preserved.

### 6. Module mechanism (page side): real ES modules via dynamic `import()`

One thin bootstrap content script stays in `manifest.json` and does
`import(chrome.runtime.getURL('page/main.js'))`; everything else uses real `import`/`export`
(files added to `web_accessible_resources`). No bundler, fitting the repo's no-build setup; the
import graph becomes real and the dependency rules enforceable; the later TS migration only has to
add a compiler. The `globalThis.GoLens*` contracts disappear. Worker side is already ES modules.

### 7. Cycles/hubs to break (full package)

1. Near-cycle: `shortcutCoachBlocked`'s direct read of `#golens-onboarding-root`/
   `#golens-settings-root` becomes an `overlay-registry` query.
2. RPC bookkeeping loop: `restoreMergeRequest` returns completeness in its own RPC result instead
   of round-tripping through a later `mergeRequestCacheStatus` call.
3. Dead `golens-go-status` event: deleted.
4. Never-populated `_implementationCache` plus its maintenance code: deleted (no memoization built
   now — that would be a behaviour change).
5. Duplicated `defaultClock`/`setClock`/`debounceIdle`: de-duplicated into `platform/clock`.
6. Worker `dispatch`/`performDispatch`: routing split from persistence/rollback per §4; the second
   test-only transport stays, as two transports behind one wire-contract interface.

Interface design (method signatures, error modes, invariants) is ticket 04's job.
