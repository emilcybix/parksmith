import { formatClock, type CalendarView, type PhaseLabel, type TimeLock } from '../game/calendar/calendarMath';
import { GAME_CONFIG } from '../game/config';

/**
 * Pure text for the top-bar clock chip and its sandbox popover. The chip shows the REAL clock even when the
 * sandbox pinned the look, and says which look is pinned.
 */

/** The primitives GameApp publishes to the store: no object identity, so an unchanged clock re-renders nothing. */
export interface CalendarUi {
  dayNumber: number;
  clockText: string;
  phaseLabel: PhaseLabel;
  timeLock: TimeLock;
  dayLengthSeconds: number;
  calendarEditable: boolean;
}

export const calendarUiOf = (view: CalendarView, dayLengthSeconds: number, editable: boolean, timeLock: TimeLock): CalendarUi => ({
  dayNumber: view.day,
  clockText: formatClock(view.clockHour, view.clockMinute),
  phaseLabel: view.clockLabel,
  timeLock,
  dayLengthSeconds,
  calendarEditable: editable,
});

export const TIME_LOCK_OPTIONS: ReadonlyArray<{ id: TimeLock; label: string }> = [
  { id: 'auto', label: 'Auto' },
  { id: 'dawn', label: 'Dawn' },
  { id: 'noon', label: 'Noon' },
  { id: 'dusk', label: 'Dusk' },
  { id: 'night', label: 'Night' },
];

/** "6 min" for whole minutes, else "90 s" (a hand-edited save can hold any length in range). */
export const dayLengthText = (seconds: number): string => (
  seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds} s`
);

export const dayLengthOptions = (): ReadonlyArray<{ seconds: number; label: string; detail: string }> => (
  GAME_CONFIG.calendar.dayLengthPresets.map((preset) => ({
    seconds: preset.seconds,
    label: preset.label,
    detail: dayLengthText(preset.seconds),
  }))
);

export const clockAriaLabel = (ui: CalendarUi): string => (
  `Day ${ui.dayNumber}, ${ui.clockText}, ${ui.phaseLabel.toLowerCase()}${ui.timeLock === 'auto' ? '' : `, sky fixed to ${lockLabel(ui.timeLock).toLowerCase()}`}`
  + (ui.calendarEditable ? '. Time settings' : '')
);

const lockLabel = (lock: TimeLock): string => TIME_LOCK_OPTIONS.find((option) => option.id === lock)?.label ?? lock;

/**
 * The second line of the chip: the real clock, "14:20 · Dusk". When the sandbox pinned the look it
 * adds "Night look" after it: the pinned time only changes the sky, never the time shown.
 */
export const clockLine = (ui: CalendarUi): { time: string; phase: string } => ({
  time: ui.clockText,
  phase: ui.timeLock === 'auto' ? ui.phaseLabel : `${ui.phaseLabel} · ${lockLabel(ui.timeLock)} look`,
});
