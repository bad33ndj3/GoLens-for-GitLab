import { useState } from 'react';
import { PopupHeader } from 'golens-design-mock';

export function Enabled() {
  const [enabled, setEnabled] = useState(true);
  return (
    <div style={{ width: 330 }}>
      <PopupHeader
        title="GoLens for GitLab"
        subtitle="Review controls"
        enabled={enabled}
        onEnabledChange={setEnabled}
        onOpenSettings={() => {}}
      />
    </div>
  );
}

export function Disabled() {
  return (
    <div style={{ width: 330 }}>
      <PopupHeader
        title="GoLens for GitLab"
        subtitle="Review controls"
        enabled={false}
        onEnabledChange={() => {}}
        onOpenSettings={() => {}}
      />
    </div>
  );
}
