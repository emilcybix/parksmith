import { BIOME_IDS, type BiomeId } from '../biomes/types';
import { PULSE_CARD_IDS, rarityOf } from '../cards/content';
import type { PulseCardId } from '../cards/types';
import { GAME_CONFIG } from '../config';
import { entranceFrame } from '../maps/frame';
import { generateMap } from '../maps/generator';
import { propFootprintSize } from '../maps/parse';
import { PROP_KIND_BY_ID } from '../maps/props';
import { MAX_SEED, isMapSeed, recipeOf } from '../maps/recipe';
import { GROUND_WATER, type MapLayout, type MapRecipe } from '../maps/types';
import type { ObjectiveDefinition } from '../scenarios/types';
import { OPPOSING_CARD_PAIRS, RUN_FAMILY_COPY, allowedConditionsFor, deadCardIdsIn } from './content';
import { keyedWeightedDraw, runHash32, runRandom, shuffled } from './rng';
import {
  RUN_OBJECTIVE_FAMILIES, RUN_PLAN_VERSION, isRunDifficulty,
  type RunConditionId, type RunDifficulty, type RunObjectiveFamily, type RunPlan, type RunPlanInput, type RunPlanLevel,
} from './types';

/**
 * Run planning (Phase 23): everything about a run that is a pure function of (seed, difficulty), computed once at run
 * start. `planRun` is cheap (no maps); `createRun` (deck.ts) adds the accepted map recipes. Every draw is a stateless
 * stream draw (rng.ts), and every "ever added" count (copy cap, dead cards) comes from the plan itself, never from what
 * the player did, so a seed is the same run whatever is played.
 */

const CONFIG = GAME_CONFIG.run;
const DENSITIES = ['low', 'normal', 'high'] as const;

/** Thrown when no map of a level can be accepted: a plan or generator bug, never an input problem (the fuzz test pins it). */
export class RunPlanBug extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunPlanBug';
  }
}

/**
 * Test-only knobs: a fake pool and a fake dead-card table prove the protections with cards that do not exist yet (an
 * unknown id draws as a common, rarityOf).
 */
export interface PlanOverrides {
  pool?: readonly PulseCardId[];
  deadCardIds?: (biomeId: BiomeId) => readonly PulseCardId[];
}

export const assertPlanInput = (input: RunPlanInput): void => {
  if (!isMapSeed(input.seed)) throw new RangeError(`a run seed must be an integer in 0..${MAX_SEED}`);
  if (!isRunDifficulty(input.difficulty)) throw new RangeError(`unknown run difficulty '${String(input.difficulty)}'`);
};

export const levelRowOf = (levelIndex: number) => CONFIG.levels[Math.min(levelIndex, CONFIG.levels.length - 1)];

const roundTo = (value: number, step: number): number => Math.max(step, Math.round(value / step) * step);

/** The objective a level of a family has at a difficulty (an `ObjectiveDefinition` with id `run-<family>`). */
export const objectiveOf = (family: RunObjectiveFamily, levelIndex: number, difficulty: RunDifficulty): ObjectiveDefinition => {
  const targets = levelRowOf(levelIndex).targets;
  const setting = CONFIG.difficulties[difficulty];
  const copy = RUN_FAMILY_COPY[family];
  const id = `run-${family}`;
  switch (family) {
    case 'visitors':
      return { id, name: copy.name, kind: 'earn', metric: 'cumulativeGuests', target: roundTo((targets.visitors ?? 100) * setting.targetScale, CONFIG.rounding.visitors) };
    case 'profit':
      return { id, name: copy.name, kind: 'earn', metric: 'operatingProfit', target: roundTo((targets.profit ?? 2_000) * setting.targetScale, CONFIG.rounding.profit) };
    case 'crowd':
      return { id, name: copy.name, kind: 'reach', metric: 'guestCount', target: roundTo((targets.crowd ?? 50) * setting.targetScale, CONFIG.rounding.crowd) };
    default: {
      const spirits = targets.spirits ?? { bar: 66, seconds: 240 };
      const bar = Math.min(95, Math.max(1, spirits.bar + setting.spiritsBarDelta));
      // The hold is the spirits family's difficulty lever: it grows with the level (the table) and the difficulty.
      const seconds = roundTo(spirits.seconds * setting.spiritsSecondsScale, CONFIG.rounding.spiritsSeconds);
      return { id, name: copy.name, kind: 'sustain', metric: 'averageHappiness', comparison: 'atLeast', target: bar, durationSeconds: seconds };
    }
  }
};

