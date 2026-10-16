import { GAME_CONFIG } from '../../game/config';
import type { ParkSaveV4 } from '../../game/save/state';
import { SaveError, type SaveErrorCode } from '../../game/save/version';
import {
  AUTOSAVE_INDICATOR_VISIBLE_MS,
  AUTOSAVE_INTERVAL_SECONDS,
  AUTOSAVE_MIN_GAP_SECONDS,
  AUTOSAVE_PREVIOUS_SLOT_ID,
  AUTOSAVE_SLOT_ID,
  DEFAULT_AUTOSAVE_NAME,
  HIDDEN_AUTOSAVE_MIN_GAP_SECONDS,
  IDLE_TIMEOUT_MS,
  MANUAL_SLOT_IDS,
  MAX_MANUAL_SLOTS,
  SAVE_NAME_MAX_LENGTH,
  SAVE_NOTICE_VISIBLE_MS,
  START_AUTOSAVE_DELAY_SECONDS,
  UNSAVED_PROGRESS_SIMULATED_SECONDS,
  WORKER_JOB_TIMEOUT_MS,
} from './constants';
import { computeStateSeal, persistSealedJob, type StateSeal } from './persistJob';
import { isAutosaveSlotId, isPreviousAutosave, slotDisplayName, slotsToDelete } from './autosaveGenerations';
import { metaForMove, planRotation } from './memorySaveStore';
import type { SealReply, SealRequest } from './saveWorker';
import { createWorkerSaveWriter, type WorkerSaveWriterWorker } from './workerSaveWriter';

export { computeStateSeal, type StateSeal };
import {
  StoreError,
  type AutosaveIndicator,
  type CapturedPark,
  type LoadedPark,
  type LoadPathModule,
  type ManualSaveSlotId,
  type ParkPreview,
  type PersistJob,
  type PersistResult,
  type PersistenceStatus,
  type SaveEvent,
  type SaveFailure,
  type SaveFailureCode,
  type SaveHost,
  type SaveManager as SaveManagerContract,
  type SaveNotice,
  type SaveReason,
  type SaveResult,
  type AutosaveSlotId,
  type SaveSlotId,
  type SaveSlotMeta,
  type SaveStore,
  type SaveWriter,
  type SavesBusy,
  type SavesSnapshot,
  type StoreStatus,
  type LoadSummary,
} from './types';
import type { LoadFailureDescription } from './loadSave';
import {
  recoveredSlotName,
  type RecoveryFailure,
  type RecoveryFailureCode,
  type RecoveryResult,
  type SaveManagerRecoveryHooks,
} from './recoveryTypes';

/**
 * Autosave, manual save and load, as one state machine that never blocks a frame.
 *
 * Cost model (see DESIGN.md section 3): the only in-frame work of a save is `host.capture()` (the
 * deep-copying serialize) plus one structured clone of the state into the hash worker. Hashing,
 * sizing and the IndexedDB write happen after the frame, through the injected `SaveWriter`. At most
 * one save is in flight; later requests coalesce into a queue that captures FRESH state when its
 * turn comes, so a queued save never writes stale data.
 *
 * No React, Pixi or IndexedDB types here: the manager is driven by a `SaveHost` (the game), a
 * `SaveStore` and a `SaveWriter`, all injectable, which is what lets it be tested with fake timers.
 */

/** The lazily imported module: the contract's one export plus the error mapper. */
export interface LoadModule extends LoadPathModule {
  loadFailureFrom(error: unknown): LoadFailureDescription;
}

export interface SaveManagerTimers {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface SaveChannelMessage {
  type: 'changed';
  tabId: string;
}

/** The slice of BroadcastChannel the manager uses. */
export interface SaveChannel {
  post(message: SaveChannelMessage): void;
  onMessage(listener: (message: SaveChannelMessage) => void): void;
  close(): void;
}

export interface SaveManagerOptions {
  host: SaveHost;
  store: SaveStore;
  writer: SaveWriter;
  /** Receives every new snapshot (throttled); GameApp wires it to the UI store. */
  publish(snapshot: SavesSnapshot): void;
  /** Defaults to a dynamic import of ./loadSave, which is what makes the load path a separate chunk. */
  loadModule?: () => Promise<LoadModule>;
  /**
   * What Retry does when the store offers more than `init()` (the resilient store also moves its
   * in-memory saves into IndexedDB when it comes back). Defaults to `store.init()`.
   */
  retryStore?: () => Promise<StoreStatus>;
  timers?: SaveManagerTimers;
  tabId?: string;
  createChannel?: () => SaveChannel | null;
  /**
   * Runs the hand-off of a captured save to the writer in a later task (GameApp passes a
   * MessageChannel hop). Default: immediately, which is what tests with fake timers want.
   */
  deferWrite?: (callback: () => void) => void;
  /** Timed autosave cadence in seconds; 0 = Off. Default AUTOSAVE_INTERVAL_SECONDS. */
  autosaveIntervalSeconds?: number;
}

/** Leading-and-trailing throttle of snapshot publication: the HUD never needs more than ten a second. */
const SNAPSHOT_PUBLISH_INTERVAL_MS = 100;

const STEP_SECONDS = GAME_CONFIG.fixedStepMs / 1000;

const NO_PARK: SaveFailure = { code: 'no-park', message: 'There is no park to save yet.' };
const BUSY: SaveFailure = { code: 'busy', message: 'Another save operation is still running. Try again in a moment.' };
const ALL_SLOTS_FULL = 'All slots are full: choose one to replace.';

const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** A version no real world has: a rewound park is unsaved against every slot (notifyParkRewound). */
const REWOUND_VERSION_SENTINEL = -1;

const recoveryFailure = (code: RecoveryFailureCode, message: string): { ok: false; error: RecoveryFailure } => (
  { ok: false, error: { code, message } }
);

const toFailure = (error: unknown): SaveFailure => (
  error instanceof StoreError || error instanceof SaveError
    ? { code: error.code, message: error.message }
    : { code: 'unknown', message: errorMessage(error) }
);

const slotOrder = (id: SaveSlotId): number => (
  id === AUTOSAVE_SLOT_ID ? -2 : id === AUTOSAVE_PREVIOUS_SLOT_ID ? -1 : (MANUAL_SLOT_IDS as readonly string[]).indexOf(id)
);

/** Autosave first, then the previous autosave, then manual slots in order; unknown (orphan) ids last, in the order the store gave them. */
const sortSlots = (slots: readonly SaveSlotMeta[]): SaveSlotMeta[] => {
  const rank = (meta: SaveSlotMeta): number => {
    const order = slotOrder(meta.id);
    return order === -1 && !isAutosaveSlotId(meta.id) ? Number.MAX_SAFE_INTEGER : order;
  };
  return slots.map((meta, index) => ({ meta, index }))
    .sort((a, b) => rank(a.meta) - rank(b.meta) || a.index - b.index)
    .map((entry) => entry.meta);
};

/**
 * Control characters (newlines, NUL) and the bidirectional overrides (U+202A-202E, U+2066-2069) are
 * dropped because a stored name is shown next to other text, where a right-to-left override can
 * reorder its neighbours. Whitespace runs collapse, and the cut is by code point so an emoji is
 * never split into a lone surrogate.
 */
const UNWANTED_NAME_CHARACTERS = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;

export const clampName = (name: string): string => (
  Array.from(name.replace(UNWANTED_NAME_CHARACTERS, ' ').replace(/\s+/g, ' ').trim())
    .slice(0, SAVE_NAME_MAX_LENGTH)
    .join('')
    .trim()
);

const isManualSlot = (id: string): id is ManualSaveSlotId => (MANUAL_SLOT_IDS as readonly string[]).includes(id);

const isPersistenceCode = (code: SaveFailureCode): code is 'unavailable' | 'blocked' | 'quota' => (
  code === 'unavailable' || code === 'blocked' || code === 'quota'
);

// --- Off-frame sealing and persisting ---------------------------------------------------------

export interface StateHasher {
  readonly kind: 'worker' | 'idle';
  seal(state: ParkSaveV4): Promise<StateSeal>;
  dispose(): void;
}

/** The slice of Worker the hasher uses, so tests can substitute a fake. */
export interface HasherWorker {
  postMessage(message: SealRequest): void;
  terminate(): void;
  onmessage: ((event: { data: SealReply }) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

export interface StateHasherOptions {
  /** Returns null (or throws) when workers are unavailable. */
  createWorker?: () => HasherWorker | null;
  /** Runs a callback outside the frame. Default: requestIdleCallback with IDLE_TIMEOUT_MS, else setTimeout(0). */
  schedule?: (callback: () => void) => void;
  timers?: SaveManagerTimers;
  jobTimeoutMs?: number;
}

const defaultCreateWorker = (): HasherWorker | null => {
  if (typeof Worker === 'undefined') return null;
  return new Worker(new URL('./saveWorker.ts', import.meta.url), { type: 'module' }) as unknown as HasherWorker;
};

const defaultSchedule = (callback: () => void): void => {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, options: { timeout: number }) => number }).requestIdleCallback;
  if (typeof idle === 'function') idle(callback, { timeout: IDLE_TIMEOUT_MS });
  else setTimeout(callback, 0);
};

