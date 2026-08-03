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

<!-- none yet -->

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
