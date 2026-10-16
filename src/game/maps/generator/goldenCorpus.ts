import { BIOME_IDS, type BiomeId } from '../../biomes/types';
import { hashState } from '../../save/hash';
import { hash32 } from '../../weather/random';
import { MAP_DENSITIES, recipeOf, type MapDensity, type MapRecipe } from '../recipe';

/**
 * The corpus behind the generator's golden DIGEST pin (Phase 24 step 2, test support only; the game never imports it).
 *
 * The 22 single-recipe pins in `generator.golden.test.ts` are typical maps: none of them reaches a cap or runs the repair
 * pass, so a change of `GAME_CONFIG.maps.generator` (minimum open area, prop count cap, chunk or map weight cap, carve
 * cap) could change many maps without moving one of them. This corpus closes that gap. It holds
 *
 * - a general sample: 6 seeds per biome and density (water on where the biome has it), and
 * - BINDING recipes, found by changing each generator constant by one step (and by a larger step) over 4,000 recipes and
 *   keeping up to six of the maps that changed, spread over the biomes: maps where R1 or R2 carve, where the 300-prop
 *   cap, the 1,400 chunk weight cap or the 8,600 map weight cap binds, and where a smaller carve cap would change R1/R2.
 *
 * `generatorCorpusDigest()` is one hash over all of them; the golden test pins it next to GENERATOR_VERSION, so any
 * output change of these maps fails until the version is bumped and the pins are re-taken in the same change.
 * Keys: biome : seed : density : wet|dry.
 */
export const BINDING_RECIPE_KEYS: readonly string[] = [
  'meadow:2687412426:high:wet', 'winter:4021149352:high:wet', 'jungle:322634579:low:wet', 'autumn-forest:3385591405:low:wet',
  'winter:2764777804:high:wet', 'jungle:3860189847:low:wet', 'autumn-forest:4050700385:low:wet', 'autumn-forest:2307024174:low:wet',
  'autumn-forest:4283383588:low:wet', 'autumn-forest:4050700385:low:dry', 'autumn-forest:3258617531:low:dry', 'autumn-forest:4283383588:low:dry',
  'jungle:3185424305:high:wet', 'autumn-forest:1155248479:normal:wet', 'jungle:1399741382:high:wet', 'autumn-forest:4164251980:normal:dry',
  'autumn-forest:1155248479:normal:dry', 'autumn-forest:2749220910:normal:dry', 'jungle:1894714874:high:wet', 'autumn-forest:4164251980:normal:wet',
  'jungle:502024833:high:wet', 'jungle:3263703554:high:wet', 'autumn-forest:2749220910:normal:wet', 'meadow:3937056758:normal:wet',
  'seaside:3521473031:normal:wet', 'meadow:1123836177:normal:wet', 'seaside:2986478394:normal:dry', 'meadow:2801159891:normal:wet',
  'seaside:2645911539:normal:dry', 'meadow:758534887:normal:wet', 'seaside:4290598374:low:wet', 'seaside:3764587016:low:wet',
  'meadow:2992850352:normal:wet', 'seaside:3258617531:low:dry', 'seaside:2429490997:normal:dry', 'winter:2574940985:normal:wet',
  'jungle:4011171062:high:wet', 'seaside:3591202825:normal:dry', 'winter:4247826276:normal:dry', 'jungle:3955779709:high:wet',
  'meadow:980523067:high:wet', 'seaside:4188580594:normal:wet', 'winter:3629472304:normal:wet', 'jungle:3385591405:normal:dry',
  'autumn-forest:980523067:high:wet', 'meadow:3385591405:high:wet', 'autumn-forest:1950746649:low:wet', 'autumn-forest:2834883605:low:wet',
  'autumn-forest:3162126023:low:wet', 'autumn-forest:1364415490:low:wet', 'autumn-forest:315569947:low:wet', 'autumn-forest:3162126023:normal:wet',
  'jungle:738658158:high:wet', 'autumn-forest:1203854616:low:wet', 'jungle:1776476772:high:wet', 'autumn-forest:3955779709:low:wet',
  'jungle:424462962:high:wet', 'autumn-forest:3521473031:low:wet',
];

export const SAMPLE_RECIPE_KEYS: readonly string[] = BIOME_IDS.flatMap((biome) => MAP_DENSITIES.flatMap((density) => (
  Array.from({ length: 6 }, (_, i) => `${biome}:${hash32(i, 0x601d)}:${density}:wet`)
)));

export const GOLDEN_CORPUS_KEYS: readonly string[] = [...SAMPLE_RECIPE_KEYS, ...BINDING_RECIPE_KEYS];

export const recipeOfGoldenKey = (key: string): MapRecipe => {
  const [biome, seed, density, water] = key.split(':');
  return recipeOf(biome as BiomeId, Number(seed), { density: density as MapDensity, water: water === 'wet' });
};

/** One hash over the given per-map hashes (in corpus order). */
export const corpusDigestOf = (mapHashes: readonly string[]): string => hashState({ corpus: mapHashes });
