import { GAME_CONFIG } from '../config';
import { readCrowdState } from '../save/consistency';
import { MAXIMUM_CROWD_PRESSURE } from '../save/ranges';
import { invalidState } from '../save/version';
import type { Serializable } from '../save/state';
import type { Cell } from '../types';
import { flowPerMinute, perLaneOf, ticksPerMinute } from './bands';
import { PathShapeCache, cellIndexOf, type PathSource } from './pathShape';
import type { CrowdFlowReader, CrowdState, PathShape } from './types';

/**
 * Phase 14 (design Q1, Q2): the rolling flow of walking guests through every path tile.
 *
 * One `Uint32Array(width x height)` of integer pressure. `noteEntry` adds `entryUnits` (1024) when a walking guest steps
 * onto a tile; `beginTick` removes ceil(p / decayDivisor) (320) from every cell once per simulation tick, so the field
 * is an exponential moving average with tau = 320 ticks (32 s) that reaches exactly 0. Integers only: the same in
 * every engine, saved as small integers. No RNG, no float in the state.
 *
 * `strength` is the ruleset's `crowdFeedback` (0 = off). With it off the field is display only (`speedFactorAt` is the
 * literal 1, `isSevereAt` false) and stays out of the save; with it on the field feeds back and is saved
 * (`serialize`/`restore`, exactly when `rules.crowdFeedback` exists: the session's law). `adoptDisplay` carries a
 * rule-off field across an undo restore so the heatmap does not blank.
 *
 * Lane width comes from the path shape of the world it reads (`pathShape.ts`, cached per `pathVersion`); call
 * `invalidateShape()` after a world restore.
 */
export class CrowdSimulation implements Serializable<CrowdState>, CrowdFlowReader {
  readonly width: number;
  readonly height: number;
  private readonly pressure: Uint32Array;
  private readonly shapes = new PathShapeCache();
  private feedbackStrength: number;
  /**
   * Early-outs (pure speed, same results): every path tile is at least one lane wide, so a pressure at or below the
   * load-1 pressure of a single lane (16,384) is load <= 1 on any tile, and one below the single-lane severe pressure
   * (24,576) is never severe. The full computation below agrees exactly at those edges.
   */
  private readonly loadOnePressure: number;
  private readonly severePressure: number;
  /** GAME_CONFIG.crowd read once (the same operands, in the same order, as `bands.ts`: identical floats). */
  private readonly constants: { ticksPerMinute: number; unitsPerTick: number; capacity: number; severe: number; maximumPenalty: number; penaltyPerLoad: number };

  constructor(private readonly world: PathSource, strength = 0) {
    this.width = world.width;
    this.height = world.height;
    this.pressure = new Uint32Array(this.width * this.height);
    this.feedbackStrength = CrowdSimulation.checkedStrength(strength);
    const crowd = GAME_CONFIG.crowd;
    const unitsPerMinute = (crowd.entryUnits * crowd.decayDivisor) / ticksPerMinute();
    this.loadOnePressure = crowd.laneCapacityPerMinute * unitsPerMinute;
    this.severePressure = crowd.bands.severe * unitsPerMinute;
    this.constants = {
      ticksPerMinute: ticksPerMinute(),
      unitsPerTick: crowd.entryUnits * crowd.decayDivisor,
      capacity: crowd.laneCapacityPerMinute,
      severe: crowd.bands.severe,
      maximumPenalty: 1 - crowd.minimumSpeedFactor,
      penaltyPerLoad: crowd.speedPenaltyPerLoad,
    };
  }

  /** Guests a minute per lane at a path cell index: `perLaneOf(flowPerMinute(p), laneWidth)` with cached operands. */
  private perLaneAtIndex(index: number, laneWidth: number): number {
    const { ticksPerMinute: perMinute, unitsPerTick } = this.constants;
    return ((this.pressure[index] * perMinute) / unitsPerTick) / laneWidth;
  }

  /** A strength must be finite in 0..maximumFeedback (0 = off). */
  private static checkedStrength(strength: number): number {
    if (typeof strength !== 'number' || !Number.isFinite(strength) || strength < 0 || strength > GAME_CONFIG.crowd.maximumFeedback) {
      throw new RangeError(`crowd feedback strength ${String(strength)} is not in 0..${GAME_CONFIG.crowd.maximumFeedback}`);
    }
    return strength;
  }

  /** The feedback strength (the ruleset's `crowdFeedback`; 0 = off, display only). */
  get strength(): number {
    return this.feedbackStrength;
  }

  /** True when the field feeds back into the simulation (and is therefore saved). */
  get feedback(): boolean {
    return this.feedbackStrength > 0;
  }

  /** Changes the strength (a session swapping its ruleset). The field is kept. */
  setStrength(strength: number): void {
    this.feedbackStrength = CrowdSimulation.checkedStrength(strength);
  }

  /** The path shape the field is classified against (cached per `pathVersion`). */
  shape(): PathShape {
    return this.shapes.of(this.world);
  }

  /** Forgets the cached path shape (after a world restore: the saved `pathVersion` may coincide with a stale one). */
  invalidateShape(): void {
    this.shapes.invalidate();
  }

