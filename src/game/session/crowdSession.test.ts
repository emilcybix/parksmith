import { describe, expect, it, vi } from 'vitest';
import { GAME_CONFIG } from '../config';
import { CrowdSimulation } from '../crowd/CrowdSimulation';
import { bandOf, flowPerMinute, perLaneOf } from '../crowd/bands';
import type { CrowdHeatmapView } from '../crowd/types';
import { hashState } from '../save/hash';
import { SaveError } from '../save/version';
import type { ParkSaveV13 } from '../save/state';
import { compileParkRules, type ParkRuleset } from '../scenarios/rules';
import { SCENARIO_BY_ID } from '../scenarios/content';
import { testStageSession } from '../run/testSupport';
import { ParkSession } from './ParkSession';
import { seedDevPark } from './devPark';

/**
 * Phase 14 Wave 2: the crowd owner of a session (design sections 4-6). Every park runs the field; a park whose ruleset
 * has `crowdFeedback` (every new park) feeds it back and saves it as `crowd`, right after `guests`; a park without the
 * rule (every save before Phase 14) keeps it display only and out of the save. `crowdView`, `crowdHeatmap` and
 * `crowdHoverAt` are pure reads with presentation memory (band hysteresis, heatmap revision) that never feeds back.
 */

const STEP_MS = 100;

const run = (session: ParkSession, ticks: number): void => {
  for (let tick = 0; tick < ticks; tick += 1) session.step(STEP_MS);
};

const rulesWithoutFeedback = (): ParkRuleset => {
  const rules: ParkRuleset = { ...compileParkRules() };
  delete rules.crowdFeedback;
  return Object.freeze(rules);
};

const saved = (session: ParkSession): ParkSaveV13 => {
  session.syncWithWorld();
  return JSON.parse(JSON.stringify(session.serialize())) as ParkSaveV13;
};

const codeOf = (action: () => unknown): string | null => {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(SaveError);
    return (error as SaveError).code;
  }
  return null;
};

/** The dev park held busy: enough walkers on the avenue for busy and severe tiles. */
const crowdedDevPark = (guests = 600, ticks = 500): ParkSession => {
  const session = new ParkSession(null);
  seedDevPark(session);
  session.syncWithWorld();
  session.guests.spawnGuests(guests);
  run(session, ticks);
  return session;
};

/** Built once (the dev park at 600 guests is the costly fixture); tests that change it build their own. */
let shared: ParkSession | null = null;
const sharedCrowdedPark = (): ParkSession => {
  shared ??= crowdedDevPark();
  return shared;
};

describe('the crowd owner of a session', () => {
  it('every new park in every mode compiles feedback 1 and runs a feedback field', () => {
    const parks = [new ParkSession(null), new ParkSession(SCENARIO_BY_ID.get('sunny-start')!), testStageSession().session];
    for (const park of parks) {
      expect(park.rules.crowdFeedback, park.mode).toBe(GAME_CONFIG.crowd.feedback);
      expect(park.crowd).toBeInstanceOf(CrowdSimulation);
      expect(park.crowd.strength, park.mode).toBe(1);
      expect(park.crowd.feedback).toBe(true);
      expect([park.crowd.width, park.crowd.height]).toEqual([park.world.width, park.world.height]);
    }
  });

  it('a park without the rule (a pre-Phase-14 save) has a display-only field', () => {
    const session = new ParkSession(null, [], { rules: rulesWithoutFeedback() });
    expect(session.rules.crowdFeedback).toBeUndefined();
    expect(session.crowd.strength).toBe(0);
    expect(session.crowd.feedback).toBe(false);
  });

  it('decays once per step, after the weather and before the guests walk', () => {
    const session = new ParkSession(null);
    const order: string[] = [];
    const weather = vi.spyOn(session.weather, 'step').mockImplementation(() => { order.push('weather'); });
    const decay = vi.spyOn(session.crowd, 'beginTick').mockImplementation(() => { order.push('crowd'); });
    const guests = vi.spyOn(session.guests, 'step').mockImplementation(() => { order.push('guests'); });
    session.step(STEP_MS);
    session.step(STEP_MS);
    expect(order).toEqual(['weather', 'crowd', 'guests', 'weather', 'crowd', 'guests']);
    for (const spy of [weather, decay, guests]) spy.mockRestore();
  });

  it('the field decays by ceil(p / decayDivisor) a tick and stands still while paused (no steps)', () => {
    const session = new ParkSession(null);
    session.crowd.noteEntry({ x: 15, y: 30 });
    const index = 30 * session.world.width + 15;
    const before = session.crowd.pressureAt(index);
    expect(before).toBe(GAME_CONFIG.crowd.entryUnits);
    session.step(STEP_MS);
    expect(session.crowd.pressureAt(index)).toBe(before - Math.ceil(before / GAME_CONFIG.crowd.decayDivisor));
    const held = session.crowd.pressureAt(index);
    session.crowdView();
    session.crowdHeatmap();
    expect(session.crowd.pressureAt(index)).toBe(held);
  });
});

