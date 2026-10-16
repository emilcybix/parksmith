import { BUILD_BY_ID } from '../content/catalog';
import { GAME_CONFIG } from '../config';
import type { BonusId } from '../profile/bonuses';

/**
 * Run-scoped rules a park session plays under. Compiled once when a session starts —
 * base rules → biome → scenario overrides → permanent profile bonuses → selected Pulse Cards → safety clamps — so neither
 * scenarios nor cards ever mutate GAME_CONFIG or shared catalog data.
 */
export interface ParkRuleset {
  startingCash: number;
  /** Catalog definitions this park cannot build, on top of research locks. */
  lockedDefinitionIds: readonly string[];
  /** Scales the organic guest arrival interval. Above 1 = slower arrivals. */
  arrivalIntervalMultiplier: number;
  /** Scales the money each guest arrives with. */
  guestBudgetMultiplier: number;
  /** Scales the price guests are willing to pay for food, drinks, and facilities. */
  servicePriceToleranceMultiplier: number;
  /** Scales how fast hunger, thirst, and toilet need grow. */
  needDecayMultiplier: number;
  /** Scales path and building costs, and their bulldoze refunds. */
  constructionCostMultiplier: number;
  /** Scales the per-cycle operating expense of every ride. */
  rideOperatingCostMultiplier: number;
  /** Scales how long a ride waits for more riders before dispatching a partial load. */
  rideDispatchMultiplier: number;
  /** Scales how long every service takes per customer. */
  serviceDurationMultiplier: number;
  /** Scales how much need each purchase relieves. */
  needReliefMultiplier: number;
  /** Scales cleaner and mechanic wages. */
  staffSalaryMultiplier: number;
  /** Scales staff walking speed. */
  staffSpeedMultiplier: number;
  /**
   * Scales the share of rain and storm in the weather drawn for days that come after the park
   * starts. Below 1 = drier. Lower is better for the player.
   */
  wetWeatherMultiplier: number;
  /** Scales the extra construction cost of chain lifts on coaster hills. Lower is better for the player. */
  chainLiftCostMultiplier: number;
  /**
   * Scales what a recolour costs in a Scenario or on The Map (the per-mode cost table in GAME_CONFIG, 0
   * by default, so a no-op today). Never charged in the Sandbox. Lower is better for the player. Plumbing
   * for Phase 22 and 25 only: nothing may require a colour.
   */
  recolourCostMultiplier: number;
  /*
   * Phase 25: seven card-modifiable multipliers (base 1). Required in memory; a saved ruleset writes each only when it
   * differs from 1 (ParkSession.toPlainRuleset), so every park without such a card serialises exactly as before.
   */
  /** Scales how hard hot, rain and storm weather bite (sunny is exempt: its effect is a bonus). Lower is better. */
  weatherEffectMultiplier: number;
  /** Scales organic arrivals at night (21:30-05:00). Higher is better. */
  nightArrivalMultiplier: number;
  /** Scales the clock-day length of a Scenario or run park (720 s x m). The deadline never moves. Higher is better. */
  dayLengthMultiplier: number;
  /** Scales the organic guest potential (the crowd the park can hold). Higher is better. */
  crowdCapacityMultiplier: number;
  /** Scales what litter does to guests and the rating (not how much litter there is). Lower is better. */
  litterImpactMultiplier: number;
  /** Scales the per-cycle breakdown probability of every ride. Lower is better. */
  breakdownRateMultiplier: number;
  /** Scales the appeal of every scenery source. Higher is better. */
  sceneryAppealMultiplier: number;
  /** Phase 21: scales the price of a parcel of land. Lower is better. Saved only when != 1 (like the Phase 25 keys). */
  landCostMultiplier: number;
  /**
   * Biome layer (Phase 24): scales how fast hunger grows. Absent = 1 (Meadow, every scenario and every save
   * written before schema 8): the key exists only when the biome changes it, so a Meadow ruleset and its JSON
   * are exactly what they were. Not card-modifiable and not a scenario override in step 1.
   */
  hungerRateMultiplier?: number;
  /** Biome layer (Phase 24): scales how fast thirst grows. Absent = 1, like `hungerRateMultiplier`. */
  thirstRateMultiplier?: number;
  /**
   * Profile-bonus layer (Phase 22): research points a NEW park starts with (integer 1..30). Absent = 0; the key
   * exists only when a permanent bonus grants it, so every ruleset without bonuses is byte-identical to before.
   * Never card-modifiable.
   */
  startingResearchPoints?: number;
  /** Profile-bonus layer (Phase 22): extra Pulse Card slots (exactly 1 when present). Absent = 0. Never card-modifiable. */
  extraCardSlots?: number;
  /**
   * Phase 16 base layer: the theme-affinity share (a themed ride or stall gains min(maximumBonus, matching x share) on
   * its scenery score). Compiled from GAME_CONFIG.scenery.themeAffinity.share for a NEW park, clamped to
   * [0, maximumShare] and present only when it is not 0. Absent = 0, which is every save written before Phase 16: an
   * old park never gains affinity. Not card-modifiable and not a scenario override.
   */
  themeAffinity?: number;
  /**
   * Phase 16 base layer: the research-point cost scale (a project costs round(base RP x scale); milestones are
   * unscaled; the card and bonus RP grants are scaled at application). Compiled from GAME_CONFIG.research.costScale for
   * a NEW park, clamped to the config bounds and present only when it is not 1. Absent = 1 (every save before Phase 16).
   * Not card-modifiable and not a scenario override.
   */
  researchCostScale?: number;
  /**
   * Phase 14 base layer (content version 4): the congestion-feedback strength in (0, maximumFeedback]. Above load 1 (30
   * guests a minute per lane) a step onto a crowded tile slows and a severe tile costs happiness, both scaled by it.
   * Compiled from GAME_CONFIG.crowd.feedback for a NEW park, clamped and present only when not 0, written LAST (after
   * the Phase 16 keys). Absent = 0 = off, which is every save written before Phase 14: an old park never gains
   * feedback. Not card-modifiable, not a scenario override, no bonus.
   */
  crowdFeedback?: number;
}

