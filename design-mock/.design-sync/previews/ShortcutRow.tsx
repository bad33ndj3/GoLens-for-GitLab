import { useState } from 'react';
import { ShortcutRow } from 'golens-design-mock';

export function Bound() {
  return (
    <div style={{ width: 500 }}>
      <ShortcutRow
        actionLabel="Open review overlay"
        binding="⌘⇧O"
        onStartRecording={() => {}}
        onClear={() => {}}
      />
    </div>
  );
}

export function Recording() {
  const [recording, setRecording] = useState(true);
  return (
    <div style={{ width: 500 }}>
      <ShortcutRow
        actionLabel="Jump to next comment"
        binding="Press keys…"
        recording={recording}
        onStartRecording={() => setRecording(true)}
        onClear={() => {}}
      />
    </div>
  );
}

export function ClearDisabled() {
  return (
    <div style={{ width: 500 }}>
      <ShortcutRow
        actionLabel="Toggle side-by-side diff"
        binding="⌘⇧D"
        onStartRecording={() => {}}
        onClear={() => {}}
        clearDisabled
      />
    </div>
  );
}
