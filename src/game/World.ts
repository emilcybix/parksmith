import { COASTER_TYPES } from './coaster/content';
import {
  deriveCoasterStats, isExclusiveCoasterPiece, trackPiecesMayCross, validateCoasterLayout, type CoasterDerivedStats, type CoasterPiece,
} from './coaster/design';
import { BUILD_BY_ID } from './content/catalog';
import {
  ENTRANCE_COLOUR_ID,
  colourSlotsFor,
  normaliseObjectColours,
  sameObjectColours,
  validateObjectColours,
  type ObjectColours,
} from './content/colours';
import { COLOUR_PRESET_BY_ID, presetRecord, type ColourPresetId } from './content/colourPresets';
import { GAME_CONFIG } from './config';
import type { BiomeDefinition } from './biomes/types';
import { MEADOW_LAYOUT, layoutFromState, groundRowsOf, propFootprintSize } from './maps/parse';
import { PROP_KIND_BY_ID, type PropKindDefinition } from './maps/props';
import { GROUND_BASE, GROUND_WATER, type Facing, type GroundKind, type MapLayout, type PropPlacement } from './maps/types';
import { footprintSize } from './types';
import { frontEdgeCells, isFrontOnly, sameFootprintRotations } from './access';
import { LandOwnership, checkOwnedParcels, type LandPurchaseBlockReason } from './land/LandOwnership';
import { parcelGridOf, parcelIndexOfCell, parcelsOfRect, type CellRect } from './land/parcels';
import { plainNumber } from './save/plainData';
import type {
  CellState,
  CoasterPieceState,
  CoasterRecordState,
  CoasterStatsState,
  GameWorldState,
  MapState,
  PlacedObjectState,
  Serializable,
  TransactionState,
} from './save/state';
import { MAXIMUM_SAVED_AMOUNT, MAXIMUM_SAVED_COUNTER, MAXIMUM_SAVED_PRICE } from './save/ranges';
import { invalidState } from './save/version';
import type {
  BuildDefinition,
  Cell,
  PlacedObject,
  Rotation,
  Transaction,
  TransactionCategory,
} from './types';

const cellKey = ({ x, y }: Cell) => `${x},${y}`;

/** Phase 38: one coaster piece in a cell's track layers. */
interface TrackLayer {
  readonly id: number;
  readonly height: number;
  /** A station piece, a special, or under a loop ring: nothing may cross it (design.ts isExclusiveCoasterPiece). */
  readonly exclusive: boolean;
}

/** Phase 38: what a coaster piece needs to know about its cell's other track. */
export interface CoasterPieceProbe {
  cell: Cell;
  height: number;
  /** Station, special or under a loop: may share its cell with nothing but a path (as before). */
  exclusive?: boolean;
}

const addTrackLayer = (layers: Map<string, TrackLayer[]>, key: string, layer: TrackLayer): void => {
  const list = layers.get(key);
  if (list === undefined) {
    layers.set(key, [layer]);
    return;
  }
  list.push(layer);
  list.sort((a, b) => a.height - b.height);
};


/** What the world needs from the opening hours: a plain read, so it never imports the weather owner. */
export interface GateSchedule {
  readonly scheduleOpen: boolean;
}

export interface BuildAccessPolicy {
  isUnlocked(definitionId: string): boolean;
}

/** 'unowned' (Phase 21): part of the footprint is on land the park does not own. */
export type ObjectBuildBlockReason = 'unknown' | 'path' | 'custom' | 'locked' | 'funds' | 'blocked' | 'obstacle' | 'unowned';

/** What stands on a cell that is neither path nor object: a prop (with its clearing price) or water. */
export type Obstacle =
  | { readonly kind: 'prop'; readonly prop: Readonly<PropPlacement>; readonly definition: PropKindDefinition; readonly cost: number | null }
  | { readonly kind: 'water' };

/** Whether the bulldozer could clear the prop on a cell, and what it would cost. A refusal changes nothing. */
export type ClearCheck =
  | { readonly ok: true; readonly prop: Readonly<PropPlacement>; readonly definition: PropKindDefinition; readonly cost: number }
  | { readonly ok: false; readonly reason: 'none' | 'permanent' | 'funds' | 'unowned'; readonly cost: number | null };

/** What one bulldozer stroke did. `cost` is set when a prop was cleared; `refused` when a prop could not be. */
export interface BulldozeResult {
  removed: boolean;
  refund: number;
  label: string | null;
  cost?: number;
  refused?: 'permanent' | 'funds' | 'unowned';
}

/** Whether a parcel could be bought now and at what price (Phase 21). A refusal changes nothing. */
export type ParcelPurchaseCheck =
  | { readonly ok: true; readonly parcel: number; readonly price: number }
  | { readonly ok: false; readonly parcel: number; readonly reason: LandPurchaseBlockReason; readonly price: number | null };

/** How a new world's land starts (Phase 21). Absent fields fall back to the map (owned area) and 1 (price multiplier). */
export interface WorldLandOptions {
  /** Overrides the map's starting owned area: null = the whole map, a rectangle = parcel-aligned, containing the gate. */
  readonly ownedArea?: CellRect | null;
  /** The ruleset's land price multiplier (not saved with the world: the ruleset holds it). */
  readonly landCostMultiplier?: number;
}

/** A ride's effective operating numbers, from the catalog or a custom coaster design. */
export interface RideProfile {
  name: string;
  capacity: number;
  duration: number;
  excitement: number;
  intensity: number;
  runningCost: number;
  ticketPrice: number;
  reliability: number;
}

export interface CoasterRecord {
  objectId: number;
  pieces: CoasterPiece[];
  stats: CoasterDerivedStats;
  /** The cash actually charged (after the construction multiplier), for refunds. */
  paidCost: number;
}

export type ObjectBuildCheck =
  | { ok: true; definition: BuildDefinition }
  | { ok: false; reason: ObjectBuildBlockReason };

export interface WorldSnapshot {
  cash: number;
  pathCount: number;
  objectCount: number;
  tick: number;
  parkOpen: boolean;
}

const TRANSACTION_CATEGORIES: Record<TransactionCategory, true> = {
  'land-clearing': true,
  'land-purchase': true,
  'ride-revenue': true,
  'food-revenue': true,
  'drink-revenue': true,
  'facility-revenue': true,
  'souvenir-revenue': true,
  'ride-operations': true,
  'staff-salaries': true,
  maintenance: true,
  research: true,
  construction: true,
  refund: true,
  grant: true,
  other: true,
};

/** The history cap recordTransaction enforces; a save holding more was not written by this game. */
const TRANSACTION_HISTORY_LIMIT = 300;

/** The numeric members of a coaster's derived stats, in the order the save lists them. */
const COASTER_STAT_KEYS = [
  'pieces', 'turns', 'drops', 'totalDescent', 'biggestDrop', 'highestHeight', 'loops', 'boosts',
  'topSpeed', 'excitement', 'intensity', 'durationSeconds', 'capacity', 'runningCost', 'ticketPrice',
  'reliability',
] as const satisfies ReadonlyArray<Exclude<keyof CoasterStatsState, 'travelSeconds'>>;

/** The stats that follow from track geometry alone; no balance constant feeds them, so restore re-derives and compares. */
const COASTER_GEOMETRY_STAT_KEYS = [
  'pieces', 'turns', 'drops', 'totalDescent', 'biggestDrop', 'highestHeight', 'loops', 'boosts',
] as const satisfies ReadonlyArray<(typeof COASTER_STAT_KEYS)[number]>;

/** Field-by-field so an unexpected extra key in a hand-edited save cannot leak into live state. */
const copyCoasterStats = (stats: CoasterStatsState): CoasterDerivedStats => {
  const copy = { travelSeconds: [...stats.travelSeconds] } as CoasterDerivedStats;
  for (const key of COASTER_STAT_KEYS) copy[key] = stats[key];
  return copy;
};

const isInteger = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);
const isPlainObject = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

/** Result of a colour edit (Phase 28). A refused edit changes nothing. */
export type ColourEditResult =
  | { ok: true; changed: boolean }
  | { ok: false; reason: 'unknown-object' | 'not-colourable' | 'invalid-colours' };

/** One edit of a recolour batch: a placed object (`gate: false`) or the entrance gate. `colours` null = defaults. */
export type ColourEdit =
  | { readonly objectId: number; readonly colours: readonly (number | null)[] | null }
  | { readonly gate: true; readonly colours: readonly (number | null)[] | null };

/** Outcome of a recolour batch: what actually changed, in edit order, and what was refused. */
export interface ColourBatchResult {
  /** Ids of placed objects whose record changed. */
  readonly changedObjectIds: readonly number[];
  readonly gateChanged: boolean;
  /** Objects (plus the gate, counted once) whose record changed: the number a cost is charged on. */
  readonly changedCount: number;
  /** Edits refused (unknown object, not colourable, invalid record), by index in the edit list. */
  readonly refused: readonly { readonly index: number; readonly reason: 'unknown-object' | 'not-colourable' | 'invalid-colours' }[];
}

