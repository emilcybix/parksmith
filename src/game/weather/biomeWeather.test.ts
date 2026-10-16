import { describe, expect, it } from 'vitest';
import { BIOMES } from '../biomes/content';
import { MAPS } from '../maps/content';
import { ParkSession } from '../session/ParkSession';
import { hashState } from '../save/hash';
import { WeatherSimulation } from './WeatherSimulation';
import { NEUTRAL_CLIMATE } from './climate';
import { ParkCalendar } from '../calendar/ParkCalendar';
import type { WeatherKind } from './types';

const DAY_TICKS = 7_200;

/** The kinds of the first `days` days a session's weather draws, stepping the weather only. */
const kindsOf = (session: ParkSession, days: number): WeatherKind[] => {
  const kinds: WeatherKind[] = [];
  const weather = session.weather;
  // The sandbox day length is the biome's (Autumn Forest's days are twice as long).
  const dayTicks = session.calendar.dayLengthSeconds * 10;
  for (let day = 1; day <= days; day += 1) {
    session.world.tick = (day - 1) * dayTicks;
    weather.step(session.world.tick);
    const index = day - weather.firstDay;
    kinds.push(weather.days[index].kind);
  }
  return kinds;
};

describe('weather per biome (seeded, deterministic)', () => {
  it('the same seed and the same biome draw the same weather in two sessions; saves and restores agree', () => {
    for (const map of MAPS) {
      const a = kindsOf(new ParkSession(null, [], { mapId: map.id }), 120);
      const b = kindsOf(new ParkSession(null, [], { mapId: map.id }), 120);
      expect(a, map.id).toEqual(b);
      expect(a[0], 'day 1 is fixed sunny everywhere (First Day safety)').toBe('sunny');
    }
  });

  it('Winter never draws a hot day; Desert draws far more hot days than Meadow over a long run', () => {
    const count = (kinds: WeatherKind[], kind: WeatherKind): number => kinds.filter((candidate) => candidate === kind).length;
    const winter = kindsOf(new ParkSession(null, [], { mapId: 'frosted-hollow' }), 400);
    expect(count(winter, 'hot')).toBe(0);
    expect(count(winter, 'rain') + count(winter, 'storm')).toBeGreaterThan(40);
    const desert = kindsOf(new ParkSession(null, [], { mapId: 'red-rock-canyon' }), 400);
    const meadow = kindsOf(new ParkSession(null, [], { mapId: 'meadow' }), 400);
    expect(count(desert, 'hot')).toBeGreaterThan(count(meadow, 'hot') * 2);
    expect(count(desert, 'rain')).toBeLessThan(count(meadow, 'rain') / 2);
    const jungle = kindsOf(new ParkSession(null, [], { mapId: 'emerald-ruins' }), 400);
    expect(count(jungle, 'rain')).toBeGreaterThan(count(meadow, 'rain'));
  });

  it('a biome with the same seed differs from Meadow only through its weights (same stream, different row)', () => {
    const first = (mix: readonly number[]): string => {
      const calendar = new ParkCalendar(() => 0, true);
      const weather = new WeatherSimulation(0x5eed1234, calendar, 1, () => 0, { mix, temperature: 0 });
      const days: string[] = [];
      for (let day = 1; day <= 60; day += 1) {
        weather.refresh((day - 1) * DAY_TICKS);
        days.push(weather.days[day - weather.firstDay].kind);
      }
      return days.join();
    };
    expect(first([1, 1, 1, 1, 1])).toBe(first(NEUTRAL_CLIMATE.mix));
    expect(first([1, 1, 1, 1, 1])).not.toBe(first([1.2, 2.2, 0.6, 0.25, 0.5]));
  });

  it('drawn days are the saved future: a restored session keeps them even if the biome weights changed', () => {
    const live = new ParkSession(null, [], { mapId: 'emerald-ruins' });
    for (let tick = 0; tick < 3_000; tick += 1) live.step(100);
    live.syncWithWorld();
    const saved = live.weather.serialize();
    const calendar = new ParkCalendar(() => 0, true);
    const other = new WeatherSimulation(0x5eed1234, calendar, 1, () => 3_000, { mix: [0, 0, 1, 0, 0], temperature: 0 });
    other.restore(saved);
    expect(other.serialize()).toEqual(saved);
    expect(hashState(other.serialize())).toBe(hashState(live.weather.serialize()));
  });

  it('the forecast, the weather view and the park conditions work in every biome', () => {
    for (const biome of BIOMES) {
      const map = MAPS.find((candidate) => candidate.biome === biome.id)!;
      const session = new ParkSession(null, [], { mapId: map.id });
      for (let tick = 0; tick < 400; tick += 1) session.step(100);
      expect(session.weatherForecast(8).length, biome.id).toBe(8);
      const view = session.weatherViewInto({ enabled: true, kind: 'sunny', intensity: 0, previousKind: 'sunny', day: 1, slot: 0, segmentProgress: 0, secondsIntoSegment: 0, flashSeed: 0 });
      expect(view.day).toBe(1);
      expect(Number.isFinite(session.weather.conditions.warmFoodBonus)).toBe(true);
      expect(Number.isFinite(session.weather.conditions.coldTreatBonus)).toBe(true);
    }
  });
});
