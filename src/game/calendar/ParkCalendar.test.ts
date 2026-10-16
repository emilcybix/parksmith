import { describe, expect, it } from 'vitest';
import { SCENARIO_BY_ID } from '../scenarios/content';
import { hashState } from '../save/hash';
import { checkSessionConsistency } from '../save/consistency';
import type { CalendarState } from '../save/state';
import { SaveError } from '../save/version';
import { ParkSession } from '../session/ParkSession';
import { UNITS_PER_DAY } from './calendarMath';
import { ParkCalendar } from './ParkCalendar';

const rig = () => {
  const state = { tick: 0 };
  return { state, calendar: new ParkCalendar(() => state.tick) };
};

describe('ParkCalendar', () => {
  it('defaults to a 720 s day that starts at 06:00', () => {
    const { calendar } = rig();
    expect(calendar.serialize()).toEqual({ dayLengthSeconds: 720, anchorTick: 0, anchorUnits: 0, timeLock: 'auto', hoursEnabled: false, openHour: 8, closeHour: 21 });
    expect(calendar.view()).toMatchObject({ day: 1, hour: 6, minute: 0 });
  });

  it('changing the length keeps position, day and clock fraction identical at that tick, then follows the new slope', () => {
    const { state, calendar } = rig();
    state.tick = 3001;
    const before = calendar.positionUnits();
    const view = calendar.view();
    expect(calendar.setDayLength(360)).toBe(true);
    expect(calendar.positionUnits()).toBe(before);
    expect(calendar.view()).toEqual(view);
    state.tick += 3600;
    expect(calendar.positionUnits()).toBe(before + UNITS_PER_DAY);
    const anchored = calendar.serialize();
    expect(calendar.setDayLength(360), 'same length is a no-op').toBe(true);
    expect(calendar.serialize()).toEqual(anchored);
  });

  it('never moves backwards over random length changes and jumps less than one unit at a change', () => {
    let seed = 7;
    const random = (): number => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
    const { state, calendar } = rig();
    const lengths = [60, 360, 720, 1440, 2880, 7200];
    let last = 0;
    for (let i = 0; i < 400; i += 1) {
      state.tick += Math.floor(random() * 500);
      if (random() < 0.4) {
        const preChange = calendar.positionUnits();
        calendar.setDayLength(lengths[Math.floor(random() * lengths.length)]);
        expect(Math.abs(calendar.positionUnits() - preChange)).toBeLessThan(1);
      }
      const now = calendar.positionUnits();
      expect(now).toBeGreaterThanOrEqual(last);
      last = now;
    }
  });

  it('rejects invalid lengths and locks, and every setter is refused in a scenario park', () => {
    const { calendar } = rig();
    for (const bad of [0, 59, 7201, 720.5, Number.NaN, -720]) expect(calendar.setDayLength(bad), String(bad)).toBe(false);
    expect(calendar.setTimeLock('midnight' as never)).toBe(false);
    expect(calendar.dayLengthSeconds).toBe(720);

    const scenario = new ParkSession(SCENARIO_BY_ID.get('sunny-start')!);
    expect(scenario.calendar.isEditable).toBe(false);
    expect(scenario.calendar.setDayLength(360)).toBe(false);
    expect(scenario.calendar.setTimeLock('night')).toBe(false);
    expect(scenario.calendar.serialize().timeLock).toBe('auto');
  });

  it('a time lock changes only the look time, never the day count or the raw clock', () => {
    const { state, calendar } = rig();
    state.tick = 7200 + 1800;
    const raw = calendar.view();
    calendar.setTimeLock('night');
    const locked = calendar.view();
    expect(locked.day).toBe(raw.day);
    expect(locked.clockFraction).toBe(raw.clockFraction);
    expect(locked.effectiveFraction).toBe(0);
    expect(locked.locked).toBe(true);
  });

  it('serialize and restore round trip exactly, and restore validates before it mutates', () => {
    const { state, calendar } = rig();
    state.tick = 999;
    calendar.setDayLength(1440);
    calendar.setTimeLock('dusk');
    const saved = calendar.serialize();
    const other = rig().calendar;
    other.restore(JSON.parse(JSON.stringify(saved)) as CalendarState);
    expect(other.serialize()).toEqual(saved);

    const bads: Array<Partial<CalendarState>> = [
      { dayLengthSeconds: 59 }, { dayLengthSeconds: 7201 }, { dayLengthSeconds: 720.5 },
      { anchorTick: -1 }, { anchorTick: 1.5 }, { anchorUnits: -1 }, { anchorUnits: Number.NaN },
      { timeLock: 'noonish' as never },
    ];
    for (const bad of bads) {
      const target = rig().calendar;
      expect(() => target.restore({ ...saved, ...bad }), JSON.stringify(bad)).toThrow(SaveError);
      expect(target.serialize(), 'untouched after a refusal').toEqual({ dayLengthSeconds: 720, anchorTick: 0, anchorUnits: 0, timeLock: 'auto', hoursEnabled: false, openHour: 8, closeHour: 21 });
    }
  });

  it('adoptSettings keeps the position of the rewound tick and takes the live length and lock', () => {
    const { state, calendar } = rig();
    state.tick = 500;
    const position = calendar.positionUnits();
    calendar.adoptSettings({ dayLengthSeconds: 2880, timeLock: 'dawn', hoursEnabled: false, openHour: 8, closeHour: 21 });
    expect(calendar.positionUnits()).toBe(position);
    expect(calendar.dayLengthSeconds).toBe(2880);
    expect(calendar.timeLock).toBe('dawn');
  });
});

