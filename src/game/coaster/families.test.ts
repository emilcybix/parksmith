import { describe, expect, it } from 'vitest';
import { GameWorld } from '../World';
import { COASTER_TYPE_BY_ID, COASTER_TYPES } from './content';
import { COASTER_VALIDATION_TEXT, coasterBaseCost, deriveCoasterStats, validateCoasterLayout } from './design';
import { hillDipLayout, layoutFromMoves, ovalLayout, zigzagLayout } from './testLayouts';

/** Phase 39: the wild mouse and wooden families: their rules, their ride model and a save round trip. */
const MOUSE = COASTER_TYPE_BY_ID.get('whisker-mouse')!;
const WOODEN = COASTER_TYPE_BY_ID.get('timber-twister')!;
const COMET = COASTER_TYPE_BY_ID.get('comet-trail')!;

describe('Phase 39: coaster families', () => {
  it('every type names a family; the three original types are steel', () => {
    expect(COASTER_TYPES.map((type) => [type.definitionId, type.family])).toEqual([
      ['comet-trail', 'steel'], ['star-chaser', 'steel'], ['skyline-serpent', 'steel'],
      ['whisker-mouse', 'wild-mouse'], ['timber-twister', 'wooden'],
    ]);
    expect(MOUSE.trainCars).toBe(2);
    expect(MOUSE.allowedSpecials).toEqual([]);
    expect(WOODEN.allowedSpecials, 'a wooden coaster has no inversions').not.toContain('loop');
  });

  it('a wild mouse turns only on the flat; the oval (hills on the straights) is fine', () => {
    expect(validateCoasterLayout(ovalLayout(), MOUSE)).toEqual({ ok: true });
    // The zig-zag climbs and falls through its turns.
    expect(validateCoasterLayout(zigzagLayout(), MOUSE)).toMatchObject({ ok: false, reason: 'mouse-turn-not-flat' });
    expect(validateCoasterLayout(zigzagLayout(), COASTER_TYPE_BY_ID.get('star-chaser')!), 'other families may').toEqual({ ok: true });
    expect(COASTER_VALIDATION_TEXT['mouse-turn-not-flat']).toMatch(/flat/);
  });

  it('a wild mouse scores turns higher and drops lower than a steel coaster on the same layout', () => {
    // A mouse layout with many flat turns: a hill on the first straight, then a flat zig-zag back.
    const mouseRun = layoutFromMoves({ x: 4, y: 4 }, 'EEEEEEESWSWSWWWWWWNNNE', [0, 0, 0, 1, 2, 1, 0]);
    expect(validateCoasterLayout(mouseRun, MOUSE).ok).toBe(true);
    const mouse = deriveCoasterStats(mouseRun, MOUSE);
    const steel = deriveCoasterStats(mouseRun, COMET);
    expect(mouse.turns).toBe(steel.turns);
    expect(mouse.excitement).toBeGreaterThan(steel.excitement);
    const drop = deriveCoasterStats(hillDipLayout(), { ...MOUSE, maximumHeight: 3 });
    const dropSteel = deriveCoasterStats(hillDipLayout(), { ...COMET, maximumHeight: 3 });
    expect(drop.intensity, 'drops count for less on a mouse').toBeLessThan(dropSteel.intensity + 1e-9);
  });

  it('a wooden coaster is rougher and gets an airtime bonus per hill', () => {
    const steel = deriveCoasterStats(hillDipLayout(), { ...COMET, maximumHeight: 3 });
    const wooden = deriveCoasterStats(hillDipLayout(), WOODEN);
    expect(wooden.drops).toBeGreaterThan(1);
    expect(wooden.intensity).toBeGreaterThan(steel.intensity);
    expect(wooden.excitement).toBeGreaterThan(steel.excitement);
    expect(wooden.reliability).toBeLessThan(COMET.reliability);
  });

  it.each(['whisker-mouse', 'timber-twister'])('%s builds, saves and loads', (id) => {
    const type = COASTER_TYPE_BY_ID.get(id)!;
    const world = new GameWorld(100_000);
    world.setBuildAccessPolicy(null);
    const pieces = ovalLayout();
    const placed = world.placeCoaster(id, pieces, deriveCoasterStats(pieces, type), coasterBaseCost(pieces, type));
    expect('error' in placed).toBe(false);
    const state = world.serialize();
    const restored = new GameWorld();
    restored.restore(structuredClone(state));
    expect(restored.serialize()).toEqual(state);
  });
});