const defaultTimers: SaveManagerTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

interface PendingSeal {
  state: ParkSaveV4;
  resolve(seal: StateSeal): void;
  reject(error: unknown): void;
  timer: unknown;
}

/**
 * Seals states in a module Web Worker; any worker failure (cannot start, error event, a job that
 * never answers, an error reply) silently moves that job and every later one to an idle-time run on
 * the main thread. The hash is not incremental, so the fallback is one idle task of roughly 40 ms
 * at 1,000 guests rather than true chunking; it is idle-scheduled so it never lands in a frame the
 * player is steering.
 */
export const createStateHasher = (options: StateHasherOptions = {}): StateHasher => {
  const timers = options.timers ?? defaultTimers;
  const schedule = options.schedule ?? defaultSchedule;
  const jobTimeoutMs = options.jobTimeoutMs ?? WORKER_JOB_TIMEOUT_MS;
  const pending = new Map<number, PendingSeal>();
  let worker: HasherWorker | null = null;
  let nextId = 1;
  let disposed = false;

  try {
    worker = (options.createWorker ?? defaultCreateWorker)();
  } catch {
    worker = null;
  }

  const sealOnMainThread = (state: ParkSaveV4): Promise<StateSeal> => new Promise((resolve, reject) => {
    schedule(() => {
      try {
        resolve(computeStateSeal(state));
      } catch (error) {
        reject(error);
      }
    });
  });

  const settle = (id: number): PendingSeal | undefined => {
    const entry = pending.get(id);
    if (!entry) return undefined;
    pending.delete(id);
    timers.clearTimeout(entry.timer);
    return entry;
  };

  const rerunOnMainThread = (entry: PendingSeal): void => {
    sealOnMainThread(entry.state).then(entry.resolve, entry.reject);
  };

  const abandonWorker = (): void => {
    const dying = worker;
    worker = null;
    if (dying) {
      dying.onmessage = null;
      dying.onerror = null;
      try { dying.terminate(); } catch { /* a dead worker may refuse; it is replaced anyway */ }
    }
    const orphans = [...pending.keys()];
    for (const id of orphans) {
      const entry = settle(id);
      if (entry) rerunOnMainThread(entry);
    }
  };

  if (worker) {
    worker.onmessage = (event) => {
      const reply = event.data;
      const entry = settle(reply.id);
      if (!entry) return;
      if (reply.ok) entry.resolve({ stateHash: reply.stateHash, sizeBytes: reply.sizeBytes, hashMs: reply.hashMs });
      else rerunOnMainThread(entry);
    };
    worker.onerror = () => abandonWorker();
  }

  return {
    get kind() { return worker ? 'worker' : 'idle'; },
    seal(state) {
      if (disposed) return Promise.reject(new Error('The save hasher was disposed'));
      if (!worker) return sealOnMainThread(state);
      const id = nextId;
      nextId += 1;
      return new Promise<StateSeal>((resolve, reject) => {
        const timer = timers.setTimeout(() => abandonWorker(), jobTimeoutMs);
        pending.set(id, { state, resolve, reject, timer });
        try {
          worker?.postMessage({ id, state });
        } catch {
          abandonWorker();
        }
      });
    },
    dispose() {
      disposed = true;
      for (const id of [...pending.keys()]) settle(id)?.reject(new Error('The save hasher was disposed'));
      const dying = worker;
      worker = null;
      if (dying) {
        dying.onmessage = null;
        dying.onerror = null;
        try { dying.terminate(); } catch { /* nothing left to clean up */ }
      }
    },
  };
};

/**
 * The default `SaveWriter`: hash and size off-frame through the hasher, then write through the store
 * (one structured clone of the state on the main thread, in its own task, never in the frame that
 * captured). The store builder's worker-owned-connection writer is a drop-in replacement through
 * the same port.
 */
export const createHashingWriter = (store: SaveStore, hasher: StateHasher): SaveWriter => ({
  get kind() { return hasher.kind; },
  async persist(job) {
    let seal: StateSeal;
    try {
      seal = await hasher.seal(job.state);
    } catch (error) {
      return { ok: false, jobId: job.jobId, error: { code: 'seal-failed', message: errorMessage(error) } } satisfies PersistResult;
    }
    return persistSealedJob(store, job, seal);
  },
  dispose() { hasher.dispose(); },
});

/** The writer GameApp uses unless a test or the store builder supplies another. */
export const createDefaultSaveWriter = (store: SaveStore): SaveWriter => createWorkerSaveWriter({
  usesIndexedDb: () => {
    // ResilientSaveStore.backend() is a method; MemorySaveStore and IdbSaveStore expose a string.
    const backend = (store as { backend?: unknown }).backend;
    return (typeof backend === 'function' ? backend.call(store) : backend) === 'indexeddb';
  },
  createFallback: () => createHashingWriter(store, createStateHasher()),
  createWorker: () => {
    if (typeof Worker === 'undefined') return null;
    return new Worker(new URL('./saveWorker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerSaveWriterWorker;
  },
});

const defaultCreateChannel = (): SaveChannel | null => {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    const channel = new BroadcastChannel('parksmith-saves-changed');
    return {
      post: (message) => channel.postMessage(message),
      onMessage: (listener) => { channel.onmessage = (event: MessageEvent<SaveChannelMessage>) => listener(event.data); },
      close: () => channel.close(),
    };
  } catch {
    return null;
  }
};

const newTabId = (): string => (
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)
);

// --- The manager -------------------------------------------------------------------------------

interface SaveRequest {
  slotId: SaveSlotId;
  reason: SaveReason;
  name: string | undefined;
  replaceUnreadable: boolean;
  /** Manual slots only: what the tab believes the slot holds (null = nothing), checked inside the write. */
  expectedRevision: number | null | undefined;
  /** Park generation at request time; a save that finishes in a later park must not re-arm quick save. */
  generation: number;
  resolvers: Array<(result: SaveResult<SaveSlotMeta>) => void>;
}

interface InFlight {
  slotId: SaveSlotId;
  reason: SaveReason;
}

type SuspendedReason = 'conflict' | 'unreadable';

export class SaveManager implements SaveManagerContract, SaveManagerRecoveryHooks {
  private readonly host: SaveHost;
  private readonly store: SaveStore;
  private readonly writer: SaveWriter;
  private readonly publish: (snapshot: SavesSnapshot) => void;
  private readonly loadModule: () => Promise<LoadModule>;
  private readonly retryStore: () => Promise<StoreStatus>;
  private readonly timers: SaveManagerTimers;
  private readonly tabId: string;
  private readonly createChannel: () => SaveChannel | null;
  private readonly deferWrite: ((callback: () => void) => void) | null;
  private channel: SaveChannel | null = null;
  private readonly listeners = new Set<(event: SaveEvent) => void>();