/** The two keys only a permanent bonus can write. */
export const BONUS_ONLY_RULE_KEYS = ['startingResearchPoints', 'extraCardSlots'] as const;
export type BonusOnlyRuleKey = (typeof BONUS_ONLY_RULE_KEYS)[number];

/** The two biome-layer keys: compiled from the biome, never from a card or a scenario. */
export const BIOME_RULE_KEYS = ['hungerRateMultiplier', 'thirstRateMultiplier'] as const;
export type BiomeRuleKey = (typeof BIOME_RULE_KEYS)[number];

/** The two Phase 16 base-layer keys: compiled from GAME_CONFIG for a new park, never from a card, scenario or bonus. */
export const PHASE16_RULE_KEYS = ['themeAffinity', 'researchCostScale'] as const;
export type Phase16RuleKey = (typeof PHASE16_RULE_KEYS)[number];

/** The Phase 14 base-layer key: compiled from GAME_CONFIG for a new park, never from a card, scenario or bonus. */
export const PHASE14_RULE_KEYS = ['crowdFeedback'] as const;
export type Phase14RuleKey = (typeof PHASE14_RULE_KEYS)[number];

/**
 * Whether `compileParkRules` writes the Phase 14 key. Phase 14 Wave 1 landed the compile switched OFF (the session did
 * not save the key yet, and a live key that the save drops would make every restored session differ from the one that
 * was saved). Wave 2 switched it on in the same change that taught ParkSession to serialize and restore
 * `crowdFeedback` and the `crowd` field.
 */
export const CROWD_FEEDBACK_COMPILED: boolean = true;

/** What a biome contributes to the compiled ruleset. 1 = neutral. */
export type BiomeRules = Readonly<Record<BiomeRuleKey, number>>;

export const NEUTRAL_RULES_OF_BIOME: BiomeRules = Object.freeze({ hungerRateMultiplier: 1, thirstRateMultiplier: 1 });

/** The numeric multiplier rules Pulse Cards are allowed to touch. */
export type CardModifiableRule = Exclude<keyof ParkRuleset, 'startingCash' | 'lockedDefinitionIds' | BiomeRuleKey | BonusOnlyRuleKey | Phase16RuleKey | Phase14RuleKey>;

