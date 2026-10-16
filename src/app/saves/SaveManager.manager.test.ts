import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ParkSaveV4 } from '../../game/save/state';
import { SAVE_CONTENT_VERSION, SAVE_SCHEMA_VERSION, SaveError, type ParkSave } from '../../game/save/version';
import {
  AUTOSAVE_INTERVAL_SECONDS,
  HIDDEN_AUTOSAVE_MIN_GAP_SECONDS,
  AUTOSAVE_MIN_GAP_SECONDS,
  MANUAL_SLOT_IDS,
  START_AUTOSAVE_DELAY_SECONDS,
  UNSAVED_PROGRESS_SIMULATED_SECONDS,
} from './constants';
import { MemorySaveStore } from './memorySaveStore';
import { makeSlotMeta } from './fakeIndexedDb.storeSupport';
import {
  SaveManager,
  createHashingWriter,
  type LoadModule,
  type SaveChannel,
  type SaveChannelMessage,
  type StateHasher,
  type StateSeal,
} from './SaveManager';
import {
  StoreError,
  type CapturedPark,
  type LoadedPark,
  type SaveEvent,
  type SaveHost,
  type SavesSnapshot,
  type SaveSlotMeta,
  type StoreWriteOptions,
} from './types';

/**
 * The manager is driven entirely through ports, so these tests use fake timers, the store
 * builder's MemorySaveStore, a real hashing writer over a controllable hasher, and a scripted host.
 */

const SECOND = 1000;

interface Gate {
  resolve(): void;
  promise: Promise<void>;
}
const gate = (): Gate => {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { resolve, promise };
};

/** A store whose next write can be made to fail, and whose writes are counted and checked for overlap. */
class TestStore extends MemorySaveStore {
  nextWriteError: StoreError | null = null;
  writes: string[] = [];
  activeWrites = 0;
  maxActiveWrites = 0;
  writeDelay: Gate | null = null;
  /** Runs once, just before the next move, to model another tab taking the free slot first. */
  beforeMove: ((to: string) => void) | null = null;
  moves: Array<[string, string]> = [];

  override async move(from: SaveSlotMetaId, to: SaveSlotMetaId): Promise<void> {
    const hook = this.beforeMove;
    this.beforeMove = null;
    hook?.(to);
    this.moves.push([from, to]);
    return super.move(from, to);
  }

  override async write(id: SaveSlotMetaId, payload: unknown, meta: SaveSlotMeta, options?: StoreWriteOptions): Promise<void> {
    this.activeWrites += 1;
    this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    try {
      if (this.writeDelay) await this.writeDelay.promise;
      if (this.nextWriteError) {
        const error = this.nextWriteError;
        this.nextWriteError = null;
        throw error;
      }
      await super.write(id, payload, meta, options);
      this.writes.push(id);
    } finally {
      this.activeWrites -= 1;
    }
  }
}
type SaveSlotMetaId = SaveSlotMeta['id'];

class TestHasher implements StateHasher {
  kind = 'worker' as const;
  sealed = 0;
  hold: Gate | null = null;
  failWith: Error | null = null;
  async seal(): Promise<StateSeal> {
    this.sealed += 1;
    if (this.hold) await this.hold.promise;
    if (this.failWith) throw this.failWith;
    return { stateHash: '0123456789abcdef', sizeBytes: 1234, hashMs: 1 };
  }
  dispose(): void {}
}

class TestHost implements SaveHost {
  park = true;
  version = 0;
  tickValue = 0;
  captures = 0;
  captureError: Error | null = null;
  installed: LoadedPark[] = [];
  installError: Error | null = null;
  tourNodeId: CapturedPark['app']['tourNodeId'] = null;
  hasPark(): boolean { return this.park; }
  worldVersion(): number { return this.version; }
  tick(): number { return this.tickValue; }
  isRunning(): boolean { return true; }
  now(): number { return Date.now(); }
  capture(): CapturedPark {
    this.captures += 1;
    if (this.captureError) throw this.captureError;
    return {
      state: { scenarioId: null, world: { tick: this.tickValue }, marker: this.captures } as unknown as ParkSaveV4,
      app: { clock: { speed: 1, simulationTimeMs: this.tickValue * 100 }, tourNodeId: this.tourNodeId },
      scenarioName: 'Sandbox park',
      guestCount: 3,
      cash: 1234,
      rating: 55,
      worldVersion: this.version,
      tick: this.tickValue,
    };
  }
  installLoaded(loaded: LoadedPark): void {
    if (this.installError) throw this.installError;
    this.installed.push(loaded);
  }
}

class TestChannel implements SaveChannel {
  posted: SaveChannelMessage[] = [];
  listener: ((message: SaveChannelMessage) => void) | null = null;
  post(message: SaveChannelMessage): void { this.posted.push(message); }
  onMessage(listener: (message: SaveChannelMessage) => void): void { this.listener = listener; }
  close(): void {}
}

interface Rig {
  manager: SaveManager;
  host: TestHost;
  store: TestStore;
  hasher: TestHasher;
  channel: TestChannel;
  events: SaveEvent[];
  published: SavesSnapshot[];
  loadModule: LoadModule;
  loadCalls: number;
}

const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
};

/** Runs frames of `seconds` real time, in 1-second slices, as the ticker would. */
const runFrames = async (rig: Rig, seconds: number): Promise<void> => {
  for (let elapsed = 0; elapsed < seconds; elapsed += 1) {
    rig.manager.frame(SECOND);
    await vi.advanceTimersByTimeAsync(SECOND);
  }
};

const makeRig = async (overrides: { loaded?: () => LoadedPark } = {}): Promise<Rig> => {
  const host = new TestHost();
  const store = new TestStore();
  const hasher = new TestHasher();
  const channel = new TestChannel();
  const events: SaveEvent[] = [];
  const published: SavesSnapshot[] = [];
  const rig = { loadCalls: 0 } as Rig;
  const loadModule: LoadModule = {
    loadParkFromPayload: (payload) => {
      if (overrides.loaded) return overrides.loaded();
      if ((payload as { poison?: boolean }).poison) throw new SaveError('corrupt', 'bad');
      return { session: {} as LoadedPark['session'], save: payload as ParkSave, contentDrift: 'none' };
    },
    loadFailureFrom: (error) => (error instanceof SaveError
      ? { code: error.code, message: `text for ${error.code}`, unreadableCode: error.code }
      : { code: 'unknown', message: 'boom', unreadableCode: null }),
  };
  const manager = new SaveManager({
    host,
    store,
    writer: createHashingWriter(store, hasher),
    publish: (snapshot) => { published.push(snapshot); },
    loadModule: () => { rig.loadCalls += 1; return Promise.resolve(loadModule); },
    tabId: 'tab-a',
    createChannel: () => channel,
  });
  manager.subscribe((event) => events.push(event));
  Object.assign(rig, { manager, host, store, hasher, channel, events, published, loadModule });
  await manager.init();
  await flush();
  return rig;
};

