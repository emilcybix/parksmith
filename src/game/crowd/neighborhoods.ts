/**
 * Phase 14 (design Q3): neighborhoods derived from the park, never saved, never player-authored.
 *
 * 1. Attraction clusters: rides with at least one adjacent path tile, in ascending object id. A ride joins the
 *    cluster whose LEADER (its first ride) centre is nearest within Chebyshev `leaderRadius` and shares a path
 *    component with it (ties: lower key); otherwise it leads a new cluster. Candidate leaders come from grid buckets.
 *    A newer ride never changes an older ride's cluster.
 * 2. Territory: a layered multi-source BFS over path tiles from every cluster's access tiles, plus the gate (key 0)
 *    which reaches only `gateSteps`. A tile goes to the nearest source, ties to the lower key (the gate's limit never
 *    blocks a cluster's wave). Paths with no ride in their component (beyond the gate's reach) belong to no
 *    neighborhood.
 * 3. Members: services, bins and benches by the territory of their access path tile (lowest cell index among the
 *    assigned ones); scenery by the nearest territory tile to its footprint (grid distance, ties lower cell index).
 * 4. Identity: key = the leader ride's object id (gate 0); order gate first, then key ascending. Names from
 *    `names.ts` (the leader's anchor and the biome), sector from the territory centroid.
 *
 * The gate neighborhood exists only while at least one ride cluster does (an empty park has no neighborhoods).
 * Cached per world (identity) and `version` (+ `pathVersion` and the object/path counts as a guard, since a restored
 * world carries its saved version verbatim); `invalidateNeighborhoods(world)` drops the cache after a restore.
 */
import { BUILD_BY_ID } from '../content/catalog';
import { GAME_CONFIG } from '../config';
import type { Cell, PlacedObject } from '../types';
import { assignNames, gateNameOf, sectorOf } from './names';
import type { SectorWord } from './types';

/** What derivation reads from a world (a `GameWorld` satisfies it). */
export interface NeighborhoodWorld {
  readonly width: number;
  readonly height: number;
  readonly paths: ReadonlySet<string>;
  readonly objects: ReadonlyMap<number, PlacedObject>;
  readonly entrance: Readonly<Cell>;
  readonly version: number;
  readonly pathVersion: number;
  readonly biome: { readonly id: string };
  objectFootprint(object: PlacedObject): Cell[];
}

export interface NeighborhoodOptions {
  readonly leaderRadius: number;
  readonly bucketSize: number;
  readonly gateSteps: number;
}

export interface Neighborhood {
  /** The leader ride's object id; 0 = the gate. */
  readonly key: number;
  readonly name: string;
  readonly sector: SectorWord;
  /** The leader's anchor (the gate: the entrance). Names hash from it. */
  readonly anchor: Readonly<Cell>;
  /** Ascending. Empty for the gate. */
  readonly rideIds: readonly number[];
  /** Services, bins, benches and scenery, ascending. */
  readonly memberIds: readonly number[];
  /** Territory path cell indices (`y * width + x`), ascending. */
  readonly tiles: Int32Array;
  /** The territory tile nearest the centroid (ties lower cell index). */
  readonly focus: Readonly<Cell>;
  readonly centroid: { readonly x: number; readonly y: number };
}

export interface NeighborhoodMap {
  readonly worldVersion: number;
  readonly pathVersion: number;
  readonly width: number;
  readonly height: number;
  /** Gate first, then key ascending. */
  readonly neighborhoods: readonly Neighborhood[];
  /** Per cell: the owning key, -1 for none (off-path or unreached path). */
  readonly territory: Int32Array;
  /** Object id -> neighborhood key, for rides and members. */
  readonly memberOf: ReadonlyMap<number, number>;
  /** Rides, services, bins and benches in no neighborhood (no path access, or access in a ride-less component). */
  readonly unreached: readonly number[];
  /** Every path cell index, ascending. */
  readonly pathCells: Int32Array;
  /** Path component per cell (-1 off-path), components numbered in ascending order of their first cell. */
  readonly component: Int32Array;
}

