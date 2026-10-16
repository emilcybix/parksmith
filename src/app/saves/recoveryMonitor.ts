import { isGameMode } from '../../game/modes/types';
import type { SaveSlotMeta } from './types';
import { AUTOSAVE_PREVIOUS_SLOT_ID } from './constants';
import { isReadableSlot } from './autosaveGenerations';
import {
  RECOVERY_HEARTBEAT_INTERVAL_MS,
  RECOVERY_LOCK_PREFIX,
  RECOVERY_MARKER_MAX_AGE_MS,
  RECOVERY_MARKER_PREFIX,
  RECOVERY_MARKER_VERSION,
  RECOVERY_STALE_HIDDEN_MS,
  RECOVERY_STALE_VISIBLE_MS,
  type InterruptedSession,
  type RecoveryDetection,
  type RecoveryMarker,
  type RecoveryMonitor,
  type RecoveryMonitorMode,
  type RecoveryParkInfo,
} from './recoveryTypes';

/**
 * Crash detection for a running park. The correctness argument is an ORDER:
 *   start:       Web Lock first, marker second;
 *   clean end:   marker removed first, lock released second.
 * So "marker present and lock free" can only mean the tab died without running its cleanup. A tab
 * that is merely backgrounded or frozen still holds its lock and is never mistaken for dead. Where
 * Web Locks do not exist the marker carries a heartbeat instead and goes stale (see the constants).
 *
 * All browser dependencies come in as options, so tests drive it with a fake storage, fake locks,
 * a fake clock and fake timers. Nothing here ever throws into the game: the safety net must not be
 * able to break the thing it protects.
 */

