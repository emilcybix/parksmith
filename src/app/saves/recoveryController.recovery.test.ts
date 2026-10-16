import { describe, expect, it } from 'vitest';
import { createRecoveryController } from './recoveryController';
import type {
  InterruptedSession,
  RecoveryDetection,
  RecoveryMonitor,
  RecoveryOffer,
  RecoveryParkInfo,
  RecoveryResult,
  RecoverySaveAccess,
} from './recoveryTypes';
import type { AutosaveSlotId, LoadSummary, ManualSaveSlotId, SaveResult, SaveSlotMeta } from './types';

/** The controller against a scripted monitor and a scripted save layer: it is a pure state machine. */

const offer = (patch: Partial<RecoveryOffer> = {}): RecoveryOffer => ({
  interruptedSessionIds: ['dead-1', 'dead-2'],
  sessionId: 'dead-1',
  parkName: 'Sunstone Valley',
  scenarioId: null,
  startedAt: 1000,
  lastSeenAt: 5000,
  autosave: {
    name: 'Autosave', scenarioName: 'Sandbox park', savedAt: 4000, playtimeSeconds: 600,
    guestCount: 42, cash: 18_300, rating: 61, revision: 7,
  },
  evidence: 'lock-free',
  ...patch,
});

const row = (patch: Partial<SaveSlotMeta> = {}): SaveSlotMeta => ({
  id: 'autosave', kind: 'auto', name: 'Autosave', scenarioId: null, scenarioName: 'Sandbox park',
  playtimeSeconds: 600, savedAt: 4000, schemaVersion: 1, contentVersion: 1, savedAtTick: 1, guestCount: 42,
  cash: 18_300, rating: 61, sizeBytes: 10, revision: 7, writerTabId: 'dead-1', status: { state: 'ok' }, ...patch,
});

class FakeMonitor implements RecoveryMonitor {
  readonly sessionId = 'me';
  readonly mode = 'web-locks' as const;
  detection: RecoveryDetection | Error = { kind: 'clean' };
  detectedWith: Array<SaveSlotMeta | null> = [];
  previousWith: Array<SaveSlotMeta | null> = [];
  forgotten: string[][] = [];
  started: RecoveryParkInfo[] = [];
  cleaned = 0;
  async start(park: RecoveryParkInfo): Promise<void> { this.started.push(park); }
  heartbeat(): void {}
  markClean(): void { this.cleaned += 1; }
  async detectInterrupted(autosave: SaveSlotMeta | null, previous: SaveSlotMeta | null = null): Promise<RecoveryDetection> {
    this.detectedWith.push(autosave);
    this.previousWith.push(previous);
    if (this.detection instanceof Error) throw this.detection;
    return this.detection;
  }
  forget(ids: readonly string[]): void { this.forgotten.push([...ids]); }
  dispose(): void {}
}

class FakeSaves implements RecoverySaveAccess {
  held = 0;
  holds: string[] = [];
  slots: SaveSlotMeta[] = [row()];
  state: 'checking' | 'ready' | 'unavailable' = 'ready';
  loadResult: SaveResult<LoadSummary> = { ok: true, value: { slotId: 'autosave', contentDrift: 'none', name: 'Autosave' } };
  /** Applied to `slots` when load is called, to model a flag set by a failed load. */
  onLoad: (() => void) | null = null;
  keepResult: RecoveryResult<ManualSaveSlotId> = { ok: true, value: 'manual-1' };
  keptWith: number[] = [];
  keptSlots: Array<AutosaveSlotId | undefined> = [];
  loads = 0;
  loadedIds: AutosaveSlotId[] = [];
  /** Applied after the next refresh, to model another tab writing in between. */
  afterRefresh: (() => void) | null = null;
  holdAutosave(): void { this.holds.push('hold'); this.held = 1; }
  releaseAutosave(): void { this.holds.push('release'); this.held = 0; }
  async keepAutosaveAsRecovered(revision: number, slotId?: AutosaveSlotId): Promise<RecoveryResult<ManualSaveSlotId>> {
    this.keptWith.push(revision);
    this.keptSlots.push(slotId);
    return this.keepResult;
  }
  notifyParkRewound(): void {}
  snapshot(): { slots: SaveSlotMeta[]; persistence: { state: 'checking' | 'ready' | 'unavailable' } } {
    return { slots: this.slots, persistence: { state: this.state } };
  }
  async load(id: AutosaveSlotId): Promise<SaveResult<LoadSummary>> {
    this.loads += 1;
    this.loadedIds.push(id);
    this.onLoad?.();
    return this.loadResult;
  }
  async refresh(): Promise<void> {
    const apply = this.afterRefresh;
    this.afterRefresh = null;
    apply?.();
  }
}

