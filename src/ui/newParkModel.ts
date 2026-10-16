import { BIOMES, BIOME_BY_ID, DEFAULT_BIOME_ID } from '../game/biomes/content';
import type { BiomeId } from '../game/biomes/types';
import { DEFAULT_MAP_ID, MAP_BY_ID, mapsOfBiome } from '../game/maps/content';
import { generateMap, type GeneratedMap } from '../game/maps/generator';
import { layoutOfMapId } from '../game/maps/parse';
import { mapFactsOf, mapPreviewOf, type MapPreviewImage } from '../game/maps/preview';
import {
  MAP_DENSITIES,
  MAX_SEED,
  biomeWaterOption,
  generatedMapName,
  parseSeedText,
  recipeOf,
} from '../game/maps/recipe';
import { GROUND_WATER, type MapDensity, type MapId, type MapRecipe } from '../game/maps/types';

/**
 * The New park picker as pure data (Phase 24 step 1). The component renders what these functions return and moves
 * focus; what the cards say, which map a biome selects first, what the facts line counts and what "Start" means are
 * decided here so they can be tested without a DOM. Meadow / Meadow Garden is the default selection, so New park +
 * Enter on the map row starts exactly today's sandbox.
 */

/** The picker's extra choice per biome: a map generated from a seed (Phase 24 step 2). It is never a shipped map id. */
export const GENERATE_CHOICE = 'generate' as const;
export type MapChoice = MapId | typeof GENERATE_CHOICE;

export interface NewParkSelection {
  biomeId: BiomeId;
  mapId: MapChoice;
}

/** What the Generate controls hold: the seed as typed (validated on use), the density and the water switch. */
export interface GeneratorDraft {
  seedText: string;
  density: MapDensity;
  water: boolean;
  /** Phase 21: a 64 x 64 estate (land for sale) instead of the classic 32 x 32 map. Absent = classic. */
  estate?: boolean;
}

export const DEFAULT_GENERATOR_DRAFT: GeneratorDraft = { seedText: '1', density: 'normal', water: true };

/** The seed text a Reroll puts in the field: a uint32 from `random` (0 <= random() < 1). Injected so tests are exact. */
export const rerolledSeedText = (random: () => number): string => String(Math.min(MAX_SEED, Math.floor(random() * (MAX_SEED + 1))));

export const SEED_HELP = `Seed: a whole number from 0 to ${MAX_SEED.toLocaleString('en-US')}.`;

/** The recipe a draft means on a biome, or the reason it does not. Water is forced off where the biome has none. */
export const recipeOfDraft = (biomeId: BiomeId, draft: GeneratorDraft): { recipe: MapRecipe; error: null } | { recipe: null; error: string } => {
  const seed = parseSeedText(draft.seedText);
  if (seed === null) return { recipe: null, error: SEED_HELP };
  return { recipe: recipeOf(biomeId, seed, { density: draft.density, water: draft.water, size: draft.estate === true ? 64 : 32 }), error: null };
};

const generatedCache = new Map<string, GeneratedMap>();
/** The generated map of a recipe (a recipe is a pure input, so a small cache is exact; the typing of a seed field re-renders often). */
export const generatedFor = (recipe: MapRecipe): GeneratedMap => {
  const key = `${recipe.biomeId}|${recipe.seed}|${recipe.density}|${recipe.water ? 1 : 0}|${recipe.size ?? 32}`;
  const hit = generatedCache.get(key);
  if (hit) return hit;
  const made = generateMap(recipe);
  generatedCache.set(key, made);
  if (generatedCache.size > 8) generatedCache.delete(generatedCache.keys().next().value as string);
  return made;
};

export const DEFAULT_NEW_PARK_SELECTION: NewParkSelection = { biomeId: DEFAULT_BIOME_ID, mapId: DEFAULT_MAP_ID };

export interface BiomeCard {
  id: BiomeId;
  name: string;
  tagline: string;
  climateLabel: string;
  /** Five '#rrggbb' strips, left to right (decorative: the card is named by text). */
  swatches: string[];
  /** How many maps the biome offers. */
  mapCount: number;
  selected: boolean;
}

