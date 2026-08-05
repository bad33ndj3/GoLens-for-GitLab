import { Button } from './Button';
import { ProgressBar } from './ProgressBar';
import { StatusText } from './StatusText';

export interface CacheCardProps {
  /** Card heading; defaults to "Project intelligence". */
  title?: string;
  /** Describes what is cached, e.g. "128 Go files at commit a1b2c3d". */
  description: string;
  /** Human-readable cache size, e.g. "4.2 MB". */
  sizeLabel: string;
  /** Current caching state; defaults to `idle`. */
  state?: 'idle' | 'busy' | 'complete' | 'error';
  /** Progress percentage (0-100), only shown while `state` is `busy`. */
  progress?: number;
  /** Label for the primary action button; defaults to "Cache full project". */
  actionLabel?: string;
  onAction: () => void;
}

/**
 * GoLens's popup card showing the project cache status and the action to (re)build it.
 *
 * @example
 * <CacheCard
 *   description="128 Go files at commit a1b2c3d"
 *   sizeLabel="4.2 MB"
 *   state="busy"
 *   progress={62}
 *   onAction={cacheProject}
 * />
 */
export function CacheCard({
  title,
  description,
  sizeLabel,
  state = 'idle',
  progress,
  actionLabel,
  onAction,
}: CacheCardProps) {
  return (
    <section className="golens-cache-card">
      <div className="golens-cache-card__heading">
        <div>
          <h1 className="golens-cache-card__title">{title ?? 'Project intelligence'}</h1>
          <StatusText tone={state === 'error' ? 'error' : 'muted'}>{description}</StatusText>
        </div>
        <output className="golens-cache-card__size">{sizeLabel}</output>
      </div>
      <Button variant="primary" success={state === 'complete'} disabled={state === 'busy'} onClick={onAction}>
        {actionLabel ?? 'Cache full project'}
      </Button>
      {state === 'busy' && <ProgressBar value={progress ?? 0} label="Caching project" />}
    </section>
  );
}
