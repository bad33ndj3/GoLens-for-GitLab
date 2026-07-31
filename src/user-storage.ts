import * as v from 'valibot';

import { commitSha, repositoryPath } from './domain.ts';

type Bindings = Record<string, string>;
type Preferences = Readonly<{
  enabled: boolean;
  hideGeneratedFiles: boolean;
  shortcutCoachEnabled: boolean;
  shortcutBindings: Readonly<Bindings>;
}>;
type StorageArea = {
  get(keys?: string | readonly string[] | Record<string, unknown> | null): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string | readonly string[]): Promise<void>;
};
type StorageChanges = {
  addListener(listener: (changes: Record<string, unknown>, area: string) => void): void;
  removeListener(listener: (changes: Record<string, unknown>, area: string) => void): void;
};

const BOOKMARK_PREFIX = 'golensBookmark:v1:';
const ONBOARDING_KEY = 'golensOnboardingVersion';
const LEARNING_KEY = 'golensShortcutCoach';
const CELEBRATION_KEY = 'golensCelebration';
const PREFERENCE_KEYS = new Set(['enabled', 'hideGeneratedFiles', 'shortcutCoachEnabled', 'shortcutBindings']);
const hash = v.pipe(v.string(), v.regex(/^(?:[0-9a-f]{64})?$/));
const bookmarkSchema = v.strictObject({
  version: v.literal(1),
  id: v.pipe(v.string(), v.minLength(1)),
  createdAt: v.pipe(v.number(), v.finite(), v.minValue(0)),
  scope: v.strictObject({
    origin: v.pipe(v.string(), v.url()),
    project: v.pipe(v.string(), v.minLength(1)),
    mergeRequest: v.pipe(v.string(), v.regex(/^\d+$/)),
    headSha: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/)),
  }),
  location: v.strictObject({
    path: v.pipe(v.string(), v.minLength(1)),
    side: v.picklist(['old', 'new']),
    startLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
    endLine: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  anchor: v.strictObject({
    symbol: v.pipe(v.string(), v.maxLength(160)),
    selectionHash: hash,
    beforeHash: hash,
    afterHash: hash,
  }),
});
const learningActionSchema = v.strictObject({
  manualUses: v.pipe(v.number(), v.integer(), v.minValue(0)),
  hintCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
  lastHintAt: v.pipe(v.number(), v.finite(), v.minValue(0)),
  lastShortcutUseAt: v.pipe(v.number(), v.finite(), v.minValue(0)),
  learned: v.boolean(),
});
const learningSchema = v.strictObject({
  version: v.literal(1),
  lastHintAt: v.pipe(v.number(), v.finite(), v.minValue(0)),
  actions: v.record(v.string(), learningActionSchema),
});
const celebrationSchema = v.strictObject({
  at: v.pipe(v.number(), v.finite(), v.minValue(0)),
  repositoryKey: v.pipe(v.string(), v.minLength(1)),
});

export type Bookmark = Readonly<v.InferOutput<typeof bookmarkSchema>>;
export type LearningState = Readonly<v.InferOutput<typeof learningSchema>>;
export type CelebrationState = Readonly<v.InferOutput<typeof celebrationSchema>>;

function parsed<T>(schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>, value: unknown): T | null {
  const result = v.safeParse(schema, value);
  return result.success ? result.output : null;
}

function freeze<T extends object>(value: T): Readonly<T> {
  return Object.freeze(value);
}

