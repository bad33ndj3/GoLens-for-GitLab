# Restructure the JavaScript before TypeScript

Label: `wayfinder:map`
Status: open

## Destination

An approved spec — target module boundaries (decided from scratch, not carried over from any prior
attempt), dependency rules, small stable public interfaces, and an execution sequence — for
restructuring the five large legacy JS files (`go-navigation.js`, `content.js`, `go-semantic-core.js`,
`go-semantic-cache.js`, `go-semantic-worker.js`) in place, as preparation for a later TypeScript
migration. This map produces the spec and its tickets; it does not execute the refactor.

## Notes

- Consult `codebase-design` and `domain-modeling` for module/interface design; `grilling` for every
  HITL ticket.
- Prior context: `caspers/rewrite-extension-architecture` attempted a big-bang TS+Lit rewrite and
  failed — by the end, functionality regressed, the UI looked completely different, things were slow,
  UX was bad, and many things no longer worked, because behaviour, performance, and UI all changed at
  once with no incremental verification. This map exists so the next attempt is staged and verifiable.
  **That rewrite's module analysis (Review Session / GitLab Host / Go Intelligence) is explicitly
  ignored** — target module boundaries are decided fresh against the current legacy code, not inherited.
- Every step keeps existing behaviour and performance intact; no UI or framework changes belong in this
  map.
- Prepares a later TypeScript migration; that migration is a separate, not-yet-started effort and is
  out of scope here.
- Tracker: local markdown in this `.scratch/restructure-js-before-ts/` directory (repo default is
  GitHub Issues per `docs/agents/issue-tracker.md`, overridden for this effort at the user's request).
  Blocking is expressed via a `**Blocked by:**` line in each ticket body (no native blocking available).

## Decisions so far

- [01 — Audit tests and docs against current features](issues/01-audit-tests-and-docs-against-current-features.md) — Docs mostly matched; fixed `domain.md`'s inaccurate `src/` layout and `AGENTS.md`'s missing `bench`/`package`/`release` commands. No coverage gaps found; nothing added to fog.
- [02 — Model current dependency structure](issues/02-model-current-dependency-structure.md) — Full map in [02-dependency-map.md](issues/02-dependency-map.md). `go-navigation.js`/`content.js` are hub files carrying many unrelated features through one `state` object each; `go-semantic-core.js`/`go-semantic-cache.js` are clean leaf ES modules; `go-semantic-worker.js` is the sole bridge between them via one port-RPC channel. No true cycles; one near-cycle (`go-navigation.js` reads `content.js`'s DOM directly for one check); one dead contract (`golens-go-status` event, never listened to); policy/infra interleaving found in all five files.
- [03 — Define target module boundaries](issues/03-define-target-module-boundaries.md) — Feature-slices over een platformlaag: `page/lifecycle` (orchestrator) → 9 feature-modules → `page/platform` (rpc-client, settings-store, clock, overlay-registry); worker blijft `dispatch`/`index-core`/`source-cache`. Verboden: feature→feature, feature→lifecycle, elk `globalThis`-contract. Per module functional core / imperative shell; `mount(ctx)`→`unmount()` state-lifecycle; één eigenaar per `chrome.storage`-key. Page-modules worden echte ES modules via dynamic `import()` (bootstrap-contentscript, geen bundler). Breekpakket: DOM-backdoor → overlay-registry, RPC-status-roundtrip → resultaat in antwoord, dood `golens-go-status` event en lege `_implementationCache` verwijderd, clock/debounceIdle gededupliceerd, worker-dispatch routing/effect gesplitst.

## Not yet specified

- Capability-by-capability migration tickets (steps 6–14 of the source plan: introduce interfaces
  around existing code, refactor one capability at a time, move complexity behind deeper modules,
  delete replaced code immediately after each migration, reassess abstractions after several
  migrations). These can't be ticketed until target module boundaries, dependency rules, and public
  interfaces (see frontier tickets below) are decided — the boundaries determine what the capabilities
  and their migration order even are.
- Whether this map's scope extends to actually sequencing/executing those capability migrations, or
  stops once the spec is approved and hands off to a fresh execution effort. Revisit once the interface
  design ticket resolves.
- Follow-up test coverage, if the audit ticket finds gaps in characterisation coverage for critical
  functionality that must be closed before refactoring can safely begin.

## Out of scope

- Any TypeScript migration work itself.
- Any UI, Lit, or framework changes.
- Reusing or re-validating the `caspers/rewrite-extension-architecture` module analysis — ignored per
  user instruction, not reopened.
