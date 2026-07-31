# Design the three deep module interfaces

Type: `grilling`
Status: resolved
Blocked by: 01

## Question

What are the smallest useful interfaces, invariants, ownership rules, cancellation semantics, and dependency directions for Review Session, GitLab Host, and Go Intelligence?

## Answer

Review Session is the sole product-workflow orchestrator. A thin content-entry composition root observes supported reviews through GitLab Host, constructs the cross-module adapters, and replaces rather than retargets Review Sessions. Each Review Session is permanently bound to one `{origin, project, mergeRequest, headSha}` identity and exposes only lifecycle:

```ts
startReviewSession({
  host,
  intelligence,
  preferences,
  bookmarks,
  signal,
}): { stop(): Promise<void> }
```

`stop()` is idempotent, aborts the complete session cancellation tree, waits for cleanup, and makes late results inert. Review Session creates linked child cancellation scopes for replaceable work such as hover, semantic navigation, source loading, and page-side coverage orchestration; a newer equivalent intent aborts the older one. As fixed by [Design Go Intelligence and the worker protocol](06-design-go-intelligence-and-worker-protocol.md), an atomic worker mutation that has crossed its commit point may finish persisting after session cancellation, but its late progress and result remain inert.

GitLab Host contains all GitLab-specific DOM and HTTP knowledge. Raw DOM nodes, selectors, `Response` objects, pagination headers, and GitLab payloads cannot cross its seam. Its smallest useful interface is:

```ts
interface GitLabHost {
  observeReviews(signal): AsyncIterable<ReviewDescriptor | null>;
  connect(review, signal): BoundGitLabHost;
}

interface BoundGitLabHost {
  events(signal): AsyncIterable<HostEvent>;
  apply(projection): ApplyOutcome;
  perform(action, signal): Promise<ActionOutcome>;
  read(query, signal): Promise<HostReadOutcome>;
}
```

The composition root consumes review discovery; one Review Session exclusively consumes its bound connection. `apply` receives complete desired GoLens projections and reconciles them idempotently. `perform` handles explicitly retried one-shot effects. `read` performs authenticated same-origin access and returns Valibot-validated stable models. DOM state changes may coalesce to the latest revision, while user intents are lossless and ordered. Every event and opaque DOM-derived location carries its host revision; an action against an obsolete location returns `stale` without touching replacement DOM.

Go Intelligence is GitLab-neutral and opens against an immutable source identity `{repositoryKey, commitSha}` plus an injected commit-pinned `SourceReader`. It never receives MR URLs, GitLab payloads, authentication details, or DOM locations. Its interface is:

```ts
interface GoIntelligence {
  query(request, signal): Promise<SemanticOutcome>;
  ensureCoverage(request, progress, signal): Promise<CoverageOutcome>;
  inspectCache(request, signal): Promise<CacheSnapshot>;
  clearCache(request, signal): Promise<ClearOutcome>;
}
```

Worker messages, source-fetch scheduling, IndexedDB, parsing, deduplication, and mutation serialization remain implementation-private. Mutations serialize per source identity and atomically publish immutable index snapshots; concurrent queries see only the latest completed snapshot. Cache clearing is a barrier around earlier and later work. Cancellation never rolls back an already published snapshot.

State has one writer:

- Review Session owns ephemeral workflow state, including selection, popovers, navigation history, focus mode, and desired projections.
- GitLab Host owns observed host state and projection mechanics, but makes no product decisions.
- Go Intelligence owns commit-scoped source, index, coverage, and cache state.
- Injected repositories own persisted preferences and bookmarks.

Dependencies point from the composition root into all implementations and from Review Session to the two public module interfaces. GitLab Host and Go Intelligence do not import one another. The composition root adapts the bound Host `read` capability to Go Intelligence's `SourceReader`; only genuinely shared immutable domain values such as `SourceIdentity` belong in a common domain layer.

Every semantic outcome carries its source identity and proven coverage. `missing` is valid only where that coverage proves absence; otherwise the outcome is `coverage-insufficient`. Review Session rejects results for another source identity or host revision.

The interfaces have three failure channels: expected operational conditions are discriminated unions; cancellation is recognizable abort control flow consumed silently by Review Session; malformed validated protocols or broken invariants throw, terminate and clean up that Review Session, and produce one bounded local failure state.