const kinds = (rig: Rig): string[] => rig.events.map((event) => event.type);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('autosave schedule', () => {
  it('never captures a clean park, however long it runs', async () => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    await runFrames(rig, 600);
    expect(rig.host.captures, 'a clean park is never serialized').toBe(0);
  });

  it('first autosave waits START_AUTOSAVE_DELAY_SECONDS of dirty time, then writes the autosave slot', async () => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 5;
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS - 1);
    expect(rig.host.captures, 'not due one second early').toBe(0);
    await runFrames(rig, 1);
    await flush();
    expect(rig.host.captures).toBe(1);
    const slots = await rig.store.list();
    expect(slots.map((slot) => slot.id)).toEqual(['autosave']);
    expect(slots[0].name).toBe('Autosave');
    expect(slots[0].revision).toBe(1);
    expect(slots[0].playtimeSeconds, 'playtime is park time from the clock').toBe(0.5);
  });

  it('later autosaves follow the interval, not the start delay', async () => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 1;
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    expect(rig.host.captures).toBe(1);
    rig.host.tickValue = 2;
    await runFrames(rig, AUTOSAVE_INTERVAL_SECONDS - 1);
    expect(rig.host.captures, 'interval not yet elapsed').toBe(1);
    await runFrames(rig, 1);
    await flush();
    expect(rig.host.captures).toBe(2);
    expect((await rig.store.list())[0].revision, 'each write increments the slot revision').toBe(2);
  });

  it('a loaded park is not dirty until something changes', async () => {
    const rig = await makeRig();
    rig.host.tickValue = 40;
    rig.host.version = 7;
    rig.manager.notifyParkStarted();
    await runFrames(rig, 200);
    expect(rig.host.captures).toBe(0);
    rig.host.version = 8;
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    expect(rig.host.captures, 'one edit makes the park dirty').toBe(1);
  });

  it('a scenario result saves at the next frame even though the park is clean, but respects the minimum gap', async () => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 1;
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    expect(rig.host.captures).toBe(1);
    // Park is now clean (baseline = captured tick), the result arrives 1 s after the last attempt.
    rig.manager.notifyScenarioResult();
    await runFrames(rig, AUTOSAVE_MIN_GAP_SECONDS - 3);
    expect(rig.host.captures, 'inside the min gap').toBe(1);
    await runFrames(rig, 5);
    await flush();
    expect(rig.host.captures, 'saved once the gap passed').toBe(2);
    await runFrames(rig, 60);
    expect(rig.host.captures, 'the safe point fires once per result').toBe(2);
  });

  it('flushOnHide saves a dirty park once and ignores a clean or busy one', async () => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    rig.manager.flushOnHide();
    expect(rig.host.captures, 'clean: nothing to flush').toBe(0);
    rig.host.version = 1;
    rig.manager.flushOnHide();
    rig.manager.flushOnHide();
    await flush();
    expect(rig.host.captures, 'the second call finds a save in flight or inside the gap').toBe(1);
    expect(rig.events.some((event) => event.type === 'saved' && event.reason === 'hidden')).toBe(true);
  });

  it('autosaveNow (Phase 23) writes a changed park at once, inside the minimum gap, and does nothing for a clean one', async () => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    await rig.manager.autosaveNow();
    expect(rig.host.captures, 'clean: nothing to write').toBe(0);
    rig.host.version = 1;
    await rig.manager.autosaveNow();
    expect(rig.host.captures).toBe(1);
    rig.host.version = 2;
    await rig.manager.autosaveNow();
    expect(rig.host.captures, 'the 20 s gap does not apply').toBe(2);
    rig.manager.notifyScenarioResult();
    await rig.manager.autosaveNow();
    expect(rig.host.captures, 'a pending safe point is written even for a clean park').toBe(3);
  });

  it('autosaveNow never throws, even when the host does', async () => {
    const rig = await makeRig();
    rig.host.version = 1;
    rig.host.hasPark = () => { throw new Error('host gone'); };
    await expect(rig.manager.autosaveNow()).resolves.toBeUndefined();
  });

  it('flushOnHide never throws, even when the host does', async () => {
    const rig = await makeRig();
    rig.host.version = 1;
    rig.host.hasPark = () => { throw new Error('host gone'); };
    expect(() => rig.manager.flushOnHide()).not.toThrow();
  });

  it('a capture failure reports failed and retries at the next interval, never in a tight loop', async () => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 1;
    rig.host.captureError = new SaveError('unsynced', 'owners lag');
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    expect(rig.host.captures).toBe(1);
    const failed = rig.events.find((event) => event.type === 'failed');
    expect(failed && failed.type === 'failed' && failed.error.code, 'SaveError code travels through').toBe('unsynced');
    await runFrames(rig, 30);
    expect(rig.host.captures, 'no retry before the interval').toBe(1);
    rig.host.captureError = null;
    await runFrames(rig, AUTOSAVE_INTERVAL_SECONDS);
    await flush();
    expect(rig.events.some((event) => event.type === 'saved')).toBe(true);
  });
});

describe('single flight and coalescing', () => {
  it('queues a save behind the one in flight, captures it fresh, and never overlaps writes', async () => {
    const rig = await makeRig();
    rig.hasher.hold = gate();
    const first = rig.manager.saveToSlot('manual-1', 'First');
    await flush();
    expect(rig.host.captures).toBe(1);
    rig.host.tickValue = 99;
    const second = rig.manager.saveToSlot('manual-2', 'Second');
    const third = rig.manager.saveToSlot('manual-2', 'Second again');
    await flush();
    expect(rig.host.captures, 'queued saves have not captured yet').toBe(1);
    const release = rig.hasher.hold;
    rig.hasher.hold = null;
    release.resolve();
    const [a, b, c] = await Promise.all([first, second, third]);
    expect(a.ok && b.ok && c.ok).toBe(true);
    expect(rig.host.captures, 'two requests for one slot coalesce into one capture').toBe(2);
    expect(rig.store.maxActiveWrites, 'writes never overlap').toBe(1);
    expect(rig.store.writes).toEqual(['manual-1', 'manual-2']);
    const rows = await rig.store.list();
    expect(rows.find((row) => row.id === 'manual-2')?.name, 'the newest name wins').toBe('Second again');
    expect(rows.find((row) => row.id === 'manual-2')?.savedAtTick, 'the queued save captured fresh state').toBe(99);
  });

  it('the dirty baseline comes from the captured state, not the live park', async () => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 1;
    rig.hasher.hold = gate();
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    rig.host.tickValue = 50; // the park keeps running while the write is in progress
    rig.host.version = 3;
    rig.hasher.hold.resolve();
    rig.hasher.hold = null;
    await flush();
    expect(rig.events.some((event) => event.type === 'saved')).toBe(true);
    await runFrames(rig, AUTOSAVE_INTERVAL_SECONDS);
    await flush();
    expect(rig.host.captures, 'the progress made during the write is still unsaved, so it saves again').toBe(2);
  });

  it('refuses a manual save without a park and an invalid slot id', async () => {
    const rig = await makeRig();
    rig.host.park = false;
    const noPark = await rig.manager.saveToSlot('manual-1');
    expect(noPark.ok ? null : noPark.error.code).toBe('no-park');
    rig.host.park = true;
    const invalid = await rig.manager.saveToSlot('autosave' as never);
    expect(invalid.ok ? null : invalid.error.code).toBe('invalid-slot');
  });
});

describe('storage failure', () => {
  it('quota: tells the player, keeps the park running, stops autosaving, and Retry restores it', async () => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 1;
    rig.store.nextWriteError = new StoreError('quota', 'Storage is full');
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    expect(kinds(rig)).toContain('persistence-unavailable');
    const snapshot = rig.manager.snapshot();
    expect(snapshot.persistence.state).toBe('unavailable');
    expect(snapshot.persistence.code).toBe('quota');
    expect(snapshot.autosave.state, 'autosave stops trying').toBe('off');
    const before = rig.host.captures;
    await runFrames(rig, AUTOSAVE_INTERVAL_SECONDS * 2);
    expect(rig.host.captures, 'no capture while persistence is unavailable').toBe(before);
    rig.manager.dismissBanner();
    expect(rig.manager.snapshot().persistence.bannerDismissed).toBe(true);
    await rig.manager.retryPersistence();
    await flush();
    expect(kinds(rig)).toContain('persistence-restored');
    expect(rig.manager.snapshot().persistence.state).toBe('ready');
    expect((await rig.store.list()).map((slot) => slot.id), 'retry saved at once').toEqual(['autosave']);
  });

  it('a manual save that fails reports the code and does not break the next one', async () => {
    const rig = await makeRig();
    rig.store.nextWriteError = new StoreError('quota', 'Storage is full');
    const failed = await rig.manager.saveToSlot('manual-3', 'Big');
    expect(failed.ok ? null : failed.error.code).toBe('quota');
    expect(rig.manager.snapshot().notice?.kind).toBe('error');
    const ok = await rig.manager.saveToSlot('manual-3', 'Big');
    expect(ok.ok, 'the store stays usable after a failure').toBe(true);
    expect(rig.manager.snapshot().persistence.state, 'a successful write proves storage works').toBe('ready');
  });

  it('a store that cannot open surfaces unavailable without throwing from init', async () => {
    const host = new TestHost();
    const store = new TestStore();
    store.setFallbackReason({ code: 'unavailable', message: 'private mode' });
    const manager = new SaveManager({
      host, store, writer: createHashingWriter(store, new TestHasher()), publish: () => undefined, createChannel: () => null,
    });
    await expect(manager.init()).resolves.toBeUndefined();
    expect(manager.snapshot().persistence).toMatchObject({ state: 'unavailable', code: 'unavailable', message: 'private mode' });
  });

  it('a hasher that fails reports seal-failed', async () => {
    const rig = await makeRig();
    rig.hasher.failWith = new Error('hash blew up');
    const result = await rig.manager.saveToSlot('manual-1');
    expect(result.ok ? null : result.error.code).toBe('seal-failed');
    expect(await rig.store.list(), 'nothing half written').toEqual([]);
  });
});

