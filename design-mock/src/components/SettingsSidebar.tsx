import type { ReactNode } from 'react';
import { Toggle } from './Toggle';

export interface SettingsTabItem {
  id: string;
  label: string;
  icon: ReactNode;
}

export interface SettingsSidebarProps {
  tabs: SettingsTabItem[];
  activeTabId: string;
  onTabChange: (id: string) => void;
  enabled: boolean;
  onEnabledChange: (enabled: boolean) => void;
}

/**
 * GoLens's settings navigation rail — page tabs plus the global enable switch.
 *
 * @example
 * <SettingsSidebar tabs={tabs} activeTabId="hosts" onTabChange={setActiveTabId} enabled={enabled} onEnabledChange={setEnabled} />
 */
export function SettingsSidebar({ tabs, activeTabId, onTabChange, enabled, onEnabledChange }: SettingsSidebarProps) {
  return (
    <aside className="golens-sidebar">
      <header className="golens-sidebar__identity">
        <div className="golens-sidebar__icon" aria-hidden="true" />
        <div>
          <strong>GoLens settings</strong>
          <span>For GitLab reviews</span>
        </div>
      </header>
      <nav role="tablist" className="golens-sidebar__nav" aria-label="Settings pages">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={tab.id === activeTabId}
            className="golens-sidebar-tab"
            onClick={() => onTabChange(tab.id)}
          >
            {tab.icon}
            <span>{tab.label}</span>
          </button>
        ))}
      </nav>
      <label className="golens-sidebar__global-switch">
        <span>
          <strong>GoLens enabled</strong>
          <small>Synced across open tabs</small>
        </span>
        <Toggle checked={enabled} onCheckedChange={onEnabledChange} label="Enable GoLens for GitLab" />
      </label>
    </aside>
  );
}
