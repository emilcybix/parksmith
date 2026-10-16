import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { NEUTRAL_CROWD_READER } from '../crowd/CrowdSimulation';
import type { CrowdFlowReader } from '../crowd/types';
import { hashState } from '../save/hash';
import { compileParkRules, type ParkRuleset } from '../scenarios/rules';
import { ParkSession } from '../session/ParkSession';
import type { Cell } from '../types';
import { CROWDED_THOUGHT, type GuestCrowdReader } from './GuestSimulation';
import type { Guest, GuestState } from './types';

/**
 * Phase 14 (design Q1, Q2): what GuestSimulation reads and writes through its crowd reader. Entries come only from guests
 * walking a route, at the moment they step onto a tile; the walking-speed factor is read for the tile being stepped onto;
 * the happiness loss and the "so crowded" thought happen only on a severe tile; the neutral reader changes nothing.
 */

const STEP_MS = 100;
const WALK_STATES: ReadonlySet<GuestState> = new Set<GuestState>(['walkingToRide', 'walkingToShop', 'wandering', 'leaving']);

/** The ruleset of a new park without the Phase 14 key (feedback off: the field is display only). */
const rulesWithoutFeedback = (): ParkRuleset => {
  const rules: ParkRuleset = { ...compileParkRules() };
  delete rules.crowdFeedback;
  return Object.freeze(rules);
};

/** A small sandbox: a ride, a drink stall and a toilet on a short network (as GuestSimulation.serialize.test). */
const createPark = (rules?: ParkRuleset): ParkSession => {
  const session = new ParkSession(null, [], rules ? { rules } : {});
  session.world.buildPaths([
    { x: 15, y: 30 }, { x: 15, y: 29 }, { x: 15, y: 28 }, { x: 15, y: 27 }, { x: 15, y: 26 },
    { x: 16, y: 27 }, { x: 17, y: 27 }, { x: 14, y: 26 }, { x: 13, y: 26 },
  ]);
  for (const [definitionId, anchor] of [
    ['petal-roundabout', { x: 12, y: 27 }],
    ['fizz-foundry', { x: 16, y: 28 }],
    ['comfort-cabin', { x: 14, y: 24 }],
  ] as const) {
    if (!session.world.buildObject(definitionId, anchor)) throw new Error(`fixture: ${definitionId} should be placeable`);
  }
  session.syncWithWorld();
  return session;
};

const run = (session: ParkSession, ticks: number): void => {
  for (let tick = 0; tick < ticks; tick += 1) session.step(STEP_MS);
};

/** A reader that records every call and answers with the given functions (neutral by default). */
const recordingReader = (
  answers: Partial<{ speedFactorAt: (cell: Readonly<Cell>) => number; isSevereAt: (cell: Readonly<Cell>) => boolean; strength: number }> = {},
): GuestCrowdReader & { entries: Cell[]; factorCells: Cell[]; severeCells: Cell[] } => {
  const entries: Cell[] = [];
  const factorCells: Cell[] = [];
  const severeCells: Cell[] = [];
  return {
    entries,
    factorCells,
    severeCells,
    strength: answers.strength,
    noteEntry: (cell) => { entries.push({ x: cell.x, y: cell.y }); },
    speedFactorAt: (cell) => { factorCells.push({ x: cell.x, y: cell.y }); return answers.speedFactorAt?.(cell) ?? 1; },
    isSevereAt: (cell) => { severeCells.push({ x: cell.x, y: cell.y }); return answers.isSevereAt?.(cell) ?? false; },
  };
};

/** Guests walking a route right now. */
const walkers = (session: ParkSession): Guest[] => [...session.guests.guests.values()]
  .filter((guest) => WALK_STATES.has(guest.state) && guest.routeIndex < guest.route.length);

/** One guest wandering a route with its 1 s need update due on the next tick; needs low so no need thought wins. */
const placedWalker = (session: ParkSession, state: GuestState = 'wandering'): Guest => {
  session.guests.spawnGuests(1);
  const guest = [...session.guests.guests.values()][0];
  Object.assign(guest, {
    state,
    route: [{ x: 15, y: 30 }, { x: 15, y: 29 }, { x: 15, y: 28 }, { x: 15, y: 27 }],
    routeIndex: 1,
    routeVersion: session.world.pathVersion,
    position: { x: 15, y: 30 },
    currentCell: { x: 15, y: 30 },
    stateTimerSeconds: 10,
    needTimerSeconds: GAME_CONFIG.guests.needUpdateSeconds - STEP_MS / 1000,
    happiness: 50,
    hunger: 10,
    thirst: 10,
    toiletNeed: 10,
    energy: 90,
    currentThought: 'Taking a look around.',
    destinationObjectId: null,
  });
  return guest;
};

