# 02 — Model the current dependency structure and architectural pressure points

Label: `wayfinder:task`
Status: open
Assignee: unclaimed
**Blocked by:** none

## Question

What does the *current* dependency structure across the five large files actually look like, and
where is it under the most strain? This is raw material for ticket 03 (target module boundaries) — it
describes what exists, it does not decide what should exist.

Produce a dependency map covering, for `go-navigation.js`, `content.js`, `go-semantic-core.js`,
`go-semantic-cache.js`, and `go-semantic-worker.js`:
- Who calls whom directly (function/class level is fine; file-level granularity is the floor).
- Where state crosses file boundaries — shared globals, module-level mutable state, DOM as shared
  state, `postMessage`/worker protocol payloads, `chrome.storage` keys read/written from more than one
  file.
- Cycles or near-cycles (A depends on B which depends back on something A owns).
- Any file acting as a dependency hub (many unrelated things route through it).
- Places where policy/decision logic (what to do) and infrastructure/side effects (DOM mutation,
  network, storage) are interleaved in the same function, rather than separated.

Write the result as an asset (a markdown document with a dependency diagram or table) linked from this
ticket's resolution — don't just describe it in prose in the answer field.

## Answer

<!-- filled in on resolution -->
