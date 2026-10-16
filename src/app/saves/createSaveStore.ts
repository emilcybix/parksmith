import { MANUAL_SLOT_IDS, SAVE_NAME_MAX_LENGTH } from './constants';
import { IdbSaveStore, type IdbSaveStoreOptions } from './idbSaveStore';
import { MemorySaveStore } from './memorySaveStore';
import type { ManualSaveSlotId, SaveRecord, SaveSlotId, SaveSlotMeta, SaveStore, StoreStatus, StoreWriteOptions } from './types';
import { StoreError } from './types';

/**
 * Picks the backing store: IndexedDB when it opens, otherwise an in-memory store, and moves the
 * in-memory saves into IndexedDB when it comes back.
 *
 * The session never depends on persistence (the ProfileManager rule): when IndexedDB cannot open, the
 * game keeps running, manual saves still land in memory for this page's lifetime, and the status
 * says why so the manager can show the banner and a Retry. The manager holds ONE object, this one,
 * so switching backends needs no re-wiring.
 */

export type SaveStoreBackend = 'indexeddb' | 'memory-only';

export interface StoreRetryResult {
  status: StoreStatus;
  backend: SaveStoreBackend;
  /** Slots that went into IndexedDB under their own id. */
  migrated: SaveSlotId[];
  /** Slots whose own id was taken in IndexedDB: kept under a free manual slot, never overwritten. */
  relocated: Array<{ from: SaveSlotId; to: ManualSaveSlotId }>;
  /** Slots that could not be moved; they stay in memory and the next retry tries again. */
  unmigrated: SaveSlotId[];
}

/** The SaveStore the manager holds, with the two extras fallback needs. */
export interface ResilientSaveStore extends SaveStore {
  backend(): SaveStoreBackend;
  /** Re-attempts IndexedDB; on success moves the in-memory slots over. Concurrent calls share one run. */
  retry(): Promise<StoreRetryResult>;
}

export type CreateSaveStoreOptions = IdbSaveStoreOptions;

const emptyRetry = (status: StoreStatus, backend: SaveStoreBackend, unmigrated: SaveSlotId[] = []): StoreRetryResult => (
  { status, backend, migrated: [], relocated: [], unmigrated }
);

class FallbackSaveStore implements ResilientSaveStore {
  private readonly indexedDb: IdbSaveStore;
  private readonly memory = new MemorySaveStore();
  private active: SaveStore;
  private retrying: Promise<StoreRetryResult> | null = null;

  constructor(options: CreateSaveStoreOptions) {
    this.indexedDb = new IdbSaveStore(options);
    this.active = this.indexedDb;
  }

  backend(): SaveStoreBackend {
    return this.active === this.indexedDb ? 'indexeddb' : 'memory-only';
  }

  async init(): Promise<StoreStatus> {
    const status = await this.indexedDb.init();
    if (status.state === 'ready') {
      this.active = this.indexedDb;
    } else if (status.state === 'unavailable') {
      this.memory.setFallbackReason({ code: status.code, message: status.message });
      this.active = this.memory;
    }
    return this.active.status();
  }

  status(): StoreStatus {
    return this.active.status();
  }

  list(): Promise<SaveSlotMeta[]> {
    return this.active.list();
  }

  read(id: SaveSlotId): Promise<SaveRecord> {
    return this.active.read(id);
  }

  write(id: SaveSlotId, payload: unknown, meta: SaveSlotMeta, options?: StoreWriteOptions): Promise<void> {
    return this.active.write(id, payload, meta, options);
  }

  updateMeta(id: SaveSlotId, patch: Partial<Pick<SaveSlotMeta, 'name' | 'status'>>): Promise<SaveSlotMeta> {
    return this.active.updateMeta(id, patch);
  }

  move(from: SaveSlotId, to: SaveSlotId): Promise<void> {
    return this.active.move(from, to);
  }

  remove(id: SaveSlotId): Promise<void> {
    return this.active.remove(id);
  }

  close(): void {
    this.indexedDb.close();
    this.memory.close();
  }

