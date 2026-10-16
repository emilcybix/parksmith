import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { ParkSession } from '../session/ParkSession';
import { SCENARIO_BY_ID } from '../scenarios/content';
import { createStormFlash, stormFlashAt } from './flash';
import { WEATHER_KINDS, createWeatherView, type WeatherKind } from './types';

const SLOT_TICKS = GAME_CONFIG.calendar.defaultDayLengthSeconds * 10 / GAME_CONFIG.weather.slotsPerDay;

/** The tick a (1-based) day and slot start at, at the default day length. */
const tickOf = (day: number, slot: number): number => ((day - 1) * 4 + slot) * SLOT_TICKS;

const sandbox = (): ParkSession => new ParkSession(null);

describe('WeatherSimulation: forecast and horizon', () => {
  it('the forecast is the future: every slot that becomes current matches what was forecast, across day boundaries', () => {
    const session = sandbox();
    const weather = session.weather;
    const view = createWeatherView();
    const recorded = new Map<string, { kind: WeatherKind; intensity: number }>();
    for (let slotIndex = 0; slotIndex < 40; slotIndex += 1) {
      const tick = slotIndex * SLOT_TICKS;
      weather.step(tick);
      // What is current now must be what an earlier forecast promised (after the first two days).
      weather.viewInto(view, tick);
      const promised = recorded.get(`${view.day}:${view.slot}`);
      if (promised) expect({ kind: view.kind, intensity: view.intensity }, `slot ${slotIndex}`).toEqual(promised);
      for (const entry of weather.forecast(8, tick)) recorded.set(`${entry.day}:${entry.slot}`, { kind: entry.kind, intensity: entry.intensity });
    }
    expect(recorded.size).toBeGreaterThan(30);
  });

  it('a day-length change in between does not change a forecast slot (slots follow calendar position)', () => {
    const session = sandbox();
    session.world.tick = 1_000;
    session.weather.step(1_000);
    const before = session.weather.forecast(8);
    session.calendar.setDayLength(360);
    session.weather.refresh();
    expect(session.weather.forecast(8)).toEqual(before);
  });

  it('keeps the current day and two forecast days drawn (and yesterday) at every tick over ten days', () => {
    const session = sandbox();
    const view = createWeatherView();
    for (let tick = 0; tick <= 10 * 7_200; tick += 50) {
      session.weather.step(tick);
      session.weather.viewInto(view, tick);
      const { firstDay, days } = session.weather;
      expect(firstDay, `tick ${tick}`).toBe(Math.max(1, view.day - 1));
      expect(firstDay + days.length - 1, `tick ${tick}`).toBe(view.day + GAME_CONFIG.weather.forecastDays);
      expect(days.length).toBeLessThanOrEqual(4);
    }
  });

  it('forecast lists the next eight slots, starting after the current one', () => {
    const session = sandbox();
    const forecast = session.weather.forecast(8, 0);
    expect(forecast).toHaveLength(8);
    expect(forecast[0]).toMatchObject({ day: 1, slot: 1 });
    expect(forecast[2]).toMatchObject({ day: 1, slot: 3 });
    expect(forecast[3]).toMatchObject({ day: 2, slot: 0 });
  });
});

describe('WeatherSimulation: switches', () => {
  it('weather off keeps the chain advancing and switching it on again matches a never-toggled twin', () => {
    const toggled = sandbox();
    const twin = sandbox();
    toggled.setWeatherEnabled(false);
    for (let tick = 0; tick <= 8 * 7_200; tick += 600) {
      if (tick === 3 * 7_200) toggled.setWeatherEnabled(true);
      toggled.weather.step(tick);
      twin.weather.step(tick);
    }
    expect(toggled.weather.serialize()).toEqual(twin.weather.serialize());
  });

  it('weather off reads as a clear sky and neutral conditions, with an empty forecast', () => {
    const session = sandbox();
    session.weather.forceCurrentSlot('storm', 1);
    expect(session.weather.conditions.stormActive).toBe(true);
    session.setWeatherEnabled(false);
    const view = session.weatherViewInto(createWeatherView());
    expect(view).toMatchObject({ enabled: false, kind: 'sunny', intensity: 0, flashSeed: 0 });
    expect(session.weather.conditions).toMatchObject({ stormActive: false, thirstFactor: 1, walkSpeedFactor: 1, arrivalWeatherFactor: 1 });
    expect(session.weatherForecast()).toEqual([]);
  });

  it('severity scales the intensity but never the kinds', () => {
    const normal = sandbox();
    const high = sandbox();
    const low = sandbox();
    high.setWeatherSeverity('high');
    low.setWeatherSeverity('low');
    normal.weather.step(tickOf(5, 1));
    high.weather.step(tickOf(5, 1));
    low.weather.step(tickOf(5, 1));
    const kinds = (session: ParkSession): string => session.weatherForecast().map((entry) => entry.kind).join();
    expect(kinds(high)).toBe(kinds(normal));
    expect(kinds(low)).toBe(kinds(normal));
    const intensities = (session: ParkSession): number[] => session.weatherForecast().map((entry) => entry.intensity);
    normal.weatherForecast().forEach((entry, index) => {
      expect(high.weatherForecast()[index].intensity).toBeCloseTo(Math.min(1, entry.intensity * GAME_CONFIG.weather.severityScale.high), 10);
      expect(low.weatherForecast()[index].intensity).toBeCloseTo(entry.intensity * GAME_CONFIG.weather.severityScale.low, 10);
    });
    expect(Math.max(...intensities(high))).toBeLessThanOrEqual(1);
    expect(normal.weather.serialize().days).toEqual(high.weather.serialize().days);
  });

  it('a scenario park refuses every weather and hours switch', () => {
    const scenario = new ParkSession(SCENARIO_BY_ID.get('sunny-start')!);
    expect(scenario.setWeatherEnabled(false)).toBe(false);
    expect(scenario.setWeatherSeverity('high')).toBe(false);
    expect(scenario.setOpeningHours(true, 8, 21)).toBe(false);
    expect(scenario.weather.enabled).toBe(true);
    expect(scenario.weather.severity).toBe('normal');
    expect(scenario.calendar.hoursEnabled).toBe(false);
    expect(sandbox().setWeatherSeverity('extreme' as never)).toBe(false);
  });
});