const defaultOptions = (): NeighborhoodOptions => {
  const { leaderRadius, bucketSize, gateSteps } = GAME_CONFIG.crowd.neighborhood;
  return { leaderRadius, bucketSize, gateSteps };
};

const UNASSIGNED = -1;
const FAR = 0x3fffffff;

const parseCell = (key: string): Cell => {
  const comma = key.indexOf(',');
  return { x: Number(key.slice(0, comma)), y: Number(key.slice(comma + 1)) };
};

/** Path occupancy grid, ascending path cells and 4-connected components. */
const pathGrid = (world: NeighborhoodWorld): { isPath: Uint8Array; cells: Int32Array; component: Int32Array } => {
  const { width, height } = world;
  const isPath = new Uint8Array(width * height);
  let count = 0;
  for (const key of world.paths) {
    const { x, y } = parseCell(key);
    if (x < 0 || y < 0 || x >= width || y >= height) continue;
    const index = y * width + x;
    if (!isPath[index]) count += 1;
    isPath[index] = 1;
  }
  const cells = new Int32Array(count);
  for (let index = 0, at = 0; index < isPath.length; index += 1) if (isPath[index]) cells[at++] = index;
  const component = new Int32Array(width * height).fill(-1);
  const queue = new Int32Array(count);
  let next = 0;
  for (const start of cells) {
    if (component[start] >= 0) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    component[start] = next;
    while (head < tail) {
      const cell = queue[head++];
      const x = cell % width;
      const y = (cell - x) / width;
      if (x > 0 && isPath[cell - 1] && component[cell - 1] < 0) { component[cell - 1] = next; queue[tail++] = cell - 1; }
      if (x < width - 1 && isPath[cell + 1] && component[cell + 1] < 0) { component[cell + 1] = next; queue[tail++] = cell + 1; }
      if (y > 0 && isPath[cell - width] && component[cell - width] < 0) { component[cell - width] = next; queue[tail++] = cell - width; }
      if (y < height - 1 && isPath[cell + width] && component[cell + width] < 0) { component[cell + width] = next; queue[tail++] = cell + width; }
    }
    next += 1;
  }
  return { isPath, cells, component };
};

/** Path cells orthogonally adjacent to the footprint and not under it, ascending. */
const accessOf = (footprint: readonly Cell[], isPath: Uint8Array, width: number, height: number): number[] => {
  const under = new Set<number>();
  for (const cell of footprint) under.add(cell.y * width + cell.x);
  const access = new Set<number>();
  for (const cell of footprint) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const x = cell.x + dx;
      const y = cell.y + dy;
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const index = y * width + x;
      if (isPath[index] && !under.has(index)) access.add(index);
    }
  }
  return [...access].sort((left, right) => left - right);
};

/**
 * Layered multi-source BFS: every cell gets the smallest distance, ties to the smallest label. `limitOf(label)` caps
 * how far a label spreads (inclusive). Exact regardless of seed order because a layer is final before the next one.
 */
const layeredBfs = (
  passable: (cell: number) => boolean,
  width: number,
  height: number,
  seeds: readonly (readonly [cell: number, label: number])[],
  limitOf: (label: number) => number,
): { label: Int32Array; distance: Int32Array } => {
  const label = new Int32Array(width * height).fill(UNASSIGNED);
  const distance = new Int32Array(width * height).fill(FAR);
  let frontier: number[] = [];
  for (const [cell, source] of seeds) {
    if (distance[cell] !== 0) {
      distance[cell] = 0;
      label[cell] = source;
      frontier.push(cell);
    } else if (source < label[cell]) label[cell] = source;
  }
  let depth = 0;
  while (frontier.length > 0) {
    depth += 1;
    const next: number[] = [];
    for (const cell of frontier) {
      const source = label[cell];
      if (depth > limitOf(source)) continue;
      const x = cell % width;
      const y = (cell - x) / width;
      const visit = (neighbour: number): void => {
        if (!passable(neighbour)) return;
        if (distance[neighbour] > depth) {
          distance[neighbour] = depth;
          label[neighbour] = source;
          next.push(neighbour);
        } else if (distance[neighbour] === depth && source < label[neighbour]) label[neighbour] = source;
      };
      if (x > 0) visit(cell - 1);
      if (x < width - 1) visit(cell + 1);
      if (y > 0) visit(cell - width);
      if (y < height - 1) visit(cell + width);
    }
    frontier = next;
  }
  return { label, distance };
};

