import {
  CENTRE_LINE_SUPPORT_HALF_SPAN,
  centreLineChainedHalf,
  centreLineFor,
  centreLineHeightAt,
  centreLineRollInPiece,
  centreLineSupportDistance,
  createCentreLineFrame,
  createGroundHeight,
  createTileProjection,
  projectOntoTile,
  sampleCentreLineFrame,
} from '../../../game/coaster/centreLine';
import type { CentreLine } from '../../../game/coaster/centreLine';
import type { CoasterPiece } from '../../../game/coaster/design';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import { GAME_CONFIG } from '../../../game/config';
import { colourSlotsFor, type ColourSlotId } from '../../../game/content/colours';
import { GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import type { BuildDefinition, Cell } from '../../../game/types';
import type { Blueprint, Shape } from '../contracts/blueprint';
import { packBoxWord } from '../contracts/boxes';
import type { BoxWriter } from '../contracts/boxes';
import { BOX_BUDGET } from '../contracts/budgets';
import type { CoasterContent } from '../contracts/content';
import { MAT, MATERIAL_EMPTY, PATTERN, SKIN_MATERIALS } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { GROUND_TOP_Z, PATH_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';
import { coasterCarSeats } from '../../coasterCarFrame';
import { slotTagger } from './colourTags';
import { COASTER_LOOP_RADIUS_VOXELS, coasterRailTopZ } from '../scene/coasterCars';

/**
 * Coaster track pieces and cars for all three coaster types (design §12, art bible "Coaster";
 * Phase 27 step 2: structure).
 *
 * Track geometry is the smooth centre line the cars ride (game/coaster/centreLine.ts): every piece
 * owns its own tile, the line enters and leaves through edge midpoints, a turn is a quarter circle
 * of radius 16 round the tile corner, heights are a monotone spline. Every box of a piece stays
 * inside its tile, because the static world files a piece's boxes under the chunk of that tile;
 * only a loop ring may overhang (≤ 1 tile, into the next piece's).
 *
 * Cross-section, per tile column whose centre is within TRACK_HALF_WIDTH (4) of the line, at
 * signed across offset `s` (voxels, positive toward the frame's N, the plan left of travel) and
 * `top = round(13·z + 5 + s · tan(roll))` (the line's height there plus the banking lift of
 * `centreLineBankLift`, so a banked corner's outer rail rises and its inner rail drops by up to
 * two voxels at the apex; roll is 0 on straights, so a straight's cross-section is level):
 * - two RAILS, |s| ∈ [2, 4), z [top − 1, top), the type's accent colour;
 * - TIES, every 4 voxels of arc (columns [4k, 4k + 2) of the piece's line, radial bars on a corner),
 *   |s| < 3, z [top − 2, top − 1), the type's tie colour: the rails lie on them;
 * - a SPINE, |s| < 1, z [top − 4, top − 2), under the ties (a station piece has a STONE bed over
 *   the whole width instead: the station is a paved pit); a column whose spine bottom is at the
 *   path top (level 0) reaches one voxel further down, on to the grass at GROUND_TOP_Z: a coaster
 *   cell gets no paving or plot slab from the static world, and a path never shares a cell with
 *   track under `pathClearanceHeight`, so nothing of the track floats over bare ground;
 * - a CHAIN of dashes, |s| < 1, 4 on 4 off, z [top − 1, top) between the rails on every chained
 *   half (`centreLineChainedHalf`: every climbing segment until step 4 keys it from piece data);
 * - a BRAKE pad (CONCRETE, a light grey no other coaster element uses), |s| < 2, along [6, 26), on
 *   the last piece (the run into the station), plus a fin post beside the rail on the far side of a
 *   straight last piece;
 * - BOOST chevrons (glowing) as before, which win over the chain and the brake.
 * Boxes come from merging equal-`top` columns of each layer into rectangles (mergeRectangles).
 *
 * Supports (level ≥ 1, one bent per piece, never under a loop ring): the frame of the line at
 * `centreLineSupportDistance` (7 voxels past the entry edge) places two 2×2 legs 8 voxels either
 * side of the line along its plan normal (so on a corner they stand beside the arc, radially),
 * each on a 4×4 STONE footing standing on the grass (z 0) and rising one voxel over the path top
 * (on a path tile its lowest voxel is inside the paving), rising to the beam top `zb`; `zb` is the lowest
 * track bottom over the bent's strip (the spine bottom, so the beam [zb − 2, zb) meets the spine
 * from below and never reaches into the track). Between the legs, a rung at z 23 when zb ≥ 27
 * (level 2 and up), then one diagonal brace per 12-voxel bay with a rung between bays: taller =
 * more bracing, and nothing floats (every box touches a leg, the beam, a rung or the ground).
 * Walkways: a path may run under track of level ≥ 2 and guests walk the lines from the tile centre
 * to its edge midpoints, so on such a piece a leg whose footing would touch a corridor (3 voxels
 * either side of those lines, or the 4-voxel disc at the centre) is moved 2 voxels along the tile
 * axis away from that corridor, up to four times, or dropped if that leaves the tile; the beam and
 * bracing cross the along-track corridor only at z ≥ 23, above a walking guest. The rotated strip
 * of a corner's bent is rasterised per column.
 *
 * Loop ring (a loop special on a straight piece): the centre line's ring, a circle of radius 16 in
 * the vertical plane of travel on the piece's exit edge M, rotated by the track's pitch α there
 * (`ringEntryPitch`), so its centre is M + 16 · (−sin α, cos α) in (along, up) and the ring enters
 * and leaves along the ramp's own tangent (the step-1 kink is gone). Cross-section as the straight
 * track bent round: rails in the annulus [16, 18) at |across| ∈ [2, 4), ties as radial bars every 4
 * voxels of arc at |across| < 2, the spine in [18, 20) at |across| < 1. Voxels at or under the
 * straight track's rail top are left to the straight track, so nothing overlaps.
 *
 * Station (the first GAME_CONFIG.coaster.stationLength pieces, level 0): a stone platform from the
 * grass up to the rail top with an accent edge beside the track, a striped canopy with an accent valance hung with glowing bulbs,
 * one post per piece, a queue gate (two accent posts and a bar) at the entry end of the first piece
 * and a dispatch light (a steel post with a bulb) at the exit end of the last. It always takes the
 * far side of the track (−x or −y, away from the camera, the same choice `classicFarSide` makes):
 * a canopy on the near side would hide the loading train. A station end that turns off toward the
 * far side keeps only the part of the platform clear of the turning arc, and a turning first piece
 * that a loop ring reaches over keeps its platform only.
 *
 * Colour by type (`coasterLook`; the classic renderer uses the same table): rails are the type's
 * accent, ties its colour (wood for the Comet Trail), the spine and supports a matching dark tone,
 * so the three types read distinctly and stay bright. No new palette materials.
 *
 * Box budget: COASTER_PIECE_BOX_ALLOWANCE bounds each piece kind (measured, see budgets.ts).
 */

const TILE = VOXELS_PER_TILE;
const HALF_TILE = TILE / 2;

/** The track spans [−4, 4) across the centreline: as wide as a car. */
export const TRACK_HALF_WIDTH = 4;
/** Each rail is 2 voxels wide, on the track's edges; its centre is 3 across (CENTRE_LINE_HALF_GAUGE). */
export const RAIL_WIDTH = 2;
const RAIL_CENTRE_ACROSS = TRACK_HALF_WIDTH - RAIL_WIDTH / 2;
/** Rail top minus spine bottom: rail, tie and the 2-voxel spine. */
export const TRACK_DEPTH = 4;
const RAIL_HEIGHT = 1;
export const TIE_THICKNESS = 1;
const SPINE_HEIGHT = TRACK_DEPTH - RAIL_HEIGHT - TIE_THICKNESS;
/** The spine under the ties spans |s| < 1 (two voxels wide). */
export const SPINE_HALF_WIDTH = 1;
/** Ties take columns [4k, 4k + 2) of a piece's line (centreLine.ts CENTRE_LINE_TIE_SPACING / OFFSET). */
export const TIE_PERIOD = 4;
export const TIE_LENGTH = 2;
/**
 * A tie spans |s| < 3: the rails' inner columns rest on it and their outer columns overhang it by
 * one voxel, which the camera cannot see from any view (the rail hides the recessed tie end), while the
 * narrower radial bars of a corner cost a quarter fewer boxes.
 */
export const TIE_HALF_WIDTH = TRACK_HALF_WIDTH - 1;
/** Chain dashes between the rails: |s| < 1, 4 voxels on, 4 off. */
export const CHAIN_HALF_WIDTH = 1;
export const CHAIN_PERIOD = 8;
export const CHAIN_DASH = 4;
/** The brake pad of the last piece: |s| < 2 over along [6, 26). */
export const BRAKE_HALF_WIDTH = 2;
export const BRAKE_FROM = 6;
export const BRAKE_TO = 26;
/** The brake fin: a 2×2 post 5 high beside the tie at along 28 on the far side of the last piece. */
const BRAKE_FIN_ALONG = 28;
const BRAKE_FIN_HEIGHT = 5;

/** Supports: 2×2 legs `SUPPORT_LEG_ACROSS` voxels either side of the line, on 4×4 footings. */
export const SUPPORT_LEG_ACROSS = CENTRE_LINE_SUPPORT_HALF_SPAN * TILE;
export const SUPPORT_SIZE = 2;
export const SUPPORT_FOOTING_SIZE = 4;
/** How far a footing rises over the path top: the part that shows on a path tile. */
export const SUPPORT_FOOTING_HEIGHT = 1;
/**
 * A footing stands on the grass: a coaster cell has no paving or plot slab of its own, so a footing
 * at the path top would float a voxel over bare ground. On the rare path tile under level-2+ track
 * its lowest voxel is inside the paving. Legs stand on SUPPORT_FOOTING_TOP, so nothing above moves.
 */
export const SUPPORT_FOOTING_Z = GROUND_TOP_Z;
export const SUPPORT_FOOTING_TOP = PATH_TOP_Z + SUPPORT_FOOTING_HEIGHT;
/** Level-0 track and the station reach from the path top down to the grass by this much. */
export const GROUND_SINK = PATH_TOP_Z - GROUND_TOP_Z;
const SUPPORT_BEAM_HEIGHT = 2;
/** The first rung's z, above a walking guest (≤ 20 over the path top), and the bay height above it. */
export const SUPPORT_RUNG_Z = PATH_TOP_Z + 22;
export const SUPPORT_RUNG_HEIGHT = 2;
export const SUPPORT_BAY = 12;
/** A diagonal brace: 4 steps of 3 voxels, each box 4 high so neighbours share a face. */
const BRACE_STEPS = 4;
const BRACE_RISE = 3;
const BRACE_HEIGHT = 4;
/** A leg is moved by this much, at most this many times, while its footing touches a walkway corridor. */
const SUPPORT_SHIFT = 2;
const SUPPORT_MAX_SHIFTS = 4;
/** Walkway corridors on a piece of level ≥ 2 (the content test's numbers): 3 voxels either side of the walk lines, a 4-voxel disc at the centre. */
const WALK_HALF_WIDTH = 3;
const WALK_CENTRE_RADIUS = 4;

/** Loop ring (art bible): the rail annulus from the running surface (16) to 18, the spine to 20. */
export const LOOP_RAIL_RADIUS = COASTER_LOOP_RADIUS_VOXELS;
export const LOOP_RAIL_THICKNESS = 2;
export const LOOP_OUTER_RADIUS = LOOP_RAIL_RADIUS + TRACK_DEPTH;
/** The ring's grid reaches this far either way along travel from its base M (the rotated centre shifts ≤ 9). */
const LOOP_REACH = 30;

/** Boost chevrons: tips every 8 voxels along the piece, between the rails. */
const CHEVRON_TIPS: readonly number[] = [-10, -2, 6, 14];

/** Station platform and canopy, in voxels across the track from the centreline. */
export const PLATFORM_NEAR = TRACK_HALF_WIDTH + 1;
export const PLATFORM_FAR = HALF_TILE - 1;
const PLATFORM_EDGE_WIDTH = 2;
/** The platform top is level with the rail top, where the cars' floors are. */
export const PLATFORM_TOP_Z = coasterRailTopZ(0);
const CANOPY_POST_SIZE = 2;
/** Canopy underside: 22 voxels over the platform, clear of a standing guest (≤ 20). */
export const CANOPY_BOTTOM_Z = PLATFORM_TOP_Z + 22;
const CANOPY_THICKNESS = 2;
const CANOPY_NEAR = TRACK_HALF_WIDTH;
/** A 2×2 accent valance hangs under the canopy's track-side edge. */
const VALANCE_DEPTH = 2;
/**
 * Festoon bulbs (2×2×1 BULB) under the valance every 16 voxels along the station, so the station
 * still reads at dusk and night. Offsets from the tile centre, 16 apart across tiles too, and one
 * always lands on the half a turning station end keeps.
 */
const STATION_BULB_ALONG: readonly number[] = [-10, 6];
const STATION_BULB_SIZE = 2;
/** The queue gate at the entry end of the first station piece: two accent posts and a bar over them. */
const GATE_ALONG = -15;
const GATE_POST_SIZE = 2;
export const GATE_HEIGHT = 9;
const GATE_NEAR = 7;
const GATE_FAR = 15;
/** The dispatch light at the exit end of the last station piece: a steel post with a bulb on top. */
const DISPATCH_ALONG = 13;
const DISPATCH_NEAR = 6;
export const DISPATCH_POST_HEIGHT = 10;
const DISPATCH_BULB_HEIGHT = 2;
/**
 * turnSide of the first station piece's inbound step when the previous piece lies on the far side:
 * travel into the piece then runs toward +across.
 */
const FAR_SIDE_TURN_IN = 1;
/** A platform beside a turning station end stops this far from the tile centre, clear of the arc. */
const STATION_ARC_CLEARANCE = 6;

/**
 * Box allowances per piece, the gate content tests hold every piece to (measured, step 2; see
 * budgets.ts). A flat straight piece with no special, not the station, gets
 * BOX_BUDGET.coasterPerPiece (two rails, eight ties and the spine are 11 boxes at level 0) plus
 * `bentPerLevel` per level of height for its bent (footings, legs, beam, then rungs and braces
 * that grow with the height; a corner's rotated bent is a staircase and costs more). Each feature
 * adds what its shapes need:
 * - a rounded corner (flat): BOX_BUDGET.coasterTurnPiece, the staircase of a quarter circle of
 *   rails, radial ties and spine, banked, plus a rotated bent;
 * - a ramp: thin treads of every layer, `ramp` extra boxes per ramped arm of a straight piece;
 *   a corner that climbs or falls is `rampedTurn` in all;
 * - the station: platform, edge, post, canopy, valance, bulbs, gate, dispatch light and the stone bed;
 * - a boost: 4 chevrons of 3 or 4 boxes, a few more where a tread splits one on a ramp;
 * - a loop: its ring (rails, ties and spine);
 * - the chain dashes of a climbing piece and the brake pad of the last piece.
 */
export const COASTER_PIECE_BOX_ALLOWANCE = {
  plain: BOX_BUDGET.coasterPerPiece,
  turn: BOX_BUDGET.coasterTurnPiece,
  ramp: BOX_BUDGET.coasterRampPerArm,
  rampedTurn: BOX_BUDGET.coasterRampedTurnPiece,
  bentPerLevel: BOX_BUDGET.coasterBentPerLevel,
  station: 20,
  boost: 20,
  loop: BOX_BUDGET.coasterLoopRing,
  chain: 10,
  brake: 6,
} as const;

// ---------------------------------------------------------------------------------------------
// Colour by type

/** The materials a coaster type is built from. */
export interface CoasterLook {
  rail: number;
  tie: number;
  spine: number;
  support: number;
}

const TYPE_LOOK: Readonly<Record<string, { tie?: number; spine: number; support: number }>> = {
  'comet-trail': { tie: MAT.WOOD, spine: MAT.TRACK, support: MAT.TIMBER },
  'star-chaser': { spine: MAT.PANTS_DARK, support: MAT.STEEL },
  'skyline-serpent': { spine: MAT.INK, support: MAT.STEEL_LIGHT },
  // Phase 39: a grey steel mouse track; a wooden coaster with wood ties and a timber spine and lattice.
  'whisker-mouse': { spine: MAT.PANTS_DARK, support: MAT.STEEL_LIGHT },
  'timber-twister': { tie: MAT.WOOD, spine: MAT.TIMBER, support: MAT.TIMBER },
};

/**
 * Phase 28: the palette material a per-tag table (`paint`: index = colour slot tag, 0 = keep the default; what
 * StaticWorld builds from a recoloured object's record) holds for a slot of this coaster, or 0 when there is no
 * table, the definition has no such slot, or the slot is on its default. The track is procedural, so unlike a
 * compiled model it carries no tags: its emitter reads the table where it picks a word, and no geometry ever
 * depends on it.
 */
export const paintedMaterial = (definitionId: string, paint: Uint8Array | null | undefined, slot: ColourSlotId): number => {
  if (!paint) return 0;
  const slots = colourSlotsFor(definitionId);
  for (let index = 0; index < slots.length; index += 1) {
    if (slots[index].id === slot) return paint[slots[index].tag] ?? 0;
  }
  return 0;
};

/**
 * Rails in the type's accent, ties in its colour (wood for the Comet Trail), spine and supports in a
 * matching dark tone; an unknown coaster gets the step-1 look. Writes into `out` and returns it.
 * `paint` (Phase 28): the 'rail' slot replaces the rails, the 'support' slot the supports, spine and ties.
 */
export const coasterLook = (definition: BuildDefinition, palette: Palette, out: CoasterLook, paint: Uint8Array | null = null): CoasterLook => {
  const type = TYPE_LOOK[definition.id];
  const rail = paintedMaterial(definition.id, paint, 'rail');
  const support = paintedMaterial(definition.id, paint, 'support');
  out.rail = rail !== 0 ? rail : palette.material(definition.accent);
  out.tie = support !== 0 ? support : type?.tie ?? palette.material(definition.color);
  out.spine = support !== 0 ? support : type?.spine ?? MAT.TRACK;
  out.support = support !== 0 ? support : type?.support ?? MAT.SUPPORT;
  return out;
};

const LOOK: CoasterLook = { rail: 0, tie: 0, spine: 0, support: 0 };

// ---------------------------------------------------------------------------------------------
// Scratch state. Track pieces are built on chunk rebuilds, not per frame, but they still reuse
// module-level buffers so a rebuild of a long coaster allocates nothing once warm.

/** Per tile column: the rail-top z of its track (banked), and what is there. */
const COLUMN_TOP = new Int32Array(TILE * TILE);
/** Bit flags per column. */
const COLUMN_FLAGS = new Uint8Array(TILE * TILE);
const FLAG_BAND = 1;
const FLAG_SPINE = 2;
const FLAG_TIE = 4;
/** The top layer [top − 1, top) of a column: one of these. */
const COLUMN_TOP_KIND = new Uint8Array(TILE * TILE);
const TOP_NONE = 0;
const TOP_RAIL = 1;
const TOP_CHAIN = 2;
const TOP_BRAKE = 3;
const TOP_CHEVRON = 4;

/** Largest grid mergeRectangles handles (the loop ring's plane is 60 × 45). */
const MAX_GRID = 64;
/** An empty grid cell: no key a rail top or a ring flag can take. */
const EMPTY = -0x80000000;
const GRID_KEYS = new Int32Array(MAX_GRID * MAX_GRID);
const RECT_STRIDE = 5;
/** Rectangles found by mergeRectangles: first column, end column, first row, end row, key. */
const RECTS = new Int32Array(MAX_GRID * MAX_GRID * RECT_STRIDE);
const OPEN_FIRST = new Int32Array(MAX_GRID);
const OPEN_END = new Int32Array(MAX_GRID);
const OPEN_KEY = new Int32Array(MAX_GRID);
const OPEN_ROW = new Int32Array(MAX_GRID);
const RUN_FIRST = new Int32Array(MAX_GRID);
const RUN_END = new Int32Array(MAX_GRID);
const RUN_KEY = new Int32Array(MAX_GRID);
const RUN_ROW = new Int32Array(MAX_GRID);

/**
 * Greedy rectangles over a `columns` × `rows` grid of keys (GRID_KEYS, EMPTY = none): runs of equal
 * keys along each row, merged down the rows while a run of the same extent and key continues. For
 * the axis-aligned bands, L-shapes and staircases track is made of this is the minimal box count.
 * Returns how many rectangles it wrote to RECTS.
 */
const mergeRectangles = (columns: number, rows: number): number => {
  let rectangles = 0;
  let openCount = 0;
  for (let row = 0; row <= rows; row += 1) {
    let runCount = 0;
    if (row < rows) {
      const base = row * columns;
      let column = 0;
      while (column < columns) {
        const key = GRID_KEYS[base + column];
        if (key === EMPTY) {
          column += 1;
          continue;
        }
        let end = column + 1;
        while (end < columns && GRID_KEYS[base + end] === key) end += 1;
        RUN_FIRST[runCount] = column;
        RUN_END[runCount] = end;
        RUN_KEY[runCount] = key;
        RUN_ROW[runCount] = row;
        runCount += 1;
        column = end;
      }
    }
    // Both lists are sorted by first column and disjoint, so one pass pairs continuing runs.
    let run = 0;
    for (let open = 0; open < openCount; open += 1) {
      while (run < runCount && RUN_FIRST[run] < OPEN_FIRST[open]) run += 1;
      if (run < runCount && RUN_FIRST[run] === OPEN_FIRST[open] && RUN_END[run] === OPEN_END[open]
        && RUN_KEY[run] === OPEN_KEY[open]) {
        RUN_ROW[run] = OPEN_ROW[open];
        continue;
      }
      const at = rectangles * RECT_STRIDE;
      RECTS[at] = OPEN_FIRST[open];
      RECTS[at + 1] = OPEN_END[open];
      RECTS[at + 2] = OPEN_ROW[open];
      RECTS[at + 3] = row;
      RECTS[at + 4] = OPEN_KEY[open];
      rectangles += 1;
    }
    for (let index = 0; index < runCount; index += 1) {
      OPEN_FIRST[index] = RUN_FIRST[index];
      OPEN_END[index] = RUN_END[index];
      OPEN_KEY[index] = RUN_KEY[index];
      OPEN_ROW[index] = RUN_ROW[index];
    }
    openCount = runCount;
  }
  return rectangles;
};

/** Emits the rectangles of the last merge of a 32 × 32 tile grid as boxes `height` tall from key + zOffset (a key of 0 lands at zOffset). */
const emitTileRectangles = (frame: PieceFrame, count: number, zOffset: number, height: number, word: number, out: BoxWriter): void => {
  const originX = frame.cellX * TILE;
  const originY = frame.cellY * TILE;
  for (let rectangle = 0; rectangle < count; rectangle += 1) {
    const at = rectangle * RECT_STRIDE;
    out.push(
      originX + RECTS[at],
      originY + RECTS[at + 2],
      RECTS[at + 4] + zOffset,
      RECTS[at + 1] - RECTS[at],
      RECTS[at + 3] - RECTS[at + 2],
      height,
      word,
    );
  }
};

// ---------------------------------------------------------------------------------------------
// Piece frames

/** What one piece's track needs to know about itself and its neighbours. */
interface PieceFrame {
  line: CentreLine;
  index: number;
  cellX: number;
  cellY: number;
  height: number;
  railTop: number;
  /** Unit direction of travel from the previous piece into this one. */
  inX: number;
  inY: number;
  /** Unit direction of travel from this piece to the next. */
  outX: number;
  outY: number;
  /** 0 on a straight, ±1 the turn's sign (centreLine.ts). */
  turn: number;
  straight: boolean;
  /** The sign that turns `projectOntoTile`'s offset into the signed across toward the frame's N. */
  acrossSign: number;
  /** The outline group every box of the piece carries. */
  outlineGroup: number;
}

const createPieceFrame = (): PieceFrame => ({
  line: centreLineFor([]), index: 0, cellX: 0, cellY: 0, height: 0, railTop: 0, inX: 1, inY: 0, outX: 1, outY: 0, turn: 0,
  straight: true, acrossSign: 1, outlineGroup: 0,
});

const FRAME = createPieceFrame();
const NEXT_FRAME = createPieceFrame();
const STATION_FRAME = createPieceFrame();

/** Unit step x from one cell toward another (a malformed layout still gets an axis, never NaN). */
const stepX = (from: Cell, to: Cell): number => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return 1;
  return Math.abs(dx) >= Math.abs(dy) ? Math.sign(dx) : 0;
};

const stepY = (from: Cell, to: Cell): number => {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (dx === 0 && dy === 0) return 0;
  return Math.abs(dx) >= Math.abs(dy) ? 0 : Math.sign(dy);
};

const pieceAt = (pieces: readonly CoasterPiece[], index: number): CoasterPiece => {
  const count = pieces.length;
  return pieces[((index % count) + count) % count];
};

/**
 * The piece's frame, from the layout's centre line (centreLine.ts), which also decides what a
 * malformed layout means: a one-piece "layout" is a flat straight along +x, and a piece whose
 * neighbours lie on one side runs straight through, so nothing is ever NaN.
 */
const readPiece = (pieces: readonly CoasterPiece[], index: number, out: PieceFrame): PieceFrame => {
  const line = centreLineFor(pieces);
  const count = pieces.length;
  const at = ((index % count) + count) % count;
  out.line = line;
  out.index = at;
  out.cellX = line.cellX[at];
  out.cellY = line.cellY[at];
  out.height = pieces[at].height;
  out.railTop = coasterRailTopZ(pieces[at].height);
  out.inX = line.inX[at];
  out.inY = line.inY[at];
  out.outX = line.outX[at];
  out.outY = line.outY[at];
  out.turn = line.turn[at];
  out.straight = out.turn === 0;
  // projectOntoTile's offset is positive toward +x (travelling along y) or +y (along x) on a
  // straight, and on the outside of a turn; N = (−dirY, dirX) is the plan left of travel.
  out.acrossSign = out.straight ? out.inX - out.inY : -out.turn;
  return out;
};

const HEIGHT = createGroundHeight();
const PROJECTION = createTileProjection();
const BENT = createCentreLineFrame();

/** Rail-top voxel of piece `frame`'s line at plan distance `along` (tiles) from its entry edge. */
const railTopAt = (frame: PieceFrame, along: number): number => {
  centreLineHeightAt(frame.line, frame.line.groundStart[frame.index] + along, HEIGHT);
  return Math.round(coasterRailTopZ(HEIGHT.z));
};

/** The first station piece index past which no station furniture is built. */
const stationLengthOf = (pieces: readonly CoasterPiece[]): number => Math.min(GAME_CONFIG.coaster.stationLength, pieces.length);

/** Whether piece `index` is a station piece with furniture: on the station run, level 0, a real layout. */
const isStationPiece = (pieces: readonly CoasterPiece[], index: number): boolean =>
  index < stationLengthOf(pieces) && pieces.length >= 2 && pieceAt(pieces, index).height === 0;

// ---------------------------------------------------------------------------------------------
// Tile columns

/** First tile-local voxel of the signed-offset range [from, to) from the tile centre along a sign. */
const rangeStart = (sign: number, from: number, to: number): number => (sign > 0 ? HALF_TILE + from : HALF_TILE - to);

/**
 * Sets the top-layer `kind` on the track columns of the rectangle [alongFrom, alongTo) ×
 * [acrossFrom, acrossTo) of signed offsets from the tile centre, along the unit direction
 * (alongX, alongY) and across it along (acrossX, acrossY).
 */
const paintTopKind = (
  alongX: number,
  alongY: number,
  alongFrom: number,
  alongTo: number,
  acrossX: number,
  acrossY: number,
  acrossFrom: number,
  acrossTo: number,
  kind: number,
): void => {
  const alongStart = rangeStart(alongX + alongY, alongFrom, alongTo);
  const acrossStart = rangeStart(acrossX + acrossY, acrossFrom, acrossTo);
  const alongIsX = alongX !== 0;
  const x0 = Math.max(0, alongIsX ? alongStart : acrossStart);
  const y0 = Math.max(0, alongIsX ? acrossStart : alongStart);
  const x1 = Math.min(TILE, (alongIsX ? alongStart : acrossStart) + (alongIsX ? alongTo - alongFrom : acrossTo - acrossFrom));
  const y1 = Math.min(TILE, (alongIsX ? acrossStart : alongStart) + (alongIsX ? acrossTo - acrossFrom : alongTo - alongFrom));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      if (COLUMN_FLAGS[y * TILE + x] & FLAG_BAND) COLUMN_TOP_KIND[y * TILE + x] = kind;
    }
  }
};

