import { guideChapters } from './feature-catalog.ts';
import { createSelfHostedAccess } from './gitlab-host/index.ts';
import { ACTIONS, PRESETS, assignBinding, bindingForEvent, defaultBindings, mergeBindings, presetBindings, presetForBindings, type ShortcutPlatform } from './shortcuts.ts';
import { createUserStorage, ensureStorageReady } from './user-storage.ts';

type Preferences = Readonly<{ enabled: boolean; hideGeneratedFiles: boolean; shortcutCoachEnabled: boolean; shortcutBindings: Readonly<Record<string, string>> }>;
type PreferencePort = Readonly<{ get(): Promise<Preferences>; set(value: Partial<Preferences>): Promise<void>; subscribe(listener: (value: Preferences) => void): () => void }>;
type AccessPort = Readonly<{ list(): Promise<readonly string[]>; add(origin: string): Promise<void>; remove(pattern: string): Promise<void> }>;

const pageMeta: Record<string, [string, string]> = {
  general:   ['General', 'Choose how GoLens behaves across GitLab reviews.'],
  shortcuts: ['Keyboard shortcuts', 'Move through large diffs without leaving the keyboard.'],
  access:    ['GitLab access', 'Control which self-hosted GitLab origins can run GoLens.'],
  cache:     ['Source cache', 'Inspect and manage commit-pinned source stored in this browser.'],
  help:      ['Help', 'Open the complete feature guide whenever you need a refresher.'],
};

function formatBytes(bytes: number): string {
  if (!bytes) return 'Empty';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

async function activeRequest(type: string): Promise<any> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('Open a supported GitLab merge request.');
  const response = await chrome.tabs.sendMessage(tab.id, { type });
  if (!response?.ok) throw new Error(response?.error || 'The active GitLab tab did not respond.');
  return response.result;
}

function renderGuide(page: Document): void {
  const target = page.querySelector<HTMLElement>('[data-feature-guide]');
  if (!target) return;
  target.replaceChildren(...[...guideChapters()].map(([chapter, features]) => {
    const section = page.createElement('section');
    const title = page.createElement('h3');
    title.textContent = chapter;
    const list = page.createElement('ul');
    for (const feature of features) {
      const item = page.createElement('li');
      const name = page.createElement('strong');
      name.textContent = feature.title;
      item.append(name, ` — ${feature.summary}`);
      list.append(item);
    }
    section.append(title, list);
    return section;
  }));
}

