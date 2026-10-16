import { BOX_BUDGET } from '../contracts/budgets';
import {
  FIGURE_MODEL_CLEANER,
  FIGURE_MODEL_GUEST,
  FIGURE_MODEL_GUEST_BALLOON,
  FIGURE_MODEL_GUEST_GLOW,
  FIGURE_MODEL_GUEST_HAT,
  FIGURE_MODEL_GUEST_PLUSH,
  FIGURE_MODEL_GUEST_UMBRELLA,
  FIGURE_MODEL_MECHANIC,
  FIGURE_TEMPLATE_TEX_WIDTH,
  FIGURE_TEMPLATE_TEXELS,
  PALETTE_ROLE_FIXED,
  PALETTE_ROLE_HAIR,
  PALETTE_ROLE_SHIRT,
  PALETTE_ROLE_SKIN,
  packTemplatePaletteWord,
  ROLE_ARM_LEFT,
  ROLE_ARM_RIGHT,
  ROLE_LEG_LEFT,
  ROLE_LEG_RIGHT,
  ROLE_UPPER,
} from '../contracts/figures';
import type { FigureModel } from '../contracts/figures';
import { MAT, MATERIAL_EMPTY, MATERIAL_FLAG_SHADOW } from '../contracts/palette';
import type { Palette } from '../contracts/palette';

/**
 * Box templates for guests and staff (contracts/figures.ts template layout), built once at mount
 * against the art bible (design §12): a guest is legs 2×2×7, a torso 3 deep × 4 wide × 6, arms
 * 1×2×5, a 4×4×4 head and 2 voxels of hair with a 1-voxel back fringe — 19 voxels, 20 with the walk
 * bob. Model space puts the feet centre at the origin, the front on +x, the figure's RIGHT side on +y and z
 * up. The projection is the mirror image of a right-handed world (contracts/space.ts), so a figure
 * facing the camera has its right hand at +y on screen's left, the hand a player expects a tool in;
 * the left/right roles were authored the other way round first, which put staff tools in the
 * on-screen left hand of the figure's right-hand role. Only whole-quarter-turn headings exist, so
 * mirroring y here mirrors every heading. the vertex shader turns a template by the entity's heading in whole quarter turns and moves
 * each box by its role's integer keyframe, so nothing here ever rotates by a fraction.
 *
 * Every corner sits on whole voxels. A 3-deep torso cannot be centred on the 2-deep legs without
 * half voxels, and half-voxel corners project onto texel centres, where the rasteriser has to break
 * ties; the torso is pushed forward instead, so its extra voxel reads as the chest and marks the
 * front together with the face, the brim and the tool.
 *
 * Budget: BOX_BUDGET.figure (8) boxes per model, because a park draws a thousand of these every
 * frame. The guest spends exactly its 8 on the art bible's parts, so there are no separate hands or
 * shoes. Staff trade the guest's hair and fringe for a cap (crown and visor in one box) and a tool.
 */

export type FigurePart = 'leg' | 'torso' | 'arm' | 'head' | 'hair' | 'fringe' | 'cap' | 'tool' | 'shadow' | 'prop';

/** One authored template box, in model voxels (see the file comment for the axes). */
export interface FigureTemplateBox {
  /** What the box is, for tests and tools; the GPU never sees it. */
  readonly part: FigurePart;
  readonly minX: number;
  readonly minY: number;
  readonly minZ: number;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  /** ROLE_*: which keyframe row moves the box. */
  readonly role: number;
  /** PALETTE_ROLE_*: coloured by the entity's palette word, or by `material`. */
  readonly paletteRole: number;
  /** Fixed material id for PALETTE_ROLE_FIXED; MATERIAL_EMPTY otherwise. */
  readonly material: number;
}

export interface FigureTemplateRange {
  model: FigureModel;
  firstBox: number;
  boxCount: number;
}

export interface FigureTemplates {
  /** FIGURE_TEMPLATE_TEXELS per box, FIGURE_TEMPLATE_TEX_WIDTH wide, whole rows (zero padded). */
  data: Float32Array;
  boxCount: number;
  /** One range per model, indexed by FigureModel (models[m].model === m), contiguous and in order. */
  models: readonly FigureTemplateRange[];
  /** The flat shadow decal drawn (dithered) under every entity. */
  shadow: { firstBox: number; boxCount: number };
}

/** Top of the legs, the torso, the head and the hair or cap (voxels above the feet). */
const LEG_TOP = 7;
const TORSO_TOP = LEG_TOP + 6;
const HEAD_TOP = TORSO_TOP + 4;
const HAIR_TOP = HEAD_TOP + 2;

