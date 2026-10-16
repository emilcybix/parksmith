import { GAME_CONFIG } from '../config';
import { WEATHER_KINDS, type WeatherDayState, type WeatherKind, type WeatherSlotState } from './types';
import type { WeatherRandom } from './random';

/**
 * The pure day generator. One drawn day costs exactly five draws, in this order: one kind draw,
 * then one intensity draw per slot 0..3 (day 1 is fixed and costs none), so the stream state after
 * N days is reproducible and a test can pin it.
 */

const round2 = (value: number): number => Math.round(value * 100) / 100;

/**
 * The neutral biome weather mix: every column weight exactly 1. `x * 1 === x` in IEEE 754, so a row weighted
 * by it is bit-identical to an unweighted one (Meadow's mix, pinned by the transition-row tests).
 */
export const NEUTRAL_MIX: readonly number[] = Object.freeze([1, 1, 1, 1, 1]);

/**
 * Transition probabilities out of `from`, wet columns scaled by `wetMultiplier` and every column by the
 * biome's `mix` weight (Phase 24), renormalised to sum 1.
 */
export const transitionRow = (from: WeatherKind, wetMultiplier: number, mix: readonly number[] = NEUTRAL_MIX): number[] => {
  const row = GAME_CONFIG.weather.transitions[from];
  const wet = GAME_CONFIG.weather.wetKinds as readonly WeatherKind[];
  const scaled = WEATHER_KINDS.map((kind, index) => row[index] * (wet.includes(kind) ? wetMultiplier : 1) * mix[index]);
  const total = scaled.reduce((sum, value) => sum + value, 0);
  return scaled.map((value) => value / total);
};

const slotsOf = (kind: WeatherKind, intensities: readonly number[]): WeatherDayState['slots'] => {
  const arc = GAME_CONFIG.weather.arcs[kind];
  const slot = (index: number): WeatherSlotState => ({ kind: arc[index], intensity: intensities[index] });
  return [slot(0), slot(1), slot(2), slot(3)];
};

/** Day 1: always sunny, a fixed intensity, no draws. */
export const firstDayOf = (): WeatherDayState => {
  const { kind, intensity } = GAME_CONFIG.weather.firstDay;
  return { kind, slots: slotsOf(kind, [intensity, intensity, intensity, intensity]) };
};

/** Draws the day that follows a day of kind `from` (five draws). */
export const drawDay = (
  from: WeatherKind,
  wetMultiplier: number,
  random: WeatherRandom,
  mix: readonly number[] = NEUTRAL_MIX,
): WeatherDayState => {
  const row = transitionRow(from, wetMultiplier, mix);
  const pick = random.next();
  let kind: WeatherKind = WEATHER_KINDS[WEATHER_KINDS.length - 1];
  let cumulative = 0;
  for (let index = 0; index < WEATHER_KINDS.length; index += 1) {
    cumulative += row[index];
    if (pick < cumulative) {
      kind = WEATHER_KINDS[index];
      break;
    }
  }
  const [low, high] = GAME_CONFIG.weather.intensityRange[kind];
  const intensities = [0, 1, 2, 3].map(() => round2(low + (high - low) * random.next()));
  return { kind, slots: slotsOf(kind, intensities) };
};

/** The analytic stationary distribution of the chain for a wet multiplier and a biome mix (power iteration). */
export const stationaryDistribution = (wetMultiplier: number, mix: readonly number[] = NEUTRAL_MIX): Record<WeatherKind, number> => {
  const rows = WEATHER_KINDS.map((kind) => transitionRow(kind, wetMultiplier, mix));
  let vector = WEATHER_KINDS.map(() => 1 / WEATHER_KINDS.length);
  for (let iteration = 0; iteration < 500; iteration += 1) {
    vector = WEATHER_KINDS.map((_, column) => rows.reduce((sum, row, from) => sum + vector[from] * row[column], 0));
  }
  return Object.fromEntries(WEATHER_KINDS.map((kind, index) => [kind, vector[index]])) as Record<WeatherKind, number>;
};