export type CardModifiers = Partial<Record<CardModifiableRule, number>>;

export const CARD_MODIFIABLE_RULES: readonly CardModifiableRule[] = [
  'arrivalIntervalMultiplier',
  'guestBudgetMultiplier',
  'servicePriceToleranceMultiplier',
  'needDecayMultiplier',
  'constructionCostMultiplier',
  'rideOperatingCostMultiplier',
  'rideDispatchMultiplier',
  'serviceDurationMultiplier',
  'needReliefMultiplier',
  'staffSalaryMultiplier',
  'staffSpeedMultiplier',
  'wetWeatherMultiplier',
  'chainLiftCostMultiplier',
  'recolourCostMultiplier',
  'weatherEffectMultiplier',
  'nightArrivalMultiplier',
  'dayLengthMultiplier',
  'crowdCapacityMultiplier',
  'litterImpactMultiplier',
  'breakdownRateMultiplier',
  'sceneryAppealMultiplier',
  'landCostMultiplier',
];

/**
 * The Phase 25 keys: optional in a saved ruleset (written only when != 1, after `recolourCostMultiplier` and before the
 * biome keys). An absent key reads as 1, so every save before Phase 25 restores unchanged.
 */
export const OPTIONAL_RULE_KEYS = [
  'weatherEffectMultiplier',
  'nightArrivalMultiplier',
  'dayLengthMultiplier',
  'crowdCapacityMultiplier',
  'litterImpactMultiplier',
  'breakdownRateMultiplier',
  'sceneryAppealMultiplier',
  'landCostMultiplier',
] as const satisfies readonly CardModifiableRule[];
export type OptionalRuleKey = (typeof OPTIONAL_RULE_KEYS)[number];

/** Which direction of each multiplier helps the player. Used to verify card tradeoffs. */
export const MULTIPLIER_DIRECTION: Readonly<Record<CardModifiableRule, 'higherIsBetter' | 'lowerIsBetter'>> = {
  arrivalIntervalMultiplier: 'lowerIsBetter',
  guestBudgetMultiplier: 'higherIsBetter',
  servicePriceToleranceMultiplier: 'higherIsBetter',
  needDecayMultiplier: 'lowerIsBetter',
  constructionCostMultiplier: 'lowerIsBetter',
  rideOperatingCostMultiplier: 'lowerIsBetter',
  rideDispatchMultiplier: 'lowerIsBetter',
  serviceDurationMultiplier: 'lowerIsBetter',
  needReliefMultiplier: 'higherIsBetter',
  staffSalaryMultiplier: 'lowerIsBetter',
  staffSpeedMultiplier: 'higherIsBetter',
  wetWeatherMultiplier: 'lowerIsBetter',
  chainLiftCostMultiplier: 'lowerIsBetter',
  recolourCostMultiplier: 'lowerIsBetter',
  weatherEffectMultiplier: 'lowerIsBetter',
  nightArrivalMultiplier: 'higherIsBetter',
  dayLengthMultiplier: 'higherIsBetter',
  crowdCapacityMultiplier: 'higherIsBetter',
  litterImpactMultiplier: 'lowerIsBetter',
  breakdownRateMultiplier: 'lowerIsBetter',
  sceneryAppealMultiplier: 'higherIsBetter',
  landCostMultiplier: 'lowerIsBetter',
};

export const RULE_CLAMPS = {
  minimumStartingCash: 0,
  maximumStartingCash: 1_000_000,
  minimumMultiplier: 0.25,
  maximumMultiplier: 4,
  /** The biome layer is small by design (see GAME_CONFIG.maps.biomeRuleClamp, the same bounds). */
  minimumBiomeMultiplier: 0.8,
  maximumBiomeMultiplier: 1.25,
} as const;

/**
 * The compiled permanent-bonus layer (src/game/profile/bonuses.ts builds it). Neutral = no bonuses: the compile
 * then does exactly the arithmetic it did before the layer existed.
 */
export interface BonusLayer {
  startingCashBonus: number;
  startingResearchPoints: number;
  extraCardSlots: number;
  multipliers: Partial<Record<CardModifiableRule, number>>;
  /** The ids that actually applied (mode-filtered, deduped, canonical order). */
  appliedBonusIds: BonusId[];
}

