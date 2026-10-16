import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { SANDBOX_SEED } from '../session/ParkSession';
import { FOUNDING_SCENARIOS, SCENARIOS } from '../scenarios/content';
import { drawDay, firstDayOf, stationaryDistribution, transitionRow } from './chain';
import { WeatherRandom, mixSeed } from './random';
import { WEATHER_KINDS, type WeatherDayState, type WeatherKind } from './types';

const sequence = (seed: number, days: number, wet = 1): WeatherDayState[] => {
  const random = new WeatherRandom(mixSeed(seed));
  const out = [firstDayOf()];
  while (out.length < days) out.push(drawDay(out[out.length - 1].kind, wet, random));
  return out;
};

describe('weather chain', () => {
  it('same seed gives the same 400 days, different seeds differ', () => {
    expect(sequence(SANDBOX_SEED, 400)).toEqual(sequence(SANDBOX_SEED, 400));
    expect(sequence(1, 400)).not.toEqual(sequence(2, 400));
  });

  it('day 1 is fixed sunny at the configured intensity and consumes no draws', () => {
    const first = firstDayOf();
    expect(first.kind).toBe('sunny');
    for (const slot of first.slots) expect(slot.intensity).toBe(GAME_CONFIG.weather.firstDay.intensity);
    const random = new WeatherRandom(mixSeed(7));
    const before = random.getState();
    firstDayOf();
    expect(random.getState()).toBe(before);
  });

  it('a drawn day costs exactly five draws (the stream is reproducible)', () => {
    const a = new WeatherRandom(mixSeed(99));
    const b = new WeatherRandom(mixSeed(99));
    drawDay('cloudy', 1, a);
    for (let draw = 0; draw < 5; draw += 1) b.next();
    expect(a.getState()).toBe(b.getState());
  });

  it('every transition row sums to 1, also after the wet multiplier', () => {
    for (const wet of [0.25, 0.5, 1, 1.5, 4]) {
      for (const kind of WEATHER_KINDS) {
        const row = transitionRow(kind, wet);
        expect(row.reduce((sum, value) => sum + value, 0)).toBeCloseTo(1, 12);
        for (const value of row) expect(value).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('the wet multiplier moves the wet share in the stated direction', () => {
    const wetShare = (wet: number): number => {
      const dist = stationaryDistribution(wet);
      return dist.rain + dist.storm;
    };
    expect(wetShare(0.5)).toBeLessThan(wetShare(1));
    expect(wetShare(1)).toBeLessThan(wetShare(1.5));
  });

  it('the base chain is sunny-dominant so the park stays colourful', () => {
    const dist = stationaryDistribution(1);
    expect(dist.sunny + dist.hot + dist.cloudy).toBeGreaterThan(0.75);
    expect(dist.sunny).toBeGreaterThan(dist.rain + dist.storm);
    expect(dist.storm).toBeLessThan(0.06);
  });

  it('the empirical distribution over 40,000 days matches the analytic one within 1.5 points', () => {
    for (const wet of [0.5, 1, 1.5]) {
      const random = new WeatherRandom(mixSeed(1234 + wet * 10));
      const counts = Object.fromEntries(WEATHER_KINDS.map((kind) => [kind, 0])) as Record<WeatherKind, number>;
      let kind: WeatherKind = 'sunny';
      const days = 40_000;
      for (let index = 0; index < days; index += 1) {
        kind = drawDay(kind, wet, random).kind;
        counts[kind] += 1;
      }
      const expected = stationaryDistribution(wet);
      for (const each of WEATHER_KINDS) {
        expect(Math.abs(counts[each] / days - expected[each]) * 100, `${each} at wet ${wet}`).toBeLessThan(1.5);
      }
    }
  });

  it('slot 0 of every arc is dry and arcs and ranges cover every kind', () => {
    for (const kind of WEATHER_KINDS) {
      expect(['sunny', 'cloudy'], `${kind} morning`).toContain(GAME_CONFIG.weather.arcs[kind][0]);
      expect(GAME_CONFIG.weather.arcs[kind]).toHaveLength(GAME_CONFIG.weather.slotsPerDay);
      expect(GAME_CONFIG.weather.transitions[kind]).toHaveLength(WEATHER_KINDS.length);
      const [low, high] = GAME_CONFIG.weather.intensityRange[kind];
      expect(low).toBeGreaterThan(0);
      expect(high).toBeLessThanOrEqual(1);
    }
    const days = sequence(5, 2_000);
    for (const day of days) for (const slot of day.slots) {
      expect(slot.intensity).toBeGreaterThanOrEqual(0);
      expect(slot.intensity).toBeLessThanOrEqual(1);
      expect(Math.round(slot.intensity * 100) / 100).toBe(slot.intensity);
    }
  });

  it('no wet slot can exist before tick 9,000 (the end of the 15 minute First Day window) for any seed', () => {
    // Day 1 is fixed sunny and slot 0 of day 2 is dry; day 2 slot 1 starts at 0.25 + 1 day after 06:00.
    const firstWetTick = (1 + 0.25) * GAME_CONFIG.calendar.defaultDayLengthSeconds * 10;
    expect(firstWetTick).toBe(9_000);
    for (let seed = 1; seed <= 2_000; seed += 1) {
      const days = sequence(seed, 2);
      for (const slot of days[0].slots) expect(['rain', 'storm']).not.toContain(slot.kind);
      expect(['rain', 'storm']).not.toContain(days[1].slots[0].kind);
    }
  });

  it('pins the sandbox and scenario sequences (re-pin and review when the chain constants change)', () => {
    const kinds = (seed: number): string => sequence(seed, 8).map((day) => day.kind).join(' ');
    expect(kinds(SANDBOX_SEED)).toBe('sunny cloudy sunny hot storm rain sunny cloudy');
    const expected: Record<string, string> = {
      'sunny-start': 'sunny hot sunny sunny rain rain cloudy cloudy',
      'penny-lane': 'sunny cloudy rain rain cloudy cloudy sunny sunny',
      'garden-gala': 'sunny sunny cloudy rain rain rain cloudy rain',
      'starlight-finale': 'sunny cloudy cloudy rain rain sunny cloudy sunny',
    };
    for (const scenario of FOUNDING_SCENARIOS) expect(kinds(scenario.seed), scenario.id).toBe(expected[scenario.id]);
  });

  it('no storm falls inside any scenario window with the base rules', () => {
    for (const scenario of SCENARIOS) {
      const windowDays = scenario.timeLimitSeconds / GAME_CONFIG.calendar.defaultDayLengthSeconds;
      const slots = Math.ceil(windowDays * GAME_CONFIG.weather.slotsPerDay);
      const days = sequence(scenario.seed, Math.ceil(windowDays) + 1);
      for (let slot = 0; slot < slots; slot += 1) {
        const state = days[Math.floor(slot / 4)].slots[slot % 4];
        expect(state.kind, `${scenario.id} slot ${slot}`).not.toBe('storm');
      }
    }
  });
});
