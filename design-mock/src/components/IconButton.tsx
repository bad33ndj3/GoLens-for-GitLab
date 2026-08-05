import type { ButtonHTMLAttributes, ReactNode } from 'react';

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Visual style. `default` is the standard small control, `close` is for dismissal, `rail`
   * is for the control-rail buttons that may show spinners during busy states. */
  variant?: 'default' | 'close' | 'rail';
  /** SVG icon element; optional and only meaningful when not in busy state. For `close`
   * variant, omitting this renders a text `×` character. */
  icon?: ReactNode;
  /** When true on `rail` variant, replaces the icon with an animated spinner SVG. */
  busy?: boolean;
  /** Accessible name used as aria-label and title attribute. Required. */
  label: string;
}

/**
 * GoLens's small icon button, used for close actions, control-rail commands, and toggle states.
 *
 * @example
 * <IconButton icon={<CheckmarkIcon />} label="Confirm" onClick={onConfirm} />
 * <IconButton variant="close" label="Close panel" onClick={onClose} />
 * <IconButton variant="rail" icon={<CogIcon />} busy={isSaving} label="Save settings" />
 */
export function IconButton({
  variant = 'default',
  icon,
  busy = false,
  label,
  className,
  ...rest
}: IconButtonProps) {
  const classes = [
    'golens-icon-button',
    variant !== 'default' ? `golens-icon-button--${variant}` : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  let content: ReactNode;
  if (busy && variant === 'rail') {
    content = (
      <svg
        viewBox="0 0 24 24"
        className="golens-icon-button__spinner"
        aria-hidden="true"
      >
        <circle
          cx="12"
          cy="12"
          r="9"
          strokeWidth="2"
          fill="none"
          stroke="currentColor"
          strokeDasharray="24"
          strokeLinecap="round"
        />
      </svg>
    );
  } else if (variant === 'close' && !icon) {
    content = '×';
  } else {
    content = icon;
  }

  return (
    <button type="button" className={classes} aria-label={label} title={label} {...rest}>
      {content}
    </button>
  );
}
