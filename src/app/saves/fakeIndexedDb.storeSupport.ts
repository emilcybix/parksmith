import type { SaveSlotId, SaveSlotMeta } from './types';

/**
 * A hand-written minimal IDBFactory for the store tests (no dependency allowed, and a fake that
 * shares its semantics with the store's real needs is more honest than a mock of the store).
 *
 * What is modelled, because the store relies on it:
 * - request and transaction events fire asynchronously, one request per task, in FIFO order;
 * - a transaction commits (`oncomplete`) when its queue drains, and an abort rolls every write back;
 * - values are structured-cloned on the way in and out (DataCloneError is thrown synchronously by put);
 * - an upgrade (`onupgradeneeded`) runs before `onsuccess`; an older connection gets `versionchange`
 *   and the open is `blocked` until it closes;
 * - transactions on one database run one at a time (a superset of the real isolation rules).
 * What is not: indexes, key ranges, cursors beyond a forward walk, durability options.
 *
 * Fault injection is the point of it: open errors, synchronous open throws, blocked upgrades,
 * transaction aborts, quota errors on put and on commit, silent connection loss.
 */

type Handler = ((event: FakeEvent) => void) | null;

export interface FakeEvent {
  type: string;
  target: unknown;
  oldVersion?: number;
  newVersion?: number | null;
  defaultPrevented: boolean;
  preventDefault(): void;
}

const makeEvent = (type: string, target: unknown, extra: Partial<FakeEvent> = {}): FakeEvent => {
  const event: FakeEvent = {
    type,
    target,
    defaultPrevented: false,
    preventDefault() { event.defaultPrevented = true; },
    ...extra,
  };
  return event;
};

const domError = (name: string, message = name): DOMException => new DOMException(message, name);

const compareKeys = (a: unknown, b: unknown): number => {
  if (typeof a === typeof b) return (a as string | number) < (b as string | number) ? -1 : (a as string | number) > (b as string | number) ? 1 : 0;
  return typeof a === 'number' ? -1 : 1;
};

/** Defers to a fresh task, the way the browser delivers IDB events. */
const nextTask = (run: () => void): void => {
  setTimeout(run, 0);
};

export type FakeFault =
  /** The next readwrite transaction aborts with this error after its n-th request (default 1). */
  | { kind: 'abort'; errorName?: string; afterRequests?: number }
  /**
   * put() reports a request error (quota) and the transaction aborts with the same error. `afterWrites`
   * lets that many writes of the transaction succeed first (default 0), so a test can fail the LAST put
   * of a multi-put transaction (the autosave rotation, Phase 31) after the earlier ones have landed.
   */
  | { kind: 'quota-on-put'; afterWrites?: number }
  /** All requests succeed, the commit fails: tx.onabort with QuotaExceededError and tx.error set. */
  | { kind: 'quota-on-commit' }
  /** put() throws synchronously with this error name (DataError, DataCloneError, ...). */
  | { kind: 'put-throws'; errorName: string }
  /** db.transaction() throws this error once (InvalidStateError: connection closing). */
  | { kind: 'transaction-throws'; errorName: string };

export type FakeOpenFault =
  /** open() throws synchronously (SecurityError in sandboxed frames). */
  | { kind: 'throw'; errorName: string }
  /** The open request fires `error` with this DOMException name (UnknownError, VersionError...). */
  | { kind: 'error'; errorName: string }
  /** The open request never answers (a hung browser). */
  | { kind: 'hang' };

interface StoreData {
  keyPath: string;
  records: Map<unknown, unknown>;
}

interface DatabaseData {
  version: number;
  stores: Map<string, StoreData>;
}

export interface FakeStoreStats {
  /** Calls that deserialize values (get, getAll, openCursor). The listing must not make these on payloads. */
  valueReads: number;
  keyReads: number;
  writes: number;
}

class FakeRequest<T> {
  result: T = undefined as T;
  error: DOMException | null = null;
  readyState: 'pending' | 'done' = 'pending';
  transaction: FakeTransaction | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
}

class FakeTransaction {
  oncomplete: Handler = null;
  onabort: Handler = null;
  onerror: Handler = null;
  error: DOMException | null = null;
  state: 'active' | 'finished' = 'active';

  private readonly queue: Array<() => void> = [];
  private snapshot: Map<string, Map<unknown, unknown>> | null = null;
  private started = false;
  private requestsRun = 0;
  private writesRun = 0;
  /** The injected fault of this transaction, if any (consumed by the fake as it fires). */
  fault: FakeFault | null = null;
  /** Called once when the transaction is over (committed or aborted). */
  onFinished: () => void = () => {};

