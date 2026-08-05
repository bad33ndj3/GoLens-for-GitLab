import { useState } from 'react';
import { Button } from 'golens-design-mock';

export function Variants() {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <Button variant="primary">Cache full project</Button>
      <Button variant="ghost">Reset defaults</Button>
      <Button variant="destructive">Clear cache</Button>
    </div>
  );
}

export function Success() {
  return (
    <Button variant="primary" success>
      Cache full project
    </Button>
  );
}

export function Disabled() {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <Button variant="primary" disabled>
        Caching…
      </Button>
      <Button variant="ghost" size="sm" disabled>
        Allow origin
      </Button>
    </div>
  );
}

export function Interactive() {
  const [clicks, setClicks] = useState(0);
  return (
    <Button variant="primary" onClick={() => setClicks((c) => c + 1)}>
      Clicked {clicks} times
    </Button>
  );
}
