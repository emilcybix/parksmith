import { readRunSummary } from './runMeta';
import { isGameMode } from '../../game/modes/types';
import { SAVE_SCHEMA_VERSION } from '../../game/save/version';
import { AUTOSAVE_PREVIOUS_SLOT_ID, AUTOSAVE_SLOT_ID, MANUAL_SLOT_IDS } from './constants';
import { isAutosaveSlotId } from './autosaveGenerations';
import type {
  SaveRecord,
  SaveSlotId,
  SaveSlotMeta,
  SaveSlotStatus,
  SaveStore,
  StoreStatus,
  UnreadableCode,
  StoreWriteOptions,
} from './types';
import { StoreError } from './types';

/**
 * The in-memory SaveStore, plus the pure rules both stores share.
 *
 * Why the rules live here: the IndexedDB store, the memory store and the tests must agree on what an
 * unreadable slot is, when a write is refused and how a listing is merged from two object stores.
 * Two copies of that logic would drift, and a drift here means an unreadable save silently
 * overwritten. This file imports nothing from IndexedDB, so the store worker can load it cheaply.
 *
 * As a store it is the fallback when IndexedDB is unavailable (private mode, blocked, quota): the
 * session keeps running, manual saves still land somewhere, and createSaveStore moves them into
 * IndexedDB when it comes back. It is never durable, which `backend` says out loud.
 */

// --- Shared pure rules --------------------------------------------------------------------------

export const isSaveSlotId = (value: unknown): value is SaveSlotId => (
  isAutosaveSlotId(value) || (typeof value === 'string' && (MANUAL_SLOT_IDS as readonly string[]).includes(value))
);

const isRecordObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const NUMERIC_META_FIELDS = [
  'playtimeSeconds', 'savedAt', 'schemaVersion', 'contentVersion', 'savedAtTick',
  'guestCount', 'cash', 'rating', 'sizeBytes', 'revision',
] as const;

const parseStatus = (value: unknown): SaveSlotStatus | null => {
  if (!isRecordObject(value)) return null;
  if (value.state === 'ok') return { state: 'ok' };
  if (value.state === 'unreadable' && typeof value.code === 'string' && typeof value.message === 'string') {
    return { state: 'unreadable', code: value.code as UnreadableCode, message: value.message };
  }
  return null;
};

/**
 * Accepts a stored metadata value only when every field the slot list renders has the right type.
 * A value that fails is listed as 'meta-corrupt' rather than rendered with NaN or crashing the
 * dialog. The payload is never consulted here.
 */
export const parseSlotMeta = (value: unknown): SaveSlotMeta | null => {
  if (!isRecordObject(value)) return null;
  if (typeof value.id !== 'string') return null;
  if (value.kind !== 'auto' && value.kind !== 'manual') return null;
  if (typeof value.name !== 'string' || typeof value.scenarioName !== 'string' || typeof value.writerTabId !== 'string') return null;
  if (value.scenarioId !== null && typeof value.scenarioId !== 'string') return null;
  for (const field of NUMERIC_META_FIELDS) {
    if (!isFiniteNumber(value[field])) return null;
  }
  const status = parseStatus(value.status);
  if (!status) return null;
  const meta = { ...(value as unknown as SaveSlotMeta), status };
  // Optional Phase 24 fields: a hostile or damaged value is dropped, and the row falls back to the Meadow default.
  if (typeof meta.mapName !== 'string') delete meta.mapName;
  if (typeof meta.biomeName !== 'string') delete meta.biomeName;
  // Phase 22: a hostile or missing mode is dropped, and the row reads `legacyModeOf(scenarioId)` (see `slotMode`).
  if (!isGameMode(meta.mode)) delete meta.mode;
  // Phase 23: a hostile run summary is dropped and the row shows the ordinary park texts.
  if (Object.hasOwn(meta, 'run')) {
    const run = readRunSummary(meta.run);
    if (run === null) delete meta.run;
    else meta.run = run;
  }
  return meta;
};

