# Implement Go Intelligence semantic outcomes

Status: resolved
Blocked by: 15

## Acceptance criteria

- Resolve symbols with kind, signature, documentation, location, receiver, and Full type body.
- Return stable duplicate-free paginated references and implementations bound to source identity, Semantic snapshot, and query.
- Every outcome carries Coverage and distinguishes resolved, ambiguous, unsupported, unavailable, and missing.
- Claim missing only when proven within complete Coverage.
- Retain regression fixtures for scopes, aliases, generics, embedding, method sets, test packages, mocks, and UTF columns.
- Keep build constraints, dot imports, and the single-root-module model explicit safe limitations.
- Expose no GitLab, DOM, IndexedDB, worker, or transport detail through the public contract.

## Answer

Added the typed Go Intelligence contract and migrated the proven parser-backed semantic engine behind a typed Semantic snapshot boundary. Outcomes now carry Source identity, snapshot revision, and Coverage; stable pagination tokens bind the source, snapshot, query, and page size; incomplete Coverage cannot claim `missing`; and safe limitations remain explicit. Contract and retained regression fixtures cover symbol details, references, implementations, ambiguity, method sets, aliases, generics, embedding, test packages, mocks, build constraints, dot imports, the single-root-module limitation, and UTF-16 columns.
