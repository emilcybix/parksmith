import { describe, expect, it } from 'vitest';
import olderSchemaSave from '../../game/save/fixtures/park-v1-sandbox.json';
import { SAVE_SCHEMA_VERSION } from '../../game/save/version';
import { MemorySaveStore } from './memorySaveStore';
import { computeStateSeal, mustVerifyBeforeWrite, persistSealedJob, storedSaveProblem, writeOptionsFor } from './persistJob';
import type { PersistJob } from './types';

const job = (overrides: Partial<PersistJob> = {}): PersistJob => ({
  jobId: 1,
  slotId: 'autosave',
  state: { world: { tick: 3 }, scenarioId: null } as unknown as PersistJob['state'],
  app: { clock: { simulationTimeMs: 1000 }, tourNodeId: null } as unknown as PersistJob['app'],
  savedAtEpochMs: 1,
  name: 'Autosave',
  scenarioName: 'Sandbox park',
  guestCount: 0,
  cash: 0,
  rating: 0,
  writerTabId: 'tab',
  options: {},
  ...overrides,
});

describe('storedSaveProblem', () => {
  const good = { schemaVersion: SAVE_SCHEMA_VERSION, stateHash: computeStateSeal({ a: 1 } as never).stateHash, state: { a: 1 } };

  it('accepts an intact save of this schema', () => {
    expect(storedSaveProblem(good), 'intact save').toBeNull();
  });

  it('rejects things that are not saves', () => {
    for (const value of [null, 'text', 7, [], {}, { schemaVersion: 1 }, { ...good, state: 'x' }, { ...good, stateHash: 5 }]) {
      expect(storedSaveProblem(value), `not a save: ${JSON.stringify(value)}`).not.toBeNull();
    }
  });

  it('rejects a state that no longer matches its hash', () => {
    expect(storedSaveProblem({ ...good, state: { a: 2 } }), 'tampered state').toContain('integrity');
  });

  it('lets an untampered older-schema autosave through, because that needs migration rather than being damaged', () => {
    expect(olderSchemaSave.schemaVersion, 'the fixture really is an older schema').toBeLessThan(SAVE_SCHEMA_VERSION);
    expect(storedSaveProblem(olderSchemaSave), 'intact older schema is not damage').toBeNull();
  });

  it('reports an older-schema autosave whose state no longer matches its hash (Phase 30)', () => {
    // The hash covers the state at the schema it was written at, so a damaged schema-1 record is
    // detected before the first autosave of this build replaces it, exactly like a current one.
    const state = olderSchemaSave.state as Record<string, unknown>;
    const tampered = { ...olderSchemaSave, state: { ...state, world: { ...(state.world as Record<string, unknown>), tick: -1 } } };
    expect(storedSaveProblem(tampered), 'tampered older schema').toContain('integrity');
    const truncated = { ...olderSchemaSave, state: Object.fromEntries(Object.entries(state).slice(0, -1)) };
    expect(storedSaveProblem(truncated), 'older schema missing a top-level key').toContain('integrity');
    const hashOnly = { ...olderSchemaSave, stateHash: '0000000000000000' };
    expect(storedSaveProblem(hashOnly), 'older schema with a foreign hash').toContain('integrity');
  });

  it('reports a state that cannot be hashed instead of throwing', () => {
    expect(storedSaveProblem({ ...good, state: { a: undefined } }), 'unhashable state').toContain('integrity');
  });
});

describe('persistSealedJob verifyExisting', () => {
  it('refuses to replace a damaged autosave and leaves the raw record alone', async () => {
    const store = new MemorySaveStore();
    await store.init();
    await persistSealedJob(store, job(), computeStateSeal(job().state));
    const record = await store.read('autosave');
    await store.write('autosave', { garbage: true }, (await store.list())[0], { expectedRevision: record.revision });
    const result = await persistSealedJob(store, job({ jobId: 2, verifyExisting: true }), computeStateSeal(job().state));
    expect(result.ok === false && result.error.code, 'damaged record refused').toBe('unreadable-slot');
    expect((await store.read('autosave')).payload, 'raw record untouched').toEqual({ garbage: true });
  });

  it('refuses to replace a tampered older-schema autosave (Phase 30)', async () => {
    const store = new MemorySaveStore();
    await store.init();
    await persistSealedJob(store, job(), computeStateSeal(job().state));
    const record = await store.read('autosave');
    const damaged = { ...olderSchemaSave, state: { ...olderSchemaSave.state, cash: 999999 } };
    await store.write('autosave', damaged, (await store.list())[0], { expectedRevision: record.revision });
    const result = await persistSealedJob(store, job({ jobId: 2, verifyExisting: true }), computeStateSeal(job().state));
    expect(result.ok === false && result.error.code, 'older-schema damage refused').toBe('unreadable-slot');
    expect(result.ok === false && result.error.message, 'the reason names the integrity check').toContain('integrity');
    expect((await store.read('autosave')).payload, 'raw record untouched').toEqual(damaged);
  });

  it('replaces an intact older-schema autosave, which only needs a migration', async () => {
    const store = new MemorySaveStore();
    await store.init();
    await persistSealedJob(store, job(), computeStateSeal(job().state));
    const record = await store.read('autosave');
    await store.write('autosave', olderSchemaSave, (await store.list())[0], { expectedRevision: record.revision });
    const result = await persistSealedJob(store, job({ jobId: 2, verifyExisting: true, options: { expectedRevision: record.revision + 1 } }), computeStateSeal(job().state));
    expect(result.ok, 'intact older schema may be replaced').toBe(true);
  });

  it('replaces an intact autosave', async () => {
    const store = new MemorySaveStore();
    await store.init();
    await persistSealedJob(store, job(), computeStateSeal(job().state));
    const revision = (await store.list())[0].revision;
    const result = await persistSealedJob(store, job({ jobId: 2, verifyExisting: true, options: { expectedRevision: revision } }), computeStateSeal(job().state));
    expect(result.ok, 'intact record may be replaced').toBe(true);
  });

  it('writes normally when nothing is stored yet', async () => {
    const store = new MemorySaveStore();
    await store.init();
    const result = await persistSealedJob(store, job({ verifyExisting: true, options: { expectedRevision: null } }), computeStateSeal(job().state));
    expect(result.ok, 'empty slot writes').toBe(true);
  });
});

