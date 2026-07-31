# Remove rewrite planning artifacts

Status: ready-for-agent
Blocked by: 26

## Acceptance criteria

- Confirm every rewrite ticket is resolved and its durable decisions live in code, tests, ADRs, or maintained documentation.
- Remove `.scratch/rewrite-extension-architecture/` from Git in the final cleanup commit.
- Restore `.gitignore` to ignoring all of `.scratch/` with no rewrite-specific exception.
- Verify the clean checkout and complete project checks still pass after removal.
