export interface ShortcutRowProps {
  actionLabel: string;
  /** Rendered key combination, e.g. `"⌘⇧O"`. */
  binding: string;
  recording?: boolean;
  onStartRecording: () => void;
  onClear: () => void;
  clearDisabled?: boolean;
}

/**
 * A single rebindable keyboard shortcut row, with its current binding and a clear action.
 *
 * @example
 * <ShortcutRow actionLabel="Open review overlay" binding="⌘⇧O" onStartRecording={startRecording} onClear={clearBinding} />
 */
export function ShortcutRow({
  actionLabel,
  binding,
  recording,
  onStartRecording,
  onClear,
  clearDisabled,
}: ShortcutRowProps) {
  return (
    <div className="golens-shortcut-row">
      <span>{actionLabel}</span>
      <button type="button" className="golens-shortcut-row__binding" data-recording={recording} onClick={onStartRecording}>
        {binding}
      </button>
      <button
        type="button"
        className="golens-shortcut-row__clear"
        onClick={onClear}
        disabled={clearDisabled}
        aria-label={`Clear shortcut for ${actionLabel}`}
      >
        ×
      </button>
    </div>
  );
}
