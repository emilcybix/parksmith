import { describe, expect, it } from 'vitest';
import { PAYLOADS_STORE_NAME, SAVE_DB_NAME, SLOTS_STORE_NAME } from './constants';
import { IdbSaveStore, mapIdbError } from './idbSaveStore';
import { asIdbFactory, createFakeIndexedDb, makeSlotMeta } from './fakeIndexedDb.storeSupport';
import { StoreError } from './types';

const rejection = async (promise: Promise<unknown>): Promise<StoreError> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof StoreError) return error;
    throw error;
  }
  throw new Error('expected the promise to reject');
};

const setup = (options: { openTimeoutMs?: number; version?: number } = {}) => {
  const fake = createFakeIndexedDb();
  const store = new IdbSaveStore({ factory: asIdbFactory(fake), ...options });
  return { fake, store };
};

describe('IdbSaveStore: metadata without payloads', () => {
  it('list() never reads a payload value, only the payload key list', async () => {
    const { fake, store } = setup();
    await store.init();
    for (const id of ['autosave', 'manual-1', 'manual-2'] as const) {
      await store.write(id, { big: 'x'.repeat(1000) }, makeSlotMeta(id));
    }
    fake.resetStats();
    const rows = await store.list();
    expect(rows, 'three rows').toHaveLength(3);
    expect(fake.stats(PAYLOADS_STORE_NAME).valueReads, 'no payload deserialized by list()').toBe(0);
    expect(fake.stats(PAYLOADS_STORE_NAME).keyReads, 'payload keys listed').toBe(1);
    expect(fake.stats(SLOTS_STORE_NAME).valueReads, 'metadata values read').toBeGreaterThan(0);
  });

  it('rename touches the slots store only', async () => {
    const { fake, store } = setup();
    await store.write('manual-1', { n: 1 }, makeSlotMeta('manual-1'));
    fake.resetStats();
    await store.updateMeta('manual-1', { name: 'New' });
    expect(fake.stats(PAYLOADS_STORE_NAME), 'payload store untouched').toEqual({ valueReads: 0, keyReads: 0, writes: 0 });
  });
});