/**
 * Lays out the track band of a piece tile into `flags`, `tops` and `topKinds`: for every column of
 * the 32 × 32 tile whose centre is within TRACK_HALF_WIDTH of the piece's centre line, its banked
 * rail-top voxel, whether it carries the spine and a tie, and its top layer (rail on the outer
 * RAIL_WIDTH either side, a chain dash or a brake pad between them).
 */
const layoutBand = (
  frame: PieceFrame,
  pieces: readonly CoasterPiece[],
  flags: Uint8Array,
  tops: Int32Array,
  topKinds: Uint8Array,
): void => {
  flags.fill(0);
  topKinds.fill(TOP_NONE);
  const line = frame.line;
  const index = frame.index;
  const ground = line.groundStart[index];
  const railInner = TRACK_HALF_WIDTH - RAIL_WIDTH;
  const brakePiece = pieces.length >= 2 && index === pieces.length - 1;
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      projectOntoTile(line, index, (x + 0.5) / TILE, (y + 0.5) / TILE, PROJECTION);
      const offset = PROJECTION.offset * TILE;
      const distance = Math.abs(offset);
      if (distance >= TRACK_HALF_WIDTH) continue;
      const along = PROJECTION.along;
      // The bank lift of a rail column is its rail's (at ±3), so a rail never steps across itself.
      const bankAcross = (distance >= railInner ? RAIL_CENTRE_ACROSS : distance) * Math.sign(offset) * frame.acrossSign;
      const roll = centreLineRollInPiece(line, index, along);
      centreLineHeightAt(line, ground + along, HEIGHT);
      const column = y * TILE + x;
      // A banked corner at ground level cannot drop its inner rail into the ground: the track never goes under the path top.
      tops[column] = Math.max(PATH_TOP_Z + TRACK_DEPTH, Math.round(coasterRailTopZ(HEIGHT.z) + bankAcross * Math.tan(roll)));
      const alongVoxel = Math.floor(along * TILE);
      let flag = FLAG_BAND;
      if (distance < SPINE_HALF_WIDTH) flag |= FLAG_SPINE;
      if (distance < TIE_HALF_WIDTH && alongVoxel % TIE_PERIOD < TIE_LENGTH) flag |= FLAG_TIE;
      flags[column] = flag;
      if (distance >= railInner) {
        topKinds[column] = TOP_RAIL;
      } else if (brakePiece && distance < BRAKE_HALF_WIDTH && alongVoxel >= BRAKE_FROM && alongVoxel < BRAKE_TO) {
        topKinds[column] = TOP_BRAKE;
      } else if (distance < CHAIN_HALF_WIDTH && alongVoxel % CHAIN_PERIOD < CHAIN_DASH && centreLineChainedHalf(line, index, along)) {
        topKinds[column] = TOP_CHAIN;
      }
    }
  }
};

