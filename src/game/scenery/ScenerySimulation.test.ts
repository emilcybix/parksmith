import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from '../content/catalog';
import { GameWorld } from '../World';
import { ScenerySimulation } from './ScenerySimulation';

describe('ScenerySimulation', () => {
  it('uses cached Manhattan falloff and leaves the cache unchanged between world changes', () => {
    const world = new GameWorld();
    const lamp = world.buildObject('lollipop-lamp', { x: 10, y: 10 });
    if (!lamp) throw new Error('Lamp should be placeable');
    const definition = BUILD_BY_ID.get(lamp.definitionId)!;
    const appeal = definition.stats?.sceneryAppeal ?? 0;
    const radius = definition.stats?.sceneryRadius ?? 0;
    const scenery = new ScenerySimulation(world);

    expect(scenery.scoreAt({ x: 10, y: 10 })).toBe(appeal);
    expect(scenery.scoreAt({ x: 11, y: 10 })).toBeCloseTo(appeal * radius / (radius + 1));
    expect(scenery.scoreAt({ x: 10 + radius, y: 10 })).toBeCloseTo(appeal / (radius + 1));
    expect(scenery.scoreAt({ x: 11 + radius, y: 10 })).toBe(0);

    const first = scenery.snapshot();
    const second = scenery.snapshot();
    expect(second.version).toBe(first.version);
    expect(second.sources).toEqual([{
      objectId: lamp.id,
      definitionId: lamp.definitionId,
      appeal,
      radius,
      influencedCells: first.sources[0].influencedCells,
    }]);
    expect(second.influencedCells).toBeGreaterThan(0);
  });

  it('stacks and caps overlapping influence, then subtracts a removed source', () => {
    const world = new GameWorld();
    const anchors = [
      { x: 12, y: 13 },
      { x: 16, y: 13 },
      { x: 14, y: 16 },
      { x: 14, y: 11 },
      { x: 11, y: 15 },
    ];
    const fountains = anchors.map((anchor) => world.buildObject('ripple-fountain', anchor));
    if (fountains.some((fountain) => !fountain)) throw new Error('Fountains should be placeable');
    const scenery = new ScenerySimulation(world);

    expect(scenery.scoreAt({ x: 15, y: 15 })).toBe(100);
    const versionBeforeRemoval = scenery.snapshot().version;
    world.bulldoze(anchors[0]);

    expect(scenery.scoreAt({ x: 15, y: 15 })).toBeLessThan(100);
    expect(scenery.scoreAt({ x: 15, y: 15 })).toBeGreaterThan(0);
    expect(scenery.snapshot().sourceCount).toBe(4);
    expect(scenery.snapshot().version).toBeGreaterThan(versionBeforeRemoval);
  });

  it('scores park appeal from entrance-connected paths and reachable destinations only', () => {
    const world = new GameWorld();
    world.buildPaths([
      { x: 15, y: 30 },
      { x: 15, y: 29 },
      { x: 15, y: 28 },
      { x: 15, y: 27 },
      { x: 5, y: 2 },
      { x: 5, y: 3 },
    ]);
    const reachableRide = world.buildObject('petal-roundabout', { x: 12, y: 27 });
    const disconnectedRide = world.buildObject('petal-roundabout', { x: 2, y: 2 });
    const disconnectedTree = world.buildObject('confetti-tree', { x: 1, y: 2 });
    if (!reachableRide || !disconnectedRide || !disconnectedTree) throw new Error('Test objects should be placeable');
    const scenery = new ScenerySimulation(world);
    const snapshot = scenery.snapshot();

    expect(scenery.scoreForObject(disconnectedRide.id)).toBeGreaterThan(0);
    expect(snapshot.destinations.map((destination) => destination.objectId)).toEqual([reachableRide.id]);
    expect(snapshot.destinations[0].score).toBe(0);
    expect(snapshot.averageDestinationScore).toBe(0);
    expect(snapshot.parkScore).toBe(0);
    expect(snapshot.connectedPathTiles).toBe(5);
    expect(snapshot.decoratedPathTiles).toBe(0);
  });

  it('reports connected path coverage and switches to destination appeal once a ride is reachable', () => {
    const world = new GameWorld();
    world.buildPaths([
      { x: 15, y: 30 },
      { x: 15, y: 29 },
      { x: 15, y: 28 },
      { x: 15, y: 27 },
    ]);
    const lamp = world.buildObject('lollipop-lamp', { x: 14, y: 29 });
    if (!lamp) throw new Error('Lamp should be placeable');
    const scenery = new ScenerySimulation(world);
    const pathsOnly = scenery.snapshot();

    expect(pathsOnly.decoratedPathTiles).toBeGreaterThan(0);
    expect(pathsOnly.coveragePercent).toBeGreaterThan(0);
    expect(pathsOnly.parkScore).toBe(pathsOnly.averagePathScore);

    const ride = world.buildObject('petal-roundabout', { x: 12, y: 26 });
    if (!ride) throw new Error('Ride should be placeable');
    const withRide = scenery.snapshot();
    expect(withRide.destinations).toHaveLength(1);
    expect(withRide.destinations[0].objectId).toBe(ride.id);
    expect(withRide.parkScore).toBe(withRide.averageDestinationScore);
  });
});