const rig = () => {
  const monitor = new FakeMonitor();
  const saves = new FakeSaves();
  const controller = createRecoveryController({ monitor, saves });
  return { monitor, saves, controller };
};

const offered = async (patch: Partial<RecoveryOffer> = {}) => {
  const context = rig();
  context.monitor.detection = { kind: 'offer', offer: offer(patch) };
  await context.controller.start();
  return context;
};

const session = (id: string): InterruptedSession => ({
  evidence: 'lock-free',
  marker: { version: 1, sessionId: id, startedAt: 1, heartbeatAt: 2, hidden: false, mode: 'web-locks', parkName: 'x', scenarioId: null },
});

describe('RecoveryController: startup', () => {
  it('holds the autosave from construction and starts in checking', () => {
    const { saves, controller } = rig();
    expect(saves.holds, 'held immediately').toEqual(['hold']);
    expect(controller.snapshot().phase, 'phase').toBe('checking');
  });

  it('clean detection: idle, markers untouched, autosave released, no notice', async () => {
    const { saves, controller, monitor } = rig();
    await controller.start();
    expect(controller.snapshot(), 'idle and silent').toEqual({ phase: 'idle', offer: null, error: null, notice: null });
    expect(saves.held, 'released').toBe(0);
    expect(monitor.forgotten, 'nothing to forget').toEqual([[]]);
  });

  it('hands the autosave row of the slot list to the monitor, and null when persistence is unavailable', async () => {
    const first = rig();
    await first.controller.start();
    expect(first.monitor.detectedWith[0]?.revision, 'row passed').toBe(7);
    const second = rig();
    second.saves.state = 'unavailable';
    await second.controller.start();
    expect(second.monitor.detectedWith[0], 'no store, no autosave').toBeNull();
  });

  it('runs detection once', async () => {
    const { controller, monitor } = rig();
    await controller.start();
    await controller.start();
    expect(monitor.detectedWith.length, 'once per page load').toBe(1);
  });

  it('an offer keeps the autosave held and publishes the offer', async () => {
    const { saves, controller, monitor } = await offered();
    expect(controller.snapshot().phase, 'offered').toBe('offered');
    expect(controller.snapshot().offer?.parkName, 'offer is published').toBe('Sunstone Valley');
    expect(saves.held, 'still held').toBe(1);
    expect(monitor.forgotten, 'markers stay until resolved').toEqual([]);
  });

  it.each([
    ['autosave-missing', 'no autosave to resume'],
    ['autosave-unreadable', 'could not be read'],
    ['autosave-not-from-interrupted-session', 'before your last park was autosaved'],
  ] as const)('no-offer %s: forgets the markers, releases, tells the player once', async (reason, text) => {
    const { saves, controller, monitor } = rig();
    monitor.detection = { kind: 'no-offer', reason, interrupted: [session('x'), session('y')] };
    await controller.start();
    expect(controller.snapshot().phase, 'idle').toBe('idle');
    expect(controller.snapshot().notice?.text, 'notice text').toContain(text);
    expect(monitor.forgotten, 'markers forgotten').toEqual([['x', 'y']]);
    expect(saves.held, 'released').toBe(0);
  });

  it('a detection failure never blocks the player', async () => {
    const { saves, controller, monitor } = rig();
    monitor.detection = new Error('boom');
    await controller.start();
    expect(controller.snapshot().phase, 'idle').toBe('idle');
    expect(saves.held, 'released').toBe(0);
  });

  it('a tab closed mid-prompt leaves the markers and the hold: nothing resolves by itself', async () => {
    const { controller, monitor, saves } = await offered();
    controller.markClean();
    expect(monitor.cleaned, 'pagehide forwarded').toBe(1);
    expect(monitor.forgotten, 'markers survive for the next load').toEqual([]);
    expect(saves.holds, 'no release').toEqual(['hold']);
  });
});

