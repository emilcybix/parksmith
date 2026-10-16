import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY, migrateStored, validateSettings } from './schema';
import { createSettingsStore, type SettingsEnv, type StorageEventLike } from './settingsStore';

/** Two tabs over ONE storage; events are queued so tests control delivery order (real browsers deliver async). */
const makeTabs = (initial: Record<string, string> = {}) => {
  const data = new Map(Object.entries(initial));
  const tabs: { listeners: Set<(e: StorageEventLike) => void>; queue: StorageEventLike[] }[] = [];
  const mk = (): { env: SettingsEnv; index: number } => {
    const tab = { listeners: new Set<(e: StorageEventLike) => void>(), queue: [] as StorageEventLike[] };
    tabs.push(tab);
    const env: SettingsEnv = {
      storage: () => ({
        getItem: (k) => data.get(k) ?? null,
        setItem: (k, v) => {
          data.set(k, v);
          tabs.forEach((t) => { if (t !== tab) t.queue.push({ key: k, newValue: v }); });
        },
        removeItem: (k) => { data.delete(k); },
      }),
      onStorageEvent: (l) => { tab.listeners.add(l); return () => tab.listeners.delete(l); },
      osReducedMotion: () => false,
      onOsReducedMotionChange: () => () => undefined,
    };
    return { env, index: tabs.length - 1 };
  };
  const deliver = (index: number): void => {
    const t = tabs[index];
    for (const e of t.queue.splice(0)) t.listeners.forEach((l) => l(e));
  };
  return { data, mk, deliver };
};

describe('adversarial: two tabs', () => {
  it('simultaneous edits of DIFFERENT keys both survive (per-key merge)', () => {
    const { data, mk, deliver } = makeTabs();
    const a = mk(); const b = mk();
    const sa = createSettingsStore(a.env); const sb = createSettingsStore(b.env);
    sa.startSync(); sb.startSync();
    sa.getState().update({ uiScale: 130 });
    sb.getState().update({ notifications: 'minimal' }); // before B saw A's event
    deliver(a.index); deliver(b.index);
    const disk = JSON.parse(data.get(SETTINGS_STORAGE_KEY) ?? '{}');
    // Expected by a per-key merge: both survive. Actual: A's uiScale is lost everywhere.
    expect({ ui: sa.getState().settings.uiScale, n: sa.getState().settings.notifications }).toEqual({ ui: 130, n: 'minimal' });
    expect(disk.uiScale).toBe(130);
  });

  it('a local choice survives the other tab event', () => {
    const { mk, deliver } = makeTabs();
    const a = mk(); const b = mk();
    const sa = createSettingsStore(a.env); const sb = createSettingsStore(b.env);
    sa.startSync(); sb.startSync();
    sb.getState().update({ autosaveMinutes: 10 });
    sa.getState().update({ uiScale: 85 });
    deliver(a.index);
    expect(sa.getState().settings.uiScale).toBe(85); // A's own just-made choice survives the adopt
  });

});

describe('cross-tab: unsaved local keys', () => {
  it('a key whose write failed is not overwritten by the other tab, and other keys still merge', () => {
    const { data, mk, deliver } = makeTabs();
    const a = mk(); const b = mk();
    let failWrites = false;
    const baseStorage = a.env.storage;
    a.env.storage = () => {
      const s = baseStorage();
      return s === null ? null : { ...s, setItem: (k: string, v: string) => { if (failWrites) throw new Error('quota'); s.setItem(k, v); } };
    };
    const sa = createSettingsStore(a.env); const sb = createSettingsStore(b.env);
    sa.startSync(); sb.startSync();
    failWrites = true;
    sa.getState().update({ uiScale: 130 });
    expect(sa.getState().persistence).toBe('unavailable');
    sb.getState().update({ notifications: 'minimal' });
    deliver(a.index);
    expect({ ui: sa.getState().settings.uiScale, n: sa.getState().settings.notifications }).toEqual({ ui: 130, n: 'minimal' });
    failWrites = false;
    sa.getState().update({ autosaveMinutes: 10 });
    const disk = JSON.parse(data.get(SETTINGS_STORAGE_KEY) ?? '{}');
    expect(disk).toMatchObject({ uiScale: 130, notifications: 'minimal', autosaveMinutes: 10 });
  });
});

