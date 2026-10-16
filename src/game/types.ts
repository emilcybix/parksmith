import type { ObjectColours } from './content/colours';

export type Cell = { x: number; y: number };

/** Quarter turns clockwise. Only footprint orientation depends on it, never cost or stats. */
export type Rotation = 0 | 1 | 2 | 3;

export type BuildCategory =
  | 'paths'
  | 'rides'
  | 'shops'
  | 'facilities'
  | 'comforts'
  | 'scenery';

/**
 * Phase 29: the keepsakes souvenir stalls sell. A guest holds each at most once (a bit in `Guest.souvenirs`): an umbrella
 * keeps the rain off, a sun hat the heat, a balloon and a plush lift the mood, a glow wand lights up the night.
 */
export const SOUVENIR_KINDS = ['umbrella', 'hat', 'balloon', 'plush', 'glowWand'] as const;
export type SouvenirKind = (typeof SOUVENIR_KINDS)[number];

export type BuildKind = 'path' | 'ride' | 'shop' | 'facility' | 'amenity' | 'scenery';

/**
 * Phase 16: the theme vocabulary of rides, stalls and scenery (and of a biome's local style). A themed ride or stall
 * gains a small, bounded scenery bonus from same-theme scenery within reach when its park's ruleset has `themeAffinity`.
 */
export const SCENERY_THEME_IDS = ['garden', 'seaside', 'adventure', 'futuristic', 'carnival'] as const;
export type SceneryThemeId = (typeof SCENERY_THEME_IDS)[number];

export interface BuildDefinition {
  id: string;
  name: string;
  kind: BuildKind;
  category: BuildCategory;
  icon: string;
  description: string;
  buildCost: number;
  footprint: readonly [number, number];
  color: number;
  accent: number;
  /** Placed through a dedicated designer tool instead of footprint stamping. */
  custom?: 'coaster';
  /**
   * Phase 38: the object's gameplay height in coaster levels. Track may run over it at level `clearanceLevels + 1`
   * or higher (and it may be built under such track). Absent = never crossed (rides, stalls, tall scenery).
   * A render test pins every value against the voxel model's height.
   */
  clearanceLevels?: number;
  stats?: {
    capacity?: number;
    duration?: number;
    excitement?: number;
    intensity?: number;
    runningCost?: number;
    ticketPrice?: number;
    serviceType?: 'food' | 'drink' | 'toilet' | 'souvenir';
    /** Souvenir stalls only (Phase 29): the keepsake a guest walks away carrying. */
    souvenir?: SouvenirKind;
    serviceDuration?: number;
    needRelief?: number;
    itemPrice?: number;
    reliability?: number;
    amenityType?: 'bin';
    binCapacity?: number;
    sceneryAppeal?: number;
    sceneryRadius?: number;
  };
  /**
   * Rides only: false for a ride under a roof or in a housed building. Open-air rides (the default)
   * close for a storm; covered ones keep running and draw guests in the rain.
   */
  openAir?: boolean;
  /** Shops only: warm food is sought in the rain, cold treats and drinks in the heat. */
  serves?: 'warm' | 'cold';
  /**
   * Phase 22: built only when the profile has unlocked it (a scenario reward). Such an entry has no research
   * project; a park that does not hold it in its grant refuses it as locked. Everything else stays as is.
   */
  profileGate?: true;
  /**
   * Phase 16: the theme of a ride, stall or scenery piece. Metadata for the theme affinity and the UI; coasters,
   * toilets, comforts and paths have none.
   */
  theme?: SceneryThemeId;
}

export interface PlacedObject {
  id: number;
  definitionId: string;
  anchor: Cell;
  rotation: Rotation;
  /**
   * Phase 28: the chosen colour per slot (a swatch index or null for the default), aligned with
   * colourSlotsFor(definitionId). Absent = every slot default. A frozen record that is replaced,
   * never mutated, so renderers can diff it by identity. Cosmetic: no simulation owner reads it.
   */
  colours?: ObjectColours;
}

/** A definition's footprint after rotation: quarter turns swap width and depth. */
export const footprintSize = (
  definition: BuildDefinition,
  rotation: Rotation = 0,
): readonly [number, number] => rotation % 2 === 0
  ? definition.footprint
  : [definition.footprint[1], definition.footprint[0]];

export type GameSpeed = 0 | 1 | 2 | 4;

export type TransactionCategory =
  | 'ride-revenue'
  | 'food-revenue'
  | 'drink-revenue'
  | 'facility-revenue'
  /** Phase 29: umbrellas, hats, balloons and the other keepsakes. */
  | 'souvenir-revenue'
  | 'ride-operations'
  | 'staff-salaries'
  | 'maintenance'
  | 'research'
  | 'construction'
  | 'land-clearing'
  /** Phase 21: buying a parcel of land. */
  | 'land-purchase'
  | 'refund'
  | 'grant'
  | 'other';

export interface Transaction {
  id: number;
  amount: number;
  label: string;
  category: TransactionCategory;
  tick: number;
}
