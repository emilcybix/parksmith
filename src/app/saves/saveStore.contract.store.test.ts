import { describe, expect, it } from 'vitest';
import { SAVE_DB_NAME, PAYLOADS_STORE_NAME, SLOTS_STORE_NAME } from './constants';
import { IdbSaveStore } from './idbSaveStore';
import { MemorySaveStore } from './memorySaveStore';
import { asIdbFactory, createFakeIndexedDb, makeSlotMeta } from './fakeIndexedDb.storeSupport';
import type { SaveSlotId, SaveStore } from './types';
import { StoreError } from './types';
import { SAVE_SCHEMA_VERSION } from '../../game/save/version';

/**
 * The SaveStore contract, run against BOTH implementations: whatever the manager relies on must
 * hold for the in-memory fallback exactly as for IndexedDB, or a fallback would behave differently
 * from the thing it stands in for.
 */

interface Harness {
  store: SaveStore;
  /** Plants raw records in the two object stores (undefined = leave that one empty). */
  seedRaw(key: string, metaValue: unknown, payloadValue: unknown): void;
}

const harnesses: Array<{ name: string; create: () => Harness }> = [
  {
    name: 'MemorySaveStore',
    create: () => {
      const store = new MemorySaveStore();
      return { store, seedRaw: (key, metaValue, payloadValue) => store.seedRaw(key, metaValue, payloadValue) };
    },
  },
  {
    name: 'IdbSaveStore (fake IndexedDB)',
    create: () => {
      const fake = createFakeIndexedDb();
      const store = new IdbSaveStore({ factory: asIdbFactory(fake) });
      return {
        store,
        seedRaw: (key, metaValue, payloadValue) => {
          if (metaValue !== undefined) fake.plant(SAVE_DB_NAME, SLOTS_STORE_NAME, key, metaValue);
          if (payloadValue !== undefined) fake.plant(SAVE_DB_NAME, PAYLOADS_STORE_NAME, key, payloadValue);
        },
      };
    },
  },
];

const rejection = async (promise: Promise<unknown>): Promise<StoreError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StoreError) return error;
    throw error;
  }
  throw new Error('expected the promise to reject');
};

