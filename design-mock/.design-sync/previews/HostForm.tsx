import { useState } from 'react';
import { HostForm } from 'golens-design-mock';

export function Empty() {
  const [value, setValue] = useState('');
  return (
    <div style={{ width: 500 }}>
      <HostForm value={value} onValueChange={setValue} onSubmit={() => {}} />
    </div>
  );
}

export function Filled() {
  const [value, setValue] = useState('https://gitlab.mycompany.internal');
  return (
    <div style={{ width: 500 }}>
      <HostForm value={value} onValueChange={setValue} onSubmit={() => {}} />
    </div>
  );
}
