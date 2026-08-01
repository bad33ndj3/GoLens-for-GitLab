# Prepare architecture storage reset

Status: resolved
Blocked by: 17, 21

## Acceptance criteria

- Reset sync preferences, local user data, Go Intelligence storage, and the architecture epoch in a restart-safe sequence.
- Make interruption idempotent and block mixed old/new reads while reset is pending.
- Show the exact approved upgrade notice before normal setup.
- Continue acknowledges the notice; Escape or close leaves it pending.
- Preserve accessibility, focus, reduced motion, and staged setup behavior.
- Cover fresh, completed, interrupted, repeated, dismissed, acknowledged, and updated installations.
- Keep the reset inactive until the atomic switch.

## Answer

The worker now owns one serialized architecture-epoch reset across synchronized
preferences, Go Intelligence storage, and local user data. Every rewrite entry
waits for it before reading storage, and the reset remains inactive until the
switch ticket selects the prepared epoch.

The first supported review shows the approved accessible upgrade notice before
normal setup. Dismissal leaves it pending; Continue acknowledges it. Contract
coverage exercises fresh, completed, interrupted, repeated, dismissed,
acknowledged, and updated states.

The upgrade notice is intentionally absent from the permanent Help feature
inventory: it is a one-time migration disclosure that disappears after
acknowledgement, not a reusable product capability. Its exact copy,
accessibility, dismissal, and sequencing are covered at the GitLab Host and
entrypoint seams instead of the legacy onboarding test.