  retry(): Promise<StoreRetryResult> {
    this.retrying = this.retrying ?? this.runRetry().finally(() => { this.retrying = null; });
    return this.retrying;
  }

  private async runRetry(): Promise<StoreRetryResult> {
    const status = await this.indexedDb.init();
    // A remembered quota failure means the database opened fine; the migration writes decide whether
    // there is room now, and the first successful write clears the status.
    const opened = status.state === 'ready' || (status.state === 'unavailable' && status.code === 'quota');
    if (!opened) {
      if (status.state === 'unavailable') this.memory.setFallbackReason({ code: status.code, message: status.message });
      return this.active === this.indexedDb ? emptyRetry(status, 'indexeddb') : emptyRetry(this.memory.status(), 'memory-only', await this.memoryIds());
    }
    const result = emptyRetry(status, 'indexeddb');
    const stoppedBy = await this.migrateMemorySlots(result);
    if (stoppedBy) {
      // IndexedDB opened but cannot take writes (quota): stay on memory so nothing is lost.
      this.memory.setFallbackReason({ code: stoppedBy.code, message: stoppedBy.message });
      this.active = this.memory;
      result.status = this.memory.status();
      result.backend = 'memory-only';
      result.unmigrated = await this.memoryIds();
      return result;
    }
    this.memory.setFallbackReason(null);
    this.active = this.indexedDb;
    result.unmigrated = await this.memoryIds();
    return result;
  }

  private async memoryIds(): Promise<SaveSlotId[]> {
    return (await this.memory.list()).map((row) => row.id);
  }

  /**
   * Moves every in-memory slot into IndexedDB without overwriting anything: a slot whose id is
   * free goes there as is; one whose id is taken is kept under the first free manual slot as
   * "Unsaved: <name>". Returns the storage failure that stopped the run, if any.
   */
  private async migrateMemorySlots(result: StoreRetryResult): Promise<{ code: 'quota' | 'unavailable' | 'blocked'; message: string } | null> {
    const rows = await this.memory.list();
    if (rows.length === 0) return null;
    const taken = new Set<string>((await this.indexedDb.list()).map((row) => row.id));
    for (const row of rows) {
      try {
        const record = await this.memory.read(row.id);
        const placed = await this.place(row, record.payload, taken, result);
        if (placed) await this.memory.remove(row.id);
      } catch (error) {
        if (error instanceof StoreError && (error.code === 'quota' || error.code === 'unavailable' || error.code === 'blocked')) {
          return { code: error.code, message: error.message };
        }
        // Anything else (a record that cannot be cloned, an unknown failure): leave it in memory.
      }
    }
    return null;
  }

  private async place(row: SaveSlotMeta, payload: unknown, taken: Set<string>, result: StoreRetryResult): Promise<boolean> {
    if (!taken.has(row.id)) {
      try {
        await this.indexedDb.write(row.id, payload, row, { expectedRevision: null });
        taken.add(row.id);
        result.migrated.push(row.id);
        return true;
      } catch (error) {
        // Someone wrote the slot between listing and writing: fall through to relocation.
        if (!(error instanceof StoreError) || (error.code !== 'conflict' && error.code !== 'unreadable-slot')) throw error;
        taken.add(row.id);
      }
    }
    const free = MANUAL_SLOT_IDS.find((id) => !taken.has(id));
    if (!free) {
      result.unmigrated.push(row.id);
      return false;
    }
    const name = `Unsaved: ${row.name}`.slice(0, SAVE_NAME_MAX_LENGTH);
    await this.indexedDb.write(free, payload, { ...row, id: free, kind: 'manual', name }, { expectedRevision: null });
    taken.add(free);
    result.relocated.push({ from: row.id, to: free });
    return true;
  }
}

/**
 * The store the app uses: IndexedDB, falling back to memory once init() finds it unavailable.
 * Pass `factory` to inject a fake IndexedDB (tests) or null to simulate a browser without one.
 */
export const createSaveStore = (options: CreateSaveStoreOptions = {}): ResilientSaveStore => new FallbackSaveStore(options);
