import { describe, expect, it } from 'vitest';
import { PAYLOADS_STORE_NAME, SAVE_DB_NAME } from './constants';
import { createSaveStore } from './createSaveStore';
import { asIdbFactory, createFakeIndexedDb, makeSlotMeta } from './fakeIndexedDb.storeSupport';
import { MemorySaveStore } from './memorySaveStore';
import type { SaveSlotId } from './types';

describe('createSaveStore: choosing a backend', () => {
  it('uses IndexedDB when it opens', async () => {
    const fake = createFakeIndexedDb();
    const store = createSaveStore({ factory: asIdbFactory(fake) });
    expect(await store.init(), 'ready').toEqual({ state: 'ready' });
    expect(store.backend(), 'backend').toBe('indexeddb');
    await store.write('manual-1', { n: 1 }, makeSlotMeta('manual-1'));
    expect(fake.peek(SAVE_DB_NAME, PAYLOADS_STORE_NAME).size, 'really in IndexedDB').toBe(1);
  });

  it('falls back to memory with the reason when IndexedDB is missing, and still saves in memory', async () => {
    const store = createSaveStore({ factory: null });
    const status = await store.init();
    expect(status, 'reason reported').toMatchObject({ state: 'unavailable', code: 'unavailable' });
    expect(store.backend(), 'memory-only').toBe('memory-only');
    await store.write('manual-1', { n: 1 }, makeSlotMeta('manual-1'));
    expect((await store.read('manual-1')).payload, 'the session can still save in memory').toEqual({ n: 1 });
    expect((await store.list()).length, 'and list it').toBe(1);
  });

  it.each([
    ['SecurityError thrown by open', { kind: 'throw', errorName: 'SecurityError' } as const],
    ['an open error event', { kind: 'error', errorName: 'UnknownError' } as const],
  ])('falls back to memory on %s', async (_label, fault) => {
    const fake = createFakeIndexedDb();
    fake.injectOpenFault(fault);
    const store = createSaveStore({ factory: asIdbFactory(fake) });
    expect((await store.init()).state, 'unavailable').toBe('unavailable');
    expect(store.backend(), 'memory-only').toBe('memory-only');
  });

  it('falls back with code blocked when an old tab holds the database', async () => {
    const fake = createFakeIndexedDb();
    const oldTab = createSaveStore({ factory: asIdbFactory(fake) });
    await oldTab.init();
    fake.connection(0)!.onversionchange = null;
    const store = createSaveStore({ factory: asIdbFactory(fake), version: 2 });
    expect(await store.init(), 'blocked').toMatchObject({ state: 'unavailable', code: 'blocked' });
    expect(store.backend(), 'memory-only meanwhile').toBe('memory-only');
  });
});