  constructor(
    private readonly database: FakeDatabase,
    private readonly storeNames: string[],
    readonly mode: IDBTransactionMode,
    private readonly facade: FakeFactory,
  ) {}

  objectStore(name: string): FakeObjectStore {
    if (this.state === 'finished') throw domError('InvalidStateError', 'The transaction has finished.');
    if (!this.storeNames.includes(name)) throw domError('NotFoundError', `Store ${name} is not in this transaction.`);
    return new FakeObjectStore(name, this, this.facade);
  }

  abort(): void {
    if (this.state === 'finished') throw domError('InvalidStateError', 'The transaction has finished.');
    this.finish(false, null);
  }

  /** Enqueues one request operation; `run` computes the result and may throw a DOMException. */
  enqueue<T>(request: FakeRequest<T>, run: () => T, isWrite: boolean): FakeRequest<T> {
    if (this.state === 'finished') throw domError('TransactionInactiveError', 'The transaction has finished.');
    if (isWrite && this.mode === 'readonly') throw domError('ReadOnlyError', 'The transaction is read-only.');
    this.queue.push(() => {
      this.requestsRun += 1;
      if (isWrite) {
        this.takeSnapshot();
        this.writesRun += 1;
      }
      let failed: DOMException | null = null;
      try {
        if (isWrite && this.fault?.kind === 'quota-on-put' && this.writesRun > (this.fault.afterWrites ?? 0)) throw domError('QuotaExceededError');
        request.result = run();
      } catch (error) {
        failed = error instanceof DOMException ? error : domError('UnknownError', String(error));
      }
      request.readyState = 'done';
      if (failed) {
        request.error = failed;
        const event = makeEvent('error', request);
        request.onerror?.(event);
        // An unhandled request error bubbles to the transaction and aborts it, unless prevented.
        this.onerror?.(event);
        if (!event.defaultPrevented && this.state === 'active') this.finish(false, failed);
        return;
      }
      request.onsuccess?.(makeEvent('success', request));
      if (this.fault?.kind === 'abort' && this.requestsRun >= (this.fault.afterRequests ?? 1) && this.state === 'active') {
        this.finish(false, domError(this.fault.errorName ?? 'AbortError'));
      }
    });
    this.schedule();
    return request;
  }

  private takeSnapshot(): void {
    if (this.snapshot) return;
    this.snapshot = new Map();
    for (const name of this.storeNames) {
      const store = this.database.data.stores.get(name);
      if (store) this.snapshot.set(name, new Map(store.records));
    }
  }

  /** Called by the database when it is this transaction's turn. */
  start(): void {
    this.started = true;
    this.schedule();
  }

  private scheduled = false;
  private schedule(): void {
    if (!this.started || this.scheduled || this.state === 'finished') return;
    this.scheduled = true;
    nextTask(() => {
      this.scheduled = false;
      if (this.state === 'finished') return;
      const next = this.queue.shift();
      if (next) {
        next();
        this.schedule();
        return;
      }
      if (this.fault?.kind === 'quota-on-commit') {
        this.finish(false, domError('QuotaExceededError'));
        return;
      }
      this.finish(true, null);
    });
  }

  finish(commit: boolean, error: DOMException | null): void {
    if (this.state === 'finished') return;
    this.state = 'finished';
    if (!commit) {
      this.error = error;
      if (this.snapshot) {
        for (const [name, records] of this.snapshot) {
          const store = this.database.data.stores.get(name);
          if (store) store.records = records;
        }
      }
    }
    // Event handlers run before the next transaction may start.
    const event = makeEvent(commit ? 'complete' : 'abort', this);
    if (commit) this.oncomplete?.(event);
    else this.onabort?.(event);
    this.onFinished();
  }
}

class FakeObjectStore {
  readonly keyPath: string;

  constructor(
    readonly name: string,
    private readonly transaction: FakeTransaction,
    private readonly facade: FakeFactory,
  ) {
    this.keyPath = this.data().keyPath;
  }

  private data(): StoreData {
    const store = this.facade.databaseData(this.transaction).stores.get(this.name);
    if (!store) throw domError('NotFoundError', `No store ${this.name}`);
    return store;
  }

  private stats(): FakeStoreStats {
    return this.facade.statsFor(this.name);
  }