/** The families a level may draw from, in canonical order. */
export const familiesAt = (levelIndex: number): RunObjectiveFamily[] => {
  const targets = levelRowOf(levelIndex).targets;
  return RUN_OBJECTIVE_FAMILIES.filter((family) => targets[family] !== undefined);
};

const densityAt = (levelIndex: number, difficulty: RunDifficulty): 'low' | 'normal' | 'high' => {
  const index = DENSITIES.indexOf(levelRowOf(levelIndex).density) + CONFIG.difficulties[difficulty].densityStep;
  return DENSITIES[Math.min(DENSITIES.length - 1, Math.max(0, index))];
};

export const conditionCountAt = (levelIndex: number, difficulty: RunDifficulty): number => (
  Math.min(CONFIG.maxConditionsPerLevel, Math.max(0, levelRowOf(levelIndex).conditions + CONFIG.difficulties[difficulty].conditionDelta))
);

/** Entry `levelIndex` of a per-level difficulty column (the last entry repeats if levelCount is raised). */
const perLevel = (column: readonly number[], levelIndex: number): number => column[Math.min(levelIndex, column.length - 1)];

/** A level's deadline in park days at a difficulty (design 7.1: the deadline is a difficulty column). */
export const deadlineDaysAt = (levelIndex: number, difficulty: RunDifficulty): number => (
  perLevel(CONFIG.difficulties[difficulty].deadlineDays, levelIndex)
);

export const startingCashAt = (levelIndex: number, difficulty: RunDifficulty): number => (
  Math.max(0, levelRowOf(levelIndex).startingCash + perLevel(CONFIG.difficulties[difficulty].cashDelta, levelIndex))
);

/** The biome of each level: `firstBiome`, then seeded shuffles of the others (a fresh shuffle per cycle, never the same biome twice in a row). */
export const biomesOf = (seed: number, levelCount: number): BiomeId[] => {
  const biomes: BiomeId[] = [CONFIG.firstBiome];
  let cycle = 0;
  while (biomes.length < levelCount) {
    const others = BIOME_IDS.filter((id) => id !== CONFIG.firstBiome);
    let order = shuffled(others, runRandom(seed, 'biomes', cycle));
    cycle += 1;
    if (order[0] === biomes[biomes.length - 1]) order = [...order.slice(1), order[0]];
    biomes.push(...order);
  }
  return biomes.slice(0, levelCount);
};

const canonicalIndex = (pool: readonly PulseCardId[]) => (id: PulseCardId): number => pool.indexOf(id);

/** True when `id` is the opposing partner of a card already chosen. */
const opposesAny = (id: PulseCardId, chosen: readonly PulseCardId[]): boolean => (
  OPPOSING_CARD_PAIRS.some(([a, b]) => (id === a && chosen.includes(b)) || (id === b && chosen.includes(a)))
);

/** The rarity row of a card (an unknown id, a test's fake card, reads as common). */
const rarityRowOf = (id: PulseCardId) => CONFIG.rarity[rarityOf(id)];

/**
 * The starter deck: a keyed weighted draw over the starter tiers (commons), distinct, never both halves of an opposing
 * pair. Canonical order.
 */
