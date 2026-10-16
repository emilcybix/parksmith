/**
 * Materials are palette slots, never textures.
 *
 * A material id (0..255) indexes a 256×4 RGBA8 palette texture:
 *   row 0: base colour (sRGB, as authored)
 *   row 1: r = MaterialFlag bits, g = emissive strength · 255, b = pattern amplitude · 255, a = 0
 *   row 2: secondary colour (mortar, stripes, strata, the second grass shade …)
 *   row 3: reserved (0)
 * Material 0 is "empty": in a blueprint it carves voxels away; it is never drawn.
 *
 * The palette is built once, eagerly and deterministically (fixed materials in id order, then
 * every catalog colour and accent, then guest colours), so material ids never depend on which
 * model happened to compile first. Content looks colours up; it never registers them.
 * Colour maths everywhere happens on these sRGB-encoded values.
 */

export const MATERIAL_EMPTY = 0;

/** Row 1, red channel. */
export const MATERIAL_FLAG_EMISSIVE = 1;
/** Glows only in the dusk and night presets (windows, glass). */
export const MATERIAL_FLAG_GLASS = 2;
export const MATERIAL_FLAG_WATER = 4;
export const MATERIAL_FLAG_NO_OUTLINE = 8;
export const MATERIAL_FLAG_SHADOW = 16;

/**
 * Fixed materials with stable ids. Base colours come from the legacy art (WorldRenderer.ts,
 * rideArt.ts) so the voxel park and the HUD swatches agree; the implementation (palette.ts) adds
 * secondary colours, flags and pattern amplitudes.
 */
export const MAT = {
  GRASS: 1,
  SOIL: 2,
  SOIL_DARK: 3,
  PAVING: 4,
  CURB: 5,
  WOOD: 6,
  TIMBER: 7,
  STEEL: 8,
  STEEL_LIGHT: 9,
  CONCRETE: 10,
  STONE: 11,
  WATER: 12,
  GLASS: 13,
  WINDOW_GLOW: 14,
  LAMP_GLOW: 15,
  INK: 16,
  WHITE: 17,
  CANVAS: 18,
  FENCE_RAIL: 19,
  FENCE_POST: 20,
  TRACK: 21,
  RAIL: 22,
  SUPPORT: 23,
  TRAIN: 24,
  SHADOW: 25,
  SKIN_1: 26,
  SKIN_2: 27,
  SKIN_3: 28,
  SKIN_4: 29,
  PANTS: 30,
  PANTS_DARK: 31,
  CLEANER_UNIFORM: 32,
  MECHANIC_UNIFORM: 33,
  CAP: 34,
  FOLIAGE: 35,
  FOLIAGE_DARK: 36,
  FLOWER_PINK: 37,
  ENTRANCE_POST: 38,
  SIGN: 39,
  ARCH_PINK: 40,
  LITTER_CUP: 41,
  LITTER_WRAPPER: 42,
  HAIR_DARK: 43,
  HAIR_BROWN: 44,
  HAIR_BLOND: 45,
  BULB: 46,
} as const;

export type FixedMaterialName = keyof typeof MAT;