export interface MapRow {
  id: MapId;
  name: string;
  blurb: string;
  /** "Gate: south edge · 12 obstacles · 8 water tiles". */
  facts: string;
  selected: boolean;
}

export interface GenerateRow {
  selected: boolean;
  name: string;
  blurb: string;
  /** "Gate: west edge · 112 obstacles" for a valid seed, otherwise the seed help. */
  facts: string;
}

export interface GenerateControls {
  seedText: string;
  seedError: string | null;
  density: MapDensity;
  densities: { id: MapDensity; label: string }[];
  /** The biome's water switch, or null where the biome has none. */
  water: { label: string; on: boolean } | null;
  /** Phase 21: the estate switch (64 x 64, buy land). */
  estate: boolean;
  recipe: MapRecipe | null;
}

export interface NewParkPicker {
  biomes: BiomeCard[];
  maps: MapRow[];
  generate: GenerateRow;
  /** The Generate controls; null unless the Generate choice is selected. */
  controls: GenerateControls | null;
  /** The top-down preview of the selected map (a shipped map, or the generated one); null for an invalid seed. */
  preview: MapPreviewImage | null;
  /** The text alternative of the preview. */
  previewLabel: string;
  /** The primary button: "Start Red Rock Canyon". */
  startLabel: string;
  /** False only for a Generate choice whose seed is not valid. */
  canStart: boolean;
  selection: NewParkSelection;
}

export const hex = (rgb: number): string => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;

const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Which edge of the map the gate is on. */
export const gateEdgeOf = (entrance: { x: number; y: number }, width: number, height: number): 'north' | 'east' | 'south' | 'west' => {
  if (entrance.y === 0) return 'north';
  if (entrance.y === height - 1) return 'south';
  if (entrance.x === 0) return 'west';
  if (entrance.x === width - 1) return 'east';
  return 'south';
};

/** The facts line: where the gate is, how many obstacles (props) stand on the land and how much of it is water. */
export const mapFacts = (mapId: MapId): string => {
  const layout = layoutOfMapId(mapId);
  let water = 0;
  for (const cell of layout.ground) if (cell === GROUND_WATER) water += 1;
  const parts = [`Gate: ${gateEdgeOf(layout.entrance, layout.width, layout.height)} edge`, plural(layout.props.length, 'obstacle')];
  if (water > 0) parts.push(plural(water, 'water tile'));
  return parts.join(' · ');
};

/** Whether `mapId` belongs to `biomeId` (a selection must never mix them). */
export const mapBelongsTo = (biomeId: BiomeId, mapId: MapChoice): boolean => (
  mapId === GENERATE_CHOICE ? BIOME_BY_ID.has(biomeId) : mapsOfBiome(biomeId).some((map) => map.id === mapId)
);

/** Selecting a biome selects its first map, or keeps the Generate choice when that is what was chosen (every biome has it). An unknown biome leaves the selection alone. */
export const selectBiome = (selection: NewParkSelection, biomeId: BiomeId): NewParkSelection => {
  if (!BIOME_BY_ID.has(biomeId)) return selection;
  if (selection.mapId === GENERATE_CHOICE) return selection.biomeId === biomeId ? selection : { biomeId, mapId: GENERATE_CHOICE };
  if (selection.biomeId === biomeId && mapBelongsTo(biomeId, selection.mapId)) return selection;
  const first = mapsOfBiome(biomeId)[0];
  return first === undefined ? selection : { biomeId, mapId: first.id };
};

/** Selecting a map of the selected biome. Anything else leaves the selection alone. */
export const selectMap = (selection: NewParkSelection, mapId: MapChoice): NewParkSelection => (
  mapBelongsTo(selection.biomeId, mapId) ? { biomeId: selection.biomeId, mapId } : selection
);

/** A selection the data can honour: the default when either id is unknown or they disagree. */
export const normaliseSelection = (selection: NewParkSelection): NewParkSelection => (
  BIOME_BY_ID.has(selection.biomeId) && mapBelongsTo(selection.biomeId, selection.mapId) ? selection : DEFAULT_NEW_PARK_SELECTION
);