export const starterDeckOf = (seed: number, pool: readonly PulseCardId[] = PULSE_CARD_IDS): PulseCardId[] => {
  if (pool.length < CONFIG.starterDeckSize) throw new RangeError('the card pool is smaller than the starter deck');
  const base = runHash32(seed, 'starter');
  const size = CONFIG.starterDeckSize;
  const eligible = pool.map((id) => ({ id, weight: rarityRowOf(id).starter ? rarityRowOf(id).weight : 0 }));
  const chosen = keyedWeightedDraw(base, eligible, size, (id, picked) => !opposesAny(id, picked));
  // A pool too small to avoid every opposing pair still fills the deck (never reached with the shipped pool: tested),
  // first from the starter tiers, then from any card.
  if (chosen.length < size) chosen.push(...keyedWeightedDraw(base, eligible, size - chosen.length, (id) => !chosen.includes(id)));
  if (chosen.length < size) chosen.push(...keyedWeightedDraw(base, pool.map((id) => ({ id, weight: 1 })), size - chosen.length, (id) => !chosen.includes(id)));
  return chosen.sort((left, right) => canonicalIndex(pool)(left) - canonicalIndex(pool)(right));
};

/**
 * An offer card's draw weight before level `levelIndex` (design 5.2): 0 once it was added `copyCap` times, before its
 * tier's first level, or when it is dead in every biome still to come; otherwise its tier's weight.
 */
export const offerWeightOf = (
  id: PulseCardId,
  levelIndex: number,
  everAdded: number,
  remainingBiomes: readonly BiomeId[],
  dead: (biomeId: BiomeId) => readonly PulseCardId[] = deadCardIdsIn,
): number => {
  const tier = rarityRowOf(id);
  if (everAdded >= CONFIG.copyCap) return 0;
  if (levelIndex + 1 < tier.firstLevel) return 0;
  if (remainingBiomes.every((biomeId) => dead(biomeId).includes(id))) return 0;
  return tier.weight;
};

const levelCount = (): number => CONFIG.levelCount;

/** Plans one level (everything but the map recipe). `biomeId` and `family` can be forced for the biome x family stress tests. */
const planLevel = (
  seed: number,
  difficulty: RunDifficulty,
  levelIndex: number,
  biomeId: BiomeId,
  family: RunObjectiveFamily,
  offer: PulseCardId[],
): RunPlanLevel => {
  const candidates = allowedConditionsFor(levelIndex, biomeId, family);
  const count = Math.min(candidates.length, conditionCountAt(levelIndex, difficulty));
  const picked = shuffled(candidates, runRandom(seed, 'conditions', levelIndex)).slice(0, count);
  const conditionIds: RunConditionId[] = candidates.filter((condition) => picked.includes(condition)).map((condition) => condition.id);
  return {
    index: levelIndex,
    biomeId,
    parkSeed: runHash32(seed, 'park', levelIndex),
    family,
    objective: objectiveOf(family, levelIndex, difficulty),
    timeLimitDays: deadlineDaysAt(levelIndex, difficulty),
    startingCash: startingCashAt(levelIndex, difficulty),
    conditionIds,
    slots: CONFIG.slotsByLevel[Math.min(levelIndex, CONFIG.slotsByLevel.length - 1)],
    offer,
    density: densityAt(levelIndex, difficulty),
  };
};

/**
 * A level for the biome x family stress test: the same fields `planRun` gives, with the biome and family forced.
 * Test support (not used by the app).
 */
export const planLevelForTest = (
  seed: number,
  levelIndex: number,
  biomeId: BiomeId,
  family: RunObjectiveFamily,
  difficulty: RunDifficulty,
): RunPlanLevel => planLevel(seed, difficulty, levelIndex, biomeId, family, []);

