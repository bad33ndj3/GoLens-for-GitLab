# Implement GitLab Host repository contracts

Status: ready-for-agent
Blocked by: 15

## Acceptance criteria

- Bind reviews to immutable identities and full commit SHAs.
- Normalize source, package, project-search, and status reads behind typed limits and outcomes.
- Use signed-in same-origin requests for an explicit Source identity.
- Follow pagination headers with the documented short-page fallback and explicit safety bounds.
- Distinguish complete, limited, and unavailable project search.
- Validate self-hosted origins exactly.
- Cover public contracts and private payload, pagination, and failure handling.