/** Lays out the piece's track columns (tops, layers, chevrons) for `frame`. */
const layoutColumns = (frame: PieceFrame, pieces: readonly CoasterPiece[], special: CoasterPiece['special']): void => {
  layoutBand(frame, pieces, COLUMN_FLAGS, COLUMN_TOP, COLUMN_TOP_KIND);
  if (frame.straight && special === 'boost') {
    const acrossX = frame.outY !== 0 ? 1 : 0;
    const acrossY = frame.outX !== 0 ? 1 : 0;
    for (let chevron = 0; chevron < CHEVRON_TIPS.length; chevron += 1) {
      const tip = CHEVRON_TIPS[chevron];
      paintTopKind(frame.outX, frame.outY, tip - 2, tip, acrossX, acrossY, -1, 1, TOP_CHEVRON);
      paintTopKind(frame.outX, frame.outY, tip - 3, tip - 1, acrossX, acrossY, -2, -1, TOP_CHEVRON);
      paintTopKind(frame.outX, frame.outY, tip - 3, tip - 1, acrossX, acrossY, 1, 2, TOP_CHEVRON);
    }
  }
};

/** Emits the columns carrying `flag` as boxes from `top + zOffset`, `height` tall, merged by equal top. */
const emitFlagged = (frame: PieceFrame, flag: number, zOffset: number, height: number, word: number, out: BoxWriter): void => {
  for (let index = 0; index < TILE * TILE; index += 1) {
    GRID_KEYS[index] = (COLUMN_FLAGS[index] & flag) === flag ? COLUMN_TOP[index] : EMPTY;
  }
  emitTileRectangles(frame, mergeRectangles(TILE, TILE), zOffset, height, word, out);
};

