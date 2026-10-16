import { describe, expect, it, vi } from 'vitest';
import { hashState } from '../../game/save/hash';
import { ParkSession } from '../../game/session/ParkSession';
import {
  UNDO_CONFIRM_MIN_GAP_MS,
  UNDO_CONFIRM_REWIND_SECONDS,
  UNDO_CONFIRM_WINDOW_MS,
  UNDO_EMPTY_MESSAGE,
  UNDO_ESTIMATED_BYTES_BASE,
  UNDO_ESTIMATED_BYTES_PER_GUEST,
  UNDO_FAILED_MESSAGE,
  UNDO_MAX_DEPTH,
  UNDO_MEMORY_BUDGET_BYTES,
  UNDO_MIN_DEPTH,
  UNDO_SCENARIO_ENDED_MESSAGE,
} from './constants';
import { ParkSnapshotUndo } from './SnapshotUndo';
import type { UndoCapture, UndoEntry, UndoHost } from './types';

/**
 * The ring against a real ParkSession behind a fake host: no renderer, no store, no GameApp. The
 * host's `restore` does what GameApp's does for the part the ring cares about (a fresh
 * `fromState` session), so "state hash after undo equals the hash before the gesture" is the real
 * property, not a stub of it.
 */

interface Fixture {
  undo: ParkSnapshotUndo;
  host: UndoHost;
  session(): ParkSession;
  /** Simulated milliseconds; the test advances it like the clock would. */
  advance(seconds: number): void;
  setNow(ms: number): void;
  flags: { busy: boolean; running: boolean; restoreThrows: boolean; captureThrows: boolean; guestCount: number | null };
  restores: UndoEntry[];
  afterRestores: number;
}

/**
 * The stamp GameApp gives the ring: the world version plus the colour edits, because a recolour (Phase
 * 28) is a gesture that must leave an entry yet is not simulation state and does not move `version`.
 */
const stamp = (session: ParkSession): number => session.world.version + session.world.appearanceVersion * 2 ** 32;

const createFixture = (): Fixture => {
  let session = new ParkSession(null);
  let simulationTimeMs = 0;
  let now = 1_000_000;
  const flags = { busy: false, running: true, restoreThrows: false, captureThrows: false, guestCount: null as number | null };
  const restores: UndoEntry[] = [];
  const state = { afterRestores: 0 };
  const host: UndoHost = {
    capture: (): UndoCapture => {
      if (flags.captureThrows) throw new Error('Not plain data at guests[1].position.x: NaN');
      session.syncWithWorld();
      return {
        state: session.serialize(),
        clock: { speed: 1, simulationTimeMs },
        cash: session.world.cash,
        guestCount: flags.guestCount ?? session.guests.guests.size,
        worldVersion: stamp(session),
      };
    },
    worldVersion: () => stamp(session),
    simulationTimeMs: () => simulationTimeMs,
    cash: () => session.world.cash,
    scenarioRunning: () => flags.running,
    busy: () => flags.busy,
    restore: (entry) => {
      if (flags.restoreThrows) throw new Error('fromState failed');
      session = ParkSession.fromState(entry.state);
      simulationTimeMs = entry.clock.simulationTimeMs;
      restores.push(entry);
    },
    afterRestore: () => { state.afterRestores += 1; },
    now: () => now,
  };
  const undo = new ParkSnapshotUndo(host);
  return {
    undo,
    host,
    session: () => session,
    advance: (seconds) => { simulationTimeMs += seconds * 1_000; },
    setNow: (ms) => { now = ms; },
    flags,
    restores,
    get afterRestores() { return state.afterRestores; },
  };
};

const hashOf = (session: ParkSession): string => {
  session.syncWithWorld();
  return hashState(session.serialize());
};

/** One complete gesture: capture, mutate, commit. Returns the hash from just before it. */
const buildBench = (fixture: Fixture, x: number, label = `Bench ${x}`): string => {
  const before = hashOf(fixture.session());
  fixture.undo.begin('object');
  fixture.session().world.buildObject('ribbon-bench', { x, y: 4 });
  fixture.undo.commit(label);
  return before;
};

