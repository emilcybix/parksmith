import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import {
  bandLowerEdge, bandOf, crowdSpeedFactor, flowPerMinute, isBottleneck, loadOf, perLaneOf, ticksPerMinute, walkingThroughputPerMinute, withHysteresis,
} from './bands';
import { computePathShape } from './pathShape';

describe('bands: units', () => {
  it('pressure reads as guests a minute: p x 600 / (1024 x 320)', () => {
    expect(ticksPerMinute()).toBe(600);
    expect(flowPerMinute(0)).toBe(0);
    expect(flowPerMinute(1024 * 320)).toBe(600);
    expect(flowPerMinute(16_384)).toBe(30);
    expect(perLaneOf(60, 2)).toBe(30);
    expect(perLaneOf(60, 0), 'off the network').toBe(0);
    expect(GAME_CONFIG.crowd.laneCapacityPerMinute).toBe(400);
    expect(loadOf(400, 1)).toBe(1);
    expect(loadOf(600, 1)).toBe(1.5);
    expect(loadOf(1_200, 3)).toBe(1);
  });

  it('the yardstick: one guest walking without stopping enters 111 tiles a minute', () => {
    expect(walkingThroughputPerMinute()).toBeCloseTo(111, 9);
    // Severe is about four walkers on a single-lane tile, the feedback threshold about 3.6.
    expect(GAME_CONFIG.crowd.bands.severe / walkingThroughputPerMinute()).toBeCloseTo(4.05, 2);
  });
});

describe('bands: classification', () => {
  it('quiet < 80 <= normal < 270 <= busy < 450 <= severe (per lane), feedback from 400', () => {
    expect(GAME_CONFIG.crowd.bands).toEqual({ normal: 80, busy: 270, severe: 450 });
    expect([0, 79.999, 80, 269.999, 270, 449.999, 450, 10_000].map(bandOf)).toEqual([0, 0, 1, 1, 2, 2, 3, 3]);
    expect([0, 1, 2, 3].map((band) => bandLowerEdge(band as 0 | 1 | 2 | 3))).toEqual([0, 80, 270, 450]);
    // The feedback starts inside busy and below severe, so a severe tile always slows its walkers.
    const { laneCapacityPerMinute: capacity, bands } = GAME_CONFIG.crowd;
    expect(capacity).toBeGreaterThan(bands.busy);
    expect(capacity).toBeLessThan(bands.severe);
  });

  it('hysteresis: rises at once, drops only below 85 % of the lower edge, through every band that no longer holds', () => {
    expect(withHysteresis(null, 300)).toBe(2);
    expect(withHysteresis(0, 300), 'rise at once').toBe(2);
    expect(withHysteresis(3, 400), 'severe held at 400 (>= 382.5)').toBe(3);
    expect(withHysteresis(3, 382.5)).toBe(3);
    expect(withHysteresis(3, 382.4), 'drops to busy, which holds').toBe(2);
    expect(withHysteresis(2, 229.5)).toBe(2);
    expect(withHysteresis(2, 229.4)).toBe(1);
    expect(withHysteresis(1, 68)).toBe(1);
    expect(withHysteresis(1, 67.9)).toBe(0);
    expect(withHysteresis(3, 50), 'a collapse falls through every band').toBe(0);
    expect(withHysteresis(3, 70), 'normal still holds at 70 (>= 68)').toBe(1);
  });

  it('a bottleneck is a severe tile that is a single lane or a cut vertex', () => {
    const W = 10;
    const paths = new Set<string>();
    // A 3x3 plaza (x 1..3, y 1..3) whose east side leaves through a corridor (x 4..7, y 2).
    for (let x = 1; x <= 3; x += 1) for (let y = 1; y <= 3; y += 1) paths.add(`${x},${y}`);
    for (let x = 4; x <= 7; x += 1) paths.add(`${x},2`);
    const shape = computePathShape({ width: W, height: 6, paths, pathVersion: 1 });
    const at = (x: number, y: number): number => y * W + x;
    expect(isBottleneck(3, shape, at(5, 2)), 'corridor').toBe(true);
    expect(isBottleneck(3, shape, at(7, 2)), 'corridor dead end: still one lane').toBe(true);
    expect(isBottleneck(3, shape, at(3, 2)), 'the plaza join: a cut vertex on a wide tile').toBe(true);
    expect(isBottleneck(3, shape, at(2, 2)), 'the plaza heart').toBe(false);
    expect(isBottleneck(3, shape, at(1, 1)), 'a plaza corner').toBe(false);
    expect(isBottleneck(2, shape, at(5, 2)), 'busy is never a bottleneck').toBe(false);
    expect(isBottleneck(3, shape, at(0, 0)), 'off-path').toBe(false);
    expect(isBottleneck(3, shape, -1)).toBe(false);
  });
});

describe('bands: the feedback curve', () => {
  it('is the literal 1 up to load 1 and for strength 0; 0.8 at load 1.5; the floor 0.6 from load 2', () => {
    for (const load of [0, 0.5, 1]) expect(Object.is(crowdSpeedFactor(load, 1), 1), String(load)).toBe(true);
    expect(Object.is(crowdSpeedFactor(5, 0), 1)).toBe(true);
    expect(Object.is(crowdSpeedFactor(Number.NaN, 1), 1)).toBe(true);
    expect(crowdSpeedFactor(1.5, 1)).toBeCloseTo(0.8, 12);
    expect(crowdSpeedFactor(2, 1)).toBeCloseTo(0.6, 12);
    expect(crowdSpeedFactor(10, 1)).toBeCloseTo(0.6, 12);
    expect(crowdSpeedFactor(10, 0.5)).toBeCloseTo(0.8, 12);
    expect(crowdSpeedFactor(1.25, 1)).toBeCloseTo(0.9, 12);
  });
});
