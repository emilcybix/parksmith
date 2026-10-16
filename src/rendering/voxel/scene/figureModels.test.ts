import { describe, expect, it } from 'vitest';
import { BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { BOX_BUDGET } from '../contracts/budgets';
import {
  FIGURE_FRAME_STANDING,
  FIGURE_FRAME_COUNT,
  FIGURE_KEYFRAMES,
  FIGURE_MAX_HEIGHT,
  FIGURE_MODEL_GUEST_BALLOON,
  FIGURE_MODEL_GUEST_GLOW,
  FIGURE_MODEL_GUEST_HAT,
  FIGURE_MODEL_GUEST_PLUSH,
  FIGURE_MODEL_GUEST_UMBRELLA,
  FIGURE_PROP_MAX_HEIGHT,
  FIGURE_MODEL_CLEANER,
  FIGURE_MODEL_COUNT,
  FIGURE_MODEL_GUEST,
  FIGURE_MODEL_MECHANIC,
  FIGURE_TEMPLATE_TEX_WIDTH,
  FIGURE_TEMPLATE_TEXELS,
  PALETTE_ROLE_FIXED,
  PALETTE_ROLE_HAIR,
  PALETTE_ROLE_SHIRT,
  PALETTE_ROLE_SKIN,
  ROLE_ARM_LEFT,
  ROLE_ARM_RIGHT,
  ROLE_COUNT,
  ROLE_LEG_LEFT,
  ROLE_LEG_RIGHT,
  ROLE_UPPER,
} from '../contracts/figures';
import type { FigureModel } from '../contracts/figures';
import { MAT, MATERIAL_EMPTY, MATERIAL_FLAG_SHADOW } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { buildPalette } from '../palette';
import { buildFigureTemplates, FIGURE_MODEL_BOXES, FIGURE_SHADOW_BOX, FIGURE_SHADOW_HEIGHT } from './figureModels';
import type { FigurePart, FigureTemplateBox } from './figureModels';

/**
 * A thousand guests are drawn from these few boxes every frame, so the templates are held to the
 * art bible (design §12) and to the rules the figure shader relies on: the box budget, the height
 * with the walk bob, whole-voxel corners, no two boxes of a figure overlapping in any keyframe
 * (overlaps are coplanar faces, which z-fight), the front on +x, the feet centre at the origin,
 * and the texture layout the vertex shader decodes (contracts/figures.ts).
 */

const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const MODELS: readonly FigureModel[] = [
  FIGURE_MODEL_GUEST, FIGURE_MODEL_CLEANER, FIGURE_MODEL_MECHANIC,
  FIGURE_MODEL_GUEST_UMBRELLA, FIGURE_MODEL_GUEST_BALLOON, FIGURE_MODEL_GUEST_HAT, FIGURE_MODEL_GUEST_PLUSH, FIGURE_MODEL_GUEST_GLOW,
];
const MODEL_NAMES = ['guest', 'cleaner', 'mechanic', 'umbrella guest', 'balloon guest', 'hat guest', 'plush guest', 'glow guest'];
/** Phase 29: the guests carrying a souvenir may spend two more boxes and stand taller (a balloon floats overhead). */
const CARRIES = (model: FigureModel): boolean => model >= FIGURE_MODEL_GUEST_UMBRELLA;
const budgetOf = (model: FigureModel): number => (CARRIES(model) && model !== FIGURE_MODEL_GUEST_HAT ? BOX_BUDGET.figureWithProp : BOX_BUDGET.figure);
const heightOf = (model: FigureModel): number => (CARRIES(model) ? FIGURE_PROP_MAX_HEIGHT : FIGURE_MAX_HEIGHT);
/** Every keyframe column: the walk, standing and (Phase 29) every pose. */
const FRAMES = Array.from({ length: FIGURE_FRAME_COUNT }, (_unused, frame) => frame);
/** The walk and standing: all staff ever show (the poses are the guests'), and what the shadow decal covers. */
const WALK_FRAMES = [0, 1, 2, 3, FIGURE_FRAME_STANDING];
const framesOf = (model: FigureModel): readonly number[] => (model === FIGURE_MODEL_CLEANER || model === FIGURE_MODEL_MECHANIC ? WALK_FRAMES : FRAMES);

interface PlacedBox {
  part: FigurePart;
  role: number;
  min: [number, number, number];
  max: [number, number, number];
}

/** A template box moved by its role's keyframe (forward along +x, then up), as the shader does. */
const posed = (box: FigureTemplateBox, frame: number): PlacedBox => {
  const [forward, up] = FIGURE_KEYFRAMES[box.role][frame];
  return {
    part: box.part,
    role: box.role,
    min: [box.minX + forward, box.minY, box.minZ + up],
    max: [box.minX + forward + box.sizeX, box.minY + box.sizeY, box.minZ + up + box.sizeZ],
  };
};

const overlapVolume = (a: PlacedBox, b: PlacedBox): number => {
  let volume = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    volume *= Math.max(0, Math.min(a.max[axis], b.max[axis]) - Math.max(a.min[axis], b.min[axis]));
  }
  return volume;
};