describe('capture: begin, commit, abandon', () => {
  it('commit keeps an entry only when the world version changed since begin', () => {
    const fixture = createFixture();
    fixture.undo.begin('object');
    fixture.undo.commit('Nothing happened');
    expect(fixture.undo.depth, 'a click that changed nothing leaves no entry').toBe(0);

    buildBench(fixture, 4);
    expect(fixture.undo.depth).toBe(1);
  });

  it('begin twice captures once (a bulldozer drag calls it on every pointer move)', () => {
    const fixture = createFixture();
    const capture = vi.spyOn(fixture.host, 'capture');
    fixture.undo.begin('demolition');
    fixture.undo.begin('demolition');
    fixture.undo.begin('demolition');
    expect(capture).toHaveBeenCalledTimes(1);
  });

  it('a capture that throws never vetoes the gesture: no entry, commit is a no-op', () => {
    const fixture = createFixture();
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    fixture.flags.captureThrows = true;
    expect(fixture.undo.begin('object'), 'begin reports that nothing was captured').toBe(false);
    expect(fixture.undo.hasPending).toBe(false);
    fixture.session().world.buildObject('ribbon-bench', { x: 4, y: 4 });
    fixture.undo.commit('Bench 4');
    expect(fixture.session().world.objectAt({ x: 4, y: 4 }), 'the gesture itself still built').toBeDefined();
    expect(fixture.undo.depth).toBe(0);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
    fixture.flags.captureThrows = false;
    expect(fixture.undo.begin('object'), 'the next gesture captures again').toBe(true);
  });

  it('a drag with five mutations is one entry', () => {
    const fixture = createFixture();
    fixture.undo.begin('demolition');
    for (let x = 4; x < 9; x += 1) fixture.session().world.buildObject('ribbon-bench', { x, y: 4 });
    fixture.undo.commit('5 things demolished');
    expect(fixture.undo.depth).toBe(1);
    expect(fixture.undo.newest?.label).toBe('5 things demolished');
  });

  it('abandon drops the pending snapshot without an entry', () => {
    const fixture = createFixture();
    fixture.undo.begin('object');
    fixture.session().world.buildObject('ribbon-bench', { x: 4, y: 4 });
    fixture.undo.abandon();
    fixture.undo.commit('Too late');
    expect(fixture.undo.depth).toBe(0);
    expect(fixture.undo.hasPending).toBe(false);
  });

  it('settles a stale pending gesture of another kind before capturing the next one', () => {
    const fixture = createFixture();
    fixture.undo.begin('demolition');
    fixture.session().world.buildObject('ribbon-bench', { x: 4, y: 4 });
    fixture.undo.setPendingLabel('Bench demolished');
    fixture.undo.begin('object');
    expect(fixture.undo.depth, 'the demolition whose pointer-up never came was committed').toBe(1);
    expect(fixture.undo.newest?.label).toBe('Bench demolished');
    expect(fixture.undo.hasPending, 'and the new gesture is pending').toBe(true);
  });

  it('captures nothing once the scenario is over, and nothing is captured twice for one gesture', () => {
    const fixture = createFixture();
    fixture.flags.running = false;
    const capture = vi.spyOn(fixture.host, 'capture');
    fixture.undo.begin('object');
    expect(capture).not.toHaveBeenCalled();
    expect(fixture.undo.hasPending).toBe(false);
  });
});

