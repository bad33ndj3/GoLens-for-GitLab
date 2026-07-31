# Rebuild the GoLens extension architecture

Label: `wayfinder:map`
Status: open

## Destination

An approved, implementation-ready migration specification and single-merge-request execution plan for replacing GoLens's authoring architecture without losing required behaviour, safety, privacy, or release confidence.

## Notes

- This map plans the rewrite; it does not implement the destination.
- Consult `codebase-design`, `domain-modeling`, `grilling`, `prototype`, and `playwright` as each ticket requires.
- Preserve local-first, same-origin, commit-pinned source handling and explicit ambiguous or unsupported semantic outcomes.
- Implement the rewrite in one merge request with a logically reviewable, generally green commit sequence and no hybrid architecture remaining after merge.
- Use TypeScript and esbuild without WXT or Plasmo.
- Centre the architecture on Review Session, GitLab Host, and Go Intelligence.
- Use Lit only for GoLens-owned Shadow DOM; GitLab-owned DOM remains behind imperative adapters.
- Use Valibot at untrusted runtime boundaries and typed discriminated unions for expected outcomes.
- Keep GitLab source fetching in the content context; keep parsing, indexing, mutation serialization, and IndexedDB in the worker.
- Replace the custom browser harness with Playwright and retain `node:test` for fast module and contract tests.
- Functional parity is the minimum. Additive semantic improvements may be included only when separately documented, regression-tested, and non-speculative.
- All existing GoLens storage may be reset with an explicit upgrade notice.
- Do not broaden extension permissions, introduce remote services or analytics, generalize to other forges, or target non-Chromium browsers.
- Generated `dist/` output remains uncommitted.
- The accepted architectural decisions are recorded in [`ADR-0001`](../../docs/adr/0001-rewrite-extension-architecture-in-one-merge-request.md).

## Decisions so far

- [Inventory the observable behaviour contract](issues/01-inventory-observable-behaviour.md) — Established the evidence-backed parity floor and the rule for turning it into rewrite acceptance coverage.
- [Design the TypeScript build and package topology](issues/02-design-build-and-package-topology.md) — Fixed the explicit four-entry build, validated single-artifact flow, deterministic packaging, development workflow, and CI-owned release contract.

## Not yet specified

- Exact semantic improvements cannot be selected until the new Go Intelligence contract exposes the safe opportunities against the recorded parity floor.
- Detailed package ownership and dependency rules depend on the deep-module interfaces and lifecycle prototype.
- The final merge-request work breakdown, rollback point, and switch-over commit depend on the build, runtime, UI, test, and performance decisions.
- Additional GitLab DOM variants or worker failure modes may emerge while cataloguing the current compatibility contract.

## Out of scope

- GitHub, Bitbucket, or generic multi-forge support.
- Firefox, Safari, or a cross-browser abstraction layer.
- A remote language service, repository-content uploads, analytics, or new broad permissions.
- New product features or intentional UX redesigns unrelated to an explicitly approved semantic improvement.
- Preserving existing settings, shortcuts, onboarding state, bookmarks, or semantic caches across the rewrite.
