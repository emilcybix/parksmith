import type { ParkSession } from '../../game/session/ParkSession';
import type { ContentDrift, ParkSave, ParkSaveAppState, SaveErrorCode } from '../../game/save/version';
import type { ParkSaveV4 } from '../../game/save/state';
import type { ParkScenarioId } from '../../game/scenarios/types';
import type { RunSummary } from '../../game/run/types';
import type { GameMode } from '../../game/modes/types';

/**
 * The contract of the app-level save layer (Phase 12, step 2). Three builders work against this
 * file in parallel: the store (IndexedDB), the manager (autosave, save, load) and the UI. Nothing
 * here imports React, Pixi or IndexedDB types, so the manager can be tested with an in-memory store.
 * DESIGN.md next to this phase explains the behaviour; these types fix the names and shapes.
 */

// --- Slots ------------------------------------------------------------------------------------

export type ManualSaveSlotId =
  | 'manual-1' | 'manual-2' | 'manual-3' | 'manual-4' | 'manual-5'
  | 'manual-6' | 'manual-7' | 'manual-8' | 'manual-9' | 'manual-10';

/**
 * Phase 31: the two rolling autosave generations. `autosave` is the newest; every autosave write moves
 * it to `autosave-previous` in the same transaction (`StoreWriteOptions.rotateTo`), so one bad write
 * can no longer cost the whole park. The previous generation is read-only: it is loaded, listed and
 * deleted, never saved to, renamed or quick-saved to. A build from before Phase 31 does not know the
 * id and lists the record as an unreadable orphan ("Unknown slot"), which it can only delete.
 */
export type AutosaveSlotId = 'autosave' | 'autosave-previous';

/**
 * Stable ids, never reused for another meaning, so multi-slot UI needs no migration. A closed
 * union (not `string`) because ids are produced only by this app; the store still treats a record
 * with an unknown id as an unreadable orphan instead of dropping it.
 */
export type SaveSlotId = AutosaveSlotId | ManualSaveSlotId;

/** Both autosave generations are kind 'auto'; which generation a row is follows from its id (`autosaveGeneration`). */
export type SaveSlotKind = 'auto' | 'manual';

/** Which autosave generation a slot holds: the newest write, or the one before it. */
export type AutosaveGeneration = 'current' | 'previous';

/** Why a stored record cannot be loaded. SaveError codes come from the loader; the rest from the store. */
export type UnreadableCode =
  | SaveErrorCode
  /** The payload record exists but is not a record we wrote (wrong shape, not structured-cloneable data). */
  | 'record-corrupt'
  /** The metadata record is damaged; the slot is listed from its key alone. */
  | 'meta-corrupt'
  /** Metadata exists but its payload does not (or the other way round: orphan payload). */
  | 'payload-missing';

export type SaveSlotStatus =
  | { state: 'ok' }
  | { state: 'unreadable'; code: UnreadableCode; message: string };

/**
 * Everything the slot list shows, readable without the payload. Written in the same transaction as
 * the payload, so the two never disagree about a save that was completed.
 */