describe('restoring', () => {
  it('restores the newest entry, pops it, and reproduces the pre-gesture state hash', () => {
    const fixture = createFixture();
    const before = buildBench(fixture, 4);
    fixture.advance(5);
    const outcome = fixture.undo.requestUndo();
    expect(outcome).toMatchObject({ kind: 'undone', target: 'Bench 4', rewoundSeconds: 5 });
    expect(hashOf(fixture.session()), 'the rewound park is exactly the pre-gesture park').toBe(before);
    expect(fixture.undo.depth).toBe(0);
    expect(fixture.afterRestores, 'the host is told for the autosave dirty flag').toBe(1);
  });

  it('a chain of ten restores in reverse order, each to its own pre-gesture hash', () => {
    const fixture = createFixture();
    const hashes: string[] = [];
    for (let index = 0; index < 10; index += 1) {
      hashes.push(buildBench(fixture, 4 + index));
      fixture.advance(2);
    }
    expect(fixture.undo.depth).toBe(10);
    for (let index = 9; index >= 0; index -= 1) {
      expect(fixture.undo.requestUndo().kind).toBe('undone');
      expect(hashOf(fixture.session()), `after undo ${10 - index}`).toBe(hashes[index]);
    }
    expect(fixture.undo.requestUndo(), 'the eleventh press').toEqual({ kind: 'refused', reason: 'empty', message: UNDO_EMPTY_MESSAGE });
  });

  it('does not mutate the entry it restores, so it can be restored again', () => {
    const fixture = createFixture();
    buildBench(fixture, 4);
    const entry = fixture.undo.newest!;
    const hash = hashState(entry.state);
    fixture.undo.requestUndo();
    expect(hashState(entry.state), 'fromState neither mutates nor aliases the snapshot').toBe(hash);
    expect(hashState(ParkSession.fromState(entry.state).serialize())).toBe(hash);
  });

  it('a demolished ride comes back through the ring with its runtime state', () => {
    const fixture = createFixture();
    const { world, rides } = fixture.session();
    const ride = world.buildObject('moonpetal-carousel', { x: 10, y: 10 })!;
    fixture.session().syncWithWorld();
    rides.setTicketPrice(ride.id, 9);
    rides.setOpen(ride.id, false);
    const runtime = structuredClone(rides.getRide(ride.id)!);

    fixture.undo.begin('demolition');
    world.bulldoze({ x: 10, y: 10 });
    fixture.undo.commit('Moonpetal Carousel demolished');
    fixture.session().syncWithWorld();
    expect(fixture.session().rides.getRide(ride.id)).toBeUndefined();
    expect(fixture.undo.requestUndo().kind).toBe('undone');
    expect(fixture.session().rides.getRide(ride.id), 'ticket price 9, closed by the player, all of it').toEqual(runtime);
  });

  it('the First Day ledger rides along: undo returns the steps latched at capture time, and adoptDismissals keeps the player\'s choices', () => {
    const fixture = createFixture();
    const first = fixture.session();
    first.world.buildPaths([{ x: 15, y: 31 }, { x: 15, y: 30 }, { x: 15, y: 29 }, { x: 15, y: 28 }, { x: 15, y: 27 }, { x: 15, y: 26 }, { x: 15, y: 25 }]);
    first.syncWithWorld();
    for (let tick = 0; tick < 20; tick += 1) first.step(100);
    expect(first.onboarding!.snapshot().steps.find((step) => step.id === 'lay-path')!.status, 'the path step latched').toBe('done');

    fixture.undo.begin('object');
    fixture.session().world.buildObject('ribbon-bench', { x: 4, y: 4 });
    fixture.undo.commit('Bench');
    first.onboarding!.skipStep('first-ride');
    first.onboarding!.dismissAll();
    const live = first.onboarding!.snapshot();

    expect(fixture.undo.requestUndo().kind).toBe('undone');
    const restored = fixture.session();
    expect(restored).not.toBe(first);
    const afterUndo = restored.onboarding!.snapshot();
    expect(afterUndo.steps.find((step) => step.id === 'lay-path')!.status, 'the latched set is the one at capture time').toBe('done');
    expect(afterUndo.dismissed, 'the rewound timeline predates the dismissal').toBe(false);

    restored.onboarding!.adoptDismissals(live);
    const adopted = restored.onboarding!.snapshot();
    expect(adopted.dismissed).toBe(true);
    expect(adopted.steps.find((step) => step.id === 'first-ride')!.status).toBe('skipped');
    expect(adopted.steps.find((step) => step.id === 'lay-path')!.status, 'adopting never un-completes').toBe('done');
  });

  it('after a restore the older entries still restore (they are earlier moments of the same timeline)', () => {
    const fixture = createFixture();
    const first = buildBench(fixture, 4);
    fixture.advance(3);
    buildBench(fixture, 5);
    fixture.undo.requestUndo();
    expect(fixture.undo.depth).toBe(1);
    fixture.undo.requestUndo();
    expect(hashOf(fixture.session())).toBe(first);
  });

  it('a host whose restore throws leaves the ring minus that entry, and reports failure', () => {
    const fixture = createFixture();
    const first = buildBench(fixture, 4);
    fixture.advance(2);
    buildBench(fixture, 5);
    const liveBefore = hashOf(fixture.session());
    fixture.flags.restoreThrows = true;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const outcome = fixture.undo.requestUndo();
    error.mockRestore();
    expect(outcome).toEqual({ kind: 'failed', message: UNDO_FAILED_MESSAGE });
    expect(hashOf(fixture.session()), 'the live park is untouched').toBe(liveBefore);
    expect(fixture.undo.depth, 'the failing entry is dropped, the older one stays').toBe(1);
    expect(fixture.afterRestores, 'no dirty flag for a restore that did not happen').toBe(0);

    fixture.flags.restoreThrows = false;
    fixture.undo.requestUndo();
    expect(hashOf(fixture.session()), 'the older entry still works').toBe(first);
  });

  it('refuses while the host is busy and while the scenario is over', () => {
    const fixture = createFixture();
    buildBench(fixture, 4);
    fixture.flags.busy = true;
    expect(fixture.undo.requestUndo()).toMatchObject({ kind: 'refused', reason: 'busy' });
    expect(fixture.undo.depth, 'a refusal keeps the entry').toBe(1);
    fixture.flags.busy = false;
    fixture.flags.running = false;
    expect(fixture.undo.requestUndo()).toEqual({ kind: 'refused', reason: 'scenario-ended', message: UNDO_SCENARIO_ENDED_MESSAGE });
    expect(fixture.restores).toEqual([]);
  });

  it('Ctrl+Z mid-drag commits and undoes the partial drag', () => {
    const fixture = createFixture();
    const before = hashOf(fixture.session());
    fixture.undo.begin('demolition');
    fixture.session().world.buildObject('ribbon-bench', { x: 4, y: 4 });
    fixture.undo.setPendingLabel('Bench demolished');
    expect(fixture.undo.requestUndo()).toMatchObject({ kind: 'undone', target: 'Bench demolished' });
    expect(hashOf(fixture.session())).toBe(before);
  });
});

