import { ProgressBar } from 'golens-design-mock';

export function Empty() {
  return (
    <div style={{ width: 200 }}>
      <ProgressBar value={0} label="Caching project (0%)" />
    </div>
  );
}

export function InProgress() {
  return (
    <div style={{ width: 200 }}>
      <ProgressBar value={45} label="Caching project (45%)" />
    </div>
  );
}

export function Complete() {
  return (
    <div style={{ width: 200 }}>
      <ProgressBar value={100} label="Cache complete" />
    </div>
  );
}

export function NoLabel() {
  return (
    <div style={{ width: 200 }}>
      <ProgressBar value={72} />
    </div>
  );
}
