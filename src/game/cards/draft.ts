import { GAME_CONFIG } from '../config';
import { keyedWeightedDraw } from '../run/rng';
import { hash32 } from '../weather/random';
import { PULSE_CARDS } from './content';
import type { CardFamily, PulseCardDefinition, PulseCardId } from './types';

/** The Scenario draft's stream salt (design 5.1). */
const DRAFT_SALT = 0x25c0_0001;

/**
 * Deterministic, duplicate-protected Scenario reward choices (Phase 25, design 5.5): the keyed weighted draw over the
 * STAGE cards the player does not own (one-shots are run-only), weighted by rarity (`draftWeight`), no level gate. Variety
 * adds no power: the choices come from different families while enough families remain. Draw order; at most `count`. An
 * empty result means the collection is complete and no draft is shown.
 */
export const draftRewardChoices = (
  ownedCardIds: ReadonlySet<PulseCardId> | readonly PulseCardId[],
  seed: number,
  count = 3,
  pool: readonly PulseCardDefinition[] = PULSE_CARDS,
): PulseCardId[] => {
  const owned = ownedCardIds instanceof Set ? ownedCardIds : new Set(ownedCardIds);
  const wanted = Math.max(0, Math.trunc(count));
  const available = pool.filter((card) => card.kind === 'stage' && !owned.has(card.id));
  const familyOf = new Map<PulseCardId, CardFamily>(available.map((card) => [card.id, card.family]));
  const candidates = available.map((card) => ({ id: card.id, weight: GAME_CONFIG.run.rarity[card.rarity].draftWeight }));
  const base = hash32(Number.isFinite(seed) ? Math.trunc(seed) >>> 0 : 0, DRAFT_SALT, 0);
  const distinctFamilies = (id: PulseCardId, chosen: readonly PulseCardId[]): boolean => (
    !chosen.some((other) => familyOf.get(other) === familyOf.get(id))
  );
  const chosen = keyedWeightedDraw(base, candidates, wanted, distinctFamilies);
  // Fewer families than choices left: fill the rest in draw order.
  if (chosen.length < wanted) {
    const rest = keyedWeightedDraw(base, candidates, wanted - chosen.length, (id) => !chosen.includes(id));
    chosen.push(...rest);
  }
  return chosen;
};
