import { BUILD_CATALOG } from '../../game/content/catalog';
import { COLOUR_SWATCHES } from '../../game/content/colours';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../game/guests/GuestSimulation';
import { BIOME_MATERIALS } from './content/biomeMaterials';
import { LITTER_EFFECT_MATERIALS } from './content/litter';
import type { Palette } from './contracts/palette';
import { buildPalette } from './palette';

/**
 * The palette the game draws with: the catalog, the guest colours, the colour swatches (Phase 28) and the biomes'
 * ground and prop colours (Phase 24: 31 materials, 162 of 256 in all), then the sick splat's two greens (Phase 49: 164).
 * Tests that need biome ground or props use it.
 */
export const gamePalette = (): Palette => buildPalette(
  BUILD_CATALOG,
  GUEST_COLORS,
  GUEST_ACCENTS,
  COLOUR_SWATCHES.map((swatch) => swatch.rgb),
  [...BIOME_MATERIALS, ...LITTER_EFFECT_MATERIALS],
);