describe('multi-tab and unreadable slots', () => {
  it('an autosave conflict suspends autosave until the player resumes it here', async () => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 1;
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    // Another tab writes the autosave slot behind our back.
    const other = new TestStore();
    expect(other).toBeDefined();
    await rig.store.write('autosave', { x: 1 }, { ...(await rig.store.list())[0] }, {});
    rig.host.tickValue = 2;
    await runFrames(rig, AUTOSAVE_INTERVAL_SECONDS);
    await flush();
    expect(kinds(rig)).toContain('autosave-conflict');
    expect(rig.manager.snapshot().autosave.state).toBe('suspended');
    expect(rig.manager.snapshot().lastError?.code).toBe('conflict');
    const captures = rig.host.captures;
    await runFrames(rig, AUTOSAVE_INTERVAL_SECONDS);
    expect(rig.host.captures, 'suspended means no further attempts').toBe(captures);
    rig.manager.resumeAutosaveHere();
    await flush();
    expect(rig.manager.snapshot().autosave.state).toBe('waiting');
    await runFrames(rig, AUTOSAVE_INTERVAL_SECONDS);
    await flush();
    expect(kinds(rig).filter((type) => type === 'saved').length, 'autosave works again after resuming').toBeGreaterThan(1);
  });

  it('another tab changing slots triggers a refresh; our own message does not', async () => {
    const rig = await makeRig();
    const spy = vi.spyOn(rig.store, 'list');
    rig.channel.listener?.({ type: 'changed', tabId: 'tab-a' });
    await flush();
    expect(spy).not.toHaveBeenCalled();
    rig.channel.listener?.({ type: 'changed', tabId: 'tab-b' });
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('an unreadable autosave is moved to a free manual slot, never overwritten', async () => {
    const rig = await makeRig();
    rig.store.seedRaw('autosave', { id: 'autosave', kind: 'auto', name: 'Autosave', status: { state: 'unreadable', code: 'corrupt', message: 'damaged' }, revision: 4, scenarioId: null, scenarioName: 'x', playtimeSeconds: 1, savedAt: 1, schemaVersion: 1, contentVersion: 1, savedAtTick: 1, guestCount: 1, cash: 1, rating: 1, sizeBytes: 1, writerTabId: 'z' }, { garbage: true });
    await rig.manager.refresh();
    expect(rig.manager.snapshot().slots[0].status.state).toBe('unreadable');
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 1;
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    const rows = await rig.store.list();
    expect(rows.map((row) => row.id)).toEqual(['autosave', 'manual-1']);
    expect(rows[1].status.state, 'the damaged record is kept, still flagged').toBe('unreadable');
    expect((await rig.store.read('manual-1')).payload, 'raw payload preserved').toEqual({ garbage: true });
    expect(rows[0].status.state).toBe('ok');
  });

  it('with no free manual slot, an unreadable autosave pauses autosave instead of replacing it', async () => {
    const rig = await makeRig();
    for (const id of MANUAL_SLOT_IDS) {
      expect((await rig.manager.saveToSlot(id, id)).ok).toBe(true);
    }
    rig.store.seedRaw('autosave', { id: 'autosave', kind: 'auto', name: 'Autosave', status: { state: 'unreadable', code: 'corrupt', message: 'damaged' }, revision: 1, scenarioId: null, scenarioName: 'x', playtimeSeconds: 1, savedAt: 1, schemaVersion: 1, contentVersion: 1, savedAtTick: 1, guestCount: 1, cash: 1, rating: 1, sizeBytes: 1, writerTabId: 'z' }, { garbage: true });
    await rig.manager.refresh();
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 1;
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    expect(rig.manager.snapshot().autosave.state).toBe('suspended');
    expect((await rig.store.read('autosave')).payload, 'untouched').toEqual({ garbage: true });
    const deleted = await rig.manager.remove('autosave');
    expect(deleted.ok).toBe(true);
    expect(rig.manager.snapshot().autosave.state, 'deleting the bad slot lifts the suspension').toBe('waiting');
  });

  it('a manual save onto an unreadable slot needs explicit confirmation', async () => {
    const rig = await makeRig();
    rig.store.seedRaw('manual-2', { id: 'manual-2', kind: 'manual', name: 'Old', status: { state: 'unreadable', code: 'corrupt', message: 'damaged' }, revision: 1, scenarioId: null, scenarioName: 'x', playtimeSeconds: 1, savedAt: 1, schemaVersion: 1, contentVersion: 1, savedAtTick: 1, guestCount: 1, cash: 1, rating: 1, sizeBytes: 1, writerTabId: 'z' }, { garbage: true });
    await rig.manager.refresh();
    const refused = await rig.manager.saveToSlot('manual-2');
    expect(refused.ok ? null : refused.error.code).toBe('slot-unreadable');
    const confirmed = await rig.manager.saveToSlot('manual-2', 'New', { confirmedReplaceUnreadable: true });
    expect(confirmed.ok).toBe(true);
  });
});

describe('quick save, rename and delete', () => {
  it('quick save targets the first free slot, then keeps overwriting the slot it chose', async () => {
    const rig = await makeRig();
    expect(rig.manager.snapshot().quickSaveSlotId).toBe('manual-1');
    const first = await rig.manager.quickSave();
    expect(first.ok && first.value.id).toBe('manual-1');
    await rig.manager.saveToSlot('manual-2', 'Two');
    expect(rig.manager.snapshot().quickSaveSlotId, 'the last manual slot saved to').toBe('manual-2');
    const again = await rig.manager.quickSave();
    expect(again.ok && again.value.id).toBe('manual-2');
  });

  it('a new park forgets the chosen slot so it cannot silently overwrite the old park', async () => {
    const rig = await makeRig();
    await rig.manager.saveToSlot('manual-1', 'One');
    rig.manager.notifyParkStarted();
    expect(rig.manager.snapshot().quickSaveSlotId, 'manual-1 is taken, so the next free one').toBe('manual-2');
  });

  it('with every slot full and none chosen, quick save refuses with a clear message', async () => {
    const rig = await makeRig();
    for (const id of MANUAL_SLOT_IDS) await rig.manager.saveToSlot(id, id);
    rig.manager.notifyParkStarted();
    expect(rig.manager.snapshot().quickSaveSlotId).toBeNull();
    const result = await rig.manager.quickSave();
    expect(result.ok ? null : result.error.message).toBe('All slots are full: choose one to replace.');
  });

  it('keeps the player\'s name when a slot is overwritten without a new one', async () => {
    const rig = await makeRig();
    await rig.manager.saveToSlot('manual-1', 'Coaster Valley');
    const again = await rig.manager.saveToSlot('manual-1');
    expect(again.ok && again.value.name).toBe('Coaster Valley');
  });

  it('cuts long names and rejects empty ones on rename', async () => {
    const rig = await makeRig();
    await rig.manager.saveToSlot('manual-1', 'x'.repeat(100));
    expect((await rig.store.list())[0].name).toHaveLength(40);
    const renamed = await rig.manager.rename('manual-1', '  Better  ');
    expect(renamed.ok && renamed.value.name).toBe('Better');
    expect(rig.manager.snapshot().slots[0].name).toBe('Better');
    const empty = await rig.manager.rename('manual-1', '   ');
    expect(empty.ok).toBe(false);
  });

  it('delete removes the row and tells other tabs; deleting an in-flight slot is refused', async () => {
    const rig = await makeRig();
    await rig.manager.saveToSlot('manual-1', 'One');
    rig.hasher.hold = gate();
    const saving = rig.manager.saveToSlot('manual-2', 'Two');
    await flush();
    const busy = await rig.manager.remove('manual-2');
    expect(busy.ok ? null : busy.error.code).toBe('busy');
    rig.hasher.hold.resolve();
    rig.hasher.hold = null;
    await saving;
    const removed = await rig.manager.remove('manual-1');
    expect(removed.ok).toBe(true);
    expect(rig.manager.snapshot().slots.map((row) => row.id)).toEqual(['manual-2']);
    expect(rig.channel.posted.length, 'every successful change is broadcast').toBeGreaterThanOrEqual(3);
  });
});

describe('load', () => {
  const planted = async (rig: Rig, payload: unknown, id: 'manual-1' | 'autosave' = 'manual-1'): Promise<void> => {
    const meta = (await (async () => {
      await rig.manager.saveToSlot('manual-9', 'seed');
      return (await rig.store.list())[0];
    })());
    rig.store.seedRaw(id, { ...meta, id, kind: id === 'autosave' ? 'auto' : 'manual', name: 'Planted' }, payload);
    await rig.manager.refresh();
  };

  it('installs the loaded park once and reports drift', async () => {
    const save = { app: { tourNodeId: 'tour-1' }, scenarioId: null } as unknown as ParkSave;
    const rig = await makeRig({ loaded: () => ({ session: {} as LoadedPark['session'], save, contentDrift: 'older' }) });
    await planted(rig, { schemaVersion: 1 });
    const result = await rig.manager.load('manual-1');
    expect(result.ok && result.value.contentDrift).toBe('older');
    expect(rig.host.installed).toHaveLength(1);
    expect(rig.host.installed[0].save.app.tourNodeId, 'the envelope reaches the host intact').toBe('tour-1');
    expect(rig.manager.snapshot().quickSaveSlotId, 'a loaded manual slot becomes the quick-save slot').toBe('manual-1');
    expect(rig.manager.snapshot().notice?.text).toContain('older balance');
    expect(kinds(rig)).toContain('loaded');
    expect(rig.manager.snapshot().busy.loading).toBeNull();
  });

  it('a corrupt save fails typed, leaves the host untouched and marks the slot unreadable for good', async () => {
    const rig = await makeRig();
    await planted(rig, { poison: true });
    const result = await rig.manager.load('manual-1');
    expect(result.ok ? null : result.error.code).toBe('corrupt');
    expect(rig.host.installed, 'the live park is untouched').toHaveLength(0);
    const row = (await rig.store.list()).find((slot) => slot.id === 'manual-1');
    expect(row?.status, 'the reason survives a reload').toMatchObject({ state: 'unreadable', code: 'corrupt' });
    expect((await rig.store.read('manual-1')).payload, 'the raw record is kept').toEqual({ poison: true });
    expect(rig.manager.snapshot().slots.find((slot) => slot.id === 'manual-1')?.status.state).toBe('unreadable');
  });

  it('an install that throws is a failed load, not a crash', async () => {
    const rig = await makeRig();
    await planted(rig, { fine: true });
    rig.host.installError = new Error('renderer exploded');
    const result = await rig.manager.load('manual-1');
    expect(result.ok ? null : result.error.code).toBe('unknown');
    expect(rig.manager.snapshot().slots.find((slot) => slot.id === 'manual-1')?.status.state, 'a bug is not the save\'s fault').toBe('ok');
  });

  it('a missing slot is not-found and a second load while loading is busy', async () => {
    const rig = await makeRig();
    const missing = await rig.manager.load('manual-5');
    expect(missing.ok ? null : missing.error.code).toBe('not-found');
    await planted(rig, { fine: true });
    const first = rig.manager.load('manual-1');
    const second = await rig.manager.load('manual-1');
    expect(second.ok ? null : second.error.code).toBe('busy');
    expect((await first).ok).toBe(true);
  });

  it('waits for a save in flight before reading, and refuses new saves while loading', async () => {
    const rig = await makeRig();
    await planted(rig, { fine: true });
    rig.hasher.hold = gate();
    const saving = rig.manager.saveToSlot('manual-4', 'Pending');
    await flush();
    const loading = rig.manager.load('manual-1');
    await flush();
    expect(rig.host.installed, 'not installed while a save is in flight').toHaveLength(0);
    const refused = await rig.manager.saveToSlot('manual-5');
    expect(refused.ok ? null : refused.error.code).toBe('busy');
    rig.hasher.hold.resolve();
    rig.hasher.hold = null;
    await saving;
    expect((await loading).ok).toBe(true);
    expect(rig.host.installed).toHaveLength(1);
  });

  it('a failed load module fetch is a typed failure with a retryable message', async () => {
    const rig = await makeRig();
    await planted(rig, { fine: true });
    const manager = new SaveManager({
      host: rig.host, store: rig.store, writer: createHashingWriter(rig.store, rig.hasher), publish: () => undefined,
      loadModule: () => Promise.reject(new Error('chunk 404')), createChannel: () => null,
    });
    await manager.init();
    const result = await manager.load('manual-1');
    expect(result.ok ? null : result.error.message).toContain('chunk 404');
    expect(rig.host.installed).toHaveLength(0);
  });
});

describe('preview (the start screen\'s park)', () => {
  const planted = async (rig: Rig, payload: unknown, id: 'manual-1' | 'autosave' = 'manual-1'): Promise<void> => {
    await rig.manager.saveToSlot('manual-9', 'seed');
    const meta = (await rig.store.list())[0];
    rig.store.seedRaw(id, { ...meta, id, kind: id === 'autosave' ? 'auto' : 'manual', name: 'Planted' }, payload);
    await rig.manager.refresh();
  };

  it('builds the park without installing it, touching the quick-save slot or announcing a load', async () => {
    const save = { app: { tourNodeId: null }, scenarioId: null } as unknown as ParkSave;
    const rig = await makeRig({ loaded: () => ({ session: {} as LoadedPark['session'], save, contentDrift: 'none' }) });
    await planted(rig, { fine: true });
    const quickBefore = rig.manager.snapshot().quickSaveSlotId;
    const noticeBefore = rig.manager.snapshot().notice;
    const eventsBefore = kinds(rig).length;
    const result = await rig.manager.loadPreview('manual-1');
    expect(result.ok).toBe(true);
    expect(result.ok && result.value.slotId).toBe('manual-1');
    expect(result.ok && result.value.revision, 'the slot revision that was read').toBe((await rig.store.read('manual-1')).revision);
    expect(rig.host.installed, 'nothing is installed').toHaveLength(0);
    expect(rig.manager.snapshot().quickSaveSlotId).toBe(quickBefore);
    expect(rig.manager.snapshot().notice).toEqual(noticeBefore);
    expect(kinds(rig).slice(eventsBefore), 'no loaded event').not.toContain('loaded');
    expect(rig.manager.snapshot().busy.loading, 'the busy marker is for real loads').toBeNull();
  });

  it('a real load started while the backdrop preview is still reading waits for it instead of failing busy', async () => {
    const save = { app: { tourNodeId: null }, scenarioId: null } as unknown as ParkSave;
    const rig = await makeRig({ loaded: () => ({ session: {} as LoadedPark['session'], save, contentDrift: 'none' }) });
    await planted(rig, { fine: true });
    const preview = rig.manager.loadPreview('manual-1');
    const load = rig.manager.load('manual-1');
    const [previewResult, loadResult] = await Promise.all([preview, load]);
    expect(previewResult.ok).toBe(true);
    expect(loadResult.ok, loadResult.ok ? '' : loadResult.error.message).toBe(true);
    expect(rig.host.installed, 'the real load installed the park').toHaveLength(1);
    expect(rig.manager.snapshot().busy.loading).toBeNull();
    // Two real loads still refuse each other.
    const first = rig.manager.load('manual-1');
    const second = await rig.manager.load('manual-1');
    expect(second.ok).toBe(false);
    expect(!second.ok && second.error.code).toBe('busy');
    expect((await first).ok).toBe(true);
  });

  it('adoptPreview does the load bookkeeping (quick-save slot, notice, loaded event) without installing', async () => {
    const save = { app: { tourNodeId: null }, scenarioId: null } as unknown as ParkSave;
    const rig = await makeRig({ loaded: () => ({ session: {} as LoadedPark['session'], save, contentDrift: 'older' }) });
    await planted(rig, { fine: true });
    const preview = await rig.manager.loadPreview('manual-1');
    if (!preview.ok) throw new Error('preview failed');
    const summary = rig.manager.adoptPreview(preview.value);
    expect(summary).toMatchObject({ slotId: 'manual-1', contentDrift: 'older' });
    expect(rig.manager.snapshot().quickSaveSlotId).toBe('manual-1');
    expect(rig.manager.snapshot().notice?.text).toContain('older balance');
    expect(kinds(rig)).toContain('loaded');
    expect(rig.host.installed).toHaveLength(0);
  });

  it('a corrupt record fails typed and quietly, and is flagged unreadable exactly as a real load flags it', async () => {
    const rig = await makeRig();
    await planted(rig, { poison: true });
    const errorsBefore = rig.events.filter((event) => event.type === 'failed').length;
    const noticeBefore = rig.manager.snapshot().notice;
    const result = await rig.manager.loadPreview('manual-1');
    expect(result.ok ? null : result.error.code).toBe('corrupt');
    expect(rig.events.filter((event) => event.type === 'failed'), 'no failed event for the dialog or strip').toHaveLength(errorsBefore);
    expect(rig.manager.snapshot().lastError).toBeNull();
    expect(rig.manager.snapshot().notice, 'no error notice for the strip').toEqual(noticeBefore);
    expect((await rig.store.list()).find((slot) => slot.id === 'manual-1')?.status).toMatchObject({ state: 'unreadable', code: 'corrupt' });
    expect((await rig.store.read('manual-1')).payload, 'the raw record is kept').toEqual({ poison: true });
  });

  it('is busy while a real load runs, and a missing slot is not-found', async () => {
    const rig = await makeRig();
    await planted(rig, { fine: true });
    const missing = await rig.manager.loadPreview('manual-5');
    expect(missing.ok ? null : missing.error.code).toBe('not-found');
    const loading = rig.manager.load('manual-1');
    const preview = await rig.manager.loadPreview('manual-1');
    expect(preview.ok ? null : preview.error.code).toBe('busy');
    await loading;
  });
});

describe('snapshot publication', () => {
  it('publishes leading-edge, throttles bursts, and carries slots, unsaved flag and autosave state', async () => {
    const rig = await makeRig();
    await vi.advanceTimersByTimeAsync(500);
    rig.published.length = 0;
    rig.manager.notifyParkStarted();
    expect(rig.published.length, 'first change publishes immediately').toBe(1);
    rig.manager.notifyParkStarted();
    rig.manager.notifyParkStarted();
    expect(rig.published.length, 'a burst inside the interval waits').toBe(1);
    await vi.advanceTimersByTimeAsync(150);
    expect(rig.published.length, 'one trailing publish').toBe(2);
  });

  it('flags unsaved changes by edits at once and by progress only past the grace', async () => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    expect(rig.manager.snapshot().unsavedChanges).toBe(false);
    rig.host.tickValue = (UNSAVED_PROGRESS_SIMULATED_SECONDS * 10) - 1;
    expect(rig.manager.snapshot().unsavedChanges, 'a little progress is not an unsaved change').toBe(false);
    rig.host.tickValue += 5;
    expect(rig.manager.snapshot().unsavedChanges).toBe(true);
    rig.manager.notifyParkStarted();
    rig.host.version += 1;
    expect(rig.manager.snapshot().unsavedChanges, 'any world edit counts').toBe(true);
    await rig.manager.saveToSlot('manual-1', 'Save');
    expect(rig.manager.snapshot().unsavedChanges, 'a successful save to any slot clears it').toBe(false);
  });

  it('the snapshot describes slots with metadata only', async () => {
    const rig = await makeRig();
    await rig.manager.saveToSlot('manual-2', 'Metadata');
    const row = rig.manager.snapshot().slots[0];
    expect(row).toMatchObject({
      id: 'manual-2', name: 'Metadata', guestCount: 3, cash: 1234, rating: 55,
      schemaVersion: SAVE_SCHEMA_VERSION, contentVersion: SAVE_CONTENT_VERSION, scenarioName: 'Sandbox park',
    });
    expect(row.sizeBytes).toBe(1234);
    expect(JSON.stringify(rig.manager.snapshot()).length, 'no payload in the snapshot').toBeLessThan(3000);
  });

  it('stops everything on dispose', async () => {
    const rig = await makeRig();
    rig.manager.dispose();
    rig.host.version = 5;
    rig.manager.frame(1000 * 1000);
    expect(rig.host.captures).toBe(0);
    const result = await rig.manager.saveToSlot('manual-1');
    expect(result.ok).toBe(false);
  });
});

