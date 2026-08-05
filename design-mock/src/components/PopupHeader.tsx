import { IconButton } from './IconButton';
import { Toggle } from './Toggle';

export interface PopupHeaderProps {
  /** Extension name shown in the popup header. */
  title: string;
  /** Short description shown under the title. */
  subtitle: string;
  /** Whether GoLens is currently enabled for this session. */
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onOpenSettings: () => void;
}

/**
 * GoLens's popup header, showing the extension identity, a link to settings, and the global
 * enable/disable toggle.
 *
 * @example
 * <PopupHeader
 *   title="GoLens for GitLab"
 *   subtitle="Review controls"
 *   enabled={enabled}
 *   onEnabledChange={setEnabled}
 *   onOpenSettings={openSettings}
 * />
 */
export function PopupHeader({ title, subtitle, enabled, onEnabledChange, onOpenSettings }: PopupHeaderProps) {
  return (
    <header className="golens-popup-header">
      <div className="golens-popup-header__identity">
        <div className="golens-popup-header__icon" aria-hidden="true" />
        <div>
          <strong className="golens-popup-header__title">{title}</strong>
          <span className="golens-popup-header__subtitle">{subtitle}</span>
        </div>
      </div>
      <div className="golens-popup-header__actions">
        <IconButton
          variant="default"
          label="Open GoLens settings"
          onClick={onOpenSettings}
          icon={
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
              <circle cx="12" cy="12" r="3" strokeWidth="1.65" />
              <path
                d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1"
                strokeWidth="1.65"
                strokeLinecap="round"
              />
            </svg>
          }
        />
        <Toggle checked={enabled} onCheckedChange={onEnabledChange} label="Enable GoLens for GitLab" />
      </div>
    </header>
  );
}
