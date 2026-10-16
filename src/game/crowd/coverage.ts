/**
 * Phase 14 (design Q4): service coverage. A path tile is covered for a kind (food, drink, toilet) when it lies within
 * `reachSteps` path steps of an access tile of an OPEN service of that kind anywhere in the park. One multi-source BFS
 * per kind over the path tiles, cached per world, path version and the open-service signature. Presentation only.
 */
import { BUILD_BY_ID } from '../content/catalog';
import { GAME_CONFIG } from '../config';
import type { ServiceKind as AnyServiceKind } from '../shops/types';

/** The needs coverage measures (Phase 29 souvenir stalls meet no need, so they are not coverage). */
type ServiceKind = Exclude<AnyServiceKind, 'souvenir'>;
import type { Cell, PlacedObject } from '../types';

export const SERVICE_KINDS: readonly ServiceKind[] = Object.freeze(['food', 'drink', 'toilet']);

/** What coverage reads from a world (a `GameWorld` satisfies it). */
export interface CoverageWorld {
  readonly width: number;
  readonly height: number;
  readonly paths: ReadonlySet<string>;
  readonly objects: ReadonlyMap<number, PlacedObject>;
  readonly pathVersion: number;
  objectFootprint(object: PlacedObject): Cell[];
}

/** One service as the owner reports it (a `ServiceSnapshot` satisfies it). */
export interface ServiceOpenState {
  readonly objectId: number;
  readonly kind: AnyServiceKind;
  readonly open: boolean;
}

export interface Coverage {
  readonly pathVersion: number;
  readonly reachSteps: number;
  /** Per cell (`y * width + x`): 1 when a path tile is within reach of an open service of that kind. */
  readonly covered: Readonly<Record<ServiceKind, Uint8Array>>;
  /** Open services of that kind with path access (anywhere in the park). */
  readonly openServices: Readonly<Record<ServiceKind, number>>;
}

const FAR = 0x3fffffff;

const signatureOf = (world: CoverageWorld, services: readonly ServiceOpenState[]): string => services
  .filter((service) => service.open && world.objects.has(service.objectId))
  .map((service) => {
    const object = world.objects.get(service.objectId)!;
    return `${service.objectId}:${service.kind}:${object.anchor.x},${object.anchor.y},${object.rotation}`;
  })
  .sort()
  .join('|');

/** Pure, uncached computation. */
export const computeCoverage = (
  world: CoverageWorld,
  services: Iterable<ServiceOpenState>,
  reachSteps: number = GAME_CONFIG.crowd.neighborhood.reachSteps,
): Coverage => {
  const { width, height } = world;
  const size = width * height;
  const isPath = new Uint8Array(size);
  for (const key of world.paths) {
    const comma = key.indexOf(',');
    const x = Number(key.slice(0, comma));
    const y = Number(key.slice(comma + 1));
    if (x >= 0 && y >= 0 && x < width && y < height) isPath[y * width + x] = 1;
  }
  const seeds: Record<ServiceKind, number[]> = { food: [], drink: [], toilet: [] };
  const openServices: Record<ServiceKind, number> = { food: 0, drink: 0, toilet: 0 };
  const ordered = [...services].sort((left, right) => left.objectId - right.objectId);
  for (const service of ordered) {
    if (!service.open || service.kind === 'souvenir') continue;
    const object = world.objects.get(service.objectId);
    if (!object || !BUILD_BY_ID.has(object.definitionId)) continue;
    const footprint = world.objectFootprint(object);
    const under = new Set(footprint.map((cell) => cell.y * width + cell.x));
    let accessible = false;
    for (const cell of footprint) {
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const x = cell.x + dx;
        const y = cell.y + dy;
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const index = y * width + x;
        if (!isPath[index] || under.has(index)) continue;
        seeds[service.kind].push(index);
        accessible = true;
      }
    }
    if (accessible) openServices[service.kind] += 1;
  }
  const covered = {} as Record<ServiceKind, Uint8Array>;
  const distance = new Int32Array(size);
  const queue = new Int32Array(size);
  for (const kind of SERVICE_KINDS) {
    const field = new Uint8Array(size);
    distance.fill(FAR);
    let head = 0;
    let tail = 0;
    for (const cell of seeds[kind]) {
      if (distance[cell] === 0) continue;
      distance[cell] = 0;
      field[cell] = 1;
      queue[tail++] = cell;
    }
    while (head < tail) {
      const cell = queue[head++];
      const next = distance[cell] + 1;
      if (next > reachSteps) continue;
      const x = cell % width;
      const y = (cell - x) / width;
      const visit = (neighbour: number): void => {
        if (!isPath[neighbour] || distance[neighbour] <= next) return;
        distance[neighbour] = next;
        field[neighbour] = 1;
        queue[tail++] = neighbour;
      };
      if (x > 0) visit(cell - 1);
      if (x < width - 1) visit(cell + 1);
      if (y > 0) visit(cell - width);
      if (y < height - 1) visit(cell + width);
    }
    covered[kind] = field;
  }
  return { pathVersion: world.pathVersion, reachSteps, covered, openServices };
};

interface CacheEntry {
  readonly pathVersion: number;
  readonly paths: number;
  readonly signature: string;
  readonly reachSteps: number;
  readonly coverage: Coverage;
}

const cache = new WeakMap<object, CacheEntry>();

/** `computeCoverage` memoised per world, path version (+ path count) and open-service signature. */
export const coverageOf = (
  world: CoverageWorld,
  services: Iterable<ServiceOpenState>,
  reachSteps: number = GAME_CONFIG.crowd.neighborhood.reachSteps,
): Coverage => {
  const list = [...services];
  const signature = signatureOf(world, list);
  const entry = cache.get(world);
  if (
    entry
    && entry.pathVersion === world.pathVersion
    && entry.paths === world.paths.size
    && entry.signature === signature
    && entry.reachSteps === reachSteps
  ) return entry.coverage;
  const coverage = computeCoverage(world, list, reachSteps);
  cache.set(world, { pathVersion: world.pathVersion, paths: world.paths.size, signature, reachSteps, coverage });
  return coverage;
};

/** Forget the cached coverage (after an in-place restore). */
export const invalidateCoverage = (world: CoverageWorld): void => {
  cache.delete(world);
};

/** Share (0..1) of `tiles` covered per kind; 0 for an empty tile list. */
export const coverageShare = (coverage: Coverage, tiles: ArrayLike<number>): { food: number; drink: number; toilet: number } => {
  if (tiles.length === 0) return { food: 0, drink: 0, toilet: 0 };
  let food = 0;
  let drink = 0;
  let toilet = 0;
  for (let index = 0; index < tiles.length; index += 1) {
    const cell = tiles[index];
    food += coverage.covered.food[cell];
    drink += coverage.covered.drink[cell];
    toilet += coverage.covered.toilet[cell];
  }
  return { food: food / tiles.length, drink: drink / tiles.length, toilet: toilet / tiles.length };
};