describe('two tabs and stale views', () => {
  /** What another tab writes into a slot behind this tab's back. */
  const writeAsOtherTab = async (rig: Rig, id: SaveSlotMetaId, marker: string): Promise<void> => {
    const template = (await rig.store.list())[0];
    const meta = { ...(template ?? { name: 'Other', scenarioName: 'Sandbox park' }), id, name: marker, writerTabId: 'tab-b' } as SaveSlotMeta;
    await rig.store.write(id, { marker }, meta, {});
  };

  it('a refresh that shows another tab\'s autosave does not make this tab\'s next autosave replace it silently', async () => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 1;
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    expect((await rig.store.list())[0].revision).toBe(1);
    await writeAsOtherTab(rig, 'autosave', 'tab-b park');
    rig.channel.listener?.({ type: 'changed', tabId: 'tab-b' });
    await flush();
    expect(rig.manager.snapshot().slots.find((row) => row.id === 'autosave')?.revision, 'the list shows the other write').toBe(2);
    rig.host.tickValue = 2;
    await runFrames(rig, AUTOSAVE_INTERVAL_SECONDS);
    await flush();
    expect(kinds(rig), 'the broadcast must not hide the conflict').toContain('autosave-conflict');
    expect((await rig.store.read('autosave')).payload, 'the other tab\'s park is intact').toEqual({ marker: 'tab-b park' });
  });

  it('a manual save over a slot another tab replaced is refused and the list refreshed', async () => {
    const rig = await makeRig();
    expect((await rig.manager.saveToSlot('manual-1', 'Mine')).ok).toBe(true);
    await writeAsOtherTab(rig, 'manual-1', 'theirs');
    const result = await rig.manager.saveToSlot('manual-1');
    expect(result.ok ? null : result.error.code).toBe('conflict');
    expect((await rig.store.read('manual-1')).payload, 'their save survives').toEqual({ marker: 'theirs' });
    await flush();
    expect(rig.manager.snapshot().slots.find((row) => row.id === 'manual-1')?.name, 'the stale row was refreshed').toBe('theirs');
  });

  it('quick save that picked a free slot another tab just filled takes the next free slot instead', async () => {
    const rig = await makeRig();
    expect(rig.manager.snapshot().quickSaveSlotId).toBe('manual-1');
    await writeAsOtherTab(rig, 'manual-1', 'theirs');
    const result = await rig.manager.quickSave();
    expect(result.ok && result.value.id).toBe('manual-2');
    expect((await rig.store.read('manual-1')).payload).toEqual({ marker: 'theirs' });
  });

  it('a manual save that lands after a new park started does not re-arm quick save for the old park', async () => {
    const rig = await makeRig();
    rig.store.writeDelay = gate();
    const pending = rig.manager.saveToSlot('manual-3', 'Old park');
    await flush();
    rig.manager.notifyParkStarted();
    rig.store.writeDelay?.resolve();
    await pending;
    await flush();
    expect(rig.manager.snapshot().quickSaveSlotId, 'Ctrl+S must not target the old park\'s slot').toBe('manual-1');
    expect(rig.manager.snapshot().slots.some((row) => row.id === 'manual-3'), 'the list still shows the finished save').toBe(true);
  });

  it('a failed quota write does not flip persistence back to ready before the next write fails', async () => {
    const rig = await makeRig();
    rig.store.nextWriteError = new StoreError('quota', 'Storage is full');
    await rig.manager.saveToSlot('manual-1');
    expect(rig.manager.snapshot().persistence.state).toBe('unavailable');
    const before = rig.events.filter((event) => event.type === 'persistence-restored').length;
    rig.store.nextWriteError = new StoreError('quota', 'Storage is full');
    await rig.manager.saveToSlot('manual-1');
    expect(rig.events.filter((event) => event.type === 'persistence-restored').length, 'no ready flicker').toBe(before);
    expect(rig.manager.snapshot().persistence.state).toBe('unavailable');
  });

  it('cuts names by code point and strips control and bidirectional characters', async () => {
    const rig = await makeRig();
    await rig.manager.saveToSlot('manual-1', 'x');
    const emoji = await rig.manager.rename('manual-1', `${'a'.repeat(39)}\u{1F600}b`);
    const name = emoji.ok ? emoji.value.name : '';
    expect(Array.from(name).length).toBe(40);
    expect(name, 'no lone surrogate').not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/);
    const dirty = await rig.manager.rename('manual-1', 'x‮y\ncontrol\u0000z');
    expect(dirty.ok && dirty.value.name).toBe('x y control z');
  });

  it('keeps a renamed autosave name across the next autosave', async () => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 1;
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    await rig.manager.rename('autosave', 'Before the big coaster');
    rig.host.tickValue = 2;
    await runFrames(rig, AUTOSAVE_INTERVAL_SECONDS);
    await flush();
    expect((await rig.store.list())[0].name).toBe('Before the big coaster');
  });

  it('hands the write to the deferral hook except for a hidden flush', async () => {
    const host = new TestHost();
    const store = new TestStore();
    const deferred: Array<() => void> = [];
    const manager = new SaveManager({
      host,
      store,
      writer: createHashingWriter(store, new TestHasher()),
      publish: () => undefined,
      createChannel: () => null,
      tabId: 'tab-a',
      deferWrite: (callback) => { deferred.push(callback); },
    });
    await manager.init();
    await flush();
    void manager.saveToSlot('manual-1', 'x');
    await flush();
    expect(store.writes, 'nothing is written until the deferred task runs').toEqual([]);
    expect(deferred.length).toBe(1);
    deferred[0]();
    await flush();
    expect(store.writes).toEqual(['manual-1']);
    host.version = 3;
    vi.setSystemTime(Date.now() + 60 * SECOND);
    manager.flushOnHide();
    await flush();
    expect(deferred.length, 'a hidden flush must not wait for a task that may never run').toBe(1);
    expect(store.writes).toEqual(['manual-1', 'autosave']);
  });
});

