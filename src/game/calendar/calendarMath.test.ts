import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { SimulationClock } from '../SimulationClock';
import { ParkSession } from '../session/ParkSession';
import {
  TICKS_PER_SECOND,
  UNITS_PER_DAY,
  createCalendarView,
  formatClock,
  phaseLabelAt,
  viewAt,
  type CalendarAnchor,
} from './calendarMath';

const standard: CalendarAnchor = { dayLengthSeconds: 720, anchorTick: 0, anchorUnits: 0 };
const DAY_TICKS = 720 * TICKS_PER_SECOND;
const at = (tick: number, anchor: CalendarAnchor = standard) => viewAt(createCalendarView(), anchor, 'auto', tick);
const clock = (tick: number): string => { const v = at(tick); return formatClock(v.hour, v.minute); };

describe('calendar arithmetic', () => {
  it('tick 0 is day 1, 06:00; exactly one day later is day 2, 06:00', () => {
    expect(at(0)).toMatchObject({ day: 1, hour: 6, minute: 0, label: 'Dawn', locked: false });
    expect(at(DAY_TICKS)).toMatchObject({ day: 2, hour: 6, minute: 0 });
    expect(at(DAY_TICKS - 1).day).toBe(1);
    expect(at(DAY_TICKS * 5 + 3600).day).toBe(6);
  });

  it('shows whole minutes without lagging a minute behind (5 ticks per game minute at 720 s days)', () => {
    expect(clock(0)).toBe('06:00');
    expect(clock(4)).toBe('06:00');
    expect(clock(5)).toBe('06:01');
    expect(clock(300)).toBe('07:00');
    expect(clock(420)).toBe('07:24');
  });

  it('labels switch at the configured boundaries', () => {
    const { dawnStart, dayStart, duskStart, nightStart } = GAME_CONFIG.calendar.phaseHours;
    expect(phaseLabelAt(dawnStart - 0.017)).toBe('Night');
    expect(phaseLabelAt(dawnStart)).toBe('Dawn');
    expect(phaseLabelAt(dayStart - 0.017)).toBe('Dawn');
    expect(phaseLabelAt(dayStart)).toBe('Day');
    expect(phaseLabelAt(duskStart)).toBe('Dusk');
    expect(phaseLabelAt(nightStart)).toBe('Night');
    expect(phaseLabelAt(0)).toBe('Night');
    // 04:59, 05:00, 08:30, 17:00, 21:30 through the real view (hours from tick 0 = 06:00).
    const tickOf = (h: number, m: number): number => ((((h * 60 + m) - 360 + 1440) % 1440) * 5);
    expect(at(tickOf(4, 59)).label).toBe('Night');
    expect(at(tickOf(5, 0)).label).toBe('Dawn');
    expect(at(tickOf(8, 30)).label).toBe('Day');
    expect(at(tickOf(17, 0)).label).toBe('Dusk');
    expect(at(tickOf(21, 30)).label).toBe('Night');
  });

  it('a fractional tick moves the clock smoothly and never beyond the next whole tick', () => {
    expect(at(10.5).clockFraction).toBeGreaterThan(at(10).clockFraction);
    expect(at(10.5).clockFraction).toBeLessThanOrEqual(at(11).clockFraction);
  });

  it('a fixed time pins the effective time and label but never the day or the raw clock', () => {
    const noon = viewAt(createCalendarView(), standard, 'noon', DAY_TICKS * 2);
    expect(noon).toMatchObject({ day: 3, hour: 12, minute: 30, label: 'Day', locked: true });
    expect(noon.clockFraction).toBeCloseTo(0.25, 6);
    // The raw clock readout (06:00 Dawn at the start of day 3) is untouched by the pinned look.
    expect(noon).toMatchObject({ clockHour: 6, clockMinute: 0, clockLabel: 'Dawn' });
    const auto = at(DAY_TICKS * 2);
    expect([auto.clockHour, auto.clockMinute, auto.clockLabel]).toEqual([auto.hour, auto.minute, auto.label]);
    expect(viewAt(createCalendarView(), standard, 'night', 5).label).toBe('Night');
    expect(viewAt(createCalendarView(), standard, 'dawn', 5).label).toBe('Dawn');
    expect(viewAt(createCalendarView(), standard, 'dusk', 5).label).toBe('Dusk');
  });

  it('a day-length change keeps the position continuous and changes only the slope', () => {
    const tick = 1234;
    const before = at(tick);
    const changed: CalendarAnchor = { dayLengthSeconds: 360, anchorTick: tick, anchorUnits: Math.floor(tick * UNITS_PER_DAY / DAY_TICKS) };
    const after = at(tick, changed);
    expect(after.day).toBe(before.day);
    expect(after.clockFraction).toBe(before.clockFraction);
    // 3600 more ticks at the new 360 s length is exactly one more day.
    expect(at(tick + 3600, changed).day).toBe(before.day + 1);
  });

  it('has no float drift over very long parks (28 years of 1x play stay exact integers)', () => {
    const ticks = 9e9;
    const units = standard.anchorUnits + Math.floor(ticks * UNITS_PER_DAY / DAY_TICKS);
    expect(Number.isSafeInteger(units)).toBe(true);
    expect(Number.isSafeInteger(ticks * UNITS_PER_DAY)).toBe(true);
  });
});

describe('the clock follows the fixed-step simulation', () => {
  const run = (speed: 0 | 1 | 2 | 4, frames: number, frameMs: number) => {
    const session = new ParkSession(null);
    const clockUnderTest = new SimulationClock((ms) => { session.step(ms); });
    clockUnderTest.setSpeed(speed);
    for (let i = 0; i < frames; i += 1) clockUnderTest.update(frameMs);
    return { session, clock: clockUnderTest };
  };

  it('speeds 1/2/4 give 1x/2x/4x game time for the same real time; pause freezes it', () => {
    const ticks = [1, 2, 4].map((speed) => run(speed as 1 | 2 | 4, 60, 100).session.world.tick);
    expect(ticks).toEqual([60, 120, 240]);
    const paused = run(0, 100, 100);
    expect(paused.session.world.tick).toBe(0);
    expect(paused.session.calendarView(paused.session.world.tick + paused.clock.stepFraction)).toEqual(new ParkSession(null).calendarView());
  });

  it('a hitch with catch-up lands on the same tick-derived time as the same real time in small frames', () => {
    const small = run(1, 10, 25).session.calendarView();
    const hitch = run(1, 1, 250).session.calendarView();
    expect(hitch).toEqual(small);
  });

  it('resuming after a pause continues from the paused time of day', () => {
    const { session, clock: sim } = run(1, 30, 100);
    const paused = session.calendarView();
    sim.setSpeed(0);
    for (let i = 0; i < 50; i += 1) sim.update(100);
    expect(session.calendarView()).toEqual(paused);
    sim.setSpeed(1);
    sim.update(100);
    expect(session.world.tick).toBe(31);
  });
});
