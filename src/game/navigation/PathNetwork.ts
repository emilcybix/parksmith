import type { Cell } from '../types';

const keyOf = ({ x, y }: Cell): string => `${x},${y}`;
const fromKey = (key: string): Cell => {
  const [x, y] = key.split(',').map(Number);
  return { x, y };
};

const DIRECTIONS: readonly Cell[] = [
  { x: 1, y: 0 },
  { x: -1, y: 0 },
  { x: 0, y: 1 },
  { x: 0, y: -1 },
];

interface DestinationField {
  /** Next cell on the shortest route toward the goal, pre-parsed once per flood. */
  next: Map<string, Cell>;
  /** Hop count to the goal, filled by the same BFS. */
  distance: Map<string, number>;
}

/**
 * Versioned cardinal path network. Every query works on cached per-goal BFS fields
 * (next-pointer + distance in one sweep) and cached per-component membership, so the
 * per-guest cost of scoring destinations is O(1) lookups; full route arrays are only
 * materialized for the destination a guest actually commits to.
 */
export class PathNetwork {
  private pathVersion = -1;
  private paths = new Set<string>();
  private readonly destinationFields = new Map<string, DestinationField>();
  private readonly componentByCell = new Map<string, readonly Cell[]>();
  private requests = 0;

  sync(paths: ReadonlySet<string>, version: number): void {
    if (version === this.pathVersion) return;
    this.pathVersion = version;
    this.paths = new Set(paths);
    this.destinationFields.clear();
    this.componentByCell.clear();
  }

  /**
   * Forgets everything derived from the paths, including the version it was synced at, so the next
   * sync rebuilds even if the world presents the same version number. A restored world carries
   * its saved pathVersion verbatim, which can coincide with the number this network last saw for
   * different paths. `requests` is telemetry and is left alone.
   */
  invalidate(): void {
    this.pathVersion = -1;
    this.paths = new Set();
    this.destinationFields.clear();
    this.componentByCell.clear();
  }

  contains(cell: Cell): boolean { return this.paths.has(keyOf(cell)); }

  getPathVersion(): number { return this.pathVersion; }

  /** Shortest-route hop count, or null when unreachable. O(1) after the field is cached. */
  routeDistance(start: Cell, goal: Cell): number | null {
    const startKey = keyOf(start);
    const goalKey = keyOf(goal);
    if (!this.paths.has(startKey) || !this.paths.has(goalKey)) return null;
    if (startKey === goalKey) return 0;
    return this.fieldTo(goalKey).distance.get(startKey) ?? null;
  }

  findRoute(start: Cell, goal: Cell): Cell[] | null {
    this.requests += 1;
    const startKey = keyOf(start);
    const goalKey = keyOf(goal);
    if (!this.paths.has(startKey) || !this.paths.has(goalKey)) return null;
    if (startKey === goalKey) return [{ ...start }];
    const field = this.fieldTo(goalKey);
    if (!field.next.has(startKey)) return null;
    const route: Cell[] = [{ ...start }];
    let cursor: Cell | undefined = field.next.get(startKey);
    let guard = this.paths.size + 1;
    while (cursor && guard > 0) {
      route.push({ ...cursor });
      if (cursor.x === goal.x && cursor.y === goal.y) return route;
      cursor = field.next.get(keyOf(cursor));
      guard -= 1;
    }
    return null;
  }

  /**
   * Route to the closest reachable goal. Goals are compared by cached distance;
   * only the winner's route is materialized.
   */
  findNearestRoute(start: Cell, goals: readonly Cell[]): Cell[] | null {
    let bestGoal: Cell | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const goal of goals) {
      const distance = this.routeDistance(start, goal);
      if (distance !== null && distance < bestDistance) {
        bestDistance = distance;
        bestGoal = goal;
        if (distance <= 1) break;
      }
    }
    return bestGoal ? this.findRoute(start, bestGoal) : null;
  }

  /**
   * All cells in the start cell's connected component, sorted by (y, x). The array is cached per
   * component and shared between callers — treat it as read-only. The order is canonical on
   * purpose: guests map wander RNG draws and break ties by index into this array, so it must not
   * depend on which cell was queried first (a restored network starts with an empty cache).
   */
  connectedCells(start: Cell): readonly Cell[] {
    const startKey = keyOf(start);
    if (!this.paths.has(startKey)) return [];
    const cached = this.componentByCell.get(startKey);
    if (cached) return cached;
    const members: Cell[] = [fromKey(startKey)];
    const visited = new Set([startKey]);
    for (let index = 0; index < members.length; index += 1) {
      const current = members[index];
      for (const direction of DIRECTIONS) {
        const neighbor = { x: current.x + direction.x, y: current.y + direction.y };
        const neighborKey = keyOf(neighbor);
        if (visited.has(neighborKey) || !this.paths.has(neighborKey)) continue;
        visited.add(neighborKey);
        members.push(neighbor);
      }
    }
    members.sort((a, b) => a.y - b.y || a.x - b.x);
    for (const member of members) this.componentByCell.set(keyOf(member), members);
    return members;
  }

  findNearestPath(origin: Cell): Cell | null {
    let best: Cell | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const key of this.paths) {
      const cell = fromKey(key);
      const distance = Math.abs(cell.x - origin.x) + Math.abs(cell.y - origin.y);
      if (distance >= bestDistance) continue;
      best = cell;
      bestDistance = distance;
    }
    return best;
  }

  consumeRequestCount(): number {
    const value = this.requests;
    this.requests = 0;
    return value;
  }

  private fieldTo(goalKey: string): DestinationField {
    const cached = this.destinationFields.get(goalKey);
    if (cached) return cached;
    const next = new Map<string, Cell>();
    const distance = new Map<string, number>([[goalKey, 0]]);
    const queue = [fromKey(goalKey)];
    const visited = new Set([goalKey]);
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      const currentKey = keyOf(current);
      const currentDistance = distance.get(currentKey) ?? 0;
      for (const direction of DIRECTIONS) {
        const neighbor = { x: current.x + direction.x, y: current.y + direction.y };
        const neighborKey = keyOf(neighbor);
        if (!this.paths.has(neighborKey) || visited.has(neighborKey)) continue;
        visited.add(neighborKey);
        next.set(neighborKey, current);
        distance.set(neighborKey, currentDistance + 1);
        queue.push(neighbor);
      }
    }
    const field = { next, distance };
    this.destinationFields.set(goalKey, field);
    return field;
  }
}