describe('recovery: autosave hold', () => {
  const dirtyPark = (rig: Rig): void => {
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 5;
  };

  it('blocks the park-start and interval autosaves, and shows as suspended', async () => {
    const rig = await makeRig();
    rig.manager.holdAutosave();
    dirtyPark(rig);
    await runFrames(rig, AUTOSAVE_INTERVAL_SECONDS * 2);
    await flush();
    expect(rig.host.captures, 'nothing was captured while held').toBe(0);
    expect(await rig.store.list(), 'the store was never written').toEqual([]);
    expect(rig.manager.snapshot().autosave.state, 'the UI sees a suspension').toBe('suspended');
  });

  it('blocks the hidden flush and a scenario-result autosave, and the result still fires after release', async () => {
    const rig = await makeRig();
    rig.manager.holdAutosave();
    dirtyPark(rig);
    rig.manager.flushOnHide();
    rig.manager.notifyScenarioResult();
    await runFrames(rig, HIDDEN_AUTOSAVE_MIN_GAP_SECONDS + 5);
    await flush();
    expect(rig.host.captures, 'hide flush and scenario result are held too').toBe(0);
    rig.manager.releaseAutosave();
    await runFrames(rig, AUTOSAVE_MIN_GAP_SECONDS + 1);
    await flush();
    expect(rig.host.captures, 'released: the pending result is saved').toBeGreaterThan(0);
  });

  it('does not block manual saves', async () => {
    const rig = await makeRig();
    rig.manager.holdAutosave();
    dirtyPark(rig);
    const saved = await rig.manager.saveToSlot('manual-1', 'Mine');
    expect(saved.ok, 'manual save works under a hold').toBe(true);
    expect((await rig.store.list()).map((row) => row.id), 'only the manual slot').toEqual(['manual-1']);
  });

  it('an existing autosave is not overwritten until the hold is released', async () => {
    const rig = await makeRig();
    dirtyPark(rig);
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    const before = (await rig.store.list())[0];
    expect(before.revision, 'seed autosave').toBe(1);
    rig.manager.holdAutosave();
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 50;
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS * 3);
    await flush();
    expect((await rig.store.list())[0].revision, 'still revision 1 under the hold').toBe(1);
    rig.manager.releaseAutosave();
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    expect((await rig.store.list())[0].revision, 'written after release').toBe(2);
  });

  it('refresh and a persistence retry do not lift the hold', async () => {
    const rig = await makeRig();
    rig.manager.holdAutosave();
    dirtyPark(rig);
    await rig.manager.refresh();
    await rig.manager.retryPersistence();
    await flush();
    expect(rig.host.captures, 'neither path starts an autosave').toBe(0);
    expect(rig.manager.snapshot().autosave.state, 'still suspended').toBe('suspended');
  });

  it('is idempotent in both directions and works before init', async () => {
    const host = new TestHost();
    const store = new TestStore();
    const manager = new SaveManager({
      host, store, writer: createHashingWriter(store, new TestHasher()), publish: () => undefined, createChannel: () => null,
    });
    manager.holdAutosave();
    manager.holdAutosave();
    await manager.init();
    manager.releaseAutosave();
    manager.releaseAutosave();
    expect(manager.snapshot().autosave.state, 'released once').toBe('waiting');
    manager.dispose();
  });
});

