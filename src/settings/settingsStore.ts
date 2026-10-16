import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  DEFAULT_SETTINGS,
  migrateStored,
  serializeSettings,
  SETTINGS_STORAGE_KEY,
  settingsEqual,
  settingValueEqual,
  validateSettings,
  type Settings,
} from './schema';

/** The slice of Storage the settings need. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface StorageEventLike {
  key: string | null;
  newValue: string | null;
}

/** Everything environmental, injected so the store is testable without a browser. */
export interface SettingsEnv {
  /** A getter: merely touching `window.localStorage` can throw (blocked site data). */
  storage: () => StorageLike | null;
  onStorageEvent: (listener: (event: StorageEventLike) => void) => () => void;
  osReducedMotion: () => boolean;
  onOsReducedMotionChange: (listener: (reduced: boolean) => void) => () => void;
}

export interface SettingsState {
  settings: Settings;
  /** 'unavailable' after any failed read or write: the panel says "Not saved in this browser". */
  persistence: 'ok' | 'unavailable';
  /** Validates, applies immediately (subscribers fire), then tries to persist. */
  update(patch: Partial<Settings>): void;
  /** Back to DEFAULT_SETTINGS. */
  reset(): void;
}

export type SettingsStore = StoreApi<SettingsState> & {
  /** Starts listening for other tabs' writes. Returns the stop function. Idempotent. */
  startSync(): () => void;
  dispose(): void;
};

/** The pre-settings developer flag; read once by the migration and never written again. */
export const LEGACY_DEV_FLAG_KEY = 'parksmith-dev';

const readLegacyDevFlag = (storage: StorageLike): boolean | null => {
  try {
    const value = storage.getItem(LEGACY_DEV_FLAG_KEY);
    return value === null ? null : value === '1';
  } catch {
    return null;
  }
};

interface LoadResult {
  settings: Settings;
  persistence: 'ok' | 'unavailable';
  needsWrite: boolean;
}

const parseStored = (text: string | null): unknown => {
  if (text === null) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return 0; // garbage: not a record, so the migration answers defaults and asks for a rewrite
  }
};

const load = (env: SettingsEnv): LoadResult => {
  let storage: StorageLike | null;
  try {
    storage = env.storage();
  } catch {
    storage = null;
  }
  if (storage === null) {
    return { settings: validateSettings(null), persistence: 'unavailable', needsWrite: false };
  }
  try {
    const raw = parseStored(storage.getItem(SETTINGS_STORAGE_KEY));
    const { settings, needsWrite } = migrateStored(raw, { devFlag: readLegacyDevFlag(storage) });
    return { settings, persistence: 'ok', needsWrite };
  } catch {
    return { settings: validateSettings(null), persistence: 'unavailable', needsWrite: false };
  }
};

