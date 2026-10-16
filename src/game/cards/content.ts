import { GAME_CONFIG } from '../config';
import { oneShotLines, stageCardLines } from './copy';
import { PULSE_CARD_TABLE } from './table';
import type { CardKind, CardRarity, PulseCardDefinition, PulseCardId, PulseCardRow } from './types';

/**
 * The Pulse Card pool as the game reads it: the table (table.ts) with generated copy, slot cost and `modifiers: {}` for a
 * one-shot. Canonical order = table order.
 */
const definitionOf = (row: PulseCardRow): PulseCardDefinition => {
  const slotCost = GAME_CONFIG.run.rarity[row.rarity].slotCost as 1 | 2;
  if (row.kind === 'stage') {
    return { ...row, modifiers: { ...row.modifiers }, ...stageCardLines(row.modifiers), slotCost } as PulseCardDefinition;
  }
  return { ...row, modifiers: {}, ...oneShotLines(row.effect), slotCost } as PulseCardDefinition;
};

export const PULSE_CARDS: readonly PulseCardDefinition[] = Object.freeze(
  (PULSE_CARD_TABLE as readonly PulseCardRow[]).map(definitionOf),
);

export const CARD_BY_ID: ReadonlyMap<PulseCardId, PulseCardDefinition> = new Map<PulseCardId, PulseCardDefinition>(
  PULSE_CARDS.map((card) => [card.id, card]),
);

export const PULSE_CARD_IDS: readonly PulseCardId[] = Object.freeze(PULSE_CARDS.map((card) => card.id));

export const isPulseCardId = (value: unknown): value is PulseCardId => (
  typeof value === 'string' && CARD_BY_ID.has(value as PulseCardId)
);

/** The collection a fresh profile starts with; the rest are discovered through reward drafts. */
export const STARTING_CARD_IDS: readonly PulseCardId[] = [
  'grand-opening',
  'local-contractors',
  'hungry-tourists',
];

/** Loadout slots a card takes (1 or 2, by rarity). An unknown id (a test's fake card) takes 1. */
export const slotCostOf = (id: PulseCardId): 1 | 2 => CARD_BY_ID.get(id)?.slotCost ?? 1;

/** A card's rarity. An unknown id (a test's fake card) reads as common. */
export const rarityOf = (id: PulseCardId): CardRarity => CARD_BY_ID.get(id)?.rarity ?? 'common';

/** A card's kind. An unknown id (a test's fake card) reads as a stage card. */
export const kindOf = (id: PulseCardId): CardKind => CARD_BY_ID.get(id)?.kind ?? 'stage';

/** The total slot cost of a list of cards. */
export const slotCostTotal = (ids: readonly PulseCardId[]): number => ids.reduce((sum, id) => sum + slotCostOf(id), 0);