const partsOf = (model: FigureModel, part: FigurePart): FigureTemplateBox[] =>
  FIGURE_MODEL_BOXES[model].filter((box) => box.part === part);

const onlyPart = (model: FigureModel, part: FigurePart): FigureTemplateBox => {
  const boxes = partsOf(model, part);
  expect(boxes, `${MODEL_NAMES[model]} should have exactly one ${part}`).toHaveLength(1);
  return boxes[0];
};

const paletteWith = (overrides: Partial<Palette>): Palette => ({
  material: (rgb) => palette.material(rgb),
  plotTint: (rgb) => palette.plotTint(rgb),
  count: palette.count,
  baseColor: (material) => palette.baseColor(material),
  secondaryColor: (material) => palette.secondaryColor(material),
  flags: (material) => palette.flags(material),
  textureData: () => palette.textureData(),
  ...overrides,
});

describe('figure templates', () => {
  it('keeps every model within the box budget, contiguous and in FigureModel order', () => {
    const templates = buildFigureTemplates(palette);
    expect(templates.models).toHaveLength(FIGURE_MODEL_COUNT);
    let next = 0;
    for (const model of MODELS) {
      const range = templates.models[model];
      expect(range.model, 'models are indexed by FigureModel').toBe(model);
      expect(range.firstBox, `${MODEL_NAMES[model]} starts right after the previous model`).toBe(next);
      expect(range.boxCount, `${MODEL_NAMES[model]} box count`).toBe(FIGURE_MODEL_BOXES[model].length);
      expect(range.boxCount, `${MODEL_NAMES[model]} is over its budget`).toBeLessThanOrEqual(budgetOf(model));
      next += range.boxCount;
    }
    expect(templates.shadow).toEqual({ firstBox: next, boxCount: 1 });
    expect(templates.boxCount).toBe(next + 1);
  });

  it('packs the template texture in the contract layout the shader decodes', () => {
    const templates = buildFigureTemplates(palette);
    const rowFloats = FIGURE_TEMPLATE_TEX_WIDTH * 4;
    expect(templates.data.length % rowFloats, 'whole texture rows').toBe(0);
    expect(templates.data.length).toBe(Math.ceil((templates.boxCount * FIGURE_TEMPLATE_TEXELS) / FIGURE_TEMPLATE_TEX_WIDTH) * rowFloats);
    const authored = [...MODELS.flatMap((model) => FIGURE_MODEL_BOXES[model]), FIGURE_SHADOW_BOX];
    authored.forEach((box, index) => {
      const at = index * FIGURE_TEMPLATE_TEXELS * 4;
      const texels = Array.from(templates.data.subarray(at, at + 8));
      // Texel 1 w is paletteRole + 4 · fixedMaterial; the shader reads it as (code & 3, code >> 2).
      const code = texels[7];
      expect(texels.slice(0, 7), `box ${index} (${box.part})`).toEqual([
        box.minX, box.minY, box.minZ, box.role, box.sizeX, box.sizeY, box.sizeZ,
      ]);
      expect(code & 3, `box ${index} palette role`).toBe(box.paletteRole);
      expect(code >> 2, `box ${index} material`).toBe(box.paletteRole === PALETTE_ROLE_FIXED ? box.material : 0);
    });
    const used = authored.length * FIGURE_TEMPLATE_TEXELS * 4;
    expect(templates.data.subarray(used).every((value) => value === 0), 'padding stays zero').toBe(true);
  });

  it('matches the art bible guest and stays within FIGURE_MAX_HEIGHT in every keyframe', () => {
    const guestTop = Math.max(...FIGURE_MODEL_BOXES[FIGURE_MODEL_GUEST].map((box) => box.minZ + box.sizeZ));
    expect(guestTop, 'legs 7 + torso 6 + head 4 + hair 2').toBe(19);
    const size = (box: FigureTemplateBox): number[] => [box.sizeX, box.sizeY, box.sizeZ];
    expect(partsOf(FIGURE_MODEL_GUEST, 'leg').map(size)).toEqual([[2, 2, 7], [2, 2, 7]]);
    expect(size(onlyPart(FIGURE_MODEL_GUEST, 'torso')), 'torso 3 deep × 4 wide × 6').toEqual([3, 4, 6]);
    expect(partsOf(FIGURE_MODEL_GUEST, 'arm').map(size)).toEqual([[2, 1, 5], [2, 1, 5]]);
    expect(size(onlyPart(FIGURE_MODEL_GUEST, 'head'))).toEqual([4, 4, 4]);
    expect(onlyPart(FIGURE_MODEL_GUEST, 'hair').sizeZ, 'hair is 2 voxels').toBe(2);
    expect(onlyPart(FIGURE_MODEL_GUEST, 'fringe').sizeX, 'the fringe is 1 voxel thick').toBe(1);
    for (const model of MODELS) {
      for (const frame of framesOf(model)) {
        const boxes = FIGURE_MODEL_BOXES[model].map((box) => posed(box, frame));
        const top = Math.max(...boxes.map((box) => box.max[2]));
        const bottom = Math.min(...boxes.map((box) => box.min[2]));
        expect(top, `${MODEL_NAMES[model]} frame ${frame} height`).toBeLessThanOrEqual(heightOf(model));
        expect(bottom, `${MODEL_NAMES[model]} frame ${frame} sinks below the paving`).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('gives every box a valid role and colour source, with body parts on the right roles', () => {
    for (const model of MODELS) {
      for (const box of [...FIGURE_MODEL_BOXES[model], FIGURE_SHADOW_BOX]) {
        const what = `${MODEL_NAMES[model]} ${box.part}`;
        expect(Number.isInteger(box.role) && box.role >= 0 && box.role < ROLE_COUNT, `${what} role`).toBe(true);
        expect([PALETTE_ROLE_SHIRT, PALETTE_ROLE_HAIR, PALETTE_ROLE_SKIN, PALETTE_ROLE_FIXED], `${what} palette role`)
          .toContain(box.paletteRole);
        if (box.paletteRole === PALETTE_ROLE_FIXED) {
          expect(box.material, `${what} material`).toBeGreaterThan(MATERIAL_EMPTY);
          expect(box.material, `${what} material`).toBeLessThan(palette.count);
          const shadowFlag = (palette.flags(box.material) & MATERIAL_FLAG_SHADOW) !== 0;
          expect(shadowFlag, `${what}: only the decal uses a shadow material`).toBe(box.part === 'shadow');
        } else {
          expect(box.material, `${what} takes its colour from the palette word`).toBe(MATERIAL_EMPTY);
        }
      }
      const rolesOf = (part: FigurePart): number[] => partsOf(model, part).map((box) => box.role).sort();
      expect(rolesOf('leg')).toEqual([ROLE_LEG_LEFT, ROLE_LEG_RIGHT]);
      expect(rolesOf('arm')).toEqual([ROLE_ARM_LEFT, ROLE_ARM_RIGHT]);
      for (const part of ['torso', 'head', 'hair', 'fringe', 'cap'] as const) {
        for (const box of partsOf(model, part)) expect(box.role, `${MODEL_NAMES[model]} ${part} moves with the body`).toBe(ROLE_UPPER);
      }
    }
    expect(onlyPart(FIGURE_MODEL_GUEST, 'torso').paletteRole, 'shirt colour').toBe(PALETTE_ROLE_SHIRT);
    expect(partsOf(FIGURE_MODEL_GUEST, 'arm').map((box) => box.paletteRole)).toEqual([PALETTE_ROLE_SHIRT, PALETTE_ROLE_SHIRT]);
    expect(onlyPart(FIGURE_MODEL_GUEST, 'head').paletteRole).toBe(PALETTE_ROLE_SKIN);
    expect(onlyPart(FIGURE_MODEL_GUEST, 'hair').paletteRole).toBe(PALETTE_ROLE_HAIR);
    expect(onlyPart(FIGURE_MODEL_GUEST, 'fringe').paletteRole).toBe(PALETTE_ROLE_HAIR);
    expect(partsOf(FIGURE_MODEL_GUEST, 'leg').map((box) => box.material)).toEqual([MAT.PANTS, MAT.PANTS]);
  });

  it('dresses staff in their uniform and a white cap and hands them their tool', () => {
    const uniforms: Record<number, number> = {
      [FIGURE_MODEL_CLEANER]: MAT.CLEANER_UNIFORM,
      [FIGURE_MODEL_MECHANIC]: MAT.MECHANIC_UNIFORM,
    };
    const tools: Record<number, number> = { [FIGURE_MODEL_CLEANER]: MAT.TIMBER, [FIGURE_MODEL_MECHANIC]: MAT.STEEL_LIGHT };
    for (const model of [FIGURE_MODEL_CLEANER, FIGURE_MODEL_MECHANIC] as const) {
      const clothes = [onlyPart(model, 'torso'), ...partsOf(model, 'arm')];
      for (const box of clothes) {
        expect(box.paletteRole, `${MODEL_NAMES[model]} ${box.part} is uniform`).toBe(PALETTE_ROLE_FIXED);
        expect(box.material, `${MODEL_NAMES[model]} ${box.part} is uniform`).toBe(uniforms[model]);
      }
      expect(onlyPart(model, 'head').paletteRole).toBe(PALETTE_ROLE_SKIN);
      expect(onlyPart(model, 'cap').material).toBe(MAT.CAP);
      const tool = onlyPart(model, 'tool');
      expect(tool.material, `${MODEL_NAMES[model]} tool`).toBe(tools[model]);
      expect(tool.role, 'the tool rides with the right arm').toBe(ROLE_ARM_RIGHT);
      expect(partsOf(model, 'hair'), 'the cap replaces the hair').toHaveLength(0);
    }
  });

  it('stands on its feet at the origin, faces +x, and mirrors left and right', () => {
    for (const model of MODELS) {
      const legs = partsOf(model, 'leg');
      const minX = Math.min(...legs.map((box) => box.minX));
      const maxX = Math.max(...legs.map((box) => box.minX + box.sizeX));
      const minY = Math.min(...legs.map((box) => box.minY));
      const maxY = Math.max(...legs.map((box) => box.minY + box.sizeY));
      expect([(minX + maxX) / 2, (minY + maxY) / 2], `${MODEL_NAMES[model]} feet centre`).toEqual([0, 0]);
      expect(Math.min(...legs.map((box) => box.minZ)), `${MODEL_NAMES[model]} feet on the ground`).toBe(0);
      const head = onlyPart(model, 'head');
      expect([head.minX + head.sizeX / 2, head.minY + head.sizeY / 2], 'the head sits over the feet').toEqual([0, 0]);
      const torso = onlyPart(model, 'torso');
      expect(torso.minX + torso.sizeX, `${MODEL_NAMES[model]}: the chest is flush with the face`).toBe(head.minX + head.sizeX);

      // Everything but the tool (and a Phase 29 guest's souvenir) is left-right symmetric, so no heading shows a lopsided body.
      const body = FIGURE_MODEL_BOXES[model].filter((box) => box.part !== 'tool' && box.part !== 'prop');
      const key = (box: FigureTemplateBox, minY: number): string =>
        [box.part, box.minX, minY, box.minZ, box.sizeX, box.sizeY, box.sizeZ, box.paletteRole, box.material].join(',');
      const shapes = body.map((box) => key(box, box.minY)).sort();
      const mirrored = body.map((box) => key(box, -(box.minY + box.sizeY))).sort();
      expect(mirrored, `${MODEL_NAMES[model]} mirrored`).toEqual(shapes);
    }
    for (const model of MODELS) {
      const [leftLeg, rightLeg] = partsOf(model, 'leg');
      expect([leftLeg.role, rightLeg.role], 'legs in order').toEqual([ROLE_LEG_LEFT, ROLE_LEG_RIGHT]);
      expect(rightLeg.minY, `${MODEL_NAMES[model]} right leg at +y`).toBeGreaterThan(leftLeg.minY);
    }
    // The front: a guest's hair hangs down the back of the head; a staff cap's brim juts out in front.
    const guestHead = onlyPart(FIGURE_MODEL_GUEST, 'head');
    const fringe = onlyPart(FIGURE_MODEL_GUEST, 'fringe');
    expect(fringe.minX + fringe.sizeX, 'the fringe is behind the head').toBe(guestHead.minX);
    for (const model of [FIGURE_MODEL_CLEANER, FIGURE_MODEL_MECHANIC] as const) {
      const head = onlyPart(model, 'head');
      const cap = onlyPart(model, 'cap');
      const tool = onlyPart(model, 'tool');
      expect(cap.minX + cap.sizeX, `${MODEL_NAMES[model]} brim in front of the face`).toBeGreaterThan(head.minX + head.sizeX);
      expect(cap.minX, `${MODEL_NAMES[model]} cap flush at the back`).toBe(head.minX);
      expect(tool.minY, `${MODEL_NAMES[model]} tool in the right (+y) hand`).toBeGreaterThanOrEqual(0);
      const rightArm = partsOf(model, 'arm').find((box) => box.role === ROLE_ARM_RIGHT);
      const leftArm = partsOf(model, 'arm').find((box) => box.role === ROLE_ARM_LEFT);
      expect(rightArm?.minY, `${MODEL_NAMES[model]} the right arm is at +y (mirrored projection)`).toBeGreaterThanOrEqual(1);
      expect(leftArm?.minY, `${MODEL_NAMES[model]} the left arm is at −y`).toBeLessThan(0);
      expect(tool.minY, 'the tool rides at its arm').toBe(rightArm?.minY);
      expect(tool.minX, `${MODEL_NAMES[model]} tool held in front of the arm`).toBeGreaterThanOrEqual(1);
    }
  });

  it('never overlaps two boxes of a figure in any keyframe (coplanar faces would z-fight)', () => {
    for (const model of MODELS) {
      for (const frame of framesOf(model)) {
        const boxes = FIGURE_MODEL_BOXES[model].map((box) => posed(box, frame));
        for (let a = 0; a < boxes.length; a += 1) {
          for (let b = a + 1; b < boxes.length; b += 1) {
            expect(overlapVolume(boxes[a], boxes[b]), `${MODEL_NAMES[model]} frame ${frame}: ${boxes[a].part} × ${boxes[b].part}`)
              .toBe(0);
          }
        }
      }
    }
  });

  it('keeps every body box on whole voxels, so no corner projects onto a texel centre', () => {
    for (const model of MODELS) {
      for (const box of FIGURE_MODEL_BOXES[model]) {
        const values = [box.minX, box.minY, box.minZ, box.sizeX, box.sizeY, box.sizeZ];
        expect(values.every(Number.isInteger), `${MODEL_NAMES[model]} ${box.part}: ${values.join(', ')}`).toBe(true);
        expect(Math.min(box.sizeX, box.sizeY, box.sizeZ), `${MODEL_NAMES[model]} ${box.part} is empty`).toBeGreaterThan(0);
      }
    }
  });

  it('lays one flat shadow decal under a whole stride', () => {
    const shadow = FIGURE_SHADOW_BOX;
    expect(shadow.part).toBe('shadow');
    expect(shadow.paletteRole).toBe(PALETTE_ROLE_FIXED);
    expect(shadow.material).toBe(MAT.SHADOW);
    expect(palette.flags(MAT.SHADOW) & MATERIAL_FLAG_SHADOW, 'the palette flags the decal material').toBe(MATERIAL_FLAG_SHADOW);
    expect([shadow.minZ, shadow.sizeZ]).toEqual([0, FIGURE_SHADOW_HEIGHT]);
    expect(FIGURE_SHADOW_HEIGHT).toBe(0.25);
    expect([shadow.minX + shadow.sizeX / 2, shadow.minY + shadow.sizeY / 2], 'centred under the feet').toEqual([0, 0]);
    // The walk and standing; a sitter's legs reach forward off the bench, over the decal's edge, which is fine there.
    for (const model of MODELS) {
      for (const frame of WALK_FRAMES) {
        for (const leg of partsOf(model, 'leg').map((box) => posed(box, frame))) {
          expect(leg.min[0] >= shadow.minX && leg.max[0] <= shadow.minX + shadow.sizeX, `frame ${frame} foot inside the decal (x)`)
            .toBe(true);
          expect(leg.min[1] >= shadow.minY && leg.max[1] <= shadow.minY + shadow.sizeY, `frame ${frame} foot inside the decal (y)`)
            .toBe(true);
        }
      }
    }
    const feet = partsOf(FIGURE_MODEL_GUEST, 'leg');
    const feetArea = feet.reduce((area, box) => area + box.sizeX * box.sizeY, 0);
    expect(shadow.sizeX * shadow.sizeY, 'larger than the standing feet').toBeGreaterThan(feetArea);
  });

  it('rejects a palette the templates do not fit', () => {
    expect(() => buildFigureTemplates(paletteWith({ count: MAT.CAP }))).toThrow(/does not have/);
    expect(() => buildFigureTemplates(paletteWith({ flags: () => 0 }))).toThrow(/MATERIAL_FLAG_SHADOW/);
    expect(() => buildFigureTemplates(palette)).not.toThrow();
  });
});
