import { useState } from 'react';
import { SettingsSidebar } from 'golens-design-mock';

const tabs = [
  {
    id: 'general',
    label: 'General',
    icon: (
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8" />
      </svg>
    ),
  },
  {
    id: 'shortcuts',
    label: 'Shortcuts',
    icon: (
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8" />
      </svg>
    ),
  },
  {
    id: 'hosts',
    label: 'GitLab access',
    icon: (
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8" />
      </svg>
    ),
  },
  {
    id: 'cache',
    label: 'Cache',
    icon: (
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8" />
      </svg>
    ),
  },
  {
    id: 'help',
    label: 'Help',
    icon: (
      <svg viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="8" />
      </svg>
    ),
  },
];

export function Interactive() {
  const [activeTabId, setActiveTabId] = useState('hosts');
  const [enabled, setEnabled] = useState(true);
  return (
    <div style={{ height: 400 }}>
      <SettingsSidebar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabChange={setActiveTabId}
        enabled={enabled}
        onEnabledChange={setEnabled}
      />
    </div>
  );
}

export function Disabled() {
  const [activeTabId, setActiveTabId] = useState('general');
  const [enabled, setEnabled] = useState(false);
  return (
    <div style={{ height: 400 }}>
      <SettingsSidebar
        tabs={tabs}
        activeTabId={activeTabId}
        onTabChange={setActiveTabId}
        enabled={enabled}
        onEnabledChange={setEnabled}
      />
    </div>
  );
}
