import { SymbolBadge, type SymbolKind } from './SymbolBadge';
import { ChoiceRow } from './ChoiceRow';
import { ProgressBar } from './ProgressBar';

export interface GoIntelligenceLoading {
  /** e.g. "Indexing package", "Resolving definition" */
  phase: string;
  current: number;
  total: number;
}

export interface GoIntelligenceChoice {
  id: string;
  title: string;
  context?: string;
  doc?: string;
  destination: 'inDiff' | 'newTab';
  destinationLabel: string;
}

export interface GoIntelligencePopoverProps {
  kind: SymbolKind;
  /** The symbol's name or signature summary, shown as the popover's title. */
  title: string;
  /** Source location caption, e.g. "internal/sync/service.go:42". */
  location?: string;
  /** Present while the worker is still indexing or resolving — replaces the body with a progress bar. */
  loading?: GoIntelligenceLoading;
  /** Compact or full Go signature, shown in a monospace block above the docs. */
  signature?: string;
  /** Doc comment or explanatory text body. */
  docs?: string;
  /** Search-scope caption, e.g. "Full project · 128 indexed packages · complete coverage". */
  scope?: string;
  /** Multiple candidates — shown as a list of selectable rows instead of a single result. */
  choices?: GoIntelligenceChoice[];
  onChoiceSelect?: (id: string) => void;
  /** Pinned popovers (click, not hover) show a close button and behave like a small dialog. */
  pinned?: boolean;
  onClose?: () => void;
  onCopyLocation?: () => void;
}

/**
 * GoLens's core surface: the Go intelligence popover shown when hovering or clicking a
 * recognized Go symbol in a merge-request diff. Shows the symbol's kind, signature, doc
 * comment, and — when a query resolves to more than one candidate — a selectable list of
 * definitions/usages/implementations to jump to.
 *
 * @example
 * <GoIntelligencePopover
 *   kind="function"
 *   title="func Refresh(ctx context.Context) error"
 *   location="internal/sync/service.go:42"
 *   signature="func Refresh(ctx context.Context) error"
 *   docs="Refresh re-pulls the project's cached index from GitLab at the current commit."
 *   scope="Full project · 128 indexed packages · complete coverage"
 *   pinned
 *   onClose={() => {}}
 * />
 */
export function GoIntelligencePopover({
  kind,
  title,
  location,
  loading,
  signature,
  docs,
  scope,
  choices,
  onChoiceSelect,
  pinned = false,
  onClose,
  onCopyLocation,
}: GoIntelligencePopoverProps) {
  return (
    <section className="golens-popover" role={pinned ? 'dialog' : 'tooltip'} aria-label={title}>
      <header className="golens-popover-header">
        <SymbolBadge kind={kind} />
        <div>
          <div className="golens-popover-title">{title}</div>
          {location && <div className="golens-popover-location">{location}</div>}
        </div>
        <div className="golens-popover-actions">
          {location && (
            <button
              type="button"
              className="golens-popover-header-action"
              aria-label="Copy source location"
              title="Copy source location"
              onClick={onCopyLocation}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <rect x="5.25" y="5.25" width="8" height="8" rx="1.25" />
                <path d="M10.75 5.25V3.5c0-.7-.55-1.25-1.25-1.25h-6c-.7 0-1.25.55-1.25 1.25v6c0 .7.55 1.25 1.25 1.25h1.75" />
              </svg>
            </button>
          )}
          {pinned && (
            <button
              type="button"
              className="golens-popover-header-action"
              aria-label="Close Go insight"
              title="Close"
              onClick={onClose}
            >
              <svg viewBox="0 0 16 16" aria-hidden="true">
                <path d="M3 3l10 10M13 3 3 13" />
              </svg>
            </button>
          )}
        </div>
      </header>

      <div className="golens-popover-body">
        {loading ? (
          <div className="golens-popover-loading">
            <div className="golens-popover-loading-meta">
              <span className="golens-popover-loading-phase">{loading.phase}</span>
              <span className="golens-popover-loading-count">
                {loading.current}/{loading.total}
              </span>
            </div>
            <ProgressBar value={(loading.current / Math.max(loading.total, 1)) * 100} label={loading.phase} />
          </div>
        ) : (
          <>
            {signature && (
              <div className="golens-signature-block">
                <pre className="golens-signature">{signature}</pre>
              </div>
            )}
            {docs && <p className="golens-popover-docs">{docs}</p>}
            {scope && <div className="golens-popover-scope">{scope}</div>}
            {choices && choices.length > 0 && (
              <div className="golens-choices">
                {choices.map((choice) => (
                  <ChoiceRow
                    key={choice.id}
                    title={choice.title}
                    context={choice.context}
                    doc={choice.doc}
                    destination={choice.destination}
                    destinationLabel={choice.destinationLabel}
                    onSelect={() => onChoiceSelect?.(choice.id)}
                  />
                ))}
              </div>
            )}
            <div className="golens-popover-shortcut-hint">
              <kbd>⌘</kbd>
              <span>or Ctrl + click to go to definition</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
