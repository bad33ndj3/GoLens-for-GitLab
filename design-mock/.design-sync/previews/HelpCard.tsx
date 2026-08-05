import { HelpCard } from 'golens-design-mock';

export function Default() {
  return (
    <div style={{ width: 500 }}>
      <HelpCard
        title="Need a hand with self-managed GitLab?"
        description="Learn how to allow your instance's origin and grant GoLens the access it needs to annotate diffs."
        actionLabel="Open setup guide"
        onAction={() => {}}
      />
    </div>
  );
}
