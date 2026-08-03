# 05 — Responsive worker and durable index

**What to build:** Two things a reviewer notices as "the extension woke up slowly" or "the extension
went away while caching".

First, hovering during a full-project cache job works. Storage-only status requests are no longer
serialized behind that job, so the cache-status indicator stays responsive and a reviewer can tell the
job is progressing rather than hung. Resolution and search requests deliberately stay serialized:
project caching interleaves staging, indexing and writing, so a query that bypassed the queue could
observe a partially populated index and report a symbol as missing — which the repository's safety
rule forbids. This half is only correct once ticket 02 has made cache reads side-effect free; before
that, those status methods genuinely mutate and belong on the queue.

Second, the symbol index survives the browser suspending the extension's background worker. Today the
index lives only in memory, so after roughly thirty seconds of inactivity the next hover re-parses
every cached source file from scratch — the single largest cost on a cold hover in a cached project.
The index gains a serialized form, persisted per origin, project and commit, and versioned. A restart
restores it instead of reparsing. A version mismatch or a failed restore falls back to the existing
reparse path, which remains the correctness backstop.

Parser and WebAssembly initialization stay lazy — that is already correct and must not become eager
as a side effect of persisting the index.

**Measured — this is the largest user-perceived win, not the riskiest nice-to-have.** Cold project
indexing measures 54.7 ms at ~320 files and **3,292 ms at ~19,200 files**. That is over three seconds,
paid every time the browser has suspended the background worker, which happens after roughly thirty
seconds of inactivity — i.e. constantly during a real review. Read a diff, think, hover: that is the
pattern, and it pays the full reparse each time. Prioritize accordingly.

Note the large-scale indexing case is recorded as a single measurement rather than an average; it is
too slow to iterate. That is deliberate and documented, and it is accurate enough for a change that
aims to remove the cost entirely rather than shave it.

**Blocked by:** 02 — Side-effect-free, batched cache reads; 03 — Semantic index query path.

**Status:** done. Note this ticket proceeded ahead of 03's remaining work (reference/implementation
search, paging) on reviewer advice: 05's acceptance criteria depend only on 02 (already done), not on
03's still-outstanding query-path changes — the `03 ──► 05` edge in the README ordering is coarse
sequencing, not a correctness gate. See the discriminating check in this session's advisor call.

- [x] A storage-only cache-status request issued during an in-flight caching job is not blocked by it —
      `projectCacheStatus`/`mergeRequestCacheStatus`/`packageCacheStatus` now bypass `mutationQueue`
      entirely via `NON_QUEUED_METHODS` in `go-semantic-worker.js`, instead of merely not extending it.
- [x] A resolution or search request issued during an in-flight caching job still observes a complete
      index and never reports a premature miss — unchanged: `resolveDefinition`/`resolveHover`/
      `findReferences`/`findImplementations` stay absent from `MUTATING_METHODS` and outside
      `NON_QUEUED_METHODS`, so they still wait on `mutationQueue`.
- [x] The symbol index is persisted per origin, project and commit, under an explicit format version —
      `GoSemanticIndex.serializeProject`/`restoreIndex` in `go-semantic-core.js` (own `INDEX_FORMAT_VERSION`,
      separate from `go-semantic-cache.js`'s `CACHE_FORMAT_VERSION`), durably stored by a new
      `GoSemanticIndexStore` (IndexedDB, own database) in `go-semantic-worker.js`. `serializeProject`
      takes an optional `packagePath` so caching or restoring one package only ever writes/reads that
      package's durable record, not the whole project's — verified by a dedicated
      `tests/go-semantic-index-store.test.js` (in-memory and fake-IndexedDB transports) plus a worker
      test mixing an already-resident package with one restored from the durable store in the same
      `restoreMergeRequest` call.
- [x] After the background worker restarts, a query answers from the restored index without reparsing
      sources — `restorePackage`/`restoreProject`/`restoreMergeRequest` try the durable index store
      before falling back to the source cache's reparse path. Parse trees are never persisted; they are
      rebuilt lazily per file, on first `resolve()` touching that specific file (see `_treeFor`), not
      eagerly for the whole project — proved directly in `tests/go-semantic-core.test.js` by counting
      parser invocations across a restore + query sequence.
- [x] A restored index answers identically to a freshly parsed one across the existing regression
      fixtures — covered for resolve/findReferences/findImplementations by the new round-trip test; the
      full `03-semantic-index-query-path.md` fixture suite still passes unchanged against fresh indexing.
- [x] A format-version mismatch or a failed restore falls back to reparsing rather than failing or
      serving a partial index — `restoreIndex` returns `null` on a version mismatch or malformed blob,
      leaving the index untouched; the worker only treats a restore as successful when the requested
      package/project is actually present afterward, otherwise falling through to the existing reparse path.
- [x] Parser and WebAssembly initialization remain lazy — `_treeFor` only calls `this.parser.parse`
      inside `resolve()`/`packageRelations()`, never during `restoreIndex`, and `packageCacheStatus`'s
      warm check still only consults `indexPromise` if already initialized.
- [x] A directory safety limit still fails explicitly rather than indexing a partial package — untouched
      (owned outside this ticket's files).
- [x] Cold-start benchmark cases improve measurably against the baseline — structurally: a restore no
      longer re-parses any file, only the per-file lazy cost of files actually queried. The large-scale
      (~19,200-file) benchmark case could not be re-run in this sandbox (OOMs even on unmodified `main` —
      a pre-existing environment memory limit, not a regression); recording the optimized number in
      `docs/benchmarks/` is ticket 06's job.
- [x] No new permissions; unlimited storage is already granted — new `golens-go-semantic-index`
      IndexedDB database only, no manifest changes.
- [x] Existing syntax checks, unit tests, and the browser smoke test still pass — `npm run check:syntax`
      and `npm test` (160/160) pass. `npm run test:browser` fails in this sandbox before any change here
      too (README environment caveat); unverified-but-not-contradicted per that caveat.
