import { useState } from 'react';
import { IconButton } from 'golens-design-mock';

export function DefaultVariant() {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <IconButton variant="default" label="Settings" />
      <IconButton variant="default" label="Refresh" />
    </div>
  );
}

export function CloseVariant() {
  return <IconButton variant="close" label="Close panel" />;
}

export function RailVariant() {
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
      <IconButton variant="rail" label="Save changes" />
      <IconButton variant="rail" label="Discard" />
    </div>
  );
}

export function RailBusyState() {
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <IconButton
        variant="rail"
        busy={busy}
        label="Apply changes"
        onClick={() => setBusy(!busy)}
      />
      <span style={{ fontSize: 12, color: '#999' }}>Click to toggle busy state</span>
    </div>
  );
}