/**
 * Emits the lower layer (the spine, or the station's bed) of the columns carrying `flag`:
 * [top − TRACK_DEPTH, top − TRACK_DEPTH + SPINE_HEIGHT), merged by equal top. A column whose spine
 * bottom is at the path top (level 0, the clamp in layoutBand) reaches GROUND_SINK further down on to
 * the grass; the split adds no boxes, since the merge never joins columns of different tops anyway.
 */
const emitLowerLayer = (frame: PieceFrame, flag: number, word: number, out: BoxWriter): void => {
  let grounded = false;
  for (let index = 0; index < TILE * TILE; index += 1) {
    const carries = (COLUMN_FLAGS[index] & flag) === flag;
    const onGround = carries && COLUMN_TOP[index] - TRACK_DEPTH <= PATH_TOP_Z;
    grounded ||= onGround;
    GRID_KEYS[index] = carries && !onGround ? COLUMN_TOP[index] : EMPTY;
  }
  emitTileRectangles(frame, mergeRectangles(TILE, TILE), -TRACK_DEPTH, SPINE_HEIGHT, word, out);
  if (!grounded) return;
  for (let index = 0; index < TILE * TILE; index += 1) {
    const carries = (COLUMN_FLAGS[index] & flag) === flag;
    GRID_KEYS[index] = carries && COLUMN_TOP[index] - TRACK_DEPTH <= PATH_TOP_Z ? COLUMN_TOP[index] : EMPTY;
  }
  emitTileRectangles(frame, mergeRectangles(TILE, TILE), -TRACK_DEPTH - GROUND_SINK, SPINE_HEIGHT + GROUND_SINK, word, out);
};

/** Emits the columns whose top layer is `kind` as boxes [top − 1, top), merged by equal top. */
const emitTopLayer = (frame: PieceFrame, kind: number, word: number, out: BoxWriter): void => {
  for (let index = 0; index < TILE * TILE; index += 1) {
    GRID_KEYS[index] = COLUMN_TOP_KIND[index] === kind ? COLUMN_TOP[index] : EMPTY;
  }
  emitTileRectangles(frame, mergeRectangles(TILE, TILE), -RAIL_HEIGHT, RAIL_HEIGHT, word, out);
};

/**
 * The z of the lowest track voxel in a laid-out column (its top when the column carries no track).
 * A level-0 spine reaches GROUND_SINK further down on to the grass, which no bent ever needs (a bent
 * needs its beam above the footing top).
 */
const trackBottomAt = (column: number): number => {
  const flags = COLUMN_FLAGS[column];
  const top = COLUMN_TOP[column];
  if (flags & FLAG_SPINE) return top - TRACK_DEPTH;
  if (flags & FLAG_TIE) return top - RAIL_HEIGHT - TIE_THICKNESS;
  if (COLUMN_TOP_KIND[column] !== TOP_NONE) return top - RAIL_HEIGHT;
  return top;
};

// ---------------------------------------------------------------------------------------------
// Supports

/** A box given as signed offset ranges from the tile centre, along and across a direction. */
const pushTileBox = (
  frame: PieceFrame,
  alongX: number,
  alongY: number,
  alongFrom: number,
  alongTo: number,
  acrossX: number,
  acrossY: number,
  acrossFrom: number,
  acrossTo: number,
  z: number,
  height: number,
  word: number,
  out: BoxWriter,
): void => {
  if (alongTo <= alongFrom || acrossTo <= acrossFrom || height <= 0) return;
  const alongStart = rangeStart(alongX + alongY, alongFrom, alongTo);
  const acrossStart = rangeStart(acrossX + acrossY, acrossFrom, acrossTo);
  const originX = frame.cellX * TILE;
  const originY = frame.cellY * TILE;
  const alongSize = alongTo - alongFrom;
  const acrossSize = acrossTo - acrossFrom;
  if (alongX !== 0) out.push(originX + alongStart, originY + acrossStart, z, alongSize, acrossSize, height, word);
  else out.push(originX + acrossStart, originY + alongStart, z, acrossSize, alongSize, height, word);
};

/** A tile-local box [x0, x1) × [y0, y1) × [z, z + height), clipped to the tile. */
const pushLocalBox = (frame: PieceFrame, x0: number, y0: number, x1: number, y1: number, z: number, height: number, word: number, out: BoxWriter): void => {
  const cx0 = Math.max(0, x0);
  const cy0 = Math.max(0, y0);
  const cx1 = Math.min(TILE, x1);
  const cy1 = Math.min(TILE, y1);
  if (cx1 <= cx0 || cy1 <= cy0 || height <= 0) return;
  out.push(frame.cellX * TILE + cx0, frame.cellY * TILE + cy0, z, cx1 - cx0, cy1 - cy0, height, word);
};

/** Whether a tile-local footprint [x0, x1) × [y0, y1) touches a walkway corridor of a piece a path may run under. */
const touchesWalkway = (x0: number, y0: number, x1: number, y1: number): boolean => {
  const low = HALF_TILE - WALK_HALF_WIDTH;
  const high = HALF_TILE + WALK_HALF_WIDTH;
  if (y0 < high && y1 > low) return true;
  if (x0 < high && x1 > low) return true;
  const dx = Math.max(x0 - HALF_TILE, 0, HALF_TILE - x1);
  const dy = Math.max(y0 - HALF_TILE, 0, HALF_TILE - y1);
  return dx * dx + dy * dy < WALK_CENTRE_RADIUS * WALK_CENTRE_RADIUS;
};

/** The bent's per-column classes (rasterised strip between the legs). */
const SUPPORT_CLASS = new Uint8Array(TILE * TILE);
const SUPPORT_NONE = 0;
const SUPPORT_BEAM = 1;
const SUPPORT_BAY_CLASS = 2;
/** For bay columns: the brace step (0 … BRACE_STEPS − 1) of the column's position between the legs. */
const SUPPORT_STEP = new Uint8Array(TILE * TILE);

/** Legs of the bent being built: tile-local 2×2 minimum corners, and their across offsets. */
const LEG_X = new Int32Array(2);
const LEG_Y = new Int32Array(2);
const LEG_ACROSS = new Float64Array(2);
const LEG_PRESENT = new Uint8Array(2);

/** Emits the rectangles of a support strip class at z, `height` tall. */
const emitSupportClass = (frame: PieceFrame, minClass: number, z: number, height: number, word: number, out: BoxWriter): void => {
  for (let index = 0; index < TILE * TILE; index += 1) {
    GRID_KEYS[index] = SUPPORT_CLASS[index] >= minClass ? 0 : EMPTY;
  }
  emitTileRectangles(frame, mergeRectangles(TILE, TILE), z, height, word, out);
};

/**
 * Phase 39: a wooden coaster's lattice bay: both diagonals of the bay as one cross, emitted per brace step as the union
 * of the two diagonals' z ranges (one box where they meet, two where they do not), so no two boxes overlap.
 */
const emitCrossBrace = (frame: PieceFrame, bayZ: number, word: number, out: BoxWriter): void => {
  for (let step = 0; step < BRACE_STEPS; step += 1) {
    for (let index = 0; index < TILE * TILE; index += 1) {
      GRID_KEYS[index] = SUPPORT_CLASS[index] === SUPPORT_BAY_CLASS && SUPPORT_STEP[index] === step ? 0 : EMPTY;
    }
    const rectangles = mergeRectangles(TILE, TILE);
    const top = bayZ + SUPPORT_BAY;
    const z0 = bayZ + step * BRACE_RISE;
    const z1 = bayZ + (BRACE_STEPS - 1 - step) * BRACE_RISE;
    const end0 = Math.min(z0 + BRACE_HEIGHT, top);
    const end1 = Math.min(z1 + BRACE_HEIGHT, top);
    const low = Math.min(z0, z1);
    const lowEnd = z0 <= z1 ? end0 : end1;
    const high = Math.max(z0, z1);
    const highEnd = z0 <= z1 ? end1 : end0;
    if (high <= lowEnd) {
      emitTileRectangles(frame, rectangles, low, Math.max(lowEnd, highEnd) - low, word, out);
    } else {
      emitTileRectangles(frame, rectangles, low, lowEnd - low, word, out);
      emitTileRectangles(frame, rectangles, high, highEnd - high, word, out);
    }
  }
};

/** Emits one diagonal brace over the bay strip: `BRACE_STEPS` steps from `bayZ`, leaning the way `direction` says. */
const emitBrace = (frame: PieceFrame, bayZ: number, direction: number, word: number, out: BoxWriter): void => {
  for (let step = 0; step < BRACE_STEPS; step += 1) {
    const rise = direction > 0 ? step : BRACE_STEPS - 1 - step;
    const z = bayZ + rise * BRACE_RISE;
    const height = Math.min(BRACE_HEIGHT, bayZ + SUPPORT_BAY - z);
    for (let index = 0; index < TILE * TILE; index += 1) {
      GRID_KEYS[index] = SUPPORT_CLASS[index] === SUPPORT_BAY_CLASS && SUPPORT_STEP[index] === step ? 0 : EMPTY;
    }
    emitTileRectangles(frame, mergeRectangles(TILE, TILE), z, height, word, out);
  }
};

/**
 * The support bent of a raised piece: two legs on footings, a beam under the spine, and bracing
 * that grows with height (see the file comment). The strip between the legs follows the frame's
 * rolled normal at the bent, so a corner's bent is a rotated staircase of columns.
 */
