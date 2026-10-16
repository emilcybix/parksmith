import { describe, expect, it } from 'vitest';
import {
  createRecoveryMonitor,
  decideRecovery,
  getOrCreateRecoveryMonitor,
  parseRecoveryMarker,
  type RecoveryLockManager,
  type RecoveryMonitorOptions,
  type RecoveryStorage,
} from './recoveryMonitor';
import {
  RECOVERY_HEARTBEAT_INTERVAL_MS,
  RECOVERY_LOCK_PREFIX,
  RECOVERY_MARKER_MAX_AGE_MS,
  RECOVERY_MARKER_PREFIX,
  RECOVERY_STALE_HIDDEN_MS,
  RECOVERY_STALE_VISIBLE_MS,
  type InterruptedSession,
  type RecoveryMarker,
  type RecoveryParkInfo,
  type RecoveryMonitor,
} from './recoveryTypes';
import type { SaveSlotMeta } from './types';

/**
 * The monitor runs against a fake browser shared by all "tabs": one localStorage and one lock
 * table, so two monitors really can see each other's markers and locks. A crash drops a tab's
 * lock without running any cleanup, which is exactly what the real browser does.
 */

class FakeStorage implements RecoveryStorage {
  readonly items = new Map<string, string>();
  broken = false;
  constructor(readonly log: string[]) {}
  get length(): number { return this.items.size; }
  key(index: number): string | null { return [...this.items.keys()][index] ?? null; }
  getItem(key: string): string | null {
    if (this.broken) throw new Error('blocked');
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    if (this.broken) throw new Error('blocked');
    this.items.set(key, value);
    this.log.push(`set ${key}`);
  }
  removeItem(key: string): void {
    if (this.broken) throw new Error('blocked');
    if (this.items.delete(key)) this.log.push(`remove ${key}`);
  }
}

class FakeLocks implements RecoveryLockManager {
  readonly held = new Set<string>();
  /** Locks of crashed tabs: their callbacks never settle, like a process that is gone. */
  constructor(private readonly log: string[]) {}
  request<T>(
    name: string,
    options: { mode?: 'exclusive'; ifAvailable?: boolean },
    callback: (lock: unknown) => Promise<T> | T,
  ): Promise<T> {
    if (options.ifAvailable) return Promise.resolve(callback(this.held.has(name) ? null : { name }));
    return Promise.resolve().then(async () => {
      this.held.add(name);
      this.log.push(`grant ${name}`);
      try {
        return await callback({ name });
      } finally {
        if (this.held.delete(name)) this.log.push(`release ${name}`);
      }
    });
  }
  /** The tab died: the lock vanishes without any cleanup having run. */
  crash(name: string): void { this.held.delete(name); }
}

interface Timer { callback: () => void; delayMs: number; id: number }

/** Shared by every tab of a test: one storage, one lock table, one clock. */
class FakeBrowser {
  readonly log: string[] = [];
  readonly storage = new FakeStorage(this.log);
  readonly locks = new FakeLocks(this.log);
  time = 1_000_000;
  readonly hidden = new Set<string>();
  readonly timers = new Map<number, Timer>();
  private timerCounter = 0;

  tab(id: string, overrides: Partial<RecoveryMonitorOptions> = {}): RecoveryMonitor & { visibility(): void } {
    let listener: (() => void) | null = null;
    const monitor = createRecoveryMonitor({
      sessionId: id,
      storage: this.storage,
      locks: this.locks,
      now: () => this.time,
      isHidden: () => this.hidden.has(id),
      onVisibilityChange: (next) => { listener = next; return () => { listener = null; }; },
      timers: {
        setInterval: (callback, delayMs) => {
          this.timerCounter += 1;
          this.timers.set(this.timerCounter, { callback, delayMs, id: this.timerCounter });
          return this.timerCounter;
        },
        clearInterval: (handle) => { this.timers.delete(handle as number); },
      },
      ...overrides,
    });
    return Object.assign(monitor, { visibility: () => listener?.() });
  }

  /** Advances the clock and fires every interval timer once per elapsed period. */
  advance(ms: number): void {
    const end = this.time + ms;
    while (this.time < end) {
      const step = Math.min(RECOVERY_HEARTBEAT_INTERVAL_MS, end - this.time);
      this.time += step;
      if (step === RECOVERY_HEARTBEAT_INTERVAL_MS) for (const timer of [...this.timers.values()]) timer.callback();
    }
  }

  crash(id: string): void { this.locks.crash(RECOVERY_LOCK_PREFIX + id); }

