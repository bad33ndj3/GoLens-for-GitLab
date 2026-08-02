# Switch all extension entries to rewrite

Status: resolved
Blocked by: 22, 23, 24

## Acceptance criteria

- Record the final green legacy/rewrite checkpoint before switching.
- Switch manifest, package, release, and check paths for all four entries atomically.
- Advance synchronized versions to the next minor release and activate the architecture epoch/reset test.
- Keep permissions, CSP, host access, and web-accessible resources unchanged.
- Run complete legacy and rewrite validation before the switch commit.
- Add no partial fallback or mixed-runtime capability.
- Reverting this commit returns the recorded checkpoint.