describe('GuestSimulation crowd reader: entries', () => {
  it('a session wires its CrowdSimulation; a standalone simulation starts with the neutral reader', () => {
    const session = createPark();
    expect((session.guests as unknown as { crowd: CrowdFlowReader }).crowd).toBe(session.crowd);
    session.guests.setCrowd(NEUTRAL_CROWD_READER);
    expect((session.guests as unknown as { crowd: CrowdFlowReader }).crowd).toBe(NEUTRAL_CROWD_READER);
  });

  it('guests that just arrived at the gate (entering) add nothing', () => {
    const session = createPark();
    const reader = recordingReader();
    session.guests.setCrowd(reader);
    session.guests.spawnGuests(20);
    run(session, 5);
    expect([...session.guests.guests.values()].every((guest) => guest.state === 'entering')).toBe(true);
    expect(reader.entries).toEqual([]);
  });

  it('each entry is a walking guest stepping onto its next route tile, at most one per walker per tick', () => {
    const session = createPark();
    session.guests.spawnGuests(25);
    run(session, 120);
    const reader = recordingReader();
    session.guests.setCrowd(reader);
    let total = 0;
    let stepped = 0;
    for (let tick = 0; tick < 300; tick += 1) {
      const before = new Map(walkers(session).map((guest) => [guest.id, { route: guest.route, index: guest.routeIndex }]));
      const first = reader.entries.length;
      const targets = new Set(walkers(session).map((guest) => `${guest.route[guest.routeIndex].x},${guest.route[guest.routeIndex].y}`));
      session.step(STEP_MS);
      const noted = reader.entries.slice(first);
      // Every entry is the tile some walker was heading for when the tick began.
      for (const cell of noted) expect(targets.has(`${cell.x},${cell.y}`), `entry at ${cell.x},${cell.y}`).toBe(true);
      expect(noted.length).toBeLessThanOrEqual(before.size);
      // Walkers still on the same route advanced exactly once per entry.
      let advanced = 0;
      for (const [id, entry] of before) {
        const guest = session.guests.guests.get(id);
        if (guest && guest.route === entry.route) advanced += guest.routeIndex - entry.index;
      }
      expect(noted.length).toBeGreaterThanOrEqual(advanced);
      total += noted.length;
      stepped += advanced;
    }
    expect(total).toBeGreaterThan(50);
    expect(stepped).toBeGreaterThan(0);
  });

  it('feeds the session field: a walked tile gains flow, a tile nobody walks stays at 0', () => {
    const session = createPark();
    session.guests.spawnGuests(25);
    run(session, 400);
    const field = session.crowd.field();
    expect(session.crowd.perMinuteAt({ x: 15, y: 29 })).toBeGreaterThan(0);
    expect(session.crowd.perMinuteAt({ x: 2, y: 2 })).toBe(0);
    expect(field.some((value) => value > 0)).toBe(true);
  });
});

describe('GuestSimulation crowd reader: the walking-speed factor', () => {
  it('is read for the tile being stepped onto, for walking guests only', () => {
    const session = createPark();
    session.guests.spawnGuests(25);
    run(session, 120);
    const reader = recordingReader();
    session.guests.setCrowd(reader);
    for (let tick = 0; tick < 50; tick += 1) {
      const targets = new Set(walkers(session).map((guest) => `${guest.route[guest.routeIndex].x},${guest.route[guest.routeIndex].y}`));
      const first = reader.factorCells.length;
      session.step(STEP_MS);
      for (const cell of reader.factorCells.slice(first)) expect(targets.has(`${cell.x},${cell.y}`)).toBe(true);
    }
    expect(reader.factorCells.length).toBeGreaterThan(0);
  });

  it('multiplies the movement: at factor 0.5 a walker needs twice the ticks for the same tiles', () => {
    const ticksToWalk = (factor: number): number => {
      const session = createPark();
      session.guests.setCrowd(recordingReader({ speedFactorAt: () => factor }));
      const guest = placedWalker(session);
      guest.needTimerSeconds = -1_000;
      let ticks = 0;
      while (guest.routeIndex < guest.route.length && ticks < 1_000) {
        session.step(STEP_MS);
        ticks += 1;
      }
      return ticks;
    };
    const normal = ticksToWalk(1);
    const slowed = ticksToWalk(0.5);
    // Each of the 3 tiles takes ceil(1 / movement) ticks (a step snaps onto the tile once within one movement):
    // 3 x 6 = 18 at 1.85 tiles a second, 3 x 11 = 33 at half speed.
    const perTile = (speed: number): number => Math.ceil(1 / (speed * GAME_CONFIG.guests.walkingCellsPerSecond * STEP_MS / 1000));
    expect(normal).toBe(3 * perTile(1));
    expect(slowed).toBe(3 * perTile(0.5));
  });

  it('a factor of exactly 1 is bit-identical to the neutral reader (the IEEE multiply by 1)', () => {
    const neutral = createPark(rulesWithoutFeedback());
    const ones = createPark(rulesWithoutFeedback());
    neutral.guests.setCrowd(NEUTRAL_CROWD_READER);
    ones.guests.setCrowd(recordingReader({ speedFactorAt: () => 1 }));
    for (const session of [neutral, ones]) {
      session.guests.spawnGuests(25);
      run(session, 600);
    }
    expect(hashState(ones.guests.serialize())).toBe(hashState(neutral.guests.serialize()));
  });
});

