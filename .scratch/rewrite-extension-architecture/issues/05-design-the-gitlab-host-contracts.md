# Design the GitLab Host contracts

Type: `grilling`
Status: resolved
Blocked by: 01, 03

## Question

Which stable models and failure modes should the GitLab Host expose while hiding Rapid and legacy diff DOM selectors, pagination, authenticated HTTP, ref discovery, source loading, search, and merge-request state?

## Answer

GitLab Host remains one deep module with the four operations fixed by
[Design the three deep module interfaces](03-design-the-deep-module-interfaces.md):
review discovery, a bound event stream, complete projection reconciliation,
explicit one-shot actions, and typed reads. It does not expose a selector-level
interface or a continuously mirrored copy of GitLab state.

### Review binding and revision

`observeReviews` coalesces page observations to the latest supported review and
emits either `null` or a fully resolved `ReviewDescriptor`:

```ts
type ReviewDescriptor = {
  identity: {
    origin: string;
    repositoryKey: string;
    projectPath: string;
    mergeRequestIid: string;
    headSha: CommitSha;
  };
  refs: {
    baseSha: CommitSha;
    startSha: CommitSha;
  };
};
```

All SHAs are validated full commit SHAs. Branch names, stale MR refs, GraphQL
payloads, blob links, and ref-discovery fallback rules stay private. A changed
head SHA is a different Review Session; moving between overview and changes or
replacing the diff DOM is only a new host revision within the same session.

`connect` creates a bound host permanently tied to that descriptor. It starts
at an opaque, monotonically increasing `HostRevision`. Every event, projection,
and DOM-derived target carries that revision. A target contains a normalized
source position plus an opaque token; it never contains a `Node`, selector,
element id, or GitLab URL:

```ts
type DiffTarget = {
  revision: HostRevision;
  token: HostTargetToken;
  path: RepositoryPath;
  side: 'old' | 'new';
  line: number;
  column?: number;
  source: SourceIdentity;
};
```

The token is valid only for its bound host and revision. The normalized fields
are durable product meaning; the token is the implementation-private route
back to the current DOM.

### Events

`events(signal)` is the sole observation stream after binding. Its closed
discriminated union has three families:

- `host-revised`: the route or rendered host state changed. It carries the new
  revision and a normalized surface kind (`overview`, `changes`, or `other`),
  not mutation records or DOM details.
- `intent`: a lossless, ordered user intention from a GoLens control, shortcut,
  Go identifier, bookmark location, overlay, or native MR action. It carries a
  stable command name and, where needed, a `DiffTarget`.
- `fullscreen-changed`: confirmed browser fullscreen state, distinct from the
  user's request to enter or leave focus mode.

Host revisions may coalesce to the latest state. User intentions never
coalesce. A revision event is delivered before any intention that refers to
that revision. Rapid/legacy rendering differences, MutationObserver records,
pointer events, keyboard events, native button selectors, and browser
fullscreen events are normalized inside the adapter.

### Projection and actions

`apply` accepts one complete `HostProjection` for a specific revision. It
contains the desired enabled state, four-control state, generated/test-file
decorations, full-file controls, interactive Go targets, occurrences,
bookmarks, destination emphasis, status/announcement text, and at most one
active GoLens-owned surface. Omitted projected state means remove it. Applying
the same projection twice is harmless, and a projection for an obsolete
revision cannot touch the current page.

Lit renders only GoLens-owned Shadow DOM from projection models. Imperative
adapters project onto GitLab-owned DOM. Their private split is not visible at
the module interface.

`perform` is reserved for explicit, potentially asynchronous effects that must
not be inferred from a projection:

- request or leave browser fullscreen;
- focus or clear GitLab file search;
- reveal a diff target, including bounded hunk/file expansion;
- switch a file between full-file and changes-only modes;
- open a commit-pinned or documentation destination;
- copy normalized source-location text.

Accepting Rapid Diffs, finding the correct AI-panel anchor, mounting surfaces,
and restoring GitLab presentation are adapter reconciliation responsibilities,
not public actions. Each action carries its revision and an operation id so an
explicit retry is idempotent.

### Reads

`read(query, signal)` is a closed union over stable capabilities, not GitLab
endpoints:

- `source-file`: return validated source text and a generic content identity at
  an explicit `SourceIdentity` and repository path;
- `go-files`: list eligible Go file descriptors for one package, the project,
  or the changed files of the bound review;
- `search-go-paths`: return matching eligible paths plus `complete`, `limited`,
  or `unavailable` coverage and a stable limitation reason;
- `review-status`: return normalized approval, merge, and unresolved-discussion
  facts needed by current product behaviour.

The `source-file`, `go-files`, and `search-go-paths` subset is adapted by the
composition root into Go Intelligence's `SourceReader`; Go Intelligence never
receives the full bound host.

All repository reads require an explicit immutable source identity. Old-side
targets already contain the resolved start/base source identity; callers never
choose between refs. Results use repository paths and generic content
identities rather than GitLab blob ids. Pagination headers, page-size fallback,
CSRF, credentials, endpoint URLs, response payloads, `vendor`/`testdata`
filtering, deleted-file filtering, and same-origin enforcement stay private.

Existing bounds remain interface invariants: package listing fails beyond 200
Go files, discussion polling beyond 20 pages, full-file expansion beyond 500
controls or 15 seconds, and related-package discovery reports its bounded
coverage. A short or failed search never becomes proof of absence.

### Outcomes and failures

Routine outcomes are closed discriminated unions:

```ts
type ApplyOutcome =
  | { kind: 'applied' | 'unchanged' }
  | { kind: 'stale'; currentRevision: HostRevision };

type ActionOutcome =
  | { kind: 'completed' | 'unchanged' }
  | { kind: 'stale'; currentRevision: HostRevision }
  | { kind: 'unavailable'; reason: HostUnavailableReason }
  | { kind: 'limit-exceeded'; limit: HostSafetyLimit };

type ReadOutcome<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'unavailable'; reason: HostUnavailableReason }
  | { kind: 'limit-exceeded'; limit: HostSafetyLimit };
```

Stable unavailability reasons are `not-found`, `not-rendered`, `unsupported`,
`authentication-required`, `forbidden`, `rate-limited`, `offline`, and
`upstream-unavailable`. Raw status codes, response bodies, URLs, headers, and
GitLab error payloads do not cross the seam. Search coverage is part of a
successful search value, so partial results remain usable and honest.

Cancellation rejects with recognizable abort control flow and is consumed
silently by Review Session. Invalid validated payloads, cross-origin access,
an impossible identity/ref/revision combination, or another broken host
invariant throws a bounded `HostContractError`; it terminates that Review
Session rather than masquerading as an ordinary unavailable result. Unknown
programming errors also throw.

Contract tests exercise both Rapid and legacy adapters only through this
interface. Selector fixtures and pagination cases remain private module tests;
Review Session tests use an in-memory host adapter and assert only normalized
events, projections, actions, reads, ordering, stale guards, cancellation, and
failure outcomes.
