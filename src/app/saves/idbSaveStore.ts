import { PAYLOADS_STORE_NAME, SAVE_DB_NAME, SAVE_DB_VERSION, SLOTS_STORE_NAME } from './constants';
import {
  asSaveRecord,
  buildListing,
  metaForMove,
  parseSlotMeta,
  planRotation,
  planWrite,
  rotatedRecord,
  type MetaEntry,
} from './memorySaveStore';
import type { SaveRecord, SaveSlotId, SaveSlotMeta, SaveStore, StoreStatus, StoreWriteOptions } from './types';
import { StoreError } from './types';

/**
 * The IndexedDB SaveStore. It uses only `indexedDB` (no `window`), so the same class runs on the
 * main thread and inside the save worker.
 *
 * Two object stores (`slots` for metadata, `payloads` for the saves) because list() must not
 * structured-clone a megabyte per slot just to draw a row. Every write is ONE readwrite
 * transaction over both stores and resolves on `oncomplete`, so a row never describes a payload
 * that failed to land and a quota abort leaves the previous save intact.
 *
 * Failure policy (the ProfileManager model): nothing here throws a raw DOMException or crashes; every
 * IndexedDB failure becomes a StoreError with a stable code, and after any failure the store stays
 * usable, because the next call reopens the connection from scratch.
 */

/**
 * How long a call waits for the database to open before reporting it unavailable. Some browsers
 * (private-mode quirks, a stuck upgrade in another tab) never answer. Not in constants.ts, which
 * this module does not own; overridable per instance for tests.
 */
const DEFAULT_OPEN_TIMEOUT_MS = 10_000;

export interface IdbSaveStoreOptions {
  /** undefined = the global `indexedDB`; null = pretend there is none. */
  factory?: IDBFactory | null;
  databaseName?: string;
  version?: number;
  openTimeoutMs?: number;
}

// --- Error mapping ------------------------------------------------------------------------------

const errorName = (error: unknown): string => (
  typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : ''
);

const errorMessage = (error: unknown): string => (
  typeof error === 'object' && error !== null && 'message' in error ? String((error as { message: unknown }).message) : ''
);

/** Firefox reports quota as NS_ERROR_DOM_QUOTA_REACHED and legacy engines as code 22. */
const isQuotaError = (error: unknown): boolean => (
  errorName(error) === 'QuotaExceededError'
  || errorName(error) === 'NS_ERROR_DOM_QUOTA_REACHED'
  || (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 22)
);

/** Maps anything thrown or reported by a request or transaction to a StoreError. */
export const mapIdbError = (error: unknown, fallbackMessage: string): StoreError => {
  if (error instanceof StoreError) return error;
  const name = errorName(error);
  const detail = errorMessage(error);
  if (isQuotaError(error)) {
    return new StoreError('quota', 'The browser has no storage space left for saves.', { cause: error });
  }
  switch (name) {
    case 'VersionError':
      return new StoreError('unavailable', 'These saves were written by a newer version of the game.', { cause: error });
    case 'SecurityError':
    case 'InvalidStateError':
    case 'VersionChangeError':
    case 'NotAllowedError':
      return new StoreError('unavailable', detail || 'Browser storage is not available here (private mode or blocked by settings).', { cause: error });
    case 'NotFoundError':
      return new StoreError('corrupt', 'The save database is missing a table; it may have been damaged.', { cause: error });
    case 'DataCloneError':
    case 'DataError':
      return new StoreError('corrupt', 'The save contains data that cannot be stored.', { cause: error });
    case 'AbortError':
      return new StoreError('unknown', 'The browser cancelled the save operation.', { cause: error });
    default:
      return new StoreError('unknown', detail || fallbackMessage, { cause: error });
  }
};

// --- Transaction plumbing -----------------------------------------------------------------------

interface TransactionContext<T> {
  readonly stores: Readonly<Record<string, IDBObjectStore>>;
  /** Runs `onSuccess` with the request's result; request errors are remembered for abort mapping. */
  request<R>(request: IDBRequest<R>, onSuccess: (result: R) => void): void;
  /** The transaction resolves with this value once it completes. */
  resolveWith(value: T): void;
  /** Aborts the transaction and rejects with this error (rolls back every write). */
  fail(error: StoreError): void;
}