describe('WeatherSimulation: the view', () => {
  it('fills the object it is given and returns it', () => {
    const session = sandbox();
    const out = createWeatherView();
    expect(session.weatherViewInto(out, 100)).toBe(out);
    expect(out).toMatchObject({ enabled: true, day: 1, slot: 0, kind: 'sunny' });
  });

  it('segment progress runs 0..1 through a slot and wraps exactly at the slot edge', () => {
    const session = sandbox();
    const a = createWeatherView();
    const b = createWeatherView();
    session.weatherViewInto(a, SLOT_TICKS - 1);
    session.weatherViewInto(b, SLOT_TICKS);
    expect(a.slot).toBe(0);
    expect(a.segmentProgress).toBeGreaterThan(0.999);
    expect(b.slot).toBe(1);
    expect(b.segmentProgress).toBe(0);
    expect(b.previousKind).toBe(a.kind);
    session.weatherViewInto(a, SLOT_TICKS / 2);
    expect(a.segmentProgress).toBeCloseTo(0.5, 5);
    expect(a.secondsIntoSegment).toBeCloseTo(GAME_CONFIG.calendar.defaultDayLengthSeconds / 8, 5);
  });

  it('is a pure read: the same tick gives the same view however often it is asked (a pause freezes the sky)', () => {
    const session = sandbox();
    const first = { ...session.weatherViewInto(createWeatherView(), 4_321.5) };
    for (let index = 0; index < 5; index += 1) expect(session.weatherViewInto(createWeatherView(), 4_321.5)).toEqual(first);
  });

  it('previous kind at the start of a day comes from the last slot of yesterday', () => {
    const session = sandbox();
    session.weather.step(tickOf(3, 0));
    const view = session.weatherViewInto(createWeatherView(), tickOf(3, 0));
    expect(view.slot).toBe(0);
    expect(session.weather.firstDay).toBe(2);
    expect(view.previousKind).toBe(session.weather.days[0].slots[3].kind);
  });

  it('a storm slot has a flash seed and nothing else does', () => {
    const session = sandbox();
    session.weather.forceCurrentSlot('storm', 0.9);
    const view = session.weatherViewInto(createWeatherView());
    expect(view.kind).toBe('storm');
    expect(view.flashSeed).toBeGreaterThan(0);
    session.weather.forceCurrentSlot('rain', 0.9);
    expect(session.weatherViewInto(createWeatherView()).flashSeed).toBe(0);
  });
});

describe('stormFlashAt', () => {
  it('is deterministic, bounded, frozen for a fixed time and silent without a seed', () => {
    const seed = 0xabcdef;
    for (let seconds = 0; seconds < 180; seconds += 0.05) {
      const flash = stormFlashAt(seed, seconds);
      expect(flash).toEqual(stormFlashAt(seed, seconds));
      expect(flash.strength).toBeGreaterThanOrEqual(0);
      expect(flash.strength).toBeLessThanOrEqual(1);
      expect(stormFlashAt(0, seconds)).toEqual({ strength: 0, boltSeed: 0 });
      if (flash.strength === 0) expect(flash.boltSeed).toBe(0);
      else expect(flash.boltSeed).toBeGreaterThan(0);
    }
  });

  it('flashes happen in a storm slot at about the configured rate, and differ between seeds', () => {
    const cells = 180 / GAME_CONFIG.weather.flash.slotSeconds;
    const flashCells = (seed: number): number => {
      let count = 0;
      for (let cell = 0; cell < cells; cell += 1) {
        let flashed = false;
        for (let step = 0; step < GAME_CONFIG.weather.flash.slotSeconds; step += 0.02) {
          if (stormFlashAt(seed, cell * GAME_CONFIG.weather.flash.slotSeconds + step).strength > 0) { flashed = true; break; }
        }
        if (flashed) count += 1;
      }
      return count;
    };
    let total = 0;
    for (let seed = 1; seed <= 40; seed += 1) total += flashCells(seed * 7919);
    const rate = total / (40 * cells);
    expect(rate).toBeGreaterThan(GAME_CONFIG.weather.flash.chancePerSlot - 0.1);
    expect(rate).toBeLessThan(GAME_CONFIG.weather.flash.chancePerSlot + 0.1);
    const pattern = (seed: number): string => Array.from({ length: 300 }, (_, index) => (stormFlashAt(seed, index * 0.6).strength > 0 ? 1 : 0)).join('');
    expect(pattern(11)).not.toBe(pattern(12));
  });

  it('fills a caller-owned object without allocating a new one', () => {
    const out = createStormFlash();
    expect(stormFlashAt(77, 3, out)).toBe(out);
  });
});

describe('weather kinds', () => {
  it('every kind appears in a long sandbox run (so every effect is reachable)', () => {
    const session = sandbox();
    const seen = new Set<WeatherKind>();
    for (let slot = 0; slot < 4 * 120; slot += 1) {
      session.weather.step(tickOf(1, 0) + slot * SLOT_TICKS);
      seen.add(session.weather.conditions.weatherKind);
    }
    expect([...seen].sort()).toEqual([...WEATHER_KINDS].sort());
  });
});