/** A complete manual-slot row, as another tab's manual save would have left it. */
const takenMeta = (id: string): SaveSlotMeta => ({
  id: id as SaveSlotMeta['id'], kind: 'manual', name: 'Taken', scenarioId: null, scenarioName: 'Sandbox park',
  playtimeSeconds: 1, savedAt: 1, schemaVersion: SAVE_SCHEMA_VERSION, contentVersion: SAVE_CONTENT_VERSION, savedAtTick: 1,
  guestCount: 1, cash: 1, rating: 1, sizeBytes: 1, revision: 1, writerTabId: 'tab-b', status: { state: 'ok' },
});

const metaOf = async (rig: Rig, id: string): Promise<SaveSlotMeta | undefined> => (
  (await rig.store.list()).find((row) => row.id === id)
);

describe('recovery: keepAutosaveAsRecovered', () => {
  const autosaved = async (): Promise<Rig> => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 5;
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    return rig;
  };

  it('moves the autosave record intact to the first free manual slot and names it', async () => {
    const rig = await autosaved();
    const before = await rig.store.read('autosave');
    const beforeMeta = await metaOf(rig, 'autosave');
    const result = await rig.manager.keepAutosaveAsRecovered(before.revision);
    expect(result, 'moved').toEqual({ ok: true, value: 'manual-1' });
    const after = await rig.store.read('manual-1');
    const afterMeta = await metaOf(rig, 'manual-1');
    expect(after.payload, 'payload is the very same record').toEqual(before.payload);
    expect(afterMeta?.name, 'named for the player').toBe('Recovered autosave');
    expect(afterMeta?.kind, 'now a manual slot').toBe('manual');
    expect(afterMeta?.playtimeSeconds, 'metadata survives the move').toBe(beforeMeta?.playtimeSeconds);
    expect((await rig.store.list()).map((row) => row.id), 'the autosave slot is empty, nothing deleted').toEqual(['manual-1']);
    expect(rig.manager.snapshot().slots.map((row) => row.id), 'the UI list follows').toEqual(['manual-1']);
    expect(rig.channel.posted.at(-1), 'other tabs are told').toEqual({ type: 'changed', tabId: 'tab-a' });
  });

  it('the next autosave after the move writes cleanly instead of conflicting', async () => {
    const rig = await autosaved();
    await rig.manager.keepAutosaveAsRecovered((await rig.store.read('autosave')).revision);
    rig.host.tickValue = 500;
    await runFrames(rig, AUTOSAVE_INTERVAL_SECONDS);
    await flush();
    expect(rig.manager.snapshot().autosave.state, 'not suspended by a conflict').not.toBe('suspended');
    expect((await rig.store.list()).map((row) => row.id), 'a new autosave next to the kept one').toEqual(['autosave', 'manual-1']);
  });

  it('skips taken slots and picks the first free one', async () => {
    const rig = await autosaved();
    await rig.manager.saveToSlot('manual-1', 'one');
    await rig.manager.saveToSlot('manual-2', 'two');
    const result = await rig.manager.keepAutosaveAsRecovered((await rig.store.read('autosave')).revision);
    expect(result, 'third slot').toEqual({ ok: true, value: 'manual-3' });
    expect((await metaOf(rig, 'manual-1'))?.name, 'existing slots untouched').toBe('one');
  });

  it('refuses with changed when the autosave revision moved, leaving everything as it was', async () => {
    const rig = await autosaved();
    const before = await rig.store.read('autosave');
    const result = await rig.manager.keepAutosaveAsRecovered(before.revision + 1);
    expect(result, 'changed').toMatchObject({ ok: false, error: { code: 'changed' } });
    expect((await rig.store.read('autosave')).payload, 'autosave untouched').toEqual(before.payload);
    expect((await rig.store.list()).map((row) => row.id), 'no new slot').toEqual(['autosave']);
  });

  it('refuses with not-found when there is no autosave', async () => {
    const rig = await makeRig();
    expect(await rig.manager.keepAutosaveAsRecovered(1), 'missing').toMatchObject({ ok: false, error: { code: 'not-found' } });
  });

  it('refuses with no-free-slot when all manual slots are taken and never deletes anything', async () => {
    const rig = await autosaved();
    for (const id of MANUAL_SLOT_IDS) expect((await rig.manager.saveToSlot(id, id)).ok, `save ${id}`).toBe(true);
    const before = await rig.store.read('autosave');
    const result = await rig.manager.keepAutosaveAsRecovered(before.revision);
    expect(result, 'no free slot').toMatchObject({ ok: false, error: { code: 'no-free-slot' } });
    expect((await rig.store.read('autosave')).payload, 'autosave still there').toEqual(before.payload);
    expect((await rig.store.list()).length, 'every slot intact').toBe(MANUAL_SLOT_IDS.length + 1);
    expect(rig.store.moves, 'no move was even attempted').toEqual([]);
  });

  it('retries once when a concurrent manual save took the chosen slot', async () => {
    const rig = await autosaved();
    const revision = (await rig.store.read('autosave')).revision;
    rig.store.beforeMove = (to) => {
      rig.store.seedRaw(to, takenMeta(to), { taken: true });
    };
    const result = await rig.manager.keepAutosaveAsRecovered(revision);
    expect(result, 'next free slot').toEqual({ ok: true, value: 'manual-2' });
    expect((await rig.store.read('manual-1')).payload, 'the other tab\'s save is intact').toEqual({ taken: true });
    expect(rig.store.moves, 'one failed attempt, one good').toEqual([['autosave', 'manual-1'], ['autosave', 'manual-2']]);
  });

  it('gives up with store error after the retry also loses, keeping the autosave', async () => {
    const rig = await autosaved();
    const revision = (await rig.store.read('autosave')).revision;
    const taker = (to: string): void => {
      rig.store.seedRaw(to, takenMeta(to), { taken: true });
    };
    rig.store.beforeMove = taker;
    const originalMove = rig.store.move.bind(rig.store);
    let calls = 0;
    rig.store.move = async (from, to) => {
      calls += 1;
      if (calls === 2) taker(to);
      return originalMove(from, to);
    };
    const result = await rig.manager.keepAutosaveAsRecovered(revision);
    expect(result.ok, 'second loss is reported, not retried forever').toBe(false);
    expect((await rig.store.list()).some((row) => row.id === 'autosave'), 'autosave never lost').toBe(true);
  });

  it('runs behind a save in flight and holds later saves back until it is done', async () => {
    const rig = await autosaved();
    const revision = (await rig.store.read('autosave')).revision;
    rig.store.writeDelay = gate();
    const slow = rig.manager.saveToSlot('manual-5', 'slow');
    await flush();
    let kept = false;
    const keeping = rig.manager.keepAutosaveAsRecovered(revision).then((result) => { kept = true; return result; });
    await flush();
    expect(kept, 'waits for the write in flight').toBe(false);
    const gateHandle = rig.store.writeDelay;
    rig.store.writeDelay = null;
    gateHandle.resolve();
    expect((await slow).ok, 'slow save finished').toBe(true);
    expect(await keeping, 'then moved').toMatchObject({ ok: true });
    expect(rig.store.maxActiveWrites, 'writes never overlapped').toBe(1);
  });

  it('refuses to rename or delete the autosave while it is being moved', async () => {
    const rig = await autosaved();
    const revision = (await rig.store.read('autosave')).revision;
    const keeping = rig.manager.keepAutosaveAsRecovered(revision);
    const rename = await rig.manager.rename('autosave', 'Mine');
    expect(rename, 'busy').toMatchObject({ ok: false, error: { code: 'busy' } });
    await keeping;
  });
});

