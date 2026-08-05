import { ChoiceRow } from 'golens-design-mock';

export function InDiff() {
  return (
    <div style={{ width: 420, background: '#1d2126', padding: 12 }}>
      <ChoiceRow
        title="func (s *Service) Refresh(ctx context.Context) error"
        context="internal/sync/service.go:42"
        doc="Refresh re-pulls the project's cached index from GitLab."
        destination="inDiff"
        destinationLabel="Jump to this line in the diff"
      />
    </div>
  );
}

export function NewTab() {
  return (
    <div style={{ width: 420, background: '#1d2126', padding: 12 }}>
      <ChoiceRow
        title="func (m *memoryCache) Get(key string) ([]byte, bool)"
        context="internal/store/memory_cache.go:12"
        doc="In-memory cache used by benchmarks."
        destination="newTab"
        destinationLabel="Open file in a new tab"
      />
    </div>
  );
}