describe.each(harnesses)('SaveStore contract: $name', ({ create }) => {
  const open = async (): Promise<Harness> => {
    const harness = create();
    await harness.store.init();
    return harness;
  };

  it('reports ready after init and lists nothing when empty', async () => {
    const { store } = await open();
    expect(store.status(), 'status after init').toEqual({ state: 'ready' });
    expect(await store.list(), 'empty list').toEqual([]);
  });

  it('writes and reads back a plain-object payload exactly', async () => {
    const { store } = await open();
    const payload = { schemaVersion: 1, nested: { list: [1, 2, { deep: 'x' }] }, nothing: null };
    await store.write('manual-1', payload, makeSlotMeta('manual-1'));
    const record = await store.read('manual-1');
    expect(record.payload, 'payload as stored').toEqual(payload);
    expect(record.id, 'record id').toBe('manual-1');
    expect(record.revision, 'first write revision').toBe(1);
  });

  it('does not alias the caller object or the returned record', async () => {
    const { store } = await open();
    const payload = { guests: [1, 2, 3] };
    await store.write('manual-1', payload, makeSlotMeta('manual-1'));
    payload.guests.push(4);
    const first = await store.read('manual-1');
    (first.payload as { guests: number[] }).guests.push(99);
    const second = await store.read('manual-1');
    expect(second.payload, 'stored payload is independent of both copies').toEqual({ guests: [1, 2, 3] });
  });

  it('lists metadata with autosave first and manual slots in order', async () => {
    const { store } = await open();
    for (const id of ['manual-3', 'manual-1', 'autosave', 'manual-10', 'manual-2'] as SaveSlotId[]) {
      await store.write(id, { id }, makeSlotMeta(id));
    }
    const rows = await store.list();
    expect(rows.map((row) => row.id), 'display order').toEqual(['autosave', 'manual-1', 'manual-2', 'manual-3', 'manual-10']);
    expect(rows[0].name, 'meta fields come through').toBe('Autosave');
    expect(rows.every((row) => row.status.state === 'ok'), 'all readable').toBe(true);
  });

  it('assigns increasing revisions and ignores the revision the caller passes', async () => {
    const { store } = await open();
    await store.write('autosave', { n: 1 }, makeSlotMeta('autosave', { revision: 500 }));
    await store.write('autosave', { n: 2 }, makeSlotMeta('autosave', { revision: 500 }));
    const rows = await store.list();
    expect(rows[0].revision, 'meta revision').toBe(2);
    expect((await store.read('autosave')).revision, 'payload revision matches meta').toBe(2);
  });

  it('keeps meta and payload together: the later write replaces both', async () => {
    const { store } = await open();
    await store.write('manual-2', { v: 1 }, makeSlotMeta('manual-2', { cash: 100 }));
    await store.write('manual-2', { v: 2 }, makeSlotMeta('manual-2', { cash: 900 }));
    expect((await store.read('manual-2')).payload, 'payload').toEqual({ v: 2 });
    expect((await store.list())[0].cash, 'meta').toBe(900);
  });

  it('rejects not-found for an absent slot', async () => {
    const { store } = await open();
    expect((await rejection(store.read('manual-4'))).code, 'read').toBe('not-found');
    expect((await rejection(store.updateMeta('manual-4', { name: 'x' }))).code, 'updateMeta').toBe('not-found');
    expect((await rejection(store.move('manual-4', 'manual-5'))).code, 'move').toBe('not-found');
  });

  describe('expectedRevision', () => {
    it('accepts the matching revision and rejects a stale one with conflict, leaving the slot untouched', async () => {
      const { store } = await open();
      await store.write('autosave', { n: 1 }, makeSlotMeta('autosave'));
      await store.write('autosave', { n: 2 }, makeSlotMeta('autosave'), { expectedRevision: 1 });
      const error = await rejection(store.write('autosave', { n: 3 }, makeSlotMeta('autosave'), { expectedRevision: 1 }));
      expect(error.code, 'stale revision').toBe('conflict');
      expect((await store.read('autosave')).payload, 'the rejected write changed nothing').toEqual({ n: 2 });
    });

    it('null means the slot must not exist', async () => {
      const { store } = await open();
      await store.write('manual-1', { n: 1 }, makeSlotMeta('manual-1'), { expectedRevision: null });
      const error = await rejection(store.write('manual-1', { n: 2 }, makeSlotMeta('manual-1'), { expectedRevision: null }));
      expect(error.code, 'slot exists').toBe('conflict');
    });

    it('a number against an empty slot is a conflict', async () => {
      const { store } = await open();
      expect((await rejection(store.write('manual-1', {}, makeSlotMeta('manual-1'), { expectedRevision: 3 }))).code, 'empty slot').toBe('conflict');
    });
  });

  describe('updateMeta', () => {
    it('renames without touching the payload or the revision', async () => {
      const { store } = await open();
      await store.write('manual-1', { keep: 'me' }, makeSlotMeta('manual-1'));
      const updated = await store.updateMeta('manual-1', { name: 'Renamed' });
      expect(updated.name, 'returned meta').toBe('Renamed');
      expect((await store.list())[0].name, 'listed meta').toBe('Renamed');
      expect((await store.list())[0].revision, 'revision unchanged').toBe(1);
      expect((await store.read('manual-1')).payload, 'payload untouched').toEqual({ keep: 'me' });
    });

    it('persists an unreadable status, which then protects the slot', async () => {
      const { store } = await open();
      await store.write('manual-1', { x: 1 }, makeSlotMeta('manual-1'));
      await store.updateMeta('manual-1', { status: { state: 'unreadable', code: 'corrupt', message: 'bad hash' } });
      const row = (await store.list())[0];
      expect(row.status, 'reason survives').toEqual({ state: 'unreadable', code: 'corrupt', message: 'bad hash' });
      expect((await rejection(store.write('manual-1', { x: 2 }, makeSlotMeta('manual-1')))).code, 'plain write refused').toBe('unreadable-slot');
      expect((await store.read('manual-1')).payload, 'raw record kept').toEqual({ x: 1 });
    });
  });

  describe('unreadable slots are never overwritten silently', () => {
    it('refuses a write to an orphan payload, a damaged meta and a missing payload', async () => {
      const { store, seedRaw } = await open();
      seedRaw('manual-1', undefined, { id: 'manual-1', payload: { odd: true }, revision: 4 });
      seedRaw('manual-2', { id: 'manual-2', garbage: true }, { id: 'manual-2', payload: {}, revision: 1 });
      seedRaw('manual-3', makeSlotMeta('manual-3'), undefined);
      for (const id of ['manual-1', 'manual-2', 'manual-3'] as SaveSlotId[]) {
        expect((await rejection(store.write(id, { fresh: true }, makeSlotMeta(id)))).code, `write to ${id}`).toBe('unreadable-slot');
      }
      expect((await store.read('manual-1')).payload, 'orphan kept').toEqual({ odd: true });
    });

    it('replaceUnreadable lets a confirmed write through and makes the slot readable', async () => {
      const { store, seedRaw } = await open();
      seedRaw('manual-1', undefined, { id: 'manual-1', payload: { odd: true }, revision: 4 });
      await store.write('manual-1', { fresh: true }, makeSlotMeta('manual-1'), { replaceUnreadable: true });
      expect((await store.list())[0].status, 'now ok').toEqual({ state: 'ok' });
      expect((await store.read('manual-1')).payload, 'replaced').toEqual({ fresh: true });
    });

    it('a too-new schema in the meta blocks overwriting', async () => {
      const { store, seedRaw } = await open();
      seedRaw('manual-1', makeSlotMeta('manual-1', { schemaVersion: 99 }), { id: 'manual-1', payload: { future: true }, revision: 1 });
      expect((await rejection(store.write('manual-1', {}, makeSlotMeta('manual-1')))).code, 'overwrite refused').toBe('unreadable-slot');
    });
  });

  describe('listing damaged data', () => {
    it('lists an orphan payload, a missing payload, a damaged meta and an unknown id as unreadable rows', async () => {
      const { store, seedRaw } = await open();
      seedRaw('manual-1', undefined, { id: 'manual-1', payload: {}, revision: 1 });
      seedRaw('manual-2', makeSlotMeta('manual-2'), undefined);
      seedRaw('manual-3', { id: 'manual-3', name: 12 }, { id: 'manual-3', payload: {}, revision: 1 });
      seedRaw('slot-from-the-future', makeSlotMeta('manual-4', { id: 'slot-from-the-future' as SaveSlotId }), { id: 'slot-from-the-future', payload: {}, revision: 1 });
      const byId = new Map((await store.list()).map((row) => [row.id as string, row]));
      expect(byId.get('manual-1')?.status, 'orphan payload').toMatchObject({ state: 'unreadable', code: 'payload-missing' });
      expect(byId.get('manual-2')?.status, 'meta without payload').toMatchObject({ state: 'unreadable', code: 'payload-missing' });
      expect(byId.get('manual-3')?.status, 'damaged meta').toMatchObject({ state: 'unreadable', code: 'meta-corrupt' });
      expect(byId.get('slot-from-the-future')?.status, 'unknown id').toMatchObject({ state: 'unreadable', code: 'meta-corrupt' });
      expect(byId.size, 'nothing dropped').toBe(4);
    });

    it('reports a newer schema from the header as too-new', async () => {
      const { store, seedRaw } = await open();
      seedRaw('autosave', makeSlotMeta('autosave', { schemaVersion: SAVE_SCHEMA_VERSION + 1 }), { id: 'autosave', payload: { whatever: 1 }, revision: 1 });
      expect((await store.list())[0].status, 'too-new').toMatchObject({ state: 'unreadable', code: 'too-new' });
    });

    it('lets the player delete every kind of unreadable row', async () => {
      const { store, seedRaw } = await open();
      seedRaw('manual-1', undefined, { id: 'manual-1', payload: {}, revision: 1 });
      seedRaw('manual-3', { id: 'manual-3', name: 12 }, undefined);
      await store.remove('manual-1');
      await store.remove('manual-3');
      expect(await store.list(), 'all gone').toEqual([]);
    });

    it('read() hands a foreign payload value to the loader raw instead of hiding it', async () => {
      const { store, seedRaw } = await open();
      seedRaw('manual-1', makeSlotMeta('manual-1'), 'not even an object');
      const record = await store.read('manual-1');
      expect(record.payload, 'raw value as found').toBe('not even an object');
    });
  });

  describe('move', () => {
    it('moves meta and payload to a free slot and removes the source', async () => {
      const { store } = await open();
      await store.write('autosave', { n: 1 }, makeSlotMeta('autosave'));
      await store.move('autosave', 'manual-7');
      const rows = await store.list();
      expect(rows.map((row) => row.id), 'only the target remains').toEqual(['manual-7']);
      expect(rows[0].kind, 'kind follows the slot').toBe('manual');
      const record = await store.read('manual-7');
      expect(record.id, 'record id rewritten').toBe('manual-7');
      expect(record.payload, 'payload moved').toEqual({ n: 1 });
      expect((await rejection(store.read('autosave'))).code, 'source gone').toBe('not-found');
    });

    it('rejects with conflict when the target is taken and changes nothing', async () => {
      const { store } = await open();
      await store.write('autosave', { n: 1 }, makeSlotMeta('autosave'));
      await store.write('manual-1', { n: 2 }, makeSlotMeta('manual-1'));
      expect((await rejection(store.move('autosave', 'manual-1'))).code, 'target taken').toBe('conflict');
      expect((await store.read('autosave')).payload, 'source intact').toEqual({ n: 1 });
      expect((await store.read('manual-1')).payload, 'target intact').toEqual({ n: 2 });
    });

    it('quarantines an orphan payload under a visible unreadable row', async () => {
      const { store, seedRaw } = await open();
      seedRaw('autosave', undefined, { id: 'autosave', payload: { orphan: true }, revision: 3 });
      await store.move('autosave', 'manual-2');
      const row = (await store.list())[0];
      expect(row.id, 'listed at the new slot').toBe('manual-2');
      expect(row.status.state, 'still unreadable, never hidden').toBe('unreadable');
      expect((await store.read('manual-2')).payload, 'payload kept').toEqual({ orphan: true });
    });
  });

  describe('remove', () => {
    it('deletes meta and payload and resolves for an absent slot', async () => {
      const { store } = await open();
      await store.write('manual-1', { n: 1 }, makeSlotMeta('manual-1'));
      await store.remove('manual-1');
      await store.remove('manual-1');
      await store.remove('manual-9');
      expect(await store.list(), 'empty').toEqual([]);
      expect((await rejection(store.read('manual-1'))).code, 'payload gone').toBe('not-found');
    });
  });

  it('rejects a payload that cannot be stored and leaves the previous save intact', async () => {
    const { store } = await open();
    await store.write('manual-1', { good: true }, makeSlotMeta('manual-1'));
    const error = await rejection(store.write('manual-1', { bad: () => 1 }, makeSlotMeta('manual-1'), { expectedRevision: 1 }));
    expect(error.code, 'uncloneable payload').toBe('corrupt');
    expect((await store.read('manual-1')).payload, 'previous save intact').toEqual({ good: true });
    expect((await store.list())[0].revision, 'revision not advanced').toBe(1);
  });

  it('holds ten manual slots plus the autosave', async () => {
    const { store } = await open();
    const ids: SaveSlotId[] = ['autosave'];
    for (let slot = 1; slot <= 10; slot += 1) ids.push(`manual-${slot}` as SaveSlotId);
    await Promise.all(ids.map((id) => store.write(id, { id }, makeSlotMeta(id))));
    expect((await store.list()).map((row) => row.id), 'all eleven in order').toEqual(ids);
  });

  it('serialises overlapping writes to the same slot so revisions never repeat', async () => {
    const { store } = await open();
    await Promise.all([1, 2, 3, 4].map((n) => store.write('autosave', { n }, makeSlotMeta('autosave'))));
    expect((await store.list())[0].revision, 'four writes, revision four').toBe(4);
  });

  describe('autosave rotation (Phase 31)', () => {
    const ROTATE = { rotateTo: 'autosave-previous' as const };

    it('moves the current record to the rotation target and puts the new one, in one write', async () => {
      const { store } = await open();
      await store.write('autosave', { n: 1 }, makeSlotMeta('autosave', { cash: 1 }), ROTATE);
      expect((await store.list()).map((row) => row.id), 'nothing to rotate out of an empty slot').toEqual(['autosave']);
      await store.write('autosave', { n: 2 }, makeSlotMeta('autosave', { cash: 2 }), { ...ROTATE, expectedRevision: 1 });
      const rows = await store.list();
      expect(rows.map((row) => row.id), 'autosave first, then the previous generation').toEqual(['autosave', 'autosave-previous']);
      expect(rows[0].cash, 'new meta in the autosave slot').toBe(2);
      expect(rows[0].revision, 'autosave revision keeps counting').toBe(2);
      expect(rows[1].cash, 'old meta moved').toBe(1);
      expect(rows[1].kind, 'the previous generation is an autosave too').toBe('auto');
      expect(rows[1].revision, 'first write to the previous slot').toBe(1);
      expect(rows[1].status, 'readable').toEqual({ state: 'ok' });
      expect((await store.read('autosave')).payload, 'new payload').toEqual({ n: 2 });
      const previous = await store.read('autosave-previous');
      expect(previous.payload, 'old payload moved').toEqual({ n: 1 });
      expect(previous.id, 'record re-keyed').toBe('autosave-previous');
      expect(previous.revision, 'record revision matches its meta').toBe(1);
    });

    it('replaces an older previous generation and advances its revision', async () => {
      const { store } = await open();
      for (const n of [1, 2, 3]) await store.write('autosave', { n }, makeSlotMeta('autosave', { cash: n }), ROTATE);
      const rows = await store.list();
      expect(rows.map((row) => [row.id, row.cash, row.revision]), 'two generations, never three').toEqual([
        ['autosave', 3, 3],
        ['autosave-previous', 2, 2],
      ]);
      expect((await store.read('autosave-previous')).payload, 'the generation before the newest').toEqual({ n: 2 });
    });

    it('does not rotate without the option (manual saves are unchanged)', async () => {
      const { store } = await open();
      await store.write('manual-1', { n: 1 }, makeSlotMeta('manual-1'));
      await store.write('manual-1', { n: 2 }, makeSlotMeta('manual-1'));
      expect((await store.list()).map((row) => row.id), 'one slot').toEqual(['manual-1']);
    });

    it('never rotates an unreadable record: a confirmed replacement leaves the previous generation alone', async () => {
      const { store, seedRaw } = await open();
      await store.write('autosave', { good: 1 }, makeSlotMeta('autosave'), ROTATE);
      await store.write('autosave', { good: 2 }, makeSlotMeta('autosave'), ROTATE);
      await store.updateMeta('autosave', { status: { state: 'unreadable', code: 'corrupt', message: 'bad' } });
      expect((await rejection(store.write('autosave', { n: 3 }, makeSlotMeta('autosave'), ROTATE))).code, 'still protected').toBe('unreadable-slot');
      await store.write('autosave', { n: 3 }, makeSlotMeta('autosave'), { ...ROTATE, replaceUnreadable: true });
      expect((await store.read('autosave-previous')).payload, 'previous generation untouched').toEqual({ good: 1 });
      seedRaw('autosave', { garbage: true }, { id: 'autosave', payload: { damaged: true }, revision: 9 });
      await store.write('autosave', { n: 4 }, makeSlotMeta('autosave'), { ...ROTATE, replaceUnreadable: true });
      expect((await store.read('autosave-previous')).payload, 'a damaged meta never rotates either').toEqual({ good: 1 });
    });

    it('a refused write (conflict) leaves both generations intact', async () => {
      const { store } = await open();
      await store.write('autosave', { n: 1 }, makeSlotMeta('autosave'), ROTATE);
      await store.write('autosave', { n: 2 }, makeSlotMeta('autosave'), ROTATE);
      expect((await rejection(store.write('autosave', { n: 3 }, makeSlotMeta('autosave'), { ...ROTATE, expectedRevision: 1 }))).code).toBe('conflict');
      expect((await store.read('autosave')).payload, 'current intact').toEqual({ n: 2 });
      expect((await store.read('autosave-previous')).payload, 'previous intact').toEqual({ n: 1 });
    });

    it('a put that fails (payload cannot be stored) leaves both generations intact', async () => {
      const { store } = await open();
      await store.write('autosave', { n: 1 }, makeSlotMeta('autosave'), ROTATE);
      await store.write('autosave', { n: 2 }, makeSlotMeta('autosave'), ROTATE);
      const error = await rejection(store.write('autosave', { bad: () => 1 }, makeSlotMeta('autosave'), ROTATE));
      expect(error.code, 'uncloneable payload').toBe('corrupt');
      const rows = await store.list();
      expect(rows.map((row) => [row.id, row.revision]), 'revisions not advanced').toEqual([['autosave', 2], ['autosave-previous', 1]]);
      expect((await store.read('autosave')).payload, 'current intact').toEqual({ n: 2 });
      expect((await store.read('autosave-previous')).payload, 'previous intact').toEqual({ n: 1 });
    });

    it('lists the previous generation as a known slot and lets it be loaded and deleted on its own', async () => {
      const { store } = await open();
      await store.write('autosave', { n: 1 }, makeSlotMeta('autosave'), ROTATE);
      await store.write('manual-1', { m: 1 }, makeSlotMeta('manual-1'));
      await store.write('autosave', { n: 2 }, makeSlotMeta('autosave'), ROTATE);
      expect((await store.list()).map((row) => row.id), 'order').toEqual(['autosave', 'autosave-previous', 'manual-1']);
      await store.remove('autosave-previous');
      expect((await store.list()).map((row) => row.id), 'only the previous one went').toEqual(['autosave', 'manual-1']);
    });
  });
});
