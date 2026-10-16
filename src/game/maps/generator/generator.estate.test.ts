import { describe, expect, it } from 'vitest';
import { BIOME_IDS } from '../../biomes/types';
import { GAME_CONFIG } from '../../config';
import { layoutFromState } from '../parse';
import { validateMapDefinition } from '../validate';
import { ParkSession } from '../../session/ParkSession';
import { generateMap, generatedMapHash, generatedMapId, generatedMapName, readRecipe, recipeOf } from './index';
import { SIZE } from './draft';

/**
 * Phase 21: generated estates. `size: 64` makes a 64 x 64 map with a starting owned area of four by three parcels by the
 * gate; every classic recipe keeps its exact shape, id and map (the golden corpus pins the 32 x 32 output).
 */
describe('generated estates (Phase 21)', () => {
  it('a classic recipe has no size key; an estate recipe says 64 in its key, id and name', () => {
    expect('size' in recipeOf('meadow', 7)).toBe(false);
    const estate = recipeOf('meadow', 7, { size: 64 });
    expect(estate.size).toBe(64);
    expect(generatedMapId(estate)).toBe('gen-meadow-7-nw-64');
    expect(generatedMapName(estate)).toBe('Generated estate · seed 7');
    expect(readRecipe(JSON.parse(JSON.stringify(estate)))).toEqual(estate);
    expect(readRecipe({ ...estate, size: 48 })).toEqual({ problem: 'size must be 64 when present' });
    expect(() => recipeOf('meadow', 7, { size: 48 as never })).toThrow(RangeError);
  });

  it.each(BIOME_IDS.map((biome) => [biome] as const))('%s: 24 seeds at every density are valid 64 x 64 estates with a starting area by the gate', (biome) => {
    for (let seed = 1; seed <= 8; seed += 1) {
      for (const density of ['low', 'normal', 'high'] as const) {
        const map = generateMap(recipeOf(biome, seed * 104_729, { size: 64, density }));
        expect([map.layout.width, map.layout.height]).toEqual([64, 64]);
        expect(validateMapDefinition(map.definition)).toEqual([]);
        const owned = map.definition.ownedArea!;
        expect((owned.x1 - owned.x0 + 1) * (owned.y1 - owned.y0 + 1), 'twelve parcels').toBe(12 * 64);
        const gate = map.layout.entrance;
        expect(gate.x >= owned.x0 && gate.x <= owned.x1 && gate.y >= owned.y0 && gate.y <= owned.y1).toBe(true);
        expect(map.stats.stranded).toBe(0);
      }
    }
    expect(SIZE, 'the draft size is put back after every run').toBe(GAME_CONFIG.mapWidth);
  }, 120_000);

  it('is deterministic, and a classic map generated after an estate is unchanged', () => {
    const classic = generatedMapHash(generateMap(recipeOf('jungle', 99)));
    const estate = generatedMapHash(generateMap(recipeOf('jungle', 99, { size: 64 })));
    expect(generatedMapHash(generateMap(recipeOf('jungle', 99, { size: 64 })))).toBe(estate);
    expect(generatedMapHash(generateMap(recipeOf('jungle', 99)))).toBe(classic);
  });

  it('a park on a generated estate starts with its owned area and saves and restores the map', () => {
    const map = generateMap(recipeOf('seaside', 2024, { size: 64 }));
    const session = new ParkSession(null, [], { layout: map.layout });
    expect(session.world.land.restricted).toBe(true);
    expect(session.world.land.ownedCount).toBe(12);
    const state = JSON.parse(JSON.stringify(session.serialize()));
    expect(layoutFromState(state.map).recipe).toEqual(map.recipe);
    const restored = ParkSession.fromState(state);
    expect(restored.world.land.ownedParcels()).toEqual(session.world.land.ownedParcels());
  });
});
