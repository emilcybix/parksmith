import { describe, expect, it, vi } from 'vitest';
import { ParkSession } from '../../game/session/ParkSession';
import { SCENARIO_BY_ID } from '../../game/scenarios/content';
import { SAVE_SCHEMA_VERSION, SaveError, createParkSave } from '../../game/save/version';
import { loadFailureFrom, loadParkFromPayload } from './loadSave';
import { MemorySaveStore } from './memorySaveStore';
import { sealRequest } from './saveWorker';
import {
  computeStateSeal,
  createHashingWriter,
  createStateHasher,
  type HasherWorker,
  type StateHasher,
} from './SaveManager';
import type { PersistJob } from './types';

/** A real (small) park, so the envelope the writer builds is compared with the one src/game builds. */
const realSession = (): ParkSession => {
  const definition = [...SCENARIO_BY_ID.values()][0];
  const session = new ParkSession(definition);
  session.guests.spawnGuests(5);
  return session;
};

const jobFor = (session: ParkSession): PersistJob => ({
  jobId: 1,
  slotId: 'manual-1',
  state: session.serialize(),
  app: { clock: { speed: 1, simulationTimeMs: 4200 }, tourNodeId: null },
  savedAtEpochMs: 1_700_000_000_000,
  name: 'Real',
  scenarioName: 'Real park',
  guestCount: 5,
  cash: 100,
  rating: 40,
  writerTabId: 'tab',
  options: {},
});

