/**
 * Phase 14 (design Q4, metric table): per-neighborhood metrics as one pass over guests, one over litter and one over
 * the territory tiles. Pure: everything is read through `NeighborhoodSources`, a small structural view the session
 * fills from its owners (no import of `session/`). Spending is read from the ride/service snapshots, never recomputed.
 * Presentation only, never saved.
 */
import type { Guest, GuestState } from '../guests/types';
import type { Cell } from '../types';
import { coverageOf, coverageShare, type CoverageWorld, type ServiceOpenState } from './coverage';
import type { NeighborhoodMap } from './neighborhoods';
import type { CrowdBand, CrowdTile, NeighborhoodMetrics, NeighborhoodView } from './types';

export type NeighborhoodGuest = Readonly<
  Pick<Guest, 'state' | 'currentCell' | 'destinationObjectId' | 'happiness' | 'hunger' | 'thirst' | 'toiletNeed'>
>;

/** A ride as the owner reports it (a `RideSnapshot` satisfies it). */
export interface RideFacts {
  readonly queueLength: number;
  readonly estimatedWaitSeconds: number;
  readonly lifetimeRevenue: number;
}

/** A service as the owner reports it (a `ServiceSnapshot` satisfies it). */
export interface ServiceFacts extends ServiceOpenState, RideFacts {}

/** The displayed crowd state of a path cell (`y * width + x`); the session wires it to the field and the bands. */
export interface CrowdTileReader {
  bandAt(cell: number): CrowdBand;
  perMinuteAt(cell: number): number;
  bottleneckAt(cell: number): boolean;
}

/** Read-only owner views (design Q4); `crowd` absent or null = every tile quiet with no flow. */
export interface NeighborhoodSources {
  readonly guests: Iterable<NeighborhoodGuest>;
  ride(objectId: number): RideFacts | null;
  /** Every service in the park (members and the coverage sources). */
  readonly services: Iterable<ServiceFacts>;
  readonly litter: Iterable<{ readonly cell: Readonly<Cell>; readonly units: number }>;
  sceneryScoreAt(cell: Readonly<Cell>): number;
  readonly crowd?: CrowdTileReader | null;
}

export interface NeighborhoodAggregate {
  /** Same order as the map: gate first, then key ascending. */
  readonly neighborhoods: NeighborhoodView[];
  /** Every bottleneck path tile, ascending cell. */
  readonly bottlenecks: CrowdTile[];
  /** Guests in a walking state anywhere in the park. */
  readonly walking: number;
  /** Walking guests on each neighborhood's tiles (key -> count; every key present). */
  readonly walkingByKey: ReadonlyMap<number, number>;
  readonly unreached: readonly number[];
}

/** States in which a guest is on a path tile and counted by where it stands. */
export const WALKING_STATES: ReadonlySet<GuestState> = new Set<GuestState>(['entering', 'wandering', 'walkingToRide', 'walkingToShop', 'leaving']);
/** States in which a guest is counted by its destination (queueing at, riding or using a member). */
const AT_MEMBER_STATES: ReadonlySet<GuestState> = new Set<GuestState>(['queueing', 'riding', 'queueingForShop', 'shopping', 'usingFacility']);
const QUEUE_STATES: ReadonlySet<GuestState> = new Set<GuestState>(['queueing', 'queueingForShop']);
const HEADING_STATES: ReadonlySet<GuestState> = new Set<GuestState>(['walkingToRide', 'walkingToShop']);

interface Accumulator {
  guests: number;
  walking: number;
  happiness: number;
  hunger: number;
  thirst: number;
  toilet: number;
  queueing: number;
  demand: number;
  litter: number;
}

const mean = (sum: number, count: number): number | null => (count > 0 ? sum / count : null);

