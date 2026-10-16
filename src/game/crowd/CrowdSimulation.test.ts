import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { SaveError } from '../save/version';
import { CrowdSimulation, NEUTRAL_CROWD_READER } from './CrowdSimulation';
import { bandOf, crowdSpeedFactor, flowPerMinute, loadOf, perLaneOf } from './bands';
import type { PathSource } from './pathShape';
import type { CrowdState } from './types';

/** An 8x8 map with one straight corridor along y = 3 (every tile lane width 1). */
const corridor = (): PathSource => ({
  width: 8,
  height: 8,
  paths: new Set(Array.from({ length: 8 }, (_, x) => `${x},3`)),
  pathVersion: 1,
});

const ENTRY = GAME_CONFIG.crowd.entryUnits;
const DIVISOR = GAME_CONFIG.crowd.decayDivisor;
const CAPACITY = GAME_CONFIG.crowd.laneCapacityPerMinute;
const SEVERE = GAME_CONFIG.crowd.bands.severe;
/** The pressure that reads as `perMinute` guests a minute (exact for the values used below). */
const pressureFor = (perMinute: number): number => Math.round((perMinute * ENTRY * DIVISOR) / 600);

const withPressure = (crowd: CrowdSimulation, cell: { x: number; y: number }, value: number): void => {
  crowd.restore({ version: 1, pressure: [[cell.y * crowd.width + cell.x, value]] });
};

const refusal = (run: () => void): SaveError => {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(SaveError);
    return error as SaveError;
  }
  throw new Error('expected a SaveError');
};

describe('CrowdSimulation: the integer pressure field', () => {
  it('uses the designed constants (1024 a step, ceil(p / 320) a tick)', () => {
    expect([ENTRY, DIVISOR]).toEqual([1024, 320]);
    expect(pressureFor(30)).toBe(16_384);
    expect(pressureFor(45)).toBe(24_576);
  });

  it('an entry adds exactly entryUnits; off-map entries are ignored', () => {
    const crowd = new CrowdSimulation(corridor());
    crowd.noteEntry({ x: 2, y: 3 });
    crowd.noteEntry({ x: 2, y: 3 });
    crowd.noteEntry({ x: -1, y: 3 });
    crowd.noteEntry({ x: 8, y: 3 });
    crowd.noteEntry({ x: 1.5, y: 3 });
    expect(crowd.serialize()).toEqual({ version: 1, pressure: [[3 * 8 + 2, 2 * ENTRY]] });
  });

  it('decays by exactly ceil(p / 320) a tick, reaches exactly 0 and stays there', () => {
    const crowd = new CrowdSimulation(corridor());
    crowd.noteEntry({ x: 0, y: 3 });
    const index = 3 * 8;
    const values: number[] = [crowd.pressureAt(index)];
    for (let tick = 0; tick < 3; tick += 1) {
      crowd.beginTick();
      values.push(crowd.pressureAt(index));
    }
    expect(values).toEqual([1024, 1020, 1016, 1012]);
    let reference = 1012;
    let ticks = 3;
    while (crowd.pressureAt(index) > 0) {
      crowd.beginTick();
      reference -= Math.ceil(reference / DIVISOR);
      ticks += 1;
      expect(crowd.pressureAt(index)).toBe(reference);
      expect(ticks).toBeLessThan(2_000);
    }
    // Below 320 every tick removes exactly 1: the tail ends at 0, never a fraction.
    expect(crowd.pressureAt(index)).toBe(0);
    crowd.beginTick();
    expect(crowd.serialize().pressure).toEqual([]);
  });

  it('has no decay without steps (a paused park keeps its field)', () => {
    const crowd = new CrowdSimulation(corridor());
    crowd.noteEntry({ x: 4, y: 3 });
    const before = crowd.serialize();
    for (let read = 0; read < 10; read += 1) {
      crowd.speedFactorAt({ x: 4, y: 3 });
      crowd.isSevereAt({ x: 4, y: 3 });
      crowd.perMinuteAt({ x: 4, y: 3 });
    }
    expect(crowd.serialize()).toEqual(before);
  });

  it('one entry a tick settles at about 600 guests a minute (the unit of the bands)', () => {
    const crowd = new CrowdSimulation(corridor());
    for (let tick = 0; tick < 6_000; tick += 1) {
      crowd.beginTick();
      crowd.noteEntry({ x: 5, y: 3 });
    }
    const flow = crowd.perMinuteAt({ x: 5, y: 3 });
    expect(flow).toBeGreaterThan(598);
    expect(flow).toBeLessThanOrEqual(601.9);
  });

  it('clamps at 2^31 - 1', () => {
    const crowd = new CrowdSimulation(corridor());
    withPressure(crowd, { x: 1, y: 3 }, 2 ** 31 - 100);
    crowd.noteEntry({ x: 1, y: 3 });
    expect(crowd.pressureAt(3 * 8 + 1)).toBe(2 ** 31 - 1);
  });
});

