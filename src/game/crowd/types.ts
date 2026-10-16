/**
 * Phase 14 (Neighborhoods & Crowd Flow): the shared data contract. Types only; nothing here runs.
 *
 * Pressure is the rolling FLOW of walking guests through a path tile, held as an integer field: an entry adds
 * `GAME_CONFIG.crowd.entryUnits`, every simulation tick decays each cell by `ceil(p / decayDivisor)`. Bands, path
 * shape, neighborhoods and every view below are derived and never saved; only `CrowdState` is, and only in a park
 * whose ruleset has `crowdFeedback`.
 */
import type { Cell } from '../types';

/** 0 quiet, 1 normal, 2 busy, 3 severe (guests a minute per lane against `GAME_CONFIG.crowd.bands`). */
export type CrowdBand = 0 | 1 | 2 | 3;

/** The saved field: sparse `[cellIndex, value]` pairs, ascending by cell, value > 0, integers only. */
export interface CrowdState {
  version: 1;
  pressure: Array<[cell: number, value: number]>;
}

/**
 * Derived per `pathVersion` (never saved). Per-cell arrays are `width x height` long, indexed `y * width + x`;
 * `cells` lists the path cell indices in ascending order.
 */
export interface PathShape {
  pathVersion: number;
  /** 1..3: path tiles in the 3x3 block / 3, clamped (corridor 1, crossing 1.67, 2-wide street 2, plaza 3); 0 off-path. */
  laneWidth: Float64Array;
  /** 0..4 orthogonal path neighbours. */
  degree: Uint8Array;
  /** 1 when the cell is an articulation point of its path component. */
  articulation: Uint8Array;
  /** Path component id (-1 off-path). */
  component: Int32Array;
  cells: Int32Array;
}

/** One classified path tile. `neighborhoodKey` null = in no neighborhood. */
export interface CrowdTile {
  cell: Cell;
  band: CrowdBand;
  perMinute: number;
  bottleneck: boolean;
  neighborhoodKey: number | null;
}

/** What the renderer draws (world cells). `revision` moves only when a displayed band changes. */
export interface CrowdHeatmapView {
  revision: number;
  cells: readonly Cell[];
  bands: readonly CrowdBand[];
}

/** The territory centroid in a 3x3 split of the map, in world compass words. */
export type SectorWord =
  | 'north-west'
  | 'north'
  | 'north-east'
  | 'west'
  | 'centre'
  | 'east'
  | 'south-west'
  | 'south'
  | 'south-east';

export interface NeighborhoodView {
  /** The leader ride's object id; 0 = the gate neighborhood. */
  key: number;
  name: string;
  sector: SectorWord;
  rideIds: number[];
  /** Services, bins, benches and scenery assigned through their nearest access path tile. */
  memberIds: number[];
  tileCount: number;
  /** The cell the camera centres on: the territory tile nearest the centroid. */
  focus: Cell;
  metrics: NeighborhoodMetrics;
  /** The worst tile (highest band, then flow); null when the territory has no path tile with flow. */
  worst: CrowdTile | null;
}

export interface NeighborhoodMetrics {
  guests: number;
  happiness: number | null;
  hunger: number | null;
  thirst: number | null;
  toilet: number | null;
  spending: number;
  litter: number;
  scenery: number;
  queueing: number;
  longestWaitSeconds: number | null;
  demand: number;
  /** Share (0..1) of its tiles within `reachSteps` path steps of an open service of that kind. */
  coverage: { food: number; drink: number; toilet: number };
  /** Tiles per band: quiet, normal, busy, severe. */
  bands: [number, number, number, number];
}

export interface CrowdView {
  tick: number;
  neighborhoods: NeighborhoodView[];
  bottlenecks: CrowdTile[];
  walking: number;
  /** True when the park's ruleset has `crowdFeedback` (the field then feeds back and is saved). */
  feedback: boolean;
  /**
   * Phase 14 Wave 2 additions (optional so hand-built fixtures stay valid; `ParkSession.crowdView()` always fills them):
   * walking guests on each neighborhood's tiles (key -> count, every key present; `NeighborhoodRow.walking`), ...
   */
  walkingByKey?: Readonly<Record<number, number>>;
  /** ... the number of rides, services, bins and benches in no neighborhood ("{n} buildings have no path access"), ... */
  unreached?: number;
  /** ... and the open services of each kind with path access anywhere in the park (the coverage Pulse lines). */
  openServices?: Readonly<{ food: number; drink: number; toilet: number }>;
}

/**
 * What `GuestSimulation` reads and writes (design section 4, `GuestSimulation.setCrowd`). A standalone
 * `GuestSimulation` uses a neutral reader (no-op entries, factor exactly 1, never severe), so it is bit-identical.
 */
export interface CrowdFlowReader {
  /** A walking guest stepped onto this path tile (the `distance <= movement` branch of `walk`). */
  noteEntry(cell: Readonly<Cell>): void;
  /** Movement multiplier for the step onto this tile: the literal 1 when off or at load <= 1. */
  speedFactorAt(cell: Readonly<Cell>): number;
  /** The tile is in the severe band (feedback on only; always false when off). */
  isSevereAt(cell: Readonly<Cell>): boolean;
}