export const NEUTRAL_BONUS_LAYER: BonusLayer = Object.freeze({
  startingCashBonus: 0,
  startingResearchPoints: 0,
  extraCardSlots: 0,
  multipliers: Object.freeze({}),
  appliedBonusIds: Object.freeze([]) as unknown as BonusId[],
});

const clampNumber = (value: number, minimum: number, maximum: number, fallback: number): number =>
  Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : fallback;

const roundMultiplier = (value: number): number => Math.round((value + Number.EPSILON) * 1_000) / 1_000;

export const BASE_PARK_RULES: ParkRuleset = Object.freeze({
  startingCash: GAME_CONFIG.startingCash,
  lockedDefinitionIds: [],
  arrivalIntervalMultiplier: 1,
  guestBudgetMultiplier: 1,
  servicePriceToleranceMultiplier: 1,
  needDecayMultiplier: 1,
  constructionCostMultiplier: 1,
  rideOperatingCostMultiplier: 1,
  rideDispatchMultiplier: 1,
  serviceDurationMultiplier: 1,
  needReliefMultiplier: 1,
  staffSalaryMultiplier: 1,
  staffSpeedMultiplier: 1,
  wetWeatherMultiplier: 1,
  chainLiftCostMultiplier: 1,
  recolourCostMultiplier: 1,
  weatherEffectMultiplier: 1,
  nightArrivalMultiplier: 1,
  dayLengthMultiplier: 1,
  crowdCapacityMultiplier: 1,
  litterImpactMultiplier: 1,
  breakdownRateMultiplier: 1,
  sceneryAppealMultiplier: 1,
  landCostMultiplier: 1,
});

/**
 * Compiles the ruleset: base rules -> biome layer -> scenario overrides -> profile bonuses -> selected cards -> safety clamps.
 * The biome layer (hunger and thirst growth) is written only when it differs from 1, so Meadow, every
 * scenario and every pre-schema-8 save compile exactly the ruleset they always had.
 */
export const compileParkRules = (
  scenarioOverrides?: Partial<ParkRuleset>,
  cards: readonly CardModifiers[] = [],
  biome: BiomeRules = NEUTRAL_RULES_OF_BIOME,
  bonus: BonusLayer = NEUTRAL_BONUS_LAYER,
): ParkRuleset => {
  const multipliers = {} as Record<CardModifiableRule, number>;
  for (const rule of CARD_MODIFIABLE_RULES) {
    let value = scenarioOverrides?.[rule] ?? BASE_PARK_RULES[rule];
    if (!Number.isFinite(value) || value <= 0) value = BASE_PARK_RULES[rule];
    // The bonus layer sits between the scenario and the cards; an absent key adds no `x 1` to the float chain.
    const bonusFactor = bonus.multipliers[rule];
    if (bonusFactor !== undefined && Number.isFinite(bonusFactor) && bonusFactor > 0) value *= bonusFactor;
    for (const card of cards) {
      const factor = card[rule];
      if (factor !== undefined && Number.isFinite(factor) && factor > 0) value *= factor;
    }
    multipliers[rule] = roundMultiplier(
      clampNumber(value, RULE_CLAMPS.minimumMultiplier, RULE_CLAMPS.maximumMultiplier, 1),
    );
  }
  return {
    startingCash: clampNumber(
      (scenarioOverrides?.startingCash ?? BASE_PARK_RULES.startingCash) + bonus.startingCashBonus,
      RULE_CLAMPS.minimumStartingCash,
      RULE_CLAMPS.maximumStartingCash,
      BASE_PARK_RULES.startingCash,
    ),
    // Paths must always be buildable, and unknown ids would lock nothing but confuse the UI.
    lockedDefinitionIds: [...new Set(scenarioOverrides?.lockedDefinitionIds ?? [])]
      .filter((definitionId) => BUILD_BY_ID.get(definitionId)?.kind !== undefined)
      .filter((definitionId) => BUILD_BY_ID.get(definitionId)?.kind !== 'path'),
    ...multipliers,
    ...biomeLayer(biome),
    ...bonusKeys(bonus),
    ...phase16Keys(),
    ...(CROWD_FEEDBACK_COMPILED ? crowdFeedbackKeys() : {}),
  };
};

