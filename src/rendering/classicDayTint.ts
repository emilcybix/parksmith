import type { DayWeights } from './dayCycle';

/**
 * The classic renderer's whole day/night look: one multiply tint on the camera container. Day is
 * exactly white (the picture is unchanged), dusk warms, night cools. The floor of 0.62 per channel
 * keeps the park colourful. Channels are quantised so the tint (a property write that dirties the
 * render group) changes a few dozen times per day, not every frame.
 */
const DAY: readonly [number, number, number] = [1, 1, 1];
const DUSK: readonly [number, number, number] = [1, 0.88, 0.8];
const NIGHT: readonly [number, number, number] = [0.62, 0.7, 0.92];
const STEPS = 64;

const channel = (day: number, dusk: number, night: number, w: DayWeights): number => {
  const value = day * w.day + dusk * w.dusk + night * w.night;
  return Math.min(255, Math.round(Math.round(Math.min(1, Math.max(0, value)) * STEPS) / STEPS * 255));
};

/** Rain and storm gloom dims by at most this share of a channel (gloom 1). */
const GLOOM_DIM = 0.14;
/** A gloomy channel never goes below this, so rain and storm cool the park but keep it colourful. */
export const CLASSIC_WEATHER_FLOOR = 0.58;
/** A full lightning flash lifts the tint this far toward white. */
const FLASH_LIFT = 0.6;

const mixChannel = (day: number, dusk: number, night: number, w: DayWeights, gloom: number, flash: number): number => {
  const base = Math.min(1, Math.max(0, day * w.day + dusk * w.dusk + night * w.night));
  const dimmed = Math.max(base * (1 - GLOOM_DIM * gloom), Math.min(base, CLASSIC_WEATHER_FLOOR));
  const lit = dimmed + (1 - dimmed) * FLASH_LIFT * flash;
  return Math.min(255, Math.round(Math.round(Math.min(1, Math.max(0, lit)) * STEPS) / STEPS * 255));
};

/**
 * The tint for a time of day, optionally dimmed by weather gloom (0..1) and lifted by a lightning
 * flash (0..1). With no gloom and no flash it is exactly the plain day tint.
 */
export const classicTint = (weights: DayWeights, gloom = 0, flash = 0): number => {
  if (gloom <= 0 && flash <= 0) {
    return (channel(DAY[0], DUSK[0], NIGHT[0], weights) << 16)
      | (channel(DAY[1], DUSK[1], NIGHT[1], weights) << 8)
      | channel(DAY[2], DUSK[2], NIGHT[2], weights);
  }
  return (mixChannel(DAY[0], DUSK[0], NIGHT[0], weights, gloom, flash) << 16)
    | (mixChannel(DAY[1], DUSK[1], NIGHT[1], weights, gloom, flash) << 8)
    | mixChannel(DAY[2], DUSK[2], NIGHT[2], weights, gloom, flash);
};

/** Documented so a retune of the look keys cannot silently break the "colourful" promise. */
export const CLASSIC_NIGHT_FLOOR = Math.min(...NIGHT);