describe('saving the crowd (schema 13)', () => {
  it('a feedback park writes `crowd` right after `guests` and `crowdFeedback` as the last rule key', () => {
    const session = sharedCrowdedPark();
    const state = saved(session);
    const keys = Object.keys(state);
    expect(keys.indexOf('crowd')).toBe(keys.indexOf('guests') + 1);
    // Phase 40's `frontAccess` is the last key when compiled; crowdFeedback ends the rest.
    expect(Object.keys(state.rules).filter((key) => key !== 'frontAccess').at(-1)).toBe('crowdFeedback');
    expect(state.rules.crowdFeedback).toBe(1);
    expect(state.crowd).toEqual(session.crowd.serialize());
    expect(state.crowd!.pressure.length).toBeGreaterThan(20);
  });

  it('a park without the rule writes neither the key nor the field (byte-identical to schema 12)', () => {
    const session = new ParkSession(null, [], { rules: rulesWithoutFeedback() });
    seedDevPark(session);
    session.guests.spawnGuests(100);
    run(session, 200);
    expect(session.crowd.field().some((value) => value > 0)).toBe(true);
    const state = saved(session);
    expect('crowd' in state).toBe(false);
    expect('crowdFeedback' in state.rules).toBe(false);
  });

  it('round-trips: the restored field, ruleset and continuation are identical', () => {
    const session = crowdedDevPark(300, 300);
    const state = saved(session);
    const restored = ParkSession.fromState(structuredClone(state));
    expect(restored.crowd.strength).toBe(1);
    expect([...restored.crowd.field()]).toEqual([...session.crowd.field()]);
    expect(hashState(saved(restored))).toBe(hashState(state));
    run(session, 150);
    run(restored, 150);
    expect(hashState(saved(restored))).toBe(hashState(saved(session)));
  });

  it('a rule-off park loads with an empty field and continues exactly like the never-saved park', () => {
    const session = new ParkSession(null, [], { rules: rulesWithoutFeedback() });
    seedDevPark(session);
    session.guests.spawnGuests(300);
    run(session, 300);
    const restored = ParkSession.fromState(saved(session));
    expect(restored.crowd.field().every((value) => value === 0)).toBe(true);
    run(session, 150);
    run(restored, 150);
    expect(hashState(saved(restored))).toBe(hashState(saved(session)));
  });

  it('the ruleset key: absent = off, an explicit 0 is dropped, (0, maximumFeedback] kept, anything else refused', () => {
    const base = saved(new ParkSession(null, [], { rules: rulesWithoutFeedback() }));
    const zero = structuredClone(base);
    zero.rules.crowdFeedback = 0;
    const loaded = ParkSession.fromState(zero);
    expect('crowdFeedback' in loaded.rules).toBe(false);
    expect(loaded.crowd.feedback).toBe(false);
    expect('crowdFeedback' in saved(loaded).rules).toBe(false);
    const half = structuredClone(base);
    half.rules.crowdFeedback = 0.5;
    half.crowd = { version: 1, pressure: [[5, 2048]] };
    const halfPark = ParkSession.fromState(half);
    expect(halfPark.crowd.strength).toBe(0.5);
    expect(halfPark.crowd.pressureAt(5)).toBe(2048);
    for (const bad of [-0.1, 1.01, Number.NaN, '1', null]) {
      const state = structuredClone(base);
      (state.rules as unknown as Record<string, unknown>).crowdFeedback = bad;
      state.crowd = { version: 1, pressure: [] };
      expect(codeOf(() => ParkSession.fromState(state)), String(bad)).toBe('invalid-state');
    }
  });

  it('the presence law: a feedback park without `crowd`, or `crowd` without the rule, is refused (fromState and in place)', () => {
    const feedback = new ParkSession(null);
    const withRule = saved(feedback);
    const missing = structuredClone(withRule);
    delete missing.crowd;
    expect(codeOf(() => ParkSession.fromState(structuredClone(missing)))).toBe('invalid-state');
    expect(codeOf(() => feedback.restoreState(structuredClone(missing)))).toBe('invalid-state');

    const plain = new ParkSession(null, [], { rules: rulesWithoutFeedback() });
    const extra = saved(plain);
    extra.crowd = { version: 1, pressure: [] };
    expect(codeOf(() => ParkSession.fromState(structuredClone(extra)))).toBe('invalid-state');
    expect(codeOf(() => plain.restoreState(structuredClone(extra)))).toBe('invalid-state');

    const outside = structuredClone(withRule);
    outside.crowd = { version: 1, pressure: [[32 * 32, 1]] };
    expect(codeOf(() => ParkSession.fromState(outside))).toBe('invalid-state');
  });

  it('an in-place restore rewinds the field and drops the derived caches (neighborhoods, shape, view)', () => {
    const session = crowdedDevPark(200, 200);
    const state = saved(session);
    const viewAtSave = JSON.stringify(session.crowdView());
    // Edit the network and run on, then rewind in place.
    session.world.buildPaths([{ x: 2, y: 2 }, { x: 3, y: 2 }]);
    session.syncWithWorld();
    run(session, 50);
    expect(JSON.stringify(session.crowdView())).not.toBe(viewAtSave);
    session.restoreState(structuredClone(state));
    expect(session.crowd.serialize()).toEqual(state.crowd);
    const fresh = ParkSession.fromState(structuredClone(state));
    // The derived list matches a fresh load (the displayed bands may keep their hysteresis memory: presentation only).
    const identity = (view: ReturnType<ParkSession['crowdView']>): unknown => view.neighborhoods.map((neighborhood) => ({
      key: neighborhood.key, name: neighborhood.name, tiles: neighborhood.tileCount, rides: neighborhood.rideIds,
      members: neighborhood.memberIds, focus: neighborhood.focus, guests: neighborhood.metrics.guests,
    }));
    expect(identity(session.crowdView())).toEqual(identity(fresh.crowdView()));
    expect(session.crowd.shape().cells).toEqual(fresh.crowd.shape().cells);
  });
});

