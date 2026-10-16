import type { BotPlacement } from '../scenarios/bot/scenarioBot';
import type { CellPlacement, StrategyDefinition, StrategyHire } from './strategyBot';

/**
 * The three early strategies of Phase 16 (design section 2), as sandbox bots for `runStrategy`. Placements are in the
 * entrance frame: `spine` pieces sit flush against the path spine on one side from a depth (the Phase 22 bot's rule),
 * `at` pieces at an explicit (lateral, depth) cell (scenery beside a ride; lateral grows to the right walking in).
 * Every strategy hires a cleaner and a mechanic at the start and a second cleaner at 10 minutes.
 */

const spine = (definitionId: string, side: 'left' | 'right', fromDepth: number, price?: number): BotPlacement => (
  price === undefined ? { definitionId, side, fromDepth } : { definitionId, side, fromDepth, price }
);

const at = (definitionId: string, l: number, d: number): CellPlacement => ({ definitionId, at: [l, d] });

const CREW: readonly StrategyHire[] = [
  { atSeconds: 0, role: 'cleaner' },
  { atSeconds: 0, role: 'mechanic' },
  { atSeconds: 600, role: 'cleaner' },
];

/** The most ride types early and the biggest guest cap: three cheap rides at minute 0. */
export const CHEAP_AND_WIDE: StrategyDefinition = {
  id: 'cheap-and-wide',
  name: 'Cheap-and-wide',
  spineDepth: 22,
  opening: [
    spine('pretzel-pram', 'right', 1),
    spine('fizz-foundry', 'left', 1),
    spine('moonpetal-carousel', 'right', 3, 4),
    spine('puddle-jumpers', 'left', 3, 3),
    spine('petal-roundabout', 'right', 7, 4),
    spine('tidy-totem', 'left', 6),
  ],
  queue: [
    spine('comfort-cabin', 'left', 7),
    spine('lemon-light', 'left', 10),
    spine('harbor-swings', 'right', 10, 5),
    spine('tidy-totem', 'left', 12),
    spine('picnic-pocket', 'left', 13),
    spine('glacier-scoop', 'right', 14),
  ],
  research: ['family-favorites', 'express-service'],
  hires: CREW,
};

/** One good ride from minute 0 (the Rocket Pendulum): the best ticket per rider and an early rating peak. */
export const ONE_PREMIUM: StrategyDefinition = {
  id: 'one-premium',
  name: 'One premium ride',
  spineDepth: 16,
  opening: [
    spine('picnic-pocket', 'right', 1),
    spine('fizz-foundry', 'left', 1),
    spine('rocket-pendulum', 'right', 3, 7),
    spine('tidy-totem', 'left', 4),
  ],
  queue: [
    spine('comfort-cabin', 'left', 5),
    spine('moonpetal-carousel', 'right', 7, 4),
    spine('lemon-light', 'left', 8),
    spine('petal-roundabout', 'right', 10, 4),
    spine('tidy-totem', 'left', 11),
    spine('glacier-scoop', 'left', 13),
  ],
  research: ['spin-studies', 'vertical-motion'],
  hires: CREW,
};

/**
 * Services and themed scenery: carnival pieces (lamp, bunting) beside the carnival carousel and stalls, garden pieces
 * (flowers, trees) beside the garden picnic stall and, later, the garden roundabout. The steadiest park, the least profit.
 */
export const SERVICE_AND_SCENERY: StrategyDefinition = {
  id: 'service-and-scenery',
  name: 'Service-and-scenery',
  spineDepth: 18,
  opening: [
    spine('picnic-pocket', 'right', 1),
    spine('fizz-foundry', 'left', 1),
    spine('pretzel-pram', 'left', 3),
    spine('moonpetal-carousel', 'right', 3, 4),
    spine('comfort-cabin', 'left', 5),
    spine('tidy-totem', 'left', 7),
    // Carnival beside the carousel (lateral 1..3, depth 3..5) and the carnival stalls on the left.
    at('bunting-mast', 4, 3),
    at('bunting-mast', 4, 5),
    at('lollipop-lamp', -3, 3),
    // Garden beside the picnic stall (lateral 1..2, depth 1..2).
    at('sunburst-flowers', 3, 1),
    at('sunburst-flowers', 3, 2),
    at('confetti-tree', 4, 4),
    at('sunburst-flowers', -3, 1),
    at('confetti-tree', -3, 2),
  ],
  queue: [
    spine('petal-roundabout', 'right', 7, 4),
    spine('lemon-light', 'left', 8),
    // Garden beside the roundabout (lateral 1..3, depth 7..9).
    [at('sunburst-flowers', 4, 7), at('confetti-tree', 4, 8), at('sunburst-flowers', 4, 9), at('confetti-tree', 2, 6)],
    spine('glacier-scoop', 'right', 11),
    spine('tidy-totem', 'left', 12),
  ],
  research: ['garden-appeal', 'express-service', 'refreshment-lab'],
  hires: CREW,
};

export const STRATEGIES: readonly StrategyDefinition[] = [CHEAP_AND_WIDE, ONE_PREMIUM, SERVICE_AND_SCENERY];
