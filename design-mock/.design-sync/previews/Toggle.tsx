import { useState } from 'react';
import { Toggle } from 'golens-design-mock';

export function Unchecked() {
  return <Toggle checked={false} onChange={() => {}} label="Enable GoLens for GitLab" />;
}

export function Checked() {
  return <Toggle checked={true} onChange={() => {}} label="Enable GoLens for GitLab" />;
}

export function Interactive() {
  const [enabled, setEnabled] = useState(false);
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <Toggle
        checked={enabled}
        onCheckedChange={setEnabled}
        label="Enable GoLens for GitLab"
      />
      <span style={{ fontSize: 12, color: '#666' }}>
        {enabled ? 'Enabled' : 'Disabled'}
      </span>
    </div>
  );
}