describe('recovery: notifyParkRewound', () => {
  it('marks the park unsaved even when the restored version equals the persisted one', async () => {
    const rig = await makeRig();
    rig.host.version = 5;
    rig.manager.notifyParkStarted();
    await rig.manager.saveToSlot('manual-1', 'Save');
    expect(rig.manager.snapshot().unsavedChanges, 'saved at version 5').toBe(false);
    rig.host.version = 5;
    rig.manager.notifyParkRewound();
    expect(rig.manager.snapshot().unsavedChanges, 'rewound world looks unsaved although version matches').toBe(true);
    expect(rig.manager.hasUnsavedEdits(), 'tab close warns too').toBe(true);
  });

  it('an autosave in flight for the pre-undo state does not mark the rewound park clean', async () => {
    const rig = await makeRig();
    rig.host.version = 9;
    rig.manager.notifyParkStarted();
    rig.host.version = 10;
    rig.hasher.hold = gate();
    const saving = rig.manager.saveToSlot('manual-1', 'pre-undo');
    await flush();
    // The rewound world reports the SAME version the in-flight autosave captured: only the
    // generation bump (not the version comparison) keeps the late save from marking it clean.
    rig.host.version = 10;
    rig.manager.notifyParkRewound();
    const holdGate = rig.hasher.hold;
    rig.hasher.hold = null;
    holdGate.resolve();
    await saving;
    await flush();
    expect(rig.manager.snapshot().unsavedChanges, 'the late save belongs to another park generation').toBe(true);
  });

  it('keeps the autosave timers, first-autosave delay and the quick-save slot', async () => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 5;
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS - 5);
    rig.manager.notifyParkRewound();
    expect(rig.host.captures, 'no autosave yet').toBe(0);
    await runFrames(rig, 5);
    await flush();
    expect(rig.host.captures, 'the 15 s start delay was not re-armed').toBe(1);
    const first = await rig.manager.quickSave();
    expect(first.ok && first.value.id, 'quick save picked a slot').toBe('manual-1');
    rig.manager.notifyParkRewound();
    const again = await rig.manager.quickSave();
    expect(again.ok && again.value.id, 'the chosen quick slot survives a rewind').toBe('manual-1');
  });
});

