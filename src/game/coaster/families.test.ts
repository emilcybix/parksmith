import { describe, expect, it } from 'vitest';
import { GameWorld } from '../World';
import { COASTER_TYPE_BY_ID, COASTER_TYPES } from './content';
import { COASTER_VALIDATION_TEXT, checkCoasterDesign, coasterBaseCost, coasterSpeedTrace, deriveCoasterStats, validateCoasterLayout } from './design';
import { liftRuns, setLiftRunChained } from './lift';
import { GAME_CONFIG } from '../config';
import { hillDipLayout, layoutFromMoves, ovalLayout, zigzagLayout } from './testLayouts';

/** Phase 39: the wild mouse and wooden families: their rules, their ride model and a save round trip. */
const MOUSE = COASTER_TYPE_BY_ID.get('whisker-mouse')!;
const WOODEN = COASTER_TYPE_BY_ID.get('timber-twister')!;
const COMET = COASTER_TYPE_BY_ID.get('comet-trail')!;

describe('Phase 39: coaster families', () => {
  it('every type names a family; the three original types are steel', () => {
    expect(COASTER_TYPES.map((type) => [type.definitionId, type.family])).toEqual([
      ['comet-trail', 'steel'], ['star-chaser', 'steel'], ['skyline-serpent', 'steel'],
      ['whisker-mouse', 'wild-mouse'], ['timber-twister', 'wooden'], ['thunder-launch', 'launch'], ['bat-wing', 'inverted'], ['titan-hyper', 'steel'],
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

describe('Phase 39 step 2: the launch family', () => {
  const LAUNCH = COASTER_TYPE_BY_ID.get('thunder-launch')!;
  /** A top hat: the launch on piece 3, a chain-free climb to level 5, a drop, and the flat way home. */
  const topHat = (): ReturnType<typeof layoutFromMoves> => {
    const pieces = layoutFromMoves({ x: 2, y: 4 }, `${'E'.repeat(14)}SS${'W'.repeat(14)}NN`,
      [0, 0, 0, 0, 1, 2, 3, 4, 5, 4, 3, 2, 1, 0], { 3: 'launch' });
    const run = liftRuns(pieces).find((candidate) => candidate.start === 3)!;
    setLiftRunChained(pieces, run.start, false);
    return pieces;
  };

  it('needs a launch, and reaches level 5 where every other family stops at 4', () => {
    expect(validateCoasterLayout(topHat(), LAUNCH)).toEqual({ ok: true });
    const withoutLaunch = topHat().map((piece) => ({ ...piece, special: undefined }));
    expect(validateCoasterLayout(withoutLaunch, LAUNCH)).toMatchObject({ ok: false, reason: 'launch-missing' });
    expect(validateCoasterLayout(topHat(), { ...COASTER_TYPE_BY_ID.get('skyline-serpent')!, allowedSpecials: ['launch'] }))
      .toMatchObject({ ok: false, reason: 'height-range' });
  });

  it('the launch fires the train out at launch speed, and the free climb rides it over the top hat', () => {
    const pieces = topHat();
    const trace = coasterSpeedTrace(pieces);
    // The launch piece starts the climb, so the train leaves it a little under launch speed, far above any drop's cap.
    expect(trace.exitSpeeds[3]).toBeGreaterThan(GAME_CONFIG.coaster.speed.maximum);
    expect(checkCoasterDesign(pieces, LAUNCH).validation).toEqual({ ok: true });
    const stats = deriveCoasterStats(pieces, LAUNCH);
    expect(stats.topSpeed).toBeGreaterThan(GAME_CONFIG.coaster.speed.maximum);
    expect(stats.highestHeight).toBe(5);
  });

  it('builds, saves and loads', () => {
    const world = new GameWorld(100_000);
    world.setBuildAccessPolicy(null);
    const pieces = topHat();
    const placed = world.placeCoaster('thunder-launch', pieces, deriveCoasterStats(pieces, LAUNCH), coasterBaseCost(pieces, LAUNCH));
    expect('error' in placed).toBe(false);
    const state = world.serialize();
    const restored = new GameWorld();
    restored.restore(structuredClone(state));
    expect(restored.serialize()).toEqual(state);
  });
});

describe('Phase 39 step 3: the inverted family', () => {
  const BAT = COASTER_TYPE_BY_ID.get('bat-wing')!;
  const place = (world: GameWorld, id: string, pieces: ReturnType<typeof ovalLayout>) => {
    const type = COASTER_TYPE_BY_ID.get(id)!;
    return world.placeCoaster(id, pieces, deriveCoasterStats(pieces, type), coasterBaseCost(pieces, type));
  };

  it('takes no loops and never crosses itself', () => {
    expect(BAT.allowedSpecials).not.toContain('loop');
    expect(validateCoasterLayout(ovalLayout(), BAT)).toEqual({ ok: true });
    const figureEight = layoutFromMoves({ x: 2, y: 5 }, 'EEEEEESSWWNNNNWWWWWSSE', [0, 0, 0, 1, 2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(validateCoasterLayout(figureEight, COMET)).toEqual({ ok: true });
    expect(validateCoasterLayout(figureEight, BAT)).toMatchObject({ ok: false, reason: 'crossing-not-allowed' });
  });

  it('a path under hanging track needs a level more, and no other track crosses it', () => {
    const world = new GameWorld(100_000);
    world.setBuildAccessPolicy(null);
    const placed = place(world, 'bat-wing', ovalLayout({ x: 4, y: 4 }));
    expect('error' in placed).toBe(false);
    // The oval runs at level 2 along y = 4 from x = 8 to x = 11: a guest would walk into the hanging cars.
    expect(world.canPlacePath({ x: 9, y: 4 })).toBe(false);
    const comet = new GameWorld(100_000);
    place(comet, 'comet-trail', ovalLayout({ x: 4, y: 4 }));
    expect(comet.canPlacePath({ x: 9, y: 4 }), 'the same cell under ordinary track').toBe(true);
    expect(world.coasterPieceConflict({ cell: { x: 9, y: 4 }, height: 0 })).toBe('track');
    expect(world.coasterPieceConflict({ cell: { x: 9, y: 4 }, height: 4 }), 'not even two levels over it').toBe('track');
  });

  it('builds, saves and loads with its hanging layers', () => {
    const world = new GameWorld(100_000);
    world.setBuildAccessPolicy(null);
    place(world, 'bat-wing', ovalLayout({ x: 4, y: 4 }));
    const restored = new GameWorld();
    restored.restore(structuredClone(world.serialize()));
    expect(restored.canPlacePath({ x: 9, y: 4 })).toBe(false);
    expect(restored.serialize()).toEqual(world.serialize());
  });
});

describe('Phase 45: tall coasters', () => {
  const TITAN = COASTER_TYPE_BY_ID.get('titan-hyper')!;
  /** A 40-piece hyper: a chain to level 10, one long drop, a camel hump and the way home. */
  const hyper = () => layoutFromMoves({ x: 2, y: 2 }, `${'E'.repeat(18)}SS${'W'.repeat(18)}NN`,
    [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 1, 0]);

  it('the Titan Hyper and the Thunder Launch reach level 10; everyone else keeps their cap', () => {
    expect(GAME_CONFIG.coaster.absoluteMaximumHeight).toBe(10);
    expect(TITAN.maximumHeight).toBe(10);
    expect(COASTER_TYPE_BY_ID.get('thunder-launch')!.maximumHeight).toBe(10);
    expect(validateCoasterLayout(hyper(), TITAN)).toEqual({ ok: true });
    expect(validateCoasterLayout(hyper(), COASTER_TYPE_BY_ID.get('skyline-serpent')!)).toMatchObject({ ok: false, reason: 'height-range' });
  });

  it('a level-10 drop is wild but does not pin intensity at 100 by itself', () => {
    const stats = deriveCoasterStats(hyper(), TITAN);
    expect(stats.biggestDrop).toBe(10);
    expect(stats.intensity).toBeLessThan(100);
    expect(stats.excitement).toBeGreaterThan(deriveCoasterStats(hillDipLayout(), { ...TITAN, maximumHeight: 3 }).excitement);
  });

  it('builds, saves and loads at level 10', () => {
    const world = new GameWorld(200_000);
    world.setBuildAccessPolicy(null);
    const pieces = hyper();
    const placed = world.placeCoaster('titan-hyper', pieces, deriveCoasterStats(pieces, TITAN), coasterBaseCost(pieces, TITAN));
    expect('error' in placed).toBe(false);
    const state = world.serialize();
    const restored = new GameWorld();
    restored.restore(structuredClone(state));
    expect(restored.serialize()).toEqual(state);
  });
});
