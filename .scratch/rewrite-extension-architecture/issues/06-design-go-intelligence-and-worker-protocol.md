# Design Go Intelligence and the worker protocol

Type: `grilling`
Status: resolved
Blocked by: 01, 03

## Question

What compact Go Intelligence interface and Valibot-validated worker protocol hide source preparation, parser initialization, indexing, cache coverage, query pagination, cancellation, service-worker restart, and typed result semantics from page features?

## Answer

Go Intelligence is one deep, GitLab-neutral module opened against one immutable
`SourceIdentity` and one injected commit-pinned `SourceReader`. Review Session
uses only the four operations already fixed by
[Design the three deep module interfaces](03-design-the-deep-module-interfaces.md):

```ts
interface GoIntelligence {
  query(request: SemanticQuery, signal: AbortSignal): Promise<SemanticOutcome>;
  ensureCoverage(
    request: CoverageRequest,
    progress: (update: CoverageProgress) => void,
    signal: AbortSignal,
  ): Promise<CoverageOutcome>;
  inspectCache(request: CacheInspection, signal: AbortSignal): Promise<CacheSnapshot>;
  clearCache(request: ClearCacheRequest, signal: AbortSignal): Promise<ClearOutcome>;
}
```

The composition root supplies the source identity and adapts the source-related
reads from GitLab Host into `SourceReader`. Page features never initialize the
parser, enumerate or download source, restore indexes, address IndexedDB,
schedule worker mutations, reconnect ports, or construct worker messages.

### Semantic queries and identities

`SemanticQuery` is a closed union with three operations:

- `resolve-symbol` accepts a repository path, one-based line and UTF-16 column,
  rendered identifier, and optional occurrence discriminator;
- `find-references` accepts a returned `SymbolIdentity` and optional page token;
- `find-implementations` accepts an interface `SymbolIdentity` and optional
  page token.

Hover, click, shortcut, declaration-hover, and result presentation are Review
Session concerns, not query variants. One symbol resolution supports all of
them. Go Intelligence converts browser UTF-16 columns to parser coordinates
internally.

`SymbolIdentity` is stable product data: source identity, path, line, column,
kind, and name. It is not a parser node, tree id, memory address, or worker
handle. Go Intelligence verifies that a supplied identity exists in the
current semantic snapshot before using it.

Every successful definition retains the current semantic contract: readable
kind, compact signature, documentation, source location, complete multiline
type body where applicable, receiver/type context, and whether the queried
occurrence is the definition. Reference locations and implementation
candidates remain stably sorted and duplicate-free; implementation candidates
retain pointer/value method-set context, asserted/structural confidence, and
test-double classification.

### Outcomes and proven coverage

`SemanticOutcome` is a closed discriminated union:

- `resolved`: one proven definition;
- `references` or `implementations`: one stable page plus an optional opaque
  continuation token;
- `ambiguous`: explicit candidate choices and reason;
- `external`: builtin, standard-library, or third-party package identity for
  Review Session to present or navigate without Go Intelligence constructing a
  GitLab URL;
- `unsupported`: a safe limitation such as build constraints, dot imports,
  unresolved embedding, or type-set constraints;
- `missing`: absence proven within the attached coverage;
- `coverage-insufficient`: the current snapshot cannot prove absence and names
  the coverage that would answer the query;
- `unavailable`: an operational inability to answer, such as a repeatedly
  unavailable worker or source reader.

Every outcome carries the bound source identity, the semantic snapshot
revision, and its proven `Coverage`. Raw `notFound` from the parser/index is
never allowed to become `missing` merely because the currently loaded packages
contain no match.

Coverage keeps the four user-visible scopes: `current-package`,
`indexed-packages`, `complete-project-search`, and `full-project`.
`complete-project-search` also carries a query fingerprint and search strategy;
proof from one search cannot establish absence for a different query. Coverage
records completeness, package count, relevant package paths, and any stable
limitation (`bounded`, `search-limited`, or `search-unavailable`).

The safe-result rules remain unchanged: unknown selector receivers expose
choices rather than a guess, duplicate declarations remain ambiguous,
unsupported implementation cases do not speculate, and external test packages
remain separate from production packages.

### Coverage orchestration

`CoverageRequest` has four goals:

- load one complete package;
- load the bounded related-review set from supplied changed Go paths;
- complete the candidate search required by one semantic query;
- load the complete eligible project.

Go Intelligence derives package relationships and implementation search terms;
Review Session does not orchestrate these steps. `SourceReader` lists eligible
files, searches paths, and returns source by generic content identity. It does
not expose GitLab endpoints, refs, pagination, credentials, or response types.

`ensureCoverage` first restores any valid durable coverage, prepares the
content manifest, requests only missing sources, verifies their content
identities, builds a candidate index, persists the manifest, and atomically
publishes a new immutable semantic snapshot. Equivalent concurrent requests
for the same source identity and goal are deduplicated and fan progress out to
all callers.

Progress phases are `checking-cache`, `discovering`, `fetching`, `indexing`,
`publishing`, and `ready`. Discovery may be indeterminate. Once totals are
known, completed work and displayed percentage never decrease; cached,
downloaded, remaining-file, and package counts remain explicit.

The existing limits remain visible in the coverage result: related-review
discovery is bounded to ten candidate packages, eight searches, and two pages;
package discovery fails beyond 200 Go files; project eligibility excludes
`vendor` and `testdata`; deleted files are not new-side sources. Limited or
unavailable search remains usable evidence but never proves repository-wide
absence.

