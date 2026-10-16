import type { BiomeId } from '../biomes/types';
import { deadCardIdsIn as deadCardIdsOfBiome } from '../cards/interaction';
import type { PulseCardId } from '../cards/types';
import type { ParkRuleset } from '../scenarios/rules';
import type { RunConditionDefinition, RunConditionId, RunObjectiveFamily } from './types';

/**
 * The Map's content (Phase 23): stage conditions, objective-family copy and the hooks Phase 25 fills. Pure data plus
 * copy. Numbers are PROVISIONAL (BALANCE_NOTES). Changing any of it bumps RUN_PLAN_VERSION.
 */

/** In canonical (draw) order. */
export const RUN_CONDITIONS: readonly RunConditionDefinition[] = [
  { id: 'quiet-season', name: 'Quiet season', detail: 'Guests arrive 15% slower.', icon: '🌙', rules: { arrivalIntervalMultiplier: 1.15 }, minLevel: 2, excludedBiomes: [], excludedFamilies: [] },
  { id: 'dusty-gears', name: 'Dusty gears', detail: 'Ride operating costs rise 15%.', icon: '⚙', rules: { rideOperatingCostMultiplier: 1.15 }, minLevel: 2, excludedBiomes: [], excludedFamilies: [] },
  { id: 'big-appetites', name: 'Big appetites', detail: 'Hunger, thirst and comfort needs grow 10% faster.', icon: '🍽', rules: { needDecayMultiplier: 1.1 }, minLevel: 2, excludedBiomes: [], excludedFamilies: [] },
  { id: 'thin-wallets', name: 'Thin wallets', detail: 'Arriving guests carry 10% less money.', icon: '👛', rules: { guestBudgetMultiplier: 0.9 }, minLevel: 2, excludedBiomes: [], excludedFamilies: [] },
  { id: 'dear-timber', name: 'Dear timber', detail: 'Construction costs 10% more.', icon: '🪵', rules: { constructionCostMultiplier: 1.1 }, minLevel: 2, excludedBiomes: [], excludedFamilies: [] },
  { id: 'slow-service', name: 'Slow service', detail: 'Every service takes 10% longer per customer.', icon: '🐌', rules: { serviceDurationMultiplier: 1.1 }, minLevel: 3, excludedBiomes: [], excludedFamilies: [] },
  { id: 'short-staffed', name: 'Short-staffed', detail: 'Staff wages are 15% higher.', icon: '🧑‍🔧', rules: { staffSalaryMultiplier: 1.15 }, minLevel: 3, excludedBiomes: [], excludedFamilies: [] },
  // Rain and storm weigh 0.25 and 0.5 in the Desert Canyon: the condition would do nothing there, so it is never drawn (dead-condition protection).
  { id: 'wet-spell', name: 'Wet spell', detail: 'Rain and storms are 25% more likely.', icon: '🌧', rules: { wetWeatherMultiplier: 1.25 }, minLevel: 2, excludedBiomes: ['desert-canyon'], excludedFamilies: [] },
  // With no bin at all, litter piles up and drags happiness and the crowd down: spirits and crowd objectives become unreachable, so they never get it.
  { id: 'bin-strike', name: 'Bin strike', detail: 'The Tidy Totem bin cannot be built.', icon: '🗑', rules: { lockedDefinitionIds: ['tidy-totem'] }, minLevel: 4, excludedBiomes: [], excludedFamilies: ['spirits', 'crowd'] },
];

export const RUN_CONDITION_BY_ID: ReadonlyMap<RunConditionId, RunConditionDefinition> = new Map(
  RUN_CONDITIONS.map((condition) => [condition.id, condition]),
);

export const isRunConditionId = (value: unknown): value is RunConditionId => (
  typeof value === 'string' && RUN_CONDITION_BY_ID.has(value as RunConditionId)
);

