# Define package ownership and dependency rules

Type: `grilling`
Status: resolved
Blocked by: 02, 03, 04, 05, 06, 08

## Question

What final `src/` layout, package ownership, allowed dependency directions, public exports, and test locations preserve deep modules without replacing the two large files with a forest of shallow wrappers?

## Answer

Use three source packages for the three deep modules, four composition roots,
and four small cross-cutting authored modules. Do not create `shared`, `common`,
`utils`, `services`, per-feature packages, or one-file wrapper directories.

```text
src/
  content.ts
  worker.ts
  popup.ts
  popup.html
  popup.css
  settings.ts
  settings.html
  settings.css
  domain.ts
  feature-catalog.ts
  shortcuts.ts
  user-storage.ts
  gitlab-lens.css
  golens-theme.css
  review-session/
    index.ts
    reducer.ts
    runtime.ts
  gitlab-host/
    index.ts
    dom.ts
    repository.ts
    surfaces.ts
    access.ts
  go-intelligence/
    index.ts
    client.ts
    worker-runtime.ts
    protocol.ts
    semantic-index.ts
    cache.ts
```

This is an ownership map, not a file-size target. A private file may remain
large when splitting it would expose sequencing or state that belongs together.
Split a listed file later only when it contains two independently changing
responsibilities; do not pre-slice it by feature or class.

### Ownership

- `content.ts` is the thin content-context composition root. It observes global
  enablement, constructs GitLab Host and the user-storage adapters, adapts the
  bound host's source reads directly to Go Intelligence's `SourceReader`, and
  replaces Review Sessions. It contains no selectors, product reducer, cache
  algorithm, or semantic logic.
- `worker.ts` only starts the Go Intelligence worker runtime. `popup.ts` and
  `settings.ts` own their page wiring and static-page rendering; they use public
  capabilities and do not import content-entry code.
- `review-session/` owns product workflow, ephemeral state, effects,
  cancellation scopes, stale-result rejection, and complete host projections.
  `reducer.ts` is pure state transition logic; `runtime.ts` executes its effects.
- `gitlab-host/` owns review discovery, Rapid and legacy DOM reconciliation,
  authenticated same-origin GitLab reads, pagination and safety limits,
  in-page Lit surfaces, fullscreen/native actions, and self-hosted permission
  administration. Lit stays in `surfaces.ts`; product state stays out.
- `go-intelligence/` owns its page-side client, private validated transport,
  worker runtime, parser/index, immutable snapshots, mutation serialization,
  and IndexedDB cache. Source fetching remains outside it behind `SourceReader`.
- `domain.ts` contains only dependency-free immutable values genuinely shared
  across packages: `CommitSha`, `RepositoryKey`, `RepositoryPath`, and
  `SourceIdentity`, plus their validation constructors. Host revisions, diff
  targets, semantic outcomes, and workflow state remain with their owner.
- `feature-catalog.ts` is the single immutable setup/guide inventory;
  `shortcuts.ts` owns keymap values and pure matching rules; `user-storage.ts`
  owns validated `chrome.storage.sync` preferences and privacy-preserving local
  bookmark/learning records. These are direct modules, not new package seams.

### Public interfaces and dependency direction

Each deep package has exactly one cross-package entry, its `index.ts`:

- `review-session/index.ts` exports `startReviewSession`, its lifecycle handle,
  and the preference/bookmark ports accepted by that function.
- `gitlab-host/index.ts` exports `createGitLabHost`, the `GitLabHost` and
  `BoundGitLabHost` interfaces and their stable contract types, plus one
  high-level self-hosted-access administration capability for settings. It does
  not export selectors, raw payload schemas, DOM adapters, or pagination helpers.
- `go-intelligence/index.ts` exports the bound `GoIntelligence` interface,
  `openGoIntelligence`, its stable requests/outcomes, cache administration, and
  `startGoIntelligenceWorker` for the worker composition root. It does not export
  protocol messages, parser/index classes, IndexedDB records, or batching.

Allowed imports are:

```text
domain <- gitlab-host
domain <- go-intelligence
domain <- review-session -> gitlab-host/index
                          -> go-intelligence/index
entry roots -> any public index or direct authored module
feature-catalog/shortcuts/user-storage -> domain only when needed
```

GitLab Host and Go Intelligence never import each other. Neither imports Review
Session. Deep packages never import composition roots or `user-storage.ts`;
adapters are injected. Cross-package imports must name the owning `index.ts` and
must not reach into another package's private files. Internal files may import
only their own package, `domain.ts`, and locked third-party/runtime dependencies.
No runtime dependency cycle is allowed. Use direct relative imports; path-alias
and barrel layers add no value here.

### Tests and enforcement

Keep tests outside `src/` and mirror the seams rather than every file:

```text
tests/
  architecture/import-rules.test.ts
  contracts/review-session.test.ts
  contracts/gitlab-host.test.ts
  contracts/go-intelligence.test.ts
  private/gitlab-host-dom.test.ts
  private/gitlab-host-repository.test.ts
  private/go-intelligence-protocol.test.ts
  private/go-intelligence-cache.test.ts
  private/go-intelligence-semantic.test.ts
  entrypoints/content.test.ts
  entrypoints/worker.test.ts
  entrypoints/popup.test.ts
  entrypoints/settings.test.ts
  browser/golens.spec.ts
  fixtures/
```

Contract tests use only each package's `index.ts` and in-memory adapters. Private
tests are reserved for selector variants, pagination, protocol validation,
cache corruption/serialization, and semantic regression fixtures whose failure
cannot be diagnosed proportionately through the public interface. Entrypoint
tests prove composition and Chrome-message wiring; Playwright owns real MV3,
GitLab, accessibility, and lifecycle integration.

`import-rules.test.ts` uses Node's filesystem and import parsing sufficient for
the repository's static imports to reject forbidden edges, deep cross-package
imports, composition-root imports, and cycles. Add no architecture dependency.
As contract coverage replaces legacy implementation tests, delete superseded
tests instead of retaining two test layers for the same behaviour.
