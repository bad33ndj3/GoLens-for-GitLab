# Implement Go Intelligence cache and worker runtime

Status: resolved
Blocked by: 16

## Acceptance criteria

- Restore, fetch, verify, and atomically publish source with explicit Coverage.
- Keep content-addressed cache data repository-isolated and purge corruption safely.
- Serialize mutations per Source identity; queries observe immutable Semantic snapshots.
- Make cache clear a barrier and define the cancellation commit point.
- Validate a versioned private worker protocol and recover from one worker restart before reporting unavailable.
- Expose cache inspection and clearing through the public interface.
- Cover cold, warm, cancelled, corrupted, serialized, and restarted behavior.

## Answer

Added the public Go Intelligence client, validated versioned worker protocol, worker runtime, and repository-isolated content-addressed cache. Coverage preparation verifies Git content identities, restores valid durable manifests, parses privately, and publishes immutable snapshots at one explicit commit point. Mutations serialize per Source identity, global clearing is a barrier, corrupt records invalidate affected manifests, and a disconnected client retries one idempotent operation before returning unavailable. Contract and private tests cover cold and warm loads, corruption, repository isolation, serialization, clearing, cancellation around publication, memory restoration, malformed messages, and worker restart recovery.