interface RideInfo {
  readonly object: PlacedObject;
  readonly cx: number;
  readonly cy: number;
  readonly access: number[];
  readonly components: ReadonlySet<number>;
}

interface Cluster {
  readonly key: number;
  readonly leader: RideInfo;
  readonly rides: RideInfo[];
}

/** Pure, uncached derivation (see the module comment). */
export const deriveNeighborhoods = (world: NeighborhoodWorld, options: NeighborhoodOptions = defaultOptions()): NeighborhoodMap => {
  const { width, height } = world;
  const { isPath, cells: pathCells, component } = pathGrid(world);

  // 1. Rides with access, ascending id, clustered by leader.
  const objects = [...world.objects.values()].sort((left, right) => left.id - right.id);
  const rides: RideInfo[] = [];
  const unreached: number[] = [];
  const others: { object: PlacedObject; footprint: Cell[]; scenery: boolean }[] = [];
  for (const object of objects) {
    const definition = BUILD_BY_ID.get(object.definitionId);
    if (!definition || definition.kind === 'path') continue;
    const footprint = world.objectFootprint(object);
    if (definition.kind !== 'ride') {
      others.push({ object, footprint, scenery: definition.kind === 'scenery' });
      continue;
    }
    const access = accessOf(footprint, isPath, width, height);
    if (access.length === 0 || footprint.length === 0) {
      unreached.push(object.id);
      continue;
    }
    let sx = 0;
    let sy = 0;
    for (const cell of footprint) { sx += cell.x; sy += cell.y; }
    rides.push({
      object,
      cx: sx / footprint.length,
      cy: sy / footprint.length,
      access,
      components: new Set(access.map((cell) => component[cell])),
    });
  }

  const radius = options.leaderRadius;
  const bucket = Math.max(1, options.bucketSize);
  const bucketColumns = Math.ceil(width / bucket);
  const bucketRows = Math.ceil(height / bucket);
  const buckets: Cluster[][] = Array.from({ length: bucketColumns * bucketRows }, () => []);
  const bucketIndex = (value: number, limit: number): number => Math.min(limit - 1, Math.max(0, Math.floor(value / bucket)));
  const clusters: Cluster[] = [];
  for (const ride of rides) {
    let best: Cluster | null = null;
    let bestDistance = Infinity;
    const fromColumn = bucketIndex(ride.cx - radius, bucketColumns);
    const toColumn = bucketIndex(ride.cx + radius, bucketColumns);
    const fromRow = bucketIndex(ride.cy - radius, bucketRows);
    const toRow = bucketIndex(ride.cy + radius, bucketRows);
    for (let row = fromRow; row <= toRow; row += 1) {
      for (let column = fromColumn; column <= toColumn; column += 1) {
        for (const cluster of buckets[row * bucketColumns + column]) {
          const leader = cluster.leader;
          const distance = Math.max(Math.abs(leader.cx - ride.cx), Math.abs(leader.cy - ride.cy));
          if (distance > radius) continue;
          if (distance > bestDistance || (distance === bestDistance && best !== null && cluster.key > best.key)) continue;
          let shared = false;
          for (const id of ride.components) if (leader.components.has(id)) { shared = true; break; }
          if (!shared) continue;
          best = cluster;
          bestDistance = distance;
        }
      }
    }
    if (best) best.rides.push(ride);
    else {
      const cluster: Cluster = { key: ride.object.id, leader: ride, rides: [ride] };
      clusters.push(cluster);
      buckets[bucketIndex(ride.cy, bucketRows) * bucketColumns + bucketIndex(ride.cx, bucketColumns)].push(cluster);
    }
  }

  const territory = new Int32Array(width * height).fill(UNASSIGNED);
  const memberOf = new Map<number, number>();
  if (clusters.length === 0) {
    for (const other of others) if (!other.scenery) unreached.push(other.object.id);
    unreached.sort((left, right) => left - right);
    return { worldVersion: world.version, pathVersion: world.pathVersion, width, height, neighborhoods: [], territory, memberOf, unreached, pathCells, component };
  }

  // 2. Territory: the ride clusters spread over every path tile (their waves pass through the gate's tiles); the
  // gate takes a tile within `gateSteps` when it is at least as near as any cluster (ties: lower key, the gate is 0).
  const seeds: [number, number][] = [];
  for (const cluster of clusters) {
    for (const ride of cluster.rides) for (const cell of ride.access) seeds.push([cell, cluster.key]);
  }
  const passable = (cell: number): boolean => isPath[cell] === 1;
  const spread = layeredBfs(passable, width, height, seeds, () => FAR);
  territory.set(spread.label);
  const entranceIndex = world.entrance.y * width + world.entrance.x;
  if (isPath[entranceIndex]) {
    const gate = layeredBfs(passable, width, height, [[entranceIndex, 0]], () => options.gateSteps);
    for (const cell of pathCells) {
      if (gate.label[cell] === 0 && gate.distance[cell] <= spread.distance[cell]) territory[cell] = 0;
    }
  }

  // A cluster whose every access tile is also an access tile of an older cluster owns no tile: its rides join the
  // cluster holding its lowest such tile (an older one, so nothing older changes and no territory moves).
  const clusterByKey = new Map(clusters.map((cluster) => [cluster.key, cluster]));
  const owned = new Set<number>();
  for (const cell of pathCells) if (territory[cell] > 0) owned.add(territory[cell]);
  for (let index = 0; index < clusters.length; index += 1) {
    const cluster = clusters[index];
    if (owned.has(cluster.key)) continue;
    let host: Cluster | undefined;
    const access = cluster.rides.flatMap((ride) => ride.access).sort((left, right) => left - right);
    for (const cell of access) {
      const key = territory[cell];
      if (key > 0 && key !== cluster.key) { host = clusterByKey.get(key); break; }
    }
    if (!host) continue;
    host.rides.push(...cluster.rides);
    host.rides.sort((left, right) => left.object.id - right.object.id);
    clusterByKey.delete(cluster.key);
    clusters.splice(index, 1);
    index -= 1;
  }

  // 3. Members.
  const nearest = others.some((other) => other.scenery)
    ? layeredBfs(() => true, width, height, [...pathCells].filter((cell) => territory[cell] >= 0).map((cell) => [cell, cell] as const), () => FAR)
    : null;
  const membersByKey = new Map<number, number[]>();
  const addMember = (key: number, id: number): void => {
    memberOf.set(id, key);
    const list = membersByKey.get(key);
    if (list) list.push(id);
    else membersByKey.set(key, [id]);
  };
  for (const other of others) {
    if (other.scenery) {
      if (!nearest) continue;
      let bestCell = UNASSIGNED;
      let bestDistance = FAR;
      for (const cell of other.footprint) {
        const index = cell.y * width + cell.x;
        if (index < 0 || index >= nearest.label.length) continue;
        const distance = nearest.distance[index];
        const source = nearest.label[index];
        if (source < 0) continue;
        if (distance < bestDistance || (distance === bestDistance && source < bestCell)) { bestDistance = distance; bestCell = source; }
      }
      if (bestCell >= 0) addMember(territory[bestCell], other.object.id);
      continue;
    }
    const access = accessOf(other.footprint, isPath, width, height).filter((cell) => territory[cell] >= 0);
    if (access.length === 0) unreached.push(other.object.id);
    else addMember(territory[access[0]], other.object.id);
  }
  unreached.sort((left, right) => left - right);

  // 4. Identity, names, geometry.
  const biomeId = world.biome.id;
  const names = assignNames(biomeId, clusters.map((cluster) => ({ key: cluster.key, anchor: cluster.leader.object.anchor })));
  const tilesByKey = new Map<number, number[]>();
  for (const cell of pathCells) {
    const key = territory[cell];
    if (key < 0) continue;
    const list = tilesByKey.get(key);
    if (list) list.push(cell);
    else tilesByKey.set(key, [cell]);
  }
  for (const cluster of clusters) for (const ride of cluster.rides) memberOf.set(ride.object.id, cluster.key);

  const geometry = (tiles: Int32Array, fallback: Readonly<Cell>): { focus: Cell; centroid: { x: number; y: number }; sector: SectorWord } => {
    if (tiles.length === 0) {
      return { focus: { ...fallback }, centroid: { x: fallback.x, y: fallback.y }, sector: sectorOf(fallback.x, fallback.y, width, height) };
    }
    let sx = 0;
    let sy = 0;
    for (const cell of tiles) { sx += cell % width; sy += Math.floor(cell / width); }
    const cx = sx / tiles.length;
    const cy = sy / tiles.length;
    let focus = tiles[0];
    let bestDistance = Infinity;
    for (const cell of tiles) {
      const dx = (cell % width) - cx;
      const dy = Math.floor(cell / width) - cy;
      const distance = dx * dx + dy * dy;
      if (distance < bestDistance) { bestDistance = distance; focus = cell; }
    }
    return { focus: { x: focus % width, y: Math.floor(focus / width) }, centroid: { x: cx, y: cy }, sector: sectorOf(cx, cy, width, height) };
  };

  const neighborhoods: Neighborhood[] = [];
  const gateTiles = Int32Array.from(tilesByKey.get(0) ?? []);
  neighborhoods.push({
    key: 0,
    name: gateNameOf(biomeId),
    anchor: { x: world.entrance.x, y: world.entrance.y },
    rideIds: [],
    memberIds: membersByKey.get(0) ?? [],
    tiles: gateTiles,
    ...geometry(gateTiles, world.entrance),
  });
  for (const cluster of clusters) {
    const tiles = Int32Array.from(tilesByKey.get(cluster.key) ?? []);
    const anchor = cluster.leader.object.anchor;
    neighborhoods.push({
      key: cluster.key,
      name: names.get(cluster.key) ?? gateNameOf(biomeId),
      anchor: { x: anchor.x, y: anchor.y },
      rideIds: cluster.rides.map((ride) => ride.object.id),
      memberIds: membersByKey.get(cluster.key) ?? [],
      tiles,
      ...geometry(tiles, anchor),
    });
  }
  return { worldVersion: world.version, pathVersion: world.pathVersion, width, height, neighborhoods, territory, memberOf, unreached, pathCells, component };
};