describe('autosave interval setting', () => {
  it('follows the configured cadence, with the first save no later than the interval', async () => {
    const rig = await makeRig();
    rig.manager.setAutosaveInterval(60);
    expect(rig.manager.getAutosaveInterval()).toBe(60);
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 1;
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    expect(rig.host.captures).toBe(1);
    rig.host.tickValue = 2;
    await runFrames(rig, 59);
    expect(rig.host.captures, 'a minute has not passed').toBe(1);
    await runFrames(rig, 1);
    await flush();
    expect(rig.host.captures).toBe(2);
  });

  it('a longer cadence delays the interval save', async () => {
    const rig = await makeRig();
    rig.manager.setAutosaveInterval(600);
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 1;
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    rig.host.tickValue = 2;
    await runFrames(rig, 599);
    expect(rig.host.captures).toBe(1);
    await runFrames(rig, 1);
    await flush();
    expect(rig.host.captures).toBe(2);
  });

  it('Off disables the timed saves but keeps the scenario-result safe point and the hide save', async () => {
    const rig = await makeRig();
    rig.manager.setAutosaveInterval(0);
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 1;
    rig.host.version = 1;
    await runFrames(rig, 1_000);
    expect(rig.host.captures, 'no timed autosave, however long the dirty park runs').toBe(0);
    rig.manager.notifyScenarioResult();
    await runFrames(rig, 2);
    await flush();
    expect(rig.host.captures, 'the scenario result still saves').toBe(1);
    rig.host.version = 2;
    await runFrames(rig, AUTOSAVE_MIN_GAP_SECONDS);
    rig.manager.flushOnHide();
    await flush();
    expect(rig.host.captures, 'tab hide still saves a dirty park').toBe(2);
    expect(rig.events.some((event) => event.type === 'saved' && event.reason === 'hidden')).toBe(true);
  });

  it('turning timed saves back on restarts the countdown instead of saving on the spot', async () => {
    const rig = await makeRig();
    rig.manager.setAutosaveInterval(0);
    rig.manager.notifyParkStarted();
    rig.host.tickValue = 1;
    await runFrames(rig, 500);
    rig.manager.setAutosaveInterval(120);
    await runFrames(rig, 1);
    expect(rig.host.captures).toBe(0);
    await runFrames(rig, START_AUTOSAVE_DELAY_SECONDS);
    await flush();
    expect(rig.host.captures).toBe(1);
  });

  it('never goes below the minimum gap between autosave writes, and ignores junk', async () => {
    const rig = await makeRig();
    rig.manager.setAutosaveInterval(1);
    expect(rig.manager.getAutosaveInterval()).toBe(AUTOSAVE_MIN_GAP_SECONDS);
    rig.manager.setAutosaveInterval(Number.NaN);
    expect(rig.manager.getAutosaveInterval(), 'NaN means Off').toBe(0);
    rig.manager.setAutosaveInterval(-5);
    expect(rig.manager.getAutosaveInterval()).toBe(0);
  });
});

describe('autosave generations (Phase 31)', () => {
  const markerOf = (payload: unknown): unknown => (payload as { state: { marker: number } }).state.marker;

  /** Two autosaves of a running park: the second one rotates the first into the previous slot. */
  const twoAutosaves = async (): Promise<Rig> => {
    const rig = await makeRig();
    rig.manager.notifyParkStarted();
    rig.host.version = 1;
    await rig.manager.autosaveNow();
    rig.host.version = 2;
    await rig.manager.autosaveNow();
    await flush();
    return rig;
  };

  it('every autosave keeps the one before it as the previous generation, and the list follows without a re-read', async () => {
    const rig = await twoAutosaves();
    const stored = await rig.store.list();
    expect(stored.map((row) => [row.id, row.kind, row.revision]), 'store').toEqual([['autosave', 'auto', 2], ['autosave-previous', 'auto', 1]]);
    expect(rig.manager.snapshot().slots, 'the manager predicted the rotation exactly').toEqual(stored);
    expect(markerOf((await rig.store.read('autosave')).payload), 'newest capture').toBe(2);
    expect(markerOf((await rig.store.read('autosave-previous')).payload), 'the capture before it').toBe(1);
    rig.host.version = 3;
    await rig.manager.autosaveNow();
    expect(markerOf((await rig.store.read('autosave-previous')).payload), 'two generations roll').toBe(2);
    expect(rig.manager.snapshot().slots, 'still in step').toEqual(await rig.store.list());
  });

  it('a damaged autosave from an earlier session is quarantined, not rotated: the good previous generation stays', async () => {
    const rig = await makeRig();
    const previous = { schemaVersion: SAVE_SCHEMA_VERSION, stateHash: 'x', state: { good: true } };
    rig.store.seedRaw('autosave-previous', makeSlotMeta('autosave-previous', { kind: 'auto', name: 'Autosave', revision: 3, schemaVersion: SAVE_SCHEMA_VERSION }), { id: 'autosave-previous', payload: previous, revision: 3 });
    rig.store.seedRaw('autosave', makeSlotMeta('autosave', { revision: 4, schemaVersion: SAVE_SCHEMA_VERSION }), { id: 'autosave', payload: { garbage: true }, revision: 4 });
    await rig.manager.refresh();
    rig.manager.notifyParkStarted();
    rig.host.version = 1;
    await rig.manager.autosaveNow();
    await flush();
    const rows = await rig.store.list();
    expect(rows.map((row) => row.id), 'quarantined to a manual slot, fresh autosave written').toEqual(['autosave', 'autosave-previous', 'manual-1']);
    expect((await rig.store.read('manual-1')).payload, 'the damaged record is kept').toEqual({ garbage: true });
    expect((await rig.store.read('autosave-previous')).payload, 'the previous generation was not pushed out').toEqual(previous);
    expect(rows[1].revision, 'and not even touched').toBe(3);
  });

  it('deleting the autosave deletes both generations; deleting the previous one deletes only it', async () => {
    const rig = await twoAutosaves();
    const removedPrevious = await rig.manager.remove('autosave-previous');
    expect(removedPrevious.ok).toBe(true);
    expect((await rig.store.list()).map((row) => row.id), 'only the previous one').toEqual(['autosave']);
    rig.host.version = 3;
    await rig.manager.autosaveNow();
    expect((await rig.store.list()).map((row) => row.id), 'rotation resumes').toEqual(['autosave', 'autosave-previous']);
    const removed = await rig.manager.remove('autosave');
    expect(removed.ok).toBe(true);
    expect(await rig.store.list(), 'both gone').toEqual([]);
    expect(rig.manager.snapshot().slots, 'the list agrees').toEqual([]);
    expect(rig.manager.snapshot().notice?.text).toBe('Deleted Autosave and the previous autosave');
  });

  it('deleting an unreadable autosave keeps the previous generation as the fallback', async () => {
    const rig = await twoAutosaves();
    await rig.store.updateMeta('autosave', { status: { state: 'unreadable', code: 'corrupt', message: 'bad' } });
    await rig.manager.refresh();
    expect((await rig.manager.remove('autosave')).ok).toBe(true);
    expect((await rig.store.list()).map((row) => row.id), 'the previous generation stays').toEqual(['autosave-previous']);
  });

  it('the previous generation is read-only: no rename, no save, no quick save', async () => {
    const rig = await twoAutosaves();
    const renamed = await rig.manager.rename('autosave-previous', 'Mine');
    expect(renamed.ok ? null : renamed.error.code, 'rename refused').toBe('invalid-slot');
    const saved = await rig.manager.saveToSlot('autosave-previous' as never);
    expect(saved.ok ? null : saved.error.code, 'save refused').toBe('invalid-slot');
    expect(rig.manager.snapshot().quickSaveSlotId, 'quick save goes to a manual slot').toBe('manual-1');
    expect((await rig.store.list()).find((row) => row.id === 'autosave-previous')?.name, 'untouched').toBe('Autosave');
  });

  it('loads the previous generation like any slot and names it by its place', async () => {
    const rig = await twoAutosaves();
    const loaded = await rig.manager.load('autosave-previous');
    expect(loaded.ok && loaded.value.name, 'summary name').toBe('Previous autosave');
    expect(markerOf(rig.host.installed[0]?.save), 'the older park was installed').toBe(1);
    rig.host.version = 10;
    await rig.manager.autosaveNow();
    expect((await rig.store.list()).map((row) => [row.id, row.revision]), 'the next autosave rotates as usual').toEqual([['autosave', 3], ['autosave-previous', 2]]);
  });

  it('an autosave in flight also writes the previous generation, so deleting it waits', async () => {
    const rig = await twoAutosaves();
    rig.hasher.hold = gate();
    rig.host.version = 3;
    const saving = rig.manager.autosaveNow();
    await flush();
    const busy = await rig.manager.remove('autosave-previous');
    expect(busy.ok ? null : busy.error.code, 'busy while the rotation is in flight').toBe('busy');
    rig.hasher.hold.resolve();
    rig.hasher.hold = null;
    await saving;
    expect((await rig.manager.remove('autosave-previous')).ok, 'free afterwards').toBe(true);
  });

  it('keepAutosaveAsRecovered can keep the previous generation (a recovery offer of it)', async () => {
    const rig = await twoAutosaves();
    const kept = await rig.manager.keepAutosaveAsRecovered(1, 'autosave-previous');
    expect(kept.ok && kept.value).toBe('manual-1');
    expect((await rig.store.list()).map((row) => row.id), 'moved, current untouched').toEqual(['autosave', 'manual-1']);
    expect(markerOf((await rig.store.read('manual-1')).payload)).toBe(1);
  });
});
