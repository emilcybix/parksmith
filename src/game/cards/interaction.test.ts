import { describe, expect, it } from 'vitest';
import { BIOME_IDS, type BiomeId } from '../biomes/types';
import { GAME_CONFIG } from '../config';
import { deadCardIdsIn as runDeadCardIdsIn } from '../run/content';
import { planRun } from '../run/plan';
import { PULSE_CARDS } from './content';
import { cardBiomeInteraction, deadCardIdsIn, deadDownsidesIn, interactionTable, wetShareOf } from './interaction';
import type { CardTag, PulseCardDefinition } from './types';
import { effectVectorOf } from './vector';

interface NodeBuiltins {
  process: { stderr: { write(text: string): void } };
}
const nodeProcess = (globalThis as unknown as NodeBuiltins).process;

/** Phase 25 (design 6): card x biome interaction, declared by tags, computed from the real weather chain. */
describe('card x biome table', () => {
  it('prints the 48 x 6 matrix and pins the dead set exactly: Dry Spell and Farmer\'s Almanac in the Desert Canyon', () => {
    const table = interactionTable();
    expect(table).toHaveLength(PULSE_CARDS.length);
    const header = `card x biome | ${BIOME_IDS.join(' | ')}`;
    const rows = table.map((row) => `${row.id} | ${BIOME_IDS.map((biomeId) => row.cells[biomeId]).join(' | ')}`);
    nodeProcess.stderr.write(`${[header, ...rows].join('\n')}\n`);
    const dead = table.flatMap((row) => BIOME_IDS.filter((biomeId) => row.cells[biomeId] === 'dead').map((biomeId) => `${row.id}@${biomeId}`));
    expect(dead).toEqual(['dry-spell@desert-canyon', 'farmers-almanac@desert-canyon']);
    expect(table.flatMap((row) => BIOME_IDS.map((biomeId) => row.cells[biomeId])).filter((cell) => cell === 'weak')).toEqual([]);
  });

  it('every card is live in the Meadow (level 1 is always the Meadow) and in at least five biomes', () => {
    expect(GAME_CONFIG.run.firstBiome).toBe('meadow');
    for (const card of PULSE_CARDS) {
      expect(cardBiomeInteraction(card, 'meadow'), card.id).toBe('live');
      expect(BIOME_IDS.filter((biomeId) => cardBiomeInteraction(card, biomeId) === 'live').length, card.id).toBeGreaterThanOrEqual(5);
    }
  });

  it('tags agree with axes: a tag must touch its axis and every axis carries its tag', () => {
    const touches: Record<CardTag, (card: PulseCardDefinition) => boolean> = {
      wet: (card) => card.kind === 'stage' && 'wetWeatherMultiplier' in card.modifiers,
      weather: (card) => (card.kind === 'stage' && 'weatherEffectMultiplier' in card.modifiers) || (card.kind === 'one-shot' && card.effect.kind === 'forecast'),
      night: (card) => card.kind === 'stage' && 'nightArrivalMultiplier' in card.modifiers,
      coaster: (card) => card.kind === 'stage' && 'chainLiftCostMultiplier' in card.modifiers,
      crowd: (card) => (card.kind === 'stage' && 'crowdCapacityMultiplier' in card.modifiers) || (card.kind === 'one-shot' && card.effect.kind === 'surge'),
      litter: (card) => (card.kind === 'stage' && 'litterImpactMultiplier' in card.modifiers) || (card.kind === 'one-shot' && card.effect.kind === 'sweep'),
      repair: (card) => (card.kind === 'stage' && 'breakdownRateMultiplier' in card.modifiers) || (card.kind === 'one-shot' && card.effect.kind === 'repair'),
      // Scenery: the appeal rule, or a one-shot of the scenery family (Bloom Festival).
      scenery: (card) => (card.kind === 'stage' && 'sceneryAppealMultiplier' in card.modifiers) || (card.kind === 'one-shot' && card.family === 'scenery'),
      // Cash: a one-shot that pays out now.
      cash: (card) => card.kind === 'one-shot' && (card.vector.cashNow ?? 0) > 0,
      research: (card) => card.kind === 'one-shot' && card.effect.kind === 'research',
    };
    for (const card of PULSE_CARDS) {
      for (const tag of Object.keys(touches) as CardTag[]) {
        expect(card.tags.includes(tag as never), `${card.id} ${tag}`).toBe(touches[tag](card));
      }
      expect(new Set(card.tags).size, card.id).toBe(card.tags.length);
    }
  });

  it('no downside axis is dead anywhere (a dead downside would make a card free there)', () => {
    for (const card of PULSE_CARDS) for (const biomeId of BIOME_IDS) expect(deadDownsidesIn(card, biomeId), `${card.id} in ${biomeId}`).toEqual([]);
    // The rule itself: a wet-weather downside would be dead in the desert.
    expect(deadDownsidesIn({ kind: 'stage', modifiers: { wetWeatherMultiplier: 1.3, guestBudgetMultiplier: 1.1 } }, 'desert-canyon')).toEqual(['wetWeatherMultiplier']);
  });

  it('deadCardIdsIn (the run hook) equals the dead column for every biome, and a desert-only road never offers a dead card (300 seeds)', () => {
    for (const biomeId of BIOME_IDS) {
      const column = PULSE_CARDS.filter((card) => cardBiomeInteraction(card, biomeId) === 'dead').map((card) => card.id);
      expect(runDeadCardIdsIn(biomeId)).toEqual(column);
      expect(deadCardIdsIn(biomeId)).toEqual(column);
    }
    // Every remaining level forced to the desert: the dead rule sees the desert column everywhere.
    const desert = () => deadCardIdsIn('desert-canyon');
    const dead = new Set(deadCardIdsIn('desert-canyon'));
    for (let seed = 0; seed < 300; seed += 1) {
      const plan = planRun({ seed, difficulty: 'standard' }, { deadCardIds: desert });
      for (const level of plan.levels) {
        expect(level.offer.filter((id) => dead.has(id)), `seed ${seed} L${level.index + 1}`).toEqual([]);
        expect(level.offer).toHaveLength(GAME_CONFIG.run.offerSize);
      }
    }
  });

  it('the measured wet shares hold within 0.005, and a card is dead only through the wet axis', () => {
    const measured: Record<BiomeId, number> = { meadow: 0.206, seaside: 0.219, 'desert-canyon': 0.047, winter: 0.221, jungle: 0.367, 'autumn-forest': 0.263 };
    for (const biomeId of BIOME_IDS) expect(Math.abs(wetShareOf(biomeId) - measured[biomeId]), biomeId).toBeLessThanOrEqual(0.005);
    for (const card of PULSE_CARDS) {
      const upsides = Object.entries(effectVectorOf(card)).filter(([, value]) => (value ?? 0) > 0).map(([axis]) => axis);
      if (cardBiomeInteraction(card, 'desert-canyon') === 'dead') expect(upsides).toEqual(['wetWeatherMultiplier']);
    }
  });
});