describe('RecoveryController: resume', () => {
  it('loads the autosave, forgets every marker and releases', async () => {
    const { controller, monitor, saves } = await offered();
    const result = await controller.commands.resume();
    expect(result.ok, 'resumed').toBe(true);
    expect(saves.loads, 'one load').toBe(1);
    expect(controller.snapshot().phase, 'idle').toBe('idle');
    expect(monitor.forgotten, 'all interrupted markers forgotten').toEqual([['dead-1', 'dead-2']]);
    expect(saves.held, 'released after the load, not before').toBe(0);
  });

  it('is in the resuming phase while the load runs and refuses a second press', async () => {
    const { controller, saves } = await offered();
    let phaseDuringLoad = '';
    saves.onLoad = () => { phaseDuringLoad = controller.snapshot().phase; };
    const first = controller.commands.resume();
    const second = await controller.commands.dismiss();
    expect(second, 'dismiss while resuming').toMatchObject({ ok: false, error: { code: 'busy' } });
    await first;
    expect(phaseDuringLoad, 'phase while loading').toBe('resuming');
  });

  it('withdraws the offer when another tab rewrote the autosave (revision)', async () => {
    const { controller, saves, monitor } = await offered();
    saves.afterRefresh = () => { saves.slots = [row({ revision: 8 })]; };
    const result = await controller.commands.resume();
    expect(result, 'changed').toMatchObject({ ok: false, error: { code: 'changed' } });
    expect(saves.loads, 'nothing loaded under the wrong label').toBe(0);
    expect(controller.snapshot().phase, 'idle').toBe('idle');
    expect(saves.held, 'released').toBe(0);
    expect(monitor.forgotten.length, 'markers forgotten').toBe(1);
  });

  it('withdraws the offer when the writer of the autosave changed', async () => {
    const { controller, saves } = await offered();
    saves.afterRefresh = () => { saves.slots = [row({ writerTabId: 'someone-else' })]; };
    expect(await controller.commands.resume(), 'writer mismatch').toMatchObject({ ok: false, error: { code: 'changed' } });
    expect(saves.loads, 'no load').toBe(0);
  });

  it('closes the offer when the autosave disappeared', async () => {
    const { controller, saves } = await offered();
    saves.afterRefresh = () => { saves.slots = []; };
    expect(await controller.commands.resume(), 'gone').toMatchObject({ ok: false, error: { code: 'not-found' } });
    expect(controller.snapshot().phase, 'idle').toBe('idle');
  });

  it('an autosave that turns out unreadable is flagged by the load: the offer closes and the player is told', async () => {
    const { controller, saves } = await offered();
    saves.loadResult = { ok: false, error: { code: 'corrupt', message: 'bad payload' } };
    saves.onLoad = () => { saves.slots = [row({ status: { state: 'unreadable', code: 'corrupt', message: 'bad payload' } })]; };
    const result = await controller.commands.resume();
    expect(result, 'unreadable').toMatchObject({ ok: false, error: { code: 'unreadable', cause: { code: 'corrupt' } } });
    expect(controller.snapshot().phase, 'closed').toBe('idle');
    expect(controller.snapshot().notice?.text, 'told once').toContain('could not be read');
    expect(saves.held, 'released').toBe(0);
  });

  it('a failure that leaves the slot intact keeps the offer open with the error', async () => {
    const { controller, saves } = await offered();
    saves.loadResult = { ok: false, error: { code: 'busy', message: 'Busy' } };
    const result = await controller.commands.resume();
    expect(result, 'busy').toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(controller.snapshot().phase, 'still offered').toBe('offered');
    expect(controller.snapshot().error?.code, 'error shown in the prompt').toBe('busy');
    expect(saves.held, 'still held').toBe(1);
    saves.loadResult = { ok: true, value: { slotId: 'autosave', contentDrift: 'none', name: 'Autosave' } };
    expect((await controller.commands.resume()).ok, 'a retry works and clears the error').toBe(true);
    expect(controller.snapshot().error, 'error cleared').toBeNull();
  });

  it('refuses with no-offer when nothing is offered', async () => {
    const { controller } = rig();
    await controller.start();
    expect(await controller.commands.resume(), 'resume').toMatchObject({ ok: false, error: { code: 'no-offer' } });
    expect(await controller.commands.dismiss(), 'dismiss').toMatchObject({ ok: false, error: { code: 'no-offer' } });
  });
});

