import type { PathShape } from './types';

/**
 * Phase 14: the shape of the path network, derived per `pathVersion` and never saved (design Q1 "Classification").
 *
 * Every path is one tile of one kind, so "width" is read from the network's shape: `laneWidth` is the number of path
 * tiles in the 3x3 block around a tile divided by 3, clamped to 1..3 (a straight 1-wide corridor 1, the crossing of two
 * corridors 5/3, a 2-wide street 2, a plaza 3). `degree` counts orthogonal path neighbours, `component` numbers the
 * orthogonally connected pieces in ascending cell order, `articulation` marks the cut vertices of each piece (iterative
 * Tarjan, no recursion). Integer inputs only, so the result is the same in every engine.
 */

/** The structural view of a world this needs (`GameWorld` satisfies it): `paths` holds `"x,y"` keys. */
export interface PathSource {
  readonly width: number;
  readonly height: number;
  readonly paths: ReadonlySet<string>;
  readonly pathVersion: number;
}

/** Orthogonal neighbour offsets in a fixed order (east, west, south, north). */
const STEPS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

/** Builds the shape from scratch (pure; no cache). Keys outside the map or not of the form `"x,y"` are ignored. */
export const computePathShape = (source: PathSource): PathShape => {
  const { width, height } = source;
  const count = width * height;
  const isPath = new Uint8Array(count);
  for (const key of source.paths) {
    const comma = key.indexOf(',');
    if (comma < 0) continue;
    const x = Number(key.slice(0, comma));
    const y = Number(key.slice(comma + 1));
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= width || y >= height) continue;
    isPath[y * width + x] = 1;
  }
  const cellList: number[] = [];
  for (let index = 0; index < count; index += 1) if (isPath[index] === 1) cellList.push(index);
  const cells = Int32Array.from(cellList);

  const laneWidth = new Float64Array(count);
  const degree = new Uint8Array(count);
  const neighbours = (index: number, visit: (next: number) => void): void => {
    const x = index % width;
    const y = (index - x) / width;
    for (const [dx, dy] of STEPS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const next = ny * width + nx;
      if (isPath[next] === 1) visit(next);
    }
  };
  for (const index of cells) {
    const x = index % width;
    const y = (index - x) / width;
    let block = 0;
    for (let dy = -1; dy <= 1; dy += 1) {
      for (let dx = -1; dx <= 1; dx += 1) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && isPath[ny * width + nx] === 1) block += 1;
      }
    }
    laneWidth[index] = Math.min(3, Math.max(1, block / 3));
    let orthogonal = 0;
    neighbours(index, () => { orthogonal += 1; });
    degree[index] = orthogonal;
  }

  const component = new Int32Array(count).fill(-1);
  const articulation = new Uint8Array(count);
  // Tarjan's articulation points, iteratively: discovery order, low-link, and an explicit stack of (cell, next step).
  const discovery = new Int32Array(count).fill(-1);
  const low = new Int32Array(count);
  const parent = new Int32Array(count).fill(-1);
  const stepIndex = new Uint8Array(count);
  const stack = new Int32Array(count);
  let time = 0;
  let componentId = 0;
  for (const root of cells) {
    if (discovery[root] !== -1) continue;
    let rootChildren = 0;
    let depth = 0;
    stack[depth] = root;
    discovery[root] = low[root] = time;
    time += 1;
    component[root] = componentId;
    while (depth >= 0) {
      const cell = stack[depth];
      if (stepIndex[cell] < STEPS.length) {
        const [dx, dy] = STEPS[stepIndex[cell]];
        stepIndex[cell] += 1;
        const x = cell % width;
        const y = (cell - x) / width;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
        const next = ny * width + nx;
        if (isPath[next] !== 1) continue;
        if (discovery[next] === -1) {
          parent[next] = cell;
          discovery[next] = low[next] = time;
          time += 1;
          component[next] = componentId;
          if (cell === root) rootChildren += 1;
          depth += 1;
          stack[depth] = next;
        } else if (next !== parent[cell] && discovery[next] < low[cell]) {
          low[cell] = discovery[next];
        }
        continue;
      }
      // Every neighbour of `cell` is done: fold its low-link into the parent.
      depth -= 1;
      const up = parent[cell];
      if (up !== -1) {
        if (low[cell] < low[up]) low[up] = low[cell];
        if (up !== root && low[cell] >= discovery[up]) articulation[up] = 1;
      }
    }
    if (rootChildren > 1) articulation[root] = 1;
    componentId += 1;
  }

  return { pathVersion: source.pathVersion, laneWidth, degree, articulation, component, cells };
};

/**
 * The shape of one world, cached by `pathVersion` exactly like `PathNetwork.sync`. `invalidate()` forgets the cache
 * including the version, for a restore: a restored world carries its saved `pathVersion`, which can coincide with the
 * number this cache last saw for different paths.
 */
export class PathShapeCache {
  private shape: PathShape | null = null;
  private width = -1;
  private height = -1;

  of(source: PathSource): PathShape {
    const cached = this.shape;
    if (cached !== null && cached.pathVersion === source.pathVersion && this.width === source.width && this.height === source.height) return cached;
    this.shape = computePathShape(source);
    this.width = source.width;
    this.height = source.height;
    return this.shape;
  }

  invalidate(): void {
    this.shape = null;
    this.width = -1;
    this.height = -1;
  }
}

const caches = new WeakMap<object, PathShapeCache>();

/** The cached shape of `world` (one cache per world object). Recomputed when `pathVersion` moves. */
export const pathShapeOf = (world: PathSource): PathShape => {
  let cache = caches.get(world);
  if (cache === undefined) {
    cache = new PathShapeCache();
    caches.set(world, cache);
  }
  return cache.of(world);
};

/** Forgets the cached shape of `world` (call after a restore, like `PathNetwork.invalidate`). */
export const invalidatePathShape = (world: PathSource): void => {
  caches.get(world)?.invalidate();
};

/** `y * width + x` (the index every per-cell array of the crowd code uses); -1 outside the map. */
export const cellIndexOf = (width: number, height: number, cell: Readonly<{ x: number; y: number }>): number => (
  Number.isInteger(cell.x) && Number.isInteger(cell.y) && cell.x >= 0 && cell.y >= 0 && cell.x < width && cell.y < height
    ? cell.y * width + cell.x
    : -1
);
