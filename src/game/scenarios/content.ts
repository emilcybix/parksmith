import { GAME_CONFIG } from '../config';
import type { ParkScenarioId, ScenarioDefinition, ScenarioId, ShippedScenarioDefinition } from './types';

/** Longest deadline an author may write in days. */
export const MAXIMUM_DEADLINE_DAYS = 30;
/** Deadlines in days must be a whole number of weather slots (a quarter of a day). */
const DEADLINE_DAY_STEP = 1 / GAME_CONFIG.weather.slotsPerDay;

type ScenarioDeadline =
  | { timeLimitSeconds: number; timeLimitDays?: undefined }
  | { timeLimitDays: number; timeLimitSeconds?: undefined };

export type ScenarioDefinitionInput<Id extends ParkScenarioId = ParkScenarioId> = Omit<ScenarioDefinition, 'timeLimitSeconds' | 'timeLimitDays' | 'id'> & { id: Id } & ScenarioDeadline;

/**
 * Normalises an authored scenario. A deadline is written EITHER in seconds or in days, never both;
 * days compile to seconds at the fixed scenario day length (a scenario park cannot change it, which
 * the save consistency check enforces), so everything downstream still counts seconds. A bad
 * deadline throws at module load, not mid-game.
 */
export const defineScenario = <Id extends ParkScenarioId>(input: ScenarioDefinitionInput<Id>): ScenarioDefinition & { id: Id } => {
  const { timeLimitSeconds, timeLimitDays, ...rest } = input;
  if ((timeLimitSeconds === undefined) === (timeLimitDays === undefined)) {
    throw new Error(`Scenario ${input.id}: give exactly one of timeLimitSeconds or timeLimitDays`);
  }
  if (timeLimitSeconds !== undefined) {
    if (!Number.isFinite(timeLimitSeconds) || timeLimitSeconds <= 0) throw new Error(`Scenario ${input.id}: timeLimitSeconds must be positive`);
    return { ...rest, timeLimitSeconds };
  }
  const days = timeLimitDays as number;
  if (!Number.isFinite(days) || days <= 0) throw new Error(`Scenario ${input.id}: timeLimitDays must be positive`);
  if (days > MAXIMUM_DEADLINE_DAYS) throw new Error(`Scenario ${input.id}: timeLimitDays may not exceed ${MAXIMUM_DEADLINE_DAYS}`);
  if (Math.abs(days / DEADLINE_DAY_STEP - Math.round(days / DEADLINE_DAY_STEP)) > 1e-9) {
    throw new Error(`Scenario ${input.id}: timeLimitDays must be a multiple of ${DEADLINE_DAY_STEP} (a weather slot)`);
  }
  return { ...rest, timeLimitSeconds: days * GAME_CONFIG.calendar.defaultDayLengthSeconds, timeLimitDays: days };
};

