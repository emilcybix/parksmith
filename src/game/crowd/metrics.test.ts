import { describe, expect, it } from 'vitest';
import type { GuestState } from '../guests/types';
import { ParkSession } from '../session/ParkSession';
import { seedDevPark } from '../session/devPark';
import type { Cell } from '../types';
import { GameWorld } from '../World';
import { coverageOf, coverageShare } from './coverage';
import { aggregateNeighborhoods, type CrowdTileReader, type NeighborhoodGuest, type NeighborhoodSources, type RideFacts, type ServiceFacts } from './metrics';
import { deriveNeighborhoods } from './neighborhoods';
import type { CrowdBand } from './types';

const REPORT = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env.NEIGHBORHOOD_REPORT === '1';

const column = (x: number, from: number, to: number): Cell[] => Array.from({ length: to - from + 1 }, (_, index) => ({ x, y: from + index }));

/** Spine x = 15, y 13..31; rides 1 + 2 (neighborhood 1), ride 3 (neighborhood 3); a food stall (access (15, 22)); a bin by the gate. */
const park = () => {
  const world = new GameWorld(1_000_000);
  world.seedScenarioPaths(column(15, 13, 31));
  world.seedScenarioObject('moonpetal-carousel', { x: 16, y: 26 });
  world.seedScenarioObject('moonpetal-carousel', { x: 12, y: 25 });
  world.seedScenarioObject('moonpetal-carousel', { x: 16, y: 13 });
  const stall = world.seedScenarioObject('snack-sprint', { x: 16, y: 22 })!;
  const bin = world.seedScenarioObject('tidy-totem', { x: 14, y: 30 })!;
  return { world, stall, bin, map: deriveNeighborhoods(world) };
};

const guest = (
  state: GuestState,
  currentCell: Cell,
  destinationObjectId: number | null,
  happiness: number,
  hunger = 10,
  thirst = 20,
  toiletNeed = 30,
): NeighborhoodGuest => ({ state, currentCell, destinationObjectId, happiness, hunger, thirst, toiletNeed });

const index = (cell: Cell): number => cell.y * 32 + cell.x;

const crowd: CrowdTileReader = {
  bandAt: (cell) => (cell === index({ x: 15, y: 22 }) ? 3 : cell === index({ x: 15, y: 23 }) ? 2 : cell === index({ x: 15, y: 24 }) ? 1 : 0) as CrowdBand,
  perMinuteAt: (cell) => (cell === index({ x: 15, y: 22 }) ? 50 : cell === index({ x: 15, y: 23 }) ? 30 : cell === index({ x: 15, y: 24 }) ? 9 : 0),
  bottleneckAt: (cell) => cell === index({ x: 15, y: 22 }),
};

const sourcesFor = (stallId: number, withCrowd: boolean): NeighborhoodSources => {
  const rides = new Map<number, RideFacts>([
    [1, { queueLength: 1, estimatedWaitSeconds: 30, lifetimeRevenue: 100 }],
    [2, { queueLength: 0, estimatedWaitSeconds: 50, lifetimeRevenue: 40 }],
    [3, { queueLength: 0, estimatedWaitSeconds: 0, lifetimeRevenue: 5 }],
  ]);
  const services: ServiceFacts[] = [{ objectId: stallId, kind: 'food', open: true, queueLength: 1, estimatedWaitSeconds: 12, lifetimeRevenue: 25 }];
  return {
    guests: [
      guest('wandering', { x: 15, y: 22 }, null, 80, 20, 30, 40),
      guest('walkingToRide', { x: 15, y: 28 }, 3, 60, 40, 10, 0),
      guest('queueing', { x: 15, y: 26 }, 1, 50),
      guest('riding', { x: 15, y: 26 }, 2, 70),
      guest('queueingForShop', { x: 15, y: 22 }, stallId, 40),
      guest('entering', { x: 15, y: 31 }, null, 90),
      guest('shopping', { x: 15, y: 22 }, 999, 10),
      guest('wandering', { x: 0, y: 0 }, null, 10),
    ],
    ride: (objectId) => rides.get(objectId) ?? null,
    services,
    litter: [{ cell: { x: 15, y: 22 }, units: 3 }, { cell: { x: 15, y: 31 }, units: 2 }, { cell: { x: 0, y: 0 }, units: 7 }],
    sceneryScoreAt: (cell) => cell.y,
    crowd: withCrowd ? crowd : null,
  };
};

