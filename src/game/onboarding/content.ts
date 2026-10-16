import type { OnboardingStepDefinition, OnboardingStepId } from './types';

/**
 * Targets for the numeric steps. PROVISIONAL until the pacing test (pacing.test.ts) has justified
 * them against the cheapest route in BALANCE_NOTES.md.
 */
export const PATH_TILE_TARGET = 6;
export const ARRIVAL_TARGET = 50;
export const PROFIT_TARGET = 100;
export const RATING_TARGET = 70;
/**
 * The rating only counts once this many guests have visited. Before any guest has an opinion the
 * score is built from default factor values and already reads 62 to 72 within the first second of a
 * park with one ride (measured in pacing.test.ts), which would complete the step at creation.
 */
export const RATING_MIN_ARRIVALS = 20;
/** Litter pile total that counts as "a problem appeared" for the fix-a-problem step. */
export const LITTER_SEEN_UNITS = 3;

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

/**
 * Phase 24: which way the park runs from the gate ON SCREEN, for the lay-path hint. The gate is a map property and the
 * player turns the view, so the hint names the screen direction of the live map and view (ui/firstDayModel.ts
 * gateInwardOnScreen). An isometric step into the park is always diagonal on screen. The Meadow gate in view 0 (on the
 * lower-left edge, the park up and to the right) keeps the shipped wording 'up'; the other three diagonals are spelled
 * out, so a gate on the upper-right edge never tells the player to drag up.
 */
export type GateInward = 'up' | 'up-left' | 'down-left' | 'down-right';

const INWARD_WORDS: Readonly<Record<GateInward, string>> = {
  up: 'up',
  'up-left': 'up and to the left',
  'down-left': 'down and to the left',
  'down-right': 'down and to the right',
};

export const layPathHint = (inward: GateInward): string =>
  `Pick Paths and drag at least ${PATH_TILE_TARGET} tiles ${INWARD_WORDS[inward]} from the gate, joined to it.`;

export const ONBOARDING_STEPS: readonly OnboardingStepDefinition[] = [
  {
    id: 'lay-path',
    title: 'Lay a path',
    hint: layPathHint('up'),
    evidenceLabel: (value) => `${plural(value, 'path tile leads', 'path tiles lead')} from the gate`,
  },
  {
    id: 'first-ride',
    title: 'Build a ride by the path',
    hint: 'Pick Rides and place one so a side touches your path.',
    evidenceLabel: (value) => `${plural(value, 'ride is', 'rides are')} connected to the gate`,
  },
  {
    id: 'set-price',
    title: 'Set a ticket price',
    hint: 'Click your ride, then press the minus or plus button by Ticket price.',
    evidenceLabel: (value) => `Tickets cost $${value.toFixed(2)}`,
  },
  {
    id: 'first-rider',
    title: 'Welcome your first rider',
    hint: 'Guests arrive on their own. Keep the ride and park open and wait for a ride to finish.',
    evidenceLabel: (value) => `${plural(value, 'ride', 'rides')} completed with guests aboard`,
  },
  {
    id: 'first-food',
    title: 'Add a food stall',
    hint: 'From Treats, place a Picnic Pocket or Glacier Scoop (food) with a side on the path.',
    evidenceLabel: (value) => `${plural(value, 'food stall is', 'food stalls are')} connected to the gate`,
  },
  {
    id: 'first-drink',
    title: 'Add a drink stall',
    hint: 'Place a Fizz Foundry or Lemon Light (drinks) beside the path, from Treats.',
    evidenceLabel: (value) => `${plural(value, 'drink stall is', 'drink stalls are')} connected to the gate`,
  },
  {
    id: 'guest-target',
    title: `Bring in ${ARRIVAL_TARGET} guests`,
    hint: `Keep the park open and let the day run. ${ARRIVAL_TARGET} guests must come through; fast-forward helps.`,
    evidenceLabel: (value) => `${plural(value, 'guest has', 'guests have')} visited`,
  },
  {
    id: 'first-profit',
    title: 'Turn a profit',
    hint: `Earn $${PROFIT_TARGET} more than running costs. Building costs do not count.`,
    evidenceLabel: (value) => `Operating profit reached $${Math.round(value)}`,
  },
  {
    id: 'fix-problem',
    title: 'Fix a problem',
    hint: 'Litter piling up? Hire a cleaner. A ride broken? Hire a mechanic. Or skip.',
    // The value is the number of repairs; 0 means the litter branch completed it.
    evidenceLabel: (value) => (value >= 1
      ? `${plural(value, 'repair was', 'repairs were')} completed`
      : 'The litter was cleaned up'),
  },
  {
    id: 'good-rating',
    title: `Earn a ${RATING_TARGET} rating`,
    hint: `After ${RATING_MIN_ARRIVALS} guests, reach ${RATING_TARGET}: more rides, a restroom, lamps, flowers, bins.`,
    evidenceLabel: (value) => `Park rating reached ${Math.round(value)}`,
  },
];

export const ONBOARDING_STEP_BY_ID: ReadonlyMap<OnboardingStepId, OnboardingStepDefinition> = new Map(
  ONBOARDING_STEPS.map((step) => [step.id, step]),
);