const DENSITY_LABELS: Record<MapDensity, string> = { low: 'Low', normal: 'Normal', high: 'High' };

export const buildNewParkPicker = (input: NewParkSelection, draft: GeneratorDraft = DEFAULT_GENERATOR_DRAFT): NewParkPicker => {
  const selection = normaliseSelection(input);
  const biomes: BiomeCard[] = BIOMES.map((biome) => ({
    id: biome.id,
    name: biome.name,
    tagline: biome.tagline,
    climateLabel: biome.climateLabel,
    swatches: biome.swatches.map(hex),
    mapCount: mapsOfBiome(biome.id).length,
    selected: biome.id === selection.biomeId,
  }));
  const maps: MapRow[] = mapsOfBiome(selection.biomeId).map((map) => ({
    id: map.id,
    name: map.name,
    blurb: map.blurb,
    facts: mapFacts(map.id),
    selected: map.id === selection.mapId,
  }));
  const biomeName = BIOME_BY_ID.get(selection.biomeId)?.name ?? 'park';
  const generating = selection.mapId === GENERATE_CHOICE;
  const parsed = recipeOfDraft(selection.biomeId, draft);
  const generated = generating && parsed.recipe !== null ? generatedFor(parsed.recipe) : null;
  const water = biomeWaterOption(selection.biomeId);
  const generate: GenerateRow = {
    selected: generating,
    name: 'Generate a map',
    blurb: `A new ${biomeName} map from a seed: the same seed and settings always make the same land.`,
    facts: generated === null ? SEED_HELP : generatedFacts(generated),
  };
  const controls: GenerateControls | null = generating
    ? {
      seedText: draft.seedText,
      seedError: parsed.error,
      density: draft.density,
      densities: MAP_DENSITIES.map((id) => ({ id, label: DENSITY_LABELS[id] })),
      water: water.available && water.label !== null ? { label: water.label, on: draft.water } : null,
      estate: draft.estate === true,
      recipe: parsed.recipe,
    }
    : null;
  const chosen = generating ? undefined : MAP_BY_ID.get(selection.mapId as MapId);
  const preview = generating ? (generated === null ? null : mapPreviewOf(generated.layout)) : chosen === undefined ? null : mapPreviewOf(layoutOfMapId(chosen.id));
  const previewLabel = generating
    ? (parsed.recipe === null ? 'No preview: the seed is not valid' : `Preview of ${generatedMapName(parsed.recipe)} in ${biomeName}, north is up`)
    : `Preview of ${chosen?.name ?? 'the map'}, north is up`;
  return {
    biomes,
    maps,
    generate,
    controls,
    preview,
    previewLabel,
    startLabel: generating ? (parsed.recipe === null ? 'Start generated map' : `Start ${generatedMapName(parsed.recipe)}`) : `Start ${chosen?.name ?? 'park'}`,
    canStart: !generating || parsed.recipe !== null,
    selection,
  };
};

/** The facts line of a generated map: the same words as a shipped map's. */
const generatedFacts = (made: GeneratedMap): string => {
  const facts = mapFactsOf(made.layout);
  const parts = [`Gate: ${facts.gateEdge} edge`, plural(facts.obstacles, 'obstacle')];
  if (facts.water > 0) parts.push(plural(facts.water, 'water tile'));
  return parts.join(' · ');
};

/**
 * Roving focus inside one radio group: arrows move (wrapping), Home and End jump, and the moved-to item is selected
 * as it takes focus (a radio group's convention). Anything else is not ours (null).
 */
export const moveRadio = (ids: readonly string[], current: string, key: string): string | null => {
  if (ids.length === 0) return null;
  const index = Math.max(0, ids.indexOf(current));
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return ids[(index + 1) % ids.length];
    case 'ArrowLeft':
    case 'ArrowUp':
      return ids[(index - 1 + ids.length) % ids.length];
    case 'Home':
      return ids[0];
    case 'End':
      return ids[ids.length - 1];
    default:
      return null;
  }
};