interface OpenWaiter {
  resolve(database: IDBDatabase): void;
  reject(error: StoreError): void;
  timer: ReturnType<typeof setTimeout>;
}

/** One `indexedDB.open` call, which may outlive the callers waiting for it (blocked, slow). */
interface OpenAttempt {
  generation: number;
  waiters: Set<OpenWaiter>;
  database: IDBDatabase | null;
  failure: StoreError | null;
  blocked: boolean;
}

const STORE_NAMES = [SLOTS_STORE_NAME, PAYLOADS_STORE_NAME] as const;

export class IdbSaveStore implements SaveStore {
  readonly backend = 'indexeddb' as const;

  private readonly factoryOption: IDBFactory | null | undefined;
  private readonly databaseName: string;
  private readonly version: number;
  private readonly openTimeoutMs: number;

  private database: IDBDatabase | null = null;
  private attempt: OpenAttempt | null = null;
  /** Bumped by close(): an open that finishes after close() must not become the connection. */
  private generation = 0;
  private currentStatus: StoreStatus = { state: 'closed' };

  constructor(options: IdbSaveStoreOptions = {}) {
    this.factoryOption = options.factory;
    this.databaseName = options.databaseName ?? SAVE_DB_NAME;
    this.version = options.version ?? SAVE_DB_VERSION;
    this.openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  }

  // --- Opening ----------------------------------------------------------------------------------

  async init(): Promise<StoreStatus> {
    try {
      await this.ensureOpen();
    } catch {
      // ensureOpen already recorded the failure in the status; init reports it instead of rejecting.
    }
    return this.currentStatus;
  }

  status(): StoreStatus {
    return this.currentStatus;
  }

  close(): void {
    this.generation += 1;
    const pending = this.attempt;
    this.attempt = null;
    if (pending) {
      this.settleWaiters(pending, (waiter) => waiter.reject(new StoreError('unavailable', 'The save store was closed.')));
    }
    this.releaseConnection();
    this.currentStatus = { state: 'closed' };
  }

  private releaseConnection(): void {
    const database = this.database;
    this.database = null;
    if (database) {
      try {
        database.close();
      } catch {
        // Already closed.
      }
    }
  }

  private factory(): IDBFactory | null {
    if (this.factoryOption !== undefined) return this.factoryOption;
    try {
      return typeof indexedDB === 'undefined' ? null : indexedDB;
    } catch {
      // Touching `indexedDB` throws SecurityError in sandboxed frames and with storage blocked.
      return null;
    }
  }

  private recordOpenFailure(error: StoreError): void {
    if (error.code === 'blocked') {
      this.currentStatus = { state: 'unavailable', code: 'blocked', message: error.message };
    } else if (error.code === 'quota') {
      this.currentStatus = { state: 'unavailable', code: 'quota', message: error.message };
    } else {
      this.currentStatus = { state: 'unavailable', code: 'unavailable', message: error.message };
    }
  }

  private async ensureOpen(): Promise<IDBDatabase> {
    if (this.database) return this.database;
    try {
      const attempt = this.attempt ?? this.startAttempt();
      return await this.waitFor(attempt);
    } catch (error) {
      const storeError = error instanceof StoreError ? error : mapIdbError(error, 'Could not open the save database.');
      this.recordOpenFailure(storeError);
      throw storeError;
    }
  }

