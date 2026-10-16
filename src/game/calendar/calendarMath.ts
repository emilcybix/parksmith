import { GAME_CONFIG } from '../config';

/**
 * Pure calendar arithmetic. Nothing here reads or writes the simulation: the day number and the
 * time of day are recomputed from the world tick plus a tiny anchor (see ParkCalendar), so there is
 * no accumulator that could drift, and pausing, speeds and catch-up bursts need no special case.
 */

export const TIME_LOCKS = ['auto', 'dawn', 'noon', 'dusk', 'night'] as const;
export type TimeLock = (typeof TIME_LOCKS)[number];
export type PhaseLabel = 'Dawn' | 'Day' | 'Dusk' | 'Night';

/** Calendar position is counted in millionths of a day, so it is an exact integer. */
export const UNITS_PER_DAY = 1_000_000;
export const TICKS_PER_SECOND = 1000 / GAME_CONFIG.fixedStepMs;

export interface CalendarAnchor {
  dayLengthSeconds: number;
  /** Tick at which the calendar position was `anchorUnits`. */
  anchorTick: number;
  anchorUnits: number;
}

export interface CalendarView {
  /** 1-based; day 1 begins at tick 0. */
  day: number;
  /** Raw clock, 0 = midnight, 0.5 = noon, in [0, 1). Gameplay (step 2) reads this one. */
  clockFraction: number;
  /** What the look and the HUD show: the raw clock unless the sandbox pinned a time of day. */
  effectiveFraction: number;
  /** Hour, minute and phase of the EFFECTIVE time (the look). */
  hour: number;
  minute: number;
  label: PhaseLabel;
  /** Hour, minute and phase of the RAW clock: what the HUD reads, so a fixed look never hides the time. */
  clockHour: number;
  clockMinute: number;
  clockLabel: PhaseLabel;
  locked: boolean;
}

const MINUTES_PER_DAY = GAME_CONFIG.calendar.hoursPerDay * 60;
const MINUTE_EPSILON = 0.002;

export const dayTicksOf = (dayLengthSeconds: number): number => dayLengthSeconds * TICKS_PER_SECOND;

/**
 * Calendar position in 1e-6 day at `tick` (may carry a fraction of a tick). Floors, so for whole
 * ticks it is exact integer arithmetic.
 */
export const positionUnitsAt = (anchor: CalendarAnchor, tick: number): number => (
  anchor.anchorUnits + Math.floor(Math.max(0, tick - anchor.anchorTick) * UNITS_PER_DAY / dayTicksOf(anchor.dayLengthSeconds))
);

/**
 * Opening hours on the RAW clock: open from `openHour` (inclusive) to `closeHour` (exclusive).
 * Hours off means the gate is always open. No overnight wrap (open < close), by validation.
 */
export const isScheduleOpen = (hoursEnabled: boolean, openHour: number, closeHour: number, clockFraction: number): boolean => {
  if (!hoursEnabled) return true;
  const hour = clockFraction * GAME_CONFIG.calendar.hoursPerDay;
  return hour >= openHour && hour < closeHour;
};

/**
 * The largest anchor position a calendar anchored at `anchorTick` can plausibly hold: the shortest
 * allowed day is the fastest clock, and every re-anchor floors, so no real history exceeds this.
 */
export const maximumAnchorUnits = (anchorTick: number): number => (
  Math.floor(anchorTick * UNITS_PER_DAY / dayTicksOf(GAME_CONFIG.calendar.minDayLengthSeconds))
);

export const phaseLabelAt = (hour: number): PhaseLabel => {
  const { dawnStart, dayStart, duskStart, nightStart } = GAME_CONFIG.calendar.phaseHours;
  if (hour >= dawnStart && hour < dayStart) return 'Dawn';
  if (hour >= dayStart && hour < duskStart) return 'Day';
  if (hour >= duskStart && hour < nightStart) return 'Dusk';
  return 'Night';
};

const wrap01 = (value: number): number => {
  const wrapped = value % 1;
  return wrapped < 0 ? wrapped + 1 : wrapped;
};

/** The clock fraction (0 = midnight) a position in day units corresponds to. */
export const clockFractionOf = (positionUnits: number): number => (
  wrap01((positionUnits % UNITS_PER_DAY) / UNITS_PER_DAY + GAME_CONFIG.calendar.startHour / GAME_CONFIG.calendar.hoursPerDay)
);

export const fixedFractionOf = (lock: Exclude<TimeLock, 'auto'>): number => (
  GAME_CONFIG.calendar.fixedTimeHours[lock] / GAME_CONFIG.calendar.hoursPerDay
);

const minuteOfDay = (fraction: number): number => (
  Math.floor(fraction * MINUTES_PER_DAY + MINUTE_EPSILON) % MINUTES_PER_DAY
);

/** Fills `out` (so a per-frame caller can reuse one object) and returns it. */
export const viewAt = (out: CalendarView, anchor: CalendarAnchor, lock: TimeLock, tick: number): CalendarView => {
  const units = positionUnitsAt(anchor, tick);
  const clock = clockFractionOf(units);
  const effective = lock === 'auto' ? clock : fixedFractionOf(lock);
  // Position is floored to 1e-6 day, so an exact minute boundary lands up to 0.0015 minute short;
  // the nudge keeps 06:05 showing as 06:05 instead of 06:04 for the whole minute.
  const totalMinutes = minuteOfDay(effective);
  const clockMinutes = lock === 'auto' ? totalMinutes : minuteOfDay(clock);
  const hours = totalMinutes / 60;
  out.day = Math.floor(units / UNITS_PER_DAY) + 1;
  out.clockFraction = clock;
  out.effectiveFraction = effective;
  out.hour = Math.floor(totalMinutes / 60);
  out.minute = totalMinutes % 60;
  out.label = phaseLabelAt(hours);
  out.clockHour = Math.floor(clockMinutes / 60);
  out.clockMinute = clockMinutes % 60;
  out.clockLabel = phaseLabelAt(clockMinutes / 60);
  out.locked = lock !== 'auto';
  return out;
};

export const createCalendarView = (): CalendarView => ({
  day: 1, clockFraction: 0, effectiveFraction: 0, hour: 0, minute: 0, label: 'Night', clockHour: 0, clockMinute: 0, clockLabel: 'Night', locked: false,
});

/** "14:05". */
export const formatClock = (hour: number, minute: number): string => (
  `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
);