describe('ParkCalendar opening hours', () => {
  it('start off at 08:00 to 21:00 and round trip through the saved state', () => {
    const { calendar } = rig();
    expect(calendar).toMatchObject({ hoursEnabled: false, openHour: 8, closeHour: 21 });
    expect(calendar.setOpeningHours(true, 6, 23)).toBe(true);
    const saved = calendar.serialize();
    expect(saved).toMatchObject({ hoursEnabled: true, openHour: 6, closeHour: 23 });
    const target = rig().calendar;
    target.restore(saved);
    expect(target.serialize()).toEqual(saved);
  });

  it('validates range, whole hours and the minimum span, and refuses without changing anything', () => {
    const { calendar } = rig();
    const before = calendar.serialize();
    for (const [open, close] of [[4, 21], [13, 21], [8, 14], [8, 24], [8.5, 21], [8, 21.5], [12, 15], [Number.NaN, 21], [8, Infinity]] as const) {
      expect(calendar.setOpeningHours(true, open, close), `${open}-${close}`).toBe(false);
    }
    expect(calendar.setOpeningHours('yes' as never, 8, 21)).toBe(false);
    expect(calendar.serialize()).toEqual(before);
    expect(calendar.setOpeningHours(true, 5, 23)).toBe(true);
    expect(calendar.setOpeningHours(true, 12, 18)).toBe(true);
    expect(calendar.setOpeningHours(false, 8, 21)).toBe(true);
  });

  it('are refused in a scenario park and restore refuses bad saved hours', () => {
    const scenario = new ParkCalendar(() => 0, false);
    expect(scenario.setOpeningHours(true, 8, 21)).toBe(false);
    const target = rig().calendar;
    const saved = target.serialize();
    for (const bad of [{ hoursEnabled: 1 }, { openHour: 3 }, { closeHour: 25 }, { openHour: 12, closeHour: 15 }, { openHour: 8.5 }]) {
      expect(() => target.restore({ ...saved, ...bad } as never), JSON.stringify(bad)).toThrow(SaveError);
    }
    expect(target.serialize()).toEqual(saved);
  });

  it('adoptSettings carries hours as well as length and lock', () => {
    const { calendar } = rig();
    calendar.adoptSettings({ dayLengthSeconds: 720, timeLock: 'auto', hoursEnabled: true, openHour: 7, closeHour: 22 });
    expect(calendar).toMatchObject({ hoursEnabled: true, openHour: 7, closeHour: 22 });
  });
});

describe('the calendar inside a park', () => {
  const advance = (session: ParkSession, ticks: number): void => {
    for (let i = 0; i < ticks; i += 1) session.step(100);
  };

  it('is part of the saved state: round trip, equal hash, same day and clock', () => {
    const session = new ParkSession(null);
    advance(session, 50);
    session.calendar.setDayLength(60);
    advance(session, 700);
    session.calendar.setTimeLock('noon');
    const state = session.serialize();
    expect(state.calendar).toMatchObject({ dayLengthSeconds: 60, anchorTick: 50, timeLock: 'noon' });
    const loaded = ParkSession.fromState(JSON.parse(JSON.stringify(state)) as typeof state);
    expect(hashState(loaded.serialize())).toBe(hashState(state));
    expect(loaded.calendarView()).toEqual(session.calendarView());
    advance(session, 400);
    advance(loaded, 400);
    expect(loaded.calendarView()).toEqual(session.calendarView());
  });

  it('the day count is part of the state hash', () => {
    const left = new ParkSession(null);
    const right = new ParkSession(null);
    expect(hashState(left.serialize())).toBe(hashState(right.serialize()));
    right.calendar.setDayLength(60);
    expect(hashState(left.serialize())).not.toBe(hashState(right.serialize()));
  });

  it('refuses a save whose calendar anchor is later than the world tick, and a bad calendar', () => {
    const state = new ParkSession(null).serialize();
    expect(() => checkSessionConsistency({ ...state, calendar: { ...state.calendar, anchorTick: 5 } })).toThrow(SaveError);
    expect(() => ParkSession.fromState({ ...state, calendar: { ...state.calendar, anchorTick: 5 } })).toThrow(SaveError);
    expect(() => ParkSession.fromState({ ...state, calendar: { ...state.calendar, dayLengthSeconds: 5 } })).toThrow(SaveError);
    expect(() => ParkSession.fromState({ ...state, calendar: undefined as never })).toThrow(SaveError);
  });
});
