import type { BiomeId } from '../biomes/types';

/**
 * Prop kinds (Phase 24): the natural obstacles of a map. Props are a MAP LAYER owned by the world, not
 * placed objects (they are not in the build catalog, consume no object ids and are never read by the
 * scenery, estate or paint code). Pure data; the voxel blueprints and the classic art live with the renderers
 * and read `color`, `accent` and `colors` from here.
 */

export type PropKindId =
  | 'oak-tree' | 'shrub' | 'meadow-boulder' | 'mossy-log' | 'great-oak'
  | 'palm-tree' | 'dune-grass' | 'driftwood' | 'sea-stack' | 'tide-rock' | 'boardwalk-pier'
  | 'saguaro' | 'barrel-cactus' | 'red-boulder' | 'canyon-wall' | 'rock-spire'
  | 'snowy-pine' | 'snow-drift' | 'snowman' | 'granite-boulder' | 'glacier-rock'
  | 'kapok-tree' | 'fern' | 'jungle-bloom' | 'mossy-rock' | 'temple-ruin'
  | 'maple-tree' | 'golden-birch' | 'pumpkin-patch' | 'toadstools' | 'fallen-log' | 'stone-wall';

export type PropSurface = 'land' | 'water';
export type PropHeightClass = 'low' | 'mid' | 'tall';

export interface PropKindDefinition {
  readonly id: PropKindId;
  /** UI: "Blocked by Saguaro", "Cleared Saguaro". */
  readonly name: string;
  readonly biome: BiomeId;
  /** [w, d] of the UNROTATED footprint: [1,1], [2,1] (logs; rotation 1 or 3 lies along y) or [2,2]. */
  readonly footprint: readonly [number, number];
  /** Price to clear at a construction multiplier of 1; null = permanent (never clearable). */
  readonly clearCost: number | null;
  /** Phase 16 hook: 0 for every kind in step 1 (props give no scenery appeal; declared in ARCHITECTURE.md). */
  readonly appeal: 0;
  /** The two main colours (classic art; the voxel blueprints use them too). */
  readonly color: number;
  readonly accent: number;
  /** Every rgb the voxel blueprint uses that is not a fixed MAT_COLOR colour (palette registration). */
  readonly colors: readonly number[];
  /** Classic art size class and the see-through height hint. */
  readonly height: PropHeightClass;
  /** 'land' kinds stand on land (base or alt ground); 'water' kinds (a pier) stand on water. */
  readonly surface: PropSurface;
}

// Fixed palette colours the props reuse (the same values as the voxel MAT_COLOR table; a renderer test pins it).
const FOLIAGE = 0x48a96b;
const FOLIAGE_DARK = 0x2f855a;
const WOOD = 0x9a6b44;
const TIMBER = 0x79543a;
const STONE = 0xb9b2a4;
const FLOWER_PINK = 0xff7ca3;
const WHITE = 0xfff8ec;
const ARCH_PINK = 0xff6f91;

// Colours new to the palette (see the biome ground colours for the ground ones).
const PALM_TRUNK = 0xc49a6c;
const DRIFTWOOD = 0xd2c3a8;
const SEA_ROCK = 0x8a9aa0;
const SAND = 0xf8d384;
const CACTUS = 0x5fa463;
const CANYON_ROCK = 0xb8643f;
const CANYON_STRATA = 0xa65a3c;
const RED_ROCK_FLOOR = 0xc97a52;
const SNOW = 0xf2f7fc;
const PACKED_SNOW = 0xdfe9f3;
const THIN_ICE = 0xb9e2f2;
const GRANITE = 0x8e939c;
const JUNGLE_LEAF = 0x2e8b4a;
const RUIN_STONE = 0xa9a48c;
const MAPLE_RED = 0xd6503a;
const MAPLE_ORANGE = 0xf08b3a;
const BIRCH_GOLD = 0xf3c24f;
const CARROT = 0xf4b94e;
const BLOOM_YELLOW = 0xffcf56;

const kind = (
  id: PropKindId,
  name: string,
  biome: BiomeId,
  footprint: readonly [number, number],
  clearCost: number | null,
  height: PropHeightClass,
  color: number,
  accent: number,
  colors: readonly number[],
  surface: PropSurface = 'land',
): PropKindDefinition => ({ id, name, biome, footprint, clearCost, appeal: 0, color, accent, colors, height, surface });