/** The slice of Storage the monitor uses. Enumeration is needed to find other tabs' markers. */
export interface RecoveryStorage {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The slice of navigator.locks the monitor uses. */
export interface RecoveryLockManager {
  request<T>(
    name: string,
    options: { mode?: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T> | T,
  ): Promise<T>;
}

export interface RecoveryTimers {
  setInterval(callback: () => void, delayMs: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RecoveryMonitorOptions {
  /** Defaults to a random UUID. The SaveManager is constructed with the same value as its tabId. */
  sessionId?: string;
  /** null = no usable localStorage (mode 'unavailable'). */
  storage: RecoveryStorage | null;
  /** null = no Web Locks (heartbeat fallback). */
  locks: RecoveryLockManager | null;
  now(): number;
  isHidden(): boolean;
  /** Subscribes to visibility changes; returns the unsubscribe. */
  onVisibilityChange?(listener: () => void): () => void;
  timers: RecoveryTimers;
}

const PROBE_KEY = 'parksmith-session-probe';

const newSessionId = (): string => (
  typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)
);

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** Everything in stored data is untrusted: a marker is accepted only when every field has its shape. */
export const parseRecoveryMarker = (raw: string | null): RecoveryMarker | null => {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== RECOVERY_MARKER_VERSION) return null;
  const { sessionId, startedAt, heartbeatAt, hidden, mode, parkName, scenarioId } = value;
  if (typeof sessionId !== 'string' || sessionId === '') return null;
  if (!isFiniteNumber(startedAt) || !isFiniteNumber(heartbeatAt) || typeof hidden !== 'boolean') return null;
  if (mode !== 'web-locks' && mode !== 'heartbeat') return null;
  if (typeof parkName !== 'string') return null;
  if (scenarioId !== null && typeof scenarioId !== 'string') return null;
  return {
    version: RECOVERY_MARKER_VERSION,
    sessionId,
    startedAt,
    heartbeatAt,
    hidden,
    mode,
    parkName,
    scenarioId: scenarioId as RecoveryMarker['scenarioId'],
    // Optional Phase 22 field: a bad value is ignored, never a reason to discard the marker.
    ...(isGameMode(value.gameMode) ? { gameMode: value.gameMode } : {}),
  };
};

/**
 * The offer rules (DESIGN 6.4) as a pure function. The autosave is offered only when ITS writer is
 * one of the interrupted sessions: with tab A crashed and tab B alive and autosaving, the autosave
 * is B's park and calling it "your interrupted park" would be a lie.
 */
export const decideRecovery = (
  interrupted: readonly InterruptedSession[],
  current: SaveSlotMeta | null,
  previous: SaveSlotMeta | null = null,
): RecoveryDetection => {
  if (interrupted.length === 0) return { kind: 'clean' };
  const list = [...interrupted];
  // Phase 31: when the current autosave is unreadable or gone (quarantined), the previous generation is
  // offered instead, but only when the interrupted tab wrote it too; otherwise the reasons stay the current one's.
  const fallback = previous !== null && isReadableSlot(previous) && (current === null || current.status.state !== 'ok')
    && list.some((session) => session.marker.sessionId === previous.writerTabId);
  const autosave = fallback ? previous : current;
  if (autosave === null) return { kind: 'no-offer', reason: 'autosave-missing', interrupted: list };
  if (autosave.status.state !== 'ok') return { kind: 'no-offer', reason: 'autosave-unreadable', interrupted: list };
  const owner = list.find((session) => session.marker.sessionId === autosave.writerTabId);
  if (owner === undefined) return { kind: 'no-offer', reason: 'autosave-not-from-interrupted-session', interrupted: list };
  const { marker } = owner;
  // The autosave is the park that is offered, so its own mode wins; a record without one falls back to the marker's.
  const offerMode = isGameMode(autosave.mode) ? autosave.mode : marker.gameMode;
  return {
    kind: 'offer',
    offer: {
      interruptedSessionIds: list.map((session) => session.marker.sessionId),
      sessionId: marker.sessionId,
      // The park the autosave actually holds: the marker names the tab's LATEST park, which can be
      // a newer one whose first autosave has not been written yet when the tab dies.
      parkName: autosave.scenarioName === '' ? marker.parkName : autosave.scenarioName,
      scenarioId: marker.scenarioId,
      ...(offerMode !== undefined ? { mode: offerMode } : {}),
      startedAt: marker.startedAt,
      lastSeenAt: Math.max(marker.startedAt, marker.heartbeatAt),
      autosave: {
        name: autosave.name,
        scenarioName: autosave.scenarioName,
        savedAt: autosave.savedAt,
        playtimeSeconds: autosave.playtimeSeconds,
        guestCount: autosave.guestCount,
        cash: autosave.cash,
        rating: autosave.rating,
        revision: autosave.revision,
        ...(fallback ? { slotId: AUTOSAVE_PREVIOUS_SLOT_ID } : {}),
        ...(autosave.run !== undefined ? { run: autosave.run } : {}),
      },
      evidence: owner.evidence,
    },
  };
};

const probeStorage = (storage: RecoveryStorage | null): boolean => {
  if (storage === null) return false;
  try {
    storage.setItem(PROBE_KEY, '1');
    storage.removeItem(PROBE_KEY);
    return true;
  } catch {
    return false;
  }
};

class Monitor implements RecoveryMonitor {
  readonly sessionId: string;
  readonly mode: RecoveryMonitorMode;
  private readonly options: RecoveryMonitorOptions;
  private park: RecoveryParkInfo | null = null;
  private running = false;
  private starting: Promise<void> | null = null;
  private startingEpoch = 0;
  /** Bumped by markClean/dispose so a start that is still waiting for its lock can tell it was overtaken. */
  private epoch = 0;
  private startedAt = 0;
  private releaseLock: (() => void) | null = null;
  private heartbeatTimer: unknown = null;
  private unsubscribeVisibility: (() => void) | null = null;
  private disposed = false;

  constructor(options: RecoveryMonitorOptions) {
    this.options = options;
    this.sessionId = options.sessionId ?? newSessionId();
    this.mode = !probeStorage(options.storage) ? 'unavailable' : options.locks !== null ? 'web-locks' : 'heartbeat';
  }

  start(park: RecoveryParkInfo): Promise<void> {
    this.park = park;
    if (this.disposed || this.mode === 'unavailable') return Promise.resolve();
    if (this.running) {
      this.writeMarker();
      return Promise.resolve();
    }
    // A start already waiting for its lock writes the latest park info when it gets there.
    // One overtaken by markClean (a pagehide followed by a bfcache restore) is not reused.
    if (this.starting !== null && this.startingEpoch === this.epoch) return this.starting;
    const epoch = this.epoch;
    const attempt = this.begin(epoch).finally(() => {
      if (this.starting === attempt) this.starting = null;
    });
    this.starting = attempt;
    this.startingEpoch = epoch;
    return attempt;
  }

