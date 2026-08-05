import { StatusText } from 'golens-design-mock';

export function MutedTone() {
  return <StatusText tone="muted">Checking active merge request…</StatusText>;
}

export function SuccessTone() {
  return <StatusText tone="success">Cache complete and synchronized</StatusText>;
}

export function ErrorTone() {
  return <StatusText tone="error">Failed to reach GitLab instance</StatusText>;
}

export function DefaultMuted() {
  return <StatusText>Cache cleared on GitLab disconnect</StatusText>;
}
