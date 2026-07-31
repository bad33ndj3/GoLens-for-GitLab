# Implement Go Intelligence cache and worker runtime

Status: ready-for-agent
Blocked by: 16

## Acceptance criteria

- Restore, fetch, verify, and atomically publish source with explicit Coverage.
- Keep content-addressed cache data repository-isolated and purge corruption safely.
- Serialize mutations per Source identity; queries observe immutable Semantic snapshots.
- Make cache clear a barrier and define the cancellation commit point.
- Validate a versioned private worker protocol and recover from one worker restart before reporting unavailable.
- Expose cache inspection and clearing through the public interface.
- Cover cold, warm, cancelled, corrupted, serialized, and restarted behavior.
