import type { CoasterPiece } from '../../../game/coaster/design';
import type { PropKindDefinition } from '../../../game/maps/props';
import type { BuildDefinition } from '../../../game/types';
import type { Blueprint } from '../contracts/blueprint';
import { packBoxWord } from '../contracts/boxes';
import type { BoxWriter } from '../contracts/boxes';
import type { CoasterContent, LitterEmitter, ObjectContent, PropContent } from '../contracts/content';
import { MAT, MAT_COLOR, PATTERN } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { COASTER_LEVEL_VOXELS, PATH_TOP_Z, PLOT_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';

/**
 * Stand-in content: a footprint-sized block in the definition's colour. Every content module starts
 * as this so the static world can be built and tested against real catalog ids before any model is
 * authored, and anything not yet authored still shows up in the park.
 */
export const placeholderContent = (height = 16): ObjectContent => ({
  blueprint: (definition: BuildDefinition, palette: Palette): Blueprint => {
    const [width, depth] = definition.footprint;
    return {
      id: `placeholder:${definition.id}:${height}`,
      footprint: definition.footprint,
      parts: [{
        id: 'body',
        pivot: [0, 0, 0],
        shapes: [{
          kind: 'box',
          min: [2, 2, PLOT_TOP_Z],
          size: [width * VOXELS_PER_TILE - 4, depth * VOXELS_PER_TILE - 4, height],
          material: palette.material(definition.color),
          pattern: PATTERN.PLAIN,
        }],
      }],
    };
  },
});

/** Phase 24: a prop's stand-in, a stone block of its whole footprint, 24 voxels tall (the obstacle still reads as blocking). */
export const PLACEHOLDER_PROP_HEIGHT = 24;
export const placeholderProp: PropContent = {
  blueprint: (kind: PropKindDefinition): Blueprint => {
    const [width, depth] = kind.footprint;
    return {
      id: `placeholder-prop:${kind.id}`,
      footprint: kind.footprint,
      floorZ: 0,
      parts: [{
        id: 'body',
        pivot: [0, 0, 0],
        shapes: [{
          kind: 'box',
          min: [1, 1, 0],
          size: [width * VOXELS_PER_TILE - 2, depth * VOXELS_PER_TILE - 2, PLACEHOLDER_PROP_HEIGHT],
          material: MAT.STONE,
          pattern: PATTERN.PLAIN,
        }],
      }],
    };
  },
};

/** A bed block per piece at its height, and a post under raised pieces. */
export const placeholderCoaster: CoasterContent = {
  pieceBoxes: (
    pieces: readonly CoasterPiece[],
    index: number,
    definition: BuildDefinition,
    palette: Palette,
    outlineGroup: number,
    out: BoxWriter,
  ): void => {
    const piece = pieces[index];
    const x = piece.cell.x * VOXELS_PER_TILE;
    const y = piece.cell.y * VOXELS_PER_TILE;
    const bed = piece.height * COASTER_LEVEL_VOXELS + PATH_TOP_Z;
    out.push(x + 8, y + 8, bed, 16, 16, 4, packBoxWord(palette.material(definition.color), outlineGroup, PATTERN.PLAIN, 0));
    if (piece.height > 0) {
      out.push(x + 2, y + 2, PATH_TOP_Z, 2, 2, bed - PATH_TOP_Z, packBoxWord(MAT.SUPPORT, outlineGroup, PATTERN.PLAIN, 0));
    }
  },
  carBlueprint: (definition: BuildDefinition, carIndex: number, palette: Palette): Blueprint => ({
    id: `placeholder-car:${definition.id}:${carIndex === 0 ? 'lead' : 'car'}`,
    footprint: [1, 1],
    floorZ: 0,
    parts: [{
      id: 'body',
      pivot: [0, 0, 0],
      shapes: [{
        kind: 'box',
        min: [-5, -4, 0],
        size: [10, 8, 6],
        material: carIndex === 0 ? palette.material(definition.color) : MAT.TRAIN,
      }],
    }],
  }),
  // The fallback train carries no riders (one invisible-by-size sliver keeps the model valid) and a plain half-bar.
  riderBlueprint: (definition: BuildDefinition, carIndex: number): Blueprint => ({
    id: `placeholder-riders:${definition.id}:${carIndex}`,
    footprint: [1, 1],
    floorZ: -1,
    parts: [{ id: 'body', pivot: [0, 0, 0], shapes: [{ kind: 'box', min: [0, -1, 6], size: [2, 2, 2], material: MAT.SKIN_1 }] }],
  }),
  couplingBlueprint: (definition: BuildDefinition): Blueprint => ({
    id: `placeholder-coupling:${definition.id}`,
    footprint: [1, 1],
    floorZ: -1,
    parts: [{ id: 'body', pivot: [0, 0, 0], shapes: [{ kind: 'box', min: [0, -1, -1], size: [8, 2, 2], material: MAT.TRAIN }] }],
  }),
};

export const placeholderLitter: LitterEmitter = (cellX, cellY, units, _palette, out) => {
  const x = cellX * VOXELS_PER_TILE + 15;
  const y = cellY * VOXELS_PER_TILE + 15;
  out.push(x, y, PATH_TOP_Z, 2, 2, units > 4 ? 3 : 2, packBoxWord(MAT.LITTER_CUP, 0, PATTERN.PLAIN, 0));
};

/** Two posts and a beam over the entrance path tile. */
export const placeholderEntrance = (palette: Palette): Blueprint => ({
  id: 'placeholder:entrance',
  footprint: [1, 1],
  parts: [{
    id: 'body',
    pivot: [0, 0, 0],
    shapes: [
      { kind: 'box', min: [2, 2, PATH_TOP_Z], size: [4, 4, 40], material: MAT.ENTRANCE_POST },
      { kind: 'box', min: [26, 2, PATH_TOP_Z], size: [4, 4, 40], material: MAT.ENTRANCE_POST },
      { kind: 'box', min: [2, 2, 40], size: [28, 4, 6], material: palette.material(MAT_COLOR.SIGN) },
    ],
  }],
});
