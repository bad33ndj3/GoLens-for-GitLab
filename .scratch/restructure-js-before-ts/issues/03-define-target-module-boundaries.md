# 03 — Define target module boundaries and dependency rules

Label: `wayfinder:grilling`
Status: open
Assignee: unclaimed
**Blocked by:** 02 — Model the current dependency structure and architectural pressure points

## Question

Given the current dependency structure and pressure points (ticket 02), what should the target module
boundaries be — decided fresh, **not** inherited from `caspers/rewrite-extension-architecture`'s
Review Session / GitLab Host / Go Intelligence split, which is explicitly ignored per user instruction?

Resolve, via `/grilling` and `/domain-modeling`:
- What are the modules, and what does each one own (its single responsibility, stated as what it
  hides, not what it does)?
- What is the allowed dependency direction between them? Which imports are forbidden?
- How do policy/decision logic and infrastructure/side effects get separated, given what ticket 02
  found interleaved?
- How is state ownership and lifecycle made explicit per module (today: globals, DOM, worker
  messages, `chrome.storage`)?
- Which of today's cycles/hubs must be broken, and roughly how (without designing the full interface
  yet — that's ticket 04)?

## Answer

<!-- filled in on resolution -->
