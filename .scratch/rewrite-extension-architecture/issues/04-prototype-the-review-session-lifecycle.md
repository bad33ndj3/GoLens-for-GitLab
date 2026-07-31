# Prototype the Review Session lifecycle

Type: `prototype`
Status: resolved
Blocked by: 03

## Question

Does a concrete reducer, event vocabulary, effect-runner, and disposal-scope prototype correctly model GitLab navigation, enablement, mutation reconciliation, cancellation, fullscreen exit, storage changes, and teardown without recreating one global state bag?

## Prototype

The accepted throwaway prototype is preserved on local branch
`caspers/prototype-review-session-lifecycle` at commit `fd4ea54`. Its portable
model and terminal driver can be inspected or run from that branch with
`npm run prototype:review-session`.

## Answer

The prototype validated a two-level lifecycle rather than one global product
state bag:

- The composition root owns only global enablement, synchronized preference
  snapshots, supported-review observation, and the active Review Session
  handle. It replaces a Review Session whenever the immutable review identity
  changes; it never retargets an existing session.
- Each Review Session owns its ephemeral workflow reducer. Host events express
  user intentions, host-revision changes, fullscreen confirmation or exit, and
  reconciliation requests without exposing DOM details.
- The reducer emits declarative effects. An effect runner owns asynchronous
  execution and hierarchical cancellation scopes: stopping a session aborts
  its whole tree, while newer equivalent work aborts only its replaceable child
  scope, such as hover.
- An asynchronous result is accepted only when its session id, immutable source
  identity, operation id, and host revision still match. Late results from
  replaced work, replaced DOM, or replaced reviews are inert.
- A host revision change clears revision-bound UI state and reapplies the full
  desired projection. Synchronized preference changes update the composition
  snapshot and the active session snapshot, then reconcile that projection.
- Requesting fullscreen does not itself make review focus active; browser
  confirmation does. Browser fullscreen exit, including Escape, returns focus
  state to inactive and reapplies the projection.
- Composition teardown is terminal and idempotent. Later observations cannot
  restart a disposed composition root.

The human accepted this ownership boundary and lifecycle behaviour after
driving the concrete model. The prototype also caught and corrected the missing
terminal composition state before acceptance.