describe('IdbSaveStore: opening and upgrading', () => {
  it('creates both stores on first open and keeps data across store instances (a page reload)', async () => {
    const fake = createFakeIndexedDb();
    const first = new IdbSaveStore({ factory: asIdbFactory(fake) });
    expect(await first.init(), 'first open').toEqual({ state: 'ready' });
    await first.write('manual-1', { survives: true }, makeSlotMeta('manual-1'));
    first.close();
    expect(first.status(), 'closed after close()').toEqual({ state: 'closed' });
    expect(fake.openConnectionCount(), 'close() released the connection').toBe(0);
    const second = new IdbSaveStore({ factory: asIdbFactory(fake) });
    expect((await second.read('manual-1')).payload, 'read after reopen').toEqual({ survives: true });
    expect((await second.list())[0].name, 'meta after reopen').toBe('Park manual-1');
  });

  it('reopens lazily after close()', async () => {
    const { store } = setup();
    await store.write('manual-1', { n: 1 }, makeSlotMeta('manual-1'));
    store.close();
    expect((await store.list()).length, 'usable again').toBe(1);
    expect(store.status(), 'ready again').toEqual({ state: 'ready' });
  });

  it('shares one open between concurrent first calls', async () => {
    const { fake, store } = setup();
    await Promise.all([store.list(), store.list(), store.init()]);
    expect(fake.openCalls, 'a single indexedDB.open').toBe(1);
  });

  it('reports unavailable without an IndexedDB, never rejecting from init()', async () => {
    const store = new IdbSaveStore({ factory: null });
    const status = await store.init();
    expect(status.state, 'status state').toBe('unavailable');
    expect(status.state === 'unavailable' && status.code, 'code').toBe('unavailable');
    expect((await rejection(store.list())).code, 'operations reject with a typed error').toBe('unavailable');
  });

  it('maps a synchronous open() throw (SecurityError) to unavailable', async () => {
    const { fake, store } = setup();
    fake.injectOpenFault({ kind: 'throw', errorName: 'SecurityError' });
    const status = await store.init();
    expect(status, 'unavailable').toMatchObject({ state: 'unavailable', code: 'unavailable' });
  });

  it('maps an open error event (private mode, UnknownError) to unavailable and retries from scratch next call', async () => {
    const { fake, store } = setup();
    fake.injectOpenFault({ kind: 'error', errorName: 'UnknownError' });
    expect(await store.init(), 'first attempt fails').toMatchObject({ state: 'unavailable', code: 'unavailable' });
    expect(await store.init(), 'retry works').toEqual({ state: 'ready' });
    expect(fake.openConnectionCount(), 'exactly one connection').toBe(1);
  });

  it('explains a database that is newer than this build and leaves it alone', async () => {
    const fake = createFakeIndexedDb();
    const newer = new IdbSaveStore({ factory: asIdbFactory(fake), version: 5 });
    await newer.write('manual-1', { n: 1 }, makeSlotMeta('manual-1'));
    newer.close();
    const older = new IdbSaveStore({ factory: asIdbFactory(fake), version: 1 });
    const status = await older.init();
    expect(status, 'unavailable').toMatchObject({ state: 'unavailable', code: 'unavailable' });
    expect(status.state === 'unavailable' && status.message, 'message names the cause').toContain('newer version');
    expect(fake.peek(SAVE_DB_NAME, PAYLOADS_STORE_NAME).size, 'data untouched').toBe(1);
  });

  it('times out a hung open as unavailable', async () => {
    const { fake, store } = setup({ openTimeoutMs: 20 });
    fake.injectOpenFault({ kind: 'hang' });
    expect(await store.init(), 'timed out').toMatchObject({ state: 'unavailable', code: 'unavailable' });
  });

  it('reports blocked while an old tab holds the database, then adopts the connection when it lets go', async () => {
    const fake = createFakeIndexedDb();
    const oldTab = new IdbSaveStore({ factory: asIdbFactory(fake), version: 1 });
    await oldTab.init();
    // The old tab keeps its connection open and ignores versionchange: the upgrade is blocked.
    fake.connection(0)!.onversionchange = null;
    const upgraded = new IdbSaveStore({ factory: asIdbFactory(fake), version: 2 });
    const status = await upgraded.init();
    expect(status, 'blocked').toMatchObject({ state: 'unavailable', code: 'blocked' });
    expect((await rejection(upgraded.list())).code, 'operations say blocked too').toBe('blocked');
    fake.connection(0)!.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await upgraded.list()), 'usable once the old tab closed').toEqual([]);
    expect(upgraded.status(), 'ready after adopting the late connection').toEqual({ state: 'ready' });
  });

  it('closes its connection on versionchange so a newer tab can upgrade, and reopens on the next call', async () => {
    const { fake, store } = setup();
    await store.write('manual-1', { n: 1 }, makeSlotMeta('manual-1'));
    fake.fireVersionChange(2);
    expect(fake.openConnectionCount(), 'connection closed').toBe(0);
    expect(store.status(), 'status closed').toEqual({ state: 'closed' });
    expect((await store.list()).length, 'next call reopens').toBe(1);
    expect(store.status(), 'ready again').toEqual({ state: 'ready' });
  });

  it('survives an abnormal close event', async () => {
    const { fake, store } = setup();
    await store.init();
    fake.abnormalClose(fake.connection(0)!);
    expect(store.status(), 'noticed').toEqual({ state: 'closed' });
    expect(await store.list(), 'reopened').toEqual([]);
  });

  it('reopens once when the browser closed the connection without telling the page (InvalidStateError)', async () => {
    const { fake, store } = setup();
    await store.write('manual-1', { n: 1 }, makeSlotMeta('manual-1'));
    fake.connection(0)!.silentlyClose();
    expect((await store.list()).length, 'transparently reopened').toBe(1);
    expect(fake.openCalls, 'one extra open').toBe(2);
  });

  it('gives up with unavailable when InvalidStateError persists', async () => {
    const { fake, store } = setup();
    await store.init();
    fake.injectFault({ kind: 'transaction-throws', errorName: 'InvalidStateError' });
    fake.injectFault({ kind: 'transaction-throws', errorName: 'InvalidStateError' });
    expect((await rejection(store.list())).code, 'second failure surfaces').toBe('unavailable');
    expect((await store.list()).length, 'and the store is usable afterwards').toBe(0);
  });
});