  markerOf(id: string): RecoveryMarker | null { return parseRecoveryMarker(this.storage.items.get(RECOVERY_MARKER_PREFIX + id) ?? null); }
}

const PARK: RecoveryParkInfo = { parkName: 'Sunstone Valley', scenarioId: null };

const autosaveBy = (writerTabId: string, patch: Partial<SaveSlotMeta> = {}): SaveSlotMeta => ({
  id: 'autosave',
  kind: 'auto',
  name: 'Autosave',
  scenarioId: null,
  scenarioName: 'Sandbox park',
  playtimeSeconds: 600,
  savedAt: 999_000,
  schemaVersion: 1,
  contentVersion: 1,
  savedAtTick: 6000,
  guestCount: 42,
  cash: 18_300,
  rating: 61,
  sizeBytes: 1000,
  revision: 7,
  writerTabId,
  status: { state: 'ok' },
  ...patch,
});

const startTab = async (browser: FakeBrowser, id: string, park = PARK): Promise<RecoveryMonitor & { visibility(): void }> => {
  const tab = browser.tab(id);
  await tab.start(park);
  return tab;
};

describe('RecoveryMonitor: start and clean end', () => {
  it('takes the lock before it writes the marker', async () => {
    const browser = new FakeBrowser();
    const tab = browser.tab('a');
    browser.log.length = 0;
    const pending = tab.start(PARK);
    expect(browser.markerOf('a'), 'no marker while the lock is still being requested').toBeNull();
    await pending;
    expect(browser.markerOf('a')?.parkName, 'marker written once running').toBe('Sunstone Valley');
    expect(browser.locks.held.has(RECOVERY_LOCK_PREFIX + 'a'), 'lock held for the life of the park').toBe(true);
    expect(browser.log, 'grant first, marker second').toEqual([`grant ${RECOVERY_LOCK_PREFIX}a`, `set ${RECOVERY_MARKER_PREFIX}a`]);
  });

  it('markClean removes the marker first and releases the lock second', async () => {
    const browser = new FakeBrowser();
    const tab = await startTab(browser, 'a');
    browser.log.length = 0;
    tab.markClean();
    await Promise.resolve();
    await Promise.resolve();
    expect(browser.log, 'marker removal precedes lock release').toEqual([
      `remove ${RECOVERY_MARKER_PREFIX}a`,
      `release ${RECOVERY_LOCK_PREFIX}a`,
    ]);
    tab.markClean();
    expect(browser.log.length, 'idempotent').toBe(2);
  });

  it('an offer names the park the autosave holds, not the tab\'s newer park', async () => {
    const browser = new FakeBrowser();
    const tab = await startTab(browser, 'a');
    await tab.start({ parkName: 'Second park', scenarioId: null });
    browser.crash('a');
    const detection = await browser.tab('b').detectInterrupted(autosaveBy('a', { scenarioName: 'Sunstone Valley' }));
    expect(detection.kind === 'offer' && detection.offer.parkName).toBe('Sunstone Valley');
  });

  it('a live web-locks tab whose marker is older than the maximum age is kept, a dead one purged', async () => {
    const browser = new FakeBrowser();
    await startTab(browser, 'live');
    await startTab(browser, 'dead');
    browser.crash('dead');
    browser.time += RECOVERY_MARKER_MAX_AGE_MS + 1;
    const detection = await browser.tab('scanner').detectInterrupted(autosaveBy('dead'));
    expect(browser.markerOf('live'), 'a healthy old tab keeps its marker').not.toBeNull();
    expect(browser.markerOf('dead'), 'an old marker with a free lock is junk').toBeNull();
    expect(detection.kind, 'junk is never offered').toBe('clean');
  });

  it('the lock is released only after the marker is gone, in the same synchronous step', async () => {
    // The async lock bookkeeping hides the order from a log, so the release is observed at the
    // instant the monitor calls it: the promise a lock callback returns is what holds the lock.
    const events: string[] = [];
    let releaseHook: (() => void) | null = null;
    class ObservedPromise<T> extends Promise<T> {
      static get [Symbol.species](): PromiseConstructor { return Promise; }
      constructor(executor: (resolve: (value: T | PromiseLike<T>) => void, reject: (reason?: unknown) => void) => void) {
        super((resolve, reject) => executor((value) => { releaseHook?.(); resolve(value); }, reject));
      }
    }
    const browser = new FakeBrowser();
    const realRequest = browser.locks.request.bind(browser.locks);
    browser.locks.request = <T,>(
      name: string,
      options: { mode?: 'exclusive'; ifAvailable?: boolean },
      callback: (lock: unknown) => Promise<T> | T,
    ): Promise<T> => realRequest(name, options, (lock) => {
      const Original = globalThis.Promise;
      globalThis.Promise = ObservedPromise as unknown as PromiseConstructor;
      try {
        return callback(lock);
      } finally {
        globalThis.Promise = Original;
      }
    });
    const tab = await startTab(browser, 'a');
    const markerKey = RECOVERY_MARKER_PREFIX + 'a';
    releaseHook = () => events.push(`release (marker present: ${browser.storage.items.has(markerKey)})`);
    tab.markClean();
    expect(events, 'the marker was already removed when the lock was released').toEqual(['release (marker present: false)']);
  });

  it('writes nothing when the page closes while the lock request is still pending', async () => {
    const browser = new FakeBrowser();
    const tab = browser.tab('a');
    const pending = tab.start(PARK);
    tab.markClean();
    await pending;
    await Promise.resolve();
    expect(browser.markerOf('a'), 'no marker for a page that already closed').toBeNull();
    expect(browser.locks.held.size, 'the late lock is released again').toBe(0);
  });

  it('a second start only updates park info; the marker keeps its start time', async () => {
    const browser = new FakeBrowser();
    const tab = await startTab(browser, 'a');
    const startedAt = browser.markerOf('a')?.startedAt;
    browser.time += 5000;
    await tab.start({ parkName: 'Loaded park', scenarioId: null });
    expect(browser.markerOf('a')?.parkName, 'new park name').toBe('Loaded park');
    expect(browser.markerOf('a')?.startedAt, 'start time kept').toBe(startedAt);
  });

  it('start after markClean registers again (bfcache restore)', async () => {
    const browser = new FakeBrowser();
    const tab = await startTab(browser, 'a');
    tab.markClean();
    expect(browser.markerOf('a')).toBeNull();
    await tab.start(PARK);
    expect(browser.markerOf('a'), 'marker is back').not.toBeNull();
    expect(browser.locks.held.has(RECOVERY_LOCK_PREFIX + 'a'), 'lock is back').toBe(true);
  });

  it('records visibility on visibilitychange', async () => {
    const browser = new FakeBrowser();
    const tab = await startTab(browser, 'a');
    browser.hidden.add('a');
    browser.time += 1000;
    tab.visibility();
    expect(browser.markerOf('a')?.hidden, 'hidden recorded').toBe(true);
    expect(browser.markerOf('a')?.heartbeatAt, 'heartbeat refreshed').toBe(browser.time);
  });
});

