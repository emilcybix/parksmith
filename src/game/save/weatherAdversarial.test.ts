import { describe, expect, it } from 'vitest';
import { SCENARIOS } from '../scenarios/content';
import { ParkSession } from '../session/ParkSession';
import type { ParkSaveV7 } from './state';
import { SaveError } from './version';

const run = (session: ParkSession, ticks: number): void => {
  for (let tick = 0; tick < ticks; tick += 1) session.step(100);
};

const base = (): ParkSaveV7 => {
  const session = new ParkSession(null);
  run(session, 20);
  return structuredClone(session.serialize());
};
const load = (mutate: (state: ParkSaveV7) => void, source: ParkSaveV7 = base()): void => {
  const state = structuredClone(source);
  mutate(state);
  ParkSession.fromState(state);
};

interface LooseWeather {
  enabled: unknown;
  severity: unknown;
  chainKind: unknown;
  days: Array<{ kind: string; slots: Array<Record<string, unknown>> }>;
}
const weatherOf = (state: ParkSaveV7): LooseWeather => state.weather as unknown as LooseWeather;

describe('weather adversarial saves', () => {
  const bad: Array<[string, (state: ParkSaveV7) => void]> = [
    ['missing weather', (s) => { delete (s as unknown as Record<string, unknown>).weather; }],
    ['weather is an array', (s) => { (s as unknown as { weather: unknown }).weather = []; }],
    ['enabled is a string', (s) => { weatherOf(s).enabled = 'yes'; }],
    ['unknown severity', (s) => { weatherOf(s).severity = 'extreme'; }],
    ['rngState negative', (s) => { s.weather.rngState = -1; }],
    ['rngState above uint32', (s) => { s.weather.rngState = 2 ** 32; }],
    ['rngState fractional', (s) => { s.weather.rngState = 1.5; }],
    ['rngState NaN', (s) => { s.weather.rngState = NaN; }],
    ['unknown chainKind', (s) => { weatherOf(s).chainKind = 'fog'; }],
    ['chainKind differs from the last day', (s) => { s.weather.chainKind = s.weather.chainKind === 'storm' ? 'sunny' : 'storm'; }],
    ['firstDay zero', (s) => { s.weather.firstDay = 0; }],
    ['firstDay fractional', (s) => { s.weather.firstDay = 1.5; }],
    ['firstDay later than the park day (day not covered)', (s) => { s.weather.firstDay = 5; }],
    ['firstDay 1e9 (day not covered)', (s) => { s.weather.firstDay = 1e9; }],
    ['days far in the future of the park', (s) => { s.weather.days.length = 1; s.weather.firstDay = 1e6; }],
    ['unknown day kind', (s) => { weatherOf(s).days[0].kind = 'fog'; }],
    ['unknown slot kind', (s) => { weatherOf(s).days[0].slots[1].kind = 'hail'; }],
    ['slot intensity NaN', (s) => { weatherOf(s).days[0].slots[0].intensity = NaN; }],
    ['slot intensity above 1', (s) => { weatherOf(s).days[0].slots[2].intensity = 1.01; }],
    ['slot intensity negative', (s) => { weatherOf(s).days[0].slots[3].intensity = -0.1; }],
    ['slot intensity a string', (s) => { weatherOf(s).days[0].slots[0].intensity = '0.5'; }],
    ['three slots in a day', (s) => { weatherOf(s).days[0].slots.pop(); }],
    ['five slots in a day', (s) => { weatherOf(s).days[0].slots.push({ kind: 'sunny', intensity: 0.5 }); }],
    ['a day that is null', (s) => { (weatherOf(s).days as unknown[])[1] = null; }],
    ['10,000 days', (s) => { s.weather.days = Array.from({ length: 10_000 }, () => structuredClone(s.weather.days[0])); }],
    ['days is not an array', (s) => { (s.weather as unknown as { days: unknown }).days = {}; }],
    ['calendar hours enabled as a number', (s) => { (s.calendar as unknown as { hoursEnabled: unknown }).hoursEnabled = 1; }],
    ['open hour before the allowed range', (s) => { s.calendar.openHour = 3; }],
    ['close hour after the allowed range', (s) => { s.calendar.closeHour = 24; }],
    ['open and close too close together', (s) => { s.calendar.openHour = 12; s.calendar.closeHour = 15; }],
    ['fractional hours', (s) => { s.calendar.openHour = 8.5; }],
    ['wet weather rule missing', (s) => { delete (s.rules as unknown as Record<string, unknown>).wetWeatherMultiplier; }],
    ['wet weather rule zero', (s) => { s.rules.wetWeatherMultiplier = 0; }],
    ['wet weather rule enormous', (s) => { s.rules.wetWeatherMultiplier = 1e6; }],
  ];
  for (const [name, mutate] of bad) {
    it(`rejects ${name}`, () => {
      let error: unknown;
      try { load(mutate); } catch (caught) { error = caught; }
      expect(error, name).toBeInstanceOf(SaveError);
    });
  }

  it('the unmodified save loads (the harness itself is sound)', () => {
    expect(() => load(() => undefined)).not.toThrow();
  });

  it('a saved day count that disagrees with a long-running park is refused, a covering one is accepted', () => {
    const session = new ParkSession(null);
    run(session, 7_200 * 2 + 10);
    const state = structuredClone(session.serialize());
    expect(() => load(() => undefined, state)).not.toThrow();
    expect(() => load((s) => { s.weather.days.splice(2); s.weather.firstDay = 1; }, state), 'days 1..2 end before day 3').toThrow(SaveError);
    expect(() => load((s) => { s.weather.firstDay += 5; }, state)).toThrow(SaveError);
  });

  describe('scenario parks keep their fixed weather and hours', () => {
    const scenarioState = (): ParkSaveV7 => structuredClone(new ParkSession(SCENARIOS[0]).serialize());
    const edits: Array<[string, (state: ParkSaveV7) => void]> = [
      ['weather off', (s) => { s.weather.enabled = false; }],
      ['low severity', (s) => { s.weather.severity = 'low'; }],
      ['high severity', (s) => { s.weather.severity = 'high'; }],
      ['hours on', (s) => { s.calendar.hoursEnabled = true; }],
      ['different hours', (s) => { s.calendar.openHour = 9; }],
      ['different closing hour', (s) => { s.calendar.closeHour = 22; }],
    ];
    it('a default scenario save loads', () => {
      expect(() => ParkSession.fromState(scenarioState())).not.toThrow();
    });
    for (const [name, edit] of edits) {
      it(`refuses ${name}`, () => {
        const state = scenarioState();
        edit(state);
        expect(() => ParkSession.fromState(state)).toThrow(SaveError);
      });
    }
  });
});