export interface SaveSlotMeta {
  id: SaveSlotId;
  kind: SaveSlotKind;
  /** Player-editable label. Defaults to the scenario name, 'Sandbox park', or 'Autosave'. */
  name: string;
  /** null = Sandbox. A park of The Map is the run's stage scenario (`the-map-stage`). */
  scenarioId: ParkScenarioId | null;
  /** Display name of the scenario, frozen at save time (content may be renamed later). */
  scenarioName: string;
  /** Phase 22: how the park was played (from the save header). Optional: older records read as `legacyModeOf(scenarioId)`. */
  mode?: GameMode;
  /**
   * Phase 24: the map the park was played on ("Red Rock Canyon", or "Custom map") and its biome ("Desert Canyon"),
   * frozen at save time like `scenarioName`. Optional: records written before Phase 24 lack them and read as the
   * Meadow Garden map in the Meadow biome (`slotMapName`, `slotBiomeName`).
   */
  mapName?: string;
  biomeName?: string;
  /**
   * Phase 23: where The Map run stands (level, seed, difficulty, phase), frozen at save time, in a park of mode `run` only.
   * The UI builds 'The Map · level 3/5 · seed N' from it and never parses a name. Absent on every other save.
   */
  run?: RunSummary;
  /**
   * Park time: simulated seconds from the saved clock (simulationTimeMs / 1000). It is what the
   * save itself knows and it survives loads, unlike wall-clock play time.
   */
  playtimeSeconds: number;
  /** Epoch ms, from the clock the SaveManager was given (src/game never reads a clock). */
  savedAt: number;
  schemaVersion: number;
  contentVersion: number;
  savedAtTick: number;
  guestCount: number;
  cash: number;
  /** Park rating 0..100 as management reports it. */
  rating: number;
  /** Approximate size of the serialized payload (JSON length), for the list and quota messages. */
  sizeBytes: number;
  /** Increments on every write to this slot; the multi-tab conflict check compares it. */
  revision: number;
  /** Random per-tab id of the last writer. */
  writerTabId: string;
  status: SaveSlotStatus;
}

/** What is stored in the payload object store: the payload is a ParkSave when status is ok. */
export interface SaveRecord {
  id: SaveSlotId;
  /** Deliberately `unknown`: an unreadable record is kept raw and shown to the loader as found. */
  payload: unknown;
  revision: number;
}

// --- Store ------------------------------------------------------------------------------------

export type StoreErrorCode =
  /** No IndexedDB, or opening it failed (private mode, security policy, newer database). */
  | 'unavailable'
  /** Another connection (old tab) blocks the upgrade; retry after it closes. */
  | 'blocked'
  /** QuotaExceededError on write. The previous record is untouched (the transaction aborted). */
  | 'quota'
  /** The record or the database is damaged in a way the store itself detected. */
  | 'corrupt'
  | 'not-found'
  /** The slot changed since the expected revision (another tab wrote it). */
  | 'conflict'
  /** The slot holds an unreadable save and the write did not explicitly replace it. */
  | 'unreadable-slot'
  | 'unknown';

export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'StoreError';
    this.code = code;
  }
}

export type StoreStatus =
  | { state: 'closed' }
  | { state: 'ready' }
  | { state: 'unavailable'; code: 'unavailable' | 'blocked' | 'quota'; message: string };

export interface StoreWriteOptions {
  /**
   * Revision the caller believes the slot is at (null = slot must not exist). A mismatch rejects
   * with 'conflict'. Omitted = last writer wins (manual save the player confirmed).
   */
  expectedRevision?: number | null;
  /** True only for an explicit, confirmed replacement of an unreadable slot. */
  replaceUnreadable?: boolean;
  /**
   * Phase 31, autosave generations: in the SAME transaction as the write, the record the slot holds now
   * (meta and payload) is moved to this slot first, replacing whatever that slot held, and then the new
   * record is put. Nothing moves when the slot is empty, or when what it holds is unreadable by the
   * store's rules (that write needs `replaceUnreadable`, and a damaged record must never push a good
   * one out of the rotation target). A write that fails leaves both slots exactly as they were.
   */
  rotateTo?: SaveSlotId;
}

/**
 * The persistence port. Implemented by IndexedDbSaveStore (and by a test-only in-memory store).
 * Every method rejects with StoreError, never with a raw DOMException, and never throws
 * synchronously. After a failure the store stays usable: a later call retries from scratch.
 */
