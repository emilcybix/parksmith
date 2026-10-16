import { CARD_BY_ID, kindOf, slotCostTotal } from '../game/cards/content';
import type { PulseCardId } from '../game/cards/types';
import { DEFAULT_MAP_ID } from '../game/maps/content';
import { layoutOfMapId } from '../game/maps/parse';
import type { MapId } from '../game/maps/types';
import type { GameMode } from '../game/modes/types';
import { modeHasCards } from '../game/modes/types';
import { BONUS_BY_ID, compileBonusLayer, type BonusDefinition, type BonusId } from '../game/profile/bonuses';
import type { ProfileSnapshot } from '../game/profile/types';
import { compileParkRules, preBonusStartingCash } from '../game/scenarios/rules';
import type { ScenarioDefinition } from '../game/scenarios/types';
import { modeLabel } from './modeLabels';
import { describeEffectiveModifiers, type EffectiveModifier } from './scenarioCopy';

/**
 * The loadout screen as pure data (Phase 22): the effective rules with the profile bonuses of the park's mode, the
 * card slots (a Spare card slot adds one), the card pool of the mode and the line about the permanent bonuses.
 */

export interface LoadoutModel {
  slots: number;
  /** Slots the selected cards take (a rare takes 2). */
  slotsUsed: number;
  /**
   * Cards the player may pick from: the Scenario collection, or the fallback pool a caller gives for another mode.
   * Stage cards only (Phase 25): one-shots are run-only.
   */
  poolCardIds: readonly PulseCardId[];
  /** "One-shot cards are played on The Map." when the pool held one-shots it leaves out; null otherwise. */
  oneShotNote: string | null;
  effective: EffectiveModifier[];
  /** "Permanent bonuses (Scenario): Nest egg +$500 · Spare card slot +1 slot", the "off" line, or null. */
  bonusLine: string | null;
  appliedBonusIds: BonusId[];
  startingCash: number;
}

/** "+$500", "+15 RP", "+1 slot", "−3%": the short effect after a bonus name. */
export const bonusEffectShort = (bonus: BonusDefinition): string => {
  const effect = bonus.effect;
  switch (effect.kind) {
    case 'startingCash': return `+$${effect.amount.toLocaleString('en-US')}`;
    case 'startingResearchPoints': return `+${effect.amount} RP`;
    case 'extraCardSlots': return `+${effect.amount} slot`;
    case 'multiplier': {
      const percent = Math.round((effect.factor - 1) * 100);
      return `${percent < 0 ? '−' : '+'}${Math.abs(percent)}%`;
    }
  }
};

const biomeRulesOf = (definition: ScenarioDefinition) => {
  try {
    return layoutOfMapId((definition.mapId ?? DEFAULT_MAP_ID) as MapId).biome.rules;
  } catch {
    return undefined;
  }
};

export const ONE_SHOTS_ON_THE_MAP = 'One-shot cards are played on The Map.';

export const buildLoadout = (
  definition: ScenarioDefinition,
  mode: GameMode,
  profile: ProfileSnapshot | null,
  selectedCardIds: readonly string[],
  fallbackPool: readonly PulseCardId[],
): LoadoutModel => {
  const switchedOn = profile?.useBonuses[mode] ?? mode !== 'sandbox';
  const earned = profile?.bonusIds ?? [];
  const layer = compileBonusLayer(switchedOn ? earned : [], mode, preBonusStartingCash(definition.rules));
  // A one-shot never joins a Scenario park (run-only): a stale or hostile selection of one changes nothing.
  const cards = selectedCardIds
    .map((cardId) => CARD_BY_ID.get(cardId as PulseCardId))
    .filter((card) => card !== undefined && card.kind === 'stage');
  const rules = compileParkRules(definition.rules, cards.map((card) => card.modifiers), biomeRulesOf(definition), layer);
  const applicable = earned.filter((id) => BONUS_BY_ID.get(id)?.modes.includes(mode) ?? false);
  let bonusLine: string | null = null;
  if (layer.appliedBonusIds.length > 0) {
    const parts = layer.appliedBonusIds.map((id) => {
      const bonus = BONUS_BY_ID.get(id);
      return bonus === undefined ? id : `${bonus.name} ${bonusEffectShort(bonus)}`;
    });
    bonusLine = `Permanent bonuses (${modeLabel(mode)}): ${parts.join(' · ')}`;
  } else if (!switchedOn && applicable.length > 0) {
    bonusLine = `Permanent bonuses are off for ${modeLabel(mode)} parks · change in Collection`;
  }
  const pool = mode === 'scenario' && profile !== null ? profile.collectionCardIds : fallbackPool;
  const stagePool = pool.filter((id) => kindOf(id) === 'stage');
  return {
    slots: definition.cardSlots + (modeHasCards(mode) ? layer.extraCardSlots : 0),
    slotsUsed: slotCostTotal(cards.map((card) => card.id)),
    poolCardIds: stagePool,
    oneShotNote: stagePool.length < pool.length ? ONE_SHOTS_ON_THE_MAP : null,
    effective: describeEffectiveModifiers(rules),
    bonusLine,
    appliedBonusIds: [...layer.appliedBonusIds],
    startingCash: rules.startingCash,
  };
};