  private slots: SaveSlotMeta[] = [];
  private listState: SavesSnapshot['listState'] = 'idle';
  private readonly busy: SavesBusy = { listing: false, saving: null, loading: null, mutating: null };
  private persistence: PersistenceStatus = { state: 'checking', code: null, message: null, bannerDismissed: false, writer: null };
  private indicator: AutosaveIndicator = 'hidden';
  private lastAutosavedAt: number | null = null;
  private lastError: SaveFailure | null = null;
  private notice: SaveNotice | null = null;
  private noticeCounter = 0;
  private chosenQuickSlot: ManualSaveSlotId | null = null;

  // Dirty tracking: the last persisted position of the live park, to any slot and to the autosave slot.
  private persistedVersion = 0;
  private persistedTick = 0;
  private autosaveVersion = 0;
  private autosaveTick = 0;
  /**
   * Presentation state the save's `app` block carries (the view rotation) changes without touching
   * the world: a counter bumped by markAppStateChanged, and the value the last autosave captured.
   */
  private appStateVersion = 0;
  private autosaveAppStateVersion = 0;
  private publishedUnsaved = false;

  // Autosave schedule.
  private secondsSinceAutosave = 0;
  private lastAutosaveAttemptAt = Number.NEGATIVE_INFINITY;
  private firstAutosavePending = true;
  /** The player's timed-autosave cadence (settings); 0 = Off. */
  private autosaveIntervalSeconds = AUTOSAVE_INTERVAL_SECONDS;
  private pendingSafePoint: SaveReason | null = null;
  private suspendedReason: SuspendedReason | null = null;
  private parkGeneration = 0;
  /**
   * Interrupted-session recovery holds every autosave trigger until the player has decided about the
   * crashed park's autosave. A flag of its own: `suspendedReason` is cleared by refresh() and by the
   * conflict/unreadable flows, none of which may release a hold.
   */
  private autosaveHeld = false;
  /**
   * The autosave revision this tab last WROTE, loaded, or (before it has written anything) first
   * saw when it opened. undefined = not known yet (omit the check), null = the slot does not exist.
   * Deliberately NOT updated by a plain refresh: a refresh only shows what other tabs wrote, and
   * adopting that would make the next autosave silently replace another tab's park.
   */
  private knownAutosaveRevision: number | null | undefined = undefined;
  /** True once an autosave of this page session succeeded: the record in the slot is then our own. */
  private autosaveVerified = false;

  // Single flight with coalescing.
  private inFlight: InFlight | null = null;
  private readonly queue: SaveRequest[] = [];
  private idleWaiters: Array<() => void> = [];
  private jobCounter = 0;

  private initialized = false;
  private disposed = false;
  private loading = false;
  /** The start screen's backdrop read (`loadPreview`), so a real load can wait it out instead of reporting busy. */
  private previewInFlight: Promise<unknown> | null = null;

  private snapshotDirty = false;
  private publishTimer: unknown = null;
  private lastPublishAt = Number.NEGATIVE_INFINITY;
  private indicatorTimer: unknown = null;
  private noticeTimer: unknown = null;

  constructor(options: SaveManagerOptions) {
    this.host = options.host;
    this.store = options.store;
    this.writer = options.writer;
    this.publish = options.publish;
    this.loadModule = options.loadModule ?? (() => import('./loadSave'));
    this.retryStore = options.retryStore ?? (() => this.store.init());
    this.timers = options.timers ?? defaultTimers;
    this.tabId = options.tabId ?? newTabId();
    this.createChannel = options.createChannel ?? defaultCreateChannel;
    this.deferWrite = options.deferWrite ?? null;
    if (options.autosaveIntervalSeconds !== undefined) this.setAutosaveInterval(options.autosaveIntervalSeconds);
  }

  /**
   * Sets the timed autosave cadence (0 = Off). Off disables only the two TIMED triggers, the
   * interval save and the park-start save: the scenario-result safe point and the save on tab
   * hide / unload still run, and manual saves are unaffected. The floor between two autosave
   * writes (AUTOSAVE_MIN_GAP_SECONDS) applies to every cadence. The countdown restarts, so
   * changing the setting never fires a save on the spot.
   */
  setAutosaveInterval(seconds: number): void {
    const next = Number.isFinite(seconds) && seconds > 0 ? Math.max(seconds, AUTOSAVE_MIN_GAP_SECONDS) : 0;
    if (next === this.autosaveIntervalSeconds) return;
    this.autosaveIntervalSeconds = next;
    this.secondsSinceAutosave = 0;
  }

  getAutosaveInterval(): number {
    return this.autosaveIntervalSeconds;
  }

  // --- Lifecycle ---

  async init(): Promise<void> {
    if (this.initialized || this.disposed) return;
    this.initialized = true;
    try {
      this.channel = this.createChannel();
      this.channel?.onMessage((message) => {
        if (message.type === 'changed' && message.tabId !== this.tabId) void this.refresh();
      });
    } catch {
      this.channel = null;
    }
    await this.openStore();
  }

  dispose(): void {
    this.disposed = true;
    this.timers.clearTimeout(this.publishTimer);
    this.timers.clearTimeout(this.indicatorTimer);
    this.timers.clearTimeout(this.noticeTimer);
    this.publishTimer = this.indicatorTimer = this.noticeTimer = null;
    this.channel?.close();
    this.channel = null;
    this.listeners.clear();
    for (const request of this.queue.splice(0)) {
      for (const resolve of request.resolvers) resolve({ ok: false, error: BUSY });
    }
    this.writer.dispose();
    this.store.close();
  }

