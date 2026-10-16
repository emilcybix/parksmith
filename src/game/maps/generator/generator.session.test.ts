import { describe, expect, it } from 'vitest';
import { BIOME_IDS } from '../../biomes/types';
import { buildFirstDayRoute } from '../../onboarding/routeInFrame';
import { hashState } from '../../save/hash';
import { ParkSession } from '../../session/ParkSession';
import { hash32 } from '../../weather/random';
import { MAP_DENSITIES, generateMap, recipeOf } from './index';

/** A generated layout drives a real ParkSession: the First Day route builds on every biome, density and facing, and a play-through round-trips. */
describe('generated maps in a ParkSession', () => {
  it('buildFirstDayRoute succeeds on 10 seeds x 6 biomes x 3 densities (180 sessions)', () => {
    const facings = new Set<string>();
    for (const biome of BIOME_IDS) {
      for (const density of MAP_DENSITIES) {
        for (let i = 0; i < 10; i += 1) {
          const { layout } = generateMap(recipeOf(biome, hash32(i, 4242), { density }));
          const session = new ParkSession(null, [], { layout });
          expect(() => buildFirstDayRoute(session), `${biome} ${density} #${i}`).not.toThrow();
          expect(session.world.objects.size).toBe(7);
          facings.add(layout.entrance.facing);
        }
      }
    }
    expect([...facings].sort()).toEqual(['east', 'north', 'south', 'west']);
  }, 120_000);

  it('the park seed is the recipe seed and the layout is the map the session plays on', () => {
    const map = generateMap(recipeOf('jungle', 777));
    const session = new ParkSession(null, [], { layout: map.layout });
    expect(session.seed).toBe(777);
    expect(session.map).toBe(map.layout);
    expect(session.world.props.size).toBe(map.layout.props.length);
    expect(session.serialize().map.recipe).toEqual(map.recipe);
    expect(hashState(session.serialize())).toBe(hashState(new ParkSession(null, [], { layout: map.layout }).serialize()));
  });
});
