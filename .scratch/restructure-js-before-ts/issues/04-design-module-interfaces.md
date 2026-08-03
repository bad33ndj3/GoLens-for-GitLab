# 04 — Design small, stable public interfaces for each module

Label: `wayfinder:grilling`
Status: open
Assignee: unclaimed
**Blocked by:** 03 — Define target module boundaries and dependency rules

## Question

For each module fixed by ticket 03, what is its public interface — the narrow surface other modules
are allowed to call, deep enough to hide the module's internal complexity?

Resolve, via `/grilling` and `codebase-design`:
- The exported functions/classes per module, their signatures, and what invariants they guarantee.
- What stays private and must not leak (DOM shape, worker message format, cache internals, etc).
- How errors/ambiguous outcomes are represented at each boundary (keep the existing "return missing or
  ambiguous results instead of guessing" contract explicit at the interface, not just in prose).
- Whether any interface needs a prototype (via `/prototype`) to validate feel before committing — flag
  it here rather than deciding blind if a shape is contentious.

## Answer

<!-- filled in on resolution -->