describe('crowdView (design Q4)', () => {
  it('names the dev park neighborhoods and counts walkers by neighborhood', () => {
    const session = sharedCrowdedPark();
    const view = session.crowdView();
    expect(view.tick).toBe(session.world.tick);
    expect(view.feedback).toBe(true);
    expect(view.neighborhoods.length, 'four ride clusters and the gate').toBe(5);
    expect(view.neighborhoods[0].key).toBe(0);
    const keys = view.neighborhoods.map((neighborhood) => neighborhood.key);
    expect(Object.keys(view.walkingByKey!).map(Number).sort((a, b) => a - b)).toEqual([...keys].sort((a, b) => a - b));
    const walkingInHoods = Object.values(view.walkingByKey!).reduce((sum, count) => sum + count, 0);
    expect(walkingInHoods).toBeGreaterThan(0);
    expect(walkingInHoods).toBeLessThanOrEqual(view.walking);
    expect(view.unreached).toBe(0);
    expect(view.openServices!.food).toBeGreaterThan(0);
    expect(view.openServices!.drink).toBeGreaterThan(0);
    expect(view.openServices!.toilet).toBeGreaterThan(0);
    for (const neighborhood of view.neighborhoods) {
      expect(neighborhood.metrics.bands.reduce((sum, count) => sum + count, 0)).toBe(neighborhood.tileCount);
    }
  });

  it('shows busy and severe tiles in the crowded dev park, and bottlenecks are severe tiles with a structural cause', () => {
    const session = sharedCrowdedPark();
    const view = session.crowdView();
    const bands = [0, 0, 0, 0];
    for (const neighborhood of view.neighborhoods) neighborhood.metrics.bands.forEach((count, band) => { bands[band] += count; });
    expect(bands[2] + bands[3], 'busy or severe tiles').toBeGreaterThan(0);
    expect(bands[3], 'severe tiles').toBeGreaterThan(0);
    const shape = session.crowd.shape();
    for (const tile of view.bottlenecks) {
      const index = tile.cell.y * session.world.width + tile.cell.x;
      expect(tile.band).toBe(3);
      expect(shape.laneWidth[index] === 1 || shape.articulation[index] === 1).toBe(true);
    }
  });

  it('is memoised per tick and world version, and is a pure read (a viewed park continues like an unviewed twin)', () => {
    const viewed = crowdedDevPark(300, 200);
    const twin = crowdedDevPark(300, 200);
    const first = viewed.crowdView();
    expect(viewed.crowdView()).toBe(first);
    let previous: Readonly<CrowdHeatmapView> | null = null;
    for (let tick = 0; tick < 200; tick += 1) {
      viewed.step(STEP_MS);
      twin.step(STEP_MS);
      if (tick % 10 === 0) {
        viewed.crowdView();
        previous = viewed.crowdHeatmap(previous);
        viewed.crowdHoverAt({ x: 15, y: 26 });
      }
    }
    expect(viewed.crowdView()).not.toBe(first);
    expect(hashState(saved(viewed))).toBe(hashState(saved(twin)));
  });

  it('a rule-off park still shows its crowd (feedback false) and the empty park has no neighborhoods', () => {
    const empty = new ParkSession(null).crowdView();
    expect(empty.neighborhoods).toEqual([]);
    expect(empty.walking).toBe(0);
    const session = new ParkSession(null, [], { rules: rulesWithoutFeedback() });
    seedDevPark(session);
    session.guests.spawnGuests(300);
    run(session, 300);
    const view = session.crowdView();
    expect(view.feedback).toBe(false);
    expect(view.neighborhoods.length).toBe(5);
    expect(view.neighborhoods.some((neighborhood) => neighborhood.worst !== null)).toBe(true);
  });
});