const emitSupports = (frame: PieceFrame, look: CoasterLook, out: BoxWriter, lattice = false): void => {
  if (frame.height <= 0) return;
  const line = frame.line;
  sampleCentreLineFrame(line, centreLineSupportDistance(line, frame.index), BENT);
  const px = (BENT.x - frame.cellX) * TILE;
  const py = (BENT.y - frame.cellY) * TILE;
  // The legs stand on the plan normal (the bank tilts the rails by a voxel, not where a leg stands).
  const nx = -BENT.dirY;
  const ny = BENT.dirX;
  const tx = BENT.dirX;
  const ty = BENT.dirY;
  const walkway = frame.height >= GAME_CONFIG.coaster.pathClearanceHeight;

  // Legs: 2×2 columns 8 voxels either side of the line. On a piece a path may run under, a leg whose
  // footing touches a walkway corridor is moved 2 voxels along the tile axis away from that corridor
  // (and out of the centre disc), a few times; a leg that would leave the tile is dropped instead.
  for (let leg = 0; leg < 2; leg += 1) {
    const sign = leg === 0 ? -1 : 1;
    let cx = px + sign * SUPPORT_LEG_ACROSS * nx;
    let cy = py + sign * SUPPORT_LEG_ACROSS * ny;
    LEG_PRESENT[leg] = 0;
    for (let attempt = 0; attempt <= SUPPORT_MAX_SHIFTS; attempt += 1) {
      const x0 = Math.floor(cx) - 1;
      const y0 = Math.floor(cy) - 1;
      if (x0 < 0 || y0 < 0 || x0 + SUPPORT_SIZE > TILE || y0 + SUPPORT_SIZE > TILE) break;
      const fx0 = x0 - 1;
      const fy0 = y0 - 1;
      const fx1 = x0 + SUPPORT_SIZE + 1;
      const fy1 = y0 + SUPPORT_SIZE + 1;
      if (!walkway || !touchesWalkway(fx0, fy0, fx1, fy1)) {
        LEG_X[leg] = x0;
        LEG_Y[leg] = y0;
        LEG_ACROSS[leg] = ((x0 + 1 - px) * nx + (y0 + 1 - py) * ny);
        LEG_PRESENT[leg] = 1;
        break;
      }
      const low = HALF_TILE - WALK_HALF_WIDTH;
      const high = HALF_TILE + WALK_HALF_WIDTH;
      const awayX = cx >= HALF_TILE ? 1 : -1;
      const awayY = cy >= HALF_TILE ? 1 : -1;
      if (fy0 < high && fy1 > low) cy += awayY * SUPPORT_SHIFT;
      else if (fx0 < high && fx1 > low) cx += awayX * SUPPORT_SHIFT;
      else {
        cx += awayX * SUPPORT_SHIFT;
        cy += awayY * SUPPORT_SHIFT;
      }
    }
  }
  if (LEG_PRESENT[0] === 0 && LEG_PRESENT[1] === 0) return;
  const stripFrom = LEG_PRESENT[0] === 1 ? LEG_ACROSS[0] - 1 : 0;
  const stripTo = LEG_PRESENT[1] === 1 ? LEG_ACROSS[1] + 1 : 0;
  const bayFrom = LEG_PRESENT[0] === 1 ? LEG_ACROSS[0] + 1 : 0;
  const bayTo = LEG_PRESENT[1] === 1 ? LEG_ACROSS[1] - 1 : 0;
  const bayWidth = bayTo - bayFrom;

  // The strip: columns within a voxel of the bent line between the legs (never a leg's own column),
  // and the beam top: the lowest track bottom over the strip and the legs.
  SUPPORT_CLASS.fill(SUPPORT_NONE);
  let beamTop = Number.POSITIVE_INFINITY;
  for (let y = 0; y < TILE; y += 1) {
    for (let x = 0; x < TILE; x += 1) {
      const column = y * TILE + x;
      const dx = x + 0.5 - px;
      const dy = y + 0.5 - py;
      const across = dx * nx + dy * ny;
      const along = dx * tx + dy * ty;
      let inLeg = false;
      for (let leg = 0; leg < 2; leg += 1) {
        if (LEG_PRESENT[leg] === 1 && x >= LEG_X[leg] && x < LEG_X[leg] + SUPPORT_SIZE && y >= LEG_Y[leg] && y < LEG_Y[leg] + SUPPORT_SIZE) inLeg = true;
      }
      const inStrip = Math.abs(along) < 1 && across >= stripFrom && across < stripTo;
      if (!inLeg && !inStrip) continue;
      if (COLUMN_FLAGS[column] & FLAG_BAND) beamTop = Math.min(beamTop, trackBottomAt(column));
      if (inLeg) continue;
      if (bayWidth > 0 && across >= bayFrom && across < bayTo) {
        SUPPORT_CLASS[column] = SUPPORT_BAY_CLASS;
        SUPPORT_STEP[column] = Math.min(BRACE_STEPS - 1, Math.floor(((across - bayFrom) * BRACE_STEPS) / bayWidth));
      } else {
        SUPPORT_CLASS[column] = SUPPORT_BEAM;
      }
    }
  }
  // No track over the bent at all (a malformed layout): the piece's own rail top.
  if (beamTop === Number.POSITIVE_INFINITY) beamTop = frame.railTop - TRACK_DEPTH;
  const footingTop = SUPPORT_FOOTING_TOP;
  if (beamTop - SUPPORT_BEAM_HEIGHT <= footingTop) return;
  const supportWord = packBoxWord(look.support, frame.outlineGroup, PATTERN.PLAIN, 0);
  const footingWord = packBoxWord(MAT.STONE, frame.outlineGroup, PATTERN.PLAIN, 0);
  for (let leg = 0; leg < 2; leg += 1) {
    if (LEG_PRESENT[leg] === 0) continue;
    const x0 = LEG_X[leg];
    const y0 = LEG_Y[leg];
    pushLocalBox(frame, x0 - 1, y0 - 1, x0 + SUPPORT_SIZE + 1, y0 + SUPPORT_SIZE + 1, SUPPORT_FOOTING_Z, footingTop - SUPPORT_FOOTING_Z, footingWord, out);
    pushLocalBox(frame, x0, y0, x0 + SUPPORT_SIZE, y0 + SUPPORT_SIZE, footingTop, beamTop - footingTop, supportWord, out);
  }
  emitSupportClass(frame, SUPPORT_BEAM, beamTop - SUPPORT_BEAM_HEIGHT, SUPPORT_BEAM_HEIGHT, supportWord, out);
  if (bayWidth <= 0 || beamTop < SUPPORT_RUNG_Z + SUPPORT_RUNG_HEIGHT + SUPPORT_BEAM_HEIGHT) return;
  // Bracing: the first rung above a walking guest, then a diagonal per bay and a rung between bays.
  emitSupportClass(frame, SUPPORT_BAY_CLASS, SUPPORT_RUNG_Z, SUPPORT_RUNG_HEIGHT, supportWord, out);
  let z = SUPPORT_RUNG_Z + SUPPORT_RUNG_HEIGHT;
  let bay = 0;
  while (z + SUPPORT_BAY <= beamTop - SUPPORT_BEAM_HEIGHT) {
    if (lattice) emitCrossBrace(frame, z, supportWord, out);
    else emitBrace(frame, z, bay % 2 === 0 ? 1 : -1, supportWord, out);
    z += SUPPORT_BAY;
    bay += 1;
    if (z + SUPPORT_RUNG_HEIGHT + SUPPORT_BAY > beamTop - SUPPORT_BEAM_HEIGHT) break;
    emitSupportClass(frame, SUPPORT_BAY_CLASS, z, SUPPORT_RUNG_HEIGHT, supportWord, out);
    z += SUPPORT_RUNG_HEIGHT;
  }
};

// ---------------------------------------------------------------------------------------------
// Loop ring

const LOOP_COLUMNS = 2 * LOOP_REACH;
const LOOP_ROWS = 2 * LOOP_OUTER_RADIUS + 3;
/** Columns of the ring's plane counted from this piece's centre along travel. */
const LOOP_FIRST_COLUMN = HALF_TILE - LOOP_REACH;
const LOOP_TOPS = new Int32Array(LOOP_COLUMNS);

const NEXT_COLUMN_TOP = new Int32Array(TILE * TILE);
const NEXT_COLUMN_FLAGS = new Uint8Array(TILE * TILE);
const NEXT_COLUMN_TOP_KIND = new Uint8Array(TILE * TILE);
const ARM_COLUMNS = HALF_TILE;

/**
 * Rail top of the track under column `column` of the loop's plane, counted from this piece's centre
 * along travel (−14 … 45): the straight piece's own line up to its exit edge, then the next piece's
 * columns under the ring's far half — the highest track column within the ring's width, so a next
 * piece that turns away or climbs never reaches into the ring (and the ring is cut only where
 * track really is).
 */
const trackTopAlongLoop = (frame: PieceFrame, nextFrame: PieceFrame, column: number): number => {
  if (column < ARM_COLUMNS) return railTopAt(frame, 0.5 + (column + 0.5) / TILE);
  const along = column - ARM_COLUMNS;
  // The straight continuation of the line: right for a straight next piece, a lower bound otherwise.
  let top = railTopAt(nextFrame, (along + 0.5) / TILE);
  const forwardSign = nextFrame.inX + nextFrame.inY;
  const acrossIsY = nextFrame.inX !== 0;
  const position = forwardSign > 0 ? along : TILE - 1 - along;
  for (let across = -TRACK_HALF_WIDTH; across < TRACK_HALF_WIDTH; across += 1) {
    const x = acrossIsY ? position : HALF_TILE + across;
    const y = acrossIsY ? HALF_TILE + across : position;
    if (NEXT_COLUMN_FLAGS[y * TILE + x] & FLAG_BAND) top = Math.max(top, NEXT_COLUMN_TOP[y * TILE + x]);
  }
  return top;
};

const RING_RAILS = 0;
const RING_TIES = 1;
const RING_SPINE = 2;

/**
 * The loop ring of a loop piece: the centre line's circle of radius 16 in the vertical plane of
 * travel, rotated by the track's pitch α at its base M (the rail top on the piece's exit edge), so
 * the ring's centre is M + 16 · (−sin α, cos α) in (along, up) and the ring enters and leaves along
 * the ramp's tangent. In the ring's plane, three passes over its (along, z) grid: the rails (annulus
 * [16, 18), |across| ∈ [2, 4)), the ties (the same annulus at |across| < 2, a radial bar every 4
 * voxels of arc) and the spine ([18, 20), |across| < 1). Voxels at or below the straight track's
 * rail top are left to the straight track, so nothing overlaps.
 */
