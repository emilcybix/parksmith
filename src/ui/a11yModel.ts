import type { NotificationClass } from '../settings/notify';

/**
 * The pure rules behind the keyboard and screen-reader behaviour of the HUD: which item a roving
 * arrow key lands on, which live region a message goes to, and when a changing summary is worth
 * saying aloud. No DOM and no store, so every rule is a unit test; the components only apply them.
 */

// ---------------------------------------------------------------------------------------------
// Roving focus (tablists, the build card grid, the sort buttons)
// ---------------------------------------------------------------------------------------------

export interface RovingOptions {
  /** `horizontal`: Left/Right move (a tablist). `both`: a grid, where Up/Down move by one row. */
  readonly orientation: 'horizontal' | 'vertical' | 'both';
  /** Items per row for `both`; at least 1. */
  readonly columns?: number;
  /** Wrap at the ends (tablists do, a grid does not move past its last row). Default true. */
  readonly wrap?: boolean;
}

/**
 * Where focus goes when `key` is pressed on item `index` of `count`, or null when the key is not
 * a navigation key of this widget (so the browser keeps it). Home/End always work. Disabled items
 * are the caller's business: pass only the focusable ones.
 */
export const rovingTarget = (key: string, index: number, count: number, options: RovingOptions): number | null => {
  if (count <= 0) return null;
  const wrap = options.wrap ?? true;
  const columns = Math.max(1, Math.floor(options.columns ?? 1));
  const clamp = (next: number): number => {
    if (wrap) return ((next % count) + count) % count;
    return Math.min(count - 1, Math.max(0, next));
  };
  const horizontal = options.orientation !== 'vertical';
  const vertical = options.orientation !== 'horizontal';
  switch (key) {
    case 'Home': return 0;
    case 'End': return count - 1;
    case 'ArrowRight': return horizontal ? clamp(index + 1) : null;
    case 'ArrowLeft': return horizontal ? clamp(index - 1) : null;
    case 'ArrowDown': {
      if (!vertical) return null;
      if (options.orientation === 'vertical') return clamp(index + 1);
      // Grid: one row down, staying in the column; the last, shorter row clamps to its last item.
      const next = index + columns;
      if (next < count) return next;
      return wrap ? index % columns : (Math.floor((count - 1) / columns) > Math.floor(index / columns) ? count - 1 : index);
    }
    case 'ArrowUp': {
      if (!vertical) return null;
      if (options.orientation === 'vertical') return clamp(index - 1);
      const next = index - columns;
      if (next >= 0) return next;
      if (!wrap) return index;
      // Wrapping up from the first row lands on the last row in the same column (or its last item).
      const lastRowStart = Math.floor((count - 1) / columns) * columns;
      return Math.min(count - 1, lastRowStart + (index % columns));
    }
    default: return null;
  }
};

/** Roving tabindex: exactly one item of the group is a tab stop. */
export const rovingTabIndex = (itemIndex: number, stopIndex: number): 0 | -1 => (itemIndex === stopIndex ? 0 : -1);

/** The tab stop of a group: the remembered item when it still exists, else the preferred one, else the first. */
export const rovingStop = (count: number, remembered: number | null, preferred: number | null): number => {
  if (count <= 0) return 0;
  if (remembered !== null && remembered >= 0 && remembered < count) return remembered;
  if (preferred !== null && preferred >= 0 && preferred < count) return preferred;
  return 0;
};

/** Items per row, from the vertical offset of each item in DOM order (the grid is CSS auto-fill). */
export const columnsFromOffsets = (offsetTops: readonly number[]): number => {
  if (offsetTops.length === 0) return 1;
  const first = offsetTops[0];
  let columns = 0;
  for (const top of offsetTops) {
    if (Math.abs(top - first) > 2) break;
    columns += 1;
  }
  return Math.max(1, columns);
};

// ---------------------------------------------------------------------------------------------
// Announcements
// ---------------------------------------------------------------------------------------------

export type LivePoliteness = 'polite' | 'assertive';

/**
 * Which live region a toast goes to. Refusals and alerts ("not enough cash", "cannot build here")
 * interrupt (assertive, role=alert); everything else waits its turn (polite, role=status).
 */
export const toastPoliteness = (cls: NotificationClass): LivePoliteness => (cls === 'alert' ? 'assertive' : 'polite');

/** Routine confirmations closer together than this are dropped from the announcement (the eye still sees them). */
export const ROUTINE_ANNOUNCE_GAP_MS = 1500;

export interface ToastAnnounceState {
  /** The last announced text and class, and when. */
  readonly text: string | null;
  readonly cls: NotificationClass | null;
  readonly at: number;
}

export const NO_TOAST_ANNOUNCED: ToastAnnounceState = { text: null, cls: null, at: -Infinity };

export interface ToastAnnouncement {
  readonly state: ToastAnnounceState;
  /** Text for the region to show now, or null to leave the regions as they are. */
  readonly say: { readonly text: string; readonly politeness: LivePoliteness } | null;
}

/**
 * Decides what the toast live regions say when the visible toast changes. A toast that clears says
 * nothing (the regions are emptied by the component). The same text again is said again only for
 * alerts (a refused click twice is two refusals); routine and important repeats are dropped, and
 * routine messages are rate-limited so dragging a long path cannot turn into a stream of speech.
 */