describe('RecoveryMonitor: detection with Web Locks', () => {
  it('flags a crashed tab as interrupted and offers its autosave', async () => {
    const browser = new FakeBrowser();
    await startTab(browser, 'a');
    browser.crash('a');
    const detection = await browser.tab('b').detectInterrupted(autosaveBy('a'));
    expect(detection.kind, 'crash is offered').toBe('offer');
    if (detection.kind !== 'offer') return;
    expect(detection.offer.parkName, 'park name is the one the autosave holds').toBe('Sandbox park');
    expect(detection.offer.evidence, 'lock evidence').toBe('lock-free');
    expect(detection.offer.autosave.revision, 'offer is bound to the revision').toBe(7);
    expect(detection.offer.autosave.guestCount, 'metadata only').toBe(42);
  });

  it('does not flag a clean close', async () => {
    const browser = new FakeBrowser();
    const tab = await startTab(browser, 'a');
    tab.markClean();
    expect((await browser.tab('b').detectInterrupted(autosaveBy('a'))).kind, 'clean close').toBe('clean');
  });

  it('does not flag a reload: the old page cleaned, the new page runs', async () => {
    const browser = new FakeBrowser();
    const first = await startTab(browser, 'a');
    first.markClean();
    await startTab(browser, 'a2');
    expect((await browser.tab('c').detectInterrupted(autosaveBy('a'))).kind, 'reload is not a crash').toBe('clean');
  });

  it('does not flag a second tab that is alive, even when its page is hidden', async () => {
    const browser = new FakeBrowser();
    await startTab(browser, 'a');
    await startTab(browser, 'b');
    browser.hidden.add('a');
    browser.advance(RECOVERY_STALE_HIDDEN_MS * 2);
    expect((await browser.tab('c').detectInterrupted(autosaveBy('a'))).kind, 'live tabs hold their locks').toBe('clean');
  });

  it('never reports its own marker', async () => {
    const browser = new FakeBrowser();
    const tab = await startTab(browser, 'a');
    browser.crash('a');
    expect((await tab.detectInterrupted(autosaveBy('a'))).kind, 'own marker ignored').toBe('clean');
  });

  it('with A crashed and B alive, the autosave of B is not offered; after B crashes too it is', async () => {
    const browser = new FakeBrowser();
    await startTab(browser, 'a', { parkName: 'Park A', scenarioId: null });
    await startTab(browser, 'b', { parkName: 'Park B', scenarioId: null });
    browser.crash('a');
    const first = await browser.tab('c').detectInterrupted(autosaveBy('b'));
    expect(first, 'B is alive and owns the autosave').toMatchObject({ kind: 'no-offer', reason: 'autosave-not-from-interrupted-session' });
    browser.crash('b');
    const second = await browser.tab('d').detectInterrupted(autosaveBy('b'));
    expect(second.kind, 'now the autosave belongs to a dead tab').toBe('offer');
    if (second.kind !== 'offer') return;
    expect(second.offer.parkName, 'the park the matching autosave holds').toBe('Sandbox park');
    expect(second.offer.interruptedSessionIds.sort(), 'both markers are to be forgotten').toEqual(['a', 'b']);
  });

  it('keeps the markers of interrupted sessions until forget, and forget leaves live tabs alone', async () => {
    const browser = new FakeBrowser();
    await startTab(browser, 'a');
    const live = await startTab(browser, 'b');
    browser.crash('a');
    const detector = browser.tab('c');
    await detector.detectInterrupted(autosaveBy('a'));
    expect(browser.markerOf('a'), 'scan does not delete evidence').not.toBeNull();
    detector.forget(['a', 'b']);
    expect(browser.markerOf('a'), 'forgotten').toBeNull();
    expect(browser.markerOf('b'), 'forget removes whatever marker it is told to').toBeNull();
    expect(browser.locks.held.has(RECOVERY_LOCK_PREFIX + live.sessionId), 'forget never touches a lock').toBe(true);
    detector.forget(['missing']);
  });

  it('purges junk, wrong-version, mismatched and 30-day-old markers without offering them', async () => {
    const browser = new FakeBrowser();
    await startTab(browser, 'old');
    const good = browser.markerOf('old') as RecoveryMarker;
    browser.crash('old');
    const put = (key: string, value: string): void => { browser.storage.items.set(RECOVERY_MARKER_PREFIX + key, value); };
    put('junk', '{not json');
    put('version', JSON.stringify({ ...good, sessionId: 'version', version: 99 }));
    put('mismatch', JSON.stringify({ ...good, sessionId: 'someone-else' }));
    put('shape', JSON.stringify({ ...good, sessionId: 'shape', hidden: 'yes' }));
    browser.time += RECOVERY_MARKER_MAX_AGE_MS + 1;
    const detection = await browser.tab('b').detectInterrupted(autosaveBy('old'));
    expect(detection.kind, 'nothing old is offered').toBe('clean');
    expect(browser.storage.items.size, 'every one of them was purged').toBe(0);
  });

  it('treats a lock failure as alive: doubt never produces an offer', async () => {
    const browser = new FakeBrowser();
    await startTab(browser, 'a');
    browser.crash('a');
    const failing: RecoveryLockManager = { request: () => Promise.reject(new Error('SecurityError')) };
    const detector = browser.tab('b', { locks: failing });
    expect((await detector.detectInterrupted(autosaveBy('a'))).kind, 'unknown liveness is alive').toBe('clean');
  });
});

