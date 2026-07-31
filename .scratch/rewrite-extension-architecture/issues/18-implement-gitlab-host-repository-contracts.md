# Implement GitLab Host repository contracts

Status: resolved
Blocked by: 15

## Acceptance criteria

- Bind reviews to immutable identities and full commit SHAs.
- Normalize source, package, project-search, and status reads behind typed limits and outcomes.
- Use signed-in same-origin requests for an explicit Source identity.
- Follow pagination headers with the documented short-page fallback and explicit safety bounds.
- Distinguish complete, limited, and unavailable project search.
- Validate self-hosted origins exactly.
- Cover public contracts and private payload, pagination, and failure handling.

## Answer

Added immutable review binding and a typed GitLab Host read contract backed by
validated, signed-in same-origin requests. Repository source, package/project
file discovery, changed-review files, project search, approvals, merge state,
and discussions now hide GitLab payloads and pagination behind stable outcomes.
Full commit identities, exact origins, content identities, short-page fallback,
explicit package/repository/discussion/search bounds, cancellation, malformed
payloads, and routine HTTP failures are covered by contract and private tests.