export interface SaveStore {
  /** Opens the database. Resolves with the resulting status instead of rejecting. */
  init(): Promise<StoreStatus>;
  status(): StoreStatus;
  /** Metadata only (the 'slots' store plus the key list of 'payloads'): never deserializes a payload. */
  list(): Promise<SaveSlotMeta[]>;
  /** The raw record, exactly as stored. Rejects 'not-found'. */
  read(id: SaveSlotId): Promise<SaveRecord>;
  /** One readwrite transaction over both stores; resolves on transaction complete, not on request success. */
  write(id: SaveSlotId, payload: unknown, meta: SaveSlotMeta, options?: StoreWriteOptions): Promise<void>;
  /** Metadata-only update (rename, mark unreadable). Never touches the payload. */
  updateMeta(id: SaveSlotId, patch: Partial<Pick<SaveSlotMeta, 'name' | 'status'>>): Promise<SaveSlotMeta>;
  /**
   * Atomically moves a record (meta + payload) to a free slot; used to quarantine an unreadable autosave.
   * The rotation of the autosave generations is not a move (its target is never free): see `StoreWriteOptions.rotateTo`.
   */
  move(from: SaveSlotId, to: SaveSlotId): Promise<void>;
  /** Deletes meta and payload in one transaction. Deleting an absent slot resolves. */
  remove(id: SaveSlotId): Promise<void>;
  close(): void;
}

// --- Writer (off-frame sealing and persisting) ------------------------------------------------

/** What the manager hands over: an independent deep copy, so it can be sealed at leisure. */
export interface PersistJob {
  jobId: number;
  slotId: SaveSlotId;
  state: ParkSaveV4;
  app: ParkSaveAppState;
  savedAtEpochMs: number;
  /** Slot name to store. */
  name: string;
  scenarioName: string;
  /** Phase 24: names of the map and biome, for the list row (the manager resolves them; the worker stays free of game content). */
  mapName?: string;
  biomeName?: string;
  /** Phase 23: the run summary of a Map park, for the list row. */
  run?: RunSummary;
  /** For the list row; read from the live session at capture time (the state holds them too). */
  guestCount: number;
  cash: number;
  rating: number;
  writerTabId: string;
  options: StoreWriteOptions;
  /**
   * Set on the first autosave of a page session when a record already sits in the autosave slot.
   * The writer then checks that record's integrity BEFORE replacing it and refuses with
   * 'unreadable-slot' if it is damaged, so a record nobody has tried to load yet (the store cannot
   * tell a garbage payload from a good one by its metadata) is quarantined instead of overwritten.
   */
  verifyExisting?: boolean;
}

export type PersistResult =
  | { ok: true; jobId: number; meta: SaveSlotMeta; hashMs: number; writeMs: number }
  | { ok: false; jobId: number; error: { code: StoreErrorCode | 'seal-failed'; message: string } };

/**
 * Seals (createParkSave: the 30 ms hash), computes sizeBytes, and writes. Two implementations:
 * WorkerSaveWriter (module Web Worker that owns its own IndexedDbSaveStore connection) and
 * IdleSaveWriter (fallback: requestIdleCallback on the main thread, then the manager's store).
 */
export interface SaveWriter {
  readonly kind: 'worker' | 'idle';
  persist(job: PersistJob): Promise<PersistResult>;
  dispose(): void;
}

// --- Manager ---------------------------------------------------------------------------------

/** Result of capturing a park at a step boundary. */
export interface CapturedPark {
  state: ParkSaveV4;
  app: ParkSaveAppState;
  scenarioName: string;
  /** Phase 24: the map and biome names at capture time. */
  mapName?: string;
  biomeName?: string;
  /** Phase 23: the run summary (mode `run` only). */
  run?: RunSummary;
  guestCount: number;
  cash: number;
  rating: number;
  /** world.version and world.tick at capture time, the dirty-tracking baseline. */
  worldVersion: number;
  tick: number;
}

/** A park built from a slot but not (yet) the live one: the start screen's sweep session. */
export interface ParkPreview {
  slotId: SaveSlotId;
  loaded: LoadedPark;
  /** The slot revision that was read, so Continue can tell a changed slot from the one it previewed. */
  revision: number;
}

export interface LoadedPark {
  session: ParkSession;
  save: ParkSave;
  contentDrift: ContentDrift;
}

/** The lazily imported load path (src/app/saves/loadPath.ts). Exactly one export. */
export interface LoadPathModule {
  /** Migrates, validates and builds a FRESH session; throws SaveError. Never touches the live park. */
  loadParkFromPayload(payload: unknown): LoadedPark;
}

