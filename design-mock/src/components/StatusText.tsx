import type { ReactNode } from 'react';

export interface StatusTextProps {
  /** Visual tone conveying the status. `muted` is the default neutral state, `success` is
   * for confirmations, `error` is for problems. */
  tone?: 'muted' | 'success' | 'error';
  /** Text content to display. */
  children: ReactNode;
}

/**
 * GoLens's status message text, used for validation feedback, operation results, and warnings.
 *
 * @example
 * <StatusText>Cache has been cleared</StatusText>
 * <StatusText tone="success">Project cached successfully</StatusText>
 * <StatusText tone="error">Failed to reach GitLab host</StatusText>
 */
export function StatusText({ tone = 'muted', children }: StatusTextProps) {
  const classes = [
    'golens-status',
    tone !== 'muted' ? `golens-status--${tone}` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes} role="status">
      {children}
    </span>
  );
}
