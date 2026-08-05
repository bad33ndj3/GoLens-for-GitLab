import { GoIntelligencePopover } from 'golens-design-mock';

export function ResolvedDefinition() {
  return (
    <GoIntelligencePopover
      kind="function"
      title="func Refresh(ctx context.Context) error"
      location="internal/sync/service.go:42"
      signature="func Refresh(ctx context.Context) error"
      docs="Refresh re-pulls the project's cached index from GitLab at the current commit. It is safe to call concurrently; overlapping calls coalesce onto the in-flight refresh."
      scope="Full project · 128 indexed packages · complete coverage"
      pinned
    />
  );
}

export function MultipleChoices() {
  return (
    <GoIntelligencePopover
      kind="interface"
      title="Cache — 3 implementations"
      location="internal/store/cache.go:18"
      docs="Cache abstracts source and index storage so the worker can swap IndexedDB for an in-memory store in tests."
      scope="Current package · internal/store"
      pinned
      choices={[
        {
          id: '1',
          title: 'func (s *sourceCache) Get(key string) ([]byte, bool)',
          context: 'internal/store/source_cache.go:31',
          doc: 'Production IndexedDB-backed cache.',
          destination: 'inDiff',
          destinationLabel: 'Jump to this line in the diff',
        },
        {
          id: '2',
          title: 'func (m *memoryCache) Get(key string) ([]byte, bool)',
          context: 'internal/store/memory_cache.go:12',
          doc: 'In-memory cache used by benchmarks.',
          destination: 'newTab',
          destinationLabel: 'Open file in a new tab',
        },
        {
          id: '3',
          title: 'func (f *fakeCache) Get(key string) ([]byte, bool)',
          context: 'internal/store/fake_cache_test.go:9',
          doc: 'Test double — always returns a miss.',
          destination: 'newTab',
          destinationLabel: 'Open file in a new tab',
        },
      ]}
    />
  );
}

export function Loading() {
  return (
    <GoIntelligencePopover
      kind="package"
      title="Resolving definition…"
      loading={{ phase: 'Indexing package', current: 42, total: 128 }}
    />
  );
}

export function ExternalDoc() {
  return (
    <GoIntelligencePopover
      kind="external"
      title="context.Context"
      docs="A Context carries a deadline, a cancellation signal, and other request-scoped values across API boundaries and between processes."
      scope="Standard library · context"
    />
  );
}
