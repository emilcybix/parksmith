import { describe, expect, it } from 'vitest';
import { BIOME_IDS } from '../../biomes/types';
import { GOLDEN_CORPUS_KEYS, BINDING_RECIPE_KEYS, corpusDigestOf, recipeOfGoldenKey } from './goldenCorpus';
import { GENERATOR_VERSION, generateMap, generatedMapHash, recipeOf } from './index';

/**
 * GOLDEN HASHES (Phase 24 step 2). Policy: ANY change to the generator's output for ANY recipe fails this test. The fix is
 * a GENERATOR_VERSION bump (src/game/maps/recipe.ts) plus new pins in the same change, never a quiet re-pin: the test
 * asserts `GOLDEN.version === GENERATOR_VERSION`, so re-pinning without a bump fails too. Saved parks keep their stored map
 * (restore never regenerates); the version only tells a later reader which generator made a recipe.
 * Keys: biome : seed : density : wet|dry (the water option).
 *
 * The single pins are typical maps (none reaches a cap or runs the repair pass), so `corpusDigest` also pins one hash over
 * the 166 recipes of `goldenCorpus.ts`, which include maps where each generator constant binds: a change of
 * `GAME_CONFIG.maps.generator` that changes output fails here too.
 *
 * History: version 2 (review fix) joins land stranded behind permanent props and water in repair R2; of the pins only
 * autumn-forest:1 changed (a540a8edc4a3cb99 -> 78b766f7cb9965e5). Version 1 had no corpus digest.
 */
const GOLDEN = {
  version: 2,
  corpusDigest: 'fe1a652260499d12',
  hashes: {
    'meadow:1:normal:wet': '71407f2eb939a1b5',
    'meadow:1234:normal:wet': '93178e5efbdf9c17',
    'meadow:3735928559:normal:wet': '9153e1bcdde797b8',
    'seaside:1:normal:wet': '04a5a320e51eae7a',
    'seaside:1234:normal:wet': '21be47afb5f75a3c',
    'seaside:3735928559:normal:wet': '894abc9ac3f52f78',
    'desert-canyon:1:normal:wet': '5e2fa600893720fd',
    'desert-canyon:1234:normal:wet': '2318af26432cb35b',
    'desert-canyon:3735928559:normal:wet': 'b8b95559f6a3bdfc',
    'winter:1:normal:wet': '72fee3e49c84b38e',
    'winter:1234:normal:wet': '1f0d071219e0e638',
    'winter:3735928559:normal:wet': 'b7c2788db124b517',
    'jungle:1:normal:wet': 'ed8d4e58eda158b5',
    'jungle:1234:normal:wet': 'ae63184982ae45ec',
    'jungle:3735928559:normal:wet': 'f181d0d637fc7eb8',
    'autumn-forest:1:normal:wet': '78b766f7cb9965e5',
    'autumn-forest:1234:normal:wet': '52181d2fac6712a1',
    'autumn-forest:3735928559:normal:wet': '8a523ee4755aef76',
    'seaside:1234:low:wet': 'a3af972d15639ce9',
    'seaside:1234:high:wet': 'bc974362b9bb26d5',
    'seaside:1234:normal:dry': 'b8112e2c3bd32f38',
    'meadow:1234:normal:dry': '520c4a384f67d3f3',
  } as Record<string, string>,
};

const recipeOfKey = (key: string) => {
  const [biome, seed, density, water] = key.split(':');
  return recipeOf(biome as never, Number(seed), { density: density as never, water: water === 'wet' });
};

describe('generator golden hashes', () => {
  it('the pins belong to the current GENERATOR_VERSION (a change of output must bump it)', () => {
    expect(GOLDEN.version).toBe(GENERATOR_VERSION);
  });

  it('pins three seeds per biome at normal density with water, plus Seaside low / high / dry and Meadow dry (22 hashes)', () => {
    expect(Object.keys(GOLDEN.hashes).length).toBe(22);
    for (const biome of BIOME_IDS) {
      expect(Object.keys(GOLDEN.hashes).filter((key) => key.startsWith(`${biome}:`) && key.endsWith(':normal:wet')).length, biome).toBe(3);
    }
  });

  it.each(Object.keys(GOLDEN.hashes))('%s', (key) => {
    expect(generatedMapHash(generateMap(recipeOfKey(key)))).toBe(GOLDEN.hashes[key]);
  });

  it('the corpus digest: 108 sample maps plus 58 maps where a generator constant binds (caps, repair carves)', () => {
    expect(GOLDEN_CORPUS_KEYS.length).toBe(166);
    expect(new Set(BINDING_RECIPE_KEYS).size).toBe(BINDING_RECIPE_KEYS.length);
    const hashes = GOLDEN_CORPUS_KEYS.map((key) => generatedMapHash(generateMap(recipeOfGoldenKey(key))));
    expect(corpusDigestOf(hashes)).toBe(GOLDEN.corpusDigest);
  }, 20_000);
});
