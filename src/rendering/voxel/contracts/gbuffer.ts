/**
 * G-buffer: what the geometry pass writes and the composite pass reads.
 *
 * The geometry shaders (world boxes, figures, litter, ghost) write UNLIT patterned colour and a few
 * tags; all lighting, outlines, shadows, light pools and grading happen once per texel in the
 * composite. Keeping light out of the geometry shaders means static boxes, rotating ride parts and
 * figures can never disagree about how a face is shaded, and the look can be tuned in one place.
 *
 *   albedo (RGBA8): rgb = unlit, patterned sRGB colour; a = 1 geometry, 0 background (cleared)
 *   gdata  (RGBA8): r = outline group / 255
 *                   g = (face | flags) / 255          face in bits 0–1, flags below
 *                   b = emissive strength 0..1         (lamps, lit windows; exempt from darkening)
 *                   a = lambert term 0..1              max(0, n·L) / (up·L), clamped to 1
 *   depth (depth24plus, sampled with nearest filtering): linear in the depth key (space.ts);
 *                   1.0 = background
 * Low-res row 0 is the top of the image (ndc = pos / size · 2 − 1 for Pixi render targets).
 */

export const FACE_TOP = 0;
export const FACE_X = 1;
export const FACE_Y = 2;
/** A face of a rotated box: no fixed plane gradient, so depth-edge tests use a raw threshold. */
export const FACE_OTHER = 3;

export const GFLAG_EMISSIVE = 4;
export const GFLAG_WATER = 8;
/** Figures share the 8-bit group space with objects; this bit keeps their contours apart. */
export const GFLAG_FIGURE = 16;
export const GFLAG_NO_OUTLINE = 32;
/** Ghost preview and dithered decals: never an occluder for outlines, contours or shadows. */
export const GFLAG_GHOST = 64;
export const GFLAG_SHADOW = 128;

export const OUTLINE_GROUP_GROUND = 0;

/** Terrain, paths and plot slabs are group 0: no contours between neighbouring tiles. */
export const objectOutlineGroup = (objectId: number): number => 1 + (objectId % 255);
/**
 * Phase 24: a prop's outline group. Props are not placed objects (they take no object id), and a forest has many
 * neighbours, so the group is spread (97 is coprime with 255) and neighbouring ids never share one.
 */
export const propOutlineGroup = (propId: number): number => 1 + ((propId * 97 + 131) % 255);
export const figureOutlineGroup = (entityIndex: number): number => 1 + (entityIndex % 255);

/**
 * Key light direction in voxel space (unit length): from the upper left of the screen, so +y faces
 * (screen lower-left) are brighter than +x faces (screen lower-right). Shared by every shader that
 * writes the lambert term and by any CPU code that needs the same shading.
 */
const LIGHT_RAW = [0.32, 0.55, 0.77] as const;
const LIGHT_LENGTH = Math.hypot(LIGHT_RAW[0], LIGHT_RAW[1], LIGHT_RAW[2]);
export const LIGHT_DIRECTION: readonly [number, number, number] = [
  LIGHT_RAW[0] / LIGHT_LENGTH,
  LIGHT_RAW[1] / LIGHT_LENGTH,
  LIGHT_RAW[2] / LIGHT_LENGTH,
];

/** The lambert term written to gdata.a for a unit normal: top faces are exactly 1. */
export const lambertTerm = (nx: number, ny: number, nz: number): number =>
  Math.min(1, Math.max(0, nx * LIGHT_DIRECTION[0] + ny * LIGHT_DIRECTION[1] + nz * LIGHT_DIRECTION[2])
    / LIGHT_DIRECTION[2]);

/**
 * Composite depth-edge rules, in depth-key units (space.ts). A texel c becomes an outline texel
 * when it is background next to geometry, or when a 4-neighbour n is nearer across a real edge —
 * the outline goes on the FAR texel, so thin parts keep their colour and silhouettes grow outward
 * by one texel. "Across a real edge" is TWO-SIDED (compositeLook.ts vxFarAcrossEdge): n's plane
 * continued to c AND c's plane continued to n must both miss by more than the threshold. A one-sided
 * test misreads convex 1-voxel corners (residual 5.25) and speckles every path end and plot corner.
 * A 1-voxel step (a path edge, a curb) is a residual of 3 and stays unoutlined; 2 voxels and more
 * are outlined.
 */