export async function startSettingsEntry({
  document: page = globalThis.document,
  preferences = createUserStorage({ normalizeShortcutBindings: mergeBindings }).preferences as PreferencePort,
  request = activeRequest,
  ensureStorage = ensureStorageReady,
  access = createSelfHostedAccess() as AccessPort,
  confirmClear = () => true,
  close = () => page.defaultView?.parent.postMessage({ type: 'golens:settings:close' }, '*'),
}: { document?: Document; preferences?: PreferencePort; request?: (type: string) => Promise<any>; ensureStorage?: () => Promise<unknown>; access?: AccessPort; confirmClear?: () => boolean; close?: () => void } = {}): Promise<() => void> {
  const updateStatus = page.querySelector<HTMLElement>('[data-settings-status]');
  if (updateStatus) updateStatus.textContent = 'Finishing the GoLens update…';
  await ensureStorage();
  if (updateStatus) updateStatus.textContent = '';
  let current = await preferences.get();
  let bindings = mergeBindings(current.shortcutBindings);
  const platform: ShortcutPlatform = /Mac/.test(page.defaultView?.navigator.platform || '') ? 'mac' : 'other';
  const applyPreferences = (next: Preferences) => {
    current = next;
    page.querySelectorAll<HTMLInputElement>('[data-setting]').forEach((input) => { input.checked = Boolean(next[input.dataset.setting as keyof Preferences]); });
  };
  applyPreferences(current);
  page.querySelectorAll<HTMLInputElement>('[data-setting]').forEach((input) => input.addEventListener('change', () => {
    void preferences.set({ [input.dataset.setting!]: input.checked });
  }));
  const unsubscribe = preferences.subscribe((next) => { applyPreferences(next); bindings = mergeBindings(next.shortcutBindings); });

  const tabs = [...page.querySelectorAll<HTMLButtonElement>('[data-settings-tab]')];
  const showTab = (tab: HTMLButtonElement) => {
    for (const candidate of tabs) { const selected = candidate === tab; candidate.setAttribute('aria-selected', String(selected)); candidate.tabIndex = selected ? 0 : -1; }
    page.querySelectorAll<HTMLElement>('[data-settings-panel]').forEach((panel) => { panel.hidden = panel.dataset.settingsPanel !== tab.dataset.settingsTab; });
    const meta = pageMeta[tab.dataset.settingsTab!];
    if (meta) {
      const titleEl = page.querySelector('[data-page-title]');
      const descEl = page.querySelector('[data-page-description]');
      if (titleEl) titleEl.textContent = meta[0];
      if (descEl) descEl.textContent = meta[1];
    }
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => showTab(tab));
    tab.addEventListener('keydown', (event) => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (['ArrowRight', 'ArrowDown'].includes(event.key) ? 1 : -1) + tabs.length) % tabs.length;
      const nextTab = tabs[next]!;
      showTab(nextTab); nextTab.focus();
    });
  });

  const shortcutList = page.querySelector<HTMLElement>('[data-shortcut-list]');
  if (shortcutList) {
    const render = () => {
      shortcutList.replaceChildren(...ACTIONS.map((action) => {
        const row = page.createElement('div'); row.className = 'shortcut-row';
        const label = page.createElement('span'); label.textContent = action.label;
        const input = page.createElement('input'); input.className = 'shortcut-binding'; input.readOnly = true;
        input.value = bindings[action.id].replace('Primary', platform === 'mac' ? 'Command' : 'Ctrl'); input.setAttribute('aria-label', `${action.label} shortcut`);
        input.addEventListener('keydown', (event) => {
          event.preventDefault();
          if (event.key === 'Escape') { input.blur(); return; }
          const binding = ['Backspace', 'Delete'].includes(event.key) ? '' : bindingForEvent(event, platform);
          if (!binding && event.key !== 'Backspace' && event.key !== 'Delete') return;
          bindings = assignBinding(bindings, action.id, binding).bindings; void preferences.set({ shortcutBindings: bindings }); render();
        });
        const clear = page.createElement('button'); clear.type = 'button'; clear.textContent = '×'; clear.setAttribute('aria-label', `Clear ${action.label}`);
        clear.addEventListener('click', () => { bindings = assignBinding(bindings, action.id, '').bindings; void preferences.set({ shortcutBindings: bindings }); render(); });
        row.append(label, input, clear); return row;
      }));
    };
    const select = page.querySelector<HTMLSelectElement>('[data-shortcut-preset]');
    if (select) {
      select.replaceChildren(...PRESETS.map((preset) => { const option = page.createElement('option'); option.value = preset.id; option.textContent = `${preset.label} — ${preset.description}`; return option; }));
      select.value = presetForBindings(bindings) || 'golens';
      page.querySelector('[data-action="apply-shortcut-preset"]')?.addEventListener('click', () => { bindings = presetBindings(select.value) || bindings; void preferences.set({ shortcutBindings: bindings }); render(); });
    }
    page.querySelector('[data-action="reset-shortcuts"]')?.addEventListener('click', () => { bindings = defaultBindings(); void preferences.set({ shortcutBindings: bindings }); render(); });
    render();
  }

  const hostList = page.querySelector<HTMLElement>('[data-host-list]');
  const renderHosts = async () => {
    if (!hostList) return;
    const patterns = await access.list();
    hostList.replaceChildren(...patterns.map((pattern) => {
      const row = page.createElement('div'); const label = page.createElement('code'); label.textContent = new URL(pattern).origin;
      const remove = page.createElement('button'); remove.type = 'button'; remove.textContent = 'Remove'; remove.addEventListener('click', () => { void access.remove(pattern).then(renderHosts); });
      row.append(label, remove); return row;
    }));
  };
  const form = page.querySelector<HTMLFormElement>('[data-host-form]');
  const hostStatus = page.querySelector<HTMLElement>('[data-host-status]');
  form?.addEventListener('submit', (event) => { event.preventDefault(); const input = form.elements.namedItem('origin') as HTMLInputElement; void access.add(input.value).then(() => {
    input.value = ''; if (hostStatus) hostStatus.textContent = 'GitLab origin allowed.'; return renderHosts();
  }, (error: unknown) => { if (hostStatus) hostStatus.textContent = error instanceof Error ? error.message : 'GitLab origin could not be allowed.'; }); });
  await renderHosts();

  const cacheButton = page.querySelector<HTMLButtonElement>('[data-action="cache-full-project"]');
  const cacheProgress = page.querySelector<HTMLProgressElement>('[data-full-cache-progress]');
  const cacheProgressStatus = page.querySelector<HTMLElement>('[data-full-cache-status]');
  const renderCache = (state: any) => {
    const output = page.querySelector<HTMLOutputElement>('[data-cache-size]'); if (output) output.textContent = formatBytes(Number(state?.cache?.bytes || 0));
    const busy = Boolean(state?.progress) && !state?.fullProject;
    if (cacheButton) { cacheButton.disabled = busy || Boolean(state?.fullProject); cacheButton.textContent = state?.fullProject ? 'Full project cached' : busy ? 'Caching full project…' : 'Cache full project'; }
    if (cacheProgressStatus) cacheProgressStatus.textContent = state?.fullProject ? 'Cached' : busy ? `Caching: ${state.progress.phase}…` : 'Not cached';
    if (cacheProgress) {
      const total = Number(state?.progress?.total || 0);
      cacheProgress.hidden = !busy;
      if (total) cacheProgress.value = Math.min(100, Math.round(Number(state.progress.completed || 0) / total * 100));
      else cacheProgress.removeAttribute('value');
    }
  };
  try { renderCache(await request('golens:rewrite:state')); } catch { renderCache({}); }
  cacheButton?.addEventListener('click', () => {
    cacheButton.disabled = true;
    const poll = setInterval(() => { void request('golens:rewrite:state').then(renderCache, () => {}); }, 250);
    void request('golens:rewrite:cache-full-project').then((result) => renderCache({ active: true, fullProject: result?.outcome?.status === 'ready', cache: result?.cache }), () => renderCache({})).finally(() => clearInterval(poll));
  });
  page.querySelector('[data-action="clear-cache"]')?.addEventListener('click', () => {
    if (!confirmClear()) return;
    const status = page.querySelector<HTMLElement>('[data-cache-status]');
    void request('golens:rewrite:clear-cache').then((result) => { renderCache(result); if (status) status.textContent = 'Source cache cleared.'; });
  });
  page.querySelector('[data-action="show-onboarding"]')?.addEventListener('click', () => {
    const status = page.querySelector<HTMLElement>('[data-onboarding-status]');
    void request('golens:rewrite:show-guide').catch((error) => { if (status) status.textContent = error instanceof Error ? error.message : 'Open a supported GitLab merge request first.'; });
  });
  page.querySelector('[data-action="close-settings"]')?.addEventListener('click', close);
  page.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { close(); return; }
    if (event.key !== 'Tab') return;
    const focusable = [...page.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),a[href]')].filter((element) => !element.closest('[hidden]'));
    const first = focusable[0]; const last = focusable[focusable.length - 1];
    if (event.shiftKey && page.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && page.activeElement === last) { event.preventDefault(); first?.focus(); }
  });
  renderGuide(page);
  page.documentElement.dataset.golensRewriteSettings = 'ready';
  return unsubscribe;
}

if (typeof chrome !== 'undefined' && typeof document !== 'undefined' && location.pathname.endsWith('/settings.html')) void startSettingsEntry({ confirmClear: () => globalThis.confirm('Clear all cached GitLab source snapshots?') });
