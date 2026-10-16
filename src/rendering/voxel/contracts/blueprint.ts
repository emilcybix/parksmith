/**
 * Blueprints: models as data, compiled to boxes at runtime.
 *
 * Model space: the origin is the footprint's minimum corner on the ground; x ∈ [0, 32·w) and
 * y ∈ [0, 32·d) for the UNROTATED catalog footprint [w, d]; z ≥ 0 up. Objects on a plot stand on the
 * plot slab, so their shapes start at z = PLOT_TOP_Z (1) — the compiler carves z < floorZ (default 1).
 * Coaster cars are the exception: their model space is centred on the car's pivot (see content.ts).
 * The model's front faces model +y (screen lower-left); a visual quarter turn moves it to +x.
 *
 * Shapes are voxelized in order into a dense grid per part (a later shape overwrites earlier voxels;
 * material 0 carves), then greedy-meshed into disjoint boxes, hollowed where that removes most of
 * the hidden volume, and sorted front-to-back (descending max-corner depth key) so real GPUs can
 * reject hidden fragments early.
 *
 * Part 0 is the static body (slot 0, boxes in model space). Parts 1+ move: their shapes and pivot
 * are authored in model space too, and the compiler emits their boxes relative to the pivot.
 */

export type Vec3 = readonly [number, number, number];
export type Axis = 'x' | 'y' | 'z';

/**
 * Phase 28 colour slots. A shape's `material` may carry a slot tag: `material = paletteMaterial + 256 · tag`
 * (tag 1..COLOUR_TAG_LIMIT − 1, from COLOUR_SLOT_TAG in game/content/colours.ts; 0 = fixed). The tag marks
 * the shapes a player's swatch repaints; the compiler carries it per box (CompiledPart boxes, field 7) and
 * StaticWorld swaps the material byte of tagged boxes while it copies a recoloured object into its chunk.
 * A tag never changes geometry: the default blueprint compiles to the same boxes it did before tags existed.
 */
export const COLOUR_TAG_STRIDE = 256;
/** Tags occupy 3 bits of the per-voxel pattern byte (pattern < 32 uses the low 5). */
export const COLOUR_TAG_LIMIT = 8;

/** Tags a palette material as belonging to colour slot `tag` (1..7). */
export const slotted = (material: number, tag: number): number => {
  if (!Number.isInteger(tag) || tag < 1 || tag >= COLOUR_TAG_LIMIT) throw new Error(`slotted: tag must be an integer in [1, ${COLOUR_TAG_LIMIT}) (got ${tag})`);
  if (!Number.isInteger(material) || material < 1 || material >= COLOUR_TAG_STRIDE) throw new Error(`slotted: material must be a palette material in [1, ${COLOUR_TAG_STRIDE}) (got ${material})`);
  return material + COLOUR_TAG_STRIDE * tag;
};

/** The palette material of a shape's `material` field (tag stripped). */
export const materialOfShape = (material: number): number => material % COLOUR_TAG_STRIDE;

/** The colour slot tag of a shape's `material` field; 0 = fixed. */
export const tagOfShape = (material: number): number => Math.floor(material / COLOUR_TAG_STRIDE);

interface ShapeBase {
  /** Palette material id, optionally `slotted(material, tag)`; 0 carves (a carve is never tagged). */
  material: number;
  /** PATTERN id; defaults to PLAIN. */
  pattern?: number;
}

export type Shape =
  | (ShapeBase & { kind: 'box'; min: Vec3; size: Vec3 })
  /** Solid cylinder; `base` is the centre of the bottom disc for axis z (the start cap otherwise). */
  | (ShapeBase & { kind: 'cylinder'; base: Vec3; radius: number; length: number; axis: Axis })
  /** Cone or frustum along +z from `base`; `topRadius` defaults to 0. */
  | (ShapeBase & { kind: 'cone'; base: Vec3; radius: number; height: number; topRadius?: number })
  | (ShapeBase & { kind: 'ellipsoid'; center: Vec3; radii: Vec3 })
  /** Stepped gable roof filling the box; the ridge runs along `ridge`, 1:2 slope in 1-voxel steps. */
  | (ShapeBase & { kind: 'gable'; min: Vec3; size: Vec3; ridge: 'x' | 'y' })
  /** Torus-like wheel rim: a ring of `radius` around `axis`, `thickness` radially, `width` along it. */
  | (ShapeBase & { kind: 'ring'; center: Vec3; radius: number; thickness: number; width: number; axis: Axis })
  /** Capsule-free thick line (spokes, arms, chains, struts): all voxels within `radius` of the segment. */
  | (ShapeBase & { kind: 'segment'; from: Vec3; to: Vec3; radius: number });

export interface BlueprintPart {
  /** Unique within the blueprint; drivers are looked up by it. Part 0 must be 'body'. */
  id: string;
  /** Rotation/translation centre of a moving part, model space, on integer voxels. */
  pivot: Vec3;
  shapes: readonly Shape[];
}

/** A point light the dusk/night light pass draws (model space). */
export interface LightSource {
  position: Vec3;
  /** Falloff radius in voxels. */
  radius: number;
  color: number;
  /** Bitmask of LIGHT_PRESET_BIT values the light is on in. */
  presets: number;
}

export const LIGHT_PRESET_DAY = 1;
export const LIGHT_PRESET_DUSK = 2;
export const LIGHT_PRESET_NIGHT = 4;

export interface Blueprint {
  /** Unique per builder and parameters (e.g. 'kiosk:picnic-pocket'); the compile cache key. */
  id: string;
  /** Unrotated catalog footprint in tiles. */
  footprint: readonly [number, number];
  parts: readonly BlueprintPart[];
  lights?: readonly LightSource[];
  /**
   * Voxels below this z are carved away (default PLOT_TOP_Z = 1: a placed object never reaches into
   * the plot slab or paving below it). Models posed by a transform whose origin is not the ground —
   * coaster cars — set it to their own bottom, e.g. 0.
   */
  floorZ?: number;
}

export interface CompiledPart {
  id: string;
  /** Model-space pivot (body: [0, 0, 0]). */
  pivot: Vec3;
  /**
   * BOX layout (contracts/boxes.ts), word = packBoxWord(material, 0, pattern, 0). Field 7 is 0 for a
   * fixed box and the colour slot tag (1..7, `slotted`) for a box a swatch repaints; every consumer
   * overwrites it with the transform slot when it places the box (StaticWorld.pushBoxes, flattenAtRest).
   */
  boxes: Float32Array;
  boxCount: number;
  /** Bounds of the part's boxes in the part's own coordinates. */
  min: Vec3;
  max: Vec3;
  /** Largest distance from the pivot to any box corner (conservative culling of moving parts). */
  sweepRadius: number;
}

export interface CompiledModel {
  blueprintId: string;
  footprint: readonly [number, number];
  parts: readonly CompiledPart[];
  lights: readonly LightSource[];
  /** Highest z of the model at rest (badges and alerts sit above it). */
  top: number;
  /** Total boxes over all parts. */
  boxCount: number;
}
