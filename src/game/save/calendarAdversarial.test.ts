import { describe, expect, it } from 'vitest';
import { ParkCalendar } from '../calendar/ParkCalendar';
import { maximumAnchorUnits } from '../calendar/calendarMath';
import { SCENARIOS } from '../scenarios/content';
import { checkSessionConsistency } from './consistency';
import { SaveError } from './version';
import { ParkSession } from '../session/ParkSession';
import { canonicalJson } from './hash';
import type { ParkSaveV7 } from './state';

const base = (): ParkSaveV7 => structuredClone(new ParkSession(null).serialize());
const load = (mutate: (state: ParkSaveV7) => void): void => {
  const state = base();
  mutate(state);
  ParkSession.fromState(state);
};

describe('calendar adversarial', () => {
  const bad: [string, (s: ParkSaveV7) => void][] = [
    ['NaN length', (s) => { s.calendar.dayLengthSeconds = NaN; }],
    ['zero length', (s) => { s.calendar.dayLengthSeconds = 0; }],
    ['negative length', (s) => { s.calendar.dayLengthSeconds = -720; }],
    ['fractional length', (s) => { s.calendar.dayLengthSeconds = 100.5; }],
    ['huge length', (s) => { s.calendar.dayLengthSeconds = 1e308; }],
    ['negative anchorUnits', (s) => { s.calendar.anchorUnits = -1; }],
    ['float anchorUnits', (s) => { s.calendar.anchorUnits = 0.5; }],
    ['huge anchorUnits', (s) => { s.calendar.anchorUnits = 2 ** 60; }],
    ['negative anchorTick', (s) => { s.calendar.anchorTick = -1; }],
    ['anchorTick > world tick', (s) => { s.calendar.anchorTick = 5; }],
    ['bad lock', (s) => { (s.calendar as unknown as { timeLock: string }).timeLock = 'midnight'; }],
    ['missing calendar', (s) => { delete (s as unknown as Record<string, unknown>).calendar; }],
    ['string length', (s) => { (s.calendar as unknown as { dayLengthSeconds: string }).dayLengthSeconds = '720'; }],
  ];
  for (const [name, mutate] of bad) {
    it(`rejects ${name}`, () => { expect(() => load(mutate)).toThrow(); });
  }

  it('negative zero anchor does not break hashing', () => {
    const s = new ParkSession(null);
    s.calendar.restore({ dayLengthSeconds: 720, anchorTick: -0, anchorUnits: -0, timeLock: 'auto', hoursEnabled: false, openHour: 8, closeHour: 21 });
    expect(() => canonicalJson(s.serialize())).not.toThrow();
  });

  it('scenario park cannot be loaded with a sandbox-edited calendar', () => {
    const def = SCENARIOS[0];
    const s = new ParkSession(def);
    const state = structuredClone(s.serialize());
    state.calendar.dayLengthSeconds = 60;
    state.calendar.timeLock = 'night';
    expect(() => ParkSession.fromState(state)).toThrow();
  });

  it('scenario park refuses each sandbox calendar edit on its own, and a default calendar still loads', () => {
    const state = structuredClone(new ParkSession(SCENARIOS[0]).serialize());
    expect(() => ParkSession.fromState(structuredClone(state))).not.toThrow();
    const edits: Array<[string, (c: typeof state.calendar) => void]> = [
      ['day length', (c) => { c.dayLengthSeconds = 1440; }],
      ['time lock', (c) => { c.timeLock = 'dusk'; }],
      ['anchor', (c) => { c.anchorTick = 0; c.anchorUnits = 500_000; }],
    ];
    for (const [name, edit] of edits) {
      const copy = structuredClone(state);
      edit(copy.calendar);
      expect(() => ParkSession.fromState(copy), name).toThrow();
    }
  });

  it('rejects an implausible anchorUnits for a tick-0 anchor (step 1 finding, fixed)', () => {
    expect(() => load((s) => { s.calendar.anchorUnits = 900_000 * 1_000_000; })).toThrow(SaveError);
    expect(() => load((s) => { s.calendar.anchorUnits = 1; })).toThrow(SaveError);
  });

  it('anchorUnits is accepted at the bound the fastest clock allows and rejected one unit above it', () => {
    const bound = maximumAnchorUnits(6_000);
    const at = (units: number): ParkCalendar => {
      const calendar = new ParkCalendar(() => 6_000);
      calendar.restore({ ...new ParkCalendar(() => 0).serialize(), anchorTick: 6_000, anchorUnits: units });
      return calendar;
    };
    expect(bound).toBe(10_000_000);
    expect(at(bound).anchorUnits).toBe(bound);
    expect(() => at(bound + 1)).toThrow(SaveError);
    // The same rule runs on the plain state, before any owner restores.
    const state = structuredClone(new ParkSession(null).serialize());
    state.world.tick = 6_000;
    state.calendar.anchorTick = 6_000;
    state.calendar.anchorUnits = bound + 1;
    expect(() => checkSessionConsistency(state)).toThrow(SaveError);
  });

  it('extreme tick keeps exact integer arithmetic', () => {
    const s = new ParkSession(null);
    // 2 ** 30 ticks of the fastest clock could have produced about 1.79e12 units, so 1e12 is plausible.
    s.calendar.restore({ dayLengthSeconds: 7200, anchorTick: 2 ** 30, anchorUnits: 1_000_000 * 1_000_000, timeLock: 'auto', hoursEnabled: false, openHour: 8, closeHour: 21 });
    const u = s.calendar.positionUnits(2 ** 31);
    expect(Number.isSafeInteger(u)).toBe(true);
    expect(Number.isFinite(s.calendar.view(2 ** 31).day)).toBe(true);
  });

  it('view at NaN/negative/Infinity tick does not hang or throw', () => {
    const s = new ParkSession(null);
    for (const t of [NaN, -5, Infinity]) {
      const v = s.calendar.view(t);
      expect(typeof v.hour).toBe('number');
    }
  });

  it('repeated length toggles at one tick keep position', () => {
    const s = new ParkSession(null);
    const tick = 12345;
    s.world.tick = tick;
    const before = s.calendar.positionUnits();
    for (let i = 0; i < 100; i += 1) { s.calendar.setDayLength(60); s.calendar.setDayLength(7200); }
    expect(Math.abs(s.calendar.positionUnits() - before)).toBeLessThanOrEqual(1);
  });
});