  subscribe(listener: (event: SaveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): SavesSnapshot {
    return {
      slots: this.slots,
      listState: this.listState,
      busy: { ...this.busy },
      persistence: { ...this.persistence },
      autosave: { state: this.autosaveState(), indicator: this.indicator, lastSavedAt: this.lastAutosavedAt },
      unsavedChanges: this.host.hasPark() && this.computeUnsaved(),
      quickSaveSlotId: this.quickSaveTarget(),
      lastError: this.lastError,
      notice: this.notice,
    };
  }

  // --- Per frame ---

  /**
   * Allocation-free unless a save is due: a few number comparisons per frame. The capture it may
   * start runs synchronously here, after `clock.update`, which is the step boundary the host needs.
   */
  frame(deltaMs: number): void {
    if (this.disposed || !this.host.hasPark()) return;
    const unsaved = this.computeUnsaved();
    if (unsaved !== this.publishedUnsaved) {
      this.publishedUnsaved = unsaved;
      this.markChanged();
    }
    if (this.suspendedReason !== null || this.autosaveHeld || this.persistence.state !== 'ready' || this.loading) return;
    if (this.inFlight !== null) return;
    if (this.pendingSafePoint !== null) {
      if (!this.gapElapsed(AUTOSAVE_MIN_GAP_SECONDS)) return;
      const reason = this.pendingSafePoint;
      this.pendingSafePoint = null;
      void this.requestSave(AUTOSAVE_SLOT_ID, reason);
      return;
    }
    if (this.autosaveIntervalSeconds === 0 || !this.isDirtyForAutosave()) return;
    this.secondsSinceAutosave += deltaMs / 1000;
    const threshold = this.firstAutosavePending
      ? Math.min(START_AUTOSAVE_DELAY_SECONDS, this.autosaveIntervalSeconds)
      : this.autosaveIntervalSeconds;
    if (this.secondsSinceAutosave < threshold || !this.gapElapsed(AUTOSAVE_MIN_GAP_SECONDS)) return;
    void this.requestSave(AUTOSAVE_SLOT_ID, this.firstAutosavePending ? 'park-start' : 'interval');
  }

  // --- Recovery hooks (see SaveManagerRecoveryHooks) ---

  holdAutosave(): void {
    if (this.autosaveHeld) return;
    this.autosaveHeld = true;
    this.markChanged();
  }

  releaseAutosave(): void {
    if (!this.autosaveHeld) return;
    this.autosaveHeld = false;
    this.markChanged();
  }

  /**
   * The live park was replaced by an earlier snapshot of itself. `worldVersion` of the restored
   * world is an old number that can coincide with the persisted baseline, which would make the
   * rewound park look saved: a sentinel that no real version equals marks it unsaved against every
   * slot. The generation bump makes an autosave of the pre-undo state, still in flight, leave the
   * baselines alone when it lands. Timers, first-autosave flag and quick-save slot stay: a rewind is
   * not a new park (notifyParkStarted would reset all three).
   */
  notifyParkRewound(): void {
    this.parkGeneration += 1;
    this.persistedVersion = this.autosaveVersion = REWOUND_VERSION_SENTINEL;
    this.markChanged();
  }

  /**
   * Moves the autosave to a free manual slot and names it, never deleting it. It occupies the
   * single-flight slot (as an in-flight save does), so a manual save or rename cannot interleave
   * with the two store calls and every other request queues behind it.
   */
  async keepAutosaveAsRecovered(expectedRevision: number, slotId: AutosaveSlotId = AUTOSAVE_SLOT_ID): Promise<RecoveryResult<ManualSaveSlotId>> {
    if (this.disposed) return recoveryFailure('busy', 'Saves are shutting down.');
    while (this.inFlight !== null || this.queue.length > 0) await this.whenIdle();
    if (this.disposed) return recoveryFailure('busy', 'Saves are shutting down.');
    this.inFlight = { slotId, reason: 'manual' };
    this.busy.mutating = slotId;
    this.markChanged();
    try {
      return await this.moveAutosaveToFreeSlot(expectedRevision, slotId);
    } catch (error) {
      const cause = this.noteStoreFailure(toFailure(error));
      return { ok: false, error: { code: 'store', message: cause.message, cause } };
    } finally {
      this.inFlight = null;
      this.busy.mutating = null;
      this.markChanged();
      this.drain();
    }
  }

  private async moveAutosaveToFreeSlot(expectedRevision: number, slotId: AutosaveSlotId): Promise<RecoveryResult<ManualSaveSlotId>> {
    // Two attempts: the first can lose a race for the free slot to a manual save of another tab.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const rows = sortSlots(await this.store.list());
      const autosave = rows.find((row) => row.id === slotId);
      if (autosave === undefined) {
        this.slots = rows;
        if (slotId === AUTOSAVE_SLOT_ID) this.knownAutosaveRevision = null;
        this.emit({ type: 'slots-changed' });
        return recoveryFailure('not-found', 'The autosave is gone.');
      }
      if (autosave.revision !== expectedRevision) {
        this.slots = rows;
        this.emit({ type: 'slots-changed' });
        return recoveryFailure('changed', 'The autosave was changed by another tab.');
      }
      const free = MANUAL_SLOT_IDS.find((id) => !rows.some((row) => row.id === id));
      if (free === undefined) {
        this.slots = rows;
        this.emit({ type: 'slots-changed' });
        return recoveryFailure('no-free-slot', `All ${MAX_MANUAL_SLOTS} save slots are in use.`);
      }
      try {
        await this.store.move(slotId, free);
      } catch (error) {
        const failure = toFailure(error);
        if (failure.code === 'conflict' && attempt === 0) continue;
        throw error;
      }
      let moved: SaveSlotMeta | null = null;
      try {
        moved = await this.store.updateMeta(free, { name: clampName(recoveredSlotName(autosave.mode)) });
      } catch {
        // The record is safe under its new id; only the label is missing. Not worth failing for.
      }
      try {
        this.slots = sortSlots(await this.store.list());
      } catch {
        const rest = rows.filter((row) => row.id !== slotId);
        this.slots = sortSlots([...rest, moved ?? { ...autosave, id: free, kind: 'manual' as const }]);
      }
      if (slotId === AUTOSAVE_SLOT_ID) this.knownAutosaveRevision = null;
      if (this.suspendedReason === 'unreadable') this.suspendedReason = null;
      this.lastError = null;
      this.channel?.post({ type: 'changed', tabId: this.tabId });
      this.emit({ type: 'slots-changed' });
      return { ok: true, value: free };
    }
    return recoveryFailure('changed', 'The save slots changed while the autosave was being kept.');
  }

  // --- Safe points ---

  notifyParkStarted(): void {
    this.parkGeneration += 1;
    this.persistedVersion = this.autosaveVersion = this.host.worldVersion();
    this.persistedTick = this.autosaveTick = this.host.tick();
    this.autosaveAppStateVersion = this.appStateVersion;
    this.secondsSinceAutosave = 0;
    this.firstAutosavePending = true;
    this.pendingSafePoint = null;
    this.publishedUnsaved = false;
    // A new park must not quietly overwrite the manual slot of the previous one.
    this.chosenQuickSlot = null;
    this.markChanged();
  }

  /**
   * The scenario result latches inside a simulation step, where serialize is not allowed to run, so
   * this only arms the save; the next `frame` (after the step) performs it, respecting the min gap
   * and skipping the dirty test because the result itself is new state.
   */
  notifyScenarioResult(): void {
    this.pendingSafePoint = 'scenario-result';
  }

  /**
   * App-only state that the save's `app` block holds changed (a view turn). It makes the park dirty
   * for the autosave (and the hidden-tab flush), so crash recovery restores it, but never for the
   * unsaved-changes warning: turning the view is not an edit worth a prompt.
   */
  markAppStateChanged(): void {
    this.appStateVersion += 1;
  }

  /**
   * True when the player has built or changed something no save holds. Narrower than `unsavedChanges`
   * (which also counts simulated progress): it decides whether closing the tab warns, and a warning
   * on every close of a running park would be noise.
   */
  hasUnsavedEdits(): boolean {
    return this.host.hasPark() && this.host.worldVersion() !== this.persistedVersion;
  }

  flushOnHide(): void {
    try {
      if (this.disposed || !this.host.hasPark() || this.inFlight !== null || this.loading) return;
      if (this.suspendedReason !== null || this.autosaveHeld || this.persistence.state !== 'ready') return;
      if (!this.isDirtyForAutosave() || !this.gapElapsed(HIDDEN_AUTOSAVE_MIN_GAP_SECONDS)) return;
      void this.requestSave(AUTOSAVE_SLOT_ID, 'hidden');
    } catch {
      // Best effort by contract: leaving the page must never throw into the browser.
    }
  }

  /**
   * Phase 23: writes the autosave now when the park changed since the last one, ignoring the minimum gap, and resolves when
   * it is on disk (or at once when there is nothing to write, or autosave is held, suspended or off). The Map uses it before
   * it leaves a run for the start screen, so a boundary the player just reached is never lost to the 20 s gap. Never rejects.
   */
  async autosaveNow(): Promise<void> {
    try {
      if (this.disposed || !this.host.hasPark() || this.loading) return;
      if (this.suspendedReason !== null || this.autosaveHeld || this.persistence.state !== 'ready') return;
      if (this.pendingSafePoint === null && !this.isDirtyForAutosave()) return;
      this.pendingSafePoint = null;
      await this.requestSave(AUTOSAVE_SLOT_ID, 'scenario-result');
    } catch {
      // Best effort by contract: the caller goes on to leave the run either way.
    }
  }

  // --- Commands ---

  async saveToSlot(
    id: ManualSaveSlotId,
    name?: string,
    options?: { confirmedReplaceUnreadable?: boolean },
  ): Promise<SaveResult<SaveSlotMeta>> {
    if (!isManualSlot(id)) return this.refuse({ code: 'invalid-slot', message: `${String(id)} is not a manual save slot.` });
    return this.manualSave(id, name, options?.confirmedReplaceUnreadable === true, 'manual');
  }

