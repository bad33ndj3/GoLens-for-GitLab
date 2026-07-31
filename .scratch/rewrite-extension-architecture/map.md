# Rebuild the GoLens extension architecture

Label: `wayfinder:map`
Status: resolved

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
- Automatically accept the agent's recommended technical, architectural, and evidence-policy choices; ask the user only when a decision steers product scope or user experience.
- All existing GoLens storage may be reset with an explicit upgrade notice.
- Do not broaden extension permissions, introduce remote services or analytics, generalize to other forges, or target non-Chromium browsers.
- Generated `dist/` output remains uncommitted.
- The accepted architectural decisions are recorded in [`ADR-0001`](../../docs/adr/0001-rewrite-extension-architecture-in-one-merge-request.md).

## Decisions so far

- [Inventory the observable behaviour contract](issues/01-inventory-observable-behaviour.md) — Established the evidence-backed parity floor and the rule for turning it into rewrite acceptance coverage.
- [Design the TypeScript build and package topology](issues/02-design-build-and-package-topology.md) — Fixed the explicit four-entry build, validated single-artifact flow, deterministic packaging, development workflow, and CI-owned release contract.
- [Design the three deep module interfaces](issues/03-design-the-deep-module-interfaces.md) — Fixed the orchestration, seams, ownership, dependency direction, result invariants, and hierarchical cancellation contract for Review Session, GitLab Host, and Go Intelligence.
- [Prototype the Review Session lifecycle](issues/04-prototype-the-review-session-lifecycle.md) — Validated replace-not-retarget orchestration, session-local workflow state, scoped effects, stale-result guards, revision reconciliation, fullscreen confirmation, and terminal teardown.
- [Design the GitLab Host contracts](issues/05-design-the-gitlab-host-contracts.md) — Fixed immutable review binding, normalized revisioned targets and events, complete projections, explicit actions, commit-pinned reads, and closed failure outcomes that hide GitLab implementation details.
- [Design Go Intelligence and the worker protocol](issues/06-design-go-intelligence-and-worker-protocol.md) — Fixed the compact query/coverage/cache interface, proof-carrying semantic outcomes, immutable snapshots, commit-point cancellation, durable cache rules, and restart-safe validated worker transport.
- [Bound the semantic improvements allowed in the rewrite](issues/07-bound-semantic-improvements.md) — Fixed semantic scope at parity, with no new query or product capability and an explicit single-root-module limitation.
- [Prototype Lit surfaces and the feature catalog](issues/08-prototype-lit-surfaces-and-feature-catalog.md) — Proved the Lit-owned Shadow DOM seam, accessibility and lifecycle contracts, and one typed catalog driving setup plus the complete guide.
- [Prove the Playwright extension harness](issues/09-prove-the-playwright-extension-harness.md) — Proved a persistent-context MV3 harness for built-extension loading, local fixtures, content-worker messaging, and Playwright-owned browser observability in local and CI runs.
- [Measure the legacy performance baseline](issues/10-measure-the-legacy-performance-baseline.md) — Established reproducible DOM, semantic, cache-processing, and retained-heap workloads, with explicit boundaries for environment-dependent browser and storage measurements.
- [Set the rewrite performance budgets](issues/11-set-performance-budgets.md) — Fixed paired median regression limits, absolute semantic and responsiveness ceilings, validity rules, and treatment of environment-dependent browser paths.
- [Define package ownership and dependency rules](issues/12-define-package-ownership-and-dependencies.md) — Fixed the lean `src/` layout, ownership and import matrix, public package surfaces, and seam-oriented test structure.
- [Plan the atomic switch-over and merge-request sequence](issues/13-plan-the-atomic-switch-over.md) — Fixed the green side-by-side build sequence, atomic four-entry switch, required reset notice, rollback checkpoint, legacy deletion, and final acceptance gate.

## Not yet specified

None currently. New fog should be recorded here only when a frontier decision exposes it.

## Implementation sequence

- [Add rewrite build and architecture guardrails](issues/14-add-rewrite-build-and-architecture-guardrails.md) — resolved in `cac1795`.
- [Add shared values and user-data adapters](issues/15-add-shared-values-and-user-data-adapters.md) — resolved.
- [Implement Go Intelligence semantic outcomes](issues/16-implement-go-intelligence-semantic-outcomes.md) — resolved.
- [Implement Go Intelligence cache and worker runtime](issues/17-implement-go-intelligence-cache-and-worker-runtime.md) — resolved.
- [Implement GitLab Host repository contracts](issues/18-implement-gitlab-host-repository-contracts.md).
- [Implement GitLab Host page projection](issues/19-implement-gitlab-host-page-projection.md).
- [Implement Review Session orchestration](issues/20-implement-review-session-orchestration.md).
- [Compose rewrite extension entries](issues/21-compose-rewrite-extension-entries.md).
- [Add Playwright rewrite parity coverage](issues/22-add-playwright-rewrite-parity-coverage.md).
- [Enforce rewrite performance budgets](issues/23-enforce-rewrite-performance-budgets.md).
- [Prepare architecture storage reset](issues/24-prepare-architecture-storage-reset.md).
- [Switch all extension entries to rewrite](issues/25-switch-all-extension-entries-to-rewrite.md).
- [Remove legacy runtime and harness](issues/26-remove-legacy-runtime-and-harness.md).
- [Remove rewrite planning artifacts](issues/27-remove-rewrite-planning-artifacts.md) — final cleanup after all durable context has moved out of `.scratch/`.

## Out of scope

- GitHub, Bitbucket, or generic multi-forge support.
- Firefox, Safari, or a cross-browser abstraction layer.
- A remote language service, repository-content uploads, analytics, or new broad permissions.
- New product features or intentional UX redesigns unrelated to an explicitly approved semantic improvement.
- Preserving existing settings, shortcuts, onboarding state, bookmarks, or semantic caches across the rewrite.
- Multi-module resolution through nested `go.mod`, `go.work`, or `replace`; the rewrite retains the single repository-root `go.mod` model.
