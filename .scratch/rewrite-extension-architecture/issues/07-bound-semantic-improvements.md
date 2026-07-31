# Bound the semantic improvements allowed in the rewrite

Type: `grilling`
Status: resolved
Blocked by: 01, 06

## Question

Which additive semantic improvements are safe and valuable enough to include in the rewrite, and what evidence proves that each preserves existing correct results and never weakens ambiguous, incomplete, or unsupported outcomes?

## Answer

The rewrite includes no additive semantic capabilities. It preserves the observable semantic contract and existing query surface: symbol resolution, references, and interface implementations.

The current module model is an explicit limitation: GoLens reads only the repository-root `go.mod` to establish one module path. Nested modules, `go.work`, and `replace`-based repository-local module resolution are outside this rewrite. When that limitation prevents a result from being proven, Go Intelligence must return `unsupported` or `coverage-insufficient`; it must not guess an import identity, navigate speculatively, or report repository-wide absence.

Semantic changes made while replacing the implementation are admissible only when required to preserve existing correct behaviour. Each requires a regression that fails against the incomplete replacement, the existing semantic regression suite as non-regression evidence, and assertions that ambiguous, unsupported, missing, and incomplete-coverage outcomes remain at least as conservative. Such a correction restores parity; it does not authorize a new query type, result claim, or user-visible feature.