  async quickSave(): Promise<SaveResult<SaveSlotMeta>> {
    const target = this.quickSaveTarget();
    if (target === null) {
      this.setNotice('error', ALL_SLOTS_FULL);
      return { ok: false, error: { code: 'invalid-slot', message: ALL_SLOTS_FULL } };
    }
    const wasFree = !this.slots.some((row) => row.id === target);
    const result = await this.manualSave(target, undefined, false, 'quick');
    if (result.ok || result.error.code !== 'conflict' || !wasFree) return result;
    // Two tabs picked the same free slot: look again once and take the next free one (or the same
    // slot if it is ours to replace), instead of making the player press Ctrl+S twice.
    await this.refresh();
    if (this.chosenQuickSlot === target) this.chosenQuickSlot = null;
    const next = this.quickSaveTarget();
    return next === null ? result : this.manualSave(next, undefined, false, 'quick');
  }

  async load(id: SaveSlotId): Promise<SaveResult<LoadSummary>> {
    // A backdrop preview read holds the lock for a moment while the start screen opens; a player's load (Continue,
    // a menu load) waits for it rather than failing with "Another save operation is still running".
    while (this.previewInFlight !== null && this.loading) await this.previewInFlight;
    if (this.loading) return { ok: false, error: BUSY };
    this.loading = true;
    this.busy.loading = id;
    this.markChanged();
    try {
      // A save in flight (and anything queued behind it) lands first, so a slot is never read mid-write.
      await this.whenIdle();
      return await this.loadSlot(id);
    } finally {
      this.loading = false;
      this.busy.loading = null;
      this.markChanged();
    }
  }

  async rename(id: SaveSlotId, name: string): Promise<SaveResult<SaveSlotMeta>> {
    const clean = clampName(name);
    // The previous autosave generation is read-only (Phase 31): it is loaded or deleted, never changed.
    if (isPreviousAutosave(id)) return this.refuse({ code: 'invalid-slot', message: 'The previous autosave cannot be renamed.' }, 'rename', id);
    if (clean.length === 0) return this.refuse({ code: 'invalid-slot', message: 'A save needs a name.' }, 'rename', id);
    if (this.touchesInFlight(id)) return this.refuse(BUSY, 'rename', id);
    this.busy.mutating = id;
    this.markChanged();
    try {
      const meta = await this.store.updateMeta(id, { name: clean });
      this.upsertSlot(meta);
      this.channel?.post({ type: 'changed', tabId: this.tabId });
      this.emit({ type: 'slots-changed' });
      return { ok: true, value: meta };
    } catch (error) {
      return this.refuse(this.noteStoreFailure(toFailure(error)), 'rename', id);
    } finally {
      this.busy.mutating = null;
      this.markChanged();
    }
  }

  async remove(id: SaveSlotId): Promise<SaveResult<null>> {
    // Phase 31: deleting the autosave deletes both generations (unless it is unreadable); see `slotsToDelete`.
    const ids = slotsToDelete(id, this.slots);
    if (ids.some((each) => this.touchesInFlight(each))) return this.refuse(BUSY, 'delete', id);
    const removed = this.slots.find((row) => row.id === id);
    this.busy.mutating = id;
    this.markChanged();
    try {
      for (const each of ids) {
        await this.store.remove(each);
        this.slots = this.slots.filter((row) => row.id !== each);
      }
      if (this.chosenQuickSlot === id) this.chosenQuickSlot = null;
      if (id === AUTOSAVE_SLOT_ID) {
        this.knownAutosaveRevision = null;
        if (this.suspendedReason === 'unreadable') this.suspendedReason = null;
      }
      this.lastError = null;
      const what = removed === undefined ? 'the save' : slotDisplayName(removed);
      this.setNotice('info', ids.length > 1 ? `Deleted ${what} and the previous autosave` : `Deleted ${what}`);
      this.channel?.post({ type: 'changed', tabId: this.tabId });
      this.emit({ type: 'slots-changed' });
      return { ok: true, value: null };
    } catch (error) {
      return this.refuse(this.noteStoreFailure(toFailure(error)), 'delete', id);
    } finally {
      this.busy.mutating = null;
      this.markChanged();
    }
  }

  async refresh(): Promise<void> {
    if (this.disposed) return;
    this.busy.listing = true;
    if (this.listState !== 'ready') this.listState = 'loading';
    this.markChanged();
    try {
      this.slots = sortSlots(await this.store.list());
      this.listState = 'ready';
      const autosave = this.slots.find((row) => row.id === AUTOSAVE_SLOT_ID);
      if (this.knownAutosaveRevision === undefined) this.knownAutosaveRevision = autosave ? autosave.revision : null;
      if (this.suspendedReason === 'unreadable' && (!autosave || autosave.status.state === 'ok')) this.suspendedReason = null;
      this.emit({ type: 'slots-changed' });
    } catch (error) {
      this.listState = 'error';
      const failure = this.noteStoreFailure(toFailure(error));
      this.lastError = failure;
      this.emit({ type: 'failed', slotId: null, reason: 'list', error: failure });
    } finally {
      this.busy.listing = false;
      this.markChanged();
    }
  }

  async retryPersistence(): Promise<void> {
    if (this.disposed) return;
    this.suspendedReason = this.suspendedReason === 'unreadable' ? 'unreadable' : null;
    const ready = await this.openStore(true);
    if (ready && this.host.hasPark() && this.suspendedReason === null && !this.autosaveHeld) {
      // The retry is only proven by a write, so try one now instead of waiting an interval.
      void this.requestSave(AUTOSAVE_SLOT_ID, 'interval');
    }
  }

  dismissBanner(): void {
    this.persistence = { ...this.persistence, bannerDismissed: true };
    this.lastError = null;
    this.markChanged();
  }

  resumeAutosaveHere(): void {
    if (this.suspendedReason !== 'conflict') return;
    void this.refresh().then(() => {
      if (this.suspendedReason === 'conflict') {
        // The player chose this tab's park: from now on the autosave in the store is the one to replace.
        const autosave = this.slots.find((row) => row.id === AUTOSAVE_SLOT_ID);
        this.knownAutosaveRevision = autosave ? autosave.revision : null;
        this.suspendedReason = null;
      }
      this.lastError = null;
      this.markChanged();
    });
  }

  // --- Saving internals ---

  private async manualSave(
    id: ManualSaveSlotId,
    name: string | undefined,
    replaceUnreadable: boolean,
    reason: SaveReason,
  ): Promise<SaveResult<SaveSlotMeta>> {
    if (!this.host.hasPark()) return this.refuse(NO_PARK, reason, id);
    const row = this.slots.find((slot) => slot.id === id);
    if (row?.status.state === 'unreadable' && !replaceUnreadable) {
      return this.refuse({ code: 'slot-unreadable', message: 'This slot holds a save that cannot be read. Delete it first, or confirm replacing it.' }, reason, id);
    }
    // After a quota failure the retry would flip persistence back to ready before the write fails
    // again, so the banner would flicker; only a successful write (or the Retry button) clears it.
    if (this.persistence.state !== 'ready' && !(this.persistence.state === 'unavailable' && this.persistence.code === 'quota')) {
      // One automatic retry per attempt: the player asked for this save, so look again. The write
      // still goes to the store afterwards, because a resilient store may keep it in memory for this
      // page's lifetime; a store that is really dead rejects it with a typed code.
      await this.openStore(true);
    }
    const cleanName = name === undefined ? undefined : clampName(name);
    // The write checks this inside its transaction: a slot another tab filled or replaced since this
    // tab last listed it is a conflict, never a silent overwrite. An unreadable row has no trustworthy
    // revision, and its replacement was confirmed explicitly, so it carries no expectation.
    const expectedRevision = row === undefined ? null : row.status.state === 'ok' ? row.revision : undefined;
    return this.requestSave(id, reason, cleanName === '' ? undefined : cleanName, replaceUnreadable, expectedRevision);
  }

