import { mergeBindings } from './shortcuts.ts';
import { createUserStorage } from './user-storage.ts';
import { ensureStorageReady } from './storage-reset.ts';

type PreferencePort = Readonly<{
  get(): Promise<{ enabled: boolean }>;
  set(value: { enabled?: boolean }): Promise<void>;
  subscribe(listener: (value: { enabled: boolean }) => void): () => void;
}>;

export function formatBytes(bytes: number): string {
  if (!bytes) return 'Empty';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

async function defaultRequest(type: string): Promise<unknown> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('Open a supported GitLab merge request.');
  const response = await chrome.tabs.sendMessage(tab.id, { type });
  if (!response?.ok) throw new Error(response?.error || 'The active GitLab tab did not respond.');
  return response.result;
}

export async function startPopupEntry({
  document: page = globalThis.document,
  preferences = createUserStorage({ normalizeShortcutBindings: mergeBindings }).preferences as PreferencePort,
  request = defaultRequest,
  ensureStorage = ensureStorageReady,
  close = () => globalThis.close(),
}: { document?: Document; preferences?: PreferencePort; request?: (type: string) => Promise<any>; ensureStorage?: () => Promise<unknown>; close?: () => void } = {}): Promise<() => void> {
  const updateStatus = page.querySelector<HTMLElement>('[data-settings-status]');
  if (updateStatus) updateStatus.textContent = 'Finishing the GoLens update…';
  await ensureStorage();
  if (updateStatus) updateStatus.textContent = '';
  const enabled = page.querySelector<HTMLInputElement>('[data-setting="enabled"]');
  const cacheButton = page.querySelector<HTMLButtonElement>('[data-action="cache-full-project"]');
  const settingsButton = page.querySelector<HTMLButtonElement>('[data-action="show-settings"]');
  const cacheSize = page.querySelector<HTMLOutputElement>('[data-cache-size]');
  const cacheStatus = page.querySelector<HTMLElement>('[data-full-cache-status]');
  const progress = page.querySelector<HTMLProgressElement>('[data-full-cache-progress]');
  const context = page.querySelector<HTMLElement>('[data-page-context]');
  const status = updateStatus;
  if (enabled) {
    enabled.checked = (await preferences.get()).enabled;
    enabled.addEventListener('change', () => { void preferences.set({ enabled: enabled.checked }); });
  }
  const unsubscribe = preferences.subscribe((next) => { if (enabled) enabled.checked = next.enabled; });
  const renderState = (state: any) => {
    if (cacheSize) cacheSize.textContent = formatBytes(Number(state?.cache?.bytes || 0));
    if (context) context.textContent = state?.active ? 'Active MR' : 'No active MR';
    if (cacheButton) { cacheButton.disabled = !state?.active || state?.fullProject; cacheButton.textContent = state?.fullProject ? 'Full project cached' : 'Cache full project'; }
    if (cacheStatus) cacheStatus.textContent = state?.active ? state?.fullProject ? 'Full-project results are ready.' : 'Full-project results are not cached yet.' : 'Open a supported GitLab merge request.';
    if (progress) {
      const total = Number(state?.progress?.total || 0);
      progress.hidden = !state?.progress || state?.fullProject;
      if (total) progress.value = Math.min(100, Math.round(Number(state.progress.completed || 0) / total * 100));
      else progress.removeAttribute('value');
    }
  };
  try { renderState(await request('golens:rewrite:state')); } catch { renderState({ active: false, cache: { bytes: 0 } }); }
  cacheButton?.addEventListener('click', () => {
    cacheButton.disabled = true;
    if (cacheStatus) cacheStatus.textContent = 'Caching full project…';
    const poll = setInterval(() => { void request('golens:rewrite:state').then(renderState, () => {}); }, 250);
    void request('golens:rewrite:cache-full-project').then((result) => renderState({ active: true, fullProject: result?.outcome?.status === 'ready', cache: result?.cache }), (error) => {
      cacheButton.disabled = false;
      if (cacheStatus) cacheStatus.textContent = error instanceof Error ? error.message : 'Unable to cache the full project.';
    }).finally(() => clearInterval(poll));
  });
  settingsButton?.addEventListener('click', () => {
    settingsButton.disabled = true;
    void request('golens:rewrite:open-settings').then(close, (error) => {
      settingsButton.disabled = false;
      if (status) status.textContent = error instanceof Error ? error.message : 'Open a supported GitLab page first.';
    });
  });
  page.documentElement.dataset.golensRewritePopup = 'ready';
  return unsubscribe;
}

if (typeof chrome !== 'undefined' && typeof document !== 'undefined' && location.pathname.endsWith('/popup.html')) void startPopupEntry();