const unreadableRow = (key: unknown, code: 'meta-corrupt' | 'payload-missing', message: string): SaveSlotMeta => ({
  id: String(key) as SaveSlotId,
  kind: isAutosaveSlotId(key) ? 'auto' : 'manual',
  name: 'Unknown save',
  scenarioId: null,
  scenarioName: '',
  playtimeSeconds: 0,
  savedAt: 0,
  schemaVersion: 0,
  contentVersion: 0,
  savedAtTick: 0,
  guestCount: 0,
  cash: 0,
  rating: 0,
  sizeBytes: 0,
  revision: 0,
  writerTabId: '',
  status: { state: 'unreadable', code, message },
});

/** A metadata value with the key it was stored under (the key is what identifies a damaged value). */
export interface MetaEntry {
  key: unknown;
  value: unknown;
}

const slotOrder = (id: string): number => {
  if (id === AUTOSAVE_SLOT_ID) return -2;
  if (id === AUTOSAVE_PREVIOUS_SLOT_ID) return -1;
  const index = (MANUAL_SLOT_IDS as readonly string[]).indexOf(id);
  return index === -1 ? MANUAL_SLOT_IDS.length : index;
};

/**
 * Merges the metadata store with the key list of the payload store into the slot list. Nothing is
 * dropped: a damaged, orphaned or unknown record becomes an unreadable row the player can delete,
 * and a schema newer than this build is reported from the header alone, without reading a payload.
 */