describe('loadParkFromPayload', () => {
  it('rebuilds a fresh session from a stored envelope and leaves the source alone', () => {
    const source = realSession();
    const save = createParkSave(source.serialize(), { clock: { speed: 2, simulationTimeMs: 900 }, tourNodeId: null }, 5);
    const loaded = loadParkFromPayload(structuredClone(save));
    expect(loaded.session, 'a different object').not.toBe(source);
    expect(loaded.save.app.clock.speed).toBe(2);
    expect(loaded.contentDrift).toBe('none');
    expect(loaded.session.guests.guests.size, 'the guests came back').toBe(source.guests.guests.size);
  });

  it('throws SaveError for every kind of damage, and the mapper turns each into player text', () => {
    const good = createParkSave(realSession().serialize(), { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 5);
    const cases: Array<[string, unknown, string]> = [
      ['not an object', 'banana', 'not-a-save'],
      ['too new', { ...good, schemaVersion: SAVE_SCHEMA_VERSION + 1 }, 'too-new'],
      ['tampered state', { ...good, state: { ...good.state, seed: good.state.seed + 1 } }, 'corrupt'],
    ];
    for (const [label, payload, code] of cases) {
      let thrown: unknown = null;
      try { loadParkFromPayload(structuredClone(payload)); } catch (error) { thrown = error; }
      expect(thrown instanceof SaveError, `${label} throws a SaveError`).toBe(true);
      const description = loadFailureFrom(thrown);
      expect(description.code, label).toBe(code);
      expect(description.message.length, `${label} has player-facing text`).toBeGreaterThan(10);
      expect(description.unreadableCode, `${label} flags the slot`).toBe(code);
    }
  });

  it('maps unsynced and foreign errors without blaming the stored record', () => {
    expect(loadFailureFrom(new SaveError('unsynced', 'x')).unreadableCode).toBeNull();
    const foreign = loadFailureFrom(new TypeError('oops'));
    expect(foreign.code).toBe('unknown');
    expect(foreign.unreadableCode).toBeNull();
    expect(foreign.message).toContain('oops');
  });
});

describe('the hashing writer', () => {
  it('builds exactly the envelope createParkSave builds, from a hash computed elsewhere', async () => {
    const store = new MemorySaveStore();
    const session = realSession();
    const job = jobFor(session);
    const hasher: StateHasher = {
      kind: 'idle',
      seal: async (state) => computeStateSeal(state),
      dispose: () => undefined,
    };
    const result = await createHashingWriter(store, hasher).persist(job);
    expect(result.ok).toBe(true);
    const stored = (await store.read('manual-1')).payload;
    expect(stored, 'the envelope must not drift from src/game/save/version.ts').toEqual(
      createParkSave(job.state, job.app, job.savedAtEpochMs),
    );
    if (result.ok) {
      expect(result.meta.revision).toBe(1);
      expect(result.meta.playtimeSeconds).toBe(4.2);
      expect(result.meta.sizeBytes).toBe(JSON.stringify(job.state).length);
    }
    const reloaded = loadParkFromPayload(stored);
    expect(reloaded.session.guests.guests.size, 'what the writer wrote loads').toBe(5);
  });
});

describe('the state hasher', () => {
  const state = realSession().serialize();

  class FakeWorker implements HasherWorker {
    onmessage: HasherWorker['onmessage'] = null;
    onerror: HasherWorker['onerror'] = null;
    posted: Array<{ id: number }> = [];
    terminated = false;
    postMessage(message: { id: number }): void { this.posted.push(message); }
    terminate(): void { this.terminated = true; }
  }

  const immediate = (callback: () => void): void => { callback(); };

  it('uses the worker reply when there is one', async () => {
    const worker = new FakeWorker();
    const hasher = createStateHasher({ createWorker: () => worker, schedule: immediate });
    expect(hasher.kind).toBe('worker');
    const pending = hasher.seal(state);
    worker.onmessage?.({ data: { id: worker.posted[0].id, ok: true, stateHash: 'abc', sizeBytes: 9, hashMs: 2 } });
    expect(await pending).toEqual({ stateHash: 'abc', sizeBytes: 9, hashMs: 2 });
  });

  it('falls back to the main thread without a Worker, with the same hash the worker would give', async () => {
    const hasher = createStateHasher({ createWorker: () => null, schedule: immediate });
    expect(hasher.kind).toBe('idle');
    const seal = await hasher.seal(state);
    const reply = sealRequest({ id: 1, state });
    expect(reply.ok && reply.stateHash, 'worker and fallback agree').toBe(seal.stateHash);
  });

  it('a worker that fails to construct, errors, or answers with an error never loses the job', async () => {
    const throwing = createStateHasher({ createWorker: () => { throw new Error('no workers'); }, schedule: immediate });
    expect(throwing.kind).toBe('idle');
    expect((await throwing.seal(state)).stateHash).toHaveLength(16);

    const crashing = new FakeWorker();
    const hasher = createStateHasher({ createWorker: () => crashing, schedule: immediate });
    const pending = hasher.seal(state);
    crashing.onerror?.(new Error('script failed to load'));
    expect((await pending).stateHash, 'in-flight job re-run on the main thread').toHaveLength(16);
    expect(crashing.terminated).toBe(true);
    expect(hasher.kind, 'later jobs go straight to the fallback').toBe('idle');

    const replying = new FakeWorker();
    const second = createStateHasher({ createWorker: () => replying, schedule: immediate });
    const secondPending = second.seal(state);
    replying.onmessage?.({ data: { id: replying.posted[0].id, ok: false, message: 'hash threw' } });
    expect((await secondPending).stateHash).toHaveLength(16);
  });

  it('a worker that never answers is abandoned after the job timeout', async () => {
    vi.useFakeTimers();
    try {
      const worker = new FakeWorker();
      const hasher = createStateHasher({ createWorker: () => worker, schedule: immediate, jobTimeoutMs: 1000 });
      const pending = hasher.seal(state);
      await vi.advanceTimersByTimeAsync(1001);
      expect((await pending).stateHash).toHaveLength(16);
      expect(worker.terminated).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects after dispose instead of hanging', async () => {
    const hasher = createStateHasher({ createWorker: () => null, schedule: immediate });
    hasher.dispose();
    await expect(hasher.seal(state)).rejects.toThrow(/disposed/);
  });
});
