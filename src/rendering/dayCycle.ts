import { GAME_CONFIG } from '../game/config';

/**
 * The look of the park through a day, renderer-neutral (both renderers import this; it pulls in no
 * voxel code). Any time of day is a weight triple over the three authored looks (day, dusk, night),
 * summing to 1. A dawn is just a key weight that mixes dusk and night; no look is ever edited.
 * Presentation only: it reads a clock fraction handed to the renderer and nothing flows back.
 */
export interface DayWeights {
  day: number;
  dusk: number;
  night: number;
}

export const createDayWeights = (): DayWeights => ({ day: 0, dusk: 0, night: 1 });

type LookKey = readonly [hour: number, day: number, dusk: number, night: number];

const KEYS: readonly LookKey[] = GAME_CONFIG.calendar.lookKeys;
const HOURS_PER_DAY = GAME_CONFIG.calendar.hoursPerDay;

const smoothstep = (t: number): number => t * t * (3 - 2 * t);

/**
 * Weights at a clock fraction (0 = midnight, 0.5 = noon; any finite value wraps into one day).
 * Mutates and returns `out`, so a per-frame caller allocates nothing. On a plateau (two keys with
 * equal weights) the weights are copied, not interpolated, so a plateau is exactly the key; the
 * smoothstep has a zero slope at every key, so ramps join the plateaus without a kink.
 */
export const dayWeights = (out: DayWeights, phase: number): DayWeights => {
  let fraction = Number.isFinite(phase) ? phase % 1 : 0;
  if (fraction < 0) fraction += 1;
  const hour = fraction * HOURS_PER_DAY;
  const last = KEYS.length - 1;
  // The segment [KEYS[i], KEYS[i + 1]) containing the hour; before the first key or from the last
  // key onward the segment wraps from the last key to the first one a day later.
  let from = last;
  let to = 0;
  let fromHour = KEYS[last][0] - HOURS_PER_DAY;
  let toHour = KEYS[0][0];
  if (hour >= KEYS[last][0]) {
    fromHour = KEYS[last][0];
    toHour = KEYS[0][0] + HOURS_PER_DAY;
  } else if (hour >= KEYS[0][0]) {
    for (let index = 0; index < last; index += 1) {
      if (hour >= KEYS[index][0] && hour < KEYS[index + 1][0]) {
        from = index;
        to = index + 1;
        fromHour = KEYS[index][0];
        toHour = KEYS[index + 1][0];
        break;
      }
    }
  }
  const a = KEYS[from];
  const b = KEYS[to];
  if (a[1] === b[1] && a[2] === b[2] && a[3] === b[3]) {
    out.day = a[1];
    out.dusk = a[2];
    out.night = a[3];
    return out;
  }
  const t = smoothstep((hour - fromHour) / (toHour - fromHour));
  out.day = a[1] + (b[1] - a[1]) * t;
  out.dusk = a[2] + (b[2] - a[2]) * t;
  out.night = a[3] + (b[3] - a[3]) * t;
  return out;
};