describe('RecoveryMonitor: heartbeat fallback without Web Locks', () => {
  const heartbeatTab = (browser: FakeBrowser, id: string) => browser.tab(id, { locks: null });

  it('reports mode heartbeat and refreshes the marker on its timer', async () => {
    const browser = new FakeBrowser();
    const tab = heartbeatTab(browser, 'a');
    expect(tab.mode, 'mode').toBe('heartbeat');
    await tab.start(PARK);
    const first = browser.markerOf('a')?.heartbeatAt ?? 0;
    browser.advance(RECOVERY_HEARTBEAT_INTERVAL_MS * 3);
    expect(browser.markerOf('a')?.heartbeatAt, 'refreshed by the timer').toBeGreaterThan(first);
    expect(browser.markerOf('a')?.mode, 'marker says heartbeat').toBe('heartbeat');
  });

  it('a running tab that keeps beating is never stale', async () => {
    const browser = new FakeBrowser();
    await heartbeatTab(browser, 'a').start(PARK);
    browser.advance(RECOVERY_STALE_VISIBLE_MS * 3);
    expect((await heartbeatTab(browser, 'b').detectInterrupted(autosaveBy('a'))).kind, 'beating tab is alive').toBe('clean');
  });

  it('a visible tab that stopped beating is dead after the visible threshold, not before', async () => {
    const browser = new FakeBrowser();
    await heartbeatTab(browser, 'a').start(PARK);
    browser.timers.clear();
    browser.time += RECOVERY_STALE_VISIBLE_MS - 1;
    expect((await heartbeatTab(browser, 'b').detectInterrupted(autosaveBy('a'))).kind, 'just inside the threshold').toBe('clean');
    browser.time += 2;
    const detection = await heartbeatTab(browser, 'b').detectInterrupted(autosaveBy('a'));
    expect(detection.kind, 'past the threshold').toBe('offer');
    if (detection.kind === 'offer') expect(detection.offer.evidence, 'heartbeat evidence').toBe('heartbeat-stale');
  });

  it('a tab last seen hidden gets the long grace', async () => {
    const browser = new FakeBrowser();
    const tab = heartbeatTab(browser, 'a');
    await tab.start(PARK);
    browser.hidden.add('a');
    tab.heartbeat();
    browser.timers.clear();
    browser.time += RECOVERY_STALE_VISIBLE_MS * 10;
    expect((await heartbeatTab(browser, 'b').detectInterrupted(autosaveBy('a'))).kind, 'hidden tab within 30 min').toBe('clean');
    browser.time += RECOVERY_STALE_HIDDEN_MS;
    expect((await heartbeatTab(browser, 'b').detectInterrupted(autosaveBy('a'))).kind, 'hidden tab past 30 min').toBe('offer');
  });

  it('judges a heartbeat marker by staleness even when this tab has Web Locks', async () => {
    const browser = new FakeBrowser();
    await heartbeatTab(browser, 'a').start(PARK);
    browser.timers.clear();
    browser.time += RECOVERY_STALE_VISIBLE_MS + 1;
    expect((await browser.tab('b').detectInterrupted(autosaveBy('a'))).kind, 'staleness applies by marker mode').toBe('offer');
  });

  it('a clean close removes the marker in heartbeat mode too', async () => {
    const browser = new FakeBrowser();
    const tab = heartbeatTab(browser, 'a');
    await tab.start(PARK);
    tab.markClean();
    expect(browser.markerOf('a'), 'marker removed').toBeNull();
    expect(browser.timers.size, 'timer stopped').toBe(0);
  });
});