/**
 * What GameApp provides to the manager. Keeping this a port is what lets the manager be tested
 * without a renderer, and keeps session swapping (a GameApp concern) out of the save layer.
 */
export interface SaveHost {
  /** False before the first park exists. */
  hasPark(): boolean;
  /** Cheap, allocation-free; read every frame for dirty tracking. */
  worldVersion(): number;
  tick(): number;
  /** True while simulation time advances (not paused, scenario not latched). */
  isRunning(): boolean;
  /**
   * Called only between simulation steps (from the ticker, or from a DOM event handler, which
   * cannot interleave with a synchronous clock.update). Runs session.syncWithWorld() and retries
   * once if serialize throws SaveError('unsynced'); throws SaveError otherwise.
   */
  capture(): CapturedPark;
  /**
   * Swaps in a loaded session exactly as startScenario does, restores the tour node association
   * from save.app.tourNodeId, refreshes management/UI snapshots, and returns when the first
   * frame can be painted. Must not throw for a well-formed LoadedPark.
   */
  installLoaded(loaded: LoadedPark): void;
  /** Epoch ms. Injected so tests control it. */
  now(): number;
}

export type SaveReason = 'manual' | 'quick' | 'interval' | 'park-start' | 'scenario-result' | 'hidden';

export type SaveFailureCode =
  | StoreErrorCode
  | SaveErrorCode
  | 'seal-failed'
  /** Another save for the same slot is in flight and this request was not coalesced. */
  | 'busy'
  /**
   * Not a failure: the load waits for the "Leave the run?" answer (Phase 23). The app closed the Save / Load dialog to
   * ask, so the dialog reports nothing for it.
   */
  | 'deferred'
  /** The manager is not initialised or has no park. */
  | 'not-ready'
  | 'no-park'
  /** A confirmed overwrite of an unreadable slot is required first. */
  | 'slot-unreadable'
  | 'invalid-slot'
  | 'worker-failed';

export interface SaveFailure {
  code: SaveFailureCode;
  message: string;
}

export type SaveResult<T> = { ok: true; value: T } | { ok: false; error: SaveFailure };

export interface LoadSummary {
  slotId: SaveSlotId;
  contentDrift: ContentDrift;
  name: string;
}

export type SaveEvent =
  | { type: 'saving'; slotId: SaveSlotId; reason: SaveReason }
  | { type: 'saved'; slotId: SaveSlotId; reason: SaveReason; meta: SaveSlotMeta }
  | { type: 'failed'; slotId: SaveSlotId | null; reason: SaveReason | 'load' | 'list' | 'delete' | 'rename'; error: SaveFailure }
  | { type: 'loaded'; summary: LoadSummary }
  | { type: 'persistence-unavailable'; code: 'unavailable' | 'blocked' | 'quota'; message: string }
  | { type: 'persistence-restored' }
  | { type: 'autosave-indicator'; indicator: AutosaveIndicator }
  /** Another tab wrote the autosave slot; this tab stops autosaving until the player resumes. */
  | { type: 'autosave-conflict' }
  | { type: 'slots-changed' };

export type AutosaveIndicator = 'hidden' | 'saving' | 'saved' | 'failed';

