import { newParkResearchCostScale } from '../cards/copy';
import { modeHasCards } from '../modes/types';
import { scaledResearchPoints } from '../progression/content';
import type { GameMode } from '../modes/types';
import {
  MULTIPLIER_DIRECTION,
  NEUTRAL_BONUS_LAYER,
  type BonusLayer,
  type CardModifiableRule,
} from '../scenarios/rules';

export { NEUTRAL_BONUS_LAYER };
export type { BonusLayer };

/**
 * Permanent profile bonuses (Phase 22): SMALL, bounded, listed. Each is earned once (the first clear of its
 * scenario) and kept forever. They enter the compiled ruleset as one more layer
 * (base -> biome -> scenario -> BONUSES -> cards -> safety clamps) and are saved in the park's ruleset, so a
 * later change of the profile never touches a park in progress. No scenario may require one.
 */
export type BonusId = 'nest-egg' | 'research-grant' | 'builders-discount' | 'spare-slot' | 'word-of-mouth' | 'trusted-crew' | 'land-surveyor';

export type BonusEffect =
  | { kind: 'startingCash'; amount: number }
  | { kind: 'startingResearchPoints'; amount: number }
  | { kind: 'extraCardSlots'; amount: 1 }
  | { kind: 'multiplier'; rule: CardModifiableRule; factor: number };

export interface BonusDefinition {
  id: BonusId;
  name: string;
  icon: string;
  /** One sentence, shown everywhere. */
  summary: string;
  effect: BonusEffect;
  /** Modes where it can apply (extraCardSlots only where there are cards). */
  modes: readonly GameMode[];
}

export const BONUS_CLAMPS = {
  maxCashBonus: 1_000,
  maxCashBonusShare: 0.1,
  maxResearchPoints: 30,
  maxExtraCardSlots: 1,
  minFactor: 0.95,
  maxFactor: 1.05,
  maxBonuses: 8,
} as const;

const ALL_MODES: readonly GameMode[] = ['sandbox', 'scenario', 'run'];
const CARD_MODES: readonly GameMode[] = ['scenario', 'run'];

/** Canonical order: the order of this table. */
export const BONUSES: readonly BonusDefinition[] = [
  {
    id: 'nest-egg', name: 'Nest egg', icon: '$',
    summary: 'Parks start with $500 more cash.',
    effect: { kind: 'startingCash', amount: 500 }, modes: ALL_MODES,
  },
  {
    id: 'research-grant', name: 'Research grant', icon: '⌑',
    // Display only (never saved or hashed): the saved amount is 15 base RP, granted scaled by a new park's research cost
    // scale (Phase 16), so the line says what a new park actually receives.
    summary: `Parks start with ${scaledResearchPoints(15, newParkResearchCostScale())} research points.`,
    effect: { kind: 'startingResearchPoints', amount: 15 }, modes: ALL_MODES,
  },
  {
    id: 'builders-discount', name: "Builder's discount", icon: '⚒',
    summary: 'Construction costs 3% less.',
    effect: { kind: 'multiplier', rule: 'constructionCostMultiplier', factor: 0.97 }, modes: ALL_MODES,
  },
  {
    id: 'spare-slot', name: 'Spare card slot', icon: '✚',
    summary: 'One more Pulse Card slot in Scenario and The Map.',
    effect: { kind: 'extraCardSlots', amount: 1 }, modes: CARD_MODES,
  },
  {
    id: 'word-of-mouth', name: 'Word of mouth', icon: '☊',
    summary: 'Guests arrive 3% faster.',
    effect: { kind: 'multiplier', rule: 'arrivalIntervalMultiplier', factor: 0.97 }, modes: ALL_MODES,
  },
  {
    id: 'trusted-crew', name: 'Trusted crew', icon: '☺',
    summary: 'Staff wages are 5% lower.',
    effect: { kind: 'multiplier', rule: 'staffSalaryMultiplier', factor: 0.95 }, modes: ALL_MODES,
  },
  {
    // Phase 21: earned on the estate scenario; it only matters where land is for sale.
    id: 'land-surveyor', name: 'Land surveyor', icon: '▦',
    summary: 'Land costs 5% less.',
    effect: { kind: 'multiplier', rule: 'landCostMultiplier', factor: 0.95 }, modes: ALL_MODES,
  },
];

export const BONUS_BY_ID: ReadonlyMap<BonusId, BonusDefinition> = new Map(BONUSES.map((bonus) => [bonus.id, bonus]));