describe('createSaveStore: retry and migration', () => {
  const unavailableThenFine = async () => {
    const fake = createFakeIndexedDb();
    fake.injectOpenFault({ kind: 'error', errorName: 'UnknownError' });
    const store = createSaveStore({ factory: asIdbFactory(fake) });
    await store.init();
    return { fake, store };
  };

  it('re-attempts IndexedDB and moves the in-memory slots into it', async () => {
    const { fake, store } = await unavailableThenFine();
    await store.write('autosave', { auto: 1 }, makeSlotMeta('autosave'));
    await store.write('manual-2', { m: 2 }, makeSlotMeta('manual-2'));
    const result = await store.retry();
    expect(result.backend, 'switched').toBe('indexeddb');
    expect(result.status, 'ready').toEqual({ state: 'ready' });
    expect(result.migrated, 'both migrated under their own ids').toEqual(['autosave', 'manual-2']);
    expect(result.unmigrated, 'nothing left behind').toEqual([]);
    expect(store.status(), 'store status follows').toEqual({ state: 'ready' });
    expect(fake.peek(SAVE_DB_NAME, PAYLOADS_STORE_NAME).size, 'on disk now').toBe(2);
    expect((await store.read('manual-2')).payload, 'payload intact').toEqual({ m: 2 });
    expect((await store.list()).map((row) => row.id), 'listing comes from IndexedDB').toEqual(['autosave', 'manual-2']);
  });

  it('stays in memory and reports the new reason when IndexedDB is still down', async () => {
    const { fake, store } = await unavailableThenFine();
    await store.write('manual-1', { n: 1 }, makeSlotMeta('manual-1'));
    fake.injectOpenFault({ kind: 'throw', errorName: 'SecurityError' });
    const result = await store.retry();
    expect(result.backend, 'still memory').toBe('memory-only');
    expect(result.unmigrated, 'the slot is still only in memory').toEqual(['manual-1']);
    expect((await store.read('manual-1')).payload, 'nothing lost').toEqual({ n: 1 });
  });

  it('never overwrites an IndexedDB slot: a clash is kept under a free manual slot', async () => {
    const fake = createFakeIndexedDb();
    // An earlier session left an autosave and manual-1 in IndexedDB.
    const earlier = createSaveStore({ factory: asIdbFactory(fake) });
    await earlier.write('autosave', { from: 'earlier session' }, makeSlotMeta('autosave'));
    await earlier.write('manual-1', { from: 'earlier manual' }, makeSlotMeta('manual-1'));
    earlier.close();
    fake.injectOpenFault({ kind: 'error', errorName: 'UnknownError' });
    const store = createSaveStore({ factory: asIdbFactory(fake) });
    await store.init();
    await store.write('autosave', { from: 'memory autosave' }, makeSlotMeta('autosave', { name: 'Autosave' }));
    const result = await store.retry();
    expect(result.relocated, 'moved to the first free manual slot').toEqual([{ from: 'autosave', to: 'manual-2' }]);
    expect((await store.read('autosave')).payload, 'earlier autosave kept').toEqual({ from: 'earlier session' });
    expect((await store.read('manual-2')).payload, 'memory autosave kept').toEqual({ from: 'memory autosave' });
    const relocated = (await store.list()).find((row) => row.id === 'manual-2');
    expect(relocated?.name, 'labelled').toBe('Unsaved: Autosave');
    expect(relocated?.kind, 'a manual slot now').toBe('manual');
  });

  it('keeps slots it cannot place (every manual slot taken) in memory and reports them', async () => {
    const fake = createFakeIndexedDb();
    const earlier = createSaveStore({ factory: asIdbFactory(fake) });
    for (let slot = 1; slot <= 10; slot += 1) {
      const id = `manual-${slot}` as SaveSlotId;
      await earlier.write(id, { id }, makeSlotMeta(id));
    }
    await earlier.write('autosave', { old: true }, makeSlotMeta('autosave'));
    earlier.close();
    fake.injectOpenFault({ kind: 'error', errorName: 'UnknownError' });
    const store = createSaveStore({ factory: asIdbFactory(fake) });
    await store.init();
    await store.write('autosave', { fresh: true }, makeSlotMeta('autosave'));
    const result = await store.retry();
    expect(result.unmigrated, 'reported').toEqual(['autosave']);
    expect((await store.read('autosave')).payload, 'IndexedDB autosave not overwritten').toEqual({ old: true });
  });

  it('stays in memory when IndexedDB opens but is out of quota, keeping the data', async () => {
    const { fake, store } = await unavailableThenFine();
    await store.write('manual-1', { n: 1 }, makeSlotMeta('manual-1'));
    fake.injectFault({ kind: 'quota-on-commit' });
    const result = await store.retry();
    expect(result.backend, 'still memory').toBe('memory-only');
    expect(result.status, 'quota reported').toMatchObject({ state: 'unavailable', code: 'quota' });
    expect((await store.read('manual-1')).payload, 'the in-memory save survives the failed migration').toEqual({ n: 1 });
    const second = await store.retry();
    expect(second.backend, 'a later retry succeeds').toBe('indexeddb');
    expect(second.migrated, 'and migrates').toEqual(['manual-1']);
  });

  it('shares one run between concurrent retries', async () => {
    const { fake, store } = await unavailableThenFine();
    await store.write('manual-1', { n: 1 }, makeSlotMeta('manual-1'));
    const [a, b] = await Promise.all([store.retry(), store.retry()]);
    expect(a, 'same result object').toBe(b);
    expect(fake.peek(SAVE_DB_NAME, PAYLOADS_STORE_NAME).size, 'migrated once').toBe(1);
  });

  it('retry on a healthy store is a harmless re-check', async () => {
    const fake = createFakeIndexedDb();
    const store = createSaveStore({ factory: asIdbFactory(fake) });
    await store.init();
    const result = await store.retry();
    expect(result, 'nothing to do').toMatchObject({ backend: 'indexeddb', migrated: [], relocated: [], unmigrated: [] });
  });
});

describe('MemorySaveStore status', () => {
  it('a deliberate memory store is ready and says memory-only through backend', async () => {
    const store = new MemorySaveStore();
    expect(store.backend, 'backend').toBe('memory-only');
    expect(await store.init(), 'ready').toEqual({ state: 'ready' });
  });

  it('a fallback memory store reports why persistence is unavailable', () => {
    const store = new MemorySaveStore({ code: 'quota', message: 'full' });
    expect(store.status(), 'carries the reason').toEqual({ state: 'unavailable', code: 'quota', message: 'full' });
  });
});
