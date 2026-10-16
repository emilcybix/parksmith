import type { BuildKind, Cell } from '../types';

/** How a building is grouped in the overview; finer than `BuildKind` for shops and amenities. */
export type BuildingGroup = 'ride' | 'food' | 'drink' | 'toilet' | 'souvenir' | 'bin' | 'scenery' | 'other';

/**
 * One placed building, flattened for the estate overview: whatever the player would want to
 * compare across the whole park in one list. Every number comes from the owning simulation,
 * never recomputed here.
 */
export interface BuildingSnapshot {
  objectId: number;
  definitionId: string;
  name: string;
  icon: string;
  kind: BuildKind;
  group: BuildingGroup;
  anchor: Cell;
  footprint: readonly [number, number];
  /** Null for buildings that have no open/closed state, such as scenery. */
  open: boolean | null;
  status: string | null;
  /** Ticket price for rides, item price for services. */
  price: number | null;
  queueLength: number | null;
  waitSeconds: number | null;
  /** Riders or customers served this session. */
  served: number | null;
  throughputPerHour: number | null;
  revenue: number | null;
  satisfaction: number | null;
  condition: number | null;
  sceneryScore: number | null;
  /** One line of specifics for this kind of building. */
  detail: string;
}