export const SCENARIOS: readonly ShippedScenarioDefinition[] = [
  {
    id: 'sunny-start',
    name: 'Sunny Start',
    tagline: 'A fresh meadow and a modest loan.',
    description: 'Prove the concept: build a small park that a steady crowd wants to visit.',
    seed: 0x50a1_0101,
    timeLimitSeconds: 900,
    objective: {
      id: 'first-crowd',
      name: 'Welcome the first crowd',
      kind: 'earn',
      metric: 'cumulativeGuests',
      target: 120,
    },
    constraint: null,
    rules: { startingCash: 9_000 },
    setup: {
      paths: [
        { x: 15, y: 30 },
        { x: 15, y: 29 },
        { x: 15, y: 28 },
        { x: 15, y: 27 },
      ],
      objects: [],
    },
    cardSlots: 2,
    difficulty: 1,
    unlockedBy: { kind: 'always' },
    rewards: { cardDraftChoices: 3, unlocks: [], bonuses: ['nest-egg'] },
  },
  {
    id: 'penny-lane',
    name: 'Penny Lane',
    tagline: 'Quiet season, careful books.',
    description: 'Visitors trickle in slowly this season. Turn a lean crowd into real operating profit.',
    seed: 0x50a1_0202,
    timeLimitSeconds: 1_200,
    objective: {
      id: 'operating-profit',
      name: 'Run a profitable park',
      kind: 'earn',
      metric: 'operatingProfit',
      target: 2_500,
    },
    constraint: {
      name: 'Quiet season',
      detail: 'Organic guest arrivals are 30% slower for the whole park.',
    },
    rules: { startingCash: 11_000, arrivalIntervalMultiplier: 1.3 },
    setup: {
      paths: [
        { x: 15, y: 30 },
        { x: 15, y: 29 },
      ],
      objects: [],
    },
    cardSlots: 2,
    difficulty: 2,
    unlockedBy: { kind: 'clear-any', scenarioIds: ['sunny-start'] },
    rewards: { cardDraftChoices: 3, unlocks: [], bonuses: ['research-grant'] },
  },
  {
    id: 'garden-gala',
    name: 'Garden Gala',
    tagline: 'The critics are watching.',
    description: 'Hold an outstanding reputation long enough to convince the touring garden critics.',
    seed: 0x50a1_0303,
    timeLimitSeconds: 1_500,
    objective: {
      id: 'critics-verdict',
      name: 'Impress the critics',
      kind: 'sustain',
      metric: 'parkRating',
      comparison: 'atLeast',
      target: 65,
      durationSeconds: 240,
    },
    constraint: {
      name: 'Bin shipment delayed',
      detail: 'Tidy Totem bins cannot be built. Hire cleaners to keep the paths spotless.',
    },
    rules: { startingCash: 14_000, lockedDefinitionIds: ['tidy-totem'] },
    setup: {
      paths: [
        { x: 15, y: 30 },
        { x: 15, y: 29 },
        { x: 15, y: 28 },
        { x: 14, y: 28 },
        { x: 16, y: 28 },
      ],
      objects: [{ definitionId: 'sunburst-flowers', anchor: { x: 14, y: 29 } }],
    },
    cardSlots: 2,
    difficulty: 2,
    unlockedBy: { kind: 'clear-any', scenarioIds: ['sunny-start'] },
    rewards: { cardDraftChoices: 3, unlocks: [], bonuses: ['builders-discount'] },
  },
  {
    id: 'starlight-finale',
    name: 'Starlight Finale',
    tagline: 'One evening to crown the tour.',
    description: 'The festival jury arrives at dusk. Keep the whole park shining until the fireworks.',
    seed: 0x50a1_0404,
    timeLimitSeconds: 1_800,
    objective: {
      id: 'festival-verdict',
      name: 'Shine for the jury',
      kind: 'sustain',
      metric: 'parkRating',
      comparison: 'atLeast',
      target: 70,
      durationSeconds: 300,
    },
    constraint: {
      name: 'Evening crowds',
      detail: 'Organic guest arrivals are 15% slower while the festival stage rehearses.',
    },
    rules: { startingCash: 16_000, arrivalIntervalMultiplier: 1.15 },
    setup: {
      paths: [
        { x: 15, y: 30 },
        { x: 15, y: 29 },
        { x: 15, y: 28 },
        { x: 14, y: 28 },
        { x: 16, y: 28 },
        { x: 15, y: 27 },
      ],
      objects: [
        { definitionId: 'sunburst-flowers', anchor: { x: 14, y: 29 } },
        { definitionId: 'lollipop-lamp', anchor: { x: 16, y: 29 } },
      ],
    },
    cardSlots: 2,
    difficulty: 3,
    unlockedBy: { kind: 'clear-any', scenarioIds: ['penny-lane', 'garden-gala'] },
    rewards: { cardDraftChoices: 3, unlocks: [], bonuses: ['spare-slot'] },
  },
  // Phase 22: one scenario per new biome (Phase 24 maps). The numbers are PROVISIONAL (BALANCE_NOTES, Phase 22):
  // each is cleared by a scripted bot with no card, no unlock and no bonus (scenarios/winnability.test.ts).
  defineScenario({
    id: 'boardwalk-breeze',
    name: 'Boardwalk Breeze',
    tagline: 'Sea air, salty snacks, a long summer day.',
    description: 'The cove is warm and thirsty. Fill the boardwalk with happy holidaymakers before the day is out. Every ride makes room for more guests: two rides will not hold eighty.',
    seed: 0x50a1_0505,
    mapId: 'seaside-cove',
    timeLimitDays: 1.5,
    objective: { id: 'fill-the-boardwalk', name: 'Fill the boardwalk', kind: 'reach', metric: 'guestCount', target: 80 },
    constraint: null,
    rules: { startingCash: 9_500 },
    setup: { paths: [{ x: 1, y: 15 }, { x: 2, y: 15 }, { x: 3, y: 15 }], objects: [] },
    cardSlots: 2,
    // Steady, not Relaxed: the First Day park (two rides) caps at about 76 guests and fails; a third ride is the lesson.
    difficulty: 2,
    unlockedBy: { kind: 'clear-any', scenarioIds: ['sunny-start'] },
    rewards: { cardDraftChoices: 3, unlocks: ['tiki-tumbler'], bonuses: [] },
  }),
  defineScenario({
    id: 'canyon-caravan',
    name: 'Canyon Caravan',
    tagline: 'A dusty corridor, thirsty travellers.',
    description: 'Travellers cross the canyon in the heat. Build where the rock allows and turn their stop into profit.',
    seed: 0x50a1_0606,
    mapId: 'red-rock-canyon',
    timeLimitDays: 2.5,
    objective: { id: 'caravan-profit', name: 'Turn the stop into profit', kind: 'earn', metric: 'operatingProfit', target: 3_900 },
    constraint: { name: 'Dusty gears', detail: 'Ride running costs are 15% higher.' },
    rules: { startingCash: 12_000, rideOperatingCostMultiplier: 1.15 },
    setup: { paths: [{ x: 16, y: 1 }, { x: 16, y: 2 }, { x: 16, y: 3 }], objects: [] },
    cardSlots: 2,
    difficulty: 2,
    unlockedBy: { kind: 'clear-any', scenarioIds: ['penny-lane', 'boardwalk-breeze'] },
    rewards: { cardDraftChoices: 3, unlocks: ['cactus-cooler'], bonuses: [] },
  }),
  defineScenario({
    id: 'frost-fair',
    name: 'Frost Fair',
    tagline: 'Keep spirits warm on the ice.',
    description: 'A winter fair in the hollow. Keep the crowd happy while the short days draw fewer visitors.',
    seed: 0x50a1_0707,
    mapId: 'frosted-hollow',
    timeLimitDays: 2,
    objective: {
      id: 'warm-spirits', name: 'Keep spirits warm', kind: 'sustain', metric: 'averageHappiness', comparison: 'atLeast', target: 70, durationSeconds: 360,
    },
    constraint: { name: 'Short winter days', detail: 'Organic guest arrivals are 10% slower.' },
    rules: { startingCash: 12_000, arrivalIntervalMultiplier: 1.1 },
    setup: { paths: [{ x: 9, y: 30 }, { x: 9, y: 29 }, { x: 9, y: 28 }], objects: [] },
    cardSlots: 2,
    // Relaxed: happiness swings with the weather, so the target sits below every swing a cared-for park makes (the
    // First Day park clears too). A higher bar made the clear depend on the seed, not on the park (BALANCE_NOTES).
    difficulty: 1,
    unlockedBy: { kind: 'clear-any', scenarioIds: ['sunny-start'] },
    rewards: { cardDraftChoices: 3, unlocks: ['cocoa-chalet'], bonuses: [] },
  }),
  defineScenario({
    id: 'ruins-rush',
    name: 'Lost Ruins Rush',
    tagline: 'Explorers are queueing at the river bridge.',
    description: 'Word of the ruins has spread. Welcome a flood of explorers, rain or shine.',
    seed: 0x50a1_0808,
    mapId: 'emerald-ruins',
    timeLimitDays: 2,
    objective: { id: 'explorer-rush', name: 'Welcome the explorers', kind: 'earn', metric: 'cumulativeGuests', target: 280 },
    constraint: { name: 'Monsoon season', detail: 'Rain and storms are more likely.' },
    rules: { startingCash: 13_000, wetWeatherMultiplier: 1.25 },
    setup: { paths: [{ x: 30, y: 22 }, { x: 29, y: 22 }, { x: 28, y: 22 }], objects: [] },
    cardSlots: 2,
    // Steady: the First Day park clears it late (about 76% of the deadline), a fuller park well inside.
    difficulty: 2,
    unlockedBy: { kind: 'clear-any', scenarioIds: ['canyon-caravan', 'garden-gala'] },
    rewards: { cardDraftChoices: 3, unlocks: [], bonuses: ['word-of-mouth'] },
  }),
  defineScenario({
    id: 'harvest-festival',
    name: 'Harvest Festival',
    tagline: 'Every paddock must earn its place.',
    description: 'The ridge is ablaze with red and gold, and hungry crowds come through. Make every stall and ride pay its way.',
    seed: 0x50a1_0909,
    mapId: 'maple-ridge',
    timeLimitDays: 2.5,
    // An earn objective, not a rating sustain: the rating swings a few points tick to tick, so a sustain at a bar that
    // tells a good park from a basic one was won or lost by when a dip landed (BALANCE_NOTES, Phase 22 review).
    objective: { id: 'harvest-takings', name: 'Bring in the harvest takings', kind: 'earn', metric: 'operatingProfit', target: 7_500 },
    constraint: { name: 'Harvest appetite', detail: 'Guest needs grow 10% faster.' },
    rules: { startingCash: 15_000, needDecayMultiplier: 1.1 },
    setup: { paths: [{ x: 22, y: 30 }, { x: 22, y: 29 }, { x: 22, y: 28 }], objects: [] },
    cardSlots: 2,
    difficulty: 3,
    unlockedBy: { kind: 'clear-any', scenarioIds: ['frost-fair'] },
    rewards: { cardDraftChoices: 3, unlocks: ['lantern-maple'], bonuses: ['trusted-crew'] },
  }),
  defineScenario({
    id: 'room-to-grow',
    name: 'Room to Grow',
    tagline: 'The estate is yours, a parcel at a time.',
    description: 'You own the lawn by the gate of Meadow Estate. Make it pay, then buy out the land around it.',
    seed: 0x50a1_0a0a,
    mapId: 'meadow-estate',
    timeLimitDays: 3,
    // Phase 21: the land objective. The park starts with 12 of the 64 parcels; 20 means buying eight, paid for by the park.
    objective: { id: 'estate-parcels', name: 'Own 20 parcels of the estate', kind: 'reach', metric: 'ownedParcels', target: 20 },
    constraint: null,
    rules: { startingCash: 12_000 },
    setup: { paths: [{ x: 31, y: 62 }, { x: 31, y: 61 }, { x: 31, y: 60 }], objects: [] },
    cardSlots: 2,
    difficulty: 2,
    unlockedBy: { kind: 'clear-any', scenarioIds: ['sunny-start'] },
    rewards: { cardDraftChoices: 3, unlocks: [], bonuses: ['land-surveyor'] },
  }),
];

/** The four scenarios shipped before Phase 22: their rules, maps and objectives are pinned and never change. */
export const FOUNDING_SCENARIO_IDS: readonly ScenarioId[] = ['sunny-start', 'penny-lane', 'garden-gala', 'starlight-finale'];

export const FOUNDING_SCENARIOS: readonly ShippedScenarioDefinition[] = SCENARIOS.filter((scenario) => FOUNDING_SCENARIO_IDS.includes(scenario.id));

export const SCENARIO_BY_ID = new Map<ScenarioId, ShippedScenarioDefinition>(
  SCENARIOS.map((scenario) => [scenario.id, scenario]),
);
