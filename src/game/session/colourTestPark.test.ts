import { describe, expect, it } from 'vitest';
import { colourKindOf } from '../content/colours';
import { hashState } from '../save/hash';
import { ParkSession } from './ParkSession';
import { seedColourTestPark } from './colourTestPark';

/** The world state hash of the baseline2 extendedPark.ts park (captured before any step-2 change): the same park. */
const WORLD_HASH = 'c129e218eb85dd5c';

describe('seedColourTestPark (the park the renderer and UI colour tests share)', () => {
  const session = new ParkSession(null);
  const report = seedColourTestPark(session);
  const { world } = session;

  it('is the developer park plus a Comet Trail, a Skyline Serpent and a Ripple Fountain, with no problems', () => {
    expect(report).toEqual({ problems: [], cometTrailId: 67, serpentId: 68, fountainId: 69 });
    expect(world.objects.size).toBe(69);
    expect(world.objects.get(67)!.definitionId).toBe('comet-trail');
    expect(world.objects.get(68)!.definitionId).toBe('skyline-serpent');
    expect(world.objects.get(69)!.definitionId).toBe('ripple-fountain');
    expect(world.coasters.size).toBe(3);
    expect(world.coasters.get(67)!.pieces).toHaveLength(18);
    const serpent = world.coasters.get(68)!.pieces;
    expect(serpent).toHaveLength(20);
    expect(serpent.map((piece) => piece.special).filter(Boolean)).toEqual(['boost', 'loop']);
  });

  it('every colourable kind is on the map (a unit test of the park the baseline captures were taken in)', () => {
    const kinds = new Set([...world.objects.values()].map((object) => colourKindOf(object.definitionId)));
    expect(kinds).toEqual(new Set(['ride', 'coaster', 'stall', 'comfort', 'scenery', null]));
    const definitions = new Set([...world.objects.values()].map((object) => object.definitionId));
    for (const id of ['comet-trail', 'star-chaser', 'skyline-serpent', 'picnic-pocket', 'comfort-cabin', 'ribbon-bench', 'tidy-totem', 'lollipop-lamp', 'sunburst-flowers', 'ripple-fountain']) {
      expect(definitions.has(id), id).toBe(true);
    }
  });

  it('is deterministic (the same world state hash every run) and the extras are placed from the same seed park', () => {
    const again = new ParkSession(null);
    seedColourTestPark(again);
    expect(hashState(again.world.serialize())).toBe(hashState(world.serialize()));
    expect(hashState(world.serialize())).toBe(WORLD_HASH);
  });
});
