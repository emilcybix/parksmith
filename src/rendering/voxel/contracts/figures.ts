import type { ViewRotation } from '../../viewRotation';
import { groundOffsetForTexelOffset } from './space';

/**
 * Figures: guests and staff, drawn from small box templates with no per-frame geometry at all.
 *
 * The CPU writes one entity record per visible figure each frame; the vertex shader expands every
 * entity into its model's template boxes. Animation is integer-voxel keyframes (no limb rotation),
 * because rotating 2-voxel limbs by continuous angles at one texel per voxel makes 1,000 guests
 * crawl; whole-voxel offsets keep every frame on the lattice.
 *
 * Entity record, two texels:
 *   texel 0: x, y, z (voxel position of the feet centre, UNSNAPPED — the shader snaps the projected
 *            origin to whole texels and moves depth by 2·Δy so the feet stay on the ground),
 *            heading (0 = model +x faces world +x, 1 = +y, 2 = −x, 3 = −y)
 *   texel 1: frame (0..3 walk cycle, 4 = standing, 5.. the Phase 29 poses), model (FigureModel), paletteWord, flags
 * Entities are packed grouped by model (all guests, then the guests carrying something, then cleaners, then
 * mechanics) and drawn as one range per model; the shadow decal is a second, dithered draw over all entities.
 */

export const FIGURE_TEXELS = 2;
export const FIGURE_FLOATS = FIGURE_TEXELS * 4;
export const FIGURE_TEX_WIDTH = 256;
export const FIGURE_CAPACITY = 2048;

export const FIGURE_MODEL_GUEST = 0;
export const FIGURE_MODEL_CLEANER = 1;
export const FIGURE_MODEL_MECHANIC = 2;
/** Phase 29: a guest under an open umbrella (shown in the rain). */
export const FIGURE_MODEL_GUEST_UMBRELLA = 3;
/** Phase 29: a guest holding a balloon on a string. */
export const FIGURE_MODEL_GUEST_BALLOON = 4;
/** Phase 29: a guest in a wide-brimmed sun hat. */
export const FIGURE_MODEL_GUEST_HAT = 5;
/** Phase 29: a guest hugging a teddy. */
export const FIGURE_MODEL_GUEST_PLUSH = 6;
/** Phase 29: a guest waving a glowing wand (shown at night). */
export const FIGURE_MODEL_GUEST_GLOW = 7;
export const FIGURE_MODEL_COUNT = 8;
export type FigureModel = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Phase 29: every guest model, the plain one first; these share the guest palette word and poses. */
export const GUEST_FIGURE_MODELS: readonly FigureModel[] = [
  FIGURE_MODEL_GUEST,
  FIGURE_MODEL_GUEST_UMBRELLA,
  FIGURE_MODEL_GUEST_BALLOON,
  FIGURE_MODEL_GUEST_HAT,
  FIGURE_MODEL_GUEST_PLUSH,
  FIGURE_MODEL_GUEST_GLOW,
];

export type FigureHeading = 0 | 1 | 2 | 3;

/** Entity flags (texel 1, w). */
export const FIGURE_FLAG_DESATURATE = 1;

/** Walk cycle keyframes 0..3; STANDING has no offsets and no bob. */
export const FIGURE_FRAME_STANDING = 4;
/**
 * Phase 29 poses, each a whole-voxel offset set like the walk (see FIGURE_KEYFRAMES). Animated poses alternate
 * between two frames (A and B) on a timer the packer derives from simulation time.
 */
export const FIGURE_FRAME_SIT = 5;
export const FIGURE_FRAME_HUNCH = 6;
export const FIGURE_FRAME_VOMIT = 7;
export const FIGURE_FRAME_JUMP = 8;
export const FIGURE_FRAME_ARMS_UP = 9;
export const FIGURE_FRAME_FAN_A = 10;
export const FIGURE_FRAME_FAN_B = 11;
export const FIGURE_FRAME_SHIVER_A = 12;
export const FIGURE_FRAME_SHIVER_B = 13;
export const FIGURE_FRAME_POINT = 14;
export const FIGURE_FRAME_CAMERA = 15;
export const FIGURE_FRAME_STOMP_A = 16;
export const FIGURE_FRAME_STOMP_B = 17;
export const FIGURE_FRAME_EAT = 18;
export const FIGURE_FRAME_WAVE_A = 19;
export const FIGURE_FRAME_WAVE_B = 20;
export const FIGURE_FRAME_HOLD = 21;
/** Keyframe columns per role. */
export const FIGURE_FRAME_COUNT = 22;
/** Milliseconds per walk keyframe at normal walking speed. */
export const FIGURE_FRAME_MS = 120;

/**
 * Template box roles. Keyframes move whole roles by integer voxels along the heading (forward)
 * and up; UPPER covers torso, head, hair, cap and anything carried.
 */
export const ROLE_UPPER = 0;
export const ROLE_LEG_LEFT = 1;
export const ROLE_LEG_RIGHT = 2;
export const ROLE_ARM_LEFT = 3;
export const ROLE_ARM_RIGHT = 4;
export const ROLE_COUNT = 5;

