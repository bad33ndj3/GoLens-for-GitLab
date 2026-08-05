export interface ProgressBarProps {
  /** Numeric progress value between 0 and 100. */
  value: number;
  /** Optional accessible label describing the progress. */
  label?: string;
}

/**
 * GoLens's progress indicator bar, used to show completion state of long-running operations.
 *
 * @example
 * <ProgressBar value={45} label="Caching project (45%)" />
 * <ProgressBar value={100} />
 */
export function ProgressBar({ value, label }: ProgressBarProps) {
  return (
    <div
      className="golens-progress"
      role="progressbar"
      aria-valuenow={value}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={label}
    >
      <div className="golens-progress__fill" style={{ width: `${value}%` }} />
    </div>
  );
}