/** The decal is this thin: it only has to win the depth test against the paving it lies on. */
export const FIGURE_SHADOW_HEIGHT = 0.25;

const box = (
  part: FigurePart,
  role: number,
  paletteRole: number,
  material: number,
  minX: number,
  minY: number,
  minZ: number,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
): FigureTemplateBox => ({ part, minX, minY, minZ, sizeX, sizeY, sizeZ, role, paletteRole, material });

const fixed = (
  part: FigurePart,
  role: number,
  material: number,
  minX: number,
  minY: number,
  minZ: number,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
): FigureTemplateBox => box(part, role, PALETTE_ROLE_FIXED, material, minX, minY, minZ, sizeX, sizeY, sizeZ);

const coloured = (
  part: FigurePart,
  role: number,
  paletteRole: number,
  minX: number,
  minY: number,
  minZ: number,
  sizeX: number,
  sizeY: number,
  sizeZ: number,
): FigureTemplateBox => box(part, role, paletteRole, MATERIAL_EMPTY, minX, minY, minZ, sizeX, sizeY, sizeZ);

/**
 * Legs side by side under the torso, 2 deep and 2 wide each: together exactly as wide as the torso,
 * so the hips never stick out past it. A stride moves them ±2 voxels along the heading.
 */
const legs = (pants: number): FigureTemplateBox[] => [
  fixed('leg', ROLE_LEG_LEFT, pants, -1, -2, 0, 2, 2, LEG_TOP),
  fixed('leg', ROLE_LEG_RIGHT, pants, -1, 0, 0, 2, 2, LEG_TOP),
];

/**
 * Torso and arms. The arms hang from the shoulder line (their tops meet the torso's) over the leg
 * line, 1 voxel thin beside the 4-wide torso, so they swing ±1 past it without ever cutting into it.
 */
const body = (paletteRole: number, material: number): FigureTemplateBox[] => [
  box('torso', ROLE_UPPER, paletteRole, material, -1, -2, LEG_TOP, 3, 4, TORSO_TOP - LEG_TOP),
  box('arm', ROLE_ARM_LEFT, paletteRole, material, -1, -3, TORSO_TOP - 5, 2, 1, 5),
  box('arm', ROLE_ARM_RIGHT, paletteRole, material, -1, 2, TORSO_TOP - 5, 2, 1, 5),
];

const head = (): FigureTemplateBox => coloured('head', ROLE_UPPER, PALETTE_ROLE_SKIN, -2, -2, TORSO_TOP, 4, 4, HEAD_TOP - TORSO_TOP);

/**
 * Hair: a 2-voxel cap over the head plus a fringe hanging 1 voxel behind it, down to mid-head. The
 * fringe is what a figure walking away from the camera shows instead of a second face.
 */
const hair = (): FigureTemplateBox[] => [
  coloured('hair', ROLE_UPPER, PALETTE_ROLE_HAIR, -2, -2, HEAD_TOP, 4, 4, HAIR_TOP - HEAD_TOP),
  coloured('fringe', ROLE_UPPER, PALETTE_ROLE_HAIR, -3, -2, HEAD_TOP - 2, 1, 4, 4),
];

/**
 * Staff cap: one flat voxel over the head that runs on 2 voxels past the face as the visor (a
 * 2-voxel-thick box read as a white block, not a cap). A white visor is the one silhouette no guest
 * has — the uniform colours alone are too close to two of the guest shirt colours to tell staff
 * apart.
 */
const cap = (): FigureTemplateBox => fixed('cap', ROLE_UPPER, MAT.CAP, -2, -2, HEAD_TOP, 6, 4, 1);

/**
 * Broom: a long handle held upright in front of the right hand, from the ground to head height.
 * It rides with the right arm, so it swings with the walk and lifts on the bob.
 */
const broom = (): FigureTemplateBox => fixed('tool', ROLE_ARM_RIGHT, MAT.TIMBER, 1, 2, 0, 1, 1, HEAD_TOP - 2);

/**
 * Wrench: a short bar in the right hand, pointing forward past the chest so it shows; light steel,
 * because dark steel disappeared against the trousers.
 */
const wrench = (): FigureTemplateBox => fixed('tool', ROLE_ARM_RIGHT, MAT.STEEL_LIGHT, 1, 2, TORSO_TOP - 5, 3, 1, 2);