/** Base colour of each fixed material (sRGB). */
export const MAT_COLOR: Readonly<Record<FixedMaterialName, number>> = {
  GRASS: 0x92d47f,
  SOIL: 0x8a6a4a,
  SOIL_DARK: 0x6e523a,
  PAVING: 0xf1d49a,
  CURB: 0xd8b878,
  WOOD: 0x9a6b44,
  TIMBER: 0x79543a,
  STEEL: 0x2c5b64,
  STEEL_LIGHT: 0x4d7f86,
  CONCRETE: 0x9fb2ae,
  STONE: 0xb9b2a4,
  WATER: 0x2b6f8e,
  GLASS: 0x9fd8e8,
  WINDOW_GLOW: 0xffd28a,
  LAMP_GLOW: 0xffe66d,
  INK: 0x173f3b,
  WHITE: 0xfff8ec,
  CANVAS: 0xfff0c8,
  FENCE_RAIL: 0xd8e6e4,
  FENCE_POST: 0x3f6f6a,
  TRACK: 0x8c3b22,
  RAIL: 0xffd166,
  SUPPORT: 0x6d4c33,
  TRAIN: 0x2b2d42,
  SHADOW: 0x1f4a44,
  SKIN_1: 0xffd3a6,
  SKIN_2: 0xe8b48a,
  SKIN_3: 0xc68a5e,
  SKIN_4: 0x8d5a3c,
  PANTS: 0x3b4a6b,
  PANTS_DARK: 0x2d3446,
  CLEANER_UNIFORM: 0x52cfa4,
  MECHANIC_UNIFORM: 0xf4b94e,
  CAP: 0xfff8ec,
  FOLIAGE: 0x48a96b,
  FOLIAGE_DARK: 0x2f855a,
  FLOWER_PINK: 0xff7ca3,
  ENTRANCE_POST: 0x254f4a,
  SIGN: 0xffd166,
  ARCH_PINK: 0xff6f91,
  LITTER_CUP: 0xff6f91,
  LITTER_WRAPPER: 0xffd166,
  HAIR_DARK: 0x3a2a22,
  HAIR_BROWN: 0x7a4b2a,
  HAIR_BLOND: 0xe0b060,
  BULB: 0xfff4c9,
};

/** Skin tones figures cycle through by entity id. */
export const SKIN_MATERIALS: readonly number[] = [MAT.SKIN_1, MAT.SKIN_2, MAT.SKIN_3, MAT.SKIN_4];

/**
 * World-anchored surface patterns, stored per box (box word bits 16–20), not per material, so any
 * colour can take any pattern. Static boxes pattern in world voxels; rigid parts and figures in
 * part-local voxels, so patterns stick to what moves. Directional patterns (planks, roof rows,
 * stripes, paving bond) follow the box word's quarter turn by swapping AND mirroring model x
 * (model x = W − 1 − world y), which matches space.ts's (x, y) → (y, W − x) exactly, so a window
 * framed at q0 stays framed at q1.
 *
 * Top faces sample only every other voxel along the x = y diagonal at one texel per voxel step, so
 * top-face patterns address cells with floor(pos + (0.5, 0, −0.5)) (one texel pair → one voxel
 * each) — except pure bands and tiles (STRIPES, ROOF, GRASS's checker and grid line), which use the
 * voxel under the sample, floor(pos − 0.5·n), so their edges stay straight. Pattern features must
 * be at least 2 voxels wide with periods of 4 or more. Mesh lines (window frames, seams) belong on
 * walls, not exactly on a top face's x edge.
 */
export const PATTERN = {
  PLAIN: 0,
  SPECKLE: 1,
  GRASS: 2,
  PAVING: 3,
  COBBLE: 4,
  PLANKS: 5,
  ROOF: 6,
  STRIPES: 7,
  FOLIAGE: 8,
  WATER: 9,
  WINDOW: 10,
  SOIL: 11,
  METAL: 12,
  FABRIC: 13,
  BRICK: 14,
} as const;

export type PatternName = keyof typeof PATTERN;

export interface Palette {
  /**
   * Material id of a registered colour (catalog colour/accent, guest colour, or an UNFLAGGED fixed
   * base). Always a plain, unflagged material: emissive, glass, water and shadow materials are only
   * reachable as MAT.* ids (material(MAT_COLOR.LAMP_GLOW) returns the lamp's plain accent, not the
   * glowing bulb). Throws for unknown colours.
   */
  material(rgb: number): number;
  /** Plot slab tint for a catalog colour: the legacy plot (23% of the colour over grass). */
  plotTint(rgb: number): number;
  /** Number of materials in use, material 0 included. */
  readonly count: number;
  baseColor(material: number): number;
  secondaryColor(material: number): number;
  flags(material: number): number;
  /** 256 × 4 RGBA8, rows as documented above. */
  textureData(): Uint8Array;
}

export const PALETTE_TEX_WIDTH = 256;
export const PALETTE_TEX_ROWS = 4;