const emitLoopRing = (pieces: readonly CoasterPiece[], index: number, frame: PieceFrame, look: CoasterLook, out: BoxWriter): void => {
  const next = readPiece(pieces, index + 1, NEXT_FRAME);
  layoutBand(next, pieces, NEXT_COLUMN_FLAGS, NEXT_COLUMN_TOP, NEXT_COLUMN_TOP_KIND);
  // M, the ring's base: the line's rail top on the exit edge, where the cars run in and out.
  centreLineHeightAt(frame.line, frame.line.groundStart[index + 1], HEIGHT);
  const baseZ = coasterRailTopZ(HEIGHT.z);
  const pitch = frame.line.ringEntryPitch[index];
  const pitchCos = Math.cos(pitch);
  const pitchSin = Math.sin(pitch);
  const centreAlong = -LOOP_RAIL_RADIUS * pitchSin;
  const centreZ = baseZ + LOOP_RAIL_RADIUS * pitchCos;
  const firstRow = Math.floor(centreZ - LOOP_OUTER_RADIUS) - 1;
  for (let column = 0; column < LOOP_COLUMNS; column += 1) {
    LOOP_TOPS[column] = trackTopAlongLoop(frame, next, LOOP_FIRST_COLUMN + column);
  }
  const railInner = LOOP_RAIL_RADIUS * LOOP_RAIL_RADIUS;
  const railOuter = (LOOP_RAIL_RADIUS + LOOP_RAIL_THICKNESS) * (LOOP_RAIL_RADIUS + LOOP_RAIL_THICKNESS);
  const outer = LOOP_OUTER_RADIUS * LOOP_OUTER_RADIUS;
  const railWord = packBoxWord(look.rail, frame.outlineGroup, PATTERN.PLAIN, 0);
  const tieWord = packBoxWord(look.tie, frame.outlineGroup, PATTERN.PLAIN, 0);
  const spineWord = packBoxWord(look.spine, frame.outlineGroup, PATTERN.PLAIN, 0);
  const alongX = frame.outX;
  const alongY = frame.outY;
  const acrossX = frame.outY !== 0 ? 1 : 0;
  const acrossY = frame.outX !== 0 ? 1 : 0;
  const railInnerAcross = TRACK_HALF_WIDTH - RAIL_WIDTH;
  const tieHalfArc = 0.75;
  for (let pass = RING_RAILS; pass <= RING_SPINE; pass += 1) {
    const from = pass === RING_SPINE ? railOuter : railInner;
    const to = pass === RING_SPINE ? outer : railOuter;
    for (let row = 0; row < LOOP_ROWS; row += 1) {
      const z = firstRow + row;
      const dz = z + 0.5 - centreZ;
      for (let column = 0; column < LOOP_COLUMNS; column += 1) {
        // The ring's base M sits on the tile edge, 16 columns from this piece's centre.
        const along = LOOP_FIRST_COLUMN + column + 0.5 - HALF_TILE - centreAlong;
        const distance = along * along + dz * dz;
        let inRing = z >= LOOP_TOPS[column] && distance >= from && distance < to;
        if (inRing && pass === RING_TIES) {
          // Angle round the ring from its base, in the rotated plane: a tie every 4 voxels of arc.
          const forward = along * pitchCos + dz * pitchSin;
          const up = -along * pitchSin + dz * pitchCos;
          let angle = Math.atan2(forward, -up);
          if (angle < 0) angle += 2 * Math.PI;
          const arc = (angle * LOOP_RAIL_RADIUS) % TIE_PERIOD;
          inRing = arc < tieHalfArc || arc > TIE_PERIOD - tieHalfArc;
        }
        GRID_KEYS[row * LOOP_COLUMNS + column] = inRing ? 1 : EMPTY;
      }
    }
    const count = mergeRectangles(LOOP_COLUMNS, LOOP_ROWS);
    for (let rectangle = 0; rectangle < count; rectangle += 1) {
      const at = rectangle * RECT_STRIDE;
      const alongFrom = LOOP_FIRST_COLUMN + RECTS[at];
      const alongTo = LOOP_FIRST_COLUMN + RECTS[at + 1];
      const z = firstRow + RECTS[at + 2];
      const height = RECTS[at + 3] - RECTS[at + 2];
      if (pass === RING_RAILS) {
        pushTileBox(frame, alongX, alongY, alongFrom, alongTo, acrossX, acrossY, -TRACK_HALF_WIDTH, -railInnerAcross, z, height, railWord, out);
        pushTileBox(frame, alongX, alongY, alongFrom, alongTo, acrossX, acrossY, railInnerAcross, TRACK_HALF_WIDTH, z, height, railWord, out);
      } else if (pass === RING_TIES) {
        pushTileBox(frame, alongX, alongY, alongFrom, alongTo, acrossX, acrossY, -railInnerAcross, railInnerAcross, z, height, tieWord, out);
      } else {
        pushTileBox(frame, alongX, alongY, alongFrom, alongTo, acrossX, acrossY, -SPINE_HALF_WIDTH, SPINE_HALF_WIDTH, z, height, spineWord, out);
      }
    }
  }
};

// ---------------------------------------------------------------------------------------------
// Station

/** Side (±1 along the positive axis across the station) a turned station arm leaves toward, or 0. */
const turnSide = (stepX: number, stepY: number, stationX: number, stationY: number): number => {
  if (stepX === stationX && stepY === stationY) return 0;
  return stationX !== 0 ? stepY : stepX;
};

/** A box on the far side of a piece running along (dirX, dirY): `near`/`far` are distances across from the track. */
const farSideBox = (
  frame: PieceFrame,
  dirX: number,
  dirY: number,
  alongFrom: number,
  alongTo: number,
  near: number,
  far: number,
  z: number,
  height: number,
  word: number,
  out: BoxWriter,
): void => {
  const acrossX = dirY !== 0 ? 1 : 0;
  const acrossY = dirX !== 0 ? 1 : 0;
  pushTileBox(frame, dirX, dirY, alongFrom, alongTo, acrossX, acrossY, -far, -near, z, height, word, out);
};

/**
 * Platform with an accent edge, a striped canopy with an accent valance on one post, the queue
 * gate and the dispatch light, on the far side of a station piece (see the file comment).
 */
const emitStation = (
  pieces: readonly CoasterPiece[],
  index: number,
  frame: PieceFrame,
  definition: BuildDefinition,
  palette: Palette,
  out: BoxWriter,
  paint: Uint8Array | null,
): void => {
  if (!isStationPiece(pieces, index)) return;
  const stationLength = stationLengthOf(pieces);
  const group = frame.outlineGroup;
  const stationX = stepX(pieces[0].cell, pieces[1].cell);
  const stationY = stepY(pieces[0].cell, pieces[1].cell);
  // A station end that turns off toward the far side keeps only the part clear of the turning arc:
  // the arc round the far corner fills the half of the tile where the track turns (the rounded
  // corner reaches 20 voxels from the corner, i.e. 4 voxels past the tile centre).
  let alongFrom = -HALF_TILE;
  let alongTo = HALF_TILE;
  if (index === 0) {
    const first = readPiece(pieces, 0, STATION_FRAME);
    if (turnSide(first.inX, first.inY, stationX, stationY) === FAR_SIDE_TURN_IN) alongTo = -STATION_ARC_CLEARANCE;
  }
  if (index === stationLength - 1) {
    const last = readPiece(pieces, stationLength - 1, STATION_FRAME);
    if (turnSide(last.outX, last.outY, stationX, stationY) === -1) alongFrom = STATION_ARC_CLEARANCE;
  }
  if (alongTo <= alongFrom) return;
  // A loop ring on the piece before a turning first station piece reaches across the tile over the
  // platform's far half (up to 28 voxels in, at canopy height): that piece keeps its platform only.
  const ringOver = index === 0 && !frame.straight && frame.line.loop[(pieces.length - 1) % pieces.length] === 1;

  const platformWord = packBoxWord(MAT.STONE, group, PATTERN.PLAIN, 0);
  // Phase 28: the platform edge, valance and queue gate follow the 'rail' slot, the canopy stripes the 'primary' one.
  const railPaint = paintedMaterial(definition.id, paint, 'rail');
  const trainPaint = paintedMaterial(definition.id, paint, 'primary');
  const accentWord = packBoxWord(railPaint !== 0 ? railPaint : palette.material(definition.accent), group, PATTERN.PLAIN, 0);
  const postWord = packBoxWord(MAT.STEEL, group, PATTERN.PLAIN, 0);
  // Stripes run across the station: the pattern's bands alternate along model x.
  const canopyWord = packBoxWord(trainPaint !== 0 ? trainPaint : palette.material(definition.color), group, PATTERN.STRIPES, stationX !== 0 ? 0 : 1);
  const bulbWord = packBoxWord(MAT.BULB, group, PATTERN.PLAIN, 0);
  // The platform stands on the grass (a station cell has no paving or slab) and rises to the rail top.
  const platformHeight = PLATFORM_TOP_Z - GROUND_TOP_Z;
  const edge = PLATFORM_NEAR + PLATFORM_EDGE_WIDTH;
  const postHeight = CANOPY_BOTTOM_Z - PLATFORM_TOP_Z;
  const postAlong = Math.floor((alongFrom + alongTo) / 2) - CANOPY_POST_SIZE / 2;
  const postNear = PLATFORM_FAR - CANOPY_POST_SIZE;
  const valanceZ = CANOPY_BOTTOM_Z - VALANCE_DEPTH;
  farSideBox(frame, stationX, stationY, alongFrom, alongTo, PLATFORM_NEAR, edge, GROUND_TOP_Z, platformHeight, accentWord, out);
  farSideBox(frame, stationX, stationY, alongFrom, alongTo, edge, PLATFORM_FAR, GROUND_TOP_Z, platformHeight, platformWord, out);
  if (ringOver) return;
  farSideBox(frame, stationX, stationY, postAlong, postAlong + CANOPY_POST_SIZE, postNear, PLATFORM_FAR, PLATFORM_TOP_Z, postHeight, postWord, out);
  farSideBox(frame, stationX, stationY, alongFrom, alongTo, CANOPY_NEAR, HALF_TILE, CANOPY_BOTTOM_Z, CANOPY_THICKNESS, canopyWord, out);
  farSideBox(frame, stationX, stationY, alongFrom, alongTo, CANOPY_NEAR, CANOPY_NEAR + VALANCE_DEPTH, valanceZ, VALANCE_DEPTH, accentWord, out);
  for (let bulb = 0; bulb < STATION_BULB_ALONG.length; bulb += 1) {
    const along = STATION_BULB_ALONG[bulb];
    if (along < alongFrom || along + STATION_BULB_SIZE > alongTo) continue;
    const bulbTo = along + STATION_BULB_SIZE;
    farSideBox(frame, stationX, stationY, along, bulbTo, CANOPY_NEAR, CANOPY_NEAR + STATION_BULB_SIZE, valanceZ - 1, 1, bulbWord, out);
  }
  // The queue gate at the entry end of the first piece: two accent posts with a bar across their tops.
  if (index === 0 && GATE_ALONG >= alongFrom && GATE_ALONG + GATE_POST_SIZE <= alongTo) {
    const gateTo = GATE_ALONG + GATE_POST_SIZE;
    farSideBox(frame, stationX, stationY, GATE_ALONG, gateTo, GATE_NEAR, GATE_NEAR + GATE_POST_SIZE, PLATFORM_TOP_Z, GATE_HEIGHT, accentWord, out);
    farSideBox(frame, stationX, stationY, GATE_ALONG, gateTo, GATE_FAR - GATE_POST_SIZE, GATE_FAR, PLATFORM_TOP_Z, GATE_HEIGHT, accentWord, out);
    farSideBox(frame, stationX, stationY, GATE_ALONG, gateTo, GATE_NEAR, GATE_FAR, PLATFORM_TOP_Z + GATE_HEIGHT, 1, accentWord, out);
  }
  // The dispatch light at the exit end of the last piece: a steel post with a bulb on top.
  if (index === stationLength - 1 && DISPATCH_ALONG >= alongFrom && DISPATCH_ALONG + CANOPY_POST_SIZE <= alongTo) {
    const lightTo = DISPATCH_ALONG + CANOPY_POST_SIZE;
    const lightFar = DISPATCH_NEAR + CANOPY_POST_SIZE;
    farSideBox(frame, stationX, stationY, DISPATCH_ALONG, lightTo, DISPATCH_NEAR, lightFar, PLATFORM_TOP_Z, DISPATCH_POST_HEIGHT, postWord, out);
    farSideBox(frame, stationX, stationY, DISPATCH_ALONG, lightTo, DISPATCH_NEAR, lightFar, PLATFORM_TOP_Z + DISPATCH_POST_HEIGHT, DISPATCH_BULB_HEIGHT, bulbWord, out);
  }
};