const GUEST_BOXES: readonly FigureTemplateBox[] = [
  ...legs(MAT.PANTS),
  ...body(PALETTE_ROLE_SHIRT, MATERIAL_EMPTY),
  head(),
  ...hair(),
];

const CLEANER_BOXES: readonly FigureTemplateBox[] = [
  ...legs(MAT.PANTS_DARK),
  ...body(PALETTE_ROLE_FIXED, MAT.CLEANER_UNIFORM),
  head(),
  cap(),
  broom(),
];

const MECHANIC_BOXES: readonly FigureTemplateBox[] = [
  ...legs(MAT.PANTS_DARK),
  ...body(PALETTE_ROLE_FIXED, MAT.MECHANIC_UNIFORM),
  head(),
  cap(),
  wrench(),
];

/**
 * Phase 29 umbrella: a dark pole in the right hand up past the hair, under a 10 x 10 canopy in the shirt colour. Both ride
 * with the right arm, so the canopy sways a voxel with the walk.
 */
const UMBRELLA_BOXES: readonly FigureTemplateBox[] = [
  ...GUEST_BOXES,
  fixed('prop', ROLE_ARM_RIGHT, MAT.INK, 1, 2, TORSO_TOP - 4, 1, 1, HAIR_TOP + 3 - (TORSO_TOP - 4)),
  coloured('prop', ROLE_ARM_RIGHT, PALETTE_ROLE_SHIRT, -5, -3, HAIR_TOP + 3, 10, 10, 2),
];

/** Phase 29 balloon: a white string from the right hand to a round-ish balloon in the shirt colour, high overhead. */
const BALLOON_BOXES: readonly FigureTemplateBox[] = [
  ...GUEST_BOXES,
  fixed('prop', ROLE_ARM_RIGHT, MAT.WHITE, 0, 3, TORSO_TOP - 5, 1, 1, 24 - (TORSO_TOP - 5)),
  coloured('prop', ROLE_ARM_RIGHT, PALETTE_ROLE_SHIRT, -2, 1, 24, 5, 5, 6),
];

/**
 * Phase 29 sun hat: the hair and fringe give way to a straw brim jutting out front and back and a crown in the hair slot
 * (the packer puts the guest's accent colour there), so the hat keeps the guest's own colours. The brim is no wider than
 * the head, so raised arms (cheering, waving) pass beside it instead of through it.
 */
const HAT_BOXES: readonly FigureTemplateBox[] = [
  ...legs(MAT.PANTS),
  ...body(PALETTE_ROLE_SHIRT, MATERIAL_EMPTY),
  head(),
  fixed('hair', ROLE_UPPER, MAT.HAIR_BLOND, -4, -2, HEAD_TOP, 8, 4, 1),
  coloured('hair', ROLE_UPPER, PALETTE_ROLE_HAIR, -2, -2, HEAD_TOP + 1, 4, 4, 2),
];

/** Phase 29 plush: a brown teddy hugged against the chest, body and head, riding with the torso. */
const PLUSH_BOXES: readonly FigureTemplateBox[] = [
  ...GUEST_BOXES,
  fixed('prop', ROLE_UPPER, MAT.HAIR_BROWN, 2, -1, LEG_TOP + 2, 2, 3, 3),
  fixed('prop', ROLE_UPPER, MAT.HAIR_BROWN, 2, -1, LEG_TOP + 5, 2, 3, 2),
];

/** Phase 29 glow wand: a white stick in the right hand with a glowing (emissive) tip. */
const GLOW_BOXES: readonly FigureTemplateBox[] = [
  ...GUEST_BOXES,
  fixed('prop', ROLE_ARM_RIGHT, MAT.WHITE, 1, 2, TORSO_TOP - 5, 1, 1, 5),
  fixed('prop', ROLE_ARM_RIGHT, MAT.LAMP_GLOW, 1, 2, TORSO_TOP, 2, 1, 2),
];

/** Authored boxes per model, indexed by FigureModel. */
export const FIGURE_MODEL_BOXES: readonly (readonly FigureTemplateBox[])[] = [
  GUEST_BOXES,
  CLEANER_BOXES,
  MECHANIC_BOXES,
  UMBRELLA_BOXES,
  BALLOON_BOXES,
  HAT_BOXES,
  PLUSH_BOXES,
  GLOW_BOXES,
];

/**
 * The shadow decal: a flat SHADOW box a little larger than a full stride (the legs reach ±3 along
 * the heading), so every frame of the walk stands inside it. The dithered decal draw applies no
 * keyframes, so its role is only a fallback for a draw that did: LEG_LEFT would slide it along the
 * ground with a stride, where UPPER would lift it into the feet with the body's bob.
 */