describe('CrowdSimulation: feedback', () => {
  it('off (strength 0): the factor is the literal 1 and nothing is ever severe, at any pressure', () => {
    const crowd = new CrowdSimulation(corridor());
    expect(crowd.feedback).toBe(false);
    withPressure(crowd, { x: 3, y: 3 }, pressureFor(600));
    expect(crowd.perLaneAt({ x: 3, y: 3 })).toBe(600);
    expect(Object.is(crowd.speedFactorAt({ x: 3, y: 3 }), 1)).toBe(true);
    expect(crowd.isSevereAt({ x: 3, y: 3 })).toBe(false);
  });

  it('on: 1 up to load 1 (400 a minute per lane), 0.8 at load 1.5, the floor 0.6 from load 2; scaled by strength', () => {
    expect([CAPACITY, SEVERE], 'the calibrated thresholds (Phase 14 calibration pass)').toEqual([400, 450]);
    const crowd = new CrowdSimulation(corridor(), 1);
    const at = (perMinute: number): number => {
      withPressure(crowd, { x: 3, y: 3 }, pressureFor(perMinute));
      return crowd.speedFactorAt({ x: 3, y: 3 });
    };
    expect(Object.is(at(100), 1)).toBe(true);
    expect(Object.is(at(400), 1)).toBe(true);
    expect(at(600)).toBeCloseTo(0.8, 12);
    expect(at(800)).toBeCloseTo(0.6, 12);
    expect(at(4000)).toBeCloseTo(0.6, 12);
    crowd.setStrength(0.5);
    expect(at(800)).toBeCloseTo(0.8, 12);
    expect(Object.is(at(400), 1)).toBe(true);
    // Off the path network and off the map: neutral.
    expect(Object.is(crowd.speedFactorAt({ x: 3, y: 0 }), 1)).toBe(true);
    expect(Object.is(crowd.speedFactorAt({ x: -3, y: 0 }), 1)).toBe(true);
  });

  it('severe from 450 a minute per lane (no hysteresis), feedback on only', () => {
    const crowd = new CrowdSimulation(corridor(), 1);
    withPressure(crowd, { x: 3, y: 3 }, pressureFor(SEVERE) - 1);
    expect(crowd.isSevereAt({ x: 3, y: 3 })).toBe(false);
    withPressure(crowd, { x: 3, y: 3 }, pressureFor(SEVERE));
    expect(crowd.isSevereAt({ x: 3, y: 3 })).toBe(true);
    expect(crowd.isSevereAt({ x: 4, y: 3 })).toBe(false);
    crowd.setStrength(0);
    expect(crowd.isSevereAt({ x: 3, y: 3 })).toBe(false);
  });

  it('a wider lane takes more flow: a 2-wide street is severe only at 900 a minute', () => {
    const street: PathSource = {
      width: 8,
      height: 8,
      paths: new Set(Array.from({ length: 16 }, (_, index) => `${index % 8},${3 + Math.floor(index / 8)}`)),
      pathVersion: 1,
    };
    const crowd = new CrowdSimulation(street, 1);
    expect(crowd.shape().laneWidth[3 * 8 + 4]).toBe(2);
    // Just under 800 a minute (400 a lane, load 1): neutral.
    withPressure(crowd, { x: 4, y: 3 }, pressureFor(800) - 1);
    expect(Object.is(crowd.speedFactorAt({ x: 4, y: 3 }), 1)).toBe(true);
    expect(crowd.isSevereAt({ x: 4, y: 3 })).toBe(false);
    withPressure(crowd, { x: 4, y: 3 }, pressureFor(900));
    expect(crowd.isSevereAt({ x: 4, y: 3 })).toBe(true);
    expect(crowd.speedFactorAt({ x: 4, y: 3 })).toBeCloseTo(0.95, 12);
  });

  it('the early-outs agree exactly with the full formula around the load-1 and severe edges, on every lane width', () => {
    const plaza: PathSource = { width: 8, height: 8, paths: new Set<string>(), pathVersion: 1 };
    for (let x = 1; x <= 5; x += 1) for (let y = 1; y <= 5; y += 1) (plaza.paths as Set<string>).add(`${x},${y}`);
    const crowd = new CrowdSimulation(plaza, 1);
    const shape = crowd.shape();
    const cells = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 3 }];
    expect(cells.map((cell) => shape.laneWidth[cell.y * 8 + cell.x])).toEqual([4 / 3, 2, 3]);
    const { speedPenaltyPerLoad, minimumSpeedFactor } = GAME_CONFIG.crowd;
    for (const cell of cells) {
      const laneWidth = shape.laneWidth[cell.y * 8 + cell.x];
      // The pressures at the load-1 and severe edges, read from the config (not literals: they follow a re-tune).
      for (const base of [pressureFor(CAPACITY), pressureFor(SEVERE), pressureFor(CAPACITY) * laneWidth, pressureFor(SEVERE) * laneWidth]) {
        for (const delta of [-1, 0, 1]) {
          const value = Math.round(base) + delta;
          withPressure(crowd, cell, value);
          const perLane = (value * 600) / (ENTRY * DIVISOR) / laneWidth;
          const load = perLane / CAPACITY;
          const expected = load <= 1 ? 1 : 1 - Math.min(1 - minimumSpeedFactor, speedPenaltyPerLoad * (load - 1));
          expect(crowd.speedFactorAt(cell), `${value} on lane ${laneWidth}`).toBe(expected);
          expect(crowd.isSevereAt(cell), `${value} on lane ${laneWidth}`).toBe(perLane >= SEVERE);
          // Bit for bit the pure helpers of bands.ts (the simulation caches their operands).
          expect(crowd.speedFactorAt(cell)).toBe(crowdSpeedFactor(loadOf(flowPerMinute(value), laneWidth), 1));
          expect(crowd.isSevereAt(cell)).toBe(bandOf(perLaneOf(flowPerMinute(value), laneWidth)) === 3);
          for (const scale of [1.37, 2.9, 7.5]) {
            const bigger = Math.round(value * scale);
            withPressure(crowd, cell, bigger);
            expect(crowd.speedFactorAt(cell)).toBe(crowdSpeedFactor(loadOf(flowPerMinute(bigger), laneWidth), 1));
          }
        }
      }
    }
  });

  it('refuses a strength outside 0..maximumFeedback', () => {
    for (const bad of [-0.1, 1.01, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new CrowdSimulation(corridor(), bad), String(bad)).toThrow(RangeError);
    }
  });

  it('the neutral reader is a no-op with factor exactly 1', () => {
    NEUTRAL_CROWD_READER.noteEntry({ x: 0, y: 0 });
    expect(Object.is(NEUTRAL_CROWD_READER.speedFactorAt({ x: 0, y: 0 }), 1)).toBe(true);
    expect(NEUTRAL_CROWD_READER.isSevereAt({ x: 0, y: 0 })).toBe(false);
  });

  it('reads the path shape of the live world, recomputed when pathVersion moves or after invalidateShape()', () => {
    const world = { ...corridor(), paths: new Set(['3,3']) } as { width: number; height: number; paths: Set<string>; pathVersion: number };
    const crowd = new CrowdSimulation(world, 1);
    expect(crowd.shape().laneWidth[3 * 8 + 3]).toBe(1);
    for (let x = 2; x <= 4; x += 1) for (let y = 2; y <= 4; y += 1) world.paths.add(`${x},${y}`);
    expect(crowd.shape().laneWidth[3 * 8 + 3], 'same pathVersion: cached').toBe(1);
    world.pathVersion += 1;
    expect(crowd.shape().laneWidth[3 * 8 + 3]).toBe(3);
    world.paths.delete('2,2');
    crowd.invalidateShape();
    expect(crowd.shape().laneWidth[3 * 8 + 3]).toBeCloseTo(8 / 3, 12);
  });
});

