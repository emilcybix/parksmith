import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from './content/catalog';
import { GAME_CONFIG } from './config';
import { SimulationClock } from './SimulationClock';
import { GameWorld } from './World';

describe('GameWorld construction', () => {
  it('deducts exactly once for unique valid path cells', () => {
    const world = new GameWorld();
    const result = world.buildPaths([{ x: 1, y: 1 }, { x: 1, y: 1 }, { x: 2, y: 1 }]);
    expect(result).toEqual({
      built: 2,
      spent: GAME_CONFIG.pathCost * 2,
      // The report has to be the deduped accepted list: it is what the path gesture's label counts.
      added: [{ x: 1, y: 1 }, { x: 2, y: 1 }],
    });
    expect(world.cash).toBe(GAME_CONFIG.startingCash - GAME_CONFIG.pathCost * 2);
  });

  it('does not charge again for an existing path cell', () => {
    const world = new GameWorld();
    world.buildPaths([{ x: 2, y: 2 }]);
    const cashAfterFirstBuild = world.cash;
    expect(world.buildPaths([{ x: 2, y: 2 }])).toEqual({ built: 0, spent: 0, added: [] });
    expect(world.cash).toBe(cashAfterFirstBuild);
  });

  it('rejects overlapping footprints and protects the entrance', () => {
    const world = new GameWorld();
    const ride = BUILD_BY_ID.get('petal-roundabout')!;
    expect(world.buildObject(ride.id, { x: 3, y: 3 })).not.toBeNull();
    expect(world.canPlace(ride, { x: 4, y: 4 })).toBe(false);
    expect(world.bulldoze(world.entrance).removed).toBe(false);
  });

  it('refunds a configured fraction when bulldozing', () => {
    const world = new GameWorld();
    const definition = BUILD_BY_ID.get('picnic-pocket')!;
    world.buildObject(definition.id, { x: 5, y: 5 });
    const before = world.cash;
    const result = world.bulldoze({ x: 5, y: 5 });
    expect(result.refund).toBe(Math.floor(definition.buildCost * GAME_CONFIG.bulldozeRefundRate));
    expect(world.cash).toBe(before + result.refund);
  });

  it('allows every catalog definition when no build access policy is installed', () => {
    const world = new GameWorld();
    expect(world.checkObjectBuild('comet-cups', { x: 4, y: 4 }).ok).toBe(true);
    expect(world.buildObject('comet-cups', { x: 4, y: 4 })).not.toBeNull();
  });

  it('enforces build access in the world and reports why an object cannot be built', () => {
    const world = new GameWorld();
    world.setBuildAccessPolicy({ isUnlocked: (definitionId) => definitionId !== 'comet-cups' });

    expect(world.checkObjectBuild('missing-definition', { x: 1, y: 1 })).toEqual({ ok: false, reason: 'unknown' });
    expect(world.checkObjectBuild('sunstone-path', { x: 1, y: 1 })).toEqual({ ok: false, reason: 'path' });
    expect(world.checkObjectBuild('comet-cups', { x: 4, y: 4 })).toEqual({ ok: false, reason: 'locked' });
    expect(world.buildObject('comet-cups', { x: 4, y: 4 })).toBeNull();

    const built = world.buildObject('petal-roundabout', { x: 8, y: 8 });
    expect(built).not.toBeNull();
    expect(world.checkObjectBuild('petal-roundabout', { x: 9, y: 9 })).toEqual({ ok: false, reason: 'blocked' });

    world.cash = 0;
    expect(world.checkObjectBuild('picnic-pocket', { x: 15, y: 15 })).toEqual({ ok: false, reason: 'funds' });
  });

  it('rotates a footprint by swapping width and depth', () => {
    const world = new GameWorld();
    const coach = BUILD_BY_ID.get('bumble-coach')!;

    expect(world.footprintCells(coach, { x: 5, y: 5 }, 0)).toHaveLength(8);
    expect(world.footprintCells(coach, { x: 5, y: 5 }, 0).map((cell) => `${cell.x},${cell.y}`))
      .toEqual(['5,5', '6,5', '7,5', '8,5', '5,6', '6,6', '7,6', '8,6']);
    expect(world.footprintCells(coach, { x: 5, y: 5 }, 1).map((cell) => `${cell.x},${cell.y}`))
      .toEqual(['5,5', '6,5', '5,6', '6,6', '5,7', '6,7', '5,8', '6,8']);
    // Two quarter turns land back on the original orientation.
    expect(world.footprintCells(coach, { x: 5, y: 5 }, 2))
      .toEqual(world.footprintCells(coach, { x: 5, y: 5 }, 0));
  });

  it('places, occupies, and clears a rotated building through its own orientation', () => {
    const world = new GameWorld();
    // A 4x2 coach turned upright fits a 2-wide gap that the unrotated one cannot.
    world.buildObject('petal-roundabout', { x: 8, y: 5 });
    expect(world.canPlace(BUILD_BY_ID.get('bumble-coach')!, { x: 6, y: 5 }, 0)).toBe(false);
    expect(world.canPlace(BUILD_BY_ID.get('bumble-coach')!, { x: 6, y: 5 }, 1)).toBe(true);

    const placed = world.buildObject('bumble-coach', { x: 6, y: 5 }, 1);
    expect(placed?.rotation).toBe(1);
    expect(world.objectFootprint(placed!)).toHaveLength(8);
    expect(world.objectAt({ x: 6, y: 8 })?.id).toBe(placed!.id);
    expect(world.objectAt({ x: 8, y: 6 })?.id).not.toBe(placed!.id);

    world.bulldoze({ x: 6, y: 8 });
    expect(world.objects.has(placed!.id)).toBe(false);
    expect(world.objectAt({ x: 6, y: 5 })).toBeUndefined();
  });

  it('reports a blocked rotated footprint before charging for it', () => {
    const world = new GameWorld();
    world.buildObject('petal-roundabout', { x: 5, y: 8 });
    const cashBefore = world.cash;
    expect(world.checkObjectBuild('bumble-coach', { x: 6, y: 6 }, 1)).toEqual({ ok: false, reason: 'blocked' });
    expect(world.buildObject('bumble-coach', { x: 6, y: 6 }, 1)).toBeNull();
    expect(world.cash).toBe(cashBefore);
  });
});

describe('SimulationClock', () => {
  it('advances by deterministic fixed steps at each speed', () => {
    let steps = 0;
    const clock = new SimulationClock(() => { steps += 1; });
    clock.update(100);
    clock.setSpeed(4);
    clock.update(100);
    expect(steps).toBe(5);
    expect(clock.simulationTimeMs).toBe(500);
  });

  it('does not advance while paused', () => {
    const clock = new SimulationClock(() => { throw new Error('should not step'); });
    clock.setSpeed(0);
    expect(clock.update(500)).toBe(0);
  });
});
