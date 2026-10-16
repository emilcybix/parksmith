import type { GuestCapacityBlock, GuestCapacityView } from '../game/guests/GuestSimulation';

/**
 * Pure copy for the park's guest ceiling (Phase 11, PA-009): the Pulse guests stat, the Pulse insight line, the
 * Overview GUESTS KPI, the Overview "Park capacity" section and the at-capacity toast. "Ride seats" is the plain word
 * for the summed `rideProfile.capacity` of open, reachable rides, matching the inspector's `Capacity` row.
 */

export const CAPACITY_SECTION_KICKER = 'PARK CAPACITY';
export const CAPACITY_SECTION_TITLE = 'Guest ceiling';
/** The Pulse insight glyph (decorative, `aria-hidden`). */
export const CAPACITY_INSIGHT_GLYPH = '◍';
export const CAPACITY_INSIGHT = 'At capacity: more ride seats or a higher rating let more guests in.';

export const CAPACITY_BLOCKED_TEXT: Readonly<Record<Exclude<GuestCapacityBlock, null>, string>> = {
  'park-closed': 'The park is closed, so no new guests arrive.',
  'after-hours': 'Outside opening hours, so no new guests arrive.',
  'too-few-paths': 'Guests arrive once the park has at least 3 path tiles.',
  'no-open-ride': 'No open ride can be reached from the gate, so no guests arrive.',
};

export interface CapacityCopy {
  /**
   * The Pulse guests stat label under the (unchanged) number: `of 52 guests`, or `guests` when blocked or unknown. Above
   * the ceiling (it fell under the guests already inside: a ride closed, the rating dropped, a card ran out) it reads
   * `max 52 guests`, because "58 of 52 guests" is not a sentence.
   */
  pulseLabel: string;
  /** True when the Pulse number takes the `at-capacity` class (amber; the label text says it too). */
  atCapacityTone: boolean;
  /** The Pulse insight line (and PulseAnnouncer line) while at capacity, else null. */
  insight: string | null;
  /** The Overview GUESTS KPI `<small>`: `of 52` (`max 52` above the ceiling), or null when blocked or unknown. */
  kpiOf: string | null;
  /** The Overview section's `<b>`: `41/52` (`41/0` when blocked), or null with no view. */
  ratio: string | null;
  /** The Overview section's paragraph, or null with no view. */
  text: string | null;
}

const formatMultiplier = (multiplier: number): string => `×${Number(multiplier.toFixed(2))}`;

/** Every capacity string for one 4 Hz UI snapshot. `view` is null before a session publishes one. */
export const describeCapacity = (view: GuestCapacityView | null, guestCount: number, atCapacity: boolean): CapacityCopy => {
  if (!view) return { pulseLabel: 'guests', atCapacityTone: false, insight: null, kpiOf: null, ratio: null, text: null };
  const ratio = `${guestCount}/${view.ceiling}`;
  if (view.blocked !== null) {
    return { pulseLabel: 'guests', atCapacityTone: false, insight: null, kpiOf: null, ratio, text: CAPACITY_BLOCKED_TEXT[view.blocked] };
  }
  const full = atCapacity && view.ceiling > 0;
  const seats = `${view.rideSeats} guest${view.rideSeats === 1 ? '' : 's'}`;
  const sentences = [
    `Open rides seat ${seats} at a time and the park rating is ${Math.round(view.rating)}. More ride seats or a higher rating raise the ceiling.`,
  ];
  if (view.crowdMultiplier !== 1) sentences.push(`Active cards scale it ${formatMultiplier(view.crowdMultiplier)}.`);
  if (view.ceiling === view.hardMaximum) sentences.push('This is the most guests a park can hold.');
  if (full) sentences.push('The park is full: no new guests arrive until someone leaves.');
  // Wave 3 audit: more guests than the ceiling (seen as "1000 / of 491 guests") reads as a maximum, not a share.
  const of = guestCount > view.ceiling ? 'max' : 'of';
  return {
    pulseLabel: `${of} ${view.ceiling} guests`,
    atCapacityTone: full,
    insight: full ? CAPACITY_INSIGHT : null,
    kpiOf: `${of} ${view.ceiling}`,
    ratio,
    text: sentences.join(' '),
  };
};

/** The one-shot `important` toast when the park has been at capacity for 60 simulated seconds. */
export const capacityToast = (ceiling: number): string =>
  `Park at capacity (${ceiling} guests). More ride seats or a higher rating let more guests in.`;