  get(key: unknown): FakeRequest<unknown> {
    this.stats().valueReads += 1;
    return this.transaction.enqueue(new FakeRequest<unknown>(), () => {
      const value = this.data().records.get(key);
      return value === undefined ? undefined : structuredClone(value);
    }, false);
  }

  getKey(key: unknown): FakeRequest<unknown> {
    this.stats().keyReads += 1;
    return this.transaction.enqueue(new FakeRequest<unknown>(), () => (this.data().records.has(key) ? key : undefined), false);
  }

  getAll(): FakeRequest<unknown[]> {
    this.stats().valueReads += 1;
    return this.transaction.enqueue(new FakeRequest<unknown[]>(), () => (
      [...this.data().records.entries()].sort((a, b) => compareKeys(a[0], b[0])).map(([, value]) => structuredClone(value))
    ), false);
  }

  getAllKeys(): FakeRequest<unknown[]> {
    this.stats().keyReads += 1;
    return this.transaction.enqueue(new FakeRequest<unknown[]>(), () => (
      [...this.data().records.keys()].sort(compareKeys)
    ), false);
  }

  count(): FakeRequest<number> {
    this.stats().keyReads += 1;
    return this.transaction.enqueue(new FakeRequest<number>(), () => this.data().records.size, false);
  }

  put(value: unknown): FakeRequest<unknown> {
    this.stats().writes += 1;
    const fault = this.transaction.fault;
    if (fault?.kind === 'put-throws') {
      this.transaction.fault = null;
      throw domError(fault.errorName);
    }
    const cloned = structuredClone(value);
    const keyPath = this.keyPath;
    const key = (cloned as Record<string, unknown> | null)?.[keyPath];
    if (key === undefined) throw domError('DataError', 'No key at the key path.');
    return this.transaction.enqueue(new FakeRequest<unknown>(), () => {
      this.data().records.set(key, cloned);
      return key;
    }, true);
  }

  delete(key: unknown): FakeRequest<undefined> {
    this.stats().writes += 1;
    return this.transaction.enqueue(new FakeRequest<undefined>(), () => {
      this.data().records.delete(key);
      return undefined;
    }, true);
  }

  /** Forward-only cursor over all records: enough for code that walks a store. */
  openCursor(): FakeRequest<{ key: unknown; value: unknown; continue(): void } | null> {
    this.stats().valueReads += 1;
    const request = new FakeRequest<{ key: unknown; value: unknown; continue(): void } | null>();
    const entries = [...this.data().records.entries()].sort((a, b) => compareKeys(a[0], b[0]));
    let index = 0;
    const present = (): { key: unknown; value: unknown; continue(): void } | null => {
      const entry = entries[index];
      if (!entry) return null;
      return {
        key: entry[0],
        value: structuredClone(entry[1]),
        continue: () => {
          index += 1;
          request.readyState = 'pending';
          this.transaction.enqueue(request, present, false);
        },
      };
    };
    return this.transaction.enqueue(request, present, false);
  }
}

class FakeDatabase {
  onversionchange: Handler = null;
  onclose: Handler = null;
  closed = false;
  readonly objectStoreNames = { contains: (name: string): boolean => this.data.stores.has(name) };

  private busy = false;
  private readonly pending: FakeTransaction[] = [];

  constructor(
    readonly name: string,
    readonly data: DatabaseData,
    private readonly facade: FakeFactory,
    readonly connectionVersion: number,
  ) {}

  get version(): number {
    return this.data.version;
  }

  createObjectStore(name: string, options: { keyPath: string }): FakeObjectStore {
    if (this.data.stores.has(name)) throw domError('ConstraintError', `Store ${name} exists.`);
    this.data.stores.set(name, { keyPath: options.keyPath, records: new Map() });
    return new FakeObjectStore(name, this.facade.upgradeTransaction(this), this.facade);
  }

  transaction(storeNames: string | string[], mode: IDBTransactionMode = 'readonly'): FakeTransaction {
    if (this.closed) throw domError('InvalidStateError', 'The database connection is closing.');
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    const fault = this.facade.takeFault(mode);
    if (fault?.kind === 'transaction-throws') throw domError(fault.errorName);
    for (const name of names) {
      if (!this.data.stores.has(name)) throw domError('NotFoundError', `No store ${name}`);
    }
    const transaction = new FakeTransaction(this, names, mode, this.facade);
    transaction.fault = fault;
    this.facade.registerTransaction(transaction, this);
    transaction.onFinished = () => {
      this.busy = false;
      this.runNext();
    };
    this.pending.push(transaction);
    this.runNext();
    return transaction;
  }