describe('RecoveryMonitor: storage unavailable', () => {
  it('is inert with no storage at all', async () => {
    const browser = new FakeBrowser();
    const tab = browser.tab('a', { storage: null });
    expect(tab.mode, 'mode').toBe('unavailable');
    await tab.start(PARK);
    expect(browser.locks.held.size, 'no lock taken').toBe(0);
    expect((await tab.detectInterrupted(null)).kind, 'nothing detected').toBe('clean');
    tab.markClean();
    tab.forget(['x']);
  });

  it('is inert when storage throws, and never throws itself', async () => {
    const browser = new FakeBrowser();
    browser.storage.broken = true;
    const tab = browser.tab('a');
    expect(tab.mode, 'mode').toBe('unavailable');
    await expect(tab.start(PARK), 'start resolves').resolves.toBeUndefined();
    expect((await tab.detectInterrupted(autosaveBy('x'))).kind, 'clean').toBe('clean');
  });

  it('survives a storage that starts failing after the park started', async () => {
    const browser = new FakeBrowser();
    const tab = await startTab(browser, 'a');
    browser.storage.broken = true;
    expect(() => { tab.heartbeat(); tab.markClean(); }, 'quota errors are swallowed').not.toThrow();
  });
});

describe('RecoveryMonitor: singleton', () => {
  it('returns the same monitor for the same holder, so HMR cannot create a second session id', () => {
    const holder: Record<string, unknown> = {};
    let created = 0;
    const make = (): RecoveryMonitor => { created += 1; return new FakeBrowser().tab(`t${created}`); };
    const first = getOrCreateRecoveryMonitor(holder, make);
    expect(getOrCreateRecoveryMonitor(holder, make), 'reused').toBe(first);
    expect(created, 'created once').toBe(1);
  });
});