  private requestSave(
    slotId: SaveSlotId,
    reason: SaveReason,
    name?: string,
    replaceUnreadable = false,
    expectedRevision?: number | null,
  ): Promise<SaveResult<SaveSlotMeta>> {
    if (this.disposed) return Promise.resolve({ ok: false, error: BUSY });
    if (this.loading) return Promise.resolve({ ok: false, error: BUSY });
    if (!this.host.hasPark()) return Promise.resolve({ ok: false, error: NO_PARK });
    // Belt and braces: every autosave trigger already checks the hold, this catches any future one.
    if (slotId === AUTOSAVE_SLOT_ID && this.autosaveHeld) return Promise.resolve({ ok: false, error: BUSY });
    return new Promise((resolve) => {
      const waiting = this.queue.find((request) => request.slotId === slotId);
      if (waiting) {
        waiting.resolvers.push(resolve);
        waiting.name = name ?? waiting.name;
        waiting.replaceUnreadable = waiting.replaceUnreadable || replaceUnreadable;
        if (reason !== 'interval' && reason !== 'hidden' && reason !== 'park-start') waiting.reason = reason;
        return;
      }
      const request: SaveRequest = {
        slotId, reason, name, replaceUnreadable, expectedRevision, generation: this.parkGeneration, resolvers: [resolve],
      };
      if (this.inFlight !== null) this.queue.push(request);
      else this.start(request);
    });
  }

  private start(request: SaveRequest): void {
    const { slotId, reason } = request;
    this.inFlight = { slotId, reason };
    const isAutosave = slotId === AUTOSAVE_SLOT_ID;
    if (isAutosave) {
      this.lastAutosaveAttemptAt = this.host.now();
      this.secondsSinceAutosave = 0;
      // Whatever happens next, the start delay was spent: a failed first attempt retries at the interval.
      this.firstAutosavePending = false;
    }
    this.busy.saving = slotId;
    this.markChanged();
    const autosaveRow = isAutosave ? this.slots.find((row) => row.id === AUTOSAVE_SLOT_ID) : undefined;
    if (autosaveRow && autosaveRow.status.state === 'unreadable') {
      this.quarantineAutosave(autosaveRow).then(
        (failure) => (failure ? this.complete(request, this.failSave(request, failure)) : this.capturePost(request)),
        (error: unknown) => this.complete(request, this.failSave(request, toFailure(error))),
      );
      return;
    }
    this.capturePost(request);
  }

  /**
   * An unreadable autosave is never overwritten: it is moved to a free manual slot first, keeping
   * the raw record for the player. With no free slot, autosave pauses and says why.
   */
  private async quarantineAutosave(row: SaveSlotMeta): Promise<SaveFailure | null> {
    const free = MANUAL_SLOT_IDS.find((id) => !this.slots.some((slot) => slot.id === id));
    if (free === undefined) {
      this.suspendedReason = 'unreadable';
      const failure: SaveFailure = {
        code: 'slot-unreadable',
        message: 'Autosave paused: the autosave slot holds an unreadable save. Delete it in Save / Load.',
      };
      this.lastError = failure;
      return failure;
    }
    await this.store.move(AUTOSAVE_SLOT_ID, free);
    try {
      const moved = await this.store.updateMeta(free, { name: clampName(`Unreadable autosave: ${row.name}`) });
      this.upsertSlot(moved);
    } catch {
      this.slots = sortSlots(this.slots.map((slot) => (slot.id === AUTOSAVE_SLOT_ID ? { ...slot, id: free, kind: 'manual' as const } : slot)));
    }
    this.slots = this.slots.filter((slot) => slot.id !== AUTOSAVE_SLOT_ID);
    this.knownAutosaveRevision = null;
    this.setNotice('info', `The unreadable autosave was kept in ${free}.`);
    return null;
  }

  private capturePost(request: SaveRequest): void {
    let captured: CapturedPark;
    try {
      captured = this.host.capture();
    } catch (error) {
      this.complete(request, this.failSave(request, toFailure(error)));
      return;
    }
    const existing = this.slots.find((row) => row.id === request.slotId);
    // A rename is kept: the row's name wins over the default, for the autosave slot too.
    const keptName = existing && existing.status.state === 'ok' ? existing.name : undefined;
    const name = request.slotId === AUTOSAVE_SLOT_ID
      ? keptName ?? DEFAULT_AUTOSAVE_NAME
      : request.name ?? keptName ?? captured.scenarioName;
    const options: PersistJob['options'] = {};
    if (request.slotId === AUTOSAVE_SLOT_ID && this.knownAutosaveRevision !== undefined) {
      options.expectedRevision = this.knownAutosaveRevision;
    } else if (request.slotId !== AUTOSAVE_SLOT_ID && request.expectedRevision !== undefined) {
      options.expectedRevision = request.expectedRevision;
    }
    if (request.replaceUnreadable) options.replaceUnreadable = true;
    this.jobCounter += 1;
    const appStateVersion = this.appStateVersion;
    const job: PersistJob = {
      jobId: this.jobCounter,
      slotId: request.slotId,
      state: captured.state,
      app: captured.app,
      savedAtEpochMs: this.host.now(),
      name: clampName(name) || DEFAULT_AUTOSAVE_NAME,
      scenarioName: captured.scenarioName,
      ...(captured.mapName !== undefined ? { mapName: captured.mapName } : {}),
      ...(captured.biomeName !== undefined ? { biomeName: captured.biomeName } : {}),
      ...(captured.run !== undefined ? { run: captured.run } : {}),
      guestCount: captured.guestCount,
      cash: captured.cash,
      rating: captured.rating,
      writerTabId: this.tabId,
      options,
    };
    // The writer checks the record before rotating it into the previous generation unless it is known to be
    // this tab's own (Phase 31, `mustVerifyBeforeWrite`): the first autosave of a page session, and any autosave
    // that carries no revision expectation.
    const verifying = request.slotId === AUTOSAVE_SLOT_ID
      && ((!this.autosaveVerified && existing !== undefined) || options.expectedRevision === undefined);
    if (verifying) job.verifyExisting = true;
    if (request.slotId === AUTOSAVE_SLOT_ID) this.setIndicator('saving');
    this.emit({ type: 'saving', slotId: request.slotId, reason: request.reason });
    const startWrite = (): void => {
      let promise: Promise<PersistResult>;
      try {
        promise = this.writer.persist(job);
      } catch (error) {
        promise = Promise.reject(error);
      }
      promise.then(
        (result) => this.onPersisted(request, captured, result, verifying, appStateVersion),
        (error: unknown) => this.onPersisted(request, captured, {
          ok: false, jobId: job.jobId, error: { code: 'unknown', message: errorMessage(error) },
        }, verifying, appStateVersion),
      );
    };
    // The structured clone into the writer costs as much as the capture at high speed, so it gets a
    // task of its own instead of extending the frame's. A hidden-tab flush starts at once: timers
    // and idle callbacks of a closing page may never run.
    if (this.deferWrite !== null && request.reason !== 'hidden') this.deferWrite(startWrite);
    else startWrite();
  }