/**
 * [forward, up] voxel offset per role (row) and keyframe (column 0..FIGURE_FRAME_COUNT-1, 4 = standing). The Phase 29
 * columns, in order: SIT (torso sunk 2 into the seat and back 1, legs forward 3 down the seat's front edge, hands on
 * the seat), HUNCH (leaning over, hands on knees), VOMIT (bent right over), JUMP (a hop with both arms up), ARMS_UP, FAN A/B
 * (right hand flapping at the face), SHIVER A/B (arms hugged in, a tremble), POINT (right arm out at shoulder height),
 * CAMERA (both hands at the face), STOMP A/B (arms crossed, one foot then the other stamped with a bob), EAT (right hand at the mouth), WAVE A/B
 * (right arm high), HOLD (both hands out in front).
 */
export const FIGURE_KEYFRAMES: readonly (readonly (readonly [number, number])[])[] = [
  /*                walk 0   walk 1  walk 2   walk 3  stand   SIT       HUNCH    VOMIT    JUMP    ARMS_UP FAN_A   FAN_B   SHIV_A  SHIV_B   POINT   CAMERA  STOMP_A STOMP_B EAT     WAVE_A  WAVE_B  HOLD */
  /* UPPER     */ [[0, 0], [0, 1], [0, 0], [0, 1], [0, 0], [-1, -2], [2, -1], [2, -2], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0], [1, 0], [0, 0], [0, 0], [0, 1], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0]],
  /* LEG_LEFT  */ [[2, 0], [0, 0], [-2, 0], [0, 0], [0, 0], [3, 0], [0, 0], [0, 0], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0]],
  /* LEG_RIGHT */ [[-2, 0], [0, 0], [2, 0], [0, 0], [0, 0], [3, 0], [0, 0], [0, 0], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 0], [0, 1], [0, 0], [0, 0], [0, 0], [0, 0]],
  /* ARM_LEFT  */ [[-1, 0], [0, 1], [1, 0], [0, 1], [0, 0], [0, -2], [2, -2], [2, -3], [0, 6], [0, 5], [0, 0], [0, 0], [1, 1], [2, 1], [0, 0], [2, 4], [1, 2], [1, 2], [0, 0], [0, 0], [0, 0], [2, 2]],
  /* ARM_RIGHT */ [[1, 0], [0, 1], [-1, 0], [0, 1], [0, 0], [0, -2], [2, -2], [2, -3], [0, 6], [0, 5], [1, 4], [2, 3], [1, 1], [2, 1], [3, 4], [2, 4], [1, 2], [1, 2], [2, 5], [0, 6], [1, 5], [2, 2]],
];

/** How a template box is coloured: by the entity's palette word, or a fixed material. */
export const PALETTE_ROLE_SHIRT = 0;
export const PALETTE_ROLE_HAIR = 1;
export const PALETTE_ROLE_SKIN = 2;
export const PALETTE_ROLE_FIXED = 3;

/**
 * Template box, two texels (template texture is FIGURE_TEMPLATE_TEX_WIDTH wide):
 *   texel 0: minX, minY, minZ, role              (model space: feet centre at the origin, front +x)
 *   texel 1: sizeX, sizeY, sizeZ, paletteRole + 4 · fixedMaterial
 */
export const FIGURE_TEMPLATE_TEXELS = 2;
export const FIGURE_TEMPLATE_TEX_WIDTH = 64;
/** Tallest a figure may be, hair and bob included (art bible). */
export const FIGURE_MAX_HEIGHT = 20;
/** Phase 29: tallest a guest carrying something may be (a balloon floats well above the head). */
export const FIGURE_PROP_MAX_HEIGHT = 36;

export const packTemplatePaletteWord = (paletteRole: number, fixedMaterial = 0): number =>
  paletteRole + 4 * fixedMaterial;

/** shirt | hair << 8 | skin << 16, each a palette material id. Exact in float32. */
export const packPaletteWord = (shirt: number, hair: number, skin: number): number =>
  shirt + hair * 256 + skin * 65_536;

export const unpackPaletteWord = (word: number): { shirt: number; hair: number; skin: number } => ({
  shirt: word & 255,
  hair: (word >>> 8) & 255,
  skin: (word >>> 16) & 255,
});

/** One draw range per model inside the entity texture. */
export interface FigureRange {
  model: FigureModel;
  firstEntity: number;
  entityCount: number;
}

/** The view transform's linear part (contracts/view.ts) per rotation: c, then s. */
const VIEW_C: readonly number[] = [1, 0, -1, 0];
const VIEW_S: readonly number[] = [0, 1, 0, -1];

/**
 * Queue slot of the i-th guest in a queue, as a WORLD ground-plane voxel offset from the access tile's
 * centre, for the map shown in view `rotation`. The layout is a SCREEN layout (the legacy one: 7 columns,
 * 7 px apart; rows 5 px down) re-expressed inside the ground plane of the view, so the picture matches
 * legacy in every view while depth stays correct: each row lower on screen is also nearer the camera, and a
 * queued guest never sinks into the paving or hides behind the fence in front of the access tile. The view
 * offset is turned back into the world (the inverse of the view's quarter turn), because the figure vertex
 * stage turns the whole world position into the view. View 0 is the legacy value, bit for bit.
 */
export const queueSlotOffset = (index: number, rotation: ViewRotation = 0): { dvx: number; dvy: number } => {
  const column = (index % 7) - 3;
  const row = Math.floor(index / 7);
  const view = groundOffsetForTexelOffset(column * 7, row * 5);
  const c = VIEW_C[rotation];
  const s = VIEW_S[rotation];
  // Inverse of (u, v) = (c*x - s*y, s*x + c*y); `+ 0` keeps exact zeros +0.
  return { dvx: c * view.dvx + s * view.dvy + 0, dvy: -s * view.dvx + c * view.dvy + 0 };
};
