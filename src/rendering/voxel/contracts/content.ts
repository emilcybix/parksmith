import type { CoasterPiece } from '../../../game/coaster/design';
import type { PropKindDefinition } from '../../../game/maps/props';
import type { BuildDefinition } from '../../../game/types';
import type { Blueprint } from './blueprint';
import type { BoxWriter } from './boxes';
import type { Palette } from './palette';
import type { PartDriver } from './rigid';

/**
 * What content modules provide. Each catalog id resolves (content/registry.ts) to an ObjectContent
 * whose blueprint is authored against the art bible (design §Art bible) and the palette; moving
 * parts get a driver keyed by part id. The static world builder owns terrain, paths, curbs, plot
 * slabs and fences; content owns everything that stands on them.
 */
export interface ObjectContent {
  /** Must be deterministic: same definition and palette → same blueprint (same id). */
  blueprint(definition: BuildDefinition, palette: Palette): Blueprint;
  /** Drivers for parts 1+, by part id. Missing drivers leave a part at rest. */
  drivers?: Readonly<Record<string, PartDriver>>;
}

/**
 * Phase 24: what a map prop provides. A prop is static scenery of a biome (a tree, a rock, a cactus): one body
 * part, no drivers and no lights in step 1, standing directly on the ground (z = 0, so the blueprint sets
 * `floorZ: 0`) inside its own footprint (x in [0, 32 w), y in [0, 32 d)), so two props never overlap.
 */
export interface PropContent {
  /** Must be deterministic: same kind and palette -> same blueprint (same id). */
  blueprint(kind: PropKindDefinition, palette: Palette): Blueprint;
}

/**
 * Coaster content: track boxes per piece in WORLD voxels (so the static builder can put each
 * piece's boxes into that piece's chunk), and one blueprint per car.
 */
export interface CoasterContent {
  /**
   * Emits the boxes of piece `index` of a closed layout: bed, rails, supports (never at the tile
   * centre, where guests walk under track of level ≥ 2), station platform, ramps toward the next
   * piece's height and a loop ring for 'loop' pieces. Coordinates are world voxels.
   * `paint` (Phase 28): a per-colour-slot-tag material table of a recoloured coaster (index = the slot's tag,
   * 0 = keep the default), or null for the default colours. It may change materials only, never a box.
   */
  pieceBoxes(
    pieces: readonly CoasterPiece[],
    index: number,
    definition: BuildDefinition,
    palette: Palette,
    outlineGroup: number,
    out: BoxWriter,
    paint?: Uint8Array | null,
    /**
     * Phase 38: false when something stands or runs under this piece in its cell (other track, a low object): the
     * piece then gets no support bent of its own (its neighbours carry it). Default true. A piece of the same
     * layout below it in its cell drops the bent whatever this says.
     */
    supports?: boolean,
  ): void;
  /**
   * Car model; the lead car (index 0) may differ. Body part only; the car is posed as a whole.
   * Car space is centred on the car's pivot: +x is the direction of travel, +y the car's left, z = 0
   * the rail top the wheels sit on. Set `floorZ: 0` (the default of 1 would carve the chassis).
   */
  carBlueprint(definition: BuildDefinition, carIndex: number, palette: Palette): Blueprint;
  /**
   * The riders of car `carIndex`, in the same car space as the car (a separate rigid part, posed with
   * the car while the ride runs and hidden by the collapse pose otherwise): one per seat of that car
   * (coasterCarFrame.ts `coasterCarSeats`), so a full train shows its capacity. Boxes, not guests.
   */
  riderBlueprint(definition: BuildDefinition, carIndex: number, palette: Palette): Blueprint;
  /**
   * HALF of the bar between two neighbouring cars: along +x from its pivot (one car's hitch) toward
   * the other car, at the chassis' height. Two are posed per coupling, one from each hitch
   * (coasterCarFrame.ts `coasterCouplingHalfFrame`), so it follows the curve between the cars.
   */
  couplingBlueprint(definition: BuildDefinition, palette: Palette): Blueprint;
}

/**
 * Litter pile at a path cell: small cup/wrapper boxes around the cell centre (world voxels),
 * more pieces for more units. Deterministic from (cellX, cellY, units).
 */
export type LitterEmitter = (
  cellX: number,
  cellY: number,
  units: number,
  palette: Palette,
  out: BoxWriter,
  /** Phase 29: someone was sick on this pile (a puddle joins the pieces). */
  sick?: boolean,
) => void;