export class GameWorld implements Serializable<GameWorldState> {
  /** The immutable part of the map (ground, biome, entrance, size, the props at session start). */
  readonly map: MapLayout;
  /** The map's size: whole parcels, 32 to 64 cells a side (Phase 21). */
  readonly width: number;
  readonly height: number;
  readonly paths = new Set<string>();
  readonly objects = new Map<number, PlacedObject>();
  readonly coasters = new Map<number, CoasterRecord>();
  readonly transactions: Transaction[] = [];
  /** The gate: a map property (Meadow: (15, 31)). Read it here, never as a literal. */
  readonly entrance: Cell;
  /** The direction guests walk into the park from the gate. */
  readonly entranceFacing: Facing;
  /** The live props by stable id, ascending (the map layer; cleared ones are gone). Never mutate from outside. */
  readonly props = new Map<number, PropPlacement>();
  /** Which parcels the park owns (Phase 21). Unrestricted (every parcel) on every map whose owned area is null. */
  readonly land: LandOwnership;
  /** The ruleset's land price multiplier: CONFIG, not saved with the world. */
  readonly landCostMultiplier: number;

  cash: number;
  tick = 0;
  parkOpen: boolean = GAME_CONFIG.startingOpen;
  version = 0;
  pathVersion = 0;
  /**
   * How many things the bulldozer has taken out of this park. It is part of the save format and
   * the state hash (the Phase 11 single-gesture undo that watched it is gone, replaced by snapshot
   * undo), so it stays: dropping it would change both.
   */
  demolitions = 0;

  /** The ground occupant of a cell: the entrance (0) or a placed non-coaster object. DERIVED, never saved. */
  private readonly occupancy = new Map<string, number>();
  /**
   * Phase 38: the coaster pieces in each cell, lowest first. Two pieces share a cell only when they are at least
   * `trackClearanceLevels` apart and neither is exclusive; a ground occupant under track has a `clearanceLevels` the
   * track clears. DERIVED from the coaster records, rebuilt on restore, never saved.
   */
  private readonly trackLayers = new Map<string, TrackLayer[]>();
  /** Derived from `props`: 0 = no prop, else the prop id, index y * width + x. Rebuilt on construct, clear and restoreMap. */
  private readonly propGrid: Int32Array;
  /** TRANSIENT: +1 per clear and per restoreMap. Renderers diff the prop set when it moved. Never saved. */
  private propRevisionCounter = 0;
  /** TRANSIENT: +1 per parcel bought and per restore. Renderers redraw the land overlay when it moved. Never saved. */
  private landRevisionCounter = 0;
  private nextObjectId = 1;
  private nextTransactionId = 1;
  private readonly listeners = new Set<() => void>();
  private buildAccessPolicy: BuildAccessPolicy | null = null;
  /**
   * Phase 40: CONFIG, from the ruleset's `frontAccess` (ParkSession sets it before seeding; never saved here). On, a
   * service or a bench is used from its front only (`frontAccessFor`), and a building placed by anything but the
   * player's own click is turned to face a path where its footprint allows (`facingRotation`).
   */
  private frontAccess = false;
  private gateSchedule: GateSchedule | null = null;
  private batchDepth = 0;
  private batchedChange = false;
  private appearanceCounter = 0;
  private gateRecord: ObjectColours | null = null;

  constructor(
    startingCash: number = GAME_CONFIG.startingCash,
    private readonly constructionCostMultiplier: number = 1,
    layout: MapLayout = MEADOW_LAYOUT,
    landOptions: WorldLandOptions = {},
  ) {
    this.map = layout;
    this.width = layout.width;
    this.height = layout.height;
    this.entrance = { x: layout.entrance.x, y: layout.entrance.y };
    this.entranceFacing = layout.entrance.facing;
    this.landCostMultiplier = landOptions.landCostMultiplier ?? 1;
    const ownedArea = landOptions.ownedArea !== undefined ? landOptions.ownedArea : layout.ownedArea ?? null;
    let ownedParcels: number[] | null = null;
    if (ownedArea !== null) {
      const grid = parcelGridOf(layout.width, layout.height);
      ownedParcels = parcelsOfRect(grid, ownedArea);
      const problem = ownedParcels === null
        ? 'is not whole parcels'
        : checkOwnedParcels(grid, parcelIndexOfCell(grid, this.entrance.x, this.entrance.y), ownedParcels);
      if (problem !== null) throw new RangeError(`GameWorld: the starting owned area ${problem}`);
    }
    this.land = new LandOwnership(layout.width, layout.height, this.entrance, ownedParcels);
    this.propGrid = new Int32Array(layout.width * layout.height);
    this.installProps(layout.props);
    this.cash = startingCash;
    this.occupancy.set(cellKey(this.entrance), 0);
    this.paths.add(cellKey(this.entrance));
  }

  get biome(): BiomeDefinition {
    return this.map.biome;
  }

  /** TRANSIENT counter that moves whenever the owned land changes (a purchase, a restore). */
  get landRevision(): number {
    return this.landRevisionCounter;
  }

  /** True when the cell is inside the map AND on owned land (Phase 21): the only land anything can be built on. */
  isOwned(cell: Cell): boolean {
    return this.isInside(cell) && this.land.isCellOwned(cell.x, cell.y);
  }

  /**
   * The park's heart for camera framing: the middle of the owned land (Phase 21), which on a wholly owned map is the map
   * centre ((width - 1) / 2, (height - 1) / 2) exactly, so every classic framing is unchanged.
   */
  get heart(): { x: number; y: number } {
    const bounds = this.land.ownedBounds();
    return { x: (bounds.x0 + bounds.x1) / 2, y: (bounds.y0 + bounds.y1) / 2 };
  }

  /** The price of a parcel now (the owned count, its distance from the gate, the land multiplier). */
  parcelPrice(parcel: number): number {
    return this.land.priceOf(parcel, this.landCostMultiplier);
  }

  /** Whether a parcel could be bought now: restricted land, next to owned land, not owned, affordable. */
  checkParcelPurchase(parcel: number): ParcelPurchaseCheck {
    const blocked = this.land.blockReason(parcel);
    if (blocked === 'unrestricted' || blocked === 'outside') return { ok: false, parcel, reason: blocked, price: null };
    const price = this.parcelPrice(parcel);
    if (blocked !== null) return { ok: false, parcel, reason: blocked, price };
    if (this.cash < price) return { ok: false, parcel, reason: 'funds', price };
    return { ok: true, parcel, price };
  }

  /**
   * Buys a parcel (Phase 21): charges its price as a 'land-purchase' transaction and makes its cells buildable. A
   * refused purchase changes nothing. Land is never sold back.
   */
  buyParcel(parcel: number): ParcelPurchaseCheck {
    const check = this.checkParcelPurchase(parcel);
    if (!check.ok) return check;
    this.land.take(parcel);
    this.landRevisionCounter += 1;
    this.recordTransaction(-check.price, 'Bought a parcel of land', 'land-purchase');
    this.changed();
    return check;
  }

  /** TRANSIENT counter that moves whenever the prop set changes (clear, restore). See `propRevisionCounter`. */
  get propRevision(): number {
    return this.propRevisionCounter;
  }

  /** The ground kind of a cell (GROUND_BASE / ALT / WATER); outside the map it reads as base ground. */
  groundAt(cell: Cell): GroundKind {
    if (!this.isInside(cell)) return GROUND_BASE;
    return this.map.ground[cell.y * this.width + cell.x] as GroundKind;
  }

  propAt(cell: Cell): PropPlacement | undefined {
    if (!this.isInside(cell)) return undefined;
    const id = this.propGrid[cell.y * this.width + cell.x];
    return id === 0 ? undefined : this.props.get(id);
  }

  /** The cells a prop covers (its footprint after rotation). */
  propFootprint(prop: PropPlacement): Cell[] {
    const kind = PROP_KIND_BY_ID.get(prop.kind);
    if (!kind) return [{ x: prop.x, y: prop.y }];
    const [w, d] = propFootprintSize(kind, prop.rotation);
    const cells: Cell[] = [];
    for (let dy = 0; dy < d; dy += 1) for (let dx = 0; dx < w; dx += 1) cells.push({ x: prop.x + dx, y: prop.y + dy });
    return cells;
  }

  /** Price to clear a prop under this park's construction multiplier; null = permanent. */
  clearCost(prop: PropPlacement): number | null {
    const base = PROP_KIND_BY_ID.get(prop.kind)?.clearCost ?? null;
    return base === null ? null : Math.round(base * this.constructionCostMultiplier);
  }

  /** A prop or water on a cell (never a path or an object: those are `objectAt` and `paths`). Null = open ground. */
  obstacleAt(cell: Cell): Obstacle | null {
    if (!this.isInside(cell)) return null;
    const prop = this.propAt(cell);
    if (prop) {
      const definition = PROP_KIND_BY_ID.get(prop.kind) as PropKindDefinition;
      return { kind: 'prop', prop, definition, cost: this.clearCost(prop) };
    }
    return this.map.ground[cell.y * this.width + cell.x] === GROUND_WATER ? { kind: 'water' } : null;
  }

  /** True when a prop or water stands on the cell: nothing can be built there. Outside the map reads as false. */
  isObstructed(cell: Cell): boolean {
    if (!this.isInside(cell)) return false;
    const index = cell.y * this.width + cell.x;
    return this.propGrid[index] !== 0 || this.map.ground[index] === GROUND_WATER;
  }

