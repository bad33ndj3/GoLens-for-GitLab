import { CacheCard } from 'golens-design-mock';

export function Idle() {
  return (
    <div style={{ width: 330 }}>
      <CacheCard
        description="128 Go files at commit a1b2c3d"
        sizeLabel="4.2 MB"
        state="idle"
        onAction={() => {}}
      />
    </div>
  );
}

export function Busy() {
  return (
    <div style={{ width: 330 }}>
      <CacheCard
        description="Caching project files…"
        sizeLabel="4.2 MB"
        state="busy"
        progress={62}
        onAction={() => {}}
      />
    </div>
  );
}

export function Complete() {
  return (
    <div style={{ width: 330 }}>
      <CacheCard
        description="128 files cached at a1b2c3d"
        sizeLabel="4.2 MB"
        state="complete"
        onAction={() => {}}
      />
    </div>
  );
}

export function Error() {
  return (
    <div style={{ width: 330 }}>
      <CacheCard
        description="Failed to reach GitLab — check your connection"
        sizeLabel="4.2 MB"
        state="error"
        onAction={() => {}}
      />
    </div>
  );
}