export const buildListing = (metaEntries: readonly MetaEntry[], payloadKeys: readonly unknown[]): SaveSlotMeta[] => {
  const payloadKeySet = new Set<unknown>(payloadKeys);
  const metaKeySet = new Set<unknown>();
  const rows: SaveSlotMeta[] = [];
  for (const { key, value } of metaEntries) {
    metaKeySet.add(key);
    const parsed = parseSlotMeta(value);
    if (!parsed || parsed.id !== key) {
      rows.push(unreadableRow(key, 'meta-corrupt', 'The save list entry is damaged. Delete it to free the slot.'));
    } else if (!isSaveSlotId(key)) {
      rows.push({ ...parsed, status: { state: 'unreadable', code: 'meta-corrupt', message: `Unknown slot "${String(key)}".` } });
    } else if (!payloadKeySet.has(key)) {
      rows.push({ ...parsed, status: { state: 'unreadable', code: 'payload-missing', message: 'The save data for this slot is missing.' } });
    } else if (parsed.status.state === 'ok' && parsed.schemaVersion > SAVE_SCHEMA_VERSION) {
      rows.push({
        ...parsed,
        status: { state: 'unreadable', code: 'too-new', message: `Saved by a newer version of the game (save format ${parsed.schemaVersion}, this build reads up to ${SAVE_SCHEMA_VERSION}).` },
      });
    } else {
      rows.push(parsed);
    }
  }
  for (const key of payloadKeys) {
    if (!metaKeySet.has(key)) {
      rows.push(unreadableRow(key, 'payload-missing', 'Save data exists without its list entry. Delete it to free the slot.'));
    }
  }
  rows.sort((a, b) => slotOrder(a.id) - slotOrder(b.id) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
};

/**
 * The write rules, applied inside the write transaction against what is actually stored: the
 * expected-revision check (multi-tab), then the protection of unreadable slots. Returns the
 * revision the write gets, or throws the StoreError that refuses it.
 *
 * `previousMeta` is undefined when the slot has no metadata record at all.
 */
export const planWrite = (previousMeta: unknown, payloadExists: boolean, options: StoreWriteOptions | undefined): number => {
  const parsed = previousMeta === undefined ? null : parseSlotMeta(previousMeta);
  const previousRevision = parsed ? parsed.revision : 0;
  const expected = options?.expectedRevision;
  if (expected === null && previousMeta !== undefined) {
    throw new StoreError('conflict', 'The slot already holds a save; another tab wrote it.');
  }
  if (typeof expected === 'number' && (!parsed || parsed.revision !== expected)) {
    throw new StoreError('conflict', `The slot changed since revision ${expected}; another tab wrote it.`);
  }
  const unreadable = previousMeta === undefined
    ? payloadExists
    : (!parsed || parsed.status.state === 'unreadable' || parsed.schemaVersion > SAVE_SCHEMA_VERSION || !payloadExists);
  if (unreadable && !options?.replaceUnreadable) {
    throw new StoreError('unreadable-slot', 'The slot holds a save that cannot be read; delete it or confirm replacing it.');
  }
  return previousRevision + 1;
};

/**
 * Phase 31: where a write moves the record its slot holds now (`StoreWriteOptions.rotateTo`), or null for
 * no rotation. Applied inside the write transaction, after `planWrite` accepted the write, against what is
 * actually stored. Nothing rotates out of an empty slot, and nothing that the store would call unreadable
 * (damaged or missing meta, missing payload, an unreadable status, a newer schema): such a write only got
 * through with `replaceUnreadable`, and a damaged record must never push a good one out of the target.
 */
export const planRotation = (
  id: SaveSlotId,
  previousMeta: unknown,
  payloadExists: boolean,
  options: StoreWriteOptions | undefined,
): SaveSlotId | null => {
  const target = options?.rotateTo;
  if (target === undefined || target === id || previousMeta === undefined || !payloadExists) return null;
  const parsed = parseSlotMeta(previousMeta);
  if (!parsed || parsed.status.state !== 'ok' || parsed.schemaVersion > SAVE_SCHEMA_VERSION) return null;
  return target;
};

/**
 * The record and metadata a rotation puts into the target slot: the source's own, re-keyed, with the
 * target's revision advanced (a revision only ever grows per slot, so a Continue that previewed the old
 * target sees that it changed). `targetMeta` is whatever the target held, if anything.
 */
export const rotatedRecord = (
  to: SaveSlotId,
  from: SaveSlotId,
  storedPayload: unknown,
  previousMeta: unknown,
  targetMeta: unknown,
): { record: SaveRecord; meta: SaveSlotMeta } => {
  const target = targetMeta === undefined ? null : parseSlotMeta(targetMeta);
  const revision = (target?.revision ?? 0) + 1;
  const source = asSaveRecord(from, storedPayload);
  return {
    record: { ...source, id: to, revision },
    meta: { ...metaForMove(previousMeta, to), revision },
  };
};

/** True when a stored payload value has the shape of a SaveRecord this store wrote. */
export const isStoredRecord = (value: unknown): value is SaveRecord => (
  isRecordObject(value) && 'payload' in value && isFiniteNumber(value.revision) && typeof value.id === 'string'
);

/**
 * What read() returns for any stored value: our own records pass through, anything else is handed
 * to the loader raw (as `payload`) so it can report not-a-save instead of the store hiding it.
 */
export const asSaveRecord = (id: SaveSlotId, stored: unknown): SaveRecord => (
  isStoredRecord(stored) ? stored : { id, payload: stored, revision: 0 }
);

/**
 * Metadata for a record moved to a new slot: the old metadata re-keyed, or an unreadable
 * placeholder when there was none, so a quarantined orphan stays visible.
 */
export const metaForMove = (previousMeta: unknown, to: SaveSlotId): SaveSlotMeta => {
  const parsed = parseSlotMeta(previousMeta);
  const kind = isAutosaveSlotId(to) ? 'auto' : 'manual';
  if (parsed) return { ...parsed, id: to, kind };
  return { ...unreadableRow(to, 'meta-corrupt', 'The save list entry was damaged when this save was moved.'), id: to, kind };
};

/** Maps a thrown value to a StoreError for the structured-clone step shared by both stores. */
export const cloneFailure = (error: unknown): StoreError => {
  if (error instanceof StoreError) return error;
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
  if (name === 'DataCloneError') {
    return new StoreError('corrupt', 'The save contains data that cannot be stored.', { cause: error });
  }
  return new StoreError('unknown', error instanceof Error ? error.message : 'Unknown storage error.', { cause: error });
};

// --- The memory store ---------------------------------------------------------------------------

export interface MemoryStoreFallbackReason {
  code: 'unavailable' | 'blocked' | 'quota';
  message: string;
}

/**
 * Same interface and the same rules as the IndexedDB store, over two Maps (metadata and payloads
 * stay separate on purpose, so a corrupt listing can be reproduced). Values are structured-cloned
 * on the way in and out: the caller keeps mutating its session after a save, and a store that
 * aliased the caller's object would "save" the future.
 */
export class MemorySaveStore implements SaveStore {
  /** Not durable: a reload loses everything. UI and createSaveStore read this, not the status. */
  readonly backend = 'memory-only' as const;

  private readonly metas = new Map<string, unknown>();
  private readonly payloads = new Map<string, unknown>();
  private fallbackReason: MemoryStoreFallbackReason | null;

  /**
   * `fallbackReason` set = this store stands in for an IndexedDB that failed, so status() reports
   * the reason (the manager shows the persistence banner from it). Absent = a deliberate in-memory
   * store (tests), which reports ready.
   */
  constructor(fallbackReason: MemoryStoreFallbackReason | null = null) {
    this.fallbackReason = fallbackReason;
  }

  setFallbackReason(reason: MemoryStoreFallbackReason | null): void {
    this.fallbackReason = reason;
  }

  /** Test seam: plants raw records (undefined = leave that store empty) to reproduce damaged data. */
  seedRaw(key: string, metaValue: unknown, payloadValue: unknown): void {
    if (metaValue !== undefined) this.metas.set(key, structuredClone(metaValue));
    if (payloadValue !== undefined) this.payloads.set(key, structuredClone(payloadValue));
  }

  async init(): Promise<StoreStatus> {
    return this.status();
  }

  status(): StoreStatus {
    return this.fallbackReason
      ? { state: 'unavailable', code: this.fallbackReason.code, message: this.fallbackReason.message }
      : { state: 'ready' };
  }

  async list(): Promise<SaveSlotMeta[]> {
    const entries: MetaEntry[] = [];
    for (const [key, value] of this.metas) entries.push({ key, value: structuredClone(value) });
    return buildListing(entries, [...this.payloads.keys()]);
  }

  async read(id: SaveSlotId): Promise<SaveRecord> {
    if (!this.payloads.has(id)) throw new StoreError('not-found', `No save in slot ${id}.`);
    return asSaveRecord(id, structuredClone(this.payloads.get(id)));
  }

  async write(id: SaveSlotId, payload: unknown, meta: SaveSlotMeta, options?: StoreWriteOptions): Promise<void> {
    const previousMeta = this.metas.get(id);
    const revision = planWrite(previousMeta, this.payloads.has(id), options);
    const rotateTo = planRotation(id, previousMeta, this.payloads.has(id), options);
    let record: SaveRecord;
    let storedMeta: SaveSlotMeta;
    try {
      record = structuredClone({ id, payload, revision });
      storedMeta = structuredClone({ ...meta, id, revision });
    } catch (error) {
      throw cloneFailure(error);
    }
    // Every set after every clone succeeded: all or nothing, like the transaction. The rotated record
    // is the stored value itself (already this store's own clone), re-keyed.
    if (rotateTo !== null) {
      const rotated = rotatedRecord(rotateTo, id, this.payloads.get(id), previousMeta, this.metas.get(rotateTo));
      this.payloads.set(rotateTo, rotated.record);
      this.metas.set(rotateTo, rotated.meta);
    }
    this.payloads.set(id, record);
    this.metas.set(id, storedMeta);
  }

  async updateMeta(id: SaveSlotId, patch: Partial<Pick<SaveSlotMeta, 'name' | 'status'>>): Promise<SaveSlotMeta> {
    const parsed = parseSlotMeta(this.metas.get(id));
    if (!this.metas.has(id)) throw new StoreError('not-found', `No save in slot ${id}.`);
    if (!parsed) throw new StoreError('corrupt', `The list entry of slot ${id} is damaged; delete the slot.`);
    const next: SaveSlotMeta = {
      ...parsed,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.status !== undefined ? { status: patch.status } : {}),
    };
    this.metas.set(id, structuredClone(next));
    return next;
  }

  async move(from: SaveSlotId, to: SaveSlotId): Promise<void> {
    if (!this.metas.has(from) && !this.payloads.has(from)) throw new StoreError('not-found', `No save in slot ${from}.`);
    if (this.metas.has(to) || this.payloads.has(to)) throw new StoreError('conflict', `Slot ${to} is not free.`);
    const stored = this.payloads.get(from);
    const record = asSaveRecord(from, stored);
    if (this.payloads.has(from)) this.payloads.set(to, { ...record, id: to });
    this.metas.set(to, metaForMove(this.metas.get(from), to));
    this.metas.delete(from);
    this.payloads.delete(from);
  }

  async remove(id: SaveSlotId): Promise<void> {
    this.metas.delete(id);
    this.payloads.delete(id);
  }

  close(): void {
    // Nothing to release; the data deliberately stays so the store remains usable.
  }
}