  /** Decay, once per simulation tick before the guests step: p -= ceil(p / decayDivisor). Pausing skips it. */
  beginTick(): void {
    const divisor = GAME_CONFIG.crowd.decayDivisor;
    const field = this.pressure;
    for (let index = 0; index < field.length; index += 1) {
      const value = field[index];
      if (value !== 0) field[index] = value - Math.ceil(value / divisor);
    }
  }

  /** A walking guest stepped onto `cell`: add `entryUnits`, clamped at MAXIMUM_CROWD_PRESSURE. Off the map: ignored. */
  noteEntry(cell: Readonly<Cell>): void {
    const index = cellIndexOf(this.width, this.height, cell);
    if (index < 0) return;
    this.pressure[index] = Math.min(MAXIMUM_CROWD_PRESSURE, this.pressure[index] + GAME_CONFIG.crowd.entryUnits);
  }

  /** The raw pressure at a cell index (0 off the map). */
  pressureAt(index: number): number {
    return index >= 0 && index < this.pressure.length ? this.pressure[index] : 0;
  }

  /** Guests a minute through `cell` (0 off the map). */
  perMinuteAt(cell: Readonly<Cell>): number {
    return flowPerMinute(this.pressureAt(cellIndexOf(this.width, this.height, cell)));
  }

  /** Guests a minute per lane at `cell` (0 off the path network). */
  perLaneAt(cell: Readonly<Cell>): number {
    const index = cellIndexOf(this.width, this.height, cell);
    if (index < 0) return 0;
    return perLaneOf(flowPerMinute(this.pressure[index]), this.shape().laneWidth[index]);
  }

  /** A read-only view of the whole field (for the bands and the heatmap); never write through it. */
  field(): Readonly<Uint32Array> {
    return this.pressure;
  }

  /**
   * Movement multiplier for the step onto `cell`: the literal 1 when feedback is off, off the network, or at load <= 1;
   * else `crowdSpeedFactor(load, strength)` (0.6 at the floor). Reads the live value (entries made earlier this tick count).
   */
  speedFactorAt(cell: Readonly<Cell>): number {
    if (this.feedbackStrength <= 0) return 1;
    const index = cellIndexOf(this.width, this.height, cell);
    if (index < 0 || this.pressure[index] <= this.loadOnePressure) return 1;
    const laneWidth = this.shape().laneWidth[index];
    if (laneWidth <= 0) return 1;
    // Same arithmetic as crowdSpeedFactor(loadOf(flowPerMinute(p), laneWidth), strength), operands cached.
    const { capacity, maximumPenalty, penaltyPerLoad } = this.constants;
    const load = this.perLaneAtIndex(index, laneWidth) / capacity;
    if (!(load > 1)) return 1;
    return 1 - this.feedbackStrength * Math.min(maximumPenalty, penaltyPerLoad * (load - 1));
  }

  /** The tile is in the severe band (no hysteresis; feedback on only, always false when off or off the network). */
  isSevereAt(cell: Readonly<Cell>): boolean {
    if (this.feedbackStrength <= 0) return false;
    const index = cellIndexOf(this.width, this.height, cell);
    if (index < 0 || this.pressure[index] < this.severePressure) return false;
    const laneWidth = this.shape().laneWidth[index];
    if (laneWidth <= 0) return false;
    return this.perLaneAtIndex(index, laneWidth) >= this.constants.severe;
  }

  /** Sparse `[cell, value]` pairs, ascending by cell, non-zero only. Deep copy, plain data. */
  serialize(): CrowdState {
    const pressure: Array<[number, number]> = [];
    const field = this.pressure;
    for (let index = 0; index < field.length; index += 1) if (field[index] !== 0) pressure.push([index, field[index]]);
    return { version: 1, pressure };
  }

  /** Validates completely first (`readCrowdState`), then clears the field and applies the pairs. Strength is kept. */
  restore(state: CrowdState): void {
    const valid = readCrowdState(state, this.pressure.length);
    this.pressure.fill(0);
    for (const [cell, value] of valid.pressure) this.pressure[cell] = value;
    this.shapes.invalidate();
  }

  /** Empties the field (a new or swapped park). */
  clear(): void {
    this.pressure.fill(0);
  }

  /**
   * Presentation only (an undo restore of a rule-OFF park, like `adoptSettings`): copies the field of the live
   * session's crowd so the heatmap does not blank. A feedback park ignores it (its field is saved state and was just
   * restored). The maps must have the same size.
   */
  adoptDisplay(other: CrowdSimulation): void {
    if (this.feedback || other === this) return;
    if (other.width !== this.width || other.height !== this.height) {
      throw invalidState('CrowdSimulation', 'adoptDisplay', `needs a ${this.width}x${this.height} field, got ${other.width}x${other.height}`);
    }
    this.pressure.set(other.pressure);
  }
}

/** The reader a standalone `GuestSimulation` uses: no entries, factor exactly 1, never severe. */
export const NEUTRAL_CROWD_READER: CrowdFlowReader = Object.freeze({
  noteEntry: () => undefined,
  speedFactorAt: () => 1,
  isSevereAt: () => false,
});
