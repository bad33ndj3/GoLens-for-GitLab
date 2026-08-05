import { Button } from './Button';

export interface HelpCardProps {
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
}

/**
 * A promotional/help card pointing to a related action, such as docs or support.
 *
 * @example
 * <HelpCard title="Need a hand?" description="Read the setup guide for self-managed GitLab." actionLabel="Open guide" onAction={openGuide} />
 */
export function HelpCard({ title, description, actionLabel, onAction }: HelpCardProps) {
  return (
    <div className="golens-help-card">
      <div className="golens-help-card__icon" aria-hidden="true" />
      <div>
        <strong>{title}</strong>
        <p>{description}</p>
        <Button variant="primary" onClick={onAction}>
          {actionLabel}
        </Button>
      </div>
    </div>
  );
}
