export const ARCHITECTURE_EPOCH = 1;
export const ACTIVE_ARCHITECTURE_EPOCH: number | null = null;

const EPOCH_KEY = 'golensArchitectureEpoch';
const RESETTING_KEY = 'golensArchitectureResetting';
const NOTICE_KEY = 'golensUpgradeNoticePending';

type StorageArea = Readonly<{
  get(keys?: string | readonly string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  clear(): Promise<void>;
}>;

export type StorageResetState = Readonly<{
  status: 'inactive' | 'ready' | 'reset';
  upgradeNoticePending: boolean;
}>;

export function createStorageResetCoordinator({ epoch, sync, local, clearCache }: {
  epoch: number | null;
  sync: StorageArea;
  local: StorageArea;
  clearCache(): Promise<unknown>;
}) {
  let running: Promise<StorageResetState> | null = null;

  const ensure = (): Promise<StorageResetState> => {
    if (epoch === null) return Promise.resolve({ status: 'inactive', upgradeNoticePending: false });
    if (running) return running;
    running = (async () => {
      const stored = await local.get(null);
      if (stored[EPOCH_KEY] === epoch && stored[RESETTING_KEY] !== true) {
        return { status: 'ready', upgradeNoticePending: stored[NOTICE_KEY] === true } as const;
      }
      await local.set({ [RESETTING_KEY]: true });
      await sync.clear();
      await clearCache();
      await local.clear();
      await local.set({ [EPOCH_KEY]: epoch, [NOTICE_KEY]: true });
      return { status: 'reset', upgradeNoticePending: true } as const;
    })().finally(() => { running = null; });
    return running;
  };

  return Object.freeze({
    ensure,
    async acknowledgeUpgradeNotice(): Promise<void> {
      const state = await ensure();
      if (state.status !== 'inactive' && state.upgradeNoticePending) await local.set({ [NOTICE_KEY]: false });
    },
  });
}

type Runtime = Pick<typeof chrome.runtime, 'sendMessage'>;

export async function ensureStorageReady(runtime: Runtime = chrome.runtime): Promise<StorageResetState> {
  const response = await runtime.sendMessage({ type: 'golens:rewrite:ensure-storage' }) as { ok?: boolean; value?: StorageResetState; error?: string };
  if (!response?.ok || !response.value) throw new Error(response?.error || 'GoLens storage reset failed.');
  return response.value;
}

export async function acknowledgeUpgradeNotice(runtime: Runtime = chrome.runtime): Promise<void> {
  const response = await runtime.sendMessage({ type: 'golens:rewrite:acknowledge-upgrade' }) as { ok?: boolean; error?: string };
  if (!response?.ok) throw new Error(response?.error || 'GoLens upgrade acknowledgement failed.');
}
