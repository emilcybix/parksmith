import { GAME_CONFIG } from '../config';
import { plainNumber } from '../save/plainData';
import { MAXIMUM_SAVED_COUNTER } from '../save/ranges';
import type { CalendarState, Serializable } from '../save/state';
import { invalidState } from '../save/version';
import {
  TIME_LOCKS,
  maximumAnchorUnits,
  UNITS_PER_DAY,
  createCalendarView,
  positionUnitsAt,
  viewAt,
  type CalendarView,
  type TimeLock,
} from './calendarMath';

/** Largest integer anchor position we accept before the tick-based bound: a million days. */
const MAXIMUM_ANCHOR_UNITS = 1_000_000 * UNITS_PER_DAY;

/** The settings a player chooses; undo carries them across a rewind (see adoptSettings). */
export type CalendarSettings = Pick<CalendarState, 'dayLengthSeconds' | 'timeLock' | 'hoursEnabled' | 'openHour' | 'closeHour'>;

/** True when the hours are integers inside the configured ranges and open for at least minSpan hours. */
export const validOpeningHours = (open: unknown, close: unknown): boolean => {
  const { openRange, closeRange, minSpan } = GAME_CONFIG.calendar.hours;
  return typeof open === 'number' && typeof close === 'number' && Number.isInteger(open) && Number.isInteger(close)
    && open >= openRange[0] && open <= openRange[1] && close >= closeRange[0] && close <= closeRange[1]
    && close - open >= minSpan;
};

/**
 * The park calendar. It never steps: the day and the time of day are a pure function of the world
 * tick (read through `getTick`) and this small state. The state exists only so a sandbox day-length
 * change keeps the clock continuous (the new length applies from the change onwards, from the
 * position the clock had at that tick). Presentation reads `view()`; nothing flows back.
 */
export class ParkCalendar implements Serializable<CalendarState> {
  dayLengthSeconds: number = GAME_CONFIG.calendar.defaultDayLengthSeconds;
  anchorTick = 0;
  anchorUnits = 0;
  timeLock: TimeLock = 'auto';
  hoursEnabled: boolean = GAME_CONFIG.calendar.hours.defaultEnabled;
  openHour: number = GAME_CONFIG.calendar.hours.defaultOpen;
  closeHour: number = GAME_CONFIG.calendar.hours.defaultClose;

  constructor(
    private readonly getTick: () => number,
    private readonly editable: boolean = true,
    /**
     * The day length a NEW park starts with (Phase 25: a Scenario or run park plays `round(720 x dayLengthMultiplier)`).
     * An integer within the configured range; a restore overwrites it with the saved calendar.
     */
    initialDayLengthSeconds: number = GAME_CONFIG.calendar.defaultDayLengthSeconds,
  ) {
    if (!Number.isInteger(initialDayLengthSeconds)
      || initialDayLengthSeconds < GAME_CONFIG.calendar.minDayLengthSeconds
      || initialDayLengthSeconds > GAME_CONFIG.calendar.maxDayLengthSeconds) {
      throw new RangeError(`ParkCalendar: initial day length ${initialDayLengthSeconds} is not an integer in range`);
    }
    this.dayLengthSeconds = initialDayLengthSeconds;
  }

  /** Sandbox only: a scenario park has a fixed day length so day deadlines stay fair. */
  get isEditable(): boolean {
    return this.editable;
  }

  /** Calendar position in 1e-6 day at `tick` (default: now). */
  positionUnits(tick: number = this.getTick()): number {
    return positionUnitsAt(this, tick);
  }

  /** A fresh object, safe to keep. `tick` may carry the interpolation fraction. */
  view(tick: number = this.getTick()): CalendarView {
    return viewAt(createCalendarView(), this, this.timeLock, tick);
  }

  /** Per-frame variant: fills an object the caller owns. */
  viewInto(out: CalendarView, tick: number = this.getTick()): CalendarView {
    return viewAt(out, this, this.timeLock, tick);
  }

  setDayLength(seconds: number): boolean {
    if (!this.editable) return false;
    if (!Number.isInteger(seconds)
      || seconds < GAME_CONFIG.calendar.minDayLengthSeconds
      || seconds > GAME_CONFIG.calendar.maxDayLengthSeconds) return false;
    if (seconds === this.dayLengthSeconds) return true;
    const tick = this.getTick();
    const units = this.positionUnits(tick);
    this.anchorUnits = units;
    this.anchorTick = tick;
    this.dayLengthSeconds = seconds;
    return true;
  }

