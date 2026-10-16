import { invalidState } from './version';

/**
 * Sanity bounds shared by every owner's restore().
 *
 * WHY they exist: `Number.isFinite` accepts 1e300, and a saved timer or counter that large is not
 * merely wrong, it can hang the tab (an unbounded `while (timer >= interval) timer -= interval`
 * never terminates once the double stops changing) or hand out colliding ids (above 2^53,
 * `id + 1 === id`). A save is user-editable data, so each number is range-checked where the state
 * is read, with a bound that no healthy park comes anywhere near. The bounds are deliberately
 * generous: rejecting a legitimate save is worse than accepting a slightly odd one.
 */

/** Ids, ticks, versions and lifetime counters. 2^31 ticks is about 6.8 years of 1x play. */
export const MAXIMUM_SAVED_COUNTER = 2 ** 31;

/** Timers, ages and accumulators in seconds. About 31 years: far above anything reachable. */
export const MAXIMUM_SAVED_SECONDS = 1_000_000_000;

/** Cumulative money and other unbounded float totals (revenue, cost, cash). 1e12 is a trillion. */
export const MAXIMUM_SAVED_AMOUNT = 1e12;

/** Money held by one guest or priced on one item: spawn budgets are two to three digits. */
export const MAXIMUM_SAVED_PRICE = 1_000_000;

/**
 * One cell of the crowd pressure field (Phase 14, `crowd.pressure` values): a non-negative integer below 2^31, the clamp
 * `CrowdSimulation.noteEntry` applies. A year of 1,000 entries a tick stays far below it (1024 x 320 x 1000 = 3.3e8).
 */
export const MAXIMUM_CROWD_PRESSURE = 2 ** 31 - 1;

/**
 * Iteration guard for loops that drain a timer by whole intervals. Healthy steps run them zero or
 * one time; the guard only matters when state is corrupt, where it turns a hang into a no-op.
 */
export const MAXIMUM_LOOP_ITERATIONS = 1_000;

/** A finite number inside `minimum..maximum` (inclusive), or an invalid-state error naming `path`. */
export const requireNumberInRange = (
  owner: string,
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw invalidState(owner, path, `must be a finite number in ${minimum}..${maximum}`);
  }
  return value;
};

/**
 * Colour records (schema 6, Phase 28) are deliberately NOT range-checked with the helpers above.
 * They are cosmetic and cannot desync any owner, so GameWorld.restore NORMALISES them
 * (normaliseObjectColours in content/colours.ts) instead of refusing the save: an entry that is not
 * an integer swatch index in 0..SWATCH_COUNT-1 becomes the slot default, a wrong length is padded
 * or truncated to the definition's slot count (never more than MAXIMUM_COLOUR_SLOTS), a record on a
 * definition that is not colourable is dropped. Non-finite numbers never get that far: the
 * envelope's plain-data rule refuses them as `corrupt` like every other field.
 */
export { MAX_COLOUR_SLOTS as MAXIMUM_COLOUR_SLOTS, SWATCH_COUNT as MAXIMUM_COLOUR_SWATCHES } from '../content/colours';