/**
 * The brake fin of the last piece (the run into the station), when it is straight: a dark post
 * (FENCE_POST, a material no other coaster element uses) beside the tie at along 28, on the far side
 * of the track, hanging on the tie's side (so a raised last piece carries it too).
 */
const emitBrakeFin = (pieces: readonly CoasterPiece[], frame: PieceFrame, out: BoxWriter): void => {
  if (pieces.length < 2 || frame.index !== pieces.length - 1 || !frame.straight) return;
  const alongX = frame.outX;
  const alongY = frame.outY;
  const top = railTopAt(frame, (BRAKE_FIN_ALONG + 0.5) / TILE);
  const z = top - RAIL_HEIGHT - TIE_THICKNESS;
  const finWord = packBoxWord(MAT.FENCE_POST, frame.outlineGroup, PATTERN.PLAIN, 0);
  farSideBox(frame, alongX, alongY, BRAKE_FIN_ALONG - HALF_TILE, BRAKE_FIN_ALONG + TIE_LENGTH - HALF_TILE, TRACK_HALF_WIDTH, TRACK_HALF_WIDTH + 2, z, BRAKE_FIN_HEIGHT, finWord, out);
};

// ---------------------------------------------------------------------------------------------
// Pieces

/** Phase 38: whether another piece of the same layout runs under piece `index` in its cell (the track crosses itself). */
const hasLowerPieceInCell = (pieces: readonly CoasterPiece[], index: number): boolean => {
  const piece = pieces[index];
  if (piece === undefined) return false;
  for (let other = 0; other < pieces.length; other += 1) {
    const candidate = pieces[other];
    if (other !== index && candidate.cell.x === piece.cell.x && candidate.cell.y === piece.cell.y && candidate.height < piece.height) return true;
  }
  return false;
};

const pieceBoxes = (
  pieces: readonly CoasterPiece[],
  index: number,
  definition: BuildDefinition,
  palette: Palette,
  outlineGroup: number,
  out: BoxWriter,
  paint: Uint8Array | null = null,
  supports = true,
): void => {
  if (pieces.length === 0) return;
  const piece = pieceAt(pieces, index);
  const frame = readPiece(pieces, index, FRAME);
  frame.outlineGroup = outlineGroup;
  const look = coasterLook(definition, palette, LOOK, paint);
  const special = frame.straight ? piece.special : undefined;
  layoutColumns(frame, pieces, special);
  const station = isStationPiece(pieces, index);
  // The lower layer: the spine, or the station's stone bed over the whole width (down to the grass at level 0).
  if (station) {
    emitLowerLayer(frame, FLAG_BAND, packBoxWord(MAT.STONE, outlineGroup, PATTERN.PLAIN, 0), out);
  } else {
    emitLowerLayer(frame, FLAG_SPINE, packBoxWord(look.spine, outlineGroup, PATTERN.PLAIN, 0), out);
  }
  emitFlagged(frame, FLAG_TIE, -RAIL_HEIGHT - TIE_THICKNESS, TIE_THICKNESS, packBoxWord(look.tie, outlineGroup, PATTERN.PLAIN, 0), out);
  emitTopLayer(frame, TOP_RAIL, packBoxWord(look.rail, outlineGroup, PATTERN.PLAIN, 0), out);
  emitTopLayer(frame, TOP_CHAIN, packBoxWord(MAT.FENCE_RAIL, outlineGroup, PATTERN.PLAIN, 0), out);
  emitTopLayer(frame, TOP_BRAKE, packBoxWord(MAT.CONCRETE, outlineGroup, PATTERN.PLAIN, 0), out);
  emitTopLayer(frame, TOP_CHEVRON, packBoxWord(MAT.BULB, outlineGroup, PATTERN.PLAIN, 0), out);
  // Phase 38: a piece crossing over other track (or a low object) stands on no bent: its legs would come down on
  // what is below. Its neighbours' bents carry it.
  if (supports && !hasLowerPieceInCell(pieces, index)) {
    emitSupports(frame, look, out, COASTER_TYPE_BY_ID.get(definition.id)?.family === 'wooden');
  }
  if (special === 'loop') emitLoopRing(pieces, index, frame, look, out);
  emitStation(pieces, index, frame, definition, palette, out, paint);
  emitBrakeFin(pieces, frame, out);
};

// ---------------------------------------------------------------------------------------------
// Cars, riders and couplings (Phase 27 step 3)

/**
 * Car space (content.ts): +x travel, +y the car's left, z = 0 the rail top, the pivot at the car's
 * centre. Every car shares one envelope, x [−5, 5) × y [−4, 4) × z [−1, 8): ten long is the most
 * a car can be before neighbouring cars touch inside a loop (the rims of two cars one spacing apart
 * on a radius-16 ring are 10.5 apart). Only the lead car's nose (to x = 8) and the last car's tail
 * (to x = −8) leave it, and nothing couples there.
 */
export const CAR_HALF_LENGTH = 5;
export const CAR_HALF_WIDTH = 4;
/** Top of the car body rim above the rail top; backrests, riders and restraints stand above it. */
export const CAR_HEIGHT = 8;
/** Lead car's nose and the last car's tail reach this far past the envelope. */
export const CAR_NOSE_LENGTH = 3;
/**
 * A coupling is two half-bars of this length (voxels), one from each hitch toward the other: together
 * they bridge every measured hitch distance (9.4 to 15.6 voxels on every fixture and fuzz circuit),
 * and one half alone never reaches the far hitch.
 */
export const COUPLING_HALF_LENGTH = 8;
/** The longest hitch distance the two halves close (voxels). */
export const COUPLING_LENGTH = 2 * COUPLING_HALF_LENGTH;

/** Box counts of the car, rider and coupling models, asserted against BOX_BUDGET. */
const BODY_BOTTOM = 2;
const RIM = 7;
const COCKPIT_FLOOR = 4;

/** A car-space box from its minimum to its maximum corner. */
const carBox = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, material: number, pattern: number = PATTERN.PLAIN): Shape =>
  ({ kind: 'box', min: [x0, y0, z0], size: [x1 - x0, y1 - y0, z1 - z0], material, pattern });

/** A box and its mirror image across y = 0 (both sides of the car). */
const mirrored = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, material: number, pattern: number = PATTERN.PLAIN): Shape[] =>
  [carBox(x0, y0, z0, x1, y1, z1, material, pattern), carBox(x0, -y1, z0, x1, -y0, z1, material, pattern)];

type CoasterKind = 'comet' | 'star' | 'serpent' | 'mouse' | 'timber';

const kindOf = (definition: BuildDefinition): CoasterKind => {
  if (definition.id === 'star-chaser') return 'star';
  if (definition.id === 'skyline-serpent') return 'serpent';
  // Phase 39: the families after steel get their own car by family, so a second type of a family looks the part.
  const family = COASTER_TYPE_BY_ID.get(definition.id)?.family;
  if (family === 'wild-mouse') return 'mouse';
  if (family === 'wooden') return 'timber';
  return 'comet';
};

/** Colours of one car: a catalog colour pair and a per-type trim. */
interface CarLook {
  body: number;
  trim: number;
  seat: number;
}

/**
 * Phase 28: the body, nose, tail and stripes are colour slot 'primary' (Train); seats, restraints, the fin and
 * (star, serpent) the trim band are 'secondary' (Seats). Wheels, chassis, headlights, eyes and riders stay fixed.
 */
const carLook = (definition: BuildDefinition, kind: CoasterKind, palette: Palette): CarLook => {
  const tag = slotTagger(definition.id);
  const body = tag('primary', palette.material(definition.color));
  const seat = tag('secondary', palette.material(definition.accent));
  return { body, seat, trim: kind === 'comet' ? MAT.WHITE : kind === 'timber' ? MAT.WOOD : seat };
};

/** Rows of seats: the front row's rider sits at x [1, 3), the back row's at x [−3, −1). */
const SEAT_ROWS: readonly { backrest: number; rider: number; bar: number }[] = [
  { backrest: 0, rider: 1, bar: 3 },
  { backrest: -4, rider: -3, bar: -1 },
];

/** Which car of the type a car index is: the lead, the last (the serpent's tail) or a middle car. */
const carRole = (definition: BuildDefinition, carIndex: number): 'lead' | 'last' | 'mid' => {
  if (carIndex === 0) return 'lead';
  const cars = COASTER_TYPE_BY_ID.get(definition.id)?.trainCars ?? 0;
  return kindOf(definition) === 'serpent' && carIndex === cars - 1 ? 'last' : 'mid';
};

