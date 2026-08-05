export interface ChoiceRowProps {
  title: string;
  context?: string;
  doc?: string;
  /** `inDiff` jumps within the current merge-request diff; `newTab` opens the file in a new tab. */
  destination: 'inDiff' | 'newTab';
  destinationLabel: string;
  onSelect?: () => void;
}

const IN_DIFF_ICON = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M2 2h2v6a3 3 0 0 0 3 3h4.2L9 8.8 10.4 7 15 11.5 10.4 16 9 14.2l2.2-2.2H7a4 4 0 0 1-4-4V2z" />
  </svg>
);

const NEW_TAB_ICON = (
  <svg viewBox="0 0 16 16" aria-hidden="true">
    <path fill="currentColor" d="M9 2h5v5h-2V5.4L7.7 9.7 6.3 8.3 10.6 4H9V2z" />
    <path fill="currentColor" d="M3 3h4v2H4v7h7V9h2v5H2V3h1z" />
  </svg>
);

/**
 * One candidate row in the Go intelligence popover's choice list — shown when a definition,
 * reference, or implementation query resolves to more than one location.
 *
 * @example
 * <ChoiceRow
 *   title="func (s *Service) Refresh(ctx context.Context) error"
 *   context="internal/sync/service.go:42"
 *   doc="Refresh re-pulls the project's cached index from GitLab."
 *   destination="inDiff"
 *   destinationLabel="Jump to this line in the diff"
 *   onSelect={() => {}}
 * />
 */
export function ChoiceRow({ title, context, doc, destination, destinationLabel, onSelect }: ChoiceRowProps) {
  return (
    <button type="button" className="golens-choice" onClick={onSelect}>
      <span>
        <span className="golens-choice-title">{title}</span>
        {context && <span className="golens-choice-context">{context}</span>}
        {doc && <span className="golens-choice-doc">{doc}</span>}
      </span>
      <span
        className={`golens-destination-icon golens-destination-icon--${destination === 'inDiff' ? 'in-diff' : 'new-tab'}`}
        role="img"
        aria-label={destinationLabel}
        title={destinationLabel}
      >
        {destination === 'inDiff' ? IN_DIFF_ICON : NEW_TAB_ICON}
      </span>
    </button>
  );
}