describe('IdbSaveStore: failures after a successful open', () => {
  it('maps a quota error on commit to quota, rolls back both stores and keeps the old save', async () => {
    const { fake, store } = setup();
    await store.write('manual-1', { v: 'old' }, makeSlotMeta('manual-1', { cash: 1 }));
    fake.injectFault({ kind: 'quota-on-commit' });
    const error = await rejection(store.write('manual-1', { v: 'new' }, makeSlotMeta('manual-1', { cash: 2 })));
    expect(error.code, 'quota').toBe('quota');
    expect(store.status(), 'status reports the quota').toMatchObject({ state: 'unavailable', code: 'quota' });
    expect((await store.read('manual-1')).payload, 'old payload intact').toEqual({ v: 'old' });
    expect((await store.list())[0].cash, 'old meta intact (atomic)').toBe(1);
  });

  it('maps a quota error on put to quota and rolls back', async () => {
    const { fake, store } = setup();
    fake.injectFault({ kind: 'quota-on-put' });
    expect((await rejection(store.write('manual-1', { v: 1 }, makeSlotMeta('manual-1')))).code, 'quota').toBe('quota');
    expect(await store.list(), 'nothing half-written').toEqual([]);
  });

  it('returns to ready after a later write succeeds, with no manual reset', async () => {
    const { fake, store } = setup();
    fake.injectFault({ kind: 'quota-on-commit' });
    await rejection(store.write('manual-1', { v: 1 }, makeSlotMeta('manual-1')));
    await store.write('manual-1', { v: 2 }, makeSlotMeta('manual-1'));
    expect(store.status(), 'recovered').toEqual({ state: 'ready' });
  });

  it('keeps reads working while the quota status is set', async () => {
    const { fake, store } = setup();
    await store.write('manual-1', { v: 1 }, makeSlotMeta('manual-1'));
    fake.injectFault({ kind: 'quota-on-commit' });
    await rejection(store.write('manual-2', { v: 2 }, makeSlotMeta('manual-2')));
    expect((await store.read('manual-1')).payload, 'read').toEqual({ v: 1 });
    expect(store.status(), 'a read does not clear the quota status').toMatchObject({ code: 'quota' });
  });

  it('maps an aborted transaction to unknown without losing the previous save', async () => {
    const { fake, store } = setup();
    await store.write('manual-1', { v: 'old' }, makeSlotMeta('manual-1'));
    fake.injectFault({ kind: 'abort', afterRequests: 3 });
    const error = await rejection(store.write('manual-1', { v: 'new' }, makeSlotMeta('manual-1')));
    expect(error.code, 'abort').toBe('unknown');
    expect((await store.read('manual-1')).payload, 'rolled back').toEqual({ v: 'old' });
    expect(store.status(), 'an abort is not a persistence outage').toEqual({ state: 'ready' });
  });

  it('maps a put DataError thrown synchronously to corrupt and aborts cleanly', async () => {
    const { fake, store } = setup();
    fake.injectFault({ kind: 'put-throws', errorName: 'DataError' });
    expect((await rejection(store.write('manual-1', {}, makeSlotMeta('manual-1')))).code, 'DataError').toBe('corrupt');
    expect(await store.list(), 'nothing written').toEqual([]);
  });

  it('never rejects with a raw DOMException', async () => {
    const { fake, store } = setup();
    await store.init();
    for (const errorName of ['UnknownError', 'ConstraintError', 'TransactionInactiveError']) {
      fake.injectFault({ kind: 'abort', errorName, afterRequests: 1 });
      const error = await rejection(store.write('manual-1', {}, makeSlotMeta('manual-1')));
      expect(error, `${errorName} is wrapped`).toBeInstanceOf(StoreError);
    }
  });

  it('write rules run inside the transaction: a conflict aborts with no partial write', async () => {
    const { fake, store } = setup();
    await store.write('manual-1', { v: 1 }, makeSlotMeta('manual-1'));
    expect((await rejection(store.write('manual-1', { v: 2 }, makeSlotMeta('manual-1'), { expectedRevision: 9 }))).code, 'conflict').toBe('conflict');
    expect((fake.peek(SAVE_DB_NAME, PAYLOADS_STORE_NAME).get('manual-1') as { payload: unknown }).payload, 'payload untouched').toEqual({ v: 1 });
  });
});

