import type { ScenarioId } from '../types';
import type { BotPlacement, BotPlan } from './scenarioBot';

/**
 * The scripted plans of the Phase 22 winnability proof (test support). Every building is available at park start:
 * no research, no gated entry, no card, no bonus. A plan is a spine of path along the entrance axis with buildings
 * flush on both sides, in the entrance frame (see scenarioBot.ts), so the same idea runs on every map.
 */

const place = (definitionId: string, side: 'left' | 'right', fromDepth: number, price?: number): BotPlacement => (
  price === undefined ? { definitionId, side, fromDepth } : { definitionId, side, fromDepth, price }
);

/** A new player's first park: the First Day idea (a carousel, two stalls, a roundabout, a few comforts), one cleaner and one mechanic. */
export const BASIC_PLAN: BotPlan = {
  spineDepth: 14,
  placements: [
    place('picnic-pocket', 'right', 1),
    place('fizz-foundry', 'left', 1),
    place('moonpetal-carousel', 'right', 3, 4),
    place('comfort-cabin', 'left', 4),
    place('petal-roundabout', 'right', 7, 4),
    place('lollipop-lamp', 'left', 6),
    place('sunburst-flowers', 'left', 8),
  ],
  hire: ['cleaner', 'mechanic'],
};

/** The first tier of a fuller park: three rides' worth of room, food and drink on both sides, bins, scenery, two cleaners. */
const CORE: readonly BotPlacement[] = [
  place('picnic-pocket', 'right', 1),
  place('fizz-foundry', 'left', 1),
  place('moonpetal-carousel', 'right', 3, 4),
  place('comfort-cabin', 'left', 4),
  place('tidy-totem', 'left', 6),
  place('petal-roundabout', 'right', 7, 4),
  place('lollipop-lamp', 'left', 7),
  place('sunburst-flowers', 'left', 8),
  place('confetti-tree', 'left', 9),
  place('lemon-light', 'left', 10),
];

/** The second tier, bought once the first tier pays: a third ride, another stall, more comfort and scenery. */
const EXPANSION: readonly BotPlacement[] = [
  place('harbor-swings', 'right', 10, 5),
  place('glacier-scoop', 'right', 13),
  place('comfort-cabin', 'left', 12),
  place('tidy-totem', 'left', 14),
  place('lollipop-lamp', 'left', 15),
  place('confetti-tree', 'left', 16),
  place('sunburst-flowers', 'right', 16),
];

const without = (placements: readonly BotPlacement[], ids: readonly string[]): BotPlacement[] => (
  placements.filter((placement) => !ids.includes(placement.definitionId))
);

/** The fuller park, minus the ids a scenario locks. */
export const richPlan = (locked: readonly string[] = [], expandAtSeconds = 150): BotPlan => ({
  spineDepth: 20,
  placements: without(CORE, locked),
  hire: ['cleaner', 'cleaner', 'mechanic'],
  steps: [{ atSeconds: expandAtSeconds, placements: without(EXPANSION, locked) }],
});

/** The plan the winnability test must clear every scenario with. */
export const WINNING_PLANS: Readonly<Record<ScenarioId, BotPlan>> = {
  'sunny-start': richPlan(),
  'penny-lane': richPlan(),
  'garden-gala': richPlan(['tidy-totem']),
  'starlight-finale': richPlan(),
  'boardwalk-breeze': richPlan(),
  'canyon-caravan': richPlan(),
  'frost-fair': richPlan(),
  'ruins-rush': richPlan(),
  'harvest-festival': richPlan(),
  // Phase 21: the fuller park, then land bought whenever the park can spare it (a reserve kept for wages and repairs).
  'room-to-grow': { ...richPlan(), buyLand: { fromSeconds: 300, reserve: 1_500 } },
};

/**
 * `plan` as a human would play it: nothing for `seconds` (reading the brief, finding the gate), then the opening, and
 * every later step just as late. A plan holds at most three steps, so the opening takes the place of one.
 */
export const delayPlan = (plan: BotPlan, seconds: number): BotPlan => {
  const { steps, buyLand, ...opening } = plan;
  return {
    ...(buyLand === undefined ? {} : { buyLand: { ...buyLand, fromSeconds: buyLand.fromSeconds + seconds } }),
    steps: [
      { atSeconds: seconds, ...opening },
      ...(steps ?? []).slice(0, 2).map((step) => ({ ...step, atSeconds: step.atSeconds + seconds })),
    ],
  };
};

/** The setup stub plus four path tiles and nothing else: it must not clear anything. */
export const LAZY_PLAN: BotPlan = { spineDepth: 4 };
