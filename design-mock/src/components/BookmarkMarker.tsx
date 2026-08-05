import type { ButtonHTMLAttributes } from 'react';

export interface BookmarkMarkerProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'onClick'> {
  /** Whether this line is currently bookmarked. */
  pressed: boolean;
  /** Called when the bookmark button is clicked. */
  onToggle: () => void;
  /** Accessible label for the bookmark button. */
  label?: string;
}

/**
 * Inline bookmark toggle button rendered next to code lines in diff view.
 *
 * @example
 * <BookmarkMarker pressed={isBookmarked} onToggle={() => setBookmarked(!isBookmarked)} label="Bookmark this line" />
 */
export function BookmarkMarker({
  pressed,
  onToggle,
  label,
  className,
  ...rest
}: BookmarkMarkerProps) {
  return (
    <button
      type="button"
      className={['golens-bookmark-marker', className ?? ''].filter(Boolean).join(' ')}
      aria-pressed={pressed}
      aria-label={label ?? 'Bookmark this line'}
      onClick={onToggle}
      {...rest}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 3h12v18l-6-4-6 4V3z" />
      </svg>
    </button>
  );
}