function bookmark(value: unknown): Bookmark | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const scope = raw.scope as Record<string, unknown> | undefined;
  const location = raw.location as Record<string, unknown> | undefined;
  const anchor = raw.anchor as Record<string, unknown> | undefined;
  let project;
  let headSha;
  let path;
  try {
    project = repositoryPath(scope?.project);
    headSha = commitSha(scope?.headSha);
    path = repositoryPath(location?.path);
  } catch {
    return null;
  }
  const candidate = {
    version: raw.version,
    id: typeof raw.id === 'string' ? raw.id.trim() : raw.id,
    createdAt: raw.createdAt,
    scope: {
      origin: typeof scope?.origin === 'string' ? scope.origin.trim() : scope?.origin,
      project,
      mergeRequest: String(scope?.mergeRequest || ''),
      headSha,
    },
    location: {
      path,
      side: location?.side,
      startLine: location?.startLine,
      endLine: location?.endLine ?? location?.startLine,
    },
    anchor: {
      symbol: typeof anchor?.symbol === 'string' ? anchor.symbol.trim().slice(0, 160) : '',
      selectionHash: typeof anchor?.selectionHash === 'string' ? anchor.selectionHash.toLowerCase() : '',
      beforeHash: typeof anchor?.beforeHash === 'string' ? anchor.beforeHash.toLowerCase() : '',
      afterHash: typeof anchor?.afterHash === 'string' ? anchor.afterHash.toLowerCase() : '',
    },
  };
  const record = parsed(bookmarkSchema, candidate);
  if (!record || record.location.endLine < record.location.startLine) return null;
  return freeze({ ...record, scope: freeze(record.scope), location: freeze(record.location), anchor: freeze(record.anchor) });
}

function bookmarkKey(record: Bookmark): string {
  return `${BOOKMARK_PREFIX}${encodeURIComponent(JSON.stringify([
    record.scope.origin, record.scope.project, record.scope.mergeRequest, record.scope.headSha, record.id,
  ]))}`;
}