  heartbeat(): void {
    if (this.running) this.writeMarker();
  }

  markClean(): void {
    this.epoch += 1;
    this.stopTimers();
    const wasRunning = this.running;
    this.running = false;
    try {
      // Order matters: the marker goes first, so there is never a marker without a lock.
      if (wasRunning) this.options.storage?.removeItem(this.markerKey(this.sessionId));
    } catch {
      // Nothing to do: a marker that stays behind is judged by the lock, which is released next.
    }
    this.releaseHeldLock();
  }

  async detectInterrupted(autosave: SaveSlotMeta | null, previous: SaveSlotMeta | null = null): Promise<RecoveryDetection> {
    const storage = this.options.storage;
    if (this.mode === 'unavailable' || storage === null) return { kind: 'clean' };
    const interrupted: InterruptedSession[] = [];
    try {
      for (const key of this.markerKeys(storage)) {
        if (key === this.markerKey(this.sessionId)) continue;
        const marker = parseRecoveryMarker(this.readItem(storage, key));
        const now = this.options.now();
        if (marker === null || key !== this.markerKey(marker.sessionId)) {
          this.removeItem(storage, key);
          continue;
        }
        if (now - marker.heartbeatAt > RECOVERY_MARKER_MAX_AGE_MS) {
          // In web-locks mode the heartbeat is not refreshed while running, so an old marker may
          // belong to a healthy tab left open for weeks: only a free lock proves it is junk.
          if (marker.mode !== 'web-locks' || (await this.judge(marker, now)) !== null) this.removeItem(storage, key);
          continue;
        }
        const evidence = await this.judge(marker, now);
        if (evidence !== null) interrupted.push({ marker, evidence });
      }
    } catch {
      // A scan that fails halfway is no scan: whatever was proven dead so far still counts.
    }
    interrupted.sort((a, b) => a.marker.startedAt - b.marker.startedAt);
    return decideRecovery(interrupted, autosave, previous);
  }

  forget(sessionIds: readonly string[]): void {
    const storage = this.options.storage;
    if (storage === null || this.mode === 'unavailable') return;
    for (const id of sessionIds) {
      if (id === this.sessionId) continue;
      this.removeItem(storage, this.markerKey(id));
    }
  }

  dispose(): void {
    this.markClean();
    this.disposed = true;
  }

  // --- internals ---

  private async begin(epoch: number): Promise<void> {
    const release = await this.acquireLock();
    if (release === null) return;
    if (epoch !== this.epoch || this.disposed) {
      // The page closed (or the monitor was disposed) while waiting: nothing may be written.
      release();
      return;
    }
    this.releaseLock = release;
    this.running = true;
    this.startedAt = this.options.now();
    // The lock is held, so the marker may exist now.
    this.writeMarker();
    this.startTimers();
  }

  private acquireLock(): Promise<(() => void) | null> {
    const locks = this.options.locks;
    if (this.mode === 'heartbeat' || locks === null) return Promise.resolve(() => undefined);
    return new Promise((resolve) => {
      try {
        // The callback's promise stays pending until released; that is what holds the lock.
        locks
          .request(RECOVERY_LOCK_PREFIX + this.sessionId, { mode: 'exclusive' }, () => new Promise<void>((release) => {
            resolve(() => release());
          }))
          .catch(() => resolve(null));
      } catch {
        resolve(null);
      }
    });
  }

  private releaseHeldLock(): void {
    const release = this.releaseLock;
    this.releaseLock = null;
    try {
      release?.();
    } catch {
      // Releasing is best effort; the browser drops the lock with the page anyway.
    }
  }

  private startTimers(): void {
    this.stopTimers();
    if (this.mode === 'heartbeat') {
      this.heartbeatTimer = this.options.timers.setInterval(() => this.heartbeat(), RECOVERY_HEARTBEAT_INTERVAL_MS);
    }
    // Both modes record visibility: the heartbeat fallback needs it to pick the stale threshold.
    this.unsubscribeVisibility = this.options.onVisibilityChange?.(() => this.heartbeat()) ?? null;
  }

