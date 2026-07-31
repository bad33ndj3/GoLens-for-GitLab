# Implement Review Session orchestration

Status: ready-for-agent
Blocked by: 17, 19

## Acceptance criteria

- The composition root replaces immutable Review Sessions instead of retargeting them.
- Drive complete lifecycle projections through a pure reducer and effect runtime.
- Use hierarchical cancellation for terminal, workflow, and operation scopes.
- Reject late results by session, Source identity, operation, Semantic snapshot, and Host revision.
- Preserve semantic interactions, Coverage, navigation history, focus, fullscreen, helpers, and bookmarks.
- Cover lifecycle behavior through the public Review Session contract.
