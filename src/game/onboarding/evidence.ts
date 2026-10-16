import {
  ARRIVAL_TARGET,
  LITTER_SEEN_UNITS,
  PATH_TILE_TARGET,
  PROFIT_TARGET,
  RATING_MIN_ARRIVALS,
  RATING_TARGET,
} from './content';
import type { OnboardingFlags, OnboardingInput, OnboardingStepId } from './types';

/**
 * Each step's completion evidence: the observed number when the step's condition holds, null when
 * it does not. Pure functions of a read-only input (no clock, no RNG, no world access), so a
 * latched result is a function of the simulation alone and a replay latches on the same tick.
 *
 * No function reads whether a ride or the park is open: closing is a player choice that must never
 * complete, undo or block a step.
 */
export type EvidenceFunction = (input: OnboardingInput, flags: OnboardingFlags) => number | null;

const countIf = (count: number): number | null => (count >= 1 ? count : null);

export const EVIDENCE: Readonly<Record<OnboardingStepId, EvidenceFunction>> = {
  'lay-path': (input) => (input.connectedPathTiles >= PATH_TILE_TARGET ? input.connectedPathTiles : null),

  // A ride that no connected path touches cannot be reached, so it does not count.
  'first-ride': (input) => countIf(input.rides.filter((ride) => ride.connected).length),

  // Rides start at their default price, so only a deliberate change counts. Evidence is the price.
  'set-price': (input) => {
    const changed = input.rides.find((ride) => ride.ticketPrice !== ride.defaultTicketPrice);
    return changed ? changed.ticketPrice : null;
  },

  'first-rider': (input) => countIf(input.rides.reduce((sum, ride) => sum + ride.satisfactionCount, 0)),

  'first-food': (input) => countIf(input.services.filter((service) => service.kind === 'food' && service.connected).length),

  'first-drink': (input) => countIf(input.services.filter((service) => service.kind === 'drink' && service.connected).length),

  'guest-target': (input) => (input.totalArrivals >= ARRIVAL_TARGET ? input.totalArrivals : null),

  'first-profit': (input) => (input.operatingProfit >= PROFIT_TARGET ? input.operatingProfit : null),

  // A repair, or litter that was seen, then cleaned by an employed cleaner. A clean park with a
  // freshly hired cleaner proves nothing, so the quiet case leaves the step pending.
  'fix-problem': (input, flags) => {
    const repairs = input.rides.reduce((sum, ride) => sum + ride.repairsCompleted, 0);
    if (repairs >= 1) return repairs;
    return flags.sawLitter && input.cleaners >= 1 && input.litterUnits === 0 ? 0 : null;
  },

  // Guests must have visited, otherwise the default factor values of an empty park already read high.
  'good-rating': (input) => (
    input.totalArrivals >= RATING_MIN_ARRIVALS && input.parkRating >= RATING_TARGET ? input.parkRating : null
  ),
};

/** Updates the latches that evidence reads. Called before the evidence functions on every evaluation. */
export const observeFlags = (flags: OnboardingFlags, input: OnboardingInput): void => {
  if (!flags.sawLitter && input.litterUnits >= LITTER_SEEN_UNITS) flags.sawLitter = true;
};