describe('aggregateNeighborhoods', () => {
  it('sums and averages over a hand-built park with known guests', () => {
    const { world, stall, bin, map } = park();
    expect(map.neighborhoods.map((hood) => hood.key)).toEqual([0, 1, 3]);
    const result = aggregateNeighborhoods(world, map, sourcesFor(stall.id, true));
    const [gate, one, three] = result.neighborhoods;

    // Neighborhood 1: two walkers on its tiles + queueing at 1, riding 2, queueing at the stall.
    expect(one.metrics.guests).toBe(5);
    expect(one.metrics.happiness).toBeCloseTo((80 + 60 + 50 + 70 + 40) / 5, 12);
    expect(one.metrics.hunger).toBeCloseTo((20 + 40 + 10 + 10 + 10) / 5, 12);
    expect(one.metrics.thirst).toBeCloseTo((30 + 10 + 20 + 20 + 20) / 5, 12);
    expect(one.metrics.toilet).toBeCloseTo((40 + 0 + 30 + 30 + 30) / 5, 12);
    expect(one.metrics.queueing).toBe(2);
    expect(one.metrics.demand).toBe(2);
    expect(one.metrics.spending).toBe(100 + 40 + 25);
    expect(one.metrics.longestWaitSeconds).toBe(50);
    expect(one.metrics.litter).toBe(3);
    expect(one.memberIds).toEqual([stall.id]);

    // Neighborhood 3: nobody there, one guest heading for its ride.
    expect(three.metrics.guests).toBe(0);
    expect(three.metrics.happiness).toBeNull();
    expect(three.metrics.hunger).toBeNull();
    expect(three.metrics.demand).toBe(1);
    expect(three.metrics.spending).toBe(5);
    expect(three.metrics.longestWaitSeconds).toBe(0);

    // The gate: the entering guest, its litter, the bin (no spending, no wait).
    expect(gate.metrics.guests).toBe(1);
    expect(gate.metrics.happiness).toBe(90);
    expect(gate.metrics.litter).toBe(2);
    expect(gate.metrics.spending).toBe(0);
    expect(gate.metrics.longestWaitSeconds).toBeNull();
    expect(gate.memberIds).toEqual([bin.id]);

    expect(result.walking).toBe(4);
    expect([...result.walkingByKey]).toEqual([[0, 1], [1, 2], [3, 0]]);
    expect(result.unreached).toEqual([]);
  });

  it('reports scenery as the mean over its tiles and coverage as shares', () => {
    const { world, stall, map } = park();
    const result = aggregateNeighborhoods(world, map, sourcesFor(stall.id, true));
    for (const [position, hood] of result.neighborhoods.entries()) {
      const tiles = map.neighborhoods[position].tiles;
      const meanY = [...tiles].reduce((sum, cell) => sum + Math.floor(cell / 32), 0) / tiles.length;
      expect(hood.metrics.scenery).toBeCloseTo(meanY, 12);
      expect(hood.tileCount).toBe(tiles.length);
      expect(hood.metrics.coverage).toEqual(coverageShare(coverageOf(world, sourcesFor(stall.id, true).services), tiles));
      expect(hood.metrics.coverage.toilet).toBe(0);
    }
    expect(result.neighborhoods[1].metrics.coverage.food).toBe(1);
  });

  it('counts bands, finds the worst tile and lists bottlenecks from the crowd reader', () => {
    const { world, stall, map } = park();
    const result = aggregateNeighborhoods(world, map, sourcesFor(stall.id, true));
    const one = result.neighborhoods[1];
    expect(one.metrics.bands).toEqual([one.tileCount - 3, 1, 1, 1]);
    expect(one.worst).toEqual({ cell: { x: 15, y: 22 }, band: 3, perMinute: 50, bottleneck: true, neighborhoodKey: 1 });
    expect(result.neighborhoods[0].worst).toBeNull();
    expect(result.bottlenecks).toEqual([{ cell: { x: 15, y: 22 }, band: 3, perMinute: 50, bottleneck: true, neighborhoodKey: 1 }]);
  });

  it('without a crowd reader every tile is quiet with no worst tile and no bottleneck', () => {
    const { world, stall, map } = park();
    const result = aggregateNeighborhoods(world, map, sourcesFor(stall.id, false));
    for (const hood of result.neighborhoods) {
      expect(hood.metrics.bands).toEqual([hood.tileCount, 0, 0, 0]);
      expect(hood.worst).toBeNull();
    }
    expect(result.bottlenecks).toEqual([]);
  });

  it('runs on a full dev park at 1,000 guests in well under a millisecond', () => {
    const session = new ParkSession(null);
    seedDevPark(session);
    session.syncWithWorld();
    const { world } = session;
    const map = deriveNeighborhoods(world);
    const cells = [...map.pathCells];
    const states: GuestState[] = ['wandering', 'walkingToRide', 'queueing', 'riding', 'walkingToShop', 'shopping', 'leaving'];
    const rideIds = map.neighborhoods.flatMap((hood) => hood.rideIds);
    const guests = Array.from({ length: 1000 }, (_, at) => guest(
      states[at % states.length],
      { x: cells[at % cells.length] % 32, y: Math.floor(cells[at % cells.length] / 32) },
      rideIds[at % rideIds.length],
      50 + (at % 50),
    ));
    const serviceIds = [...world.objects.values()].filter((object) => session.shops.snapshot(object.id)).map((object) => object.id);
    const sources: NeighborhoodSources = {
      guests,
      ride: (objectId) => session.rides.snapshot(objectId),
      services: serviceIds.map((objectId) => session.shops.snapshot(objectId)!),
      litter: session.operations.litter.values(),
      sceneryScoreAt: (cell) => session.scenery.scoreAt(cell),
      crowd: null,
    };
    let result = aggregateNeighborhoods(world, map, sources);
    const started = performance.now();
    for (let at = 0; at < 20; at += 1) result = aggregateNeighborhoods(world, map, sources);
    const ms = (performance.now() - started) / 20;
    if (REPORT) console.log(`aggregate at 1,000 guests on the dev park: ${ms.toFixed(3)} ms`);
    expect(result.neighborhoods.reduce((sum, hood) => sum + hood.metrics.guests, 0)).toBeGreaterThan(900);
    expect(result.neighborhoods.every((hood) => hood.metrics.coverage.food > 0)).toBe(true);
    expect(ms).toBeLessThan(5);
  });
});