export const BONUS_IDS: readonly BonusId[] = BONUSES.map((bonus) => bonus.id);

export const isBonusId = (value: unknown): value is BonusId => (
  typeof value === 'string' && BONUS_BY_ID.has(value as BonusId)
);

export interface ActiveBonusSnapshot { id: BonusId; name: string; icon: string; summary: string }

export const activeBonusSnapshotOf = (ids: readonly BonusId[]): ActiveBonusSnapshot[] => (
  ids.flatMap((id) => {
    const bonus = BONUS_BY_ID.get(id);
    return bonus ? [{ id: bonus.id, name: bonus.name, icon: bonus.icon, summary: bonus.summary }] : [];
  })
);

/** Round down to a multiple of $10. */
const floorTen = (value: number): number => Math.floor(value / 10) * 10;

const clamp = (value: number, minimum: number, maximum: number): number => Math.min(maximum, Math.max(minimum, value));

/**
 * Compiles the bonus layer. Pure. Unknown, duplicate and hostile ids are ignored; a bonus outside its modes is
 * ignored; per-bonus clamps first (cash amount, research points, factor in [0.95, 1.05]), then the totals:
 * cash <= min($1,000, 10% of the pre-bonus starting cash rounded down to $10), research points <= 30, extra slots
 * <= 1, and per rule the product of factors stays in [0.95, 1/0.95]. A multiplier on the player's wrong side is
 * neutralised (a bonus is upside-only). `table` is injectable for tests; the shipped content has at most 8 bonuses.
 */
export const compileBonusLayer = (
  bonusIds: readonly unknown[],
  mode: GameMode,
  baseStartingCash: number,
  table: readonly BonusDefinition[] = BONUSES,
): BonusLayer => {
  if (!Array.isArray(bonusIds) || bonusIds.length === 0) return NEUTRAL_BONUS_LAYER;
  const wanted = new Set<string>();
  for (const id of bonusIds) if (typeof id === 'string') wanted.add(id);
  const multipliers: Partial<Record<CardModifiableRule, number>> = {};
  const applied: BonusId[] = [];
  let cash = 0;
  let researchPoints = 0;
  let extraSlots = 0;
  for (const bonus of table) {
    if (applied.length >= BONUS_CLAMPS.maxBonuses) break;
    if (!wanted.has(bonus.id) || !bonus.modes.includes(mode)) continue;
    const effect = bonus.effect;
    if (effect.kind === 'startingCash') {
      if (!Number.isFinite(effect.amount)) continue;
      cash += clamp(Math.floor(effect.amount), 0, BONUS_CLAMPS.maxCashBonus);
    } else if (effect.kind === 'startingResearchPoints') {
      if (!Number.isFinite(effect.amount)) continue;
      researchPoints += clamp(Math.floor(effect.amount), 0, BONUS_CLAMPS.maxResearchPoints);
    } else if (effect.kind === 'extraCardSlots') {
      if (!modeHasCards(mode)) continue;
      extraSlots += BONUS_CLAMPS.maxExtraCardSlots;
    } else {
      const direction = MULTIPLIER_DIRECTION[effect.rule];
      if (direction === undefined || !Number.isFinite(effect.factor) || effect.factor <= 0) continue;
      let factor = clamp(effect.factor, BONUS_CLAMPS.minFactor, BONUS_CLAMPS.maxFactor);
      // Upside-only: a factor on the wrong side of 1 is no bonus at all.
      if ((direction === 'lowerIsBetter' && factor > 1) || (direction === 'higherIsBetter' && factor < 1)) factor = 1;
      if (factor !== 1) {
        multipliers[effect.rule] = clamp(
          (multipliers[effect.rule] ?? 1) * factor,
          BONUS_CLAMPS.minFactor,
          1 / BONUS_CLAMPS.minFactor,
        );
      }
    }
    applied.push(bonus.id);
  }
  const base = Number.isFinite(baseStartingCash) ? Math.max(0, baseStartingCash) : 0;
  const cashCap = Math.min(BONUS_CLAMPS.maxCashBonus, floorTen(base * BONUS_CLAMPS.maxCashBonusShare));
  return {
    startingCashBonus: Math.min(cash, cashCap),
    startingResearchPoints: Math.min(researchPoints, BONUS_CLAMPS.maxResearchPoints),
    extraCardSlots: Math.min(extraSlots, BONUS_CLAMPS.maxExtraCardSlots),
    multipliers,
    appliedBonusIds: applied,
  };
};
