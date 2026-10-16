import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, SETTINGS_VERSION } from './schema';
import { createSettingsStore, type SettingsEnv, type StorageEventLike, type StorageLike } from './settingsStore';

interface FakeEnv extends SettingsEnv {
  data: Map<string, string>;
  writes: number;
  fail: { read: boolean; write: boolean; access: boolean };
  emit(event: StorageEventLike): void;
  listeners: number;
  os: { reduced: boolean };
  emitOs(reduced: boolean): void;
}

export const fakeEnv = (initial: Record<string, string> = {}): FakeEnv => {
  const data = new Map(Object.entries(initial));
  const listeners = new Set<(event: StorageEventLike) => void>();
  const osListeners = new Set<(reduced: boolean) => void>();
  const env: FakeEnv = {
    data,
    writes: 0,
    fail: { read: false, write: false, access: false },
    os: { reduced: false },
    get listeners() { return listeners.size; },
    storage: (): StorageLike | null => {
      if (env.fail.access) throw new Error('blocked');
      return {
        getItem: (key) => {
          if (env.fail.read) throw new Error('read');
          return data.get(key) ?? null;
        },
        setItem: (key, value) => {
          if (env.fail.write) throw new Error('QuotaExceededError');
          env.writes += 1;
          data.set(key, value);
        },
        removeItem: (key) => { data.delete(key); },
      };
    },
    onStorageEvent: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    osReducedMotion: () => env.os.reduced,
    onOsReducedMotionChange: (listener) => {
      osListeners.add(listener);
      return () => { osListeners.delete(listener); };
    },
    emit: (event) => { for (const listener of [...listeners]) listener(event); },
    emitOs: (reduced) => {
      env.os.reduced = reduced;
      for (const listener of [...osListeners]) listener(reduced);
    },
  };
  return env;
};

const stored = (patch: object) => ({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ version: 1, ...patch }) });

