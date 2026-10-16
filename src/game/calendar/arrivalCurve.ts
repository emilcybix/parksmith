import { GAME_CONFIG } from '../config';

/**
 * The guest arrival curve over the RAW clock hour (never the pinned look): a deterministic
 * multiplier on the arrival logic. Piecewise smoothstep through GAME_CONFIG.calendar.arrivalCurve,
 * wrapping at 24 h, so it is continuous and has a flat tangent at every key.
 */
export const arrivalCurveAt = (hour: number): number => {
  const keys = GAME_CONFIG.calendar.arrivalCurve;
  const hoursPerDay = GAME_CONFIG.calendar.hoursPerDay;
  const wrapped = ((hour % hoursPerDay) + hoursPerDay) % hoursPerDay;
  for (let index = 1; index < keys.length; index += 1) {
    const [toHour, toValue] = keys[index];
    if (wrapped > toHour) continue;
    const [fromHour, fromValue] = keys[index - 1];
    const span = toHour - fromHour;
    const t = span > 0 ? (wrapped - fromHour) / span : 1;
    const eased = t * t * (3 - 2 * t);
    return fromValue + (toValue - fromValue) * eased;
  }
  return keys[keys.length - 1][1];
};

/** Mean of the curve over a day, for the config test and the balance note. */
export const arrivalCurveMean = (samples = 2_400): number => {
  let total = 0;
  for (let index = 0; index < samples; index += 1) total += arrivalCurveAt(index / samples * GAME_CONFIG.calendar.hoursPerDay);
  return total / samples;
};