describe('crowdHeatmap and crowdHoverAt', () => {
  it('lists every path tile with its displayed band; the same object while nothing displayed changes', () => {
    const session = sharedCrowdedPark();
    const view = session.crowdHeatmap();
    const shape = session.crowd.shape();
    expect(view.cells.length).toBe(shape.cells.length);
    expect(view.bands.length).toBe(view.cells.length);
    view.cells.forEach((cell, index) => expect(cell.y * session.world.width + cell.x).toBe(shape.cells[index]));
    expect(new Set(view.bands).size, 'several bands drawn').toBeGreaterThan(2);
    expect(session.crowdHeatmap(view)).toBe(view);
    expect(session.crowdHeatmap(null)).toBe(view);
    expect(Object.isFrozen(view)).toBe(true);
  });

  it('a band change moves the revision; revisions are never reused by another session', () => {
    const session = new ParkSession(null);
    seedDevPark(session);
    session.syncWithWorld();
    const first = session.crowdHeatmap();
    const other = new ParkSession(null).crowdHeatmap();
    expect(other.revision).not.toBe(first.revision);
    // Flood one avenue tile up to severe: its band rises at once.
    for (let entry = 0; entry < 800; entry += 1) session.crowd.noteEntry({ x: 15, y: 24 });
    session.step(STEP_MS);
    const second = session.crowdHeatmap(first);
    expect(second).not.toBe(first);
    expect(second.revision).toBeGreaterThan(first.revision);
    const index = second.cells.findIndex((cell) => cell.x === 15 && cell.y === 24);
    const perLane = perLaneOf(flowPerMinute(session.crowd.pressureAt(24 * session.world.width + 15)), session.crowd.shape().laneWidth[24 * session.world.width + 15]);
    expect(second.bands[index]).toBe(bandOf(perLane));
  });

  it('holds a band while the flow sits just under its edge (display hysteresis), and drops it below 85 %', () => {
    const session = new ParkSession(null);
    seedDevPark(session);
    session.syncWithWorld();
    const cell = { x: 15, y: 24 };
    const index = cell.y * session.world.width + cell.x;
    const laneWidth = session.crowd.shape().laneWidth[index];
    // Pressure for a given per-lane flow: p = perLane x laneWidth x entryUnits x decayDivisor / ticksPerMinute.
    const pressureFor = (perLane: number): number => Math.ceil(perLane * laneWidth * GAME_CONFIG.crowd.entryUnits * GAME_CONFIG.crowd.decayDivisor / 600);
    const busyEdge = GAME_CONFIG.crowd.bands.busy;
    const setPressure = (value: number): void => session.crowd.restore({ version: 1, pressure: [[index, value]] });
    const bandNow = (): number => {
      session.world.advanceTick();
      const view = session.crowdHeatmap();
      return view.bands[view.cells.findIndex((entry) => entry.x === cell.x && entry.y === cell.y)];
    };
    setPressure(pressureFor(busyEdge + 1));
    expect(bandNow()).toBe(2);
    setPressure(pressureFor(busyEdge * 0.9));
    expect(bandNow(), 'just under the busy edge: still busy').toBe(2);
    setPressure(pressureFor(busyEdge * 0.8));
    expect(bandNow(), 'below 85 % of the edge: normal').toBe(1);
  });

  it('hover: a path tile gives its band, flow and neighborhood name; off the network nothing', () => {
    const session = sharedCrowdedPark();
    const hover = session.crowdHoverAt({ x: 15, y: 26 });
    expect(hover).not.toBeNull();
    expect(hover!.perMinute).toBeGreaterThan(0);
    expect(hover!.neighborhoodName).toEqual(expect.any(String));
    expect(session.crowdHoverAt({ x: 0, y: 0 })).toBeNull();
    expect(session.crowdHoverAt({ x: -1, y: 5 })).toBeNull();
    expect(session.crowdHoverAt({ x: 99, y: 5 })).toBeNull();
  });
});