describe('parseRecoveryMarker', () => {
  it('rejects null and non-objects', () => {
    expect(parseRecoveryMarker(null), 'null').toBeNull();
    expect(parseRecoveryMarker('[]'), 'array').toBeNull();
    expect(parseRecoveryMarker('5'), 'number').toBeNull();
  });
});

describe('decideRecovery', () => {
  const session = (id: string, startedAt = 1): InterruptedSession => ({
    evidence: 'lock-free',
    marker: { version: 1, sessionId: id, startedAt, heartbeatAt: startedAt + 10, hidden: false, mode: 'web-locks', parkName: `Park ${id}`, scenarioId: null },
  });

  it('is clean with nothing interrupted', () => {
    expect(decideRecovery([], autosaveBy('a')).kind, 'clean').toBe('clean');
  });

  it('has no offer without an autosave', () => {
    expect(decideRecovery([session('a')], null), 'missing').toMatchObject({ kind: 'no-offer', reason: 'autosave-missing' });
  });

  it('has no offer for an unreadable autosave', () => {
    const unreadable = autosaveBy('a', { status: { state: 'unreadable', code: 'corrupt', message: 'bad' } });
    expect(decideRecovery([session('a')], unreadable), 'unreadable').toMatchObject({ kind: 'no-offer', reason: 'autosave-unreadable' });
  });

  it('has no offer when the autosave was written by another tab', () => {
    expect(decideRecovery([session('a')], autosaveBy('b')), 'foreign writer').toMatchObject({ kind: 'no-offer', reason: 'autosave-not-from-interrupted-session' });
  });

  it('uses the interrupted session whose id matches the autosave writer', () => {
    const result = decideRecovery([session('a', 1), session('b', 50), session('c', 90)], autosaveBy('b'));
    expect(result.kind, 'offer').toBe('offer');
    if (result.kind !== 'offer') return;
    expect(result.offer.sessionId, 'matching session').toBe('b');
    expect(result.offer.parkName, 'the autosave park name').toBe('Sandbox park');
    expect(result.offer.startedAt, 'its start').toBe(50);
    expect(result.offer.lastSeenAt, 'its last heartbeat').toBe(60);
    expect(result.offer.interruptedSessionIds, 'all ids to forget').toEqual(['a', 'b', 'c']);
  });

  describe('the previous autosave generation (Phase 31)', () => {
    const previousBy = (writer: string, patch: Partial<SaveSlotMeta> = {}): SaveSlotMeta => autosaveBy(writer, { id: 'autosave-previous', revision: 2, savedAt: 50, ...patch });
    const unreadable = (writer: string): SaveSlotMeta => autosaveBy(writer, { status: { state: 'unreadable', code: 'corrupt', message: 'bad' } });

    it('offers the previous generation when the current one is unreadable and the interrupted tab wrote both', () => {
      const result = decideRecovery([session('a')], unreadable('a'), previousBy('a'));
      expect(result.kind, 'offer').toBe('offer');
      if (result.kind !== 'offer') return;
      expect(result.offer.autosave.slotId, 'the previous slot').toBe('autosave-previous');
      expect(result.offer.autosave.revision, 'its own revision').toBe(2);
    });

    it('offers the previous generation when the current one was quarantined away', () => {
      const result = decideRecovery([session('a')], null, previousBy('a'));
      expect(result.kind === 'offer' && result.offer.autosave.slotId).toBe('autosave-previous');
    });

    it('never offers the previous generation while the current one is readable', () => {
      const result = decideRecovery([session('a')], autosaveBy('a'), previousBy('a'));
      expect(result.kind === 'offer' && result.offer.autosave.slotId, 'the current one, no slot id').toBeUndefined();
      expect(decideRecovery([session('a')], autosaveBy('b'), previousBy('a')), 'a live tab owns the current one').toMatchObject({ kind: 'no-offer', reason: 'autosave-not-from-interrupted-session' });
    });

    it('keeps the current generation\'s reason when the previous one cannot stand in', () => {
      expect(decideRecovery([session('a')], unreadable('a'), previousBy('b')), 'another tab wrote it').toMatchObject({ kind: 'no-offer', reason: 'autosave-unreadable' });
      expect(decideRecovery([session('a')], unreadable('a'), previousBy('a', { status: { state: 'unreadable', code: 'corrupt', message: 'bad' } })), 'unreadable too').toMatchObject({ kind: 'no-offer', reason: 'autosave-unreadable' });
      expect(decideRecovery([session('a')], null, null), 'nothing').toMatchObject({ kind: 'no-offer', reason: 'autosave-missing' });
    });
  });
});