/** Pure and cheap (no maps). Same input, same plan, in any process. */
export const planRun = (input: RunPlanInput, overrides: PlanOverrides = {}): RunPlan => {
  assertPlanInput(input);
  const { seed, difficulty } = input;
  const pool = overrides.pool ?? PULSE_CARD_IDS;
  const dead = overrides.deadCardIds ?? deadCardIdsIn;
  const count = levelCount();
  const biomes = biomesOf(seed, count);
  const starterDeck = starterDeckOf(seed, pool);
  const everAdded = new Map<PulseCardId, number>();
  for (const id of starterDeck) everAdded.set(id, (everAdded.get(id) ?? 0) + 1);
  const levels: RunPlanLevel[] = [];
  let previousFamily: RunObjectiveFamily | null = null;
  for (let index = 0; index < count; index += 1) {
    const allowed = familiesAt(index);
    const choices = allowed.filter((family) => family !== previousFamily);
    const options = choices.length > 0 ? choices : allowed;
    const family = options[Math.floor(runRandom(seed, 'family', index)() * options.length)];
    previousFamily = family;
    // Offers: the keyed weighted draw over the pool (weights by rarity, 0 when capped, too early or dead in every biome
    // still to come), distinct, never both halves of an opposing pair, offerSize cards.
    const remaining = biomes.slice(index);
    const candidates = pool.map((id) => ({ id, weight: offerWeightOf(id, index, everAdded.get(id) ?? 0, remaining, dead) }));
    const offer = keyedWeightedDraw(runHash32(seed, 'offer', index), candidates, CONFIG.offerSize, (id, chosen) => !opposesAny(id, chosen));
    offer.sort((left, right) => canonicalIndex(pool)(left) - canonicalIndex(pool)(right));
    for (const id of offer) everAdded.set(id, (everAdded.get(id) ?? 0) + 1);
    levels.push(planLevel(seed, difficulty, index, biomes[index], family, offer));
  }
  return {
    planVersion: RUN_PLAN_VERSION,
    seed,
    difficulty,
    consumeAt: CONFIG.consumeAt,
    offerRule: { ...CONFIG.offerRule },
    starterDeck,
    levels,
  };
};

// ---------------------------------------------------------------------------------------------
// Maps
// ---------------------------------------------------------------------------------------------

/** The seed of attempt `attempt` of a level's map. */
export const mapSeedFor = (seed: number, levelIndex: number, attempt: number): number => runHash32(seed, 'map', levelIndex, attempt);

/** True when the entrance corridor holds no water and no permanent (unclearable) land prop. */
export const corridorIsClear = (layout: MapLayout): boolean => {
  const frame = entranceFrame(layout.entrance);
  const { half, depth } = CONFIG.map.corridor;
  const blocked = new Set<number>();
  for (const prop of layout.props) {
    const kind = PROP_KIND_BY_ID.get(prop.kind);
    if (!kind || kind.clearCost !== null || kind.surface !== 'land') continue;
    const [w, d] = propFootprintSize(kind, prop.rotation);
    for (let dy = 0; dy < d; dy += 1) for (let dx = 0; dx < w; dx += 1) blocked.add((prop.y + dy) * layout.width + prop.x + dx);
  }
  for (let l = -half; l <= half; l += 1) {
    for (let d = 0; d <= depth; d += 1) {
      const cell = frame.toWorld(l, d);
      if (cell.x < 0 || cell.y < 0 || cell.x >= layout.width || cell.y >= layout.height) return false;
      const index = cell.y * layout.width + cell.x;
      if (layout.ground[index] === GROUND_WATER || blocked.has(index)) return false;
    }
  }
  return true;
};

export const mapIsAcceptable = (map: ReturnType<typeof generateMap>): boolean => (
  map.stats.cleared >= CONFIG.map.minimumClearedArea
  && map.stats.maxChunkWeight <= GAME_CONFIG.maps.generator.chunkPropWeightCap
  && map.stats.totalWeight <= GAME_CONFIG.maps.generator.mapPropWeightCap
  && corridorIsClear(map.layout)
);

/** The accepted recipe of a planned level: attempts with the level's density and water, then low and dry. RunPlanBug if none. */
export const acceptedRecipeOf = (seed: number, level: Pick<RunPlanLevel, 'index' | 'biomeId' | 'density'>): { recipe: MapRecipe; attempt: number } => {
  const { attempts, fallbackAttempts } = CONFIG.map;
  for (let attempt = 0; attempt < attempts + fallbackAttempts; attempt += 1) {
    const fallback = attempt >= attempts;
    const recipe = recipeOf(level.biomeId, mapSeedFor(seed, level.index, attempt), fallback ? { density: 'low', water: false } : { density: level.density, water: true });
    if (mapIsAcceptable(generateMap(recipe))) return { recipe, attempt };
  }
  throw new RunPlanBug(`no acceptable map for level ${level.index + 1} (${level.biomeId}) of run seed ${seed}`);
};