export const aggregateNeighborhoods = (
  world: CoverageWorld,
  map: NeighborhoodMap,
  sources: NeighborhoodSources,
): NeighborhoodAggregate => {
  const { width, height, territory } = map;
  const indexByKey = new Map<number, number>();
  map.neighborhoods.forEach((neighborhood, index) => indexByKey.set(neighborhood.key, index));
  const totals: Accumulator[] = map.neighborhoods.map(() => ({
    guests: 0, walking: 0, happiness: 0, hunger: 0, thirst: 0, toilet: 0, queueing: 0, demand: 0, litter: 0,
  }));
  const territoryIndexAt = (cell: Readonly<Cell>): number => {
    if (cell.x < 0 || cell.y < 0 || cell.x >= width || cell.y >= height) return -1;
    const key = territory[cell.y * width + cell.x];
    return key < 0 ? -1 : (indexByKey.get(key) ?? -1);
  };
  const memberIndexOf = (objectId: number | null): number => {
    if (objectId === null) return -1;
    const key = map.memberOf.get(objectId);
    return key === undefined ? -1 : (indexByKey.get(key) ?? -1);
  };

  let walking = 0;
  for (const guest of sources.guests) {
    let index = -1;
    if (WALKING_STATES.has(guest.state)) {
      walking += 1;
      index = territoryIndexAt(guest.currentCell);
      if (index >= 0) totals[index].walking += 1;
      if (HEADING_STATES.has(guest.state)) {
        const target = memberIndexOf(guest.destinationObjectId);
        if (target >= 0) totals[target].demand += 1;
      }
    } else if (AT_MEMBER_STATES.has(guest.state)) {
      index = memberIndexOf(guest.destinationObjectId);
      if (index >= 0 && QUEUE_STATES.has(guest.state)) {
        totals[index].queueing += 1;
        totals[index].demand += 1;
      }
    }
    if (index < 0) continue;
    const total = totals[index];
    total.guests += 1;
    total.happiness += guest.happiness;
    total.hunger += guest.hunger;
    total.thirst += guest.thirst;
    total.toilet += guest.toiletNeed;
  }

  for (const pile of sources.litter) {
    const index = territoryIndexAt(pile.cell);
    if (index >= 0) totals[index].litter += pile.units;
  }

  const services = [...sources.services];
  const serviceById = new Map<number, ServiceFacts>();
  for (const service of services) serviceById.set(service.objectId, service);
  const coverage = coverageOf(world, services);
  const crowd = sources.crowd ?? null;

  const neighborhoods: NeighborhoodView[] = map.neighborhoods.map((neighborhood, index) => {
    const total = totals[index];
    let spending = 0;
    let longestWaitSeconds: number | null = null;
    const consider = (facts: RideFacts | null | undefined): void => {
      if (!facts) return;
      spending += facts.lifetimeRevenue;
      longestWaitSeconds = longestWaitSeconds === null ? facts.estimatedWaitSeconds : Math.max(longestWaitSeconds, facts.estimatedWaitSeconds);
    };
    for (const rideId of neighborhood.rideIds) consider(sources.ride(rideId));
    for (const memberId of neighborhood.memberIds) consider(serviceById.get(memberId));

    let scenery = 0;
    const bands: [number, number, number, number] = [0, 0, 0, 0];
    let worst: CrowdTile | null = null;
    let worstBand = -1;
    let worstFlow = 0;
    for (const cell of neighborhood.tiles) {
      const cellPoint = { x: cell % width, y: Math.floor(cell / width) };
      scenery += sources.sceneryScoreAt(cellPoint);
      const band = crowd ? crowd.bandAt(cell) : 0;
      bands[band] += 1;
      const perMinute = crowd ? crowd.perMinuteAt(cell) : 0;
      if (perMinute > 0 && (band > worstBand || (band === worstBand && perMinute > worstFlow))) {
        worstBand = band;
        worstFlow = perMinute;
        worst = { cell: cellPoint, band, perMinute, bottleneck: crowd!.bottleneckAt(cell), neighborhoodKey: neighborhood.key };
      }
    }
    const metrics: NeighborhoodMetrics = {
      guests: total.guests,
      happiness: mean(total.happiness, total.guests),
      hunger: mean(total.hunger, total.guests),
      thirst: mean(total.thirst, total.guests),
      toilet: mean(total.toilet, total.guests),
      spending,
      litter: total.litter,
      scenery: neighborhood.tiles.length > 0 ? scenery / neighborhood.tiles.length : 0,
      queueing: total.queueing,
      longestWaitSeconds,
      demand: total.demand,
      coverage: coverageShare(coverage, neighborhood.tiles),
      bands,
    };
    return {
      key: neighborhood.key,
      name: neighborhood.name,
      sector: neighborhood.sector,
      rideIds: [...neighborhood.rideIds],
      memberIds: [...neighborhood.memberIds],
      tileCount: neighborhood.tiles.length,
      focus: { x: neighborhood.focus.x, y: neighborhood.focus.y },
      metrics,
      worst,
    };
  });

  const bottlenecks: CrowdTile[] = [];
  if (crowd) {
    for (const cell of map.pathCells) {
      if (!crowd.bottleneckAt(cell)) continue;
      const key = territory[cell];
      bottlenecks.push({
        cell: { x: cell % width, y: Math.floor(cell / width) },
        band: crowd.bandAt(cell),
        perMinute: crowd.perMinuteAt(cell),
        bottleneck: true,
        neighborhoodKey: key < 0 ? null : key,
      });
    }
  }

  const walkingByKey = new Map<number, number>();
  map.neighborhoods.forEach((neighborhood, index) => walkingByKey.set(neighborhood.key, totals[index].walking));
  return { neighborhoods, bottlenecks, walking, walkingByKey, unreached: map.unreached };
};
