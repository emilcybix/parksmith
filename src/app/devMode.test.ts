import { afterEach, describe, expect, it, vi } from 'vitest';

const load = async (search: string | null, stored: Record<string, string> = {}) => {
  vi.resetModules();
  const data = new Map(Object.entries(stored));
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    removeItem: (key: string) => { data.delete(key); },
  };
  vi.stubGlobal('window', {
    localStorage: storage,
    location: { search: search ?? '' },
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  });
  const dev = await import('./devMode');
  const settings = await import('../settings/settingsStore');
  return { dev, settings, data };
};

afterEach(() => vi.unstubAllGlobals());

describe('DEVELOPER_MODE', () => {
  it('is off by default and follows the persisted setting', async () => {
    expect((await load(null)).dev.DEVELOPER_MODE).toBe(false);
    const stored = { 'parksmith-settings': JSON.stringify({ version: 1, developerTools: true }) };
    expect((await load(null, stored)).dev.DEVELOPER_MODE).toBe(true);
  });

  it('?dev=1 forces it on and applies to this session only and is never persisted; ?dev=0 forces it off', async () => {
    const on = await load('?dev=1');
    expect(on.dev.DEVELOPER_MODE).toBe(true);
    expect(on.dev.DEVELOPER_FORCED_BY_URL).toBe(true);
    expect(on.settings.getSettings().developerTools).toBe(false);
    expect(on.data.has('parksmith-settings')).toBe(false);
    const stored = { 'parksmith-settings': JSON.stringify({ version: 1, developerTools: true }) };
    const off = await load('?dev=0', stored);
    expect(off.dev.DEVELOPER_MODE).toBe(false);
    expect(off.settings.getSettings().developerTools).toBe(true);
  });

  it('imports the legacy parksmith-dev=1 flag once, through the settings migration', async () => {
    const { dev, data } = await load(null, { 'parksmith-dev': '1' });
    expect(dev.DEVELOPER_MODE).toBe(true);
    expect(JSON.parse(data.get('parksmith-settings') ?? '{}').developerTools).toBe(true);
  });

  it('a storage that throws gives false and never throws', async () => {
    vi.resetModules();
    vi.stubGlobal('window', {
      get localStorage(): never { throw new Error('blocked'); },
      location: { search: '' },
      addEventListener: () => undefined,
    });
    const dev = await import('./devMode');
    expect(dev.DEVELOPER_MODE).toBe(false);
  });
});