describe('GuestSimulation crowd reader: severe tiles', () => {
  const oneNeedUpdate = (reader: GuestCrowdReader, state: GuestState = 'wandering'): Guest => {
    const session = createPark();
    session.guests.setCrowd(reader);
    const guest = placedWalker(session, state);
    session.step(STEP_MS);
    return guest;
  };

  it('a moving guest on a severe tile loses severeHappinessPerSecond x strength per second and thinks it is crowded', () => {
    const calm = oneNeedUpdate(recordingReader());
    const jammed = oneNeedUpdate(recordingReader({ isSevereAt: () => true, strength: 1 }));
    const half = oneNeedUpdate(recordingReader({ isSevereAt: () => true, strength: 0.5 }));
    const seconds = GAME_CONFIG.guests.needUpdateSeconds;
    expect(calm.happiness - jammed.happiness).toBeCloseTo(GAME_CONFIG.crowd.severeHappinessPerSecond * seconds, 10);
    expect(calm.happiness - half.happiness).toBeCloseTo(0.5 * GAME_CONFIG.crowd.severeHappinessPerSecond * seconds, 10);
    expect(jammed.currentThought).toBe(CROWDED_THOUGHT);
    expect(calm.currentThought).not.toBe(CROWDED_THOUGHT);
  });

  it('a need thought wins over the crowd thought (cascade: after the need thoughts, before the scenery)', () => {
    const session = createPark();
    session.guests.setCrowd(recordingReader({ isSevereAt: () => true, strength: 1 }));
    const guest = placedWalker(session);
    guest.thirst = 90;
    session.step(STEP_MS);
    expect(guest.currentThought).toBe('I could use a drink.');
  });

  it('a guest walking to a ride loses happiness but keeps its "Heading for" thought (the cascade is for wanderers)', () => {
    const calm = oneNeedUpdate(recordingReader(), 'walkingToRide');
    const jammed = oneNeedUpdate(recordingReader({ isSevereAt: () => true, strength: 1 }), 'walkingToRide');
    expect(jammed.happiness).toBeLessThan(calm.happiness);
    expect(jammed.currentThought).toBe(calm.currentThought);
  });

  it('a guest that is not moving (queueing, or at the end of its route) is never asked and loses nothing', () => {
    const reader = recordingReader({ isSevereAt: () => true, strength: 1 });
    const session = createPark();
    session.guests.setCrowd(reader);
    const guest = placedWalker(session);
    guest.routeIndex = guest.route.length;
    guest.stateTimerSeconds = 0;
    session.step(STEP_MS);
    expect(reader.severeCells).toEqual([]);
    expect(guest.currentThought).not.toBe(CROWDED_THOUGHT);
  });

  it('the insight text summarises the crowd thought for Park Pulse', () => {
    const session = createPark();
    session.guests.spawnGuests(3);
    for (const guest of session.guests.guests.values()) guest.currentThought = CROWDED_THOUGHT;
    expect(session.guests.thoughtInsights()).toEqual([{ text: 'guests find the paths too crowded', count: 3, objectId: null, objectName: null }]);
  });
});

describe('GuestSimulation crowd reader: bit-identity', () => {
  it('a rule-off session (display-only field) plays exactly like the neutral reader', () => {
    const wired = createPark(rulesWithoutFeedback());
    const neutral = createPark(rulesWithoutFeedback());
    expect(wired.crowd.feedback).toBe(false);
    neutral.guests.setCrowd(NEUTRAL_CROWD_READER);
    for (const session of [wired, neutral]) {
      session.guests.spawnGuests(40);
      run(session, 800);
    }
    expect(wired.crowd.field().some((value) => value > 0), 'the display field still runs').toBe(true);
    expect(hashState(wired.guests.serialize())).toBe(hashState(neutral.guests.serialize()));
  });

  it('a feedback park that never reaches load 1 plays exactly like a park without the rule', () => {
    const on = createPark();
    const off = createPark(rulesWithoutFeedback());
    expect(on.crowd.feedback).toBe(true);
    let peak = 0;
    for (const session of [on, off]) session.guests.spawnGuests(6);
    for (let tick = 0; tick < 800; tick += 1) {
      on.step(STEP_MS);
      off.step(STEP_MS);
      for (const index of on.crowd.shape().cells) peak = Math.max(peak, on.crowd.perLaneAt({ x: index % on.world.width, y: Math.floor(index / on.world.width) }));
    }
    expect(peak, 'the park stays below the threshold').toBeLessThan(GAME_CONFIG.crowd.laneCapacityPerMinute);
    expect(peak).toBeGreaterThan(0);
    expect(hashState(on.guests.serialize())).toBe(hashState(off.guests.serialize()));
    expect(on.world.cash).toBe(off.world.cash);
  });
});