describe('autosave generations in the writer (Phase 31)', () => {
  const stateOf = (tick: number): PersistJob['state'] => ({ world: { tick }, scenarioId: null }) as unknown as PersistJob['state'];
  const autosaveJob = (tick: number, overrides: Partial<PersistJob> = {}): PersistJob => job({ jobId: tick, state: stateOf(tick), ...overrides });
  const persist = (store: MemorySaveStore, value: PersistJob) => persistSealedJob(store, value, computeStateSeal(value.state));
  const tickOf = (payload: unknown): unknown => (payload as { state: { world: { tick: number } } }).state.world.tick;

  it('routes every autosave write through the rotation and leaves manual slots alone', () => {
    expect(writeOptionsFor({ slotId: 'autosave', options: { expectedRevision: 4 } }), 'autosave rotates').toEqual({ expectedRevision: 4, rotateTo: 'autosave-previous' });
    expect(writeOptionsFor({ slotId: 'manual-2', options: { expectedRevision: 4 } }), 'manual unchanged').toEqual({ expectedRevision: 4 });
  });

  it('verifies the stored autosave unless the write proves it is this tab\'s own', () => {
    expect(mustVerifyBeforeWrite({ slotId: 'autosave', options: { expectedRevision: 3 } }), 'own revision: trusted').toBe(false);
    expect(mustVerifyBeforeWrite({ slotId: 'autosave', options: { expectedRevision: null } }), 'must be empty: nothing to rotate').toBe(false);
    expect(mustVerifyBeforeWrite({ slotId: 'autosave', options: { expectedRevision: 3 }, verifyExisting: true }), 'first autosave of a session').toBe(true);
    expect(mustVerifyBeforeWrite({ slotId: 'autosave', options: {} }), 'no expectation at all').toBe(true);
    expect(mustVerifyBeforeWrite({ slotId: 'manual-1', options: {} }), 'manual saves never rotate').toBe(false);
  });

  it('keeps the autosave before the newest one in the previous slot', async () => {
    const store = new MemorySaveStore();
    await store.init();
    expect((await persist(store, autosaveJob(1, { options: { expectedRevision: null } }))).ok).toBe(true);
    expect((await persist(store, autosaveJob(2, { options: { expectedRevision: 1 } }))).ok).toBe(true);
    const third = await persist(store, autosaveJob(3, { options: { expectedRevision: 2 } }));
    expect(third.ok && third.meta.revision, 'the autosave revision keeps counting').toBe(3);
    expect(tickOf((await store.read('autosave')).payload), 'newest').toBe(3);
    expect(tickOf((await store.read('autosave-previous')).payload), 'the one before it').toBe(2);
    const rows = await store.list();
    expect(rows.map((row) => [row.id, row.kind]), 'two autosave rows').toEqual([['autosave', 'auto'], ['autosave-previous', 'auto']]);
    expect(storedSaveProblem((await store.read('autosave-previous')).payload), 'the moved save is intact').toBeNull();
  });

  it('does not rotate a damaged autosave: the write is refused and the good previous generation stays', async () => {
    const store = new MemorySaveStore();
    await store.init();
    await persist(store, autosaveJob(1));
    await persist(store, autosaveJob(2, { options: { expectedRevision: 1 } }));
    const meta = (await store.list())[0];
    await store.write('autosave', { garbage: true }, meta, { expectedRevision: 2 });
    for (const options of [{ expectedRevision: 3 }, {}]) {
      const result = await persist(store, autosaveJob(4, { verifyExisting: options.expectedRevision !== undefined, options }));
      expect(result.ok === false && result.error.code, `refused (${JSON.stringify(options)})`).toBe('unreadable-slot');
      expect((await store.read('autosave')).payload, 'damaged record kept for quarantine').toEqual({ garbage: true });
      expect(tickOf((await store.read('autosave-previous')).payload), 'good previous generation untouched').toBe(1);
    }
  });

  it('never writes the previous slot directly', async () => {
    const store = new MemorySaveStore();
    await store.init();
    const result = await persist(store, autosaveJob(1, { slotId: 'autosave-previous' }));
    expect(result.ok === false && result.error.message, 'read-only').toContain('read-only');
    expect(await store.list(), 'nothing written').toEqual([]);
  });

  it('does not rotate manual saves', async () => {
    const store = new MemorySaveStore();
    await store.init();
    await persist(store, autosaveJob(1, { slotId: 'manual-1', name: 'Mine' }));
    await persist(store, autosaveJob(2, { slotId: 'manual-1', name: 'Mine' }));
    expect((await store.list()).map((row) => row.id), 'one manual slot').toEqual(['manual-1']);
  });
});
