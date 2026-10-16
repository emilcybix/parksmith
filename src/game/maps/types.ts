import type { BiomeDefinition, BiomeId } from '../biomes/types';
import type { MapState, PropState } from '../save/state';
import type { Cell, Rotation } from '../types';
import type { PropKindId } from './props';

/**
 * Map data types (Phase 24). A MapDefinition is the authoring format (versioned, validated, hand-written
 * as ASCII); a MapLayout is the immutable runtime part of a map (built once per session, from a definition
 * or from a saved MapState); MapState is what a save holds (defined in save/state.ts, the one-state-module rule).
 */

export type { MapState, PropState };

/** The direction guests walk INTO the park from the gate (the inward direction of the border the gate is on). */
export type Facing = 'north' | 'east' | 'south' | 'west';

export const FACINGS: readonly Facing[] = ['north', 'east', 'south', 'west'];

export const FACING_VECTORS: Readonly<Record<Facing, Readonly<{ x: number; y: number }>>> = Object.freeze({
  north: Object.freeze({ x: 0, y: -1 }),
  east: Object.freeze({ x: 1, y: 0 }),
  south: Object.freeze({ x: 0, y: 1 }),
  west: Object.freeze({ x: -1, y: 0 }),
});

/** Ground layer values (index `y * width + x`). Props are NOT part of the ground; they stand on base ground. */
export const GROUND_BASE = 0;
export const GROUND_ALT = 1;
export const GROUND_WATER = 2;
export type GroundKind = typeof GROUND_BASE | typeof GROUND_ALT | typeof GROUND_WATER;

export const MAP_FORMAT_VERSION = 1;

/** How a generated map was made (Phase 24 step 2). Saved with the map; the stored ground and props win on restore. */
export type MapDensity = 'low' | 'normal' | 'high';
export interface MapRecipe {
  /** The generator version that made the map (informational on restore). */
  readonly generatorVersion: number;
  readonly biomeId: BiomeId;
  /** uint32. */
  readonly seed: number;
  readonly density: MapDensity;
  /** Always false for a biome without a water option. */
  readonly water: boolean;
  /**
   * Phase 21: 64 for a generated estate (64 x 64, land for sale around a starting area by the gate). Absent = the
   * classic 32 x 32, so every recipe made before keeps its exact shape and map.
   */
  readonly size?: 64;
}

export type MapId =
  | 'meadow'
  | 'brookside-meadow'
  | 'seaside-cove'
  | 'red-rock-canyon'
  | 'frosted-hollow'
  | 'emerald-ruins'
  | 'maple-ridge'
  /** Phase 21: the first estate (64 x 64, land for sale). */
  | 'meadow-estate';

/** A prop in the world: a stable id, its kind and its anchor (the min corner of its footprint). */
export interface PropPlacement {
  readonly id: number;
  readonly kind: PropKindId;
  readonly x: number;
  readonly y: number;
  readonly rotation: Rotation;
}

export interface MapEntrance {
  readonly x: number;
  readonly y: number;
  readonly facing: Facing;
}

export interface MapDefinition {
  readonly formatVersion: 1;
  /** A MapId for the shipped maps (ShippedMapDefinition); `gen-<biome>-<seed>-<dw>` for a generated one. */
  readonly id: string;
  readonly name: string;
  /** One line for the picker: the map's character and its decision (at most 120 characters). */
  readonly blurb: string;
  readonly biome: BiomeId;
  /** Whole parcels, GAME_CONFIG.land.minimumMapSize..maximumMapSize on each side (Phase 21); every hand-made map before it is 32. */
  readonly width: number;
  readonly height: number;
  /** The park seed of a sandbox on this map (weather, guests). Meadow: SANDBOX_SEED, so nothing moves. */
  readonly seed: number;
  /**
   * The land a new park on this map starts with (Phase 21): null = the whole map is owned (nothing to buy). Otherwise an
   * inclusive, parcel-aligned rectangle containing the entrance; the rest of the map is for sale parcel by parcel. The
   * owned set itself is saved with the world (`GameWorldState.land`), not with the map.
   */
  readonly ownedArea: null | { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  /** `height` strings of `width` characters (ASCII legend: see parse.ts). Exactly one 'E', on the border, not on a corner. */
  readonly rows: readonly string[];
  /**
   * Optional explicit ground (Phase 24 step 2): `height` rows of `width` characters from `.,~`. At a non-prop cell it must
   * equal the ground of `rows` ('E' counts as '.'); at a prop cell it is the ground under the prop (sand under a beach palm,
   * water under a pier). Absent = props stand on base ground (water-surface props on water), exactly as in step 1.
   */
  readonly ground?: readonly string[];
  /**
   * Free starting content stamped like scenario setup (no cash, no transactions). Shipped sandbox maps use none:
   * a pre-laid path would complete First Day's "lay a path" for the player. Supported for scenarios / The Map.
   */
  readonly startingObjects: {
    readonly paths: readonly Cell[];
    readonly objects: readonly { readonly definitionId: string; readonly anchor: Cell; readonly rotation?: Rotation }[];
  };
}

/** A hand-authored map: its id is one of the shipped MapIds. */
export type ShippedMapDefinition = MapDefinition & { readonly id: MapId };

/** The immutable part of a map, built once per session (from a MapDefinition or from a saved MapState). */
export interface MapLayout {
  /** A MapId for shipped maps; any [a-z0-9-]{1,64} for saved or generated ones. */
  readonly id: string;
  /** The shipped map's name, else 'Custom map'. */
  readonly name: string;
  readonly biome: BiomeDefinition;
  readonly width: number;
  readonly height: number;
  readonly entrance: MapEntrance;
  /** Never mutated. */
  readonly ground: Uint8Array;
  /** `${id}|${biome.id}|${hash of the ground rows}`: renderer cache key (classic terrain), stable across undo swaps. */
  readonly groundKey: string;
  /** The props at session start (the world keeps the live set). Ascending id. */
  readonly props: readonly PropPlacement[];
  /** Empty for a restored layout (the save carries the paths and objects). */
  readonly startingObjects: MapDefinition['startingObjects'];
  /** The map's seed (null for a restored layout: the save carries the park seed). */
  readonly seed: number | null;
  /** How the map was generated (null for a hand-made map). A restored layout takes it from the save. */
  readonly recipe: MapRecipe | null;
  /**
   * The starting owned area of a NEW park (Phase 21): present only when the definition restricts it (absent = the whole
   * map). A restored layout never has it: the save's `world.land` holds the owned set.
   */
  readonly ownedArea?: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
}

/** Thrown by layoutOfMap with every problem listed (the map data is code: a bad map is a bug, not a save). */
export class MapFormatError extends Error {
  readonly problems: readonly string[];

  constructor(mapId: string, problems: readonly string[]) {
    super(`Map '${mapId}' is malformed: ${problems.join('; ')}`);
    this.name = 'MapFormatError';
    this.problems = problems;
  }
}

export type MapProblemCode =
  | 'format' | 'size' | 'rows' | 'char' | 'entrance-count' | 'entrance-border' | 'entrance-corner'
  | 'entrance-inward-blocked' | 'legend' | 'block-shape' | 'too-many-props' | 'chunk-density'
  | 'apron-blocked' | 'open-area' | 'cleared-area' | 'starting-object' | 'owned-area' | 'seed' | 'ground' | 'surface';

export interface MapProblem {
  readonly code: MapProblemCode;
  readonly at: Cell | null;
  readonly detail: string;
}