  /** What the bulldozer would do to the prop on `cell`, without doing it. */
  checkClear(cell: Cell): ClearCheck {
    const prop = this.propAt(cell);
    if (!prop) return { ok: false, reason: 'none', cost: null };
    const definition = PROP_KIND_BY_ID.get(prop.kind) as PropKindDefinition;
    const cost = this.clearCost(prop);
    if (cost === null) return { ok: false, reason: 'permanent', cost: null };
    // Every cell of the prop must be owned: clearing touches the whole footprint.
    if (this.propFootprint(prop).some((covered) => !this.isOwned(covered))) return { ok: false, reason: 'unowned', cost };
    if (this.cash < cost) return { ok: false, reason: 'funds', cost };
    return { ok: true, prop, definition, cost };
  }

  /** (Re)builds `props` and `propGrid` from a placement list. Callers bump the revision. */
  private installProps(placements: readonly PropPlacement[]): void {
    this.props.clear();
    this.propGrid.fill(0);
    for (const placement of placements) {
      const prop: PropPlacement = { id: placement.id, kind: placement.kind, x: placement.x, y: placement.y, rotation: placement.rotation };
      this.props.set(prop.id, prop);
      for (const cell of this.propFootprint(prop)) this.propGrid[cell.y * this.width + cell.x] = prop.id;
    }
  }

  /** Plain-data image of the map layer for the save: the ground and the REMAINING props. Pure. */
  serializeMap(): MapState {
    const props = [...this.props.values()].map((prop) => ({
      id: plainNumber(prop.id, 'map.props.id'),
      kind: prop.kind,
      x: plainNumber(prop.x, 'map.props.x'),
      y: plainNumber(prop.y, 'map.props.y'),
      rotation: prop.rotation,
    }));
    return {
      id: this.map.id,
      biomeId: this.map.biome.id,
      width: this.width,
      height: this.height,
      entrance: { x: this.entrance.x, y: this.entrance.y, facing: this.entranceFacing },
      ground: groundRowsOf(this.map.ground, this.width, this.height),
      props,
      recipe: this.map.recipe === null ? null : { ...this.map.recipe },
    };
  }

  /**
   * Replaces the live props with a saved map's. The state is validated COMPLETELY first (layoutFromState) and
   * its identity (id, biome, size, entrance, ground) must equal this world's map: an in-place restore never
   * swaps the land, a session built by `fromState` already has it. Bumps `propRevision`; notifies nobody (the
   * world restore that follows does).
   */
  restoreMap(state: MapState): void {
    if (this.batchDepth !== 0) {
      throw invalidState('GameWorld', 'batch', 'cannot be restored inside an open batch');
    }
    const layout = layoutFromState(state);
    const sameLand = layout.id === this.map.id
      && layout.biome.id === this.map.biome.id
      && layout.width === this.width
      && layout.height === this.height
      && layout.entrance.x === this.entrance.x
      && layout.entrance.y === this.entrance.y
      && layout.entrance.facing === this.entranceFacing
      && layout.groundKey === this.map.groundKey;
    if (!sameLand) throw invalidState('GameWorld', 'map', 'is a different map than this world was built on');
    this.installProps(layout.props);
    this.propRevisionCounter += 1;
  }

  /** Effective per-tile path cost under this park's ruleset. */
  get pathCost(): number {
    return Math.round(GAME_CONFIG.pathCost * this.constructionCostMultiplier);
  }

  /** This park's construction cost scaling, for costs the catalog cannot express on its own. */
  get constructionMultiplier(): number {
    return this.constructionCostMultiplier;
  }