  private runNext(): void {
    if (this.busy) return;
    const next = this.pending.shift();
    if (!next) return;
    this.busy = true;
    next.start();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.facade.connectionClosed(this);
  }

  /** Test seam: the browser drops the connection without telling the page (no `close` event). */
  silentlyClose(): void {
    this.closed = true;
    this.facade.connectionClosed(this);
  }
}

export class FakeFactory {
  private readonly databases = new Map<string, DatabaseData>();
  private readonly connections = new Set<FakeDatabase>();
  private readonly storeStats = new Map<string, FakeStoreStats>();
  private readonly transactionDatabase = new WeakMap<FakeTransaction, FakeDatabase>();
  private readonly upgradeTransactions = new WeakMap<FakeDatabase, FakeTransaction>();
  private readonly closeWaiters: Array<() => void> = [];
  private readonly faultQueue: FakeFault[] = [];
  private openFault: FakeOpenFault | null = null;
  /** How many open() calls reached the factory. */
  openCalls = 0;

  // --- Test controls ---

  injectFault(fault: FakeFault): void {
    this.faultQueue.push(fault);
  }

  injectOpenFault(fault: FakeOpenFault): void {
    this.openFault = fault;
  }

  stats(storeName: string): FakeStoreStats {
    return this.statsFor(storeName);
  }

  resetStats(): void {
    this.storeStats.clear();
  }

  /** All connections currently open (a store that leaked one shows up here). */
  openConnectionCount(): number {
    return this.connections.size;
  }

  connection(index = 0): FakeDatabase | undefined {
    return [...this.connections][index];
  }

  /** Fires `versionchange` on every open connection, as another tab upgrading the database would. */
  fireVersionChange(newVersion: number): void {
    for (const connection of [...this.connections]) {
      connection.onversionchange?.(makeEvent('versionchange', connection, { newVersion, oldVersion: connection.version }));
    }
  }

  /** The browser closes a connection on its own and tells the page (`close` event). */
  abnormalClose(connection: FakeDatabase): void {
    connection.silentlyClose();
    connection.onclose?.(makeEvent('close', connection));
  }

  /** Reads the raw records of a store without any fault or stats (assertions about what is on disk). */
  peek(databaseName: string, storeName: string): Map<unknown, unknown> {
    return new Map(this.databases.get(databaseName)?.stores.get(storeName)?.records ?? []);
  }

  /** Plants a raw record (damaged data) directly on disk. */
  plant(databaseName: string, storeName: string, key: unknown, value: unknown): void {
    this.databases.get(databaseName)?.stores.get(storeName)?.records.set(key, structuredClone(value));
  }

  // --- Used by the fake classes ---

  statsFor(storeName: string): FakeStoreStats {
    let stats = this.storeStats.get(storeName);
    if (!stats) {
      stats = { valueReads: 0, keyReads: 0, writes: 0 };
      this.storeStats.set(storeName, stats);
    }
    return stats;
  }

  registerTransaction(transaction: FakeTransaction, database: FakeDatabase): void {
    this.transactionDatabase.set(transaction, database);
  }

  databaseData(transaction: FakeTransaction): DatabaseData {
    const database = this.transactionDatabase.get(transaction);
    if (!database) throw domError('InvalidStateError', 'Unknown transaction.');
    return database.data;
  }

  upgradeTransaction(database: FakeDatabase): FakeTransaction {
    const transaction = this.upgradeTransactions.get(database);
    if (!transaction) throw domError('InvalidStateError', 'Not in an upgrade.');
    return transaction;
  }

  /** Consumes the next injected fault for a readwrite transaction (or a transaction-throws for any). */
  takeFault(mode: IDBTransactionMode): FakeFault | null {
    const fault = this.faultQueue[0];
    if (!fault || (mode !== 'readwrite' && fault.kind !== 'transaction-throws')) return null;
    this.faultQueue.shift();
    return fault;
  }

  connectionClosed(connection: FakeDatabase): void {
    this.connections.delete(connection);
    const waiters = this.closeWaiters.splice(0);
    for (const waiter of waiters) waiter();
  }

  // --- IDBFactory ---

