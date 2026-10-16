import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { GameWorld } from '../World';
import { COASTER_TYPE_BY_ID } from './content';
import {
  COASTER_VALIDATION_TEXT,
  coasterBaseCost,
  coasterCrossings,
  deriveCoasterStats,
  isExclusiveCoasterPiece,
  validateCoasterLayout,
  type CoasterPiece,
} from './design';
import { layoutFromMoves, ovalLayout } from './testLayouts';

/**
 * Phase 38: track over and under itself, other coasters and low objects. The figure eight below runs east at level 2
 * over (6, 5) (piece 4) and comes back north through the same cell at level 0 (piece 12).
 */
const COMET = COASTER_TYPE_BY_ID.get('comet-trail')!;
const SERPENT = COASTER_TYPE_BY_ID.get('skyline-serpent')!;
const FIGURE_EIGHT_MOVES = 'EEEEEESSWWNNNNWWWWWSSE';
const FIGURE_EIGHT_HEIGHTS = [0, 0, 0, 1, 2, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const CROSSING = { x: 6, y: 5 };
const figureEight = (heights: readonly number[] = FIGURE_EIGHT_HEIGHTS, specials: Readonly<Record<number, 'loop' | 'boost'>> = {}): CoasterPiece[] =>
  layoutFromMoves({ x: 2, y: 5 }, FIGURE_EIGHT_MOVES, heights, specials);

const place = (world: GameWorld, pieces: CoasterPiece[], typeId = 'comet-trail') => {
  const type = COASTER_TYPE_BY_ID.get(typeId)!;
  return world.placeCoaster(typeId, pieces, deriveCoasterStats(pieces, type), coasterBaseCost(pieces, type));
};
const idOf = (result: ReturnType<typeof place>): number => {
  if ('error' in result) throw new Error(`placement refused: ${result.error}`);
  return result.id;
};

describe('Phase 38: layout validation', () => {
  it('a figure eight with a level 0 / level 2 crossing validates, and counts one crossing', () => {
    const pieces = figureEight();
    expect(pieces[4].cell).toEqual(CROSSING);
    expect(pieces[12].cell).toEqual(CROSSING);
    expect(validateCoasterLayout(pieces, COMET)).toEqual({ ok: true });
    expect(coasterCrossings(pieces)).toBe(1);
  });

  it('a level 0 / level 1 crossing is refused with the clearance message', () => {
    const heights = [0, 0, 0, 1, 1, 2, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    expect(validateCoasterLayout(figureEight(heights), COMET)).toEqual({ ok: false, reason: 'crossing-too-close', pieceIndex: 12 });
    expect(COASTER_VALIDATION_TEXT['crossing-too-close']).toContain(`${GAME_CONFIG.coaster.trackClearanceLevels} levels`);
  });

  it('a boost on the crossing keeps its cell to itself', () => {
    const pieces = figureEight(FIGURE_EIGHT_HEIGHTS, { 4: 'boost' });
    expect(isExclusiveCoasterPiece(pieces, 4)).toBe(true);
    expect(validateCoasterLayout(pieces, SERPENT)).toMatchObject({ ok: false, reason: 'crossing-not-allowed' });
  });

  it('a crossing adds the near-miss excitement bonus', () => {
    const pieces = figureEight();
    const withBonus = deriveCoasterStats(pieces, COMET).excitement;
    const crossing = GAME_CONFIG.coaster.crossing as { excitement: number };
    const saved = crossing.excitement;
    crossing.excitement = 0;
    try {
      expect(withBonus - deriveCoasterStats(pieces, COMET).excitement).toBeCloseTo(saved, 5);
    } finally {
      crossing.excitement = saved;
    }
    expect(coasterCrossings(ovalLayout()), 'a layout without a crossing takes the old expressions').toBe(0);
  });
});

describe('Phase 38: placement in the world', () => {
  it('the figure eight builds, and a path may run under its upper track but not its lower', () => {
    const world = new GameWorld(100_000);
    const id = idOf(place(world, figureEight()));
    expect(world.trackHeightsAt(CROSSING)).toEqual([0, 2]);
    expect(world.objectAt(CROSSING)?.id).toBe(id);
    expect(world.canPlacePath(CROSSING), 'level 0 track is there too').toBe(false);
    expect(world.canPlacePath({ x: 7, y: 5 }), 'only level 2 track over this cell').toBe(true);
  });

  it('a second coaster can cross the first at clearance, and not closer', () => {
    // The oval's bottom edge (y = 14, x 5..12) is level 0. The second coaster climbs north over it at x = 6, turns
    // east inside the oval at level 2 and comes back south over it at x = 10.
    const moves = `EEEE${'N'.repeat(6)}EEEE${'S'.repeat(7)}${'W'.repeat(9)}NE`;
    const high = [0, 0, 0, 1, ...Array<number>(14).fill(2), 1, ...Array<number>(13).fill(0)];
    const low = [0, 0, 0, ...Array<number>(6).fill(1), ...Array<number>(6).fill(2), 1, 1, 1, 1, ...Array<number>(13).fill(0)];
    const crossingHigh = layoutFromMoves({ x: 2, y: 18 }, moves, high);
    const crossingLow = layoutFromMoves({ x: 2, y: 18 }, moves, low);
    expect(crossingHigh[8].cell).toEqual({ x: 6, y: 14 });
    expect(crossingHigh[16].cell).toEqual({ x: 10, y: 14 });
    expect(validateCoasterLayout(crossingHigh, COMET)).toEqual({ ok: true });
    expect(validateCoasterLayout(crossingLow, COMET)).toEqual({ ok: true });

    const tooLow = new GameWorld(100_000);
    idOf(place(tooLow, ovalLayout({ x: 4, y: 10 })));
    expect(place(tooLow, crossingLow), 'level 1 over level 0 is too close').toEqual({ error: 'blocked' });
    expect(tooLow.coasterPieceConflict({ cell: { x: 6, y: 14 }, height: 1 })).toBe('track');

    const over = new GameWorld(100_000);
    const lower = idOf(place(over, ovalLayout({ x: 4, y: 10 })));
    const upper = idOf(place(over, crossingHigh));
    expect(over.trackHeightsAt({ x: 6, y: 14 })).toEqual([0, 2]);
    expect(over.trackHeightsAt({ x: 6, y: 14 }, upper)).toEqual([0]);
    expect(over.objectsAt({ x: 6, y: 14 }).map((object) => object.id)).toEqual([upper, lower]);
    // The bulldozer takes the upper track first, and the lower coaster stays.
    expect(over.objectAt({ x: 6, y: 14 })?.id).toBe(upper);
    expect(over.bulldoze({ x: 6, y: 14 }).removed).toBe(true);
    expect([...over.coasters.keys()]).toEqual([lower]);
    expect(over.trackHeightsAt({ x: 6, y: 14 })).toEqual([0]);
    expect(over.trackHeightsAt({ x: 6, y: 13 })).toEqual([]);
  });

  it('track may run over a bench and not over a stall; a bench cannot go under track that is too low', () => {
    const world = new GameWorld(100_000);
    expect(world.buildObject('ribbon-bench', { x: 7, y: 5 })).toBeTruthy();
    // Piece 5 runs over (7, 5) at level 2: the bench (clearance 1) fits under it.
    const id = idOf(place(world, figureEight()));
    expect(world.objectAt({ x: 7, y: 5 })?.definitionId, 'the ground occupant answers first').toBe('ribbon-bench');
    expect(world.objectsAt({ x: 7, y: 5 }).map((object) => object.id)).toContain(id);
    expect(world.hasSomethingUnder({ x: 7, y: 5 }, 2)).toBe(true);

    const stall = new GameWorld(100_000);
    const stallDefinition = 'picnic-pocket';
    expect(stall.buildObject(stallDefinition, { x: 7, y: 5 })).toBeTruthy();
    expect(place(stall, figureEight())).toEqual({ error: 'blocked' });

    const low = new GameWorld(100_000);
    idOf(place(low, figureEight()));
    // (5, 5) carries level 1 track: a bench needs level 2 above it.
    expect(low.checkObjectBuild('ribbon-bench', { x: 5, y: 5 })).toMatchObject({ ok: false, reason: 'blocked' });
    expect(low.checkObjectBuild('ribbon-bench', { x: 7, y: 5 }).ok).toBe(true);
    // A station piece is never crossed, even by a bench.
    expect(low.checkObjectBuild('ribbon-bench', { x: 2, y: 5 }).ok).toBe(false);
    // A tall lamp (clearance 3) does not fit under level 2.
    expect(low.checkObjectBuild('lollipop-lamp', { x: 7, y: 5 }).ok).toBe(false);
  });

  it('save and load round-trip a crossing coaster and a bench under track', () => {
    const world = new GameWorld(100_000);
    expect(world.buildObject('ribbon-bench', { x: 7, y: 5 })).toBeTruthy();
    idOf(place(world, figureEight()));
    const state = world.serialize();
    const restored = new GameWorld();
    restored.restore(structuredClone(state));
    expect(restored.trackHeightsAt(CROSSING)).toEqual([0, 2]);
    expect(restored.objectAt({ x: 7, y: 5 })?.definitionId).toBe('ribbon-bench');
    expect(restored.serialize()).toEqual(state);
  });

  it('a save whose crossing is too close is refused at load', () => {
    const world = new GameWorld(100_000);
    idOf(place(world, figureEight()));
    const state = structuredClone(world.serialize());
    // Lower the upper piece to level 1 (and its neighbour to keep the steps legal): now 1 level apart.
    const record = state.coasters[0];
    record.pieces[4].height = 1;
    expect(() => new GameWorld().restore(state)).toThrow();
  });
});