/** The effective theme-affinity share of a ruleset: absent = 0 (off). */
export const themeAffinityOf = (rules: Pick<ParkRuleset, 'themeAffinity'>): number => rules.themeAffinity ?? 0;

/** The effective research cost scale of a ruleset: absent = 1 (the pre-Phase-16 costs). */
export const researchCostScaleOf = (rules: Pick<ParkRuleset, 'researchCostScale'>): number => rules.researchCostScale ?? 1;

/**
 * The Phase 16 base-layer keys, read from GAME_CONFIG at COMPILE time (not frozen into BASE_PARK_RULES at import, so a
 * `vi.mock` of the config reaches every park). Clamped, rounded to 0.001, and written only when non-neutral (affinity 0,
 * scale 1), after the bonus keys: a neutral config compiles exactly the ruleset of before Phase 16.
 */
const phase16Keys = (): Partial<Pick<ParkRuleset, Phase16RuleKey>> => {
  const keys: Partial<Pick<ParkRuleset, Phase16RuleKey>> = {};
  const affinity = GAME_CONFIG.scenery.themeAffinity;
  const share = roundMultiplier(clampNumber(affinity.share, 0, affinity.maximumShare, 0));
  if (share !== 0) keys.themeAffinity = share;
  const bounds = GAME_CONFIG.research.costScaleBounds;
  const scale = roundMultiplier(clampNumber(GAME_CONFIG.research.costScale, bounds.minimum, bounds.maximum, 1));
  if (scale !== 1) keys.researchCostScale = scale;
  return keys;
};

/** The effective congestion-feedback strength of a ruleset: absent = 0 (off; the field is display only). */
export const crowdFeedbackOf = (rules: Pick<ParkRuleset, 'crowdFeedback'>): number => rules.crowdFeedback ?? 0;

/**
 * The Phase 14 base-layer key, read from GAME_CONFIG at COMPILE time (a `vi.mock` of the config reaches it), clamped to
 * [0, maximumFeedback], rounded to 0.001 and written only when not 0, after the Phase 16 keys: a config with feedback 0
 * compiles exactly the ruleset of before Phase 14. Exported for the tests of the compile layer.
 */
export const crowdFeedbackKeys = (): Partial<Pick<ParkRuleset, Phase14RuleKey>> => {
  const crowd = GAME_CONFIG.crowd;
  const strength = roundMultiplier(clampNumber(crowd.feedback, 0, crowd.maximumFeedback, 0));
  return strength !== 0 ? { crowdFeedback: strength } : {};
};

/** The pre-bonus starting cash of a scenario (or the Sandbox): what the cash-bonus cap is a share of. */
export const preBonusStartingCash = (scenarioOverrides?: Partial<ParkRuleset>): number => clampNumber(
  scenarioOverrides?.startingCash ?? BASE_PARK_RULES.startingCash,
  RULE_CLAMPS.minimumStartingCash,
  RULE_CLAMPS.maximumStartingCash,
  BASE_PARK_RULES.startingCash,
);

/** Written only when non-zero, after the biome keys. */
const bonusKeys = (bonus: BonusLayer): Partial<Pick<ParkRuleset, BonusOnlyRuleKey>> => {
  const keys: Partial<Pick<ParkRuleset, BonusOnlyRuleKey>> = {};
  if (Number.isInteger(bonus.startingResearchPoints) && bonus.startingResearchPoints > 0) keys.startingResearchPoints = bonus.startingResearchPoints;
  if (Number.isInteger(bonus.extraCardSlots) && bonus.extraCardSlots > 0) keys.extraCardSlots = bonus.extraCardSlots;
  return keys;
};

const biomeLayer = (biome: BiomeRules): Partial<Pick<ParkRuleset, BiomeRuleKey>> => {
  const layer: Partial<Record<BiomeRuleKey, number>> = {};
  for (const key of BIOME_RULE_KEYS) {
    const value = roundMultiplier(
      clampNumber(biome[key], RULE_CLAMPS.minimumBiomeMultiplier, RULE_CLAMPS.maximumBiomeMultiplier, 1),
    );
    if (value !== 1) layer[key] = value;
  }
  return layer;
};
