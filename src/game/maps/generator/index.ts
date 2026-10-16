import { BIOME_BY_ID } from '../../biomes/content';
import { BIOME_IDS, type BiomeDefinition, type BiomeId, type PropLegendChar } from '../../biomes/types';
import { GAME_CONFIG } from '../../config';
import { hashState } from '../../save/hash';
import { hash32 } from '../../weather/random';
import { groundRowsOf, layoutOfMap, propFootprintSize } from '../parse';
import { PROP_KIND_BY_ID } from '../props';
import {
  GENERATOR_VERSION, generatedMapId, generatedMapName, type MapRecipe,
} from '../recipe';
import {
  GROUND_ALT, GROUND_WATER, FACINGS, MAP_FORMAT_VERSION,
  type Facing, type MapDefinition, type MapEntrance, type MapLayout, type MapProblem, type PropPlacement,
} from '../types';
import { maxPropCellsPerChunk, reachableArea, validateMapDefinition } from '../validate';
import { CELLS, SIZE, createDraft, footprintCells, indexOf, setDraftSize, type DraftProp, type MapDraft } from './draft';
import { parcelGridOf, parcelIndexOfCell, parcelRect } from '../../land/parcels';
import { makeNoise, GEN_SALT } from './noise';
import { computeZones, placeRules } from './place';
import { BIOME_RECIPES, finishTerrain } from './recipes';
import { repairDraft, type RepairSteps } from './repair';
import { TAG, type GenContext } from './features';
import { propWeightPerChunk } from './weights';

/**
 * The procedural map generator (Phase 24 step 2): a PURE function of (biome, seed, density, water). It uses its own
 * positional integer hashes (never Math.random, a clock, the guest RNG or the weather RNG), so the same recipe gives
 * the same map in every process and in every call order. The pipeline is one pass plus a bounded repair; there is no
 * retry loop anywhere. See ARCHITECTURE.md, Biomes and maps, Map generator.
 */

export {
  DEFAULT_GENERATOR_OPTIONS, GENERATOR_VERSION, MAP_DENSITIES, MAX_RECIPE_GENERATOR_VERSION, MAX_SEED,
  biomeWaterOption, generatedMapId, generatedMapName, isMapSeed, parseSeedText, readRecipe, recipeOf,
  type MapDensity, type MapGeneratorOptions, type MapRecipe,
} from '../recipe';
export { PROP_BOX_WEIGHT, propWeightPerChunk } from './weights';
export { repairDraft, type RepairSteps } from './repair';
export { createDraft, type MapDraft } from './draft';

export interface GeneratedMapStats {
  /** Cells reachable from the gate without spending anything, and with every clearable prop cleared. */
  readonly open: number;
  readonly cleared: number;
  /** Land cells (not water, not under a permanent prop) that no clearing can reach from the gate; the repair pass joins them, so 0 except after a capped repair. */
  readonly stranded: number;
  readonly props: number;
  readonly propCells: number;
  readonly water: number;
  readonly alt: number;
  readonly maxPropCellsPerChunk: number;
  /** The summed prop box weight of the heaviest chunk and of the whole map (generator caps apply to exactly these). */
  readonly maxChunkWeight: number;
  readonly totalWeight: number;
  readonly repair: RepairSteps;
}

export interface GeneratedMap {
  readonly recipe: MapRecipe;
  /** rows + ground; `validateMapDefinition(definition)` is []. */
  readonly definition: MapDefinition;
  /** `layout.recipe === recipe`, `layout.name === generatedMapName(recipe)`. */
  readonly layout: MapLayout;
  readonly stats: GeneratedMapStats;
}

/** Thrown when the generator's own output fails the validator: a generator bug, never an input problem. */
export class MapGeneratorBug extends Error {
  readonly recipe: MapRecipe;
  readonly problems: readonly MapProblem[];

  constructor(recipe: MapRecipe, problems: readonly MapProblem[]) {
    super(`The map generator produced an invalid map for ${generatedMapId(recipe)}: ${problems.map((problem) => `${problem.code} ${problem.detail}`).join('; ')}`);
    this.name = 'MapGeneratorBug';
    this.recipe = recipe;
    this.problems = problems;
  }
}