describe('CrowdSimulation: serialize / restore', () => {
  it('serializes sparse ascending non-zero pairs and restores them exactly, replacing the old field', () => {
    const crowd = new CrowdSimulation(corridor(), 1);
    crowd.noteEntry({ x: 7, y: 3 });
    crowd.noteEntry({ x: 0, y: 3 });
    crowd.noteEntry({ x: 0, y: 3 });
    crowd.beginTick();
    const state = crowd.serialize();
    expect(state).toEqual({ version: 1, pressure: [[24, 2041], [31, 1020]] });
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
    const other = new CrowdSimulation(corridor(), 1);
    other.noteEntry({ x: 3, y: 3 });
    other.restore(structuredClone(state));
    expect(other.serialize()).toEqual(state);
    // Restore copies: mutating the input later changes nothing.
    const input: CrowdState = { version: 1, pressure: [[5, 9]] };
    other.restore(input);
    input.pressure[0][1] = 99;
    expect(other.pressureAt(5)).toBe(9);
    // Twins stay identical tick for tick.
    for (let tick = 0; tick < 50; tick += 1) {
      for (const sim of [crowd, other]) sim.beginTick();
    }
    other.restore(crowd.serialize());
    expect(other.serialize()).toEqual(crowd.serialize());
  });

  it('refuses a bad field before changing anything (invalid-state)', () => {
    const crowd = new CrowdSimulation(corridor());
    crowd.noteEntry({ x: 2, y: 3 });
    const before = crowd.serialize();
    const bad: unknown[] = [
      null,
      [],
      { version: 2, pressure: [] },
      { version: 1 },
      { version: 1, pressure: {} },
      { version: 1, pressure: [], extra: true },
      { version: 1, pressure: [[1]] },
      { version: 1, pressure: [[1, 2, 3]] },
      { version: 1, pressure: [[1, 0]] },
      { version: 1, pressure: [[1, -5]] },
      { version: 1, pressure: [[1, 1.5]] },
      { version: 1, pressure: [[1, 2 ** 31]] },
      { version: 1, pressure: [[1, '5']] },
      { version: 1, pressure: [[-1, 5]] },
      { version: 1, pressure: [[64, 5]] },
      { version: 1, pressure: [[2.5, 5]] },
      { version: 1, pressure: [[3, 5], [3, 5]] },
      { version: 1, pressure: [[4, 5], [3, 5]] },
    ];
    for (const state of bad) {
      expect(refusal(() => crowd.restore(state as CrowdState)).code, JSON.stringify(state)).toBe('invalid-state');
      expect(crowd.serialize()).toEqual(before);
    }
    crowd.restore({ version: 1, pressure: [[0, 1], [63, 2 ** 31 - 1]] });
    expect(crowd.serialize().pressure).toEqual([[0, 1], [63, 2 ** 31 - 1]]);
  });

  it('adoptDisplay copies a live field into a rule-off park only', () => {
    const live = new CrowdSimulation(corridor());
    live.noteEntry({ x: 6, y: 3 });
    const restored = new CrowdSimulation(corridor());
    restored.adoptDisplay(live);
    expect(restored.serialize()).toEqual(live.serialize());
    live.noteEntry({ x: 6, y: 3 });
    expect(restored.pressureAt(30), 'a copy, not a shared buffer').toBe(1024);
    const feedback = new CrowdSimulation(corridor(), 1);
    feedback.adoptDisplay(live);
    expect(feedback.serialize().pressure).toEqual([]);
    const small = new CrowdSimulation({ width: 4, height: 4, paths: new Set(), pathVersion: 0 });
    expect(() => small.adoptDisplay(live)).toThrow(SaveError);
    restored.clear();
    expect(restored.serialize().pressure).toEqual([]);
  });
});
