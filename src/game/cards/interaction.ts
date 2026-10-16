import { BIOME_IDS, type BiomeId } from '../biomes/types';
import { biomeOf } from '../biomes/content';
import { GAME_CONFIG } from '../config';
import { stationaryDistribution } from '../weather/chain';
import type { WeatherKind } from '../weather/types';
import { PULSE_CARDS } from './content';
import type { EffectAxis, PulseCardId } from './types';
import { downsideAxesOf, effectVectorOf, upsideAxesOf, type VectorSource } from './vector';

/**
 * Card x biome interaction (Phase 25, design 6), computed from the real weather chain, never assumed. An axis is dead in
 * a biome when its effect cannot happen there; today only the wet-weather axis can be (a biome whose stationary rain +
 * storm share is below GAME_CONFIG.run.deadWetShare). A card is dead when every upside axis is dead; `weak` is kept as a
 * state so a future biome is classified, and never occurs today.
 */
export type CardBiomeInteraction = 'live' | 'weak' | 'dead';

const wetShares = new Map<BiomeId, number>();

/** The stationary share of rain and storm days in a biome (the chain at wet multiplier 1 with the biome's mix). */
export const wetShareOf = (biomeId: BiomeId): number => {
  const cached = wetShares.get(biomeId);
  if (cached !== undefined) return cached;
  const distribution = stationaryDistribution(1, biomeOf(biomeId).weatherMix);
  const share = (GAME_CONFIG.weather.wetKinds as readonly WeatherKind[]).reduce((sum, kind) => sum + distribution[kind], 0);
  wetShares.set(biomeId, share);
  return share;
};

/** The effect axes that cannot do anything in a biome. */
export const deadAxesIn = (biomeId: BiomeId): ReadonlySet<EffectAxis> => {
  const dead = new Set<EffectAxis>();
  if (wetShareOf(biomeId) < GAME_CONFIG.run.deadWetShare) dead.add('wetWeatherMultiplier');
  return dead;
};

/** live, weak or dead: a card is dead in a biome when every upside axis is dead there. */
export const cardBiomeInteraction = (card: VectorSource, biomeId: BiomeId): CardBiomeInteraction => {
  const dead = deadAxesIn(biomeId);
  const upsides = upsideAxesOf(effectVectorOf(card));
  if (upsides.length > 0 && upsides.every((axis) => dead.has(axis))) return 'dead';
  return 'live';
};

/** The downside axes of a card that are dead in a biome (must be none anywhere: a dead downside is a free card). */
export const deadDownsidesIn = (card: VectorSource, biomeId: BiomeId): EffectAxis[] => {
  const dead = deadAxesIn(biomeId);
  return downsideAxesOf(effectVectorOf(card)).filter((axis) => dead.has(axis));
};

const deadColumns = new Map<BiomeId, readonly PulseCardId[]>();

/** The cards that do nothing in a biome, in canonical order (run/content.ts `deadCardIdsIn` reads this). */
export const deadCardIdsIn = (biomeId: BiomeId): readonly PulseCardId[] => {
  const cached = deadColumns.get(biomeId);
  if (cached) return cached;
  const column = Object.freeze(PULSE_CARDS.filter((card) => cardBiomeInteraction(card, biomeId) === 'dead').map((card) => card.id));
  deadColumns.set(biomeId, column);
  return column;
};

/** The 48 x 6 matrix (the BALANCE_NOTES artefact): one row per card, one cell per biome. */
export const interactionTable = (): Array<{ id: PulseCardId; cells: Record<BiomeId, CardBiomeInteraction> }> => (
  PULSE_CARDS.map((card) => ({
    id: card.id,
    cells: Object.fromEntries(BIOME_IDS.map((biomeId) => [biomeId, cardBiomeInteraction(card, biomeId)])) as Record<BiomeId, CardBiomeInteraction>,
  }))
);