export function createUserStorage({
  sync = chrome.storage.sync as StorageArea,
  local = chrome.storage.local as StorageArea,
  changes = chrome.storage.onChanged as StorageChanges,
  normalizeShortcutBindings,
  now = () => Date.now(),
  id = () => crypto.randomUUID(),
}: {
  sync?: StorageArea;
  local?: StorageArea;
  changes?: StorageChanges;
  normalizeShortcutBindings: (value: unknown) => Bindings;
  now?: () => number;
  id?: () => string;
}) {
  async function getPreferences(): Promise<Preferences> {
    try {
      const stored = await sync.get(null);
      return freeze({
        enabled: parsed(v.boolean(), stored.enabled) ?? true,
        hideGeneratedFiles: parsed(v.boolean(), stored.hideGeneratedFiles) ?? false,
        shortcutCoachEnabled: parsed(v.boolean(), stored.shortcutCoachEnabled) ?? true,
        shortcutBindings: freeze({ ...normalizeShortcutBindings(stored.shortcutBindings) }),
      });
    } catch {
      return freeze({ enabled: true, hideGeneratedFiles: false, shortcutCoachEnabled: true, shortcutBindings: freeze({ ...normalizeShortcutBindings(undefined) }) });
    }
  }

  const preferences = {
    get: getPreferences,
    async set(update: Partial<Preferences>): Promise<void> {
      const next: Record<string, unknown> = {};
      for (const key of ['enabled', 'hideGeneratedFiles', 'shortcutCoachEnabled'] as const) {
        if (typeof update[key] === 'boolean') next[key] = update[key];
      }
      if (update.shortcutBindings) next.shortcutBindings = { ...normalizeShortcutBindings(update.shortcutBindings) };
      if (Object.keys(next).length) await sync.set(next);
    },
    subscribe(listener: (value: Preferences) => void): () => void {
      const handle = (updated: Record<string, unknown>, area: string) => {
        if (area === 'sync' && Object.keys(updated).some((key) => PREFERENCE_KEYS.has(key))) void getPreferences().then(listener);
      };
      changes.addListener(handle);
      return () => changes.removeListener(handle);
    },
  };

  async function allBookmarks(): Promise<Bookmark[]> {
    try {
      const stored = await local.get(null);
      return Object.entries(stored).filter(([key]) => key.startsWith(BOOKMARK_PREFIX)).map(([, value]) => bookmark(value)).filter((value): value is Bookmark => Boolean(value));
    } catch {
      return [];
    }
  }

  const bookmarks = {
    async list(scope: { origin: string; project: string; mergeRequest: string }): Promise<readonly Bookmark[]> {
      return (await allBookmarks()).filter((record) => record.scope.origin === scope.origin && record.scope.project === scope.project && record.scope.mergeRequest === scope.mergeRequest)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));
    },
    async toggle(input: { scope: unknown; location: unknown; anchor?: unknown }): Promise<{ action: 'added' | 'removed'; record: Bookmark }> {
      const record = bookmark({ version: 1, id: id(), createdAt: now(), scope: input.scope, location: input.location, anchor: input.anchor || {} });
      if (!record) throw new TypeError('Invalid bookmark.');
      const existing = (await allBookmarks()).find((candidate) => candidate.scope.origin === record.scope.origin
        && candidate.scope.project === record.scope.project && candidate.scope.mergeRequest === record.scope.mergeRequest
        && candidate.scope.headSha === record.scope.headSha && candidate.location.path === record.location.path
        && candidate.location.side === record.location.side && candidate.location.startLine === record.location.startLine
        && candidate.location.endLine === record.location.endLine);
      if (existing) {
        await local.remove(bookmarkKey(existing));
        return { action: 'removed', record: existing };
      }
      await local.set({ [bookmarkKey(record)]: record });
      return { action: 'added', record };
    },
    async clear(scope: { origin: string; project: string; mergeRequest: string; headSha: string }, mode: 'all' | 'current' | 'stale' = 'all'): Promise<number> {
      const records = (await allBookmarks()).filter((record) => record.scope.origin === scope.origin
        && record.scope.project === scope.project && record.scope.mergeRequest === scope.mergeRequest
        && (mode === 'all' || (mode === 'current' ? record.scope.headSha === scope.headSha : record.scope.headSha !== scope.headSha)));
      if (records.length) await local.remove(records.map(bookmarkKey));
      return records.length;
    },
    async recover(previous: Bookmark, input: { scope: unknown; location: unknown; anchor?: unknown }): Promise<Bookmark> {
      const stale = bookmark(previous);
      const replacement = bookmark({ ...previous, scope: input.scope, location: input.location, anchor: input.anchor || {} });
      if (!stale || !replacement || stale.scope.origin !== replacement.scope.origin
        || stale.scope.project !== replacement.scope.project || stale.scope.mergeRequest !== replacement.scope.mergeRequest) {
        throw new TypeError('Invalid bookmark recovery.');
      }
      await local.set({ [bookmarkKey(replacement)]: replacement });
      await local.remove(bookmarkKey(stale));
      return replacement;
    },
  };

  const onboarding = {
    async get(): Promise<number> {
      try {
        const value = (await local.get(ONBOARDING_KEY))[ONBOARDING_KEY];
        return parsed(v.pipe(v.number(), v.integer(), v.minValue(0)), value) ?? 0;
      } catch { return 0; }
    },
    async set(version: number): Promise<void> {
      const valid = parsed(v.pipe(v.number(), v.integer(), v.minValue(0)), version);
      if (valid === null) throw new TypeError('Invalid onboarding version.');
      await local.set({ [ONBOARDING_KEY]: valid });
    },
  };

  const learning = {
    async get(): Promise<LearningState> {
      try {
        return freeze(parsed(learningSchema, (await local.get(LEARNING_KEY))[LEARNING_KEY]) || { version: 1, lastHintAt: 0, actions: {} });
      } catch { return freeze({ version: 1, lastHintAt: 0, actions: {} }); }
    },
    async set(state: LearningState): Promise<void> {
      const valid = parsed(learningSchema, state);
      if (!valid) throw new TypeError('Invalid shortcut learning state.');
      await local.set({ [LEARNING_KEY]: valid });
    },
  };

  const celebration = {
    async get(): Promise<CelebrationState | null> {
      try {
        const state = parsed(celebrationSchema, (await local.get(CELEBRATION_KEY))[CELEBRATION_KEY]);
        return state ? freeze(state) : null;
      } catch { return null; }
    },
    async set(state: CelebrationState): Promise<void> {
      const valid = parsed(celebrationSchema, state);
      if (!valid) throw new TypeError('Invalid celebration state.');
      await local.set({ [CELEBRATION_KEY]: valid });
    },
    clear: () => local.remove(CELEBRATION_KEY),
  };

  return { preferences, bookmarks, onboarding, learning, celebration };
}
