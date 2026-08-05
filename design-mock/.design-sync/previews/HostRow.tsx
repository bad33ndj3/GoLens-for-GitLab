import { HostRow } from 'golens-design-mock';

export function Idle() {
  return (
    <div style={{ width: 500 }}>
      <HostRow origin="https://gitlab.example.com" status="idle" onRemove={() => {}} />
    </div>
  );
}

export function Success() {
  return (
    <div style={{ width: 500 }}>
      <HostRow
        origin="https://gitlab.mycompany.internal"
        status="success"
        statusLabel="Reachable"
        onRemove={() => {}}
      />
    </div>
  );
}

export function Error() {
  return (
    <div style={{ width: 500 }}>
      <HostRow
        origin="https://gitlab.staging.example.com"
        status="error"
        statusLabel="Unreachable"
        onRemove={() => {}}
      />
    </div>
  );
}