const noseShapes = (kind: CoasterKind, look: CarLook): Shape[] => {
  const shapes: Shape[] = [];
  if (kind === 'comet') {
    // A friendly rounded nose with two headlights and a little star on top.
    shapes.push(
      carBox(5, -3, BODY_BOTTOM, 7, 3, 5, look.body),
      carBox(7, -2, BODY_BOTTOM, 8, 2, 4, look.body),
      ...mirrored(7, 2, 3, 8, 3, 4, MAT.LAMP_GLOW),
      carBox(5, -1, 5, 7, 1, 6, look.seat),
      carBox(5, -2, 5, 6, 2, 6, look.seat),
    );
  } else if (kind === 'star') {
    // A pointed wedge, two headlights, and a tall fin on the front wall.
    shapes.push(
      carBox(5, -3, BODY_BOTTOM, 6, 3, 5, look.body),
      carBox(6, -2, BODY_BOTTOM, 7, 2, 4, look.body),
      carBox(7, -1, BODY_BOTTOM, 8, 1, 3, look.body),
      ...mirrored(6, 1, 3, 7, 2, 4, MAT.LAMP_GLOW),
      carBox(3, -1, RIM, 5, 1, 9, look.seat),
    );
  } else if (kind === 'mouse') {
    // Phase 39: a mouse's face: a short rounded snout with a pink nose and dark whiskers, two round ears at the back.
    shapes.push(
      carBox(5, -3, BODY_BOTTOM, 7, 3, 6, look.body),
      carBox(7, -2, BODY_BOTTOM + 1, 8, 2, 4, look.body),
      carBox(7, -1, 4, 8, 1, 5, look.seat),
      ...mirrored(5, 1, 5, 6, 2, 6, MAT.INK),
      ...mirrored(7, 2, 4, 8, 4, 5, MAT.INK),
      ...mirrored(-5, 1, RIM, -3, 4, RIM + 3, look.body),
      ...mirrored(-5, 2, RIM + 1, -4, 3, RIM + 2, look.seat),
    );
  } else if (kind === 'timber') {
    // Phase 39: a mine-cart front: a blunt wooden bumper, iron straps and one lantern.
    shapes.push(
      carBox(5, -4, BODY_BOTTOM, 7, 4, 5, MAT.WOOD),
      carBox(5, -4, 3, 7, 4, 4, MAT.STEEL),
      carBox(6, -1, 5, 7, 1, 7, MAT.LAMP_GLOW),
    );
  } else {
    // A serpent's head: a long snout, white eyes with a dark pupil, a dark jaw line, glowing nostrils.
    shapes.push(
      carBox(5, -3, BODY_BOTTOM, 8, 3, 5, look.body),
      carBox(6, -3, BODY_BOTTOM, 8, 3, 3, MAT.INK),
      ...mirrored(5, 1, 5, 6, 3, 6, MAT.WHITE),
      ...mirrored(5, 2, 5, 6, 3, 6, MAT.INK),
      ...mirrored(7, 1, 4, 8, 2, 5, MAT.LAMP_GLOW),
    );
  }
  return shapes;
};

const tailShapes = (look: CarLook): Shape[] => [
  carBox(-7, -2, BODY_BOTTOM, -5, 2, 5, look.body),
  carBox(-8, -1, BODY_BOTTOM, -7, 1, 4, look.trim),
];

/** Restraints of one row: lap bars on the comet, over-the-shoulder hoops on the looping types. */
const restraintShapes = (kind: CoasterKind, row: { backrest: number; bar: number }, look: CarLook): Shape[] => {
  if (kind === 'star') {
    // A tall hoop behind the riders' heads: two posts and a bar over them, plus a lap bar.
    return [
      carBox(row.bar, -3, 6, row.bar + 1, 3, RIM, look.seat),
      ...mirrored(row.backrest, 1, 8, row.backrest + 1, 3, 10, look.seat),
      carBox(row.backrest, -3, 10, row.backrest + 1, 3, 11, look.seat),
    ];
  }
  return [carBox(row.bar, -3, 6, row.bar + 1, 3, RIM, look.seat)];
};

/**
 * A car: a navy chassis on four running wheels and four guide wheels, a body tub in the coaster's
 * colour with a trim band all round, an open cockpit with two rows of accent seats and restraints,
 * and per type a lead car with a clear front (comet: rounded nose with headlights and a star; star
 * chaser: a pointed wedge with a fin; serpent: a snake's head, and a tail on the last car). Riders
 * are a separate part (`riderBlueprint`), couplings too (`couplingBlueprint`).
 */
const carBlueprint = (definition: BuildDefinition, carIndex: number, palette: Palette): Blueprint => {
  const kind = kindOf(definition);
  const look = carLook(definition, kind, palette);
  const role = carRole(definition, carIndex);
  const x = CAR_HALF_LENGTH;
  const y = CAR_HALF_WIDTH;
  // Later shapes overwrite earlier ones (material 0 carves).
  const shapes: Shape[] = [
    carBox(-4, -3, 1, 4, 3, 3, MAT.TRAIN),
    // Running wheels (front and rear bogie, both rails) and guide wheels outside the rails.
    ...mirrored(1, 2, 0, 4, 4, 2, MAT.INK),
    ...mirrored(-4, 2, 0, -1, 4, 2, MAT.INK),
    ...mirrored(2, 4, -1, 3, 5, 1, MAT.STEEL_LIGHT),
    ...mirrored(-3, 4, -1, -2, 5, 1, MAT.STEEL_LIGHT),
    carBox(-x, -y, BODY_BOTTOM, x, y, RIM, look.body),
  ];
  if (kind === 'serpent') shapes.push(carBox(-x, -y, 3, x, y, 6, look.body, PATTERN.STRIPES));
  shapes.push(carBox(-x, -y, 4, x, y, 5, look.trim));
  if (role === 'lead') shapes.push(...noseShapes(kind, look));
  if (role === 'last') shapes.push(...tailShapes(look));
  shapes.push(carBox(-4, -3, COCKPIT_FLOOR, 4, 3, RIM, MATERIAL_EMPTY));
  for (const row of SEAT_ROWS) {
    shapes.push(
      carBox(row.rider, -3, COCKPIT_FLOOR, row.rider + 2, 3, COCKPIT_FLOOR + 1, look.seat),
      carBox(row.backrest, -3, COCKPIT_FLOOR, row.backrest + 1, 3, RIM + 1, look.seat),
      ...restraintShapes(kind, row, look),
    );
  }
  return {
    id: `coaster-car:${definition.id}:${role}`,
    footprint: [1, 1],
    floorZ: -1,
    parts: [{ id: 'body', pivot: [0, 0, 0], shapes }],
  };
};

/** Hair, skin and shirt colour of rider `seat` of car `carIndex`: deterministic, and none of it is a guest. */
const riderColours = (carIndex: number, seat: number, palette: Palette): { shirt: number; skin: number; hair: number } => ({
  shirt: palette.material(GUEST_COLORS[(2 * carIndex + seat) % GUEST_COLORS.length]),
  skin: SKIN_MATERIALS[(carIndex + seat) % SKIN_MATERIALS.length],
  hair: [MAT.HAIR_DARK, MAT.HAIR_BROWN, MAT.HAIR_BLOND][(carIndex + 2 * seat) % 3],
});

/**
 * Where seat k of a car sits (front row first): its rider box's x and y corners. A one-seat car (the
 * serpent's back cars) seats its rider in the middle of the front row.
 */
const SEAT_SPOTS: readonly (readonly [number, number])[] = [
  [SEAT_ROWS[0].rider, 1], [SEAT_ROWS[0].rider, -3], [SEAT_ROWS[1].rider, 1], [SEAT_ROWS[1].rider, -3],
];
const SINGLE_SEAT_SPOT: readonly [number, number] = [SEAT_ROWS[0].rider, -1];

/**
 * The riders of car `carIndex`: as many as the car has seats (`coasterCarSeats`: the type's train
 * capacity spread over its cars, 3 per comet car, 2 per star chaser car, 2 or 1 per serpent car), front
 * row first, each a torso in a guest shirt colour, a head and hair; the looping types' riders put
 * their hands up. A full train shows exactly its capacity. It is a separate rigid part posed with the
 * car (or hidden by the collapse pose, contracts/rigid.ts) so the train never rebuilds when it fills.
 */
const riderBlueprint = (definition: BuildDefinition, carIndex: number, palette: Palette): Blueprint => {
  const kind = kindOf(definition);
  const type = COASTER_TYPE_BY_ID.get(definition.id);
  const seats = type ? coasterCarSeats(carIndex, type.trainCapacity, type.trainCars) : 0;
  const shapes: Shape[] = [];
  for (let seat = 0; seat < seats; seat += 1) {
    const [x0, side] = seats === 1 ? SINGLE_SEAT_SPOT : SEAT_SPOTS[seat];
    const colours = riderColours(carIndex, seat, palette);
    shapes.push(
      carBox(x0, side, COCKPIT_FLOOR + 1, x0 + 2, side + 2, RIM, colours.shirt),
      // The face looks ahead (+x): hair covers the back half of the head, so skin shows from above.
      carBox(x0 + 1, side, RIM, x0 + 2, side + 2, RIM + 2, colours.skin),
      carBox(x0, side, RIM, x0 + 1, side + 2, RIM + 3, colours.hair),
    );
    if (kind !== 'comet' && kind !== 'mouse') shapes.push(carBox(x0, side, RIM + 3, x0 + 2, side + 2, RIM + 5, colours.shirt));
  }
  // A car without seats (a type whose capacity is below its car count) still needs a valid model:
  // an empty one would not compile, so it gets a one-voxel seat cushion that the collapse pose hides.
  if (shapes.length === 0) shapes.push(carBox(SEAT_ROWS[0].rider, -1, COCKPIT_FLOOR, SEAT_ROWS[0].rider + 1, 0, COCKPIT_FLOOR + 1, palette.material(definition.accent)));
  return {
    id: `coaster-riders:${definition.id}:${carIndex}`,
    footprint: [1, 1],
    floorZ: -1,
    parts: [{ id: 'body', pivot: [0, 0, 0], shapes }],
  };
};

/**
 * Half of the coupling between two cars: a dark bar from its pivot (one car's hitch) along +x for
 * `COUPLING_HALF_LENGTH`, at the chassis' height, with a steel clevis at the hitch. Two halves make a
 * coupling, each posed from its own car's hitch toward the other's (coasterCarFrame.ts
 * `coasterCouplingHalfFrame`), so the bar follows the curve while the cars stay rigid and no end ever
 * reaches past a hitch into (or out under) a car.
 */
const couplingBlueprint = (definition: BuildDefinition): Blueprint => ({
  id: `coaster-coupling:${definition.id}`,
  footprint: [1, 1],
  floorZ: -1,
  parts: [{
    id: 'body',
    pivot: [0, 0, 0],
    shapes: [
      carBox(0, -1, -1, COUPLING_HALF_LENGTH, 1, 1, MAT.TRAIN),
      carBox(0, -1, 1, 2, 1, 2, MAT.STEEL_LIGHT),
    ],
  }],
});

export const coasterContent: CoasterContent = { pieceBoxes, carBlueprint, riderBlueprint, couplingBlueprint };
