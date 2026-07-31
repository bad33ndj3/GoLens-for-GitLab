# Prepare architecture storage reset

Status: ready-for-agent
Blocked by: 17, 21

## Acceptance criteria

- Reset sync preferences, local user data, Go Intelligence storage, and the architecture epoch in a restart-safe sequence.
- Make interruption idempotent and block mixed old/new reads while reset is pending.
- Show the exact approved upgrade notice before normal setup.
- Continue acknowledges the notice; Escape or close leaves it pending.
- Preserve accessibility, focus, reduced motion, and staged setup behavior.
- Cover fresh, completed, interrupted, repeated, dismissed, acknowledged, and updated installations.
- Keep the reset inactive until the atomic switch.
