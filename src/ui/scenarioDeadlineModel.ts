import { GAME_CONFIG } from '../game/config';
import type { ScenarioSnapshot } from '../game/scenarios/types';

/**
 * Deadline text for scenarios. A deadline authored in days reads in days ("1.4 days left",
 * "2 days (24:00)"); one authored in seconds keeps the m:ss form. Park time (m:ss) is always
 * available because the simulation counts seconds.
 */

export const formatParkClock = (seconds: number): string => {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

const daysText = (days: number): string => `${Number.isInteger(days) ? days : days.toFixed(2).replace(/0$/, '')} day${days === 1 ? '' : 's'}`;

type DeadlineSource = Pick<ScenarioSnapshot, 'timeLimitDays' | 'timeLimitSeconds' | 'remainingDays' | 'remainingSeconds'>;

/** Seconds per park day in a scenario park at the default rules, for callers that convert. */
export const SCENARIO_DAY_SECONDS = GAME_CONFIG.calendar.defaultDayLengthSeconds;

/**
 * The running countdown: "1.4 days left" for a day-based scenario, "9:30" otherwise. The deadline is fixed in seconds
 * (`days * 720`), so under a day-length card (Phase 25, a park whose days are not 720 s) "days left" would not match the
 * park's own clock: such a park counts down in park time instead ("9:30 left").
 */
export const countdownText = (snapshot: DeadlineSource, dayLengthSeconds: number = SCENARIO_DAY_SECONDS): string => (
  snapshot.timeLimitDays === null
    ? formatParkClock(snapshot.remainingSeconds)
    : snapshot.remainingDays < 0.1 || dayLengthSeconds !== SCENARIO_DAY_SECONDS
      ? `${formatParkClock(snapshot.remainingSeconds)} left`
      : `${daysText(Math.ceil(snapshot.remainingDays * 100) / 100)} left`
);

/** The whole allowance: "2 days (24:00 min)" for a day-based scenario, "15:00" otherwise. */
export const timeLimitText = (definition: { timeLimitDays?: number; timeLimitSeconds: number }): string => (
  definition.timeLimitDays === undefined
    ? formatParkClock(definition.timeLimitSeconds)
    : `${daysText(definition.timeLimitDays)} (${formatParkClock(definition.timeLimitSeconds)} min)`
);