  setTimeLock(lock: TimeLock): boolean {
    if (!this.editable || !TIME_LOCKS.includes(lock)) return false;
    if (lock !== this.timeLock) {
      this.timeLock = lock;
    }
    return true;
  }

  /** Sandbox only: park opening hours on the raw clock. Refused when out of range or too short. */
  setOpeningHours(enabled: boolean, open: number, close: number): boolean {
    if (!this.editable || typeof enabled !== 'boolean' || !validOpeningHours(open, close)) return false;
    this.hoursEnabled = enabled;
    this.openHour = open;
    this.closeHour = close;
    return true;
  }

  /**
   * Undo rewinds the calendar with the park, but the two settings are player choices about how to
   * play and survive it (like the First Day dismissals). Called on the session an undo swapped in,
   * with the live session's settings: the length change re-anchors at the rewound tick, so the
   * position stays the snapshot's and only the slope going forward is the chosen one.
   */
  adoptSettings(live: CalendarSettings): void {
    this.setDayLength(live.dayLengthSeconds);
    this.setTimeLock(live.timeLock);
    this.setOpeningHours(live.hoursEnabled, live.openHour, live.closeHour);
  }

  serialize(): CalendarState {
    return {
      dayLengthSeconds: plainNumber(this.dayLengthSeconds, 'dayLengthSeconds'),
      anchorTick: plainNumber(this.anchorTick, 'anchorTick'),
      anchorUnits: plainNumber(this.anchorUnits, 'anchorUnits'),
      timeLock: this.timeLock,
      hoursEnabled: this.hoursEnabled,
      openHour: plainNumber(this.openHour, 'openHour'),
      closeHour: plainNumber(this.closeHour, 'closeHour'),
    };
  }

  restore(state: CalendarState): void {
    const length: unknown = state?.dayLengthSeconds;
    if (typeof length !== 'number' || !Number.isInteger(length)
      || length < GAME_CONFIG.calendar.minDayLengthSeconds || length > GAME_CONFIG.calendar.maxDayLengthSeconds) {
      throw invalidState('ParkCalendar', 'dayLengthSeconds',
        `must be an integer in ${GAME_CONFIG.calendar.minDayLengthSeconds}..${GAME_CONFIG.calendar.maxDayLengthSeconds}`);
    }
    const tick: unknown = state.anchorTick;
    if (typeof tick !== 'number' || !Number.isInteger(tick) || tick < 0 || tick > MAXIMUM_SAVED_COUNTER) {
      throw invalidState('ParkCalendar', 'anchorTick', 'must be an integer >= 0');
    }
    const units: unknown = state.anchorUnits;
    if (typeof units !== 'number' || !Number.isInteger(units) || units < 0 || units > MAXIMUM_ANCHOR_UNITS) {
      throw invalidState('ParkCalendar', 'anchorUnits', 'must be an integer >= 0');
    }
    if (units > maximumAnchorUnits(tick)) {
      throw invalidState('ParkCalendar', 'anchorUnits', `${units} exceeds what anchorTick ${tick} can have produced (at most ${maximumAnchorUnits(tick)})`);
    }
    const lock: unknown = state.timeLock;
    if (typeof lock !== 'string' || !(TIME_LOCKS as readonly string[]).includes(lock)) {
      throw invalidState('ParkCalendar', 'timeLock', `must be one of ${TIME_LOCKS.join(', ')}`);
    }
    const hoursEnabled: unknown = state.hoursEnabled;
    if (typeof hoursEnabled !== 'boolean') throw invalidState('ParkCalendar', 'hoursEnabled', 'must be a boolean');
    if (!validOpeningHours(state.openHour, state.closeHour)) {
      throw invalidState('ParkCalendar', 'openHour', 'and closeHour must be integers inside the configured ranges, at least the minimum span apart');
    }
    this.dayLengthSeconds = length;
    this.hoursEnabled = hoursEnabled;
    this.openHour = state.openHour;
    this.closeHour = state.closeHour;
    this.anchorTick = tick;
    this.anchorUnits = units;
    this.timeLock = lock as TimeLock;
  }
}