interface CacheEntry {
  readonly version: number;
  readonly pathVersion: number;
  readonly objects: number;
  readonly paths: number;
  readonly map: NeighborhoodMap;
}

const cache = new WeakMap<object, CacheEntry>();

/** `deriveNeighborhoods` memoised per world and edit (`version`), with the default options. */
export const neighborhoodsOf = (world: NeighborhoodWorld): NeighborhoodMap => {
  const entry = cache.get(world);
  if (
    entry
    && entry.version === world.version
    && entry.pathVersion === world.pathVersion
    && entry.objects === world.objects.size
    && entry.paths === world.paths.size
  ) return entry.map;
  const map = deriveNeighborhoods(world);
  cache.set(world, { version: world.version, pathVersion: world.pathVersion, objects: world.objects.size, paths: world.paths.size, map });
  return map;
};

/** Forget the cached derivation (call after an in-place restore, like `PathNetwork.invalidate`). */
export const invalidateNeighborhoods = (world: NeighborhoodWorld): void => {
  cache.delete(world);
};

/** The neighborhood owning a world cell, or null (off-path, unreached, outside the map). */
export const neighborhoodAt = (map: NeighborhoodMap, cell: Readonly<Cell>): Neighborhood | null => {
  if (cell.x < 0 || cell.y < 0 || cell.x >= map.width || cell.y >= map.height) return null;
  const key = map.territory[cell.y * map.width + cell.x];
  if (key < 0) return null;
  return map.neighborhoods.find((neighborhood) => neighborhood.key === key) ?? null;
};