  private startAttempt(): OpenAttempt {
    const attempt: OpenAttempt = { generation: this.generation, waiters: new Set(), database: null, failure: null, blocked: false };
    const factory = this.factory();
    if (!factory) {
      attempt.failure = new StoreError('unavailable', 'Browser storage (IndexedDB) is not available, so saves cannot be kept.');
      return attempt;
    }
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(this.databaseName, this.version);
    } catch (error) {
      attempt.failure = mapIdbError(error, 'Could not open the save database.');
      return attempt;
    }
    this.attempt = attempt;
    request.onupgradeneeded = (event) => {
      try {
        this.upgrade(request.result, event.oldVersion);
      } catch (error) {
        // Without both stores the database is unusable; aborting fails the open with AbortError.
        try {
          request.transaction?.abort();
        } catch {
          // Already finished.
        }
        attempt.failure = mapIdbError(error, 'Could not create the save database.');
      }
    };
    request.onsuccess = () => {
      const database = request.result;
      if (this.attempt === attempt) this.attempt = null;
      if (attempt.generation !== this.generation) {
        // close() ran while this open was pending (blocked or slow): do not resurrect the connection.
        database.close();
        return;
      }
      database.onversionchange = () => {
        // A newer tab wants to upgrade: close at once or it stays blocked. The next call reopens.
        this.dropConnection(database, { state: 'closed' });
      };
      database.onclose = () => {
        this.dropConnection(database, { state: 'closed' });
      };
      attempt.database = database;
      this.database = database;
      this.currentStatus = { state: 'ready' };
      this.settleWaiters(attempt, (waiter) => waiter.resolve(database));
    };
    request.onerror = (event) => {
      event.preventDefault();
      if (this.attempt === attempt) this.attempt = null;
      attempt.failure = attempt.failure ?? mapIdbError(request.error, 'Could not open the save database.');
      this.settleWaiters(attempt, (waiter) => waiter.reject(attempt.failure as StoreError));
    };
    request.onblocked = () => {
      attempt.blocked = true;
      // The request stays alive: if the other tab lets go, success arrives and is adopted above.
      this.settleWaiters(attempt, (waiter) => waiter.reject(this.blockedError()));
    };
    return attempt;
  }

  private blockedError(): StoreError {
    return new StoreError('blocked', 'Another tab with an older version of the game is keeping the saves locked. Close it and retry.');
  }

  private settleWaiters(attempt: OpenAttempt, settle: (waiter: OpenWaiter) => void): void {
    const waiters = [...attempt.waiters];
    attempt.waiters.clear();
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      settle(waiter);
    }
  }

  private waitFor(attempt: OpenAttempt): Promise<IDBDatabase> {
    if (attempt.database) return Promise.resolve(attempt.database);
    if (attempt.failure) {
      if (this.attempt === attempt) this.attempt = null;
      return Promise.reject(attempt.failure);
    }
    if (attempt.blocked) return Promise.reject(this.blockedError());
    return new Promise<IDBDatabase>((resolve, reject) => {
      const waiter: OpenWaiter = {
        resolve,
        reject,
        timer: setTimeout(() => {
          attempt.waiters.delete(waiter);
          reject(new StoreError('unavailable', 'The save database did not open in time.'));
        }, this.openTimeoutMs),
      };
      attempt.waiters.add(waiter);
    });
  }

  private upgrade(database: IDBDatabase, oldVersion: number): void {
    // One case per released version, falling through; never edit an earlier case.
    // Step 3 adds `case 1:` (a 'session' store for crash recovery) at SAVE_DB_VERSION 2.
    switch (oldVersion) {
      case 0:
        database.createObjectStore(SLOTS_STORE_NAME, { keyPath: 'id' });
        database.createObjectStore(PAYLOADS_STORE_NAME, { keyPath: 'id' });
    }
  }

  private dropConnection(database: IDBDatabase, status: StoreStatus): void {
    if (this.database === database) {
      this.database = null;
      this.currentStatus = status;
    }
    try {
      database.close();
    } catch {
      // Already closed.
    }
  }

  // --- Transactions -----------------------------------------------------------------------------

  private async transact<T>(
    mode: IDBTransactionMode,
    storeNames: readonly string[],
    body: (context: TransactionContext<T>) => void,
    allowReopen = true,
  ): Promise<T> {
    const database = await this.ensureOpen();
    let transaction: IDBTransaction;
    try {
      transaction = database.transaction([...storeNames], mode);
    } catch (error) {
      if (allowReopen && errorName(error) === 'InvalidStateError') {
        // The browser closed the connection under us (storage cleared, profile closing): reopen once.
        this.dropConnection(database, { state: 'closed' });
        return this.transact(mode, storeNames, body, false);
      }
      throw this.noted(mapIdbError(error, 'Could not start a storage transaction.'));
    }
    const outcome = await new Promise<{ ok: true; value: T } | { ok: false; error: StoreError }>((resolve) => {
      let value: T | undefined;
      let failure: StoreError | null = null;
      let lastRequestError: unknown = null;
      const abortWith = (error: StoreError): void => {
        failure = failure ?? error;
        try {
          transaction.abort();
        } catch {
          // Already finished or aborting.
        }
      };
      transaction.oncomplete = () => resolve({ ok: true, value: value as T });
      transaction.onabort = () => {
        resolve({ ok: false, error: failure ?? mapIdbError(transaction.error ?? lastRequestError, 'The browser aborted the storage transaction.') });
      };
      const stores: Record<string, IDBObjectStore> = {};
      try {
        for (const name of storeNames) stores[name] = transaction.objectStore(name);
        body({
          stores,
          request: (request, onSuccess) => {
            request.onsuccess = () => {
              try {
                onSuccess(request.result);
              } catch (error) {
                abortWith(mapIdbError(error, 'Storage request failed.'));
              }
            };
            request.onerror = () => {
              lastRequestError = request.error;
            };
          },
          resolveWith: (result) => {
            value = result;
          },
          fail: abortWith,
        });
      } catch (error) {
        // put() throws DataCloneError synchronously for a payload that cannot be cloned.
        abortWith(mapIdbError(error, 'Could not start the storage request.'));
      }
    });
    if (!outcome.ok) throw this.noted(outcome.error);
    if (mode === 'readwrite' && this.currentStatus.state === 'unavailable' && this.currentStatus.code === 'quota') {
      this.currentStatus = { state: 'ready' };
    }
    return outcome.value;
  }

  /** Records what a failed operation means for the status, then hands the error back to throw. */
  private noted(error: StoreError): StoreError {
    if (error.code === 'quota') {
      this.currentStatus = { state: 'unavailable', code: 'quota', message: error.message };
    }
    return error;
  }

  // --- SaveStore --------------------------------------------------------------------------------

  async list(): Promise<SaveSlotMeta[]> {
    return this.transact<SaveSlotMeta[]>('readonly', STORE_NAMES, ({ stores, request, resolveWith }) => {
      const slots = stores[SLOTS_STORE_NAME];
      const payloads = stores[PAYLOADS_STORE_NAME];
      let metaKeys: IDBValidKey[] | null = null;
      let metaValues: unknown[] | null = null;
      let payloadKeys: IDBValidKey[] | null = null;
      const merge = (): void => {
        if (!metaKeys || !metaValues || !payloadKeys) return;
        const entries: MetaEntry[] = metaKeys.map((key, index) => ({ key, value: metaValues?.[index] }));
        resolveWith(buildListing(entries, payloadKeys));
      };
      // Metadata values plus the KEY list of the payload store: a payload is never deserialized here.
      request(slots.getAllKeys(), (keys) => { metaKeys = keys; merge(); });
      request(slots.getAll(), (values) => { metaValues = values; merge(); });
      request(payloads.getAllKeys(), (keys) => { payloadKeys = keys; merge(); });
    });
  }

  async read(id: SaveSlotId): Promise<SaveRecord> {
    return this.transact<SaveRecord>('readonly', [PAYLOADS_STORE_NAME], ({ stores, request, resolveWith, fail }) => {
      request(stores[PAYLOADS_STORE_NAME].get(id), (stored) => {
        if (stored === undefined) {
          fail(new StoreError('not-found', `No save in slot ${id}.`));
          return;
        }
        resolveWith(asSaveRecord(id, stored));
      });
    });
  }

  async write(id: SaveSlotId, payload: unknown, meta: SaveSlotMeta, options?: StoreWriteOptions): Promise<void> {
    return this.transact<void>('readwrite', STORE_NAMES, ({ stores, request, fail }) => {
      const slots = stores[SLOTS_STORE_NAME];
      const payloads = stores[PAYLOADS_STORE_NAME];
      const finish = (previousMeta: unknown, payloadExists: boolean, storedPayload: unknown, targetMeta: unknown): void => {
        let revision: number;
        let rotateTo: SaveSlotId | null;
        try {
          revision = planWrite(previousMeta, payloadExists, options);
          rotateTo = planRotation(id, previousMeta, payloadExists, options);
        } catch (error) {
          fail(mapIdbError(error, 'Storage request failed.'));
          return;
        }
        // Phase 31: the current record moves to the rotation target FIRST, in this same transaction, so
        // a put that fails below (quota, clone) aborts the move too and both slots stay as they were.
        if (rotateTo !== null) {
          const rotated = rotatedRecord(rotateTo, id, storedPayload, previousMeta, targetMeta);
          payloads.put(rotated.record);
          slots.put(rotated.meta);
        }
        // The store assigns the revision; whatever the caller put in meta.revision is replaced.
        const record: SaveRecord = { id, payload, revision };
        payloads.put(record);
        slots.put({ ...meta, id, revision });
      };
      const rotateTo = options?.rotateTo;
      request(slots.get(id), (previousMeta) => {
        if (rotateTo === undefined || rotateTo === id) {
          request(payloads.getKey(id), (payloadKey) => finish(previousMeta, payloadKey !== undefined, undefined, undefined));
          return;
        }
        // Rotating needs the payload VALUE (it is moved, not just checked) and the target's revision.
        request(payloads.get(id), (storedPayload) => {
          request(slots.get(rotateTo), (targetMeta) => finish(previousMeta, storedPayload !== undefined, storedPayload, targetMeta));
        });
      });
    });
  }

  async updateMeta(id: SaveSlotId, patch: Partial<Pick<SaveSlotMeta, 'name' | 'status'>>): Promise<SaveSlotMeta> {
    return this.transact<SaveSlotMeta>('readwrite', [SLOTS_STORE_NAME], ({ stores, request, resolveWith, fail }) => {
      const slots = stores[SLOTS_STORE_NAME];
      request(slots.get(id), (stored) => {
        if (stored === undefined) {
          fail(new StoreError('not-found', `No save in slot ${id}.`));
          return;
        }
        const parsed = parseSlotMeta(stored);
        if (!parsed) {
          fail(new StoreError('corrupt', `The list entry of slot ${id} is damaged; delete the slot.`));
          return;
        }
        // Only the two documented fields, and never the revision: a rename is not a write of the save.
        const next: SaveSlotMeta = {
          ...parsed,
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.status !== undefined ? { status: patch.status } : {}),
        };
        slots.put(next);
        resolveWith(next);
      });
    });
  }

  async move(from: SaveSlotId, to: SaveSlotId): Promise<void> {
    return this.transact<void>('readwrite', STORE_NAMES, ({ stores, request, fail }) => {
      const slots = stores[SLOTS_STORE_NAME];
      const payloads = stores[PAYLOADS_STORE_NAME];
      request(slots.get(from), (fromMeta) => {
        request(payloads.get(from), (fromPayload) => {
          if (fromMeta === undefined && fromPayload === undefined) {
            fail(new StoreError('not-found', `No save in slot ${from}.`));
            return;
          }
          request(slots.getKey(to), (toMetaKey) => {
            request(payloads.getKey(to), (toPayloadKey) => {
              if (toMetaKey !== undefined || toPayloadKey !== undefined) {
                fail(new StoreError('conflict', `Slot ${to} is not free.`));
                return;
              }
              if (fromPayload !== undefined) {
                payloads.put({ ...asSaveRecord(from, fromPayload), id: to });
              }
              slots.put(metaForMove(fromMeta, to));
              slots.delete(from);
              payloads.delete(from);
            });
          });
        });
      });
    });
  }

  async remove(id: SaveSlotId): Promise<void> {
    return this.transact<void>('readwrite', STORE_NAMES, ({ stores }) => {
      // The only way an unreadable record ever disappears, and only because the player asked.
      stores[SLOTS_STORE_NAME].delete(id);
      stores[PAYLOADS_STORE_NAME].delete(id);
    });
  }
}
