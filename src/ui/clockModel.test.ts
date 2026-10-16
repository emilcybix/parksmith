import { describe, expect, it } from 'vitest';
import { createCalendarView, viewAt } from '../game/calendar/calendarMath';
import { calendarUiOf, clockAriaLabel, clockLine, dayLengthOptions, dayLengthText } from './clockModel';

const anchor = { dayLengthSeconds: 720, anchorTick: 0, anchorUnits: 0 };
const ui = (tick: number, lock: 'auto' | 'night' = 'auto', editable = true) => (
  calendarUiOf(viewAt(createCalendarView(), anchor, lock, tick), 720, editable, lock)
);

describe('clock chip text', () => {
  it('shows day, hh:mm and the phase for a spread of times', () => {
    expect(ui(0)).toMatchObject({ dayNumber: 1, clockText: '06:00', phaseLabel: 'Dawn' });
    expect(ui(1800)).toMatchObject({ clockText: '12:00', phaseLabel: 'Day' });
    expect(ui(3600)).toMatchObject({ clockText: '18:00', phaseLabel: 'Dusk' });
    expect(ui(5400)).toMatchObject({ clockText: '00:00', phaseLabel: 'Night' });
    expect(ui(7200 + 15)).toMatchObject({ dayNumber: 2, clockText: '06:03' });
  });

  it('says "fixed" when the sandbox pinned the time, and the aria label says so too', () => {
    expect(clockLine(ui(0))).toEqual({ time: '06:00', phase: 'Dawn' });
    // The chip keeps the real clock (12:00, Day) and names the pinned look separately.
    const locked = ui(1800, 'night');
    expect(clockLine(locked)).toEqual({ time: '12:00', phase: 'Day · Night look' });
    expect(locked).toMatchObject({ dayNumber: 1, clockText: '12:00', phaseLabel: 'Day', timeLock: 'night' });
    expect(clockAriaLabel(locked)).toBe('Day 1, 12:00, day, sky fixed to night. Time settings');
    // The real clock keeps moving under a lock.
    expect(ui(1800 + 15, 'night').clockText).toBe('12:03');
  });

  it('a scenario park gets a readout without the settings hint', () => {
    expect(clockAriaLabel(ui(0, 'auto', false))).toBe('Day 1, 06:00, dawn');
  });

  it('describes day lengths in real time', () => {
    expect(dayLengthText(360)).toBe('6 min');
    expect(dayLengthText(2880)).toBe('48 min');
    expect(dayLengthText(90)).toBe('90 s');
    expect(dayLengthOptions().map((option) => [option.label, option.detail])).toEqual([
      ['Brisk', '6 min'], ['Standard', '12 min'], ['Relaxed', '24 min'], ['Leisurely', '48 min'],
    ]);
  });
});