  open(name: string, version?: number): FakeRequest<FakeDatabase> {
    this.openCalls += 1;
    const fault = this.openFault;
    if (fault?.kind === 'throw') {
      this.openFault = null;
      throw domError(fault.errorName);
    }
    const request = new FakeRequest<FakeDatabase>();
    if (fault) this.openFault = null;
    if (fault?.kind === 'hang') return request;
    nextTask(() => {
      if (fault?.kind === 'error') {
        this.failOpen(request, fault.errorName);
        return;
      }
      this.runOpen(request, name, version);
    });
    return request;
  }

  private failOpen(request: FakeRequest<FakeDatabase>, errorName: string): void {
    request.readyState = 'done';
    request.error = domError(errorName);
    request.onerror?.(makeEvent('error', request));
  }

  private runOpen(request: FakeRequest<FakeDatabase>, name: string, requested: number | undefined): void {
    const existing = this.databases.get(name);
    const target = requested ?? existing?.version ?? 1;
    if (existing && target < existing.version) {
      this.failOpen(request, 'VersionError');
      return;
    }
    if (!existing || target > existing.version) {
      this.upgrade(request, name, existing, target);
      return;
    }
    this.deliver(request, name, existing, target);
  }

  private upgrade(request: FakeRequest<FakeDatabase>, name: string, existing: DatabaseData | undefined, target: number): void {
    const others = [...this.connections].filter((connection) => connection.name === name);
    for (const other of others) other.onversionchange?.(makeEvent('versionchange', other, { newVersion: target, oldVersion: other.version }));
    nextTask(() => {
      if ([...this.connections].some((connection) => connection.name === name)) {
        request.onblocked?.(makeEvent('blocked', request));
        // Waits for every older connection to close, then upgrades.
        this.closeWaiters.push(() => this.upgrade(request, name, existing, target));
        return;
      }
      const oldVersion = existing?.version ?? 0;
      const snapshot = existing ? new Map([...existing.stores].map(([storeName, data]) => [storeName, { ...data, records: new Map(data.records) }])) : new Map();
      const data: DatabaseData = existing ?? { version: 0, stores: new Map() };
      data.version = target;
      this.databases.set(name, data);
      const database = new FakeDatabase(name, data, this, target);
      const transaction = new FakeTransaction(database, [], 'readwrite', this);
      this.transactionDatabase.set(transaction, database);
      this.upgradeTransactions.set(database, transaction);
      request.result = database;
      request.transaction = transaction;
      let aborted = false;
      transaction.onabort = () => {
        aborted = true;
        // Roll the database back to what it was before the upgrade.
        if (existing) {
          existing.version = oldVersion;
          existing.stores = snapshot;
        } else {
          this.databases.delete(name);
        }
        this.failOpen(request, 'AbortError');
      };
      request.onupgradeneeded?.(makeEvent('upgradeneeded', request, { oldVersion, newVersion: target }));
      if (aborted) return;
      transaction.state = 'finished';
      this.connections.add(database);
      request.readyState = 'done';
      nextTask(() => request.onsuccess?.(makeEvent('success', request)));
    });
  }

  private deliver(request: FakeRequest<FakeDatabase>, name: string, data: DatabaseData, version: number): void {
    const database = new FakeDatabase(name, data, this, version);
    this.connections.add(database);
    request.result = database;
    request.readyState = 'done';
    request.onsuccess?.(makeEvent('success', request));
  }
}

export const createFakeIndexedDb = (): FakeFactory => new FakeFactory();

/** The store takes an IDBFactory; the fake is structurally close enough and cast once, here. */
export const asIdbFactory = (fake: FakeFactory): IDBFactory => fake as unknown as IDBFactory;

/** A complete, valid metadata record for tests; override what the case is about. */
export const makeSlotMeta = (id: SaveSlotId, overrides: Partial<SaveSlotMeta> = {}): SaveSlotMeta => ({
  id,
  kind: id === 'autosave' ? 'auto' : 'manual',
  name: id === 'autosave' ? 'Autosave' : `Park ${id}`,
  scenarioId: null,
  scenarioName: 'Sandbox park',
  playtimeSeconds: 120,
  savedAt: 1_700_000_000_000,
  schemaVersion: 1,
  contentVersion: 1,
  savedAtTick: 600,
  guestCount: 42,
  cash: 5_000,
  rating: 61,
  sizeBytes: 1_000,
  revision: 0,
  writerTabId: 'tab-a',
  status: { state: 'ok' },
  ...overrides,
});