describe('settings store: loading', () => {
  it('loads defaults from an empty storage without writing', () => {
    const env = fakeEnv();
    const store = createSettingsStore(env);
    expect(store.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(store.getState().persistence).toBe('ok');
    expect(env.writes).toBe(0);
  });

  it('loads and validates a stored blob', () => {
    const store = createSettingsStore(fakeEnv(stored({ uiScale: 85, notifications: 'nope' })));
    expect(store.getState().settings).toEqual({ ...DEFAULT_SETTINGS, uiScale: 85 });
  });

  it('survives a storage getter that throws, a null storage and a throwing getItem', () => {
    const blocked = fakeEnv();
    blocked.fail.access = true;
    expect(createSettingsStore(blocked).getState()).toMatchObject({ settings: DEFAULT_SETTINGS, persistence: 'unavailable' });
    const none = { ...fakeEnv(), storage: () => null };
    expect(createSettingsStore(none).getState().persistence).toBe('unavailable');
    const reading = fakeEnv();
    reading.fail.read = true;
    expect(createSettingsStore(reading).getState()).toMatchObject({ settings: DEFAULT_SETTINGS, persistence: 'unavailable' });
  });

  it('garbage JSON gives defaults and is repaired on load', () => {
    const env = fakeEnv({ [SETTINGS_STORAGE_KEY]: '{not json' });
    const store = createSettingsStore(env);
    expect(store.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(store.getState().persistence).toBe('ok');
    expect(JSON.parse(env.data.get(SETTINGS_STORAGE_KEY) ?? 'null').version).toBe(SETTINGS_VERSION);
  });

  it('imports the legacy dev flag once', () => {
    const env = fakeEnv({ 'parksmith-dev': '1' });
    const store = createSettingsStore(env);
    expect(store.getState().settings.developerTools).toBe(true);
    expect(JSON.parse(env.data.get(SETTINGS_STORAGE_KEY) ?? '{}').developerTools).toBe(true);
    expect(env.data.get('parksmith-dev')).toBe('1');
  });

  it('a newer-version blob is not rewritten by loading', () => {
    const env = fakeEnv({ [SETTINGS_STORAGE_KEY]: JSON.stringify({ version: 9, uiScale: 130 }) });
    const store = createSettingsStore(env);
    expect(store.getState().settings.uiScale).toBe(130);
    expect(env.writes).toBe(0);
  });
});

describe('settings store: update, reset', () => {
  it('applies immediately, notifies, and persists the versioned blob', () => {
    const env = fakeEnv();
    const store = createSettingsStore(env);
    const seen: number[] = [];
    store.subscribe((state) => seen.push(state.settings.uiScale));
    store.getState().update({ uiScale: 115 });
    expect(store.getState().settings.uiScale).toBe(115);
    expect(seen).toContain(115);
    expect(JSON.parse(env.data.get(SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({ version: SETTINGS_VERSION, uiScale: 115 });
  });

  it('validates the patch: a bad value is ignored and nothing is written', () => {
    const env = fakeEnv();
    const store = createSettingsStore(env);
    store.getState().update({ uiScale: 999 as never });
    expect(store.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(env.writes).toBe(0);
  });

  it('an equal patch does not notify or write', () => {
    const env = fakeEnv();
    const store = createSettingsStore(env);
    let calls = 0;
    store.subscribe(() => { calls += 1; });
    store.getState().update({ uiScale: 100 });
    store.getState().update({});
    expect(calls).toBe(0);
    expect(env.writes).toBe(0);
  });

  it('a quota error keeps the value in memory, flags persistence, and a later write recovers', () => {
    const env = fakeEnv();
    const store = createSettingsStore(env);
    env.fail.write = true;
    store.getState().update({ uiScale: 85 });
    expect(store.getState().settings.uiScale).toBe(85);
    expect(store.getState().persistence).toBe('unavailable');
    env.fail.write = false;
    store.getState().update({ uiScale: 115 });
    expect(store.getState().persistence).toBe('ok');
    expect(JSON.parse(env.data.get(SETTINGS_STORAGE_KEY) ?? '{}').uiScale).toBe(115);
  });

  it('works with storage blocked entirely', () => {
    const env = fakeEnv();
    env.fail.access = true;
    const store = createSettingsStore(env);
    store.getState().update({ notifications: 'minimal' });
    expect(store.getState().settings.notifications).toBe('minimal');
    expect(store.getState().persistence).toBe('unavailable');
  });

  it('reset restores the defaults and persists them', () => {
    const env = fakeEnv(stored({ uiScale: 85, autosaveMinutes: 0 }));
    const store = createSettingsStore(env);
    store.getState().reset();
    expect(store.getState().settings).toEqual(DEFAULT_SETTINGS);
    expect(JSON.parse(env.data.get(SETTINGS_STORAGE_KEY) ?? '{}').uiScale).toBe(100);
  });
});

describe('settings store: cross-tab', () => {
  it('adopts another tab\'s write without writing back', () => {
    const env = fakeEnv();
    const store = createSettingsStore(env);
    store.startSync();
    env.emit({ key: SETTINGS_STORAGE_KEY, newValue: JSON.stringify({ version: 1, uiScale: 130, weatherEffects: 'reduced' }) });
    expect(store.getState().settings).toMatchObject({ uiScale: 130, weatherEffects: 'reduced' });
    expect(env.writes).toBe(0);
  });

  it('ignores other keys, tolerates garbage, and treats a removed key as defaults', () => {
    const env = fakeEnv();
    const store = createSettingsStore(env);
    store.startSync();
    store.getState().update({ uiScale: 85 });
    env.emit({ key: 'other', newValue: '{}' });
    expect(store.getState().settings.uiScale).toBe(85);
    env.data.set(SETTINGS_STORAGE_KEY, '{garbage'); // a real event always mirrors what storage now holds
    env.emit({ key: SETTINGS_STORAGE_KEY, newValue: '{garbage' });
    expect(store.getState().settings).toEqual(DEFAULT_SETTINGS);
    store.getState().update({ uiScale: 85 });
    env.data.delete(SETTINGS_STORAGE_KEY);
    env.emit({ key: SETTINGS_STORAGE_KEY, newValue: null });
    expect(store.getState().settings).toEqual(DEFAULT_SETTINGS);
  });

  it('key === null (storage cleared) re-reads storage', () => {
    const env = fakeEnv();
    const store = createSettingsStore(env);
    store.startSync();
    store.getState().update({ uiScale: 85 });
    env.data.clear();
    env.emit({ key: null, newValue: null });
    expect(store.getState().settings).toEqual(DEFAULT_SETTINGS);
  });

  it('startSync is idempotent and dispose removes the listener', () => {
    const env = fakeEnv();
    const store = createSettingsStore(env);
    store.startSync();
    store.startSync();
    expect(env.listeners).toBe(1);
    store.dispose();
    expect(env.listeners).toBe(0);
    env.emit({ key: SETTINGS_STORAGE_KEY, newValue: JSON.stringify({ version: 1, uiScale: 130 }) });
    expect(store.getState().settings.uiScale).toBe(100);
  });
});

describe('settings store: keybindings', () => {
  it('persists a binding, reloads it, and does not rewrite an unchanged equal value', () => {
    const env = fakeEnv();
    const store = createSettingsStore(env);
    store.getState().update({ keybindings: { toggleGrid: 'k:j' } });
    expect(store.getState().settings.keybindings).toEqual({ toggleGrid: 'k:j' });
    expect(JSON.parse(env.data.get(SETTINGS_STORAGE_KEY) ?? '{}').keybindings).toEqual({ toggleGrid: 'k:j' });
    const writes = env.writes;
    store.getState().update({ keybindings: { toggleGrid: 'k:j' } });
    expect(env.writes, 'an equal keybindings object is not a change').toBe(writes);
    expect(createSettingsStore(env).getState().settings.keybindings).toEqual({ toggleGrid: 'k:j' });
  });

  it('validates what update is given: a conflict or a reserved key is dropped', () => {
    const store = createSettingsStore(fakeEnv());
    store.getState().update({ keybindings: { toggleGrid: 'k:h', speed1: 'c:Tab' } });
    // h is Clean view's key (clash) and Tab is reserved: both entries are dropped.
    expect(store.getState().settings.keybindings).toEqual({});
  });

  it('reset clears the bindings with everything else', () => {
    const store = createSettingsStore(fakeEnv());
    store.getState().update({ keybindings: { bulldozer: 'k:j' }, uiScale: 85 });
    store.getState().reset();
    expect(store.getState().settings).toEqual(DEFAULT_SETTINGS);
  });

  it('adopts another tab\'s bindings without writing back', () => {
    const env = fakeEnv();
    const store = createSettingsStore(env);
    store.startSync();
    const writes = env.writes;
    env.emit({ key: SETTINGS_STORAGE_KEY, newValue: JSON.stringify({ version: SETTINGS_VERSION, keybindings: { peek: 'k:n' } }) });
    expect(store.getState().settings.keybindings).toEqual({ peek: 'k:n' });
    expect(env.writes).toBe(writes);
  });
});