describe('eviction and the memory budget', () => {
  it('the depth cap drops the oldest entry', () => {
    const fixture = createFixture();
    for (let index = 0; index < UNDO_MAX_DEPTH + 3; index += 1) buildBench(fixture, 2 + index);
    expect(fixture.undo.depth).toBe(UNDO_MAX_DEPTH);
    expect(fixture.undo.newest?.label).toBe(`Bench ${2 + UNDO_MAX_DEPTH + 2}`);
    // The oldest three are gone: undoing everything ends at the fourth gesture's pre-state.
    let presses = 0;
    while (fixture.undo.requestUndo().kind === 'undone') presses += 1;
    expect(presses).toBe(UNDO_MAX_DEPTH);
    expect(fixture.session().world.objects.size, 'three benches are beyond the ring').toBe(3);
  });

  it('the memory budget evicts oldest first and never below the minimum', () => {
    const fixture = createFixture();
    // 10,000 guests per snapshot by estimate: three of them are already over the budget.
    fixture.flags.guestCount = 10_000;
    const perEntry = UNDO_ESTIMATED_BYTES_BASE + UNDO_ESTIMATED_BYTES_PER_GUEST * 10_000;
    expect(perEntry * UNDO_MIN_DEPTH, 'the fixture is heavy enough to hit the floor').toBeGreaterThan(UNDO_MEMORY_BUDGET_BYTES);
    for (let index = 0; index < 8; index += 1) buildBench(fixture, 2 + index);
    expect(fixture.undo.depth, 'the floor holds').toBe(UNDO_MIN_DEPTH);
    expect(fixture.undo.newest?.label, 'the newest survived').toBe('Bench 9');
    expect(fixture.undo.status().maxDepth, 'the status says the budget lowered the cap').toBe(UNDO_MIN_DEPTH);
  });

  it('heavy parks hold fewer entries than light ones, within the budget', () => {
    const fixture = createFixture();
    fixture.flags.guestCount = 1_000;
    const perEntry = UNDO_ESTIMATED_BYTES_BASE + UNDO_ESTIMATED_BYTES_PER_GUEST * 1_000;
    const fits = Math.floor(UNDO_MEMORY_BUDGET_BYTES / perEntry);
    expect(fits, 'sanity: the guest cap does not fit the full depth').toBeLessThan(UNDO_MAX_DEPTH);
    for (let index = 0; index < UNDO_MAX_DEPTH; index += 1) buildBench(fixture, 2 + index);
    expect(fixture.undo.depth).toBe(fits);
    expect(fixture.undo.estimatedBytes).toBeLessThanOrEqual(UNDO_MEMORY_BUDGET_BYTES);
    expect(fixture.undo.status().maxDepth).toBe(fits);
  });
});