describe('RecoveryController: not now', () => {
  it('keeps the autosave for the offered revision, forgets the markers, releases and says where it went', async () => {
    const { controller, saves, monitor } = await offered();
    const result = await controller.commands.dismiss();
    expect(result, 'kept').toEqual({ ok: true, value: 'manual-1' });
    expect(saves.keptWith, 'bound to the offer revision').toEqual([7]);
    expect(controller.snapshot().phase, 'idle').toBe('idle');
    expect(controller.snapshot().notice?.text, 'notice names the slot').toContain("'Recovered autosave' in manual-1");
    expect(monitor.forgotten, 'forgotten').toEqual([['dead-1', 'dead-2']]);
    expect(saves.held, 'released').toBe(0);
  });

  it('no free slot: the offer stays open with an explanation and the hold stays', async () => {
    const { controller, saves, monitor } = await offered();
    saves.keepResult = { ok: false, error: { code: 'no-free-slot', message: 'full' } };
    const result = await controller.commands.dismiss();
    expect(result, 'refused').toMatchObject({ ok: false, error: { code: 'no-free-slot' } });
    expect(controller.snapshot().phase, 'offer stays').toBe('offered');
    expect(controller.snapshot().error?.message, 'explains').toContain('Resume, or delete one in Save / Load first');
    expect(saves.held, 'autosave stays held: nothing may overwrite it').toBe(1);
    expect(monitor.forgotten, 'markers stay').toEqual([]);
    saves.keepResult = { ok: true, value: 'manual-4' };
    expect((await controller.commands.dismiss()).ok, 'works once a slot is free').toBe(true);
  });

  it.each(['changed', 'not-found'] as const)('%s withdraws the offer and releases', async (code) => {
    const { controller, saves, monitor } = await offered();
    saves.keepResult = { ok: false, error: { code, message: 'x' } };
    expect(await controller.commands.dismiss(), 'surfaced').toMatchObject({ ok: false, error: { code } });
    expect(controller.snapshot().phase, 'idle').toBe('idle');
    expect(saves.held, 'released').toBe(0);
    expect(monitor.forgotten.length, 'forgotten').toBe(1);
  });

  it('a store error keeps the offer open', async () => {
    const { controller, saves } = await offered();
    saves.keepResult = { ok: false, error: { code: 'store', message: 'disk' } };
    await controller.commands.dismiss();
    expect(controller.snapshot().phase, 'offered').toBe('offered');
    expect(controller.snapshot().error?.code, 'error').toBe('store');
  });

  it('a throwing save layer is a store error, never an unhandled rejection', async () => {
    const { controller, saves } = await offered();
    saves.keepAutosaveAsRecovered = () => Promise.reject(new Error('exploded'));
    expect(await controller.commands.dismiss(), 'caught').toMatchObject({ ok: false, error: { code: 'store', message: 'exploded' } });
    expect(controller.snapshot().phase, 'offered').toBe('offered');
  });
});

describe('RecoveryController: park lifecycle forwarding', () => {
  it('forwards parkStarted and re-registers the last park on pageRestored', () => {
    const { controller, monitor } = rig();
    controller.pageRestored();
    expect(monitor.started.length, 'nothing to restore yet').toBe(0);
    controller.parkStarted({ parkName: 'A', scenarioId: null });
    controller.parkStarted({ parkName: 'B', scenarioId: null });
    controller.pageRestored();
    expect(monitor.started.map((park) => park.parkName), 'last park wins').toEqual(['A', 'B', 'B']);
  });

  it('notifies subscribers with a new snapshot object per change and stops after unsubscribe', async () => {
    const { controller, monitor } = rig();
    const seen: string[] = [];
    const stop = controller.subscribe((snapshot) => seen.push(snapshot.phase));
    monitor.detection = { kind: 'offer', offer: offer() };
    await controller.start();
    stop();
    await controller.commands.dismiss();
    expect(seen, 'one update, then silence').toEqual(['offered']);
  });
});

