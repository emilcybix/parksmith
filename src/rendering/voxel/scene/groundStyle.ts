import type { BiomeDefinition } from '../../../game/biomes/types';
import { packBoxWord } from '../contracts/boxes';
import { OUTLINE_GROUP_GROUND } from '../contracts/gbuffer';
import { MAT, PATTERN } from '../contracts/palette';
import type { Palette } from '../contracts/palette';

/**
 * Phase 24: the box words of a biome's ground (terrain top, soil, plain water, paving, curb), looked up once per
 * palette and biome. Meadow resolves to exactly today's fixed materials and patterns (GRASS, SOIL, PAVING, CURB;
 * pinned by groundStyle.test.ts), so the default park's chunks hash as they always did. A biome's colours are
 * ordinary plain materials the palette appends (content/biomeMaterials.ts): the terrain material of a biome is
 * data, no shader or uniform is involved.
 *
 * Patterns: the lawn checker and its grid line (PATTERN.GRASS) keep tiles readable on sand and snow as well; paving
 * keeps its bond; the curb is plain; Winter's ice speckles.
 */
export interface GroundStyle {
  /** The terrain top voxel layer of open ground ('.'). */
  readonly base: number;
  /** The second ground ('.' in Meadow). */
  readonly alt: number;
  /** Water (flush with the ground in step 1). */
  readonly water: number;
  /** The diorama edge strata. */
  readonly soil: number;
  readonly paving: number;
  readonly curb: number;
}

const word = (material: number, pattern: number): number => packBoxWord(material, OUTLINE_GROUP_GROUND, pattern, 0);

/** Throws when the palette lacks a colour of the biome (a palette built without `biomeMaterials`). */
export const groundStyleFor = (palette: Palette, biome: BiomeDefinition): GroundStyle => {
  const g = biome.ground;
  return {
    base: word(palette.material(g.base.rgb), PATTERN.GRASS),
    alt: word(palette.material(g.alt.rgb), PATTERN.GRASS),
    water: g.waterMaterial === 'water' ? word(MAT.WATER, PATTERN.WATER) : word(palette.material(g.water.rgb), PATTERN.SPECKLE),
    soil: word(palette.material(g.soil.rgb), PATTERN.SOIL),
    paving: word(palette.material(g.paving.rgb), PATTERN.PAVING),
    curb: word(palette.material(g.curb.rgb), PATTERN.PLAIN),
  };
};

/** Today's lawn, soil, paving and curb words: Meadow, and the stand-in when a palette lacks a biome's colours. */
export const meadowGroundStyle = (): GroundStyle => ({
  base: word(MAT.GRASS, PATTERN.GRASS),
  alt: word(MAT.GRASS, PATTERN.GRASS),
  water: word(MAT.WATER, PATTERN.WATER),
  soil: word(MAT.SOIL, PATTERN.SOIL),
  paving: word(MAT.PAVING, PATTERN.PAVING),
  curb: word(MAT.CURB, PATTERN.PLAIN),
});