  private onPersisted(
    request: SaveRequest,
    captured: CapturedPark,
    result: PersistResult,
    verifying: boolean,
    appStateVersion: number,
  ): void {
    if (!result.ok && verifying && result.error.code === 'unreadable-slot') {
      // The record in the autosave slot is damaged although its metadata looked fine. Mark it, so the
      // row says why and the normal path quarantines it (never overwrites it), then run this save again.
      void this.markUnreadable(AUTOSAVE_SLOT_ID, 'corrupt', result.error.message).then(() => this.start(request));
      return;
    }
    if (!result.ok) {
      this.complete(request, this.failSave(request, { code: result.error.code, message: result.error.message }));
      return;
    }
    const { meta } = result;
    // A save that lands after another park started describes the OLD park: it updates the list, but
    // must not move this park's dirty baselines or point Ctrl+S at the old park's slot.
    const samePark = request.generation === this.parkGeneration;
    if (samePark) {
      // Baselines come from what was CAPTURED: the park kept running while the write was in progress.
      this.persistedVersion = captured.worldVersion;
      this.persistedTick = captured.tick;
    }
    if (request.slotId === AUTOSAVE_SLOT_ID) {
      this.noteRotation();
      if (samePark) {
        this.autosaveVersion = captured.worldVersion;
        this.autosaveTick = captured.tick;
        this.autosaveAppStateVersion = appStateVersion;
      }
      this.knownAutosaveRevision = meta.revision;
      this.autosaveVerified = true;
      this.firstAutosavePending = false;
      this.lastAutosavedAt = meta.savedAt;
      this.setIndicator('saved');
    } else if (isManualSlot(request.slotId)) {
      if (samePark) this.chosenQuickSlot = request.slotId;
      this.setNotice('info', this.persistence.state === 'ready'
        ? `Saved to ${meta.name}`
        : `Saved to ${meta.name} for this session only: storage is unavailable`);
    }
    if (this.persistence.state !== 'ready' && this.store.status().state === 'ready') this.setPersistenceReady();
    this.lastError = null;
    this.upsertSlot(meta);
    this.channel?.post({ type: 'changed', tabId: this.tabId });
    this.emit({ type: 'saved', slotId: request.slotId, reason: request.reason, meta });
    this.emit({ type: 'slots-changed' });
    this.complete(request, { ok: true, value: meta });
  }

  /**
   * After an autosave landed, the row it replaced is the previous generation now: the store moved it in the
   * write's transaction by the same rule (`planRotation`), so the list follows without a re-read. Runs
   * before the new autosave row is upserted, while `this.slots` still shows what was replaced.
   */
  private noteRotation(): void {
    const replaced = this.slots.find((row) => row.id === AUTOSAVE_SLOT_ID);
    if (replaced === undefined) return;
    if (planRotation(AUTOSAVE_SLOT_ID, replaced, true, { rotateTo: AUTOSAVE_PREVIOUS_SLOT_ID }) === null) return;
    const before = this.slots.find((row) => row.id === AUTOSAVE_PREVIOUS_SLOT_ID);
    this.upsertSlot({ ...metaForMove(replaced, AUTOSAVE_PREVIOUS_SLOT_ID), revision: (before?.revision ?? 0) + 1 });
  }

  /** Records a failed save (events, indicator, persistence status, suspension) and returns the result. */
  private failSave(request: SaveRequest, failure: SaveFailure): SaveResult<SaveSlotMeta> {
    const isAutosave = request.slotId === AUTOSAVE_SLOT_ID;
    this.noteStoreFailure(failure);
    if (isAutosave) {
      this.setIndicator('failed');
      if (failure.code === 'conflict') {
        this.suspendedReason = 'conflict';
        failure = { code: 'conflict', message: 'Another tab is saving this park\'s autosave. Autosave is paused here.' };
        this.emit({ type: 'autosave-conflict' });
      } else if (failure.code === 'unreadable-slot') {
        // The row we hold is stale: another tab (or a failed load) marked the slot. Re-list so the
        // next attempt quarantines it instead of bouncing off the store again.
        void this.refresh();
      }
    } else {
      if (failure.code === 'conflict') {
        failure = { code: 'conflict', message: 'This slot changed in another tab. The list was refreshed: check it and save again.' };
        void this.refresh();
      }
      this.setNotice('error', failure.message);
    }
    this.lastError = failure;
    this.emit({ type: 'failed', slotId: request.slotId, reason: request.reason, error: failure });
    return { ok: false, error: failure };
  }

  private complete(request: SaveRequest, result: SaveResult<SaveSlotMeta>): void {
    this.inFlight = null;
    this.busy.saving = null;
    this.markChanged();
    for (const resolve of request.resolvers) resolve(result);
    this.drain();
  }

  private drain(): void {
    if (this.inFlight !== null) return;
    const next = this.queue.shift();
    if (next) {
      this.start(next);
      return;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const wake of waiters) wake();
  }

  private whenIdle(): Promise<void> {
    if (this.inFlight === null && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => { this.idleWaiters.push(resolve); });
  }

  /** An autosave in flight or queued also writes the previous generation (the rotation), so it touches both. */
  private touchesInFlight(id: SaveSlotId): boolean {
    const touches = (slotId: SaveSlotId): boolean => slotId === id || (slotId === AUTOSAVE_SLOT_ID && id === AUTOSAVE_PREVIOUS_SLOT_ID);
    return (this.inFlight !== null && touches(this.inFlight.slotId)) || this.queue.some((request) => touches(request.slotId));
  }

  // --- Loading internals ---

  /**
   * Reads, migrates, validates and builds a FRESH session from a slot, or fails with a typed
   * failure (marking the slot unreadable when the record itself is bad). Touches no live state.
   */
  private async buildFromSlot(id: SaveSlotId, quiet = false): Promise<SaveResult<{ loaded: LoadedPark; revision: number }>> {
    const fail = (failure: SaveFailure): SaveResult<{ loaded: LoadedPark; revision: number }> => {
      // A preview that fails is reported by the start screen itself; the save strip and the dialog stay out of it.
      if (!quiet) {
        this.lastError = failure;
        this.setNotice('error', failure.message);
        this.emit({ type: 'failed', slotId: id, reason: 'load', error: failure });
      }
      return { ok: false, error: failure };
    };
    let payload: unknown;
    let loadedRevision: number;
    try {
      const record = await this.store.read(id);
      payload = record.payload;
      loadedRevision = record.revision;
    } catch (error) {
      return fail(this.noteStoreFailure(toFailure(error)));
    }
    let module: LoadModule;
    try {
      module = await this.loadModule();
    } catch (error) {
      return fail({ code: 'unknown', message: `The load code could not be fetched (${errorMessage(error)}). Check your connection and try again.` });
    }
    let loaded: LoadedPark;
    try {
      loaded = module.loadParkFromPayload(payload);
    } catch (error) {
      const description = module.loadFailureFrom(error);
      if (description.unreadableCode !== null) await this.markUnreadable(id, description.unreadableCode, description.message);
      return fail({ code: description.code, message: description.message });
    }
    return { ok: true, value: { loaded, revision: loadedRevision } };
  }

  /** What follows a park that is now the live one: the autosave and quick-save bookkeeping and the notice. */
  private finishLoad(id: SaveSlotId, loaded: LoadedPark, loadedRevision: number): SaveResult<LoadSummary> {
    const existing = this.slots.find((row) => row.id === id);
    // The previous generation is named by its place ("Previous autosave"), not by the autosave name it carries.
    const name = slotDisplayName({ id, name: existing?.name ?? DEFAULT_AUTOSAVE_NAME });
    // Playing the autosave's park means the stored autosave is now this tab's own to replace.
    if (id === AUTOSAVE_SLOT_ID) this.knownAutosaveRevision = loadedRevision;
    this.chosenQuickSlot = isManualSlot(id) ? id : null;
    this.lastError = null;
    this.setNotice('info', loaded.contentDrift === 'older'
      ? `Loaded ${name}. It was saved under an older balance.`
      : loaded.contentDrift === 'newer' ? `Loaded ${name}. It was saved under a newer balance.` : `Loaded ${name}`);
    const summary: LoadSummary = { slotId: id, contentDrift: loaded.contentDrift, name };
    this.emit({ type: 'loaded', summary });
    return { ok: true, value: summary };
  }