const DENSITY_INDEX = { low: 0, normal: 1, high: 2 } as const;
const GROUND_CHARS = '.,~';

const legendCharOf = (biome: BiomeDefinition): Map<string, string> => {
  const chars = new Map<string, string>();
  for (const [char, kind] of Object.entries(biome.legend)) if (kind) chars.set(kind, char);
  return chars;
};

const emit = (draft: MapDraft, recipe: MapRecipe, biome: BiomeDefinition, facing: Facing): MapDefinition => {
  const chars = legendCharOf(biome);
  const rows: string[][] = [];
  const ground: string[][] = [];
  for (let y = 0; y < SIZE; y += 1) {
    const rowChars: string[] = [];
    const groundChars: string[] = [];
    for (let x = 0; x < SIZE; x += 1) {
      const g = GROUND_CHARS[draft.ground[indexOf(x, y)]];
      groundChars.push(g);
      rowChars.push(g);
    }
    rows.push(rowChars);
    ground.push(groundChars);
  }
  for (const prop of draft.props) {
    if (!prop) continue;
    const kind = PROP_KIND_BY_ID.get(prop.kind);
    const char = chars.get(prop.kind);
    if (!kind || !char) throw new Error(`generator: no legend character for ${prop.kind}`);
    footprintCells(kind, prop.x, prop.y, prop.rotation, (cx, cy) => { rows[cy][cx] = char; });
  }
  rows[draft.gate.y][draft.gate.x] = 'E';
  return {
    formatVersion: MAP_FORMAT_VERSION,
    id: generatedMapId(recipe),
    name: generatedMapName(recipe),
    blurb: BIOME_RECIPES[recipe.biomeId].blurb(facing, recipe.water),
    biome: recipe.biomeId,
    width: SIZE,
    height: SIZE,
    seed: recipe.seed,
    ownedArea: estateOwnedArea(draft.gate),
    rows: rows.map((row) => row.join('')),
    ground: ground.map((row) => row.join('')),
    startingObjects: { paths: [], objects: [] },
  };
};

/**
 * Phase 21: the starting land of a generated estate: four parcels along the gate's edge (centred on the gate's parcel,
 * kept inside the map) and three deep. Null on a classic 32 x 32 map (wholly owned).
 */
const estateOwnedArea = (gate: MapEntrance): MapDefinition['ownedArea'] => {
  if (SIZE === GAME_CONFIG.mapWidth) return null;
  const grid = parcelGridOf(SIZE, SIZE);
  const gateRect = parcelRect(grid, parcelIndexOfCell(grid, gate.x, gate.y));
  const parcel = grid.parcelSize;
  const alongX = gate.facing === 'north' || gate.facing === 'south';
  const gateAlong = alongX ? gateRect.x0 / parcel : gateRect.y0 / parcel;
  const first = Math.min(Math.max(gateAlong - 1, 0), grid.columns - 4);
  const along0 = first * parcel;
  const along1 = (first + 4) * parcel - 1;
  const deep = 3 * parcel;
  switch (gate.facing) {
    case 'north': return { x0: along0, y0: SIZE - deep, x1: along1, y1: SIZE - 1 };
    case 'south': return { x0: along0, y0: 0, x1: along1, y1: deep - 1 };
    case 'east': return { x0: 0, y0: along0, x1: deep - 1, y1: along1 };
    default: return { x0: SIZE - deep, y0: along0, x1: SIZE - 1, y1: along1 };
  }
};

const gateOf = (facing: Facing, along: number): MapEntrance => {
  switch (facing) {
    case 'north': return { x: along, y: SIZE - 1, facing };
    case 'south': return { x: along, y: 0, facing };
    case 'east': return { x: 0, y: along, facing };
    default: return { x: SIZE - 1, y: along, facing };
  }
};

