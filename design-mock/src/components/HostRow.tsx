import type { FormEvent } from 'react';
import { Button } from './Button';

export interface HostFormProps {
  value: string;
  onValueChange: (value: string) => void;
  onSubmit: (value: string) => void;
  /** Placeholder shown in the origin input. Defaults to `"https://gitlab.example.com"`. */
  placeholder?: string;
}

/**
 * GoLens's form for allowing a new GitLab origin.
 *
 * @example
 * <HostForm value={origin} onValueChange={setOrigin} onSubmit={addOrigin} />
 */
export function HostForm({ value, onValueChange, onSubmit, placeholder }: HostFormProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(value);
  };

  return (
    <form className="golens-host-form" onSubmit={handleSubmit}>
      <label htmlFor="golens-host-origin">GitLab origin</label>
      <div className="golens-host-form__row">
        <input
          id="golens-host-origin"
          type="text"
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          placeholder={placeholder ?? 'https://gitlab.example.com'}
          required
        />
        <Button type="submit" variant="ghost" size="sm">
          Allow origin
        </Button>
      </div>
    </form>
  );
}

export interface HostRowProps {
  origin: string;
  /** Visual state of the row. Defaults to `'idle'`. */
  status?: 'idle' | 'success' | 'error';
  statusLabel?: string;
  onRemove: () => void;
}

/**
 * A single allowed GitLab origin, with its allow/block status and a remove action.
 *
 * @example
 * <HostRow origin="https://gitlab.example.com" status="success" statusLabel="Reachable" onRemove={removeOrigin} />
 */
export function HostRow({ origin, status = 'idle', statusLabel, onRemove }: HostRowProps) {
  const classes = [
    'golens-host-row',
    status === 'success' ? 'golens-host-row--success' : '',
    status === 'error' ? 'golens-host-row--error' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={classes}>
      <code>{origin}</code>
      {statusLabel && <span className="golens-host-row__status">{statusLabel}</span>}
      <Button variant="ghost" size="sm" onClick={onRemove}>
        Remove
      </Button>
    </div>
  );
}