  private stopTimers(): void {
    if (this.heartbeatTimer !== null) this.options.timers.clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
    this.unsubscribeVisibility?.();
    this.unsubscribeVisibility = null;
  }

  private writeMarker(): void {
    const storage = this.options.storage;
    if (storage === null || this.park === null || this.mode === 'unavailable') return;
    const marker: RecoveryMarker = {
      version: RECOVERY_MARKER_VERSION,
      sessionId: this.sessionId,
      startedAt: this.startedAt,
      heartbeatAt: this.options.now(),
      hidden: this.options.isHidden(),
      mode: this.mode,
      parkName: this.park.parkName,
      scenarioId: this.park.scenarioId,
      ...(this.park.mode !== undefined ? { gameMode: this.park.mode } : {}),
    };
    try {
      storage.setItem(this.markerKey(this.sessionId), JSON.stringify(marker));
    } catch {
      // Quota or a blocked profile: no marker means no recovery offer, never a broken game.
    }
  }

  /** Dead (with the evidence) or alive (null). Doubt always means alive: a false offer is worse than a missed one. */
  private async judge(marker: RecoveryMarker, now: number): Promise<InterruptedSession['evidence'] | null> {
    if (marker.mode === 'heartbeat') {
      const limit = marker.hidden ? RECOVERY_STALE_HIDDEN_MS : RECOVERY_STALE_VISIBLE_MS;
      return now - marker.heartbeatAt > limit ? 'heartbeat-stale' : null;
    }
    const locks = this.options.locks;
    if (locks === null) return null;
    try {
      const free = await locks.request(RECOVERY_LOCK_PREFIX + marker.sessionId, { ifAvailable: true }, (lock) => lock !== null);
      return free ? 'lock-free' : null;
    } catch {
      return null;
    }
  }

  private markerKey(sessionId: string): string {
    return RECOVERY_MARKER_PREFIX + sessionId;
  }

  private markerKeys(storage: RecoveryStorage): string[] {
    const keys: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key !== null && key.startsWith(RECOVERY_MARKER_PREFIX)) keys.push(key);
    }
    return keys;
  }

  private readItem(storage: RecoveryStorage, key: string): string | null {
    try {
      return storage.getItem(key);
    } catch {
      return null;
    }
  }

  private removeItem(storage: RecoveryStorage, key: string): void {
    try {
      storage.removeItem(key);
    } catch {
      // See markClean.
    }
  }
}

export const createRecoveryMonitor = (options: RecoveryMonitorOptions): RecoveryMonitor => new Monitor(options);

// --- Browser wiring ---------------------------------------------------------------------------

export const RECOVERY_MONITOR_HOLDER_KEY = '__parksmithRecoveryMonitor';

/** localStorage, or null when even touching it throws (blocked cookies, some sandboxed frames). */
const browserStorage = (): RecoveryStorage | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

/** The monitor with the real browser behind it. */
export const createBrowserRecoveryMonitor = (sessionId?: string): RecoveryMonitor => createRecoveryMonitor({
  sessionId,
  storage: browserStorage(),
  locks: typeof navigator !== 'undefined' && navigator.locks ? navigator.locks : null,
  now: () => Date.now(),
  isHidden: () => typeof document !== 'undefined' && document.visibilityState === 'hidden',
  onVisibilityChange: (listener) => {
    if (typeof document === 'undefined') return () => undefined;
    document.addEventListener('visibilitychange', listener);
    return () => document.removeEventListener('visibilitychange', listener);
  },
  timers: {
    setInterval: (callback, delayMs) => setInterval(callback, delayMs),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
  },
});

/**
 * One monitor per page: a hot-reloaded app module re-evaluates and would otherwise create a second
 * session id (and a second lock) for the same tab, which a scan would then judge as two tabs.
 * `holder` is the window in the app and a plain object in tests.
 */
export const getOrCreateRecoveryMonitor = (
  holder: Record<string, unknown>,
  create: () => RecoveryMonitor = createBrowserRecoveryMonitor,
): RecoveryMonitor => {
  const existing = holder[RECOVERY_MONITOR_HOLDER_KEY];
  if (existing !== undefined) return existing as RecoveryMonitor;
  const monitor = create();
  holder[RECOVERY_MONITOR_HOLDER_KEY] = monitor;
  return monitor;
};
