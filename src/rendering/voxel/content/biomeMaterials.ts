import { BIOMES } from '../../../game/biomes/content';
import type { BiomeDefinition } from '../../../game/biomes/types';
import { PROP_KINDS } from '../../../game/maps/props';
import type { PropKindDefinition } from '../../../game/maps/props';

/**
 * The palette materials the biomes add (Phase 24 step 1), as data: ground, soil, paving, curb, plain water and every
 * prop colour, in BIOMES order and, within a biome, ground first and then the prop colours in PROP_KINDS order.
 * `buildPalette` appends them AFTER the colour swatches and de-duplicates by rgb among the unflagged materials, so a
 * colour that already exists (Meadow's lawn, soil, paving and curb are fixed materials; a prop colour that is a fixed
 * or catalog colour) costs nothing and no existing material id ever moves.
 *
 * Declared here, next to the content that needs them, so adding a biome or a prop colour is data plus a test.
 */
export interface BiomeMaterial {
  readonly rgb: number;
  /** The pattern's second colour (the lawn's second shade, the paving bond, the strata band); undefined = the palette derives a contrasting one. */
  readonly secondary?: number;
  /** 'calm' = the ground family's low variation (grass, paving, curb: art bible ±6 %); 'default' = the usual ±8 %. */
  readonly variation: 'calm' | 'default';
  readonly what: string;
}

const ground = (biome: BiomeDefinition): BiomeMaterial[] => {
  const g = biome.ground;
  const name = (part: string): string => `${biome.name} ${part}`;
  const entries: BiomeMaterial[] = [
    { rgb: g.base.rgb, secondary: g.base.secondary, variation: 'calm', what: name('ground') },
    { rgb: g.alt.rgb, secondary: g.alt.secondary, variation: 'calm', what: name('second ground') },
    { rgb: g.soil.rgb, secondary: g.soil.secondary, variation: 'default', what: name('soil') },
    { rgb: g.paving.rgb, secondary: g.paving.secondary, variation: 'calm', what: name('paving') },
    { rgb: g.curb.rgb, secondary: g.curb.secondary, variation: 'calm', what: name('curb') },
  ];
  if (g.waterMaterial === 'plain') {
    entries.push({ rgb: g.water.rgb, secondary: g.water.secondary, variation: 'default', what: name('ice') });
  }
  return entries;
};

const props = (kind: PropKindDefinition): BiomeMaterial[] => kind.colors.map((rgb) => (
  { rgb, variation: 'default', what: `${kind.name} colour` } satisfies BiomeMaterial
));

/** Every material the biomes may need, in palette order (duplicates are fine: the palette de-duplicates by rgb). */
export const collectBiomeMaterials = (
  biomes: readonly BiomeDefinition[] = BIOMES,
  kinds: readonly PropKindDefinition[] = PROP_KINDS,
): readonly BiomeMaterial[] => biomes.flatMap((biome) => [
  ...ground(biome),
  ...kinds.filter((kind) => kind.biome === biome.id).flatMap(props),
]);

export const BIOME_MATERIALS: readonly BiomeMaterial[] = collectBiomeMaterials();