  /** Effective build cost for a definition under this park's ruleset. */
  objectCost(definition: BuildDefinition): number {
    return Math.round(definition.buildCost * this.constructionCostMultiplier);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Phase 40: switches the front-access rule (ParkSession, from the ruleset). */
  setFrontAccess(on: boolean): void {
    this.frontAccess = on;
  }

  get frontAccessRule(): boolean {
    return this.frontAccess;
  }

  /** Phase 40: whether guests use this kind from its front only in this park. */
  frontAccessFor(definition: BuildDefinition): boolean {
    return this.frontAccess && isFrontOnly(definition);
  }

  /** Phase 40: whether the front of a footprint at this rotation looks onto a path. */
  frontFacesPath(definition: BuildDefinition, anchor: Cell, rotation: Rotation): boolean {
    return frontEdgeCells(definition, anchor, rotation).some((cell) => this.paths.has(cellKey(cell)));
  }

  /**
   * Phase 40: the rotation a front-only building should take here so its front looks onto a path: first a turn that
   * keeps its footprint (`sameFootprintRotations`), then a quarter turn of a non-square one where that fits at the same
   * anchor; the given rotation when the rule is off, the kind has no front, or no turn finds a path.
   */
  facingRotation(definition: BuildDefinition, anchor: Cell, rotation: Rotation): Rotation {
    if (!this.frontAccessFor(definition)) return rotation;
    const same = sameFootprintRotations(definition, rotation).find((turn) => this.frontFacesPath(definition, anchor, turn));
    if (same !== undefined) return same;
    // A quarter turn of a non-square footprint covers other cells: only where it fits at the same anchor.
    const quarter = ([1, 3] as const)
      .map((step) => ((rotation + step) % 4) as Rotation)
      .find((turn) => this.canPlace(definition, anchor, turn) && this.frontFacesPath(definition, anchor, turn));
    return quarter ?? rotation;
  }

  setBuildAccessPolicy(policy: BuildAccessPolicy | null): void {
    this.buildAccessPolicy = policy;
  }

  isDefinitionUnlocked(definitionId: string): boolean {
    return this.buildAccessPolicy?.isUnlocked(definitionId) ?? true;
  }

  /**
   * The gate as guests, rides and stalls see it: the manual park switch AND the opening hours.
   * `parkOpen` stays the player's own switch (it is what the toggle shows and what a save holds).
   */
  get gateOpen(): boolean {
    return this.parkOpen && (this.gateSchedule?.scheduleOpen ?? true);
  }

  /** Wired by the session to the park conditions; null (the default) means no opening hours. */
  setGateSchedule(schedule: GateSchedule | null): void {
    this.gateSchedule = schedule;
  }

  advanceTick(): void {
    this.tick += 1;
  }

  setParkOpen(open: boolean): void {
    this.parkOpen = open;
    this.changed();
  }

  isInside(cell: Cell): boolean {
    return cell.x >= 0 && cell.y >= 0 && cell.x < this.width && cell.y < this.height;
  }

  canPlacePath(cell: Cell): boolean {
    const key = cellKey(cell);
    if (!this.isOwned(cell) || this.paths.has(key) || this.isObstructed(cell) || this.occupancy.has(key)) return false;
    // Elevated coaster track leaves the ground free for a walkway underneath.
    const lowest = this.trackLayers.get(key)?.[0];
    return lowest === undefined || lowest.height >= GAME_CONFIG.coaster.pathClearanceHeight;
  }

  /**
   * A coaster piece fits on empty ground, above an existing path if it is high enough, and (Phase 38) over a low
   * object it clears, and over or under other track at least `trackClearanceLevels` away when neither piece is
   * exclusive. Checked against the WORLD only: a draft's own crossings are validateCoasterLayout's job.
   */
  canPlaceCoasterPiece(piece: CoasterPieceProbe): boolean {
    return this.coasterPieceConflict(piece) === null;
  }

  /**
   * Phase 38: why a coaster piece cannot go here, or null. 'track' = other track too close or not crossable,
   * 'object' = an object it does not clear (or the entrance), 'path' = a path under track below the clearance.
   */
  coasterPieceConflict(piece: CoasterPieceProbe): 'blocked' | 'object' | 'path' | 'track' | null {
    const key = cellKey(piece.cell);
    if (!this.isOwned(piece.cell) || this.isObstructed(piece.cell)) return 'blocked';
    const ground = this.occupancy.get(key);
    if (ground !== undefined) {
      const levels = ground === 0 ? undefined : this.groundClearanceLevels(ground);
      if (levels === undefined || piece.exclusive === true || piece.height < levels + 1) return 'object';
    }
    if (piece.height < GAME_CONFIG.coaster.pathClearanceHeight && this.paths.has(key)) return 'path';
    for (const layer of this.trackLayers.get(key) ?? []) {
      if (layer.exclusive || piece.exclusive === true || !trackPiecesMayCross(layer.height, piece.height)) return 'track';
    }
    return null;
  }

  /** Phase 38: the clearance a ground object needs from track above it, or undefined when track never crosses it. */
  private groundClearanceLevels(objectId: number): number | undefined {
    const object = this.objects.get(objectId);
    return object ? BUILD_BY_ID.get(object.definitionId)?.clearanceLevels : undefined;
  }

  /** Phase 38: whether an object of this definition may stand in a cell with track above it. */
  private clearsTrackAbove(definition: BuildDefinition, key: string): boolean {
    const layers = this.trackLayers.get(key);
    if (layers === undefined) return true;
    const levels = definition.clearanceLevels;
    return levels !== undefined && layers.every((layer) => !layer.exclusive && layer.height >= levels + 1);
  }

  /**
   * Phase 38: the track heights in a cell, lowest first, excluding coaster `exceptId` (a coaster's own pieces).
   * Renderers ask it whether a piece has something under it (then it stands on no support bent of its own).
   */
  trackHeightsAt(cell: Cell, exceptId = -1): number[] {
    const layers = this.trackLayers.get(cellKey(cell));
    if (layers === undefined) return [];
    const heights: number[] = [];
    for (const layer of layers) if (layer.id !== exceptId) heights.push(layer.height);
    return heights;
  }

  /** Phase 38: whether anything but a path stands or runs under a piece at `height` in this cell (track or an object). */
  hasSomethingUnder(cell: Cell, height: number): boolean {
    const key = cellKey(cell);
    if (this.occupancy.has(key)) return true;
    return (this.trackLayers.get(key) ?? []).some((layer) => layer.height < height);
  }

  canPlace(definition: BuildDefinition, anchor: Cell, rotation: Rotation = 0): boolean {
    if (definition.kind === 'path') return this.canPlacePath(anchor);
    for (const cell of this.footprintCells(definition, anchor, rotation)) {
      const key = cellKey(cell);
      if (!this.isOwned(cell) || this.paths.has(key) || this.occupancy.has(key) || this.isObstructed(cell)) return false;
      if (!this.clearsTrackAbove(definition, key)) return false;
    }
    return true;
  }

  /**
   * True when a footprint is off the map or stands on a path or an object (what 'blocked' means); land the park does not
   * own is 'unowned' (Phase 21), props and water are 'obstacle'. Blocked wins over unowned, unowned over obstacle.
   */
  private footprintConflict(definition: BuildDefinition, anchor: Cell, rotation: Rotation): 'blocked' | 'obstacle' | 'unowned' | null {
    let obstacle = false;
    let unowned = false;
    for (const cell of this.footprintCells(definition, anchor, rotation)) {
      const key = cellKey(cell);
      if (!this.isInside(cell) || this.paths.has(key) || this.occupancy.has(key) || !this.clearsTrackAbove(definition, key)) return 'blocked';
      if (!this.land.isCellOwned(cell.x, cell.y)) unowned = true;
      if (this.isObstructed(cell)) obstacle = true;
    }
    return unowned ? 'unowned' : obstacle ? 'obstacle' : null;
  }

  checkObjectBuild(definitionId: string, anchor: Cell, rotation: Rotation = 0): ObjectBuildCheck {
    const definition = BUILD_BY_ID.get(definitionId);
    if (!definition) return { ok: false, reason: 'unknown' };
    if (definition.kind === 'path') return { ok: false, reason: 'path' };
    if (definition.custom) return { ok: false, reason: 'custom' };
    if (!this.isDefinitionUnlocked(definitionId)) return { ok: false, reason: 'locked' };
    if (this.cash < this.objectCost(definition)) return { ok: false, reason: 'funds' };
    const conflict = this.footprintConflict(definition, anchor, rotation);
    if (conflict !== null) return { ok: false, reason: conflict };
    return { ok: true, definition };
  }

  /** The cells an existing object occupies — a coaster's whole track, or the footprint rect. */
  objectFootprint(object: PlacedObject): Cell[] {
    const coaster = this.coasters.get(object.id);
    if (coaster) return coaster.pieces.map((piece) => ({ ...piece.cell }));
    const definition = BUILD_BY_ID.get(object.definitionId);
    return definition ? this.footprintCells(definition, object.anchor, object.rotation) : [];
  }

  /** Operating numbers for a ride object: custom coaster stats win over catalog stats. */
  rideProfile(objectId: number): RideProfile | undefined {
    const object = this.objects.get(objectId);
    const definition = object ? BUILD_BY_ID.get(object.definitionId) : undefined;
    if (!object || definition?.kind !== 'ride') return undefined;
    const coaster = this.coasters.get(objectId);
    if (coaster) {
      return {
        name: definition.name,
        capacity: coaster.stats.capacity,
        duration: coaster.stats.durationSeconds,
        excitement: coaster.stats.excitement,
        intensity: coaster.stats.intensity,
        runningCost: coaster.stats.runningCost,
        ticketPrice: coaster.stats.ticketPrice,
        reliability: coaster.stats.reliability,
      };
    }
    return {
      name: definition.name,
      capacity: definition.stats?.capacity ?? 1,
      duration: definition.stats?.duration ?? 30,
      excitement: definition.stats?.excitement ?? 25,
      intensity: definition.stats?.intensity ?? 20,
      runningCost: definition.stats?.runningCost ?? 0,
      ticketPrice: definition.stats?.ticketPrice ?? 4,
      reliability: definition.stats?.reliability ?? 90,
    };
  }

  /** Places a validated coaster layout: charges the multiplied cost, occupies every track cell. */
  placeCoaster(
    definitionId: string,
    pieces: readonly CoasterPiece[],
    stats: CoasterDerivedStats,
    baseCost: number,
  ): PlacedObject | { error: 'blocked' | 'funds' | 'locked' | 'unknown' } {
    const definition = BUILD_BY_ID.get(definitionId);
    if (definition?.custom !== 'coaster') return { error: 'unknown' };
    if (!this.isDefinitionUnlocked(definitionId)) return { error: 'locked' };
    for (const [index, piece] of pieces.entries()) {
      if (!this.canPlaceCoasterPiece({ cell: piece.cell, height: piece.height, exclusive: isExclusiveCoasterPiece(pieces, index) })) {
        return { error: 'blocked' };
      }
    }
    const cost = Math.round(baseCost * this.constructionCostMultiplier);
    if (this.cash < cost) return { error: 'funds' };
    const placed: PlacedObject = {
      id: this.nextObjectId++,
      definitionId,
      anchor: { ...pieces[0].cell },
      rotation: 0,
    };
    this.objects.set(placed.id, placed);
    for (const [index, piece] of pieces.entries()) {
      addTrackLayer(this.trackLayers, cellKey(piece.cell), { id: placed.id, height: piece.height, exclusive: isExclusiveCoasterPiece(pieces, index) });
    }
    this.coasters.set(placed.id, {
      objectId: placed.id,
      // `freeClimb` is a key only when true: a chained piece keeps exactly the shape it always had.
      pieces: pieces.map((piece) => ({
        cell: { ...piece.cell },
        height: piece.height,
        special: piece.special,
        ...(piece.freeClimb === true ? { freeClimb: true } : {}),
      })),
      stats: { ...stats, travelSeconds: [...stats.travelSeconds] },
      paidCost: cost,
    });
    this.recordTransaction(-cost, `Built ${definition.name} (${pieces.length} pieces)`, 'construction');
    this.changed();
    return placed;
  }

  footprintCells(definition: BuildDefinition, anchor: Cell, rotation: Rotation = 0): Cell[] {
    const [width, depth] = footprintSize(definition, rotation);
    const cells: Cell[] = [];
    for (let y = 0; y < depth; y += 1) {
      for (let x = 0; x < width; x += 1) cells.push({ x: anchor.x + x, y: anchor.y + y });
    }
    return cells;
  }

  /** Builds every placeable tile it can afford, and reports exactly which ones it added. */
  buildPaths(cells: readonly Cell[]): { built: number; spent: number; added: Cell[] } {
    const unique = [...new Map(cells.map((cell) => [cellKey(cell), cell])).values()]
      .filter((cell) => this.canPlacePath(cell));
    const affordableCount = Math.min(unique.length, Math.floor(this.cash / Math.max(1, this.pathCost)));
    const accepted = unique.slice(0, affordableCount);
    if (accepted.length === 0) return { built: 0, spent: 0, added: [] };
    for (const cell of accepted) this.paths.add(cellKey(cell));
    this.pathVersion += 1;
    const spent = accepted.length * this.pathCost;
    this.recordTransaction(-spent, `Built ${accepted.length} path tile${accepted.length === 1 ? '' : 's'}`, 'construction');
    this.changed();
    return { built: accepted.length, spent, added: accepted.map((cell) => ({ ...cell })) };
  }

  /**
   * Builds a placed object. Phase 40: with the front-access rule on, a front-only building is turned to face a path
   * where its footprint allows (`facingRotation`), unless `exactRotation` (the player's own placement: the ghost
   * already showed the turn they chose).
   */
  buildObject(definitionId: string, anchor: Cell, rotation: Rotation = 0, options: { exactRotation?: boolean } = {}): PlacedObject | null {
    const requested = BUILD_BY_ID.get(definitionId);
    if (requested && options.exactRotation !== true) rotation = this.facingRotation(requested, anchor, rotation);
    const check = this.checkObjectBuild(definitionId, anchor, rotation);
    if (!check.ok) return null;
    const { definition } = check;
    const placed: PlacedObject = { id: this.nextObjectId++, definitionId, anchor: { ...anchor }, rotation };
    this.objects.set(placed.id, placed);
    for (const cell of this.footprintCells(definition, anchor, rotation)) this.occupancy.set(cellKey(cell), placed.id);
    this.recordTransaction(-this.objectCost(definition), `Built ${definition.name}`, 'construction');
    this.changed();
    return placed;
  }

  /**
   * The object in a cell: its ground occupant first (a bench under track, a stall), else (Phase 38) the top-most
   * track. The bulldozer takes what this returns, so a crossing loses its upper track before the lower one.
   */
  objectAt(cell: Cell): PlacedObject | undefined {
    const key = cellKey(cell);
    const id = this.occupancy.get(key);
    if (id) return this.objects.get(id);
    const layers = this.trackLayers.get(key);
    return layers === undefined ? undefined : this.objects.get(layers[layers.length - 1].id);
  }

  /** Phase 38: every object in a cell, top-most track first, then the ground occupant (each once). */
  objectsAt(cell: Cell): PlacedObject[] {
    const key = cellKey(cell);
    const found: PlacedObject[] = [];
    const layers = this.trackLayers.get(key) ?? [];
    for (let index = layers.length - 1; index >= 0; index -= 1) {
      const object = this.objects.get(layers[index].id);
      if (object && !found.includes(object)) found.push(object);
    }
    const id = this.occupancy.get(key);
    const ground = id ? this.objects.get(id) : undefined;
    if (ground) found.push(ground);
    return found;
  }

  /**
   * Removes one tile's worth of park and reports what went, so the toast can name it. A prop (Phase 24) is
   * CLEARED for its price instead (`cost` in the result, ledger category 'land-clearing'); a permanent prop
   * or too little cash refuses it with a typed reason and changes nothing. Water has nothing to remove.
   */
  bulldoze(cell: Cell): BulldozeResult {
    if (!this.isInside(cell) || (cell.x === this.entrance.x && cell.y === this.entrance.y)) {
      return { removed: false, refund: 0, label: null };
    }
    const key = cellKey(cell);
    // A walkway under elevated track is removed before the track itself.
    if (this.paths.has(key)) {
      this.paths.delete(key);
      this.pathVersion += 1;
      const refund = Math.floor(this.pathCost * GAME_CONFIG.bulldozeRefundRate);
      this.demolitions += 1;
      this.recordTransaction(refund, 'Recovered path materials', 'refund');
      this.changed();
      return { removed: true, refund, label: 'a path tile' };
    }
    const object = this.objectAt(cell);
    if (object) return this.demolishObject(object.id);
    const prop = this.propAt(cell);
    if (prop) {
      const check = this.checkClear(cell);
      if (!check.ok) {
        return { removed: false, refund: 0, label: null, ...(check.reason === 'none' ? {} : { refused: check.reason }) };
      }
      this.props.delete(prop.id);
      for (const occupied of this.propFootprint(prop)) this.propGrid[occupied.y * this.width + occupied.x] = 0;
      this.propRevisionCounter += 1;
      // Clearing is not a demolition (that counts park structures) and refunds nothing.
      this.recordTransaction(-check.cost, `Cleared ${check.definition.name}`, 'land-clearing');
      this.changed();
      return { removed: true, refund: 0, label: check.definition.name, cost: check.cost };
    }
    return { removed: false, refund: 0, label: null };
  }

  /**
   * The refund demolishing this placed object would pay (Phase 11, PA-015): the same `floor(cost × rate)` as
   * `demolishObject`, with a coaster refunding its `paidCost`. Null when no such object (or no definition) exists.
   * A pure read.
   */
  demolitionRefund(objectId: number): number | null {
    const object = this.objects.get(objectId);
    if (!object) return null;
    const definition = BUILD_BY_ID.get(object.definitionId);
    if (!definition) return null;
    const coaster = this.coasters.get(object.id);
    return Math.floor((coaster ? coaster.paidCost : this.objectCost(definition)) * GAME_CONFIG.bulldozeRefundRate);
  }

  /**
   * Removes one placed object (its whole footprint; a coaster goes whole) and refunds it (Phase 11, PA-015). This is
   * the object branch of `bulldoze(cell)`, which delegates here, so a demolition from the inspector and one from the
   * bulldozer are the same mutation. An unknown id (or a missing definition) changes nothing.
   */
  demolishObject(objectId: number): BulldozeResult {
    const object = this.objects.get(objectId);
    if (!object) return { removed: false, refund: 0, label: null };
    const definition = BUILD_BY_ID.get(object.definitionId);
    if (!definition) return { removed: false, refund: 0, label: null };
    const coaster = this.coasters.get(object.id);
    for (const occupied of this.objectFootprint(object)) {
      const key = cellKey(occupied);
      if (this.occupancy.get(key) === object.id) this.occupancy.delete(key);
      const layers = this.trackLayers.get(key);
      if (layers === undefined) continue;
      const kept = layers.filter((layer) => layer.id !== object.id);
      if (kept.length === 0) this.trackLayers.delete(key);
      else this.trackLayers.set(key, kept);
    }
    this.objects.delete(object.id);
    this.coasters.delete(object.id);
    const refund = Math.floor(
      (coaster ? coaster.paidCost : this.objectCost(definition)) * GAME_CONFIG.bulldozeRefundRate,
    );
    this.demolitions += 1;
    this.recordTransaction(refund, `Recovered materials from ${definition.name}`, 'refund');
    this.changed();
    return { removed: true, refund, label: definition.name };
  }

  /** Places scenario starter paths without spending cash or recording transactions. */
  seedScenarioPaths(cells: readonly Cell[]): number {
    let added = 0;
    for (const cell of cells) {
      if (!this.canPlacePath(cell)) continue;
      this.paths.add(cellKey(cell));
      added += 1;
    }
    if (added > 0) {
      this.pathVersion += 1;
      this.changed();
    }
    return added;
  }

  /** Places a scenario starter object without cost, transactions, or unlock checks. */
  seedScenarioObject(definitionId: string, anchor: Cell, rotation: Rotation = 0): PlacedObject | null {
    const definition = BUILD_BY_ID.get(definitionId);
    if (!definition || definition.kind === 'path') return null;
    // Phase 40: starting content faces its paths where the footprint allows (paths are seeded first).
    rotation = this.facingRotation(definition, anchor, rotation);
    if (!this.canPlace(definition, anchor, rotation)) return null;
    const placed: PlacedObject = { id: this.nextObjectId++, definitionId, anchor: { ...anchor }, rotation };
    this.objects.set(placed.id, placed);
    for (const cell of this.footprintCells(definition, anchor, rotation)) this.occupancy.set(cellKey(cell), placed.id);
    this.changed();
    return placed;
  }

  addMoney(amount: number, label = 'Developer grant'): void {
    this.recordTransaction(amount, label, 'grant');
    this.changed();
  }

  postTransaction(amount: number, label: string, category: TransactionCategory = 'other'): void {
    this.recordTransaction(amount, label, category);
  }

  /**
   * TRANSIENT, monotone within this instance: +1 on every colour change and on restore. Never saved
   * and never read by a simulation owner. It is deliberately NOT `version`: bumping `version` would
   * re-sync scenery, invalidate guest routes and management caches and so change the simulation,
   * while a colour is cosmetic. Renderers diff the per-object record by identity; the app adds this
   * to `version` for its undo and save-dirty stamp.
   */
  get appearanceVersion(): number {
    return this.appearanceCounter;
  }

  /** The object's colour record, or null when every slot is default. */
  objectColours(objectId: number): ObjectColours | null {
    return this.objects.get(objectId)?.colours ?? null;
  }

  /**
   * Recolours one object. Strict: `colours.length` must equal the definition's slot count and every
   * entry must be null or a swatch index; an all-null array clears. Free, no transaction, no
   * `version` or `pathVersion` bump. Bumps `appearanceVersion` and notifies listeners (once per batch)
   * only when the stored record actually changed.
   */
  setObjectColours(objectId: number, colours: readonly (number | null)[]): ColourEditResult {
    const object = this.objects.get(objectId);
    if (!object) return { ok: false, reason: 'unknown-object' };
    if (colourSlotsFor(object.definitionId).length === 0) return { ok: false, reason: 'not-colourable' };
    const record = validateObjectColours(object.definitionId, colours);
    if (record === 'invalid') return { ok: false, reason: 'invalid-colours' };
    if (sameObjectColours(object.colours, record)) return { ok: true, changed: false };
    if (record) object.colours = record;
    else delete object.colours;
    this.appearanceChanged();
    return { ok: true, changed: true };
  }

  /** Back to the default colours (a no-op, `changed: false`, when there is no record). */
  clearObjectColours(objectId: number): ColourEditResult {
    const object = this.objects.get(objectId);
    if (!object) return { ok: false, reason: 'unknown-object' };
    if (colourSlotsFor(object.definitionId).length === 0) return { ok: false, reason: 'not-colourable' };
    if (!object.colours) return { ok: true, changed: false };
    delete object.colours;
    this.appearanceChanged();
    return { ok: true, changed: true };
  }

  /**
   * The entrance gate's colours (Phase 28 step 2): a park-level record, aligned with
   * colourSlotsFor(ENTRANCE_COLOUR_ID) (arch, sign, posts); null when every slot is default. The gate is
   * not a placed object, so it has its own field, saved as `gateColours`. Frozen and replaced on change.
   */
  get gateColours(): ObjectColours | null {
    return this.gateRecord;
  }

  /** Recolours the gate. Same contract as setObjectColours: strict, free, `appearanceVersion` only. */
  setGateColours(colours: readonly (number | null)[]): ColourEditResult {
    const record = validateObjectColours(ENTRANCE_COLOUR_ID, colours);
    if (record === 'invalid') return { ok: false, reason: 'invalid-colours' };
    if (sameObjectColours(this.gateRecord, record)) return { ok: true, changed: false };
    this.gateRecord = record;
    this.appearanceChanged();
    return { ok: true, changed: true };
  }

  /** Back to the shipped gate colours (a no-op, `changed: false`, when there is no record). */
  clearGateColours(): ColourEditResult {
    if (!this.gateRecord) return { ok: true, changed: false };
    this.gateRecord = null;
    this.appearanceChanged();
    return { ok: true, changed: true };
  }

  /**
   * Applies several recolours as ONE gesture (a paint drag, a whole-park preset): one listener
   * notification at the end, `appearanceVersion` +1 per changed record, `version` untouched, no
   * transaction. A refused edit does not stop the others and changes nothing. Edits that leave a record
   * as it is are not counted.
   */
  recolourBatch(edits: readonly ColourEdit[]): ColourBatchResult {
    const changedObjectIds: number[] = [];
    const refused: { index: number; reason: 'unknown-object' | 'not-colourable' | 'invalid-colours' }[] = [];
    let gateChanged = false;
    this.batch(() => {
      edits.forEach((edit, index) => {
        const colours = edit.colours;
        let result: ColourEditResult;
        if ('gate' in edit) {
          result = colours === null ? this.clearGateColours() : this.setGateColours(colours);
          if (result.ok && result.changed) gateChanged = true;
        } else {
          result = colours === null ? this.clearObjectColours(edit.objectId) : this.setObjectColours(edit.objectId, colours);
          if (result.ok && result.changed) changedObjectIds.push(edit.objectId);
        }
        if (!result.ok) refused.push({ index, reason: result.reason });
      });
    });
    return { changedObjectIds, gateChanged, changedCount: changedObjectIds.length + (gateChanged ? 1 : 0), refused };
  }

  /**
   * One named preset on the whole park: every colourable placed object and the gate get the preset's record
   * (replacing what they had), as one batch. Objects that already match are not counted. Free; the app
   * charges `changedCount` objects through colourCost and takes ONE undo entry. An unknown preset id
   * changes nothing.
   */
  applyPresetToPark(presetId: ColourPresetId): ColourBatchResult {
    if (!COLOUR_PRESET_BY_ID.has(presetId)) return { changedObjectIds: [], gateChanged: false, changedCount: 0, refused: [] };
    const edits: ColourEdit[] = [];
    for (const object of this.objects.values()) {
      if (colourSlotsFor(object.definitionId).length === 0) continue;
      edits.push({ objectId: object.id, colours: presetRecord(object.definitionId, presetId) });
    }
    edits.push({ gate: true, colours: presetRecord(ENTRANCE_COLOUR_ID, presetId) });
    return this.recolourBatch(edits);
  }

  snapshot(): WorldSnapshot {
    return { cash: this.cash, pathCount: this.paths.size - 1, objectCount: this.objects.size, tick: this.tick, parkOpen: this.parkOpen };
  }

  private recordTransaction(amount: number, label: string, category: TransactionCategory): void {
    this.cash += amount;
    // `recordTransaction(-cost)` with a free item is -0; a save must never contain it (JSON writes
    // it as 0, so a restored park would differ from a never-saved one under Object.is).
    const normalizedAmount = amount === 0 ? 0 : amount;
    this.transactions.unshift({
      id: this.nextTransactionId++,
      amount: normalizedAmount,
      label,
      category,
      tick: this.tick,
    });
    if (this.transactions.length > TRANSACTION_HISTORY_LIMIT) this.transactions.length = TRANSACTION_HISTORY_LIMIT;
  }

  /**
   * Plain-data image of everything in this world that influences the future. Pure: it allocates
   * no ids, bumps no version and notifies nobody. Occupancy and coaster heights are derived and
   * rebuilt by restore; the paths Set is written in INSERTION order because a bulldoze-and-rebuild
   * re-adds at the end and PathNetwork (and so guest wandering) copies that order.
   */
  serialize(): GameWorldState {
    if (this.batchDepth !== 0) {
      throw new Error('GameWorld cannot serialize inside an open batch: half a construction gesture must not be captured');
    }
    const cellState = (cell: Cell, path: string): CellState => ({
      x: plainNumber(cell.x, `${path}.x`),
      y: plainNumber(cell.y, `${path}.y`),
    });
    const paths: CellState[] = [];
    for (const key of this.paths) {
      const [x, y] = key.split(',').map(Number);
      paths.push(cellState({ x, y }, `paths[${paths.length}]`));
    }
    const objects: PlacedObjectState[] = [];
    for (const object of this.objects.values()) {
      const path = `objects[${objects.length}]`;
      const state: PlacedObjectState = {
        id: plainNumber(object.id, `${path}.id`),
        definitionId: object.definitionId,
        anchor: cellState(object.anchor, `${path}.anchor`),
        rotation: object.rotation,
      };
      // Written only when at least one slot is recoloured, so an uncoloured park serializes exactly
      // as it did before schema 6 (and hashes the same).
      if (object.colours) state.colours = [...object.colours];
      objects.push(state);
    }
    const coasters: CoasterRecordState[] = [];
    for (const record of this.coasters.values()) {
      const path = `coasters[${coasters.length}]`;
      const pieces = record.pieces.map((piece, index): CoasterPieceState => {
        const piecePath = `${path}.pieces[${index}]`;
        const state: CoasterPieceState = {
          cell: cellState(piece.cell, `${piecePath}.cell`),
          height: plainNumber(piece.height, `${piecePath}.height`),
        };
        if (piece.special !== undefined) state.special = piece.special;
        if (piece.freeClimb === true) state.freeClimb = true;
        return state;
      });
      const stats = record.stats;
      coasters.push({
        objectId: plainNumber(record.objectId, `${path}.objectId`),
        pieces,
        stats: {
          pieces: plainNumber(stats.pieces, `${path}.stats.pieces`),
          turns: plainNumber(stats.turns, `${path}.stats.turns`),
          drops: plainNumber(stats.drops, `${path}.stats.drops`),
          totalDescent: plainNumber(stats.totalDescent, `${path}.stats.totalDescent`),
          biggestDrop: plainNumber(stats.biggestDrop, `${path}.stats.biggestDrop`),
          highestHeight: plainNumber(stats.highestHeight, `${path}.stats.highestHeight`),
          loops: plainNumber(stats.loops, `${path}.stats.loops`),
          boosts: plainNumber(stats.boosts, `${path}.stats.boosts`),
          topSpeed: plainNumber(stats.topSpeed, `${path}.stats.topSpeed`),
          excitement: plainNumber(stats.excitement, `${path}.stats.excitement`),
          intensity: plainNumber(stats.intensity, `${path}.stats.intensity`),
          durationSeconds: plainNumber(stats.durationSeconds, `${path}.stats.durationSeconds`),
          travelSeconds: stats.travelSeconds.map((seconds, index) => (
            plainNumber(seconds, `${path}.stats.travelSeconds[${index}]`)
          )),
          capacity: plainNumber(stats.capacity, `${path}.stats.capacity`),
          runningCost: plainNumber(stats.runningCost, `${path}.stats.runningCost`),
          ticketPrice: plainNumber(stats.ticketPrice, `${path}.stats.ticketPrice`),
          reliability: plainNumber(stats.reliability, `${path}.stats.reliability`),
        },
        paidCost: plainNumber(record.paidCost, `${path}.paidCost`),
      });
    }
    const transactions = this.transactions.map((transaction, index): TransactionState => ({
      id: plainNumber(transaction.id, `transactions[${index}].id`),
      amount: plainNumber(transaction.amount, `transactions[${index}].amount`),
      label: transaction.label,
      category: transaction.category,
      tick: plainNumber(transaction.tick, `transactions[${index}].tick`),
    }));
    return {
      mapWidth: this.width,
      mapHeight: this.height,
      constructionCostMultiplier: plainNumber(this.constructionCostMultiplier, 'constructionCostMultiplier'),
      cash: plainNumber(this.cash, 'cash'),
      tick: plainNumber(this.tick, 'tick'),
      parkOpen: this.parkOpen,
      demolitions: plainNumber(this.demolitions, 'demolitions'),
      nextObjectId: plainNumber(this.nextObjectId, 'nextObjectId'),
      nextTransactionId: plainNumber(this.nextTransactionId, 'nextTransactionId'),
      version: plainNumber(this.version, 'version'),
      pathVersion: plainNumber(this.pathVersion, 'pathVersion'),
      // Written only when the gate is recoloured, so an uncoloured park serializes without the key.
      ...(this.gateRecord ? { gateColours: [...this.gateRecord] } : {}),
      // Written only when the land is restricted (Phase 21), so a wholly owned park serializes without the key.
      ...(this.land.restricted ? { land: { parcelSize: GAME_CONFIG.land.parcelSize, owned: this.land.ownedParcels() } } : {}),
      paths,
      objects,
      coasters,
      transactions,
    };
  }

  /**
   * Replaces this world's park with a saved one. Everything is validated against scratch
   * structures first, so a rejected save leaves the world exactly as it was; the apply phase
   * only copies and cannot throw. Listeners, the build-access closure, the batch state, the cost
   * multiplier and the entrance are not part of a save and are never touched. `version` and
   * `pathVersion` are restored verbatim (other owners compare them for equality), so this
   * notifies listeners once without going through changed(), which would bump the version.
   */
  restore(state: GameWorldState): void {
    if (this.batchDepth !== 0) {
      throw invalidState('GameWorld', 'batch', 'cannot be restored inside an open batch');
    }
    const plan = this.validateState(state);

    this.land.assign(plan.ownedParcels);
    this.landRevisionCounter += 1;
    this.paths.clear();
    for (const key of plan.pathKeys) this.paths.add(key);
    this.objects.clear();
    this.coasters.clear();
    this.occupancy.clear();
    this.trackLayers.clear();
    for (const [key, id] of plan.occupancy) this.occupancy.set(key, id);
    for (const [key, layers] of plan.trackLayers) this.trackLayers.set(key, layers);
    for (const object of state.objects) {
      const colours = plan.colours.get(object.id);
      this.objects.set(object.id, {
        id: object.id,
        definitionId: object.definitionId,
        anchor: { x: object.anchor.x, y: object.anchor.y },
        rotation: object.rotation,
        ...(colours ? { colours } : {}),
      });
    }
    for (const record of state.coasters) {
      this.coasters.set(record.objectId, {
        objectId: record.objectId,
        // `special` stays a present key holding undefined for plain track, exactly like placeCoaster.
        pieces: record.pieces.map((piece) => ({
          cell: { x: piece.cell.x, y: piece.cell.y },
          height: piece.height,
          special: piece.special,
          ...(piece.freeClimb === true ? { freeClimb: true } : {}),
        })),
        stats: copyCoasterStats(record.stats),
        paidCost: record.paidCost,
      });
    }
    // Same array identity: other owners and the UI hold this reference.
    this.transactions.length = 0;
    for (const transaction of state.transactions) {
      this.transactions.push({
        id: transaction.id,
        amount: transaction.amount,
        label: transaction.label,
        category: transaction.category,
        tick: transaction.tick,
      });
    }
    this.cash = state.cash;
    this.tick = state.tick;
    this.parkOpen = state.parkOpen;
    this.demolitions = state.demolitions;
    this.nextObjectId = state.nextObjectId;
    this.nextTransactionId = state.nextTransactionId;
    this.version = state.version;
    this.pathVersion = state.pathVersion;
    // Cosmetic like object colours: normalised, never refused (a bad entry is the default).
    this.gateRecord = normaliseObjectColours(ENTRANCE_COLOUR_ID, state.gateColours);
    this.appearanceCounter += 1;
    this.notifyListeners();
  }

  /** Every check restore makes, with no side effect on this world. Returns the derived indexes. */
  private validateState(state: GameWorldState): {
    ownedParcels: number[] | null;
    pathKeys: string[];
    occupancy: Map<string, number>;
    trackLayers: Map<string, TrackLayer[]>;
    colours: Map<number, ObjectColours>;
  } {
    const fail = (path: string, problem: string): never => {
      throw invalidState('GameWorld', path, problem);
    };
    if (!isPlainObject(state)) return fail('state', 'is not an object');
    if (state.mapWidth !== this.width) fail('mapWidth', `is ${String(state.mapWidth)} but this map is ${this.width} wide`);
    if (state.mapHeight !== this.height) fail('mapHeight', `is ${String(state.mapHeight)} but this map is ${this.height} tall`);
    if (state.constructionCostMultiplier !== this.constructionCostMultiplier) {
      fail(
        'constructionCostMultiplier',
        `is ${String(state.constructionCostMultiplier)} but this world was built with ${this.constructionCostMultiplier}`,
      );
    }
    if (typeof state.cash !== 'number' || !Number.isFinite(state.cash) || Math.abs(state.cash) > MAXIMUM_SAVED_AMOUNT) {
      fail('cash', `is not a finite number within +-${MAXIMUM_SAVED_AMOUNT}`);
    }
    if (typeof state.parkOpen !== 'boolean') fail('parkOpen', 'is not a boolean');
    const counters: Array<[string, unknown, number]> = [
      ['tick', state.tick, 0],
      ['demolitions', state.demolitions, 0],
      ['nextObjectId', state.nextObjectId, 1],
      ['nextTransactionId', state.nextTransactionId, 1],
      ['version', state.version, 0],
      ['pathVersion', state.pathVersion, 0],
    ];
    for (const [name, value, minimum] of counters) {
      // The upper bound keeps `id + 1` exact (above 2^53 it is not) and stamps sane on every history entry.
      if (!isInteger(value) || value < minimum || value > MAXIMUM_SAVED_COUNTER) {
        fail(name, `must be an integer in ${minimum}..${MAXIMUM_SAVED_COUNTER}`);
      }
    }
    for (const name of ['paths', 'objects', 'coasters', 'transactions'] as const) {
      if (!Array.isArray(state[name])) fail(name, 'is not an array');
    }

    // Phase 21: the owned land (absent = the whole map). Validated against a scratch ownership first.
    let ownedParcels: number[] | null = null;
    const scratchLand = new LandOwnership(this.width, this.height, this.entrance, null);
    if (state.land !== undefined) {
      const land: unknown = state.land;
      if (!isPlainObject(land)) return fail('land', 'is not an object');
      if (land.parcelSize !== GAME_CONFIG.land.parcelSize) fail('land.parcelSize', `must be ${GAME_CONFIG.land.parcelSize}`);
      const problem = checkOwnedParcels(scratchLand.grid, scratchLand.gateParcel, land.owned);
      if (problem !== null) fail('land.owned', problem);
      ownedParcels = [...(land.owned as number[])];
      scratchLand.assign(ownedParcels);
    }
    const checkOwned = (cell: Cell, path: string): void => {
      if (!scratchLand.isCellOwned(cell.x, cell.y)) fail(path, `is on land the park does not own at ${cellKey(cell)}`);
    };

    const checkCell = (cell: unknown, path: string): void => {
      if (!isPlainObject(cell) || !isInteger(cell.x) || !isInteger(cell.y)) fail(path, 'is not an integer cell');
      if (!this.isInside(cell as unknown as Cell)) fail(path, 'is outside the map');
    };

    const pathKeys: string[] = [];
    const pathSet = new Set<string>();
    state.paths.forEach((cell, index) => {
      checkCell(cell, `paths[${index}]`);
      const key = cellKey(cell);
      if (pathSet.has(key)) fail(`paths[${index}]`, `repeats ${key}`);
      if (this.isObstructed(cell) && key !== cellKey(this.entrance)) fail(`paths[${index}]`, `is on a prop or water at ${key}`);
      checkOwned(cell, `paths[${index}]`);
      pathSet.add(key);
      pathKeys.push(key);
    });
    if (!pathSet.has(cellKey(this.entrance))) fail('paths', 'does not contain the park entrance');

    // Coaster records first, so objects can be matched against them.
    const recordById = new Map<number, CoasterRecordState>();
    const coasterConfig = GAME_CONFIG.coaster;
    let previousRecordId = 0;
    state.coasters.forEach((record, index) => {
      const path = `coasters[${index}]`;
      if (!isPlainObject(record) || !isInteger(record.objectId)) return fail(path, 'has no integer objectId');
      if (record.objectId <= previousRecordId) fail(`${path}.objectId`, 'is not strictly ascending');
      previousRecordId = record.objectId;
      if (typeof record.paidCost !== 'number' || !Number.isFinite(record.paidCost) || record.paidCost < 0 || record.paidCost > MAXIMUM_SAVED_AMOUNT) {
        fail(`${path}.paidCost`, 'is not a finite non-negative number');
      }
      if (!Array.isArray(record.pieces)) return fail(`${path}.pieces`, 'is not an array');
      if (record.pieces.length < coasterConfig.minimumPieces || record.pieces.length > coasterConfig.maximumPieces) {
        fail(
          `${path}.pieces`,
          `has ${record.pieces.length} pieces, outside ${coasterConfig.minimumPieces}..${coasterConfig.maximumPieces}`,
        );
      }
      record.pieces.forEach((piece, pieceIndex) => {
        const piecePath = `${path}.pieces[${pieceIndex}]`;
        if (!isPlainObject(piece)) return fail(piecePath, 'is not an object');
        checkCell(piece.cell, `${piecePath}.cell`);
        if (!isInteger(piece.height) || piece.height < 0 || piece.height > coasterConfig.absoluteMaximumHeight) {
          fail(`${piecePath}.height`, `must be an integer 0..${coasterConfig.absoluteMaximumHeight}`);
        }
        if (piece.special !== undefined && piece.special !== 'loop' && piece.special !== 'boost') {
          fail(`${piecePath}.special`, 'is not loop or boost');
        }
        if (piece.freeClimb !== undefined && piece.freeClimb !== true) fail(`${piecePath}.freeClimb`, 'is not true');
      });
      if (!isPlainObject(record.stats)) return fail(`${path}.stats`, 'is not an object');
      const stats = record.stats as unknown as Record<string, unknown>;
      for (const key of COASTER_STAT_KEYS) {
        const value = stats[key];
        if (typeof value !== 'number' || !Number.isFinite(value)) fail(`${path}.stats.${key}`, 'is not a finite number');
      }
      const travelRaw: unknown = stats.travelSeconds;
      if (!Array.isArray(travelRaw) || travelRaw.some((value: unknown) => typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1_000)) {
        return fail(`${path}.stats.travelSeconds`, 'is not an array of positive finite numbers');
      }
      // The train animation indexes travelSeconds by piece: a length mismatch reads past the end.
      if (travelRaw.length !== record.pieces.length) {
        fail(`${path}.stats.travelSeconds`, `has ${travelRaw.length} entries for ${record.pieces.length} pieces`);
      }
      // Balance-derived numbers are saved verbatim (see CoasterStatsState), so they are only
      // range-checked; a forged excitement of 1e9 or a negative capacity must not run a park.
      const bounded = (key: (typeof COASTER_STAT_KEYS)[number], maximum: number, minimum = 0): void => {
        const value = stats[key] as number;
        if (value < minimum || value > maximum) fail(`${path}.stats.${key}`, `must be within ${minimum}..${maximum}`);
      };
      bounded('excitement', 100);
      bounded('intensity', 100);
      bounded('reliability', 100);
      bounded('topSpeed', 1_000);
      bounded('durationSeconds', 100_000);
      bounded('runningCost', MAXIMUM_SAVED_PRICE);
      bounded('ticketPrice', MAXIMUM_SAVED_PRICE);
      bounded('capacity', 1_000, 1);
      if (!isInteger(stats.capacity)) fail(`${path}.stats.capacity`, 'must be an integer');
      recordById.set(record.objectId, record);
    });

    const occupancy = new Map<string, number>([[cellKey(this.entrance), 0]]);
    const trackLayers = new Map<string, TrackLayer[]>();
    const colours = new Map<number, ObjectColours>();
    // Phase 38: ground objects claim first (in id order), track second, so a crossing is checked whatever the ids.
    const pendingTrack: Array<{ key: string; layer: TrackLayer; path: string }> = [];
    const claim = (cell: Cell, id: number, path: string): void => {
      const key = cellKey(cell);
      if (occupancy.has(key)) fail(path, `overlaps another object or the entrance at ${key}`);
      if (this.isObstructed(cell)) fail(path, `stands on a prop or water at ${key}`);
      checkOwned(cell, path);
      occupancy.set(key, id);
    };
    let previousId = 0;
    const objectIds = new Set<number>();
    state.objects.forEach((object, index) => {
      const path = `objects[${index}]`;
      if (!isPlainObject(object) || !isInteger(object.id) || object.id < 1) return fail(`${path}.id`, 'must be an integer >= 1');
      if (object.id <= previousId) fail(`${path}.id`, 'is not strictly ascending');
      previousId = object.id;
      if (object.id >= state.nextObjectId) fail(`${path}.id`, `is not below nextObjectId ${state.nextObjectId}`);
      if (typeof object.definitionId !== 'string') return fail(`${path}.definitionId`, 'is not a string');
      const definition = BUILD_BY_ID.get(object.definitionId);
      if (!definition) return fail(`${path}.definitionId`, `names unknown definition '${object.definitionId}'`);
      if (definition.kind === 'path') fail(`${path}.definitionId`, 'is a path, which is never a placed object');
      if (object.rotation !== 0 && object.rotation !== 1 && object.rotation !== 2 && object.rotation !== 3) {
        fail(`${path}.rotation`, 'must be 0, 1, 2 or 3');
      }
      checkCell(object.anchor, `${path}.anchor`);
      // Phase 28: colours are cosmetic and are normalised, never refused (see normaliseObjectColours).
      const normalised = normaliseObjectColours(object.definitionId, object.colours);
      if (normalised) colours.set(object.id, normalised);
      objectIds.add(object.id);
      const record = recordById.get(object.id);
      if (definition.custom === 'coaster') {
        if (!record) return fail(path, `is a coaster but has no coaster record`);
        record.pieces.forEach((piece, pieceIndex) => {
          const piecePath = `${path} (coaster piece ${pieceIndex})`;
          if (this.isObstructed(piece.cell)) fail(piecePath, `stands on a prop or water at ${cellKey(piece.cell)}`);
          checkOwned(piece.cell, piecePath);
          pendingTrack.push({
            key: cellKey(piece.cell),
            layer: { id: object.id, height: piece.height, exclusive: isExclusiveCoasterPiece(record.pieces, pieceIndex) },
            path: piecePath,
          });
          // Track low enough to touch the ground cannot stand on a walkway (placement forbids it).
          if (pathSet.has(cellKey(piece.cell)) && piece.height < coasterConfig.pathClearanceHeight) {
            fail(`${path} (coaster piece ${pieceIndex})`, 'sits on a path below the clearance height');
          }
        });
        const first = record.pieces[0].cell;
        if (object.anchor.x !== first.x || object.anchor.y !== first.y) {
          fail(`${path}.anchor`, 'is not the first coaster piece');
        }
        // Geometry rules and the geometry-only stats: a layout the designer could never have
        // produced (a 0-to-3 height jump, swapped cells) would run on physics nobody tested.
        // Pure geometry is safe to compare exactly; the balance numbers were range-checked above.
        // A future tightening of validateCoasterLayout therefore needs a save migration.
        const type = COASTER_TYPES.find((candidate) => candidate.definitionId === object.definitionId);
        if (!type) return fail(`${path}.definitionId`, 'is a coaster without a coaster type');
        const layout = validateCoasterLayout(record.pieces, type);
        if (!layout.ok) fail(`${path} (coaster)`, `is not a valid layout (${layout.reason} at piece ${String(layout.pieceIndex)})`);
        const derived = deriveCoasterStats(record.pieces, type);
        for (const key of COASTER_GEOMETRY_STAT_KEYS) {
          if (record.stats[key] !== derived[key]) {
            fail(`${path}.stats.${key}`, `is ${String(record.stats[key])} but the layout implies ${derived[key]}`);
          }
        }
      } else {
        if (record) fail(path, 'has a coaster record but is not a coaster');
        for (const cell of this.footprintCells(definition, object.anchor, object.rotation)) {
          if (!this.isInside(cell)) return fail(path, 'has a footprint outside the map');
          claim(cell, object.id, path);
          if (pathSet.has(cellKey(cell))) fail(path, `stands on a path at ${cellKey(cell)}`);
        }
      }
    });
    for (const id of recordById.keys()) {
      if (!objectIds.has(id)) fail('coasters', `has a record for object ${id}, which does not exist`);
    }
    for (const { key, layer, path } of pendingTrack) {
      const ground = occupancy.get(key);
      if (ground !== undefined) {
        const groundObject = state.objects.find((candidate) => candidate.id === ground);
        const levels = groundObject ? BUILD_BY_ID.get(groundObject.definitionId)?.clearanceLevels : undefined;
        if (levels === undefined || layer.exclusive || layer.height < levels + 1) fail(path, `overlaps another object or the entrance at ${key}`);
      }
      for (const other of trackLayers.get(key) ?? []) {
        if (other.exclusive || layer.exclusive || !trackPiecesMayCross(other.height, layer.height)) {
          fail(path, `crosses other track too closely at ${key}`);
        }
      }
      addTrackLayer(trackLayers, key, layer);
    }

    if (state.transactions.length > TRANSACTION_HISTORY_LIMIT) {
      fail('transactions', `has ${state.transactions.length} entries, above the ${TRANSACTION_HISTORY_LIMIT} cap`);
    }
    let previousTransactionId = Number.POSITIVE_INFINITY;
    state.transactions.forEach((transaction, index) => {
      const path = `transactions[${index}]`;
      if (!isPlainObject(transaction) || !isInteger(transaction.id) || transaction.id < 1) {
        return fail(`${path}.id`, 'must be an integer >= 1');
      }
      if (transaction.id >= previousTransactionId) fail(`${path}.id`, 'is not strictly descending (newest first)');
      previousTransactionId = transaction.id;
      if (transaction.id >= state.nextTransactionId) fail(`${path}.id`, `is not below nextTransactionId ${state.nextTransactionId}`);
      if (typeof transaction.amount !== 'number' || !Number.isFinite(transaction.amount) || Math.abs(transaction.amount) > MAXIMUM_SAVED_AMOUNT) {
        fail(`${path}.amount`, 'is not finite or is implausibly large');
      }
      if (typeof transaction.label !== 'string') fail(`${path}.label`, 'is not a string');
      if (!Object.hasOwn(TRANSACTION_CATEGORIES, transaction.category)) fail(`${path}.category`, 'is not a known category');
      if (!isInteger(transaction.tick) || transaction.tick < 0 || transaction.tick > state.tick) {
        fail(`${path}.tick`, `must be an integer in 0..${state.tick} (a transaction cannot be from the future)`);
      }
    });

    return { ownedParcels, pathKeys, occupancy, trackLayers, colours };
  }

  /**
   * Runs several mutations as one gesture: `version` still advances per mutation so every cache
   * invalidates correctly, but listeners are notified once at the end. Dragging the bulldozer
   * across ten tiles is one construction gesture and should cost one rebuild, not ten.
   */
  batch<T>(run: () => T): T {
    this.batchDepth += 1;
    try {
      return run();
    } finally {
      this.batchDepth -= 1;
      if (this.batchDepth === 0 && this.batchedChange) {
        this.batchedChange = false;
        this.notifyListeners();
      }
    }
  }

  private changed(): void {
    this.version += 1;
    if (this.batchDepth > 0) {
      this.batchedChange = true;
      return;
    }
    this.notifyListeners();
  }

  /** A cosmetic change: notifies like changed() but leaves `version` (and so every simulation cache) alone. */
  private appearanceChanged(): void {
    this.appearanceCounter += 1;
    if (this.batchDepth > 0) {
      this.batchedChange = true;
      return;
    }
    this.notifyListeners();
  }

  private notifyListeners(): void {
    for (const listener of this.listeners) listener();
  }
}