describe('clearing', () => {
  it.each(['new-park', 'loaded', 'disposed'] as const)('%s empties the ring and the pending snapshot and reopens it', (reason) => {
    const fixture = createFixture();
    buildBench(fixture, 4);
    fixture.undo.begin('object');
    fixture.undo.clear(reason);
    expect(fixture.undo.depth).toBe(0);
    expect(fixture.undo.hasPending).toBe(false);
    expect(fixture.undo.estimatedBytes).toBe(0);
    expect(fixture.undo.status()).toMatchObject({ canUndo: false, reason: 'empty' });
    buildBench(fixture, 5);
    expect(fixture.undo.depth, 'a new park can be undone in again').toBe(1);
  });

  it('scenario-ended empties the ring and keeps it shut', () => {
    const fixture = createFixture();
    buildBench(fixture, 4);
    fixture.undo.clear('scenario-ended');
    expect(fixture.undo.status()).toMatchObject({ canUndo: false, reason: 'scenario-ended', message: UNDO_SCENARIO_ENDED_MESSAGE });
    const capture = vi.spyOn(fixture.host, 'capture');
    fixture.undo.begin('object');
    expect(capture, 'no capture after a latch').not.toHaveBeenCalled();
    fixture.undo.commit('Ignored');
    expect(fixture.undo.depth).toBe(0);
    // A new park reopens it.
    fixture.undo.clear('new-park');
    buildBench(fixture, 5);
    expect(fixture.undo.depth).toBe(1);
  });
});

describe('what the button says', () => {
  it('rewind seconds come from the simulation clock, and the label states them', () => {
    const fixture = createFixture();
    buildBench(fixture, 4);
    fixture.undo.refresh();
    expect(fixture.undo.status()).toMatchObject({ canUndo: true, label: 'Undo', rewindSeconds: 0, needsConfirmation: false });
    fixture.advance(42);
    expect(fixture.undo.refresh()).toBe(true);
    expect(fixture.undo.status()).toMatchObject({ label: 'Undo · rewinds 42 s', rewindSeconds: 42, target: 'Bench 4', kind: 'object' });
  });

  it('names cash after the undo and the steps available in the tooltip', () => {
    const fixture = createFixture();
    const cashBefore = fixture.session().world.cash;
    buildBench(fixture, 4);
    buildBench(fixture, 5);
    fixture.undo.refresh();
    const status = fixture.undo.status();
    expect(status.cashAfterUndo, 'the balance before the newest gesture').toBe(fixture.undo.newest!.cash);
    expect(status.cashAfterUndo).toBeLessThan(cashBefore);
    expect(status.tooltip).toContain('Takes back Bench 5');
    expect(status.tooltip).toContain('2 steps available (Ctrl+Z)');
    expect(status.tooltip).toContain(`$${Math.round(status.cashAfterUndo!).toLocaleString('en-US')}`);
  });

  it('refresh returns false when nothing visible changed and true when a simulated second ticked', () => {
    const fixture = createFixture();
    buildBench(fixture, 4);
    expect(fixture.undo.refresh()).toBe(false);
    const status = fixture.undo.status();
    fixture.advance(0.4);
    expect(fixture.undo.refresh(), 'under a second: same label').toBe(false);
    expect(fixture.undo.status(), 'and the very same object, nothing allocated').toBe(status);
    fixture.advance(0.7);
    expect(fixture.undo.refresh()).toBe(true);
    expect(fixture.undo.refresh(), 'then quiet again').toBe(false);
  });

  it('counts a gesture still in progress, named by what it has called itself so far', () => {
    const fixture = createFixture();
    buildBench(fixture, 4);
    fixture.undo.begin('demolition');
    fixture.undo.refresh();
    expect(fixture.undo.status().depth, 'a drag that changed nothing yet is not a step').toBe(1);
    fixture.session().world.buildObject('ribbon-bench', { x: 6, y: 4 });
    fixture.undo.setPendingLabel('Bench demolished');
    expect(fixture.undo.refresh()).toBe(true);
    expect(fixture.undo.status()).toMatchObject({ depth: 2, target: 'Bench demolished', kind: 'demolition' });
  });

  it('an empty ring is shown disabled, never hidden, and says why', () => {
    const fixture = createFixture();
    fixture.undo.refresh();
    expect(fixture.undo.status()).toMatchObject({ canUndo: false, label: 'Undo', reason: 'empty', message: UNDO_EMPTY_MESSAGE });
    fixture.flags.busy = true;
    fixture.undo.refresh();
    expect(fixture.undo.status()).toMatchObject({ canUndo: false, reason: 'busy' });
  });
});