export interface SaveManager {
  /** Opens the store, creates the writer, lists slots. Resolves even when persistence is unavailable. */
  init(): Promise<void>;
  snapshot(): SavesSnapshot;
  subscribe(listener: (event: SaveEvent) => void): () => void;
  /**
   * Called every frame from the ticker AFTER clock.update with the real frame delta. Allocation-free:
   * adds to timers and compares two numbers; starts an autosave capture when one is due.
   */
  frame(deltaMs: number): void;
  /** A new or loaded park exists: resets the dirty baseline and arms the first autosave. */
  notifyParkStarted(): void;
  /** The scenario latched success or failure: autosave now (subject to the min gap). */
  notifyScenarioResult(): void;
  /** visibilitychange to hidden, and pagehide. Best effort; never throws. */
  flushOnHide(): void;
  saveToSlot(id: ManualSaveSlotId, name?: string, options?: { confirmedReplaceUnreadable?: boolean }): Promise<SaveResult<SaveSlotMeta>>;
  quickSave(): Promise<SaveResult<SaveSlotMeta>>;
  load(id: SaveSlotId): Promise<SaveResult<LoadSummary>>;
  /** Builds a park from a slot without installing it (see ParkPreview); the slot is flagged unreadable if it is bad. */
  loadPreview(id: SaveSlotId): Promise<SaveResult<ParkPreview>>;
  /** The previewed park is now the live one: the load bookkeeping without the install. */
  adoptPreview(preview: ParkPreview): LoadSummary;
  rename(id: SaveSlotId, name: string): Promise<SaveResult<SaveSlotMeta>>;
  remove(id: SaveSlotId): Promise<SaveResult<null>>;
  /** Re-lists (dialog open, other tab changed something). */
  refresh(): Promise<void>;
  retryPersistence(): Promise<void>;
  dismissBanner(): void;
  /** After an autosave-conflict: take over the autosave slot in this tab. */
  resumeAutosaveHere(): void;
  dispose(): void;
}

// --- UI snapshot and commands -----------------------------------------------------------------

export type PersistenceState = 'checking' | 'ready' | 'unavailable';

export interface PersistenceStatus {
  state: PersistenceState;
  code: 'unavailable' | 'blocked' | 'quota' | null;
  message: string | null;
  /** The player closed the banner; it returns on the next failure. */
  bannerDismissed: boolean;
  /** Which writer runs: 'worker', or 'idle' when workers are unavailable (UI may show nothing). */
  writer: 'worker' | 'idle' | null;
}

export type AutosaveState = 'off' | 'waiting' | 'saving' | 'suspended';

export interface SaveNotice {
  /** Monotonic id so the UI can key and expire toasts. */
  id: number;
  kind: 'info' | 'error';
  text: string;
}

export interface SavesBusy {
  listing: boolean;
  saving: SaveSlotId | null;
  loading: SaveSlotId | null;
  /** A rename or delete in progress. */
  mutating: SaveSlotId | null;
}

/** The slice of the Zustand store the dialog, the HUD indicator and the banner render from. */
export interface SavesSnapshot {
  /** Autosave first, then the previous autosave (Phase 31), then manual-1..N that exist, plus unreadable ones. Empty slots are not listed. */
  slots: SaveSlotMeta[];
  listState: 'idle' | 'loading' | 'ready' | 'error';
  busy: SavesBusy;
  persistence: PersistenceStatus;
  autosave: {
    state: AutosaveState;
    indicator: AutosaveIndicator;
    /** Epoch ms of the last successful autosave, null before the first. */
    lastSavedAt: number | null;
  };
  /** True when the live park has edits (or enough progress) not persisted to any slot. */
  unsavedChanges: boolean;
  /** The slot Ctrl+S writes to next, or null when every manual slot is taken and none was chosen. */
  quickSaveSlotId: ManualSaveSlotId | null;
  /** The last operation error, cleared by the next success or by the player. */
  lastError: SaveFailure | null;
  notice: SaveNotice | null;
}

/** UI -> app. Registered by GameApp through registerSaveCommands (see gameBridge.ts). */
export interface SaveCommands {
  saveToSlot(id: ManualSaveSlotId, name?: string, options?: { confirmedReplaceUnreadable?: boolean }): Promise<SaveResult<SaveSlotMeta>>;
  quickSave(): Promise<SaveResult<SaveSlotMeta>>;
  load(id: SaveSlotId): Promise<SaveResult<LoadSummary>>;
  rename(id: SaveSlotId, name: string): Promise<SaveResult<SaveSlotMeta>>;
  remove(id: SaveSlotId): Promise<SaveResult<null>>;
  refresh(): Promise<void>;
  retryPersistence(): Promise<void>;
  dismissBanner(): void;
  resumeAutosaveHere(): void;
}
