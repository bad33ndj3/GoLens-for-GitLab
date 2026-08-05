import { useState } from 'react';
import { PreferenceRow } from 'golens-design-mock';

export function Checked() {
  const [checked, setChecked] = useState(true);
  return (
    <div style={{ width: 500 }}>
      <PreferenceRow
        title="Hide generated files"
        description="Collapse files matching your .gitattributes generated markers by default"
        checked={checked}
        onCheckedChange={setChecked}
      />
    </div>
  );
}

export function Unchecked() {
  const [checked, setChecked] = useState(false);
  return (
    <div style={{ width: 500 }}>
      <PreferenceRow
        title="Show contextual shortcut tips"
        description="Display a small hint near the diff toolbar the first few times a shortcut applies"
        checked={checked}
        onCheckedChange={setChecked}
      />
    </div>
  );
}
