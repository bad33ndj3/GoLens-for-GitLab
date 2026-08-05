import type { InputHTMLAttributes } from 'react';

export interface ToggleProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type' | 'checked' | 'onChange'> {
  checked: boolean;
  onCheckedChange?: (checked: boolean) => void;
  /** Accessible name — GoLens toggles never carry visible text of their own. */
  label: string;
}

/**
 * GoLens's pill switch, used for the global enable/disable state and boolean preferences.
 *
 * @example
 * <Toggle checked={enabled} onCheckedChange={setEnabled} label="Enable GoLens for GitLab" />
 */
export function Toggle({ checked, onCheckedChange, label, className, ...rest }: ToggleProps) {
  return (
    <input
      type="checkbox"
      className={['golens-toggle', className ?? ''].filter(Boolean).join(' ')}
      checked={checked}
      onChange={(event) => onCheckedChange?.(event.target.checked)}
      aria-label={label}
      {...rest}
    />
  );
}