  private async loadSlot(id: SaveSlotId): Promise<SaveResult<LoadSummary>> {
    const built = await this.buildFromSlot(id);
    if (!built.ok) return built;
    const { loaded, revision } = built.value;
    try {
      this.host.installLoaded(loaded);
    } catch (error) {
      const failure: SaveFailure = { code: 'unknown', message: `The park could not be started from this save (${errorMessage(error)}).` };
      this.lastError = failure;
      this.setNotice('error', failure.message);
      this.emit({ type: 'failed', slotId: id, reason: 'load', error: failure });
      return { ok: false, error: failure };
    }
    return this.finishLoad(id, loaded, revision);
  }

  /**
   * Builds a park from a slot WITHOUT making it the live one (the start screen's camera sweep).
   * Nothing is installed and no bookkeeping moves; a record that cannot be read is flagged
   * unreadable exactly as a real load would. `adoptPreview` completes it if the player continues.
   */
  async loadPreview(id: SaveSlotId): Promise<SaveResult<ParkPreview>> {
    if (this.loading) return { ok: false, error: BUSY };
    this.loading = true;
    this.markChanged();
    const run = (async (): Promise<SaveResult<ParkPreview>> => {
      try {
        await this.whenIdle();
        const built = await this.buildFromSlot(id, true);
        if (!built.ok) return built;
        return { ok: true, value: { slotId: id, loaded: built.value.loaded, revision: built.value.revision } };
      } finally {
        this.loading = false;
        this.markChanged();
      }
    })();
    const settled = run.then(() => undefined, () => undefined);
    this.previewInFlight = settled;
    void settled.then(() => {
      if (this.previewInFlight === settled) this.previewInFlight = null;
    });
    return run;
  }

  /** Continue: the previewed park became the live one. Same bookkeeping as the tail of a load. */
  adoptPreview(preview: ParkPreview): LoadSummary {
    const result = this.finishLoad(preview.slotId, preview.loaded, preview.revision);
    // finishLoad never fails; the narrowing keeps the type honest without a cast.
    if (!result.ok) throw new Error('unreachable: finishLoad does not fail');
    return result.value;
  }

  /** The reason survives a reload because it is written into the slot's metadata, not just shown once. */
  private async markUnreadable(id: SaveSlotId, code: SaveErrorCode, message: string): Promise<void> {
    const status = { state: 'unreadable' as const, code, message };
    try {
      this.upsertSlot(await this.store.updateMeta(id, { status }));
    } catch {
      this.slots = this.slots.map((row) => (row.id === id ? { ...row, status } : row));
    }
  }

  // --- Persistence status ---

  private async openStore(retry = false): Promise<boolean> {
    let status: StoreStatus;
    try {
      status = await (retry ? this.retryStore() : this.store.init());
    } catch (error) {
      status = { state: 'unavailable', code: 'unavailable', message: errorMessage(error) };
    }
    if (this.disposed) return false;
    if (status.state === 'ready') {
      this.setPersistenceReady();
      await this.refresh();
      return true;
    }
    if (status.state === 'unavailable') this.setUnavailable(status.code, status.message);
    else this.setUnavailable('unavailable', 'The save database is closed.');
    return false;
  }

  private setPersistenceReady(): void {
    const wasUnavailable = this.persistence.state === 'unavailable';
    this.persistence = {
      state: 'ready', code: null, message: null, bannerDismissed: false, writer: this.writer.kind,
    };
    this.markChanged();
    if (wasUnavailable) this.emit({ type: 'persistence-restored' });
  }

  private setUnavailable(code: 'unavailable' | 'blocked' | 'quota', message: string): void {
    this.persistence = {
      state: 'unavailable', code, message, bannerDismissed: false, writer: this.writer.kind,
    };
    this.markChanged();
    this.emit({ type: 'persistence-unavailable', code, message });
  }

  /** Storage that stops working flips persistence to unavailable (once per failure); every other code passes through. */
  private noteStoreFailure(failure: SaveFailure): SaveFailure {
    if (isPersistenceCode(failure.code)) this.setUnavailable(failure.code, failure.message);
    return failure;
  }

  // --- Small helpers ---

  private autosaveState(): SavesSnapshot['autosave']['state'] {
    if (!this.host.hasPark() || this.persistence.state !== 'ready') return 'off';
    if (this.suspendedReason !== null || this.autosaveHeld) return 'suspended';
    return this.inFlight?.slotId === AUTOSAVE_SLOT_ID ? 'saving' : 'waiting';
  }

  /** The chosen slot, else the first manual slot with nothing in it, else none. */
  private quickSaveTarget(): ManualSaveSlotId | null {
    if (this.chosenQuickSlot !== null) {
      const row = this.slots.find((slot) => slot.id === this.chosenQuickSlot);
      if (!row || row.status.state === 'ok') return this.chosenQuickSlot;
    }
    return MANUAL_SLOT_IDS.find((id) => !this.slots.some((slot) => slot.id === id)) ?? null;
  }

  private isDirtyForAutosave(): boolean {
    return this.host.worldVersion() !== this.autosaveVersion
      || this.host.tick() !== this.autosaveTick
      || this.appStateVersion !== this.autosaveAppStateVersion;
  }

  private computeUnsaved(): boolean {
    return this.host.worldVersion() !== this.persistedVersion
      || (this.host.tick() - this.persistedTick) * STEP_SECONDS > UNSAVED_PROGRESS_SIMULATED_SECONDS;
  }

  private gapElapsed(seconds: number): boolean {
    return this.host.now() - this.lastAutosaveAttemptAt >= seconds * 1000;
  }

  private refuse(failure: SaveFailure, reason: SaveReason | 'rename' | 'delete' = 'manual', slotId: SaveSlotId | null = null): { ok: false; error: SaveFailure } {
    this.lastError = failure;
    this.setNotice('error', failure.message);
    this.emit({ type: 'failed', slotId, reason, error: failure });
    this.markChanged();
    return { ok: false, error: failure };
  }

  private upsertSlot(meta: SaveSlotMeta): void {
    const without = this.slots.filter((row) => row.id !== meta.id);
    without.push(meta);
    this.slots = sortSlots(without);
    this.markChanged();
  }

  private setIndicator(indicator: AutosaveIndicator): void {
    this.indicator = indicator;
    this.timers.clearTimeout(this.indicatorTimer);
    this.indicatorTimer = null;
    if (indicator === 'saved') {
      this.indicatorTimer = this.timers.setTimeout(() => {
        this.indicatorTimer = null;
        if (this.indicator === 'saved') this.setIndicator('hidden');
      }, AUTOSAVE_INDICATOR_VISIBLE_MS);
    }
    this.emit({ type: 'autosave-indicator', indicator });
    this.markChanged();
  }

  private setNotice(kind: SaveNotice['kind'], text: string): void {
    this.noticeCounter += 1;
    const id = this.noticeCounter;
    this.notice = { id, kind, text };
    this.timers.clearTimeout(this.noticeTimer);
    this.noticeTimer = this.timers.setTimeout(() => {
      this.noticeTimer = null;
      if (this.notice?.id === id) {
        this.notice = null;
        this.markChanged();
      }
    }, SAVE_NOTICE_VISIBLE_MS);
    this.markChanged();
  }

  private emit(event: SaveEvent): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error(error);
      }
    }
  }

  /** Leading edge publishes at once; changes inside the interval collapse into one trailing publish. */
  private markChanged(): void {
    if (this.disposed) return;
    this.snapshotDirty = true;
    if (this.publishTimer !== null) return;
    const wait = Math.max(0, this.lastPublishAt + SNAPSHOT_PUBLISH_INTERVAL_MS - this.host.now());
    if (wait === 0) {
      this.publishNow();
      return;
    }
    this.publishTimer = this.timers.setTimeout(() => {
      this.publishTimer = null;
      this.publishNow();
    }, wait);
  }

  private publishNow(): void {
    if (!this.snapshotDirty || this.disposed) return;
    this.snapshotDirty = false;
    this.lastPublishAt = this.host.now();
    this.publish(this.snapshot());
  }
}