/** The conditions that may be drawn at a 0-based level in a biome for an objective family. */
export const allowedConditionsFor = (levelIndex: number, biomeId: BiomeId, family: RunObjectiveFamily): RunConditionDefinition[] => (
  RUN_CONDITIONS.filter((condition) => condition.minLevel <= levelIndex + 1
    && !condition.excludedBiomes.includes(biomeId)
    && !condition.excludedFamilies.includes(family))
);

/** The scenario-layer rules of a set of conditions: multipliers multiply, locked ids union (the compile clamps the product). */
export const combinedConditionRules = (conditionIds: readonly RunConditionId[]): Partial<ParkRuleset> => {
  const rules: Record<string, number | string[]> = {};
  const locked: string[] = [];
  for (const id of conditionIds) {
    const condition = RUN_CONDITION_BY_ID.get(id);
    if (!condition) continue;
    for (const [key, value] of Object.entries(condition.rules)) {
      if (key === 'lockedDefinitionIds') locked.push(...(value as readonly string[]));
      else if (typeof value === 'number') rules[key] = ((rules[key] as number | undefined) ?? 1) * value;
    }
  }
  const out = rules as Partial<ParkRuleset>;
  return locked.length > 0 ? { ...out, lockedDefinitionIds: [...new Set(locked)] } : out;
};

/** The catalog ids the conditions lock (for the bot and the UI). */
export const lockedIdsOf = (conditionIds: readonly RunConditionId[]): string[] => (
  [...(combinedConditionRules(conditionIds).lockedDefinitionIds ?? [])]
);

export interface RunFamilyCopy {
  /** The objective's name, and the ScenarioDefinition tagline. */
  name: string;
  tagline: string;
}

export const RUN_FAMILY_COPY: Readonly<Record<RunObjectiveFamily, RunFamilyCopy>> = {
  visitors: { name: 'Welcome the visitors', tagline: 'Fill the gates with visitors.' },
  profit: { name: 'Turn the stop into profit', tagline: 'Turn the stop into profit.' },
  crowd: { name: 'Fill the park', tagline: 'Fill the park with a happy crowd.' },
  spirits: { name: 'Keep spirits high', tagline: 'Keep the crowd in good spirits.' },
};

export const RUN_STAGE_DESCRIPTION = 'Clear this level to move on along The Map.';

/**
 * Cards that would do nothing in a biome (a "dead card", Phase 25): derived from the real weather chain by
 * cards/interaction.ts (today exactly Dry Spell and Farmer's Almanac in the Desert Canyon). A card dead in every remaining
 * biome is never offered.
 */
export const deadCardIdsIn = (biomeId: BiomeId): readonly PulseCardId[] => deadCardIdsOfBiome(biomeId);

/**
 * Pairs whose modifiers cancel (each shares an axis with opposite signs, tested): a starter deck and an offer never hold
 * both halves (Velvet Ropes undoes Grand Opening).
 */
export const OPPOSING_CARD_PAIRS: ReadonlyArray<readonly [PulseCardId, PulseCardId]> = [
  ['grand-opening', 'velvet-ropes'],
  ['word-on-the-street', 'premium-pricing'],
  ['storm-shutters', 'heat-haze'],
  ['tidy-town', 'greasy-fairground'],
  ['master-mechanics', 'apprentices'],
  ['safety-first', 'oil-and-grease'],
  ['quick-turnaround', 'full-trains'],
  ['hungry-tourists', 'value-menu'],
  ['garden-club', 'plastic-flowers'],
  ['long-days', 'brisk-days'],
  ['local-contractors', 'timber-tariff'],
  ['sponsor-banner', 'bloom-festival'],
];

/** One plain glyph per biome for the run map (the UI may draw its own art; this is the data fallback). */
export const RUN_BIOME_ICON: Readonly<Record<BiomeId, string>> = {
  meadow: '🌼',
  seaside: '🌊',
  'desert-canyon': '🏜',
  winter: '❄',
  jungle: '🌴',
  'autumn-forest': '🍁',
};