describe('the two-press confirmation', () => {
  const longRewind = (seconds: number): Fixture => {
    const fixture = createFixture();
    buildBench(fixture, 4);
    fixture.advance(seconds);
    return fixture;
  };

  it('needs confirmation above 60 s and not at 60 s', () => {
    const exactly = longRewind(UNDO_CONFIRM_REWIND_SECONDS);
    exactly.undo.refresh();
    expect(exactly.undo.status().needsConfirmation).toBe(false);
    expect(exactly.undo.requestUndo().kind, 'sixty seconds is one press').toBe('undone');

    const over = longRewind(UNDO_CONFIRM_REWIND_SECONDS + 1);
    over.undo.refresh();
    expect(over.undo.status().needsConfirmation).toBe(true);
  });

  it('the first press arms, the second inside the window rewinds', () => {
    const fixture = longRewind(200);
    const first = fixture.undo.requestUndo();
    expect(first).toEqual({ kind: 'confirm', target: 'Bench 4', rewindSeconds: 200, strong: false });
    expect(fixture.undo.depth, 'nothing was rewound').toBe(1);
    expect(fixture.undo.status()).toMatchObject({ armed: true, label: 'Confirm rewind 3 min 20 s' });
    fixture.setNow(1_000_000 + UNDO_CONFIRM_WINDOW_MS - 1);
    expect(fixture.undo.requestUndo()).toMatchObject({ kind: 'undone', rewoundSeconds: 200 });
  });

  it('a second press within the minimum gap (a double-click) neither confirms nor restarts the arm', () => {
    const fixture = longRewind(200);
    fixture.undo.requestUndo();
    fixture.setNow(1_000_000 + 30);
    expect(fixture.undo.requestUndo().kind, 'the double-click is not a confirmation').toBe('confirm');
    expect(fixture.undo.depth).toBe(1);
    expect(fixture.undo.status().armed, 'still armed').toBe(true);
    fixture.setNow(1_000_000 + UNDO_CONFIRM_MIN_GAP_MS);
    expect(fixture.undo.requestUndo().kind, 'a deliberate second press still confirms').toBe('undone');
  });

  it('compares the unfloored distance: 60.9 s needs confirmation although the label reads 60', () => {
    const fixture = createFixture();
    buildBench(fixture, 4);
    fixture.advance(60.9);
    fixture.undo.refresh();
    expect(fixture.undo.status().needsConfirmation).toBe(true);
    expect(fixture.undo.requestUndo().kind).toBe('confirm');
  });

  it('the arm expires after the window, silently', () => {
    const fixture = longRewind(200);
    fixture.undo.requestUndo();
    fixture.setNow(1_000_000 + UNDO_CONFIRM_WINDOW_MS);
    expect(fixture.undo.refresh(), 'the status changes when the arm expires').toBe(true);
    expect(fixture.undo.status().armed).toBe(false);
    expect(fixture.undo.requestUndo().kind, 'a late second press arms again instead of rewinding').toBe('confirm');
    expect(fixture.undo.depth).toBe(1);
  });

  it('a new gesture disarms: the arm belonged to the old target', () => {
    const fixture = longRewind(200);
    fixture.undo.requestUndo();
    expect(fixture.undo.status().armed).toBe(true);
    buildBench(fixture, 5);
    fixture.undo.refresh();
    expect(fixture.undo.status().armed).toBe(false);
    expect(fixture.undo.requestUndo(), 'the newest gesture is recent, so one press').toMatchObject({ kind: 'undone', target: 'Bench 5' });
  });

  it('flags a rewind past five minutes as strong', () => {
    const fixture = longRewind(430);
    expect(fixture.undo.requestUndo()).toMatchObject({ kind: 'confirm', strong: true, rewindSeconds: 430 });
  });
});