### Semantic snapshots, serialization, and cancellation

Go Intelligence is the single writer for commit-scoped source, coverage,
indexes, and cache manifests. Coverage mutations serialize per source identity,
while unrelated source identities may progress independently. A global cache
clear is a barrier: it waits for all previously accepted mutations, clears
durable source and every in-memory snapshot, then later work may start.

Each mutation builds privately and publishes one immutable semantic snapshot
only after parsing and validation succeed. Queries wait for prior mutations of
their source identity and then read one published snapshot; they never observe
a partially indexed package or project. Reindexing replaces stale candidates.

Cancellation stops page-side discovery and source fetching, prevents further
worker mutations, and makes late progress/results inert. Once a worker mutation
crosses its atomic commit point, cancellation does not roll it back: the
mutation may finish persisting and publishing a valid snapshot while GoLens is
disabled, but its response is ignored by the stopped Review Session. Re-enabling
may discover the completed cache. This is the accepted reconciliation of
session teardown with cache completion while disabled.

### Cache contract

Durable source blobs remain content-addressed and isolated by repository key.
Unchanged blobs may be shared across commits of that repository, never across
repositories. Commit manifests preserve current paths after renames and bind
package/project/related-review coverage to the full source identity.

Source content is verified against its declared Git SHA-1 or SHA-256 content
identity before reuse. Corrupt or missing blobs invalidate only the affected
manifest/source and are purged or treated as a miss. Coverage is `complete`
only while every referenced blob and manifest entry validates.

`inspectCache` supports the bound source identity and global aggregate counts
needed by the popup/settings: source blobs, package manifests, project
manifests, and bytes. `clearCache` supports the current product's global clear
only and reports the same deleted counts. The rewrite may introduce a new cache
format and discard the old one, as already approved; no migration adapter is
required.

### Private worker protocol

The worker protocol is private transport, not a second product interface. It is
versioned and has Valibot schemas on both sides:

```ts
type WorkerRequest = {
  protocol: 1;
  clientId: string;
  requestId: string;
  operationId: string;
  source?: SourceIdentity;
  command: WorkerCommand;
};

type WorkerResponse =
  | { protocol: 1; clientId: string; requestId: string; ok: true; value: unknown }
  | { protocol: 1; clientId: string; requestId: string; ok: false; error: WorkerError };
```

`WorkerCommand` has seven internal commands:

- `prepare-coverage`: inspect durable blobs/manifests and report missing content;
- `store-sources`: validate and durably stage bounded batches of fetched source;
- `publish-coverage`: validate a complete manifest, parse/index it, and publish;
- `query`: execute a normalized semantic query against one snapshot;
- `inspect-cache`;
- `clear-cache`;
- `dispose-memory`: drop in-memory snapshots without deleting durable source.

Large source sets may be split into ordered `store-sources` batches; batching is
transport-only and cannot create partial coverage. `publish-coverage` rechecks
the complete manifest instead of trusting a prior preparation result, so a
worker restart between preparation and publication is safe and idempotent.

Requests are validated before dispatch. Success payloads and structured errors
are validated before sending and again after receipt. Unknown commands return
`unknown-command`; version mismatch returns `protocol-mismatch`; neither
crashes the worker. Raw exceptions, stacks, parser nodes, Tree-sitter objects,
IndexedDB records, and source-reader details never cross the transport.

The protocol has control messages for cancellation. The worker cooperatively
stops before the commit point and between source/parser batches; synchronous
parsing already in progress may finish, but cannot publish after pre-commit
cancellation. A mutation past the commit point completes atomically.

### Service-worker restart and pagination

Every port connection receives a fresh `clientId`. On disconnect, all pending
transport promises reject immediately; no caller hangs and no response from the
old client generation is accepted. Go Intelligence reconnects and retries an
idempotent high-level operation once, restoring the required durable snapshot
as part of that retry. A second disconnect returns `unavailable` with
`worker-restarted`; malformed protocol or an impossible response throws an
`IntelligenceContractError` and terminates the Review Session.

Continuation tokens are opaque to Review Session. They bind the source
identity, semantic snapshot revision, query fingerprint, page size, and last
stable sort key. Page size defaults to 25 and is capped at 100. If the snapshot
changes, the token yields `stale-page` rather than mixing results from two
indexes; Review Session restarts the query from the first page. This preserves
stable, duplicate-free pagination without rescanning unrelated identifiers.

### Failure channels and tests

Expected source unavailability, safety limits, insufficient coverage, stale
pagination, and one failed restart recovery are typed outcomes. Cancellation
is recognizable abort control flow and is consumed silently. Invalid worker
messages, corrupt code/asset invariants, parser initialization failure, or an
impossible snapshot/source identity throw `IntelligenceContractError`; lazy
parser initialization resets after failure so a newly constructed module may
try again, but the current Review Session terminates cleanly.

Tests use an in-process worker adapter and in-memory source/cache adapters
through the Go Intelligence interface. Separate private protocol tests cover
Valibot rejection, unknown commands, batching, cancellation before/after the
commit point, per-source serialization, the global clear barrier, port restart
and single retry, stale responses, corrupt blobs, parser initialization,
snapshot replacement, and page-token binding. Existing semantic regression
fixtures remain parity tests of public outcomes rather than transport method
names.