export const SILHOUETTE_MIN_RESIDUAL = 4.5;
/** Rotated faces (FACE_OTHER) have no known gradient; compare raw depth keys instead. */
export const SILHOUETTE_RAW_OTHER = 8;
/**
 * Id contour (outline groups differ at level contact): drawn on the FAR texel, i.e. only where the
 * neighbour is not farther by more than this; at equal depth the texel with the lower group id takes
 * the contour, so it is exactly one texel wide.
 */
export const CONTOUR_NOT_NEARER = 0.5;

/**
 * Bayer 4×4 dither, the only way anything in the voxel renderer is ever partially visible.
 * A texel shows coverage c when c > BAYER_4X4[(y & 3) * 4 + (x & 3)]. The index is ALWAYS anchored
 * to the world (fragment texel + camera texel origin) or to a moving object's snapped origin, never
 * to the screen, so dithered surfaces do not crawl while the camera pans. Per-effect offsets
 * decorrelate stacked dithers.
 */
export const BAYER_4X4: readonly number[] = [
  0, 8, 2, 10,
  12, 4, 14, 6,
  3, 11, 1, 9,
  15, 7, 13, 5,
].map((rank) => (rank + 0.5) / 16);

export const DITHER_OFFSET_GHOST: readonly [number, number] = [0, 0];
export const DITHER_OFFSET_SHADOW: readonly [number, number] = [2, 1];
export const DITHER_OFFSET_LIGHT: readonly [number, number] = [1, 3];
export const DITHER_OFFSET_OVERLAY: readonly [number, number] = [3, 2];
/** The see-through cutaway's screen door (world-anchored, so it never crawls while panning). */
export const DITHER_OFFSET_SEE: readonly [number, number] = [3, 1];
/** Weather (cloud shadow levels, puddle edges, rain tails): decorrelated from the four above. */
export const DITHER_OFFSET_WEATHER: readonly [number, number] = [0, 3];

/** Ghost preview: coverage by validity, and the tint mixed 40% into the ghost's own colours. */
export const GHOST_COVERAGE_VALID = 0.6;
/**
 * Phase 28: a VALID build ghost that carries a chosen colour (colour before placing) is screened denser and
 * tinted lighter, so the choice reads on the ghost: at the plain 40% mix Cherry came out a muddy tan and
 * Emerald or Teal nearly the valid tint itself. Validity still reads (the tint, the coverage, and the invalid
 * ghost unchanged at GHOST_COVERAGE_INVALID and GHOST_TINT_MIX in red). A ghost in its shipped colours keeps
 * GHOST_COVERAGE_VALID and GHOST_TINT_MIX, pixel for pixel. Uniform values only: no shader change.
 */
export const GHOST_COVERAGE_VALID_COLOURED = 0.8;
export const GHOST_TINT_MIX_COLOURED = 0.12;
export const GHOST_COVERAGE_INVALID = 0.35;
export const GHOST_TINT_VALID = 0x69f0c0;
export const GHOST_TINT_INVALID = 0xff6277;
export const GHOST_TINT_BULLDOZE = 0xff5f70;
/**
 * Phase 24: the bulldozer over a map prop it will NOT clear (a permanent prop, or a price the park cannot pay): a cool
 * slate instead of the demolition red, so "this goes" and "this stays" read apart in the world, not only in the cursor
 * readout. Equal to PREVIEW_FILL_BULLDOZE_REFUSED (src/rendering/previewFill.ts), the overlay and classic preview diamond.
 */
export const GHOST_TINT_BULLDOZE_REFUSED = 0x8c97ad;
export const GHOST_TINT_MIX = 0.4;
/** Depth-key bias so a ghost over identical geometry wins deterministically. */
export const GHOST_DEPTH_BIAS = 0.25;
