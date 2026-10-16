import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { CARD_BY_ID, PULSE_CARDS, STARTING_CARD_IDS } from './content';
import { draftRewardChoices } from './draft';
import type { CardRarity, PulseCardDefinition, PulseCardId } from './types';

/** Phase 25 (design 5.5): the Scenario reward draft on the keyed weighted draw, stage cards only, distinct families. */
const STAGE = PULSE_CARDS.filter((card) => card.kind === 'stage');

describe('Scenario reward draft', () => {
  it('is deterministic and independent of the owned list\'s form', () => {
    for (let seed = 0; seed < 50; seed += 1) {
      const owned = [...STARTING_CARD_IDS];
      expect(draftRewardChoices(owned, seed)).toEqual(draftRewardChoices(new Set(owned), seed));
      expect(draftRewardChoices(owned, seed)).toEqual(draftRewardChoices(owned, seed));
    }
    expect(draftRewardChoices([], 1.9)).toEqual(draftRewardChoices([], 1));
    expect(draftRewardChoices([], Number.NaN)).toEqual(draftRewardChoices([], 0));
  });

  it('offers only stage cards the player does not own, distinct, three of them', () => {
    for (let seed = 0; seed < 500; seed += 1) {
      const owned = new Set<PulseCardId>(STAGE.filter((_, index) => (index + seed) % 3 === 0).map((card) => card.id));
      const choices = draftRewardChoices(owned, seed * 7_919);
      expect(choices).toHaveLength(3);
      expect(new Set(choices).size).toBe(choices.length);
      for (const id of choices) {
        expect(owned.has(id)).toBe(false);
        expect(CARD_BY_ID.get(id)!.kind, id).toBe('stage');
      }
    }
  });

  it('the three choices come from three different families while three families remain', () => {
    for (let seed = 0; seed < 1_000; seed += 1) {
      const choices = draftRewardChoices([], seed);
      expect(new Set(choices.map((id) => CARD_BY_ID.get(id)!.family)).size, `seed ${seed}`).toBe(3);
    }
    // Two families left: the third choice repeats one, so the draft is never short while cards remain.
    const twoFamilies = STAGE.filter((card) => card.family !== 'weather' && card.family !== 'rides').map((card) => card.id);
    const choices = draftRewardChoices(twoFamilies, 3);
    expect(choices).toHaveLength(3);
    expect(new Set(choices.map((id) => CARD_BY_ID.get(id)!.family))).toEqual(new Set(['weather', 'rides']));
  });

  it('the first choice follows the rarity weights over 1,000 seeds (within 2 points)', () => {
    const weight = (rarity: CardRarity) => GAME_CONFIG.run.rarity[rarity].draftWeight;
    const total = STAGE.reduce((sum, card) => sum + weight(card.rarity), 0);
    const expected: Record<CardRarity, number> = { common: 0, uncommon: 0, rare: 0 };
    for (const card of STAGE) expected[card.rarity] += weight(card.rarity) / total;
    const seen: Record<CardRarity, number> = { common: 0, uncommon: 0, rare: 0 };
    for (let seed = 0; seed < 1_000; seed += 1) seen[CARD_BY_ID.get(draftRewardChoices([], seed)[0])!.rarity] += 1 / 1_000;
    for (const rarity of ['common', 'uncommon', 'rare'] as const) expect(Math.abs(seen[rarity] - expected[rarity]), rarity).toBeLessThanOrEqual(0.02);
  });

  it('is stable: adding a card changes a draft only where the new card itself wins a place', () => {
    const fake = { ...CARD_BY_ID.get('tip-jar')!, id: 'fake-card' as PulseCardId, family: 'economy' } as PulseCardDefinition;
    let changed = 0;
    for (let seed = 0; seed < 1_000; seed += 1) {
      const before = draftRewardChoices([], seed);
      const after = draftRewardChoices([], seed, 3, [...PULSE_CARDS, fake]);
      if (after.includes(fake.id)) changed += 1;
      else expect(after, `seed ${seed}`).toEqual(before);
    }
    expect(changed).toBeGreaterThan(0);
  });
});
