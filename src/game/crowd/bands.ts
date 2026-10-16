import { GAME_CONFIG } from '../config';
import type { CrowdBand, PathShape } from './types';

/**
 * Phase 14: from pressure to what a player sees (design Q1). Pure arithmetic over `GAME_CONFIG.crowd`, read at call time
 * so a `vi.mock` of the config reaches it.
 *
 * Units. Pressure is the integer field of `CrowdSimulation` (an entry adds `entryUnits`, each tick removes
 * ceil(p / decayDivisor)). At a steady r entries a tick the field settles at p = r x entryUnits x decayDivisor, so the
 * flow is p / (entryUnits x decayDivisor) entries a tick, times the ticks in a minute (60,000 ms / fixedStepMs = 600):
 * **guests a minute** through the tile. Divided by `laneWidth` it is guests a minute per lane, the unit of the bands;
 * divided further by `laneCapacityPerMinute` (400) it is the load the feedback reads (load 1 = 400 a minute per lane).
 * Scale: a guest walking without stopping enters `walkingThroughputPerMinute()` (111) tiles a minute, so a per-lane
 * flow over 111 is the average number of walkers on the tile (severe 450 = about four).
 */

/** Simulation ticks in one minute (600 at 100 ms a tick). */
export const ticksPerMinute = (): number => 60_000 / GAME_CONFIG.fixedStepMs;

/**
 * Tile entries a minute of ONE guest walking without stopping (walkingCellsPerSecond x 60 = 111): the yardstick of the
 * thresholds. A per-lane flow divided by it is the average number of walkers on the tile.
 */
export const walkingThroughputPerMinute = (): number => GAME_CONFIG.guests.walkingCellsPerSecond * 60;

/** Guests a minute through a tile holding `pressure`. 0 for 0. */
export const flowPerMinute = (pressure: number): number => {
  const crowd = GAME_CONFIG.crowd;
  return (pressure * ticksPerMinute()) / (crowd.entryUnits * crowd.decayDivisor);
};

/** Guests a minute per lane; 0 off the network (`laneWidth` 0). */
export const perLaneOf = (perMinute: number, laneWidth: number): number => (laneWidth > 0 ? perMinute / laneWidth : 0);

/** The load the feedback reads: guests a minute per lane over `laneCapacityPerMinute`. 0 off the network. */
export const loadOf = (perMinute: number, laneWidth: number): number => (
  perLaneOf(perMinute, laneWidth) / GAME_CONFIG.crowd.laneCapacityPerMinute
);

/** The band of a per-lane flow: quiet < normal (80) <= normal < busy (270) <= busy < severe (450) <= severe. */
export const bandOf = (perLane: number): CrowdBand => {
  const { normal, busy, severe } = GAME_CONFIG.crowd.bands;
  if (perLane >= severe) return 3;
  if (perLane >= busy) return 2;
  if (perLane >= normal) return 1;
  return 0;
};

/** The lowest per-lane flow of a band (0 for quiet). */
export const bandLowerEdge = (band: CrowdBand): number => {
  const { normal, busy, severe } = GAME_CONFIG.crowd.bands;
  return band === 3 ? severe : band === 2 ? busy : band === 1 ? normal : 0;
};

/**
 * Display hysteresis (never used by the simulation): a band rises as soon as the flow reaches the next edge, and drops
 * only when the flow falls below `hysteresis` (85 %) of its own lower edge, one band at a time while that holds, so a
 * tile sitting on an edge does not flicker. `previous` null = no memory (the plain band).
 */
export const withHysteresis = (previous: CrowdBand | null, perLane: number): CrowdBand => {
  const raw = bandOf(perLane);
  if (previous === null || raw >= previous) return raw;
  const keep = GAME_CONFIG.crowd.hysteresis;
  let band = previous;
  while (band > raw && perLane < keep * bandLowerEdge(band)) band = (band - 1) as CrowdBand;
  return band;
};

/**
 * A bottleneck (the word Park Pulse uses) is a severe tile with a structural cause: a single lane (`laneWidth` exactly 1,
 * at most 3 path tiles in its 3x3 block) or an articulation point of its component. `cell` is the cell index
 * (`y * width + x`); off-network cells never are.
 */
export const isBottleneck = (band: CrowdBand, shape: PathShape, cell: number): boolean => (
  band === 3 && cell >= 0 && cell < shape.laneWidth.length && shape.laneWidth[cell] > 0
    && (shape.laneWidth[cell] === 1 || shape.articulation[cell] === 1)
);

/**
 * The walking-speed multiplier of design Q2: the LITERAL 1 at load <= 1 or strength <= 0 (an IEEE multiply by 1 is
 * exact, so a park below the threshold computes the old floats), else 1 - strength x min(1 - minimumSpeedFactor,
 * speedPenaltyPerLoad x (load - 1)): 0.8 at load 1.5, the floor 0.6 from load 2 at strength 1.
 */
export const crowdSpeedFactor = (load: number, strength: number): number => {
  if (!(strength > 0) || !(load > 1)) return 1;
  const crowd = GAME_CONFIG.crowd;
  return 1 - strength * Math.min(1 - crowd.minimumSpeedFactor, crowd.speedPenaltyPerLoad * (load - 1));
};