export const planToastAnnouncement = (
  previous: ToastAnnounceState,
  text: string | null,
  cls: NotificationClass,
  now: number,
): ToastAnnouncement => {
  if (text === null || text === '') return { state: previous, say: null };
  const repeat = previous.text === text && now - previous.at < 4000;
  if (cls === 'alert') return { state: { text, cls, at: now }, say: { text, politeness: 'assertive' } };
  if (repeat) return { state: previous, say: null };
  if (cls === 'routine' && previous.cls === 'routine' && now - previous.at < ROUTINE_ANNOUNCE_GAP_MS) {
    return { state: previous, say: null };
  }
  return { state: { text, cls, at: now }, say: { text, politeness: 'polite' } };
};

export interface PulseAnnounceInput {
  /** Short, stable sentences: weather and opening-hours lines and guest thoughts, without their counts. */
  readonly lines: readonly string[];
}

export interface PulseAnnounceState {
  readonly lines: readonly string[];
  readonly at: number;
}

export const NO_PULSE_ANNOUNCED: PulseAnnounceState = { lines: [], at: -Infinity };

/** At most one Park Pulse announcement in this window, however busy the park is. */
export const PULSE_ANNOUNCE_GAP_MS = 12_000;

/**
 * The Park Pulse summary changes every few seconds (guest counts, thought counts), and none of that
 * is worth interrupting for. Only a line that was not there before is: a new weather line, a new
 * guest concern. Management notifications are NOT said here: ManagementNotifications owns them,
 * so one event never produces two utterances. A line that disappears or a count that moves is silent, the first reading is
 * silent (the person did not ask for the park to talk on load), and announcements are spaced.
 * Returns the new state and the sentence to say, or null.
 */
export const planPulseAnnouncement = (
  previous: PulseAnnounceState | null,
  input: PulseAnnounceInput,
  now: number,
): { state: PulseAnnounceState; say: string | null } => {
  const lines = [...input.lines];
  if (previous === null) return { state: { lines, at: -Infinity }, say: null };
  const fresh = lines.filter((line) => !previous.lines.includes(line));
  if (fresh.length === 0) {
    // Keep the remembered lines in step so a line that came back later counts as new.
    return { state: { lines, at: previous.at }, say: null };
  }
  if (now - previous.at < PULSE_ANNOUNCE_GAP_MS) {
    // Too soon: do not advance the remembered lines, so the change is said at the next chance.
    return { state: previous, say: null };
  }
  return { state: { lines, at: now }, say: fresh[0] };
};

export interface NotificationLike {
  readonly id: number | string;
  readonly severity: 'info' | 'warning' | 'critical' | string;
  readonly title: string;
  readonly message: string;
}

/**
 * Management notifications to speak: the ones not announced yet, after the intensity filter has
 * already removed the ones the player turned off. Critical ones go to the assertive region, the
 * rest to the polite one; at most two per update so a burst is a summary, not a monologue.
 */
export const planNotificationAnnouncements = (
  announcedIds: ReadonlySet<number | string>,
  visible: readonly NotificationLike[],
): { assertive: string | null; polite: string | null; announced: Set<number | string> } => {
  const announced = new Set(announcedIds);
  const fresh = visible.filter((notification) => !announced.has(notification.id));
  for (const notification of visible) announced.add(notification.id);
  const speak = (notification: NotificationLike): string => `${notification.title}. ${notification.message}`;
  const critical = fresh.filter((notification) => notification.severity === 'critical');
  const other = fresh.filter((notification) => notification.severity !== 'critical');
  return {
    assertive: critical.length > 0 ? critical.slice(-2).map(speak).join(' ') : null,
    polite: other.length > 0 ? other.slice(-2).map(speak).join(' ') : null,
    announced,
  };
};

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

/** "Lower ticket price by $0.50": the stepper buttons show only a sign, the name says what it does. */
export const stepperLabel = (direction: 'lower' | 'raise', what: string, step: number): string => (
  `${direction === 'lower' ? 'Lower' : 'Raise'} ${what} by $${step.toFixed(2)}`
);

/**
 * The accessible name of an open/closed toggle. The visible word is the state ("Open"), so the name
 * must contain it; it then says what a press does.
 */
export const openToggleLabel = (subject: string, open: boolean): string => (
  `${subject} is ${open ? 'open' : 'closed'}. Press to ${open ? 'close' : 'open'} it`
);

/** Meters in the HUD expose their value as text: "Ride condition 82 percent". */
export const percentLabel = (what: string, value: number): string => `${what} ${Math.round(Math.max(0, Math.min(100, value)))} percent`;

/**
 * The name of a button whose visible text is a state or a short word, plus what it acts on:
 * "Research: Faster Carousel". The visible text stays the first words, as WCAG 2.5.3 asks.
 */
export const labelWithSubject = (visible: string, subject: string): string => `${visible}: ${subject}`;

// ---------------------------------------------------------------------------------------------
// Contrast (WCAG 2.x relative luminance), used by the stylesheet guard test
// ---------------------------------------------------------------------------------------------

const channel = (value: number): number => {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};

/** "#rgb" or "#rrggbb" to [r, g, b]; null for anything else. */
export const parseHex = (hex: string): [number, number, number] | null => {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? match[1].split('').map((c) => c + c).join('') : match[1];
  return [parseInt(digits.slice(0, 2), 16), parseInt(digits.slice(2, 4), 16), parseInt(digits.slice(4, 6), 16)];
};

const luminance = ([r, g, b]: readonly [number, number, number]): number => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG contrast ratio of two hex colours (1 to 21); NaN when either is not a hex colour. */
export const contrastRatio = (a: string, b: string): number => {
  const first = parseHex(a);
  const second = parseHex(b);
  if (!first || !second) return Number.NaN;
  const [high, low] = [luminance(first), luminance(second)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
};