const statsOf = (layout: MapLayout, repair: RepairSteps): GeneratedMapStats => {
  let water = 0;
  let alt = 0;
  for (let index = 0; index < CELLS; index += 1) {
    if (layout.ground[index] === GROUND_WATER) water += 1;
    else if (layout.ground[index] === GROUND_ALT) alt += 1;
  }
  let propCells = 0;
  let permanentCells = 0;
  for (const prop of layout.props) {
    const kind = PROP_KIND_BY_ID.get(prop.kind)!;
    const [w, d] = propFootprintSize(kind, prop.rotation);
    propCells += w * d;
    if (kind.clearCost === null && kind.surface === 'land') permanentCells += w * d;
  }
  const weights = propWeightPerChunk(layout, layout.props);
  const cleared = reachableArea(layout, layout.props, { clearClearable: true });
  return {
    open: reachableArea(layout, layout.props, { clearClearable: false }),
    cleared,
    stranded: CELLS - water - permanentCells - cleared,
    props: layout.props.length,
    propCells,
    water,
    alt,
    maxPropCellsPerChunk: maxPropCellsPerChunk(layout, layout.props),
    maxChunkWeight: Math.max(0, ...weights),
    totalWeight: weights.reduce((sum, value) => sum + value, 0),
    repair,
  };
};

/**
 * Pure. Throws RangeError for a recipe of another generator version (an old recipe cannot be reproduced by this
 * build: the save holds the map itself, so nothing needs it), MapGeneratorBug if the output fails the validator.
 */
export const generateMap = (recipe: MapRecipe): GeneratedMap => {
  if (recipe.generatorVersion !== GENERATOR_VERSION) {
    throw new RangeError(`this build generates version ${GENERATOR_VERSION} maps, not version ${recipe.generatorVersion}`);
  }
  // Phase 21: an estate is generated at 64 a side; the draft size is put back whatever happens.
  setDraftSize(recipe.size ?? GAME_CONFIG.mapWidth);
  try {
    return generateAtSize(recipe);
  } finally {
    setDraftSize(GAME_CONFIG.mapWidth);
  }
};

const generateAtSize = (recipe: MapRecipe): GeneratedMap => {
  const biome = BIOME_BY_ID.get(recipe.biomeId);
  if (!biome) throw new RangeError(`unknown biome '${String(recipe.biomeId)}'`);
  const noise = makeNoise(hash32(recipe.seed, BIOME_IDS.indexOf(recipe.biomeId) + 1, GEN_SALT));
  const facing = FACINGS[noise.pick(TAG.facing, 4)];
  const gateAlong = noise.range(TAG.gate, 6, SIZE - 7);
  const draft = createDraft(gateOf(facing, gateAlong));
  const ctx: GenContext = { draft, noise, density: DENSITY_INDEX[recipe.density], water: recipe.water, facing, gateAlong };
  const biomeRecipe = BIOME_RECIPES[recipe.biomeId];
  finishTerrain(ctx, biomeRecipe);
  biomeRecipe.decide(ctx);
  placeRules(draft, noise, computeZones(draft), biomeRecipe.rules, ctx.density, TAG.rules);
  const { steps } = repairDraft(draft, { open: GAME_CONFIG.maps.generator.minimumOpenArea, cleared: GAME_CONFIG.maps.generator.minimumClearedArea });

  const definition = emit(draft, recipe, biome, facing);
  const problems = validateMapDefinition(definition);
  if (problems.length > 0) throw new MapGeneratorBug(recipe, problems);
  const layout = layoutOfMap(definition, recipe);
  return Object.freeze({ recipe: layout.recipe as MapRecipe, definition, layout, stats: statsOf(layout, steps) });
};

/** The game-side hash of a generated map (ground rows, props, entrance, biome): what the golden tests pin. */
export const generatedMapHash = (map: GeneratedMap | MapLayout): string => {
  const layout = 'layout' in map ? map.layout : map;
  return hashState({
    biome: layout.biome.id,
    ground: groundRowsOf(layout.ground, layout.width, layout.height),
    entrance: layout.entrance,
    props: layout.props.map((prop: PropPlacement) => [prop.kind, prop.x, prop.y, prop.rotation]),
  });
};

export type { BiomeId, DraftProp, PropLegendChar };
