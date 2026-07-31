---
status: accepted
---

# Rewrite the extension architecture in one merge request

GoLens will replace its current authoring architecture in one merge request while preserving all user-visible behaviour, storage compatibility, permissions, safe semantic failure modes, and local-first commit-pinned source handling. The replacement will use TypeScript and esbuild without an extension framework; Lit may manage only GoLens-owned Shadow DOM. The architecture will centre on three deep modules: Review Session owns the lifecycle of one active merge-request review, GitLab Host translates GitLab DOM and HTTP responses into stable models, and Go Intelligence owns source loading, worker communication, cache coverage, and semantic queries. This accepts a larger review and integration risk in exchange for reaching the intended module architecture without maintaining a prolonged hybrid system.

## Considered options

- Incrementally migrate modules across multiple merge requests.
- Rewrite in one merge request using an extension framework such as WXT or Plasmo.
- Rewrite in one merge request using a minimal TypeScript and esbuild toolchain.

## Consequences

- The merge request must demonstrate functional parity before the old implementation is removed.
- Commits should remain logically reviewable even though the architecture switches over atomically at merge.
- New product features and intentional UX changes are excluded from the rewrite. Additive semantic improvements are allowed when they are documented separately in the merge request, covered by regressions, preserve every existing correct result, and never weaken explicit ambiguous or unsupported outcomes.
- The rewrite may reset all existing GoLens storage, including settings, shortcut customizations, onboarding state, bookmarks, and semantic caches. With at most five current users, an explicit upgrade notice is preferred over carrying migration code into the new architecture.