export const createSettingsStore = (env: SettingsEnv): SettingsStore => {
  const loaded = load(env);
  let stopSync: (() => void) | null = null;

  const persist = (settings: Settings): 'ok' | 'unavailable' => {
    try {
      const storage = env.storage();
      if (storage === null) return 'unavailable';
      storage.setItem(SETTINGS_STORAGE_KEY, serializeSettings(settings));
      return 'ok';
    } catch {
      // Quota or blocked storage: the in-memory value still holds for this session.
      return 'unavailable';
    }
  };

  /** Keys changed here whose write failed: not on disk, so another tab's blob must not overwrite them. */
  const unsaved = new Set<keyof Settings>();
  const KEYS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

  const readRaw = (): string | null | undefined => {
    try {
      return env.storage()?.getItem(SETTINGS_STORAGE_KEY);
    } catch {
      return undefined;
    }
  };

  /** What storage holds right now (the cross-tab truth), or null when unreadable. */
  const readStored = (): Settings | null => {
    try {
      const storage = env.storage();
      if (storage === null) return null;
      return migrateStored(parseStored(storage.getItem(SETTINGS_STORAGE_KEY)), { devFlag: null }).settings;
    } catch {
      return null;
    }
  };

  const overlay = (base: Settings, source: Settings, keys: Iterable<keyof Settings>): Settings => {
    const merged = { ...base } as Record<string, unknown>;
    for (const key of keys) merged[key] = source[key];
    return merged as unknown as Settings;
  };

  const store = createStore<SettingsState>((set, get) => {
    /**
     * Per-key merge: the changed keys are laid over what storage holds NOW, so an edit made in
     * another tab to a different key is kept, not clobbered by this tab's stale whole blob.
     */
    const apply = (candidate: Settings, force = false): void => {
      const current = get().settings;
      const changed = force ? KEYS : KEYS.filter((key) => !settingValueEqual(key, current, candidate));
      if (changed.length === 0) return;
      const base = readStored() ?? current;
      const next = validateSettings(overlay(overlay(base, current, unsaved), candidate, changed));
      set({ settings: next });
      const result = persist(next);
      if (result === 'ok') unsaved.clear();
      else for (const key of changed) unsaved.add(key);
      set({ persistence: result });
    };
    return {
      settings: loaded.settings,
      persistence: loaded.persistence,
      update: (patch) => apply(validateSettings({ ...get().settings, ...patch })),
      // Forced: Reset must also clear a corrupt blob whose parsed value already equals the defaults.
      reset: () => apply(validateSettings(null), true),
    };
  });

  if (loaded.needsWrite && loaded.persistence === 'ok') {
    store.setState({ persistence: persist(loaded.settings) });
  }

  /**
   * Another tab wrote: adopt its blob without writing back (no ping-pong), keeping local keys whose
   * write failed. Writers merge per key against storage (see `apply`), so the blob carries every
   * tab's committed keys. Events are delivered late: when the event payload is no longer what
   * storage holds, a newer write (possibly this tab's own) has superseded it, so storage wins.
   */
  const adopt = (event: StorageEventLike): void => {
    if (event.key !== null && event.key !== SETTINGS_STORAGE_KEY) return;
    const current = store.getState().settings;
    const raw = readRaw();
    let incoming: Settings;
    if (event.key === null) incoming = load(env).settings;
    else if (typeof raw === 'string' && raw !== event.newValue) incoming = readStored() ?? current;
    else incoming = migrateStored(parseStored(event.newValue), { devFlag: null }).settings;
    const next = overlay(incoming, current, unsaved);
    if (!settingsEqual(current, next)) store.setState({ settings: next });
  };

  return Object.assign(store, {
    startSync: () => {
      if (stopSync === null) stopSync = env.onStorageEvent(adopt);
      return () => {
        stopSync?.();
        stopSync = null;
      };
    },
    dispose: () => {
      stopSync?.();
      stopSync = null;
    },
  });
};

/** The real environment. The media query list is created once and read as a cheap property. */
export const browserEnv = (): SettingsEnv => {
  let query: MediaQueryList | null | undefined;
  const mediaQuery = (): MediaQueryList | null => {
    if (query !== undefined) return query;
    try {
      query = typeof window !== 'undefined' && typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)')
        : null;
    } catch {
      query = null;
    }
    return query ?? null;
  };
  return {
    storage: () => {
      try {
        return typeof window === 'undefined' ? null : window.localStorage ?? null;
      } catch {
        return null;
      }
    },
    onStorageEvent: (listener) => {
      if (typeof window === 'undefined') return () => undefined;
      const handler = (event: StorageEvent): void => listener({ key: event.key, newValue: event.newValue });
      window.addEventListener('storage', handler);
      return () => window.removeEventListener('storage', handler);
    },
    osReducedMotion: () => mediaQuery()?.matches === true,
    onOsReducedMotionChange: (listener) => {
      const q = mediaQuery();
      if (q === null || typeof q.addEventListener !== 'function') return () => undefined;
      const handler = (event: { matches: boolean }): void => listener(event.matches === true);
      q.addEventListener('change', handler);
      return () => {
        try { q.removeEventListener('change', handler); } catch { /* nothing to release */ }
      };
    },
  };
};

export const settingsEnv: SettingsEnv = browserEnv();
/** The app-wide store. Loads synchronously at import, so first paint and DEVELOPER_MODE see it. */
export const settingsStore: SettingsStore = createSettingsStore(settingsEnv);

export const getSettings = (): Settings => settingsStore.getState().settings;
export const updateSettings = (patch: Partial<Settings>): void => settingsStore.getState().update(patch);
export const resetSettings = (): void => settingsStore.getState().reset();
/** Called once from main.tsx: keeps this tab in step with settings changed in another tab. */
export const startSettingsSync = (): (() => void) => settingsStore.startSync();
