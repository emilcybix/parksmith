import { BIOME_BY_ID } from '../game/biomes/content';
import { CARD_BY_ID, kindOf, slotCostOf, slotCostTotal } from '../game/cards/content';
import type { CardKind, CardRarity, PulseCardId } from '../game/cards/types';
import { BONUS_BY_ID, compileBonusLayer } from '../game/profile/bonuses';
import { GAME_CONFIG } from '../game/config';
import { combinedConditionRules } from '../game/run/content';
import type { RunConditionId, RunSnapshot } from '../game/run/types';
import { compileParkRules } from '../game/scenarios/rules';
import { modeHasCards } from '../game/modes/types';
import { bonusEffectShort } from './loadoutModel';
import { cardCountText, daysText, money } from './runCopy';
import { describeEffectiveModifiers, objectiveSentence, type EffectiveModifier } from './scenarioCopy';
import { carriedDebtNote, startingCashAfterDebt } from './runResultModel';
import { plural } from './unlockCopy';

/**
 * The run loadout as pure data: the brief of the level, the deck as distinct cards with counts, the slot counter,
 * the combined rules of the conditions and the chosen cards (the same compile the stage session runs, with the run's
 * grant bonuses) and what the deck keeps afterwards.
 */

export interface LoadoutDeckCard {
  cardId: PulseCardId;
  icon: string;
  name: string;
  tagline: string;
  upside: string;
  downside: string;
  kind: CardKind;
  rarity: CardRarity;
  slotCost: 1 | 2;
  count: number;
  selected: boolean;
  /** This card is not chosen and its slot cost does not fit in the free slots: it cannot be added. */
  blocked: boolean;
  /** Why it is blocked ("No free slot", "Needs 2 free slots"); null when it is not. */
  blockedReason: string | null;
}

export interface RunLoadoutModel {
  heading: string;
  biomeName: string;
  objective: string;
  deadline: string;
  startingCash: string;
  conditions: Array<{ id: string; icon: string; name: string; detail: string }>;
  slots: number;
  /** Slots the chosen cards take (a rare takes 2). */
  slotsUsed: number;
  deck: LoadoutDeckCard[];
  counter: string;
  /** "Pocket: Coach Party, Bridging Loan": the chosen one-shots, played from Park Pulse during the level; null when none. */
  pocketLine: string | null;
  /** "No cards: this level plays with the conditions only." when nothing is chosen. */
  note: string | null;
  effective: EffectiveModifier[];
  bonusLine: string | null;
  afterLine: string;
  startLabel: string;
  startEnabled: boolean;
}

/**
 * The ids that may be sent to the bridge: distinct, in the deck, and their slot costs (a rare takes 2) within the slots,
 * kept in order. A card that does not fit in what is left is dropped; a later one that fits is still kept.
 */
export const sanitiseLoadout = (run: RunSnapshot, selected: readonly string[]): PulseCardId[] => {
  const inDeck = new Set(run.deck.map((row) => row.cardId));
  const out: PulseCardId[] = [];
  let used = 0;
  for (const raw of selected) {
    const id = raw as PulseCardId;
    if (!inDeck.has(id) || out.includes(id)) continue;
    const cost = slotCostOf(id);
    if (used + cost > run.slotsNow) continue;
    out.push(id);
    used += cost;
  }
  return out;
};

/** Toggle a card: removing is always possible, adding only when its slot cost fits in the free slots. */
export const toggleLoadoutCard = (run: RunSnapshot, selected: readonly string[], cardId: string): PulseCardId[] => {
  const current = sanitiseLoadout(run, selected);
  if (current.includes(cardId as PulseCardId)) return current.filter((id) => id !== cardId);
  return sanitiseLoadout(run, [...current, cardId]);
};

export const buildRunLoadout = (run: RunSnapshot, selected: readonly string[], grantBonusIds: readonly string[]): RunLoadoutModel | null => {
  const level = run.levels[run.levelIndex];
  if (level === undefined) return null;
  const chosen = sanitiseLoadout(run, selected);
  const conditionIds = level.conditions.map((condition) => condition.id as RunConditionId);
  // The park starts with the planned cash minus the debt the level before left (Phase 25, run/stage.ts levelStartingCashOf).
  const plannedCash = startingCashAfterDebt(run, level.index);
  const scenarioRules = { startingCash: plannedCash, ...combinedConditionRules(conditionIds) };
  const layer = compileBonusLayer(grantBonusIds, 'run', plannedCash);
  // One-shots change no park rule (their modifiers are empty): "Combined park rules" reads the stage cards only.
  const cards = chosen.flatMap((id) => {
    const card = CARD_BY_ID.get(id);
    return card === undefined || card.kind !== 'stage' ? [] : [card.modifiers];
  });
  const rules = compileParkRules(scenarioRules, cards, BIOME_BY_ID.get(level.biomeId)?.rules, layer);
  const bonusLine = layer.appliedBonusIds.length === 0
    ? null
    : `Permanent bonuses (The Map): ${layer.appliedBonusIds.map((id) => {
      const bonus = BONUS_BY_ID.get(id);
      return bonus === undefined ? id : `${bonus.name} ${bonusEffectShort(bonus)}`;
    }).join(' · ')}`;
  const used = slotCostTotal(chosen);
  const free = Math.max(0, run.slotsNow - used);
  const deck: LoadoutDeckCard[] = run.deck.flatMap(({ cardId, count }) => {
    const card = CARD_BY_ID.get(cardId);
    if (card === undefined) return [];
    const isSelected = chosen.includes(cardId);
    const blocked = !isSelected && card.slotCost > free;
    const blockedReason = !blocked ? null : card.slotCost > 1 ? `Needs ${card.slotCost} free slots` : 'No free slot';
    return [{
      cardId, icon: card.icon, name: card.name, tagline: card.tagline, upside: card.upside, downside: card.downside,
      kind: card.kind, rarity: card.rarity, slotCost: card.slotCost, count, selected: isSelected, blocked, blockedReason,
    }];
  });
  const pocket = chosen.filter((id) => kindOf(id) === 'one-shot').map((id) => CARD_BY_ID.get(id)?.name ?? id);
  const left = run.deckSize - chosen.length;
  const consumeAtClear = run.consumeAt === 'stage-clear';
  return {
    heading: `Choose cards for level ${level.index + 1}`,
    biomeName: level.biomeName,
    objective: objectiveSentence(level.objective),
    deadline: `Time limit ${daysText(level.timeLimitDays)}`,
    startingCash: `Starting cash ${money(rules.startingCash)}${carriedDebtNote(run, level.index)}`,
    conditions: level.conditions.map((condition) => ({ ...condition })),
    slots: run.slotsNow,
    slotsUsed: used,
    deck,
    counter: `${used} of ${plural(run.slotsNow, 'slot')} chosen · ${consumeAtClear ? 'these cards are used up when the level is cleared' : 'these cards are used up when the level starts'}${pocket.length > 0 && GAME_CONFIG.run.unplayedOneShots === 'return' ? ', except a one-shot you do not play, which comes back' : ''}`,
    pocketLine: pocket.length === 0 ? null : `Pocket: ${pocket.join(', ')}`,
    note: chosen.length === 0 ? 'No cards: this level plays with the conditions only.' : null,
    effective: describeEffectiveModifiers(rules),
    bonusLine: modeHasCards('run') ? bonusLine : null,
    afterLine: `After this level: ${cardCountText(left)} left in your deck.`,
    startLabel: `Start level ${level.index + 1}${chosen.length === 0 ? ' without cards' : ''}`,
    startEnabled: run.phase === 'loadout',
  };
};