export const FIGURE_SHADOW_BOX: FigureTemplateBox = fixed(
  'shadow',
  ROLE_LEG_LEFT,
  MAT.SHADOW,
  -3,
  -3,
  0,
  6,
  6,
  FIGURE_SHADOW_HEIGHT,
);

const FIGURE_MODELS: readonly FigureModel[] = [
  FIGURE_MODEL_GUEST,
  FIGURE_MODEL_CLEANER,
  FIGURE_MODEL_MECHANIC,
  FIGURE_MODEL_GUEST_UMBRELLA,
  FIGURE_MODEL_GUEST_BALLOON,
  FIGURE_MODEL_GUEST_HAT,
  FIGURE_MODEL_GUEST_PLUSH,
  FIGURE_MODEL_GUEST_GLOW,
];

/** Phase 29: the guests carrying something may spend a few more boxes on it. */
const budgetOf = (model: FigureModel): number => (
  model === FIGURE_MODEL_GUEST || model === FIGURE_MODEL_CLEANER || model === FIGURE_MODEL_MECHANIC ? BOX_BUDGET.figure : BOX_BUDGET.figureWithProp
);

/**
 * The templates hard-code MAT ids and rely on the SHADOW material's flags; a palette that disagrees
 * (a stale or hand-made one) would draw figures in the wrong colours or an opaque black decal, so
 * it is rejected here, once, at mount.
 */
const assertPaletteFits = (palette: Palette, boxes: readonly FigureTemplateBox[]): void => {
  for (const templateBox of boxes) {
    if (templateBox.paletteRole !== PALETTE_ROLE_FIXED) continue;
    if (!(templateBox.material > MATERIAL_EMPTY && templateBox.material < palette.count)) {
      throw new Error(`Figure ${templateBox.part} uses material ${templateBox.material}, which the palette `
        + `(${palette.count} materials) does not have.`);
    }
  }
  if ((palette.flags(MAT.SHADOW) & MATERIAL_FLAG_SHADOW) === 0) {
    throw new Error('The palette\'s MAT.SHADOW is not flagged MATERIAL_FLAG_SHADOW, so figure shadows would draw as solid boxes.');
  }
};

const writeTemplateBox = (data: Float32Array, index: number, templateBox: FigureTemplateBox): void => {
  const at = index * FIGURE_TEMPLATE_TEXELS * 4;
  data[at] = templateBox.minX;
  data[at + 1] = templateBox.minY;
  data[at + 2] = templateBox.minZ;
  data[at + 3] = templateBox.role;
  data[at + 4] = templateBox.sizeX;
  data[at + 5] = templateBox.sizeY;
  data[at + 6] = templateBox.sizeZ;
  data[at + 7] = packTemplatePaletteWord(
    templateBox.paletteRole,
    templateBox.paletteRole === PALETTE_ROLE_FIXED ? templateBox.material : 0,
  );
};

/**
 * Packs every model's boxes, in FigureModel order, then the shadow decal, into one small texture's
 * data. Throws when the palette does not fit the templates or a model exceeds BOX_BUDGET.figure.
 */
export const buildFigureTemplates = (palette: Palette): FigureTemplates => {
  const allBoxes: FigureTemplateBox[] = [];
  const models: FigureTemplateRange[] = [];
  for (const model of FIGURE_MODELS) {
    const boxes = FIGURE_MODEL_BOXES[model];
    if (boxes.length > budgetOf(model)) {
      throw new Error(`Figure model ${model} has ${boxes.length} boxes; the budget is ${budgetOf(model)}.`);
    }
    models.push({ model, firstBox: allBoxes.length, boxCount: boxes.length });
    allBoxes.push(...boxes);
  }
  const shadow = { firstBox: allBoxes.length, boxCount: 1 };
  allBoxes.push(FIGURE_SHADOW_BOX);
  assertPaletteFits(palette, allBoxes);

  const rows = Math.ceil((allBoxes.length * FIGURE_TEMPLATE_TEXELS) / FIGURE_TEMPLATE_TEX_WIDTH);
  const data = new Float32Array(rows * FIGURE_TEMPLATE_TEX_WIDTH * 4);
  allBoxes.forEach((templateBox, index) => writeTemplateBox(data, index, templateBox));
  return { data, boxCount: allBoxes.length, models, shadow };
};