describe('a recolour entry (Phase 28)', () => {
  const recolour = (fixture: Fixture, id: number, colours: (number | null)[], label = 'Ride recoloured'): void => {
    fixture.undo.begin('recolour');
    fixture.session().world.setObjectColours(id, colours);
    fixture.undo.commit(label);
  };
  const withRide = (): { fixture: Fixture; id: number } => {
    const fixture = createFixture();
    fixture.session().world.addMoney(100_000);
    const id = fixture.session().world.buildObject('moonpetal-carousel', { x: 20, y: 10 })!.id;
    return { fixture, id };
  };

  it('a colour change is a gesture that leaves an entry although the world version did not move', () => {
    const { fixture, id } = withRide();
    const version = fixture.session().world.version;
    recolour(fixture, id, [3, null, null]);
    expect(fixture.session().world.version).toBe(version);
    expect(fixture.undo.depth).toBe(1);
    expect(fixture.undo.newest?.kind).toBe('recolour');
  });

  it('a pick of the colour already there changes nothing and leaves no entry', () => {
    const { fixture, id } = withRide();
    recolour(fixture, id, [3, null, null]);
    recolour(fixture, id, [3, null, null]);
    expect(fixture.undo.depth).toBe(1);
  });

  it('says it rewinds nothing and needs no confirmation, however much time has passed', () => {
    const { fixture, id } = withRide();
    recolour(fixture, id, [3, null, null], 'Moonpetal Carousel recoloured');
    fixture.advance(UNDO_CONFIRM_REWIND_SECONDS * 20);
    fixture.undo.refresh();
    const status = fixture.undo.status();
    expect(status).toMatchObject({ canUndo: true, kind: 'recolour', rewindSeconds: 0, needsConfirmation: false, label: 'Undo', target: 'Moonpetal Carousel recoloured' });
    expect(status.tooltip).toContain('Nothing else changes');
    expect(status.tooltip).not.toContain('Cash returns');
    expect(status.tooltip).not.toContain('Rewinds the whole park');
  });

  it('is undone with one press even a long time later, and reports no rewound seconds', () => {
    const { fixture, id } = withRide();
    recolour(fixture, id, [3, null, null]);
    fixture.advance(UNDO_CONFIRM_REWIND_SECONDS * 20);
    const outcome = fixture.undo.requestUndo();
    expect(outcome).toMatchObject({ kind: 'undone', rewoundSeconds: 0 });
    expect(fixture.restores.length).toBe(1);
    expect(fixture.undo.depth).toBe(0);
  });

  it('does not change how the entries around it behave: an older gesture still confirms by its own distance', () => {
    const { fixture, id } = withRide();
    buildBench(fixture, 4);
    fixture.advance(UNDO_CONFIRM_REWIND_SECONDS + 5);
    recolour(fixture, id, [3, null, null]);
    expect(fixture.undo.requestUndo().kind).toBe('undone');
    expect(fixture.undo.requestUndo().kind, 'the bench is 65 s back').toBe('confirm');
  });
});