/** In palette order (the voxel registry appends new materials in this order). */
export const PROP_KINDS: readonly PropKindDefinition[] = [
  kind('oak-tree', 'Oak tree', 'meadow', [1, 1], 60, 'tall', FOLIAGE, WOOD, []),
  kind('shrub', 'Shrub', 'meadow', [1, 1], 15, 'low', FOLIAGE_DARK, FLOWER_PINK, []),
  kind('meadow-boulder', 'Meadow boulder', 'meadow', [1, 1], 150, 'low', STONE, FOLIAGE, []),
  kind('mossy-log', 'Mossy log', 'meadow', [2, 1], 35, 'low', TIMBER, FOLIAGE, []),
  kind('great-oak', 'Great oak', 'meadow', [2, 2], null, 'tall', FOLIAGE_DARK, TIMBER, []),

  kind('palm-tree', 'Palm tree', 'seaside', [1, 1], 80, 'tall', PALM_TRUNK, FOLIAGE, [PALM_TRUNK]),
  kind('dune-grass', 'Dune grass', 'seaside', [1, 1], 12, 'low', FOLIAGE, SAND, [SAND]),
  kind('driftwood', 'Driftwood', 'seaside', [2, 1], 30, 'low', DRIFTWOOD, TIMBER, [DRIFTWOOD]),
  kind('sea-stack', 'Sea stack', 'seaside', [2, 2], null, 'tall', SEA_ROCK, WHITE, [SEA_ROCK]),
  kind('tide-rock', 'Tide rock', 'seaside', [1, 1], 120, 'low', SEA_ROCK, WHITE, [SEA_ROCK]),
  kind('boardwalk-pier', 'Boardwalk pier', 'seaside', [1, 1], null, 'low', TIMBER, WOOD, [], 'water'),

  kind('saguaro', 'Saguaro', 'desert-canyon', [1, 1], 70, 'tall', CACTUS, FLOWER_PINK, [CACTUS]),
  kind('barrel-cactus', 'Barrel cactus', 'desert-canyon', [1, 1], 25, 'low', CACTUS, ARCH_PINK, [CACTUS]),
  kind('red-boulder', 'Red boulder', 'desert-canyon', [1, 1], 180, 'mid', CANYON_ROCK, CANYON_STRATA, [CANYON_ROCK, CANYON_STRATA]),
  kind('canyon-wall', 'Canyon wall', 'desert-canyon', [1, 1], null, 'tall', CANYON_ROCK, CANYON_STRATA, [CANYON_ROCK, CANYON_STRATA]),
  kind('rock-spire', 'Rock spire', 'desert-canyon', [2, 2], null, 'tall', CANYON_ROCK, RED_ROCK_FLOOR, [CANYON_ROCK, RED_ROCK_FLOOR]),

  kind('snowy-pine', 'Snowy pine', 'winter', [1, 1], 70, 'tall', FOLIAGE_DARK, SNOW, [SNOW]),
  kind('snow-drift', 'Snow drift', 'winter', [1, 1], 10, 'low', SNOW, PACKED_SNOW, [SNOW, PACKED_SNOW]),
  kind('snowman', 'Snowman', 'winter', [1, 1], 30, 'mid', WHITE, ARCH_PINK, [CARROT]),
  kind('granite-boulder', 'Granite boulder', 'winter', [1, 1], 160, 'low', GRANITE, SNOW, [GRANITE, SNOW]),
  kind('glacier-rock', 'Glacier rock', 'winter', [2, 2], null, 'tall', THIN_ICE, GRANITE, [THIN_ICE, GRANITE, SNOW]),

  kind('kapok-tree', 'Kapok tree', 'jungle', [1, 1], 90, 'tall', JUNGLE_LEAF, WOOD, [JUNGLE_LEAF]),
  kind('fern', 'Fern', 'jungle', [1, 1], 15, 'low', JUNGLE_LEAF, FOLIAGE, [JUNGLE_LEAF]),
  kind('jungle-bloom', 'Jungle bloom', 'jungle', [1, 1], 20, 'low', FLOWER_PINK, BLOOM_YELLOW, [JUNGLE_LEAF, BLOOM_YELLOW]),
  kind('mossy-rock', 'Mossy rock', 'jungle', [1, 1], 150, 'low', STONE, FOLIAGE, []),
  kind('temple-ruin', 'Temple ruin', 'jungle', [2, 2], null, 'mid', RUIN_STONE, JUNGLE_LEAF, [RUIN_STONE, JUNGLE_LEAF]),

  kind('maple-tree', 'Maple tree', 'autumn-forest', [1, 1], 70, 'tall', MAPLE_RED, MAPLE_ORANGE, [MAPLE_RED, MAPLE_ORANGE]),
  kind('golden-birch', 'Golden birch', 'autumn-forest', [1, 1], 60, 'tall', BIRCH_GOLD, WHITE, [BIRCH_GOLD]),
  kind('pumpkin-patch', 'Pumpkin patch', 'autumn-forest', [1, 1], 20, 'low', MAPLE_ORANGE, FOLIAGE, [MAPLE_ORANGE]),
  kind('toadstools', 'Toadstools', 'autumn-forest', [1, 1], 10, 'low', MAPLE_RED, WHITE, [MAPLE_RED]),
  kind('fallen-log', 'Fallen log', 'autumn-forest', [2, 1], 40, 'low', TIMBER, FOLIAGE, []),
  kind('stone-wall', 'Stone wall', 'autumn-forest', [1, 1], null, 'low', STONE, FOLIAGE_DARK, []),
];

export const PROP_KIND_BY_ID: ReadonlyMap<PropKindId, PropKindDefinition> = new Map(
  PROP_KINDS.map((definition) => [definition.id, definition]),
);

export const PROP_KIND_IDS: readonly PropKindId[] = PROP_KINDS.map((definition) => definition.id);

export const isPropKindId = (value: unknown): value is PropKindId => (
  typeof value === 'string' && PROP_KIND_BY_ID.has(value as PropKindId)
);
