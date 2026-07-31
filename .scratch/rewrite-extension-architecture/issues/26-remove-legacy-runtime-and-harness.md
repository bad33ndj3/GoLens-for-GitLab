# Remove legacy runtime and harness

Status: ready-for-agent
Blocked by: 25

## Acceptance criteria

- Delete legacy runtime, duplicated UI, compatibility globals, fallbacks, superseded tests, harness, commands, and dependencies.
- Leave only the accepted architecture and Playwright browser coverage.
- Update developer, user, privacy, security, CI, packaging, release, and screenshot documentation.
- Pass the complete clean-checkout acceptance list.
- Validate the runtime allowlist contains no TypeScript, tests, maps, metadata, or legacy files.
- Record checkpoint, checks, reports, reset impact, rollback, and absence of scope additions in merge-request evidence.
