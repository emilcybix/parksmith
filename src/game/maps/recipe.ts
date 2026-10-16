import { BIOME_IDS, type BiomeId } from '../biomes/types';
import type { MapDensity, MapRecipe } from './types';

/**
 * Generator recipes (Phase 24 step 2): the small plain record that says how a generated map was made, plus the
 * pure helpers the save, the picker and the generator share. No generator code lives here (parse.ts imports this
 * module on restore, and a restore never regenerates).
 */

/** Bumped whenever the generator's output changes for any recipe; the golden-hash test pins the current output. */
export const GENERATOR_VERSION = 2;
export const MAX_SEED = 0xffff_ffff;
export const MAX_RECIPE_GENERATOR_VERSION = 0xffff;

export type { MapDensity, MapRecipe };
export const MAP_DENSITIES: readonly MapDensity[] = ['low', 'normal', 'high'];

export interface MapGeneratorOptions {
  readonly density: MapDensity;
  readonly water: boolean;
  /** Phase 21: 64 makes an estate; 32 (the default) the classic map. */
  readonly size: 32 | 64;
}
export const DEFAULT_GENERATOR_OPTIONS: MapGeneratorOptions = Object.freeze({ density: 'normal', water: true, size: 32 });

/** The picker label of each biome's water option; Desert Canyon has none (the option is hidden and `water` is false). */
const WATER_LABELS: Readonly<Record<BiomeId, string | null>> = {
  meadow: 'Ponds and brooks',
  seaside: 'Sea',
  'desert-canyon': null,
  winter: 'Thin ice',
  jungle: 'River',
  'autumn-forest': 'Streams',
};

export const biomeWaterOption = (biomeId: BiomeId): { readonly available: boolean; readonly label: string | null } => {
  const label = WATER_LABELS[biomeId] ?? null;
  return { available: label !== null, label };
};

export const isMapSeed = (value: unknown): value is number => (
  typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_SEED
);

/** The recipe for `(biome, seed, options)`. RangeError on a bad seed or biome. Water is forced off where the biome has none. */
export const recipeOf = (biomeId: BiomeId, seed: number, options: Partial<MapGeneratorOptions> = {}): MapRecipe => {
  if (!(BIOME_IDS as readonly string[]).includes(biomeId)) throw new RangeError(`unknown biome '${String(biomeId)}'`);
  if (!isMapSeed(seed)) throw new RangeError(`seed must be an integer in 0..${MAX_SEED}`);
  const density = options.density ?? DEFAULT_GENERATOR_OPTIONS.density;
  if (!MAP_DENSITIES.includes(density)) throw new RangeError(`unknown density '${String(density)}'`);
  const wanted = options.water ?? DEFAULT_GENERATOR_OPTIONS.water;
  const size = options.size ?? DEFAULT_GENERATOR_OPTIONS.size;
  if (size !== 32 && size !== 64) throw new RangeError(`size must be 32 or 64, not ${String(size)}`);
  return Object.freeze({
    generatorVersion: GENERATOR_VERSION,
    biomeId,
    seed,
    density,
    water: wanted && biomeWaterOption(biomeId).available,
    // Phase 21: written only for an estate, so a classic recipe keeps its exact shape.
    ...(size === 64 ? { size: 64 as const } : {}),
  });
};

/** `gen-<biome>-<seed>-<d><w>`, e.g. `gen-seaside-1234-nw`: fits [a-z0-9-]{1,64}. */
export const generatedMapId = (recipe: MapRecipe): string => (
  `gen-${recipe.biomeId}-${recipe.seed}-${recipe.density[0]}${recipe.water ? 'w' : 'd'}${recipe.size === 64 ? '-64' : ''}`
);

export const generatedMapName = (recipe: Pick<MapRecipe, 'seed'> & Partial<Pick<MapRecipe, 'size'>>): string => (
  recipe.size === 64 ? `Generated estate · seed ${recipe.seed}` : `Generated · seed ${recipe.seed}`
);

/** Seed text from a field: trimmed, plain decimal digits (no sign, exponent or separators), 0..MAX_SEED, else null. */
export const parseSeedText = (text: string): number | null => {
  if (typeof text !== 'string') return null;
  const trimmed = text.trim();
  if (!/^[0-9]{1,10}$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value <= MAX_SEED ? value : null;
};

const RECIPE_KEYS = ['generatorVersion', 'biomeId', 'seed', 'density', 'water'];

/** Shape check for saves and UI input: the recipe, or the first problem as text. Never throws. */
export const readRecipe = (value: unknown): MapRecipe | { readonly problem: string } => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return { problem: 'is not an object' };
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!RECIPE_KEYS.includes(key) && key !== 'size') return { problem: `has the unknown key '${key.slice(0, 40)}'` };
  }
  // Phase 21: `size` is optional and, when present, exactly 64 (an estate).
  if (Object.hasOwn(record, 'size') && record.size !== 64) return { problem: 'size must be 64 when present' };
  for (const key of RECIPE_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) return { problem: `is missing '${key}'` };
  }
  const { generatorVersion, biomeId, seed, density, water } = record;
  if (typeof generatorVersion !== 'number' || !Number.isInteger(generatorVersion) || generatorVersion < 1 || generatorVersion > MAX_RECIPE_GENERATOR_VERSION) {
    return { problem: `generatorVersion must be an integer in 1..${MAX_RECIPE_GENERATOR_VERSION}` };
  }
  if (typeof biomeId !== 'string' || !(BIOME_IDS as readonly string[]).includes(biomeId)) return { problem: 'biomeId is not a biome' };
  if (!isMapSeed(seed)) return { problem: `seed must be an integer in 0..${MAX_SEED}` };
  if (typeof density !== 'string' || !(MAP_DENSITIES as readonly string[]).includes(density)) return { problem: 'density must be low, normal or high' };
  if (typeof water !== 'boolean') return { problem: 'water must be a boolean' };
  if (water && !biomeWaterOption(biomeId as BiomeId).available) return { problem: `water is on for ${biomeId}, which has no water option` };
  return Object.freeze({
    generatorVersion, biomeId: biomeId as BiomeId, seed, density: density as MapDensity, water,
    ...(record.size === 64 ? { size: 64 as const } : {}),
  });
};