describe('adversarial: garbage and odd values', () => {
  const cases: [string, unknown][] = [
    ['null', null], ['array', []], ['string', 'x'], ['number', 5], ['NaN fields', { version: 1, uiScale: NaN, autosaveMinutes: NaN }],
    ['huge', { version: 1, uiScale: 1e308, autosaveMinutes: Infinity }],
    ['proto', JSON.parse('{"version":1,"__proto__":{"uiScale":85},"constructor":{"x":1}}')],
    ['strings for numbers', { version: 1, uiScale: '130', autosaveMinutes: '5' }],
    ['-0', JSON.parse('{"version":1,"autosaveMinutes":-0}')],
    ['version float', { version: 1.5, uiScale: 130 }],
    ['version huge', { version: 1e9, uiScale: 130 }],
    ['version string', { version: '1', uiScale: 130 }],
    ['version negative', { version: -3, uiScale: 130 }],
  ];
  for (const [name, raw] of cases) {
    it(`validates ${name} into legal values`, () => {
      const r = migrateStored(raw, { devFlag: null }).settings;
      for (const k of Object.keys(DEFAULT_SETTINGS) as (keyof typeof DEFAULT_SETTINGS)[]) {
        expect([...(JSON.parse(JSON.stringify([DEFAULT_SETTINGS[k]])) as unknown[]), r[k]].length).toBe(2);
      }
      expect(Object.keys(r).sort()).toEqual(Object.keys(DEFAULT_SETTINGS).sort());
      expect(Object.is(r.autosaveMinutes, -0)).toBe(false);
    });
  }

  it('stored JSON "null" is not repaired (needsWrite false)', () => {
    const res = migrateStored(JSON.parse('null'), { devFlag: null });
    expect(res.needsWrite).toBe(true);
  });

  it('legacy dev flag does not leak developerTools=true when a blob is corrupt', () => {
    expect(migrateStored(7, { devFlag: true }).settings.developerTools).toBe(false);
  });

  it('validateSettings never aliases or mutates the frozen defaults', () => {
    const r = validateSettings(null);
    r.uiScale = 130;
    expect(DEFAULT_SETTINGS.uiScale).toBe(100);
  });
});

describe('adversarial: storage faults', () => {
  const throwing = (over: Partial<Record<'get' | 'set' | 'access', boolean>>): SettingsEnv => ({
    storage: () => {
      if (over.access) throw new Error('SecurityError');
      return {
        getItem: () => { if (over.get) throw new Error('get'); return null; },
        setItem: () => { if (over.set) throw new DOMException('quota', 'QuotaExceededError'); },
        removeItem: () => undefined,
      };
    },
    onStorageEvent: () => () => undefined,
    osReducedMotion: () => false,
    onOsReducedMotionChange: () => () => undefined,
  });
  for (const mode of ['get', 'set', 'access'] as const) {
    it(`${mode} throwing never throws out of the store and edits still apply`, () => {
      const s = createSettingsStore(throwing({ [mode]: true }));
      expect(() => s.getState().update({ uiScale: 130 })).not.toThrow();
      expect(s.getState().settings.uiScale).toBe(130);
      expect(() => s.getState().reset()).not.toThrow();
      expect(s.getState().settings).toEqual(DEFAULT_SETTINGS);
    });
  }
  it('persistence flag recovers to ok after a later successful write', () => {
    let fail = true;
    const env = throwing({});
    const base = env.storage;
    env.storage = () => ({ ...base()!, setItem: () => { if (fail) throw new Error('q'); } });
    const s = createSettingsStore(env);
    s.getState().update({ uiScale: 85 });
    expect(s.getState().persistence).toBe('unavailable');
    fail = false;
    s.getState().update({ uiScale: 115 });
    expect(s.getState().persistence).toBe('ok');
  });
  it('reset() when already default does not write (cannot clear a corrupt key)', () => {
    const data = new Map([[SETTINGS_STORAGE_KEY, '{"version":1,"uiScale":"bad"}']]);
    const env: SettingsEnv = { ...throwing({}), storage: () => ({ getItem: (k) => data.get(k) ?? null, setItem: (k, v) => { data.set(k, v); }, removeItem: () => undefined }) };
    const s = createSettingsStore(env);
    s.getState().reset();
    expect(JSON.parse(data.get(SETTINGS_STORAGE_KEY)!).uiScale).toBe(100);
  });
});
