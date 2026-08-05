import type { ReactNode } from 'react';
import { Toggle } from './Toggle';

export interface PreferenceRowProps {
  title: string;
  description: ReactNode;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}

/**
 * A single labelled boolean preference, used to list GoLens's toggleable behaviors.
 *
 * @example
 * <PreferenceRow title="Auto-expand diffs" description="Expand collapsed files on open" checked={autoExpand} onCheckedChange={setAutoExpand} />
 */
export function PreferenceRow({ title, description, checked, onCheckedChange }: PreferenceRowProps) {
  return (
    <label className="golens-preference-row">
      <span>
        <strong>{title}</strong>
        <small>{description}</small>
      </span>
      <Toggle checked={checked} onCheckedChange={onCheckedChange} label={title} />
    </label>
  );
}