describe('IdbSaveStore: autosave rotation is one transaction (Phase 31)', () => {
  const ROTATE = { rotateTo: 'autosave-previous' as const };

  const twoGenerations = async () => {
    const { fake, store } = setup();
    await store.write('autosave', { v: 'older' }, makeSlotMeta('autosave', { cash: 1 }), ROTATE);
    await store.write('autosave', { v: 'newer' }, makeSlotMeta('autosave', { cash: 2 }), ROTATE);
    return { fake, store };
  };

  const expectBothIntact = async (fake: ReturnType<typeof createFakeIndexedDb>, store: IdbSaveStore): Promise<void> => {
    const payloads = fake.peek(SAVE_DB_NAME, PAYLOADS_STORE_NAME);
    expect((payloads.get('autosave') as { payload: unknown }).payload, 'current payload intact').toEqual({ v: 'newer' });
    expect((payloads.get('autosave-previous') as { payload: unknown }).payload, 'previous payload intact').toEqual({ v: 'older' });
    const rows = await store.list();
    expect(rows.map((row) => [row.id, row.cash, row.revision]), 'both metas intact (atomic)').toEqual([
      ['autosave', 2, 2],
      ['autosave-previous', 1, 1],
    ]);
  };

  it('a quota error on the LAST put, after the rotation puts landed, rolls the rotation back too', async () => {
    const { fake, store } = await twoGenerations();
    // The rotation writes two records (payload and meta of the previous slot); the third put is the new payload.
    fake.injectFault({ kind: 'quota-on-put', afterWrites: 2 });
    expect((await rejection(store.write('autosave', { v: 'newest' }, makeSlotMeta('autosave', { cash: 3 }), ROTATE))).code).toBe('quota');
    await expectBothIntact(fake, store);
  });

  it('a quota error on commit leaves both generations intact', async () => {
    const { fake, store } = await twoGenerations();
    fake.injectFault({ kind: 'quota-on-commit' });
    expect((await rejection(store.write('autosave', { v: 'newest' }, makeSlotMeta('autosave', { cash: 3 }), ROTATE))).code).toBe('quota');
    await expectBothIntact(fake, store);
  });

  it('an abort half-way through leaves both generations intact', async () => {
    const { fake, store } = await twoGenerations();
    // get meta, get payload, get target meta, then the first rotation put.
    fake.injectFault({ kind: 'abort', afterRequests: 4 });
    expect((await rejection(store.write('autosave', { v: 'newest' }, makeSlotMeta('autosave', { cash: 3 }), ROTATE))).code).toBe('unknown');
    await expectBothIntact(fake, store);
  });

  it('a payload that cannot be cloned aborts after the rotation puts and keeps both generations', async () => {
    const { fake, store } = await twoGenerations();
    expect((await rejection(store.write('autosave', { bad: () => 1 }, makeSlotMeta('autosave'), ROTATE))).code).toBe('corrupt');
    await expectBothIntact(fake, store);
  });
});

describe('IdbSaveStore: payload shape and timing', () => {
  it('stores raw plain objects (structured clone), never JSON strings', async () => {
    const { fake, store } = setup();
    await store.write('manual-1', { nested: { n: 1 } }, makeSlotMeta('manual-1'));
    const record = fake.peek(SAVE_DB_NAME, PAYLOADS_STORE_NAME).get('manual-1') as { payload: unknown };
    expect(typeof record.payload, 'payload is an object').toBe('object');
  });
});

describe('mapIdbError', () => {
  it('recognises the quota spellings of other engines', () => {
    expect(mapIdbError({ name: 'NS_ERROR_DOM_QUOTA_REACHED' }, 'x').code, 'Firefox').toBe('quota');
    expect(mapIdbError({ name: 'Error', code: 22 }, 'x').code, 'legacy code 22').toBe('quota');
  });

  it('passes StoreErrors through and describes unknown values', () => {
    const original = new StoreError('conflict', 'c');
    expect(mapIdbError(original, 'x'), 'same instance').toBe(original);
    expect(mapIdbError('weird', 'fallback text').message, 'fallback message').toBe('fallback text');
  });
});
