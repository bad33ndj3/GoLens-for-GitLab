import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual weight. `primary` is the accent-filled call to action, `ghost` is the bordered
   * secondary style, `destructive` is reserved for irreversible actions like clearing cache. */
  variant?: 'primary' | 'ghost' | 'destructive';
  /** Compact sizing used inside dense rows (shortcut preset, host list). */
  size?: 'md' | 'sm';
  /** Only meaningful on `variant="primary"` — swaps the fill to the success tint, used once a
   * long-running action (like caching a project) has completed. */
  success?: boolean;
  children: ReactNode;
}

/**
 * GoLens's action button. Primary is the accent-filled call to action; ghost is bordered and
 * neutral; destructive is reserved for irreversible actions.
 *
 * @example
 * <Button variant="primary" onClick={cacheProject}>Cache full project</Button>
 * <Button variant="destructive" size="sm" onClick={clearCache}>Clear cache</Button>
 */
export function Button({ variant = 'primary', size = 'md', success = false, className, children, ...rest }: ButtonProps) {
  const classes = [
    'golens-button',
    `golens-button--${variant}`,
    size === 'sm' ? 'golens-button--sm' : '',
    variant === 'primary' && success ? 'golens-button--success' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button type="button" className={classes} {...rest}>
      {children}
    </button>
  );
}
