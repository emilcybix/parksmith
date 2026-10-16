/** Phase 39 step 2: `launch` is the launch family's special: a launch track that fires the train out at speed. */
export type CoasterSpecial = 'loop' | 'boost' | 'launch';

/**
 * Phase 39: what a coaster is built like. `steel` is the original three types; a family has its own build rules
 * (design.ts), ride model weights (`deriveCoasterStats`) and art (track look, supports, cars).
 * - `wild-mouse`: short trains of four-seat cars (two: one car alone carried a third of a family coaster), flat turns only (no climbing or falling on a corner), no specials; turns
 *   count for more, drops for less.
 * - `wooden`: wooden track and lattice supports, no inversions; rougher (more intensity per drop) with an airtime
 *   bonus per hill, lower reliability.
 * - `launch` (step 2; Phase 44 made Thunder Launch a shuttle, see `layout`): at least one `launch` piece replaces the chain lift's job (the train leaves it at
 *   `speed.launch`, and a chain-free climb after it rides that momentum up a top hat); the height cap is
 *   5 (Phase 45: 10, a shuttle's spike) instead of the usual 4.
 * - `inverted` (step 3): the train hangs under the track (drawn one level up, on gantries from above). A path needs
 *   one level more under it, it never crosses other track, and it takes no loops.
 */
export type CoasterFamily = 'steel' | 'wild-mouse' | 'wooden' | 'launch' | 'inverted';

/**
 * A buildable coaster family: same designer, different physical limits and economy.
 * Referenced by the catalog card's definition id.
 */
export interface CoasterTypeDefinition {
  definitionId: string;
  family: CoasterFamily;
  maximumHeight: number;
  trainCapacity: number;
  trainCars: number;
  reliability: number;
  stationCost: number;
  pieceCost: number;
  heightCostPerLevel: number;
  allowedSpecials: readonly CoasterSpecial[];
  /**
   * Phase 44: `shuttle` types build open out-and-back layouts (the station launches the train, it climbs, rolls
   * back): the designer sets a launch speed instead of closing the circuit. A shuttle type still LOADS a closed
   * circuit saved before it became one (a layout without `launchSpeed` is read as a circuit).
   */
  layout?: 'shuttle';
}

export const COASTER_TYPES: readonly CoasterTypeDefinition[] = [
  {
    definitionId: 'comet-trail',
    family: 'steel',
    maximumHeight: 2,
    trainCapacity: 12,
    trainCars: 4,
    reliability: 92,
    stationCost: 400,
    pieceCost: 45,
    heightCostPerLevel: 30,
    allowedSpecials: [],
  },
  {
    definitionId: 'star-chaser',
    family: 'steel',
    maximumHeight: 3,
    trainCapacity: 10,
    trainCars: 5,
    reliability: 86,
    stationCost: 550,
    pieceCost: 55,
    heightCostPerLevel: 40,
    allowedSpecials: ['loop'],
  },
  {
    definitionId: 'skyline-serpent',
    family: 'steel',
    maximumHeight: 4,
    trainCapacity: 8,
    trainCars: 6,
    reliability: 80,
    stationCost: 750,
    pieceCost: 65,
    heightCostPerLevel: 45,
    allowedSpecials: ['loop', 'boost'],
  },
  {
    definitionId: 'whisker-mouse',
    family: 'wild-mouse',
    maximumHeight: 3,
    trainCapacity: 8,
    trainCars: 2,
    reliability: 92,
    stationCost: 280,
    pieceCost: 32,
    heightCostPerLevel: 25,
    allowedSpecials: [],
  },
  {
    definitionId: 'timber-twister',
    family: 'wooden',
    maximumHeight: 3,
    trainCapacity: 10,
    trainCars: 4,
    reliability: 76,
    stationCost: 450,
    pieceCost: 42,
    heightCostPerLevel: 30,
    allowedSpecials: [],
  },
  {
    definitionId: 'thunder-launch',
    family: 'launch',
    // Phase 45: a shuttle's spike reaches level 10.
    maximumHeight: 10,
    trainCapacity: 12,
    trainCars: 4,
    reliability: 82,
    stationCost: 900,
    pieceCost: 70,
    heightCostPerLevel: 50,
    // `launch` stays for the closed circuits saved before Phase 44; a shuttle refuses launch pieces (its station launches).
    allowedSpecials: ['launch', 'boost', 'loop'],
    layout: 'shuttle',
  },
  {
    definitionId: 'bat-wing',
    family: 'inverted',
    maximumHeight: 4,
    trainCapacity: 8,
    trainCars: 4,
    reliability: 84,
    stationCost: 800,
    pieceCost: 62,
    heightCostPerLevel: 45,
    allowedSpecials: ['boost'],
  },
  {
    // Phase 45: the tall steel coaster, chain lift to level 10.
    definitionId: 'titan-hyper',
    family: 'steel',
    maximumHeight: 10,
    trainCapacity: 12,
    trainCars: 6,
    reliability: 78,
    stationCost: 1_200,
    pieceCost: 80,
    heightCostPerLevel: 55,
    allowedSpecials: ['loop', 'boost'],
  },
] as const;

/** Phase 39 step 3: whether a coaster type's train hangs under its track. */
export const coasterHangs = (definitionId: string): boolean => COASTER_TYPE_BY_ID.get(definitionId)?.family === 'inverted';

export const COASTER_TYPE_BY_ID = new Map<string, CoasterTypeDefinition>(
  COASTER_TYPES.map((type) => [type.definitionId, type]),
);