describe('RecoveryController: a sibling tab crashes after this tab finished its startup scan', () => {
  const park: RecoveryParkInfo = { parkName: 'Second', scenarioId: null };
  const settle = async (): Promise<void> => { for (let turn = 0; turn < 10; turn += 1) await Promise.resolve(); };

  it('holds the autosave synchronously at park start and offers the dead tab\'s autosave', async () => {
    const { controller, monitor, saves } = rig();
    await controller.start();
    expect(controller.snapshot().phase, 'idle after a clean startup').toBe('idle');
    saves.holds.length = 0;
    // The sibling died while this tab idled; its marker is only visible to a new scan.
    monitor.detection = { kind: 'offer', offer: offer() };
    controller.parkStarted(park);
    expect(saves.held, 'held before any frame could ask for a park-start autosave').toBe(1);
    await settle();
    expect(controller.snapshot().phase, 'the offer is made although startup was long over').toBe('offered');
    expect(saves.held, 'still held until the player decides').toBe(1);
    expect(monitor.detectedWith.length, 'cheap scan, then a fresh one after refreshing the slot list').toBe(3);
  });

  it('releases the hold again when the rescan finds nothing, without reading the store', async () => {
    const { controller, monitor, saves } = rig();
    await controller.start();
    let refreshes = 0;
    saves.refresh = async () => { refreshes += 1; };
    controller.parkStarted(park);
    expect(saves.held).toBe(1);
    await settle();
    expect(saves.held, 'released').toBe(0);
    expect(refreshes, 'no dead tab, no store read').toBe(0);
    expect(monitor.detectedWith.length).toBe(2);
    expect(controller.snapshot().phase).toBe('idle');
  });

  it('does not rescan while an offer is already open or a scan is running', async () => {
    const { controller, monitor } = await offered();
    const scans = monitor.detectedWith.length;
    controller.parkStarted(park);
    await settle();
    expect(monitor.detectedWith.length, 'an open offer already holds the autosave').toBe(scans);
  });

  it('a failing rescan never keeps the autosave held', async () => {
    const { controller, monitor, saves } = rig();
    await controller.start();
    monitor.detection = new Error('boom');
    controller.parkStarted(park);
    await settle();
    expect(saves.held).toBe(0);
    expect(controller.snapshot().phase).toBe('idle');
  });
});

describe('RecoveryController: autosave generations (Phase 31)', () => {
  const previousRow = (patch: Partial<SaveSlotMeta> = {}): SaveSlotMeta => row({ id: 'autosave-previous', revision: 3, savedAt: 3000, ...patch });

  it('hands both generation rows to the monitor through the shared helper', async () => {
    const { saves, controller, monitor } = rig();
    saves.slots = [row(), previousRow(), row({ id: 'manual-1', kind: 'manual' })];
    await controller.start();
    expect(monitor.detectedWith[0]?.id, 'current').toBe('autosave');
    expect(monitor.previousWith[0]?.id, 'previous').toBe('autosave-previous');
  });

  it('resumes an offer of the previous generation from that slot, checking its own revision', async () => {
    const context = await offered({ autosave: { ...offer().autosave, revision: 3, slotId: 'autosave-previous' } });
    context.saves.slots = [row({ status: { state: 'unreadable', code: 'corrupt', message: 'bad' } }), previousRow()];
    const result = await context.controller.commands.resume();
    expect(result.ok, 'resumed').toBe(true);
    expect(context.saves.loadedIds, 'loaded the previous generation').toEqual(['autosave-previous']);
  });

  it('withdraws an offer of the previous generation when that slot changed', async () => {
    const context = await offered({ autosave: { ...offer().autosave, revision: 3, slotId: 'autosave-previous' } });
    context.saves.slots = [previousRow({ revision: 4 })];
    const result = await context.controller.commands.resume();
    expect(result.ok ? null : result.error.code).toBe('changed');
    expect(context.saves.loads, 'nothing loaded').toBe(0);
  });

  it('"Not now" keeps the offered generation', async () => {
    const context = await offered({ autosave: { ...offer().autosave, revision: 3, slotId: 'autosave-previous' } });
    await context.controller.commands.dismiss();
    expect(context.saves.keptWith, 'its revision').toEqual([3]);
    expect(context.saves.keptSlots, 'its slot').toEqual(['autosave-previous']);
    const current = await offered();
    await current.controller.commands.dismiss();
    expect(current.saves.keptSlots, 'the current one by default').toEqual(['autosave']);
  });
});
