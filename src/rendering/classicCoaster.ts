import {
  CENTRE_LINE_HALF_GAUGE,
  CENTRE_LINE_SUPPORT_HALF_SPAN,
  COASTER_LEVEL_TILES,
  centreLineChainedHalf,
  centreLineSupportDistance,
  centreLineTieAlong,
  centreLineTieCount,
  createCentreLineFrame,
  sampleCentreLineFrame,
} from '../game/coaster/centreLine';
import type { CentreLine, CentreLineFrame } from '../game/coaster/centreLine';
import { BUILD_BY_ID } from '../game/content/catalog';
import type { ObjectColours } from '../game/content/colours';
import { ridePaintFor } from './classicPaint';
import { TILE_HEIGHT, TILE_WIDTH } from './isometric';
import { IDENTITY_VIEW_FRAME, pointToView, vectorToView } from './viewRotation';
import type { ViewFrame, XY } from './viewRotation';

/**
 * The classic renderer's coaster structure (Phase 27 step 2), as pure screen-space geometry built
 * from the coaster centre line and its cross-section frame (game/coaster/centreLine.ts). No Pixi:
 * `buildClassicTrack` returns plain number arrays the renderer strokes once at construction
 * (`WorldRenderer.drawCoasterTrack`), so the whole file is testable without a display and nothing
 * here ever runs per frame.
 *
 * Deliberately simpler than the voxel structure, but the same recipe from the same line:
 * - rails: two polylines at P ± `CENTRE_LINE_HALF_GAUGE` along the frame's rolled normal N′, so
 *   banking is a slight offset (the outer rail of a corner rises up to about 1.3 px at the apex)
 *   and a loop ring's rails are the ring traced at ± the ring's axis;
 * - ties: short strokes across the line every `CENTRE_LINE_TIE_SPACING` of arc (8 a straight,
 *   7 a corner, 25 round a ring), a spine stroke under them along the centre line;
 * - supports: one bent per raised piece (never on the station, never under a ring) at
 *   `centreLineSupportDistance`: two legs from the ground up to the bed under P ± 8/32 N′ (per leg
 *   heights, so a banked corner's outer leg is taller), a beam between them, a rung and one diagonal
 *   per 12 px bay when the bed is high enough (taller = more bracing), footings on the ground. A leg
 *   keeps out of the walkway corridors (the two axis lines through the tile centre that a path under
 *   track at level 2+ walks along): it is pushed outward until clear, or dropped if that leaves the tile;
 * - chain: static dashes along the centre line on chained halves (`centreLineChainedHalf`, which
 *   step 4 will key from the piece's data);
 * - brake: a pad strip over the middle of the last piece (the run into the station) and a fin post;
 * - station: a platform with an accent edge, a canopy with a valance, a post per piece, a gate at the
 *   entry end and a dispatch light at the exit end, on the far side of the track (`classicFarSide`);
 * - colour by coaster type (`classicCoasterPalette`): rails in the type's accent, ties in its colour,
 *   a spine and supports in a matching dark tone, so the three types read distinctly.
 *
 * Screen projection: a point (x, y tiles, z levels) lands at ((x − y) · 32, (x + y) · 16 − 13 z), and a
 * tile-unit vector (vx, vy, vz) at ((vx − vy) · 32, (vx + vy) · 16 − 32 vz): 13 px a level, 32 px a tile
 * of height, the same as the trains. Everything is placed from the line's tangent and normal, never
 * from screen directions; the one camera-dependent choice is `classicFarSide` (the voxel station makes
 * the same one), so map rotation (Phase 26) changes one function (`classicFarSide`, plus the projection state below).
 */

/**
 * Phase 26: the view the geometry is projected through. Everything here is built from the line's
 * plan coordinates (world space) and reaches the screen only through the four projection functions
 * and `classicFarSide`, so turning the map changes exactly this state. The classic renderer sets it
 * (it keeps the frame object and mutates it) before it builds or places anything; the default is
 * view 0, which every function treats as the identity (bit-identical to the unrotated game).
 */
let activeView: ViewFrame = IDENTITY_VIEW_FRAME;
const viewScratch: XY = { x: 0, y: 0 };
export const setClassicView = (frame: ViewFrame): void => {
  activeView = frame;
};
/** A world-plan vector as the active view sees it (z untouched): for callers that project themselves. */
export const classicViewVector = (dx: number, dy: number, out: XY): XY =>
  vectorToView(activeView.rotation, dx, dy, out);

/** Screen px per coaster height level (13 voxels). */
export const CLASSIC_LEVEL_PX = 13;
/** Screen px per tile of vertical offset (32 voxels). */
export const CLASSIC_TILE_PX = 32;

/** Screen x of a point of the centre line (tiles in cell space). */
export const classicTrackX = (x: number, y: number): number => {
  pointToView(activeView, x, y, viewScratch);
  return (viewScratch.x - viewScratch.y) * (TILE_WIDTH / 2);
};
/** Screen y of a point of the centre line (tiles in cell space, height in levels). */
export const classicTrackY = (x: number, y: number, z: number): number => {
  pointToView(activeView, x, y, viewScratch);
  return (viewScratch.x + viewScratch.y) * (TILE_HEIGHT / 2) - z * CLASSIC_LEVEL_PX;
};
/** Screen x of a tile-unit offset vector. */
export const classicOffsetX = (vx: number, vy: number): number => {
  vectorToView(activeView.rotation, vx, vy, viewScratch);
  return (viewScratch.x - viewScratch.y) * (TILE_WIDTH / 2);
};
/** Screen y of a tile-unit offset vector (z in tiles). */
export const classicOffsetY = (vx: number, vy: number, vz: number): number => {
  vectorToView(activeView.rotation, vx, vy, viewScratch);
  return (viewScratch.x + viewScratch.y) * (TILE_HEIGHT / 2) - vz * CLASSIC_TILE_PX;
};

/**
 * The side of the track (+1 toward N, the plan left of travel; −1 the right) that is away from the
 * camera: the station's platform and canopy go there so they never hide the loading train. The
 * camera looks from +x +y, so the far side is the one with the smaller x + y. This is the only
 * screen-dependent choice in the classic coaster (the voxel station makes the same one).
 */
export const classicFarSide = (dirX: number, dirY: number): number => {
  // Rotation keeps handedness, so "plan left of travel" survives the view; only the camera side moves.
  vectorToView(activeView.rotation, dirX, dirY, viewScratch);
  return viewScratch.x - viewScratch.y > 0 ? -1 : 1;
};

export interface ClassicCoasterPalette {
  /** The rails: the type's accent, bright. */
  rail: number;
  /** Ties and the station platform edge: the type's colour. */
  tie: number;
  /** The spine under the ties and the bed of the loop ring. */
  spine: number;
  /** Support legs, beams and bracing. */
  support: number;
  /** The station canopy. */
  canopy: number;
  /**
   * The station platform's edge strip. It is the ties' colour by default and follows the Rails slot once
   * that is recoloured (the voxel platform edge is a rail-word part).
   */
  edge: number;
  /** The tint of the station's ground diamonds: ground contact, never recoloured (the default rail colour). */
  ground: number;
}

const PALETTES: Readonly<Record<string, ClassicCoasterPalette>> = {
  'comet-trail': { rail: 0xffd166, tie: 0x9a6b44, spine: 0x8c3b22, support: 0x79543a, canopy: 0xe4572e, edge: 0x9a6b44, ground: 0xffd166 },
  'star-chaser': { rail: 0x61e7d3, tie: 0x7048c9, spine: 0x2d3446, support: 0x2c5b64, canopy: 0x7048c9, edge: 0x7048c9, ground: 0x61e7d3 },
  'skyline-serpent': { rail: 0xf5f06c, tie: 0x1b7f79, spine: 0x173f3b, support: 0x4d7f86, canopy: 0x1b7f79, edge: 0x1b7f79, ground: 0xf5f06c },
  'whisker-mouse': { rail: 0xef6f8f, tie: 0x4c9fd4, spine: 0x2d3446, support: 0x4d7f86, canopy: 0x4c9fd4, edge: 0x4c9fd4, ground: 0xef6f8f },
  'bat-wing': { rail: 0xffe66d, tie: 0x335c67, spine: 0x173f3b, support: 0x4d7f86, canopy: 0x335c67, edge: 0x335c67, ground: 0xffe66d },
  'titan-hyper': { rail: 0xf5f06c, tie: 0xc0392b, spine: 0x2d3446, support: 0x2c5b64, canopy: 0xc0392b, edge: 0xc0392b, ground: 0xf5f06c },
  'thunder-launch': { rail: 0xf5f06c, tie: 0x9557d1, spine: 0x2d3446, support: 0x2c5b64, canopy: 0x9557d1, edge: 0x9557d1, ground: 0xf5f06c },
  'timber-twister': { rail: 0xffd166, tie: 0x9a6b44, spine: 0x8c3b22, support: 0x79543a, canopy: 0xc0392b, edge: 0x9a6b44, ground: 0xffd166 },
};

/** Footings, the stone platform, the chain, the brake pad and the dispatch bulb: shared by every type. */
export const CLASSIC_COASTER_COMMON = {
  footing: 0xb9b2a4,
  platform: 0xb9b2a4,
  post: 0x2c5b64,
  chain: 0xd8e6e4,
  brake: 0xa9c4c8,
  bulb: 0xfff4c9,
  chevron: 0xffe66d,
} as const;

/**
 * The palette of a coaster type by catalog id, or by the colour the draft is drawn in when the id
 * is missing (the catalog coaster with that colour); anything else gets the step-1 look in `color`.
 */
export const classicCoasterPalette = (
  definitionId: string | undefined,
  color: number,
  colours: ObjectColours | null = null,
): ClassicCoasterPalette => {
  const base = baseCoasterPalette(definitionId, color);
  if (!colours || !definitionId) return base;
  // Phase 28: the four coaster slots. A record with every slot at default (or on the swatch that IS the
  // default) answers the base palette itself, so default art is the same object and the same instructions.
  const paint = ridePaintFor(definitionId, colours);
  if (!paint.isSet('primary') && !paint.isSet('rail') && !paint.isSet('support')) return base;
  const supportSet = paint.isSet('support');
  const railSet = paint.isSet('rail');
  const support = paint('support', base.support);
  return {
    rail: paint('rail', base.rail),
    // Ties, spine and supports are one slot (the voxel support bents, spine and ties), as the Supports slot says.
    tie: supportSet ? support : base.tie,
    spine: supportSet ? support : base.spine,
    support,
    canopy: paint('primary', base.canopy),
    edge: railSet ? paint('rail', base.rail) : supportSet ? support : base.edge,
    ground: base.ground,
  };
};

const baseCoasterPalette = (definitionId: string | undefined, color: number): ClassicCoasterPalette => {
  const known = definitionId ? PALETTES[definitionId] : undefined;
  if (known) return known;
  for (const definition of BUILD_BY_ID.values()) {
    if (definition.custom === 'coaster' && definition.color === color && PALETTES[definition.id]) return PALETTES[definition.id];
  }
  return { rail: 0xffd166, tie: color, spine: 0x8c3b22, support: 0x6d4c33, canopy: color, edge: color, ground: 0xffd166 };
};

/** Straight pieces are sampled in this many segments (the climb curves), corners and rings in more. */
export const CLASSIC_STRAIGHT_STEPS = 4;
export const CLASSIC_TURN_STEPS = 8;
export const CLASSIC_RING_STEPS = 32;
/** Ties reach this far either side of the line (a little past the rails). */
export const CLASSIC_TIE_HALF = 4.5 / 32;
/** The bed hangs this many px under the rail line; supports stop there. */
export const CLASSIC_BED_DEPTH_PX = 4;
/** No support when the bed bottom is lower than this over the ground. */
const SUPPORT_MIN_BED_PX = 3;
/** Bracing: a rung at this height when the bed bottom is at or above RUNG_MIN_BED_PX, then one bay every BAY_PX. */
export const CLASSIC_RUNG_Z_PX = 18;
export const CLASSIC_RUNG_MIN_BED_PX = 22;
export const CLASSIC_BAY_PX = 12;
/** A leg keeps this far (tiles) from the walk lines through the tile centre: 3 voxels of corridor plus the leg's own half size. */
export const CLASSIC_CORRIDOR_HALF = 4 / 32;
const LEG_PUSH = 2 / 32;
/** Chain dashes: 4 on, 4 off voxels of arc, phased by arc length so they run on across pieces. */
const CHAIN_PERIOD = 8 / 32;
const CHAIN_DASH = 4 / 32;
/** The brake pad covers the middle of the last piece, the fin stands near its exit. */
const BRAKE_FROM = 6 / 32;
const BRAKE_TO = 26 / 32;
const BRAKE_FIN_ALONG = 28 / 32;
const BRAKE_FIN_ACROSS = 6 / 32;
const BRAKE_FIN_HEIGHT_PX = 6;
/** Station furniture, across the track from the line on the far side (tiles) and px above the track line. */
const PLATFORM_NEAR = 5 / 32;
const PLATFORM_FAR = 15 / 32;
const PLATFORM_TOP_PX = 3;
const CANOPY_NEAR = 4 / 32;
const CANOPY_FAR = 16 / 32;
export const CLASSIC_CANOPY_HEIGHT_PX = 22;
const VALANCE_PX = 2;
const POST_ACROSS = 14 / 32;
/** A platform beside a turning station end stops this far from the tile centre, clear of the arc. */
const STATION_ARC_CLEARANCE = 6 / 32;
const GATE_ALONG = -0.5 + 2 / 32;
const GATE_ACROSS = [6 / 32, 10 / 32] as const;
const GATE_HEIGHT_PX = 9;
const LIGHT_ALONG = 0.5 - 2 / 32;
const LIGHT_ACROSS = 6 / 32;
const LIGHT_HEIGHT_PX = 10;
/** Boost chevrons: two, tips forward, along the direction of travel on the screen. */
const CHEVRON_ALONG = [-5, 3] as const;

/** One support bent: legs and the members between them, in screen px. */
export interface ClassicSupport {
  /** [footX, footY, topX, topY] per leg (0 to 2 legs). */
  legs: number[];
  /** Beam, rungs and diagonals as [x1, y1, x2, y2] lines. */
  braces: number[];
  /** How many rungs and diagonals the bent has (the beam is not counted). */
  bracingCount: number;
}

/** One station piece's furniture, in screen px. */
export interface ClassicStation {
  /** The platform's top face, 4 corners. */
  platform: number[];
  /** The accent edge of the platform beside the track, [x1, y1, x2, y2]. */
  platformEdge: number[];
  /** The canopy, 4 corners. */
  canopy: number[];
  /** The valance along the canopy's track-side edge, [x1, y1, x2, y2]. */
  valance: number[];
  /** The canopy post, [x1, y1, x2, y2]. */
  post: number[];
  /** The queue gate at the entry end: two posts and a bar, [x1, y1, x2, y2] × 3; empty when the piece has no room. */
  gate: number[];
  /** The dispatch light at the exit end: a post [x1, y1, x2, y2] and the bulb's centre [x, y]; empty when not this piece. */
  light: number[];
}

/** Everything the renderer strokes for one coaster, in screen px. */
export interface ClassicTrackGeometry {
  /** The centre line: one polyline [x0, y0, x1, y1, …] over the tiles, then one per loop ring. */
  spine: number[][];
  /** The left and right rail: the same runs offset along the frame's rolled normal. */
  left: number[][];
  right: number[][];
  /** Ties as [x1, y1, x2, y2] lines. */
  ties: number[];
  /** Chain dashes as [x1, y1, x2, y2] lines, on chained halves only. */
  chain: number[];
  /** The brake pad polyline over the last piece (empty on an open draft). */
  brake: number[];
  /** The brake fin post, [x1, y1, x2, y2], or empty. */
  brakeFin: number[];
  supports: ClassicSupport[];
  stations: ClassicStation[];
  /** Boost chevrons, one polyline of three points each. */
  chevrons: number[][];
}

export interface ClassicTrackOptions {
  /** A built (or closable) layout: the brake pad and the lap-closing structure are drawn. */
  closed: boolean;
  /** How many pieces from `first` are the station. */
  stationLength: number;
  /** Tiles of the line that carry a boost special (the line itself only knows loops). */
  boostTiles?: readonly number[];
}

const FRAME = createCentreLineFrame();

/** Screen position of a frame's point offset `across` tiles along its rolled normal N′. */
const railX = (frame: CentreLineFrame, across: number): number =>
  classicTrackX(frame.x, frame.y) + classicOffsetX(frame.normalX * across, frame.normalY * across);
const railY = (frame: CentreLineFrame, across: number): number =>
  classicTrackY(frame.x, frame.y, frame.z) + classicOffsetY(frame.normalX * across, frame.normalY * across, frame.normalZ * across);

const pushPoint = (run: number[], frame: CentreLineFrame, across: number): void => {
  run.push(railX(frame, across), railY(frame, across));
};

/** Samples [from, to] of the line in `steps` segments into the three rail runs. */
const traceRuns = (
  line: CentreLine,
  from: number,
  to: number,
  steps: number,
  skipFirst: boolean,
  spine: number[],
  left: number[],
  right: number[],
): void => {
  for (let step = skipFirst ? 1 : 0; step <= steps; step += 1) {
    sampleCentreLineFrame(line, from + ((to - from) * step) / steps, FRAME);
    pushPoint(spine, FRAME, 0);
    pushPoint(left, FRAME, CENTRE_LINE_HALF_GAUGE);
    pushPoint(right, FRAME, -CENTRE_LINE_HALF_GAUGE);
  }
};

/** Ties from the start of a line `length` of arc long at `start`. */
const emitTies = (line: CentreLine, start: number, length: number, ties: number[]): void => {
  const count = centreLineTieCount(length);
  for (let k = 0; k < count; k += 1) {
    sampleCentreLineFrame(line, start + centreLineTieAlong(k), FRAME);
    ties.push(railX(FRAME, CLASSIC_TIE_HALF), railY(FRAME, CLASSIC_TIE_HALF), railX(FRAME, -CLASSIC_TIE_HALF), railY(FRAME, -CLASSIC_TIE_HALF));
  }
};

/** Chain dashes over the arc range [from, to] (a merged run of chained halves, so no dash is split at a tile edge). */
const emitChain = (line: CentreLine, from: number, to: number, chain: number[]): void => {
  const firstDash = Math.floor(from / CHAIN_PERIOD);
  const lastDash = Math.floor(to / CHAIN_PERIOD);
  for (let k = firstDash; k <= lastDash; k += 1) {
    const dashFrom = Math.max(from, k * CHAIN_PERIOD);
    const dashTo = Math.min(to, k * CHAIN_PERIOD + CHAIN_DASH);
    if (dashTo - dashFrom < 1e-9) continue;
    sampleCentreLineFrame(line, dashFrom, FRAME);
    const x1 = railX(FRAME, 0);
    const y1 = railY(FRAME, 0);
    sampleCentreLineFrame(line, dashTo, FRAME);
    chain.push(x1, y1, railX(FRAME, 0), railY(FRAME, 0));
  }
};

/**
 * The plan point of a support leg `side` · HALF_SPAN along the frame's rolled normal, pushed out of
 * the walkway corridors of its tile. Returns false when no clear spot inside the tile exists.
 */
const legPlan = (line: CentreLine, index: number, frame: CentreLineFrame, side: number, out: { x: number; y: number; z: number }): boolean => {
  const centreX = line.cellX[index] + 0.5;
  const centreY = line.cellY[index] + 0.5;
  for (let push = 0; push < 3; push += 1) {
    const across = side * (CENTRE_LINE_SUPPORT_HALF_SPAN + push * LEG_PUSH);
    const x = frame.x + frame.normalX * across;
    const y = frame.y + frame.normalY * across;
    if (Math.abs(x - centreX) > 0.5 || Math.abs(y - centreY) > 0.5) return false;
    if (Math.abs(x - centreX) >= CLASSIC_CORRIDOR_HALF && Math.abs(y - centreY) >= CLASSIC_CORRIDOR_HALF) {
      out.x = x;
      out.y = y;
      out.z = frame.z + (frame.normalZ * across) / COASTER_LEVEL_TILES;
      return true;
    }
  }
  return false;
};

const LEG_A = { x: 0, y: 0, z: 0 };
const LEG_B = { x: 0, y: 0, z: 0 };

/** Screen y of a plan point at `zPx` px over the ground. */
const groundY = (x: number, y: number, zPx: number): number => classicTrackY(x, y, 0) - zPx;

/** The support bent of piece `index`, or null when the bed is on the ground or no leg fits. */
const buildSupport = (line: CentreLine, index: number): ClassicSupport | null => {
  sampleCentreLineFrame(line, centreLineSupportDistance(line, index), FRAME);
  const bedPx = FRAME.z * CLASSIC_LEVEL_PX - CLASSIC_BED_DEPTH_PX;
  if (bedPx < SUPPORT_MIN_BED_PX) return null;
  const hasA = legPlan(line, index, FRAME, 1, LEG_A);
  const hasB = legPlan(line, index, FRAME, -1, LEG_B);
  if (!hasA && !hasB) return null;
  const legs: number[] = [];
  const braces: number[] = [];
  let bracingCount = 0;
  const bedA = LEG_A.z * CLASSIC_LEVEL_PX - CLASSIC_BED_DEPTH_PX;
  const bedB = LEG_B.z * CLASSIC_LEVEL_PX - CLASSIC_BED_DEPTH_PX;
  if (hasA) legs.push(classicTrackX(LEG_A.x, LEG_A.y), groundY(LEG_A.x, LEG_A.y, 0), classicTrackX(LEG_A.x, LEG_A.y), groundY(LEG_A.x, LEG_A.y, Math.max(bedA, 1)));
  if (hasB) legs.push(classicTrackX(LEG_B.x, LEG_B.y), groundY(LEG_B.x, LEG_B.y, 0), classicTrackX(LEG_B.x, LEG_B.y), groundY(LEG_B.x, LEG_B.y, Math.max(bedB, 1)));
  if (hasA && hasB) {
    // The beam sits at the lower of the two bed bottoms, so it never reaches into the banked bed.
    const beamPx = Math.min(bedA, bedB);
    const ax = classicTrackX(LEG_A.x, LEG_A.y);
    const bx = classicTrackX(LEG_B.x, LEG_B.y);
    braces.push(ax, groundY(LEG_A.x, LEG_A.y, beamPx), bx, groundY(LEG_B.x, LEG_B.y, beamPx));
    if (beamPx >= CLASSIC_RUNG_MIN_BED_PX) {
      braces.push(ax, groundY(LEG_A.x, LEG_A.y, CLASSIC_RUNG_Z_PX), bx, groundY(LEG_B.x, LEG_B.y, CLASSIC_RUNG_Z_PX));
      bracingCount += 1;
      for (let bay = 0; ; bay += 1) {
        const lowPx = CLASSIC_RUNG_Z_PX + bay * CLASSIC_BAY_PX;
        const highPx = lowPx + CLASSIC_BAY_PX;
        if (highPx > beamPx - 2) break;
        if (bay > 0) {
          braces.push(ax, groundY(LEG_A.x, LEG_A.y, lowPx), bx, groundY(LEG_B.x, LEG_B.y, lowPx));
          bracingCount += 1;
        }
        // One diagonal per bay, alternating direction.
        const aPx = bay % 2 === 0 ? highPx : lowPx;
        const bPx = bay % 2 === 0 ? lowPx : highPx;
        braces.push(ax, groundY(LEG_A.x, LEG_A.y, aPx), bx, groundY(LEG_B.x, LEG_B.y, bPx));
        bracingCount += 1;
      }
    }
  }
  return { legs, braces, bracingCount };
};

/** Screen x/y of the point `along` tiles from a straight station piece's centre and `across` tiles on its far side, `zPx` up. */
const stationX = (cx: number, cy: number, dirX: number, dirY: number, side: number, along: number, across: number): number =>
  classicTrackX(cx + dirX * along - dirY * side * across, cy + dirY * along + dirX * side * across);
const stationY = (cx: number, cy: number, dirX: number, dirY: number, side: number, along: number, across: number, zPx: number): number =>
  groundY(cx + dirX * along - dirY * side * across, cy + dirY * along + dirX * side * across, zPx);

/** The furniture of station piece `index` (a flat piece), on the far side of the track, or null. */
const buildStation = (line: CentreLine, index: number, isFirst: boolean, isLast: boolean): ClassicStation | null => {
  if (line.nodeHeight[index] !== 0) return null;
  const cx = line.cellX[index] + 0.5;
  const cy = line.cellY[index] + 0.5;
  // The station runs the way the track leaves piece 0 (a closing corner as piece 0 turns in) and
  // the way it enters its last piece (which may turn off); the pieces between are straight.
  const dirX = isLast && !isFirst ? line.inX[index] : line.outX[index];
  const dirY = isLast && !isFirst ? line.inY[index] : line.outY[index];
  const side = classicFarSide(dirX, dirY);
  // The far-side normal, in plan: side · (−dirY, dirX).
  const farX = -dirY * side;
  const farY = dirX * side;
  let alongFrom = -0.5;
  let alongTo = 0.5;
  // A station end that turns off toward the far side keeps only the part clear of the turning arc
  // (the previous piece on the far side: the arc fills the exit half; the next one there: the entry half).
  if (isFirst && line.inX[index] * farX + line.inY[index] * farY < 0) alongTo = -STATION_ARC_CLEARANCE;
  if (isLast && line.outX[index] * farX + line.outY[index] * farY > 0) alongFrom = STATION_ARC_CLEARANCE;
  if (alongTo <= alongFrom) return null;
  const px = (along: number, across: number): number => stationX(cx, cy, dirX, dirY, side, along, across);
  const py = (along: number, across: number, zPx: number): number => stationY(cx, cy, dirX, dirY, side, along, across, zPx);
  const platform = [
    px(alongFrom, PLATFORM_NEAR), py(alongFrom, PLATFORM_NEAR, PLATFORM_TOP_PX),
    px(alongTo, PLATFORM_NEAR), py(alongTo, PLATFORM_NEAR, PLATFORM_TOP_PX),
    px(alongTo, PLATFORM_FAR), py(alongTo, PLATFORM_FAR, PLATFORM_TOP_PX),
    px(alongFrom, PLATFORM_FAR), py(alongFrom, PLATFORM_FAR, PLATFORM_TOP_PX),
  ];
  const platformEdge = [platform[0], platform[1], platform[2], platform[3]];
  const canopy = [
    px(alongFrom, CANOPY_NEAR), py(alongFrom, CANOPY_NEAR, CLASSIC_CANOPY_HEIGHT_PX),
    px(alongTo, CANOPY_NEAR), py(alongTo, CANOPY_NEAR, CLASSIC_CANOPY_HEIGHT_PX),
    px(alongTo, CANOPY_FAR), py(alongTo, CANOPY_FAR, CLASSIC_CANOPY_HEIGHT_PX),
    px(alongFrom, CANOPY_FAR), py(alongFrom, CANOPY_FAR, CLASSIC_CANOPY_HEIGHT_PX),
  ];
  const valance = [
    px(alongFrom, CANOPY_NEAR), py(alongFrom, CANOPY_NEAR, CLASSIC_CANOPY_HEIGHT_PX - VALANCE_PX),
    px(alongTo, CANOPY_NEAR), py(alongTo, CANOPY_NEAR, CLASSIC_CANOPY_HEIGHT_PX - VALANCE_PX),
  ];
  const postAlong = alongFrom <= 0 && alongTo >= 0 ? 0 : (alongFrom + alongTo) / 2;
  const post = [
    px(postAlong, POST_ACROSS), py(postAlong, POST_ACROSS, PLATFORM_TOP_PX),
    px(postAlong, POST_ACROSS), py(postAlong, POST_ACROSS, CLASSIC_CANOPY_HEIGHT_PX),
  ];
  const gate: number[] = [];
  if (isFirst && alongFrom <= GATE_ALONG && alongTo >= GATE_ALONG) {
    for (const across of GATE_ACROSS) {
      gate.push(px(GATE_ALONG, across), py(GATE_ALONG, across, PLATFORM_TOP_PX), px(GATE_ALONG, across), py(GATE_ALONG, across, PLATFORM_TOP_PX + GATE_HEIGHT_PX));
    }
    gate.push(gate[2], gate[3], gate[6], gate[7]);
  }
  const light: number[] = [];
  if (isLast && alongFrom <= LIGHT_ALONG && alongTo >= LIGHT_ALONG) {
    light.push(
      px(LIGHT_ALONG, LIGHT_ACROSS), py(LIGHT_ALONG, LIGHT_ACROSS, PLATFORM_TOP_PX),
      px(LIGHT_ALONG, LIGHT_ACROSS), py(LIGHT_ALONG, LIGHT_ACROSS, PLATFORM_TOP_PX + LIGHT_HEIGHT_PX),
      px(LIGHT_ALONG, LIGHT_ACROSS), py(LIGHT_ALONG, LIGHT_ACROSS, PLATFORM_TOP_PX + LIGHT_HEIGHT_PX + 1.5),
    );
  }
  return { platform, platformEdge, canopy, valance, post, gate, light };
};

/** Two chevrons at the centre of piece `index`, tips along the direction of travel on the screen. */
const buildChevrons = (line: CentreLine, index: number, chevrons: number[][]): void => {
  sampleCentreLineFrame(line, line.centreDistance[index], FRAME);
  const x = classicTrackX(FRAME.x, FRAME.y);
  const y = classicTrackY(FRAME.x, FRAME.y, FRAME.z);
  const forwardX = classicOffsetX(FRAME.tangentX, FRAME.tangentY);
  const forwardY = classicOffsetY(FRAME.tangentX, FRAME.tangentY, FRAME.tangentZ);
  const length = Math.hypot(forwardX, forwardY) || 1;
  const ux = forwardX / length;
  const uy = forwardY / length;
  for (const along of CHEVRON_ALONG) {
    const tipX = x + ux * (along + 4);
    const tipY = y + uy * (along + 4) - 6;
    chevrons.push([tipX - ux * 6 - uy * 4, tipY - uy * 6 + ux * 4, tipX, tipY, tipX - ux * 6 + uy * 4, tipY - uy * 6 - ux * 4]);
  }
};

/**
 * The structure of tiles `first` … `last` of `line` (an open draft passes the ring's real pieces;
 * a built layout 0 … n − 1), in screen px. Allocates its result: construction time only.
 */
export const buildClassicTrack = (
  line: CentreLine,
  first: number,
  last: number,
  options: ClassicTrackOptions,
): ClassicTrackGeometry => {
  const geometry: ClassicTrackGeometry = {
    spine: [], left: [], right: [], ties: [], chain: [], brake: [], brakeFin: [], supports: [], stations: [], chevrons: [],
  };
  if (line.pieceCount === 0 || last < first) return geometry;
  const trackSpine: number[] = [];
  const trackLeft: number[] = [];
  const trackRight: number[] = [];
  /** Chained arc ranges [from, to, from, to, …], neighbouring halves merged. */
  const chained: number[] = [];
  const addChained = (from: number, to: number): void => {
    if (chained.length > 0 && Math.abs(chained[chained.length - 1] - from) < 1e-9) chained[chained.length - 1] = to;
    else chained.push(from, to);
  };
  const count = line.pieceCount;
  const stationEnd = Math.min(last, first + options.stationLength - 1);
  for (let index = first; index <= last; index += 1) {
    const start = line.tileStart[index];
    const length = line.tileLength[index];
    const steps = line.turn[index] === 0 ? CLASSIC_STRAIGHT_STEPS : CLASSIC_TURN_STEPS;
    traceRuns(line, start, start + length, steps, index > first, trackSpine, trackLeft, trackRight);
    emitTies(line, start, length, geometry.ties);
    const isStation = index <= stationEnd;
    if (!isStation) {
      const support = buildSupport(line, index);
      if (support) geometry.supports.push(support);
    } else {
      const station = buildStation(line, index, index === first, index === stationEnd);
      if (station) geometry.stations.push(station);
    }
    // The chain: the entry half when the segment before this piece climbs, the exit half when its own does.
    const middle = start + length / 2;
    if (centreLineChainedHalf(line, index, 0)) addChained(start, middle);
    if (centreLineChainedHalf(line, index, length)) addChained(middle, start + length);
    if (options.boostTiles?.includes(index)) buildChevrons(line, index, geometry.chevrons);
    if (line.loop[index] === 1) {
      const ringStart = start + length;
      const ringEnd = line.tileStart[index + 1];
      const ringSpine: number[] = [];
      const ringLeft: number[] = [];
      const ringRight: number[] = [];
      traceRuns(line, ringStart, ringEnd, CLASSIC_RING_STEPS, false, ringSpine, ringLeft, ringRight);
      geometry.spine.push(ringSpine);
      geometry.left.push(ringLeft);
      geometry.right.push(ringRight);
      emitTies(line, ringStart, ringEnd - ringStart, geometry.ties);
    }
    if (options.closed && index === last && count > 1) {
      // The run into the station brakes: a pad over the middle of the last piece and a fin at its exit.
      for (const along of [BRAKE_FROM, (BRAKE_FROM + BRAKE_TO) / 2, BRAKE_TO]) {
        sampleCentreLineFrame(line, start + along * length, FRAME);
        pushPoint(geometry.brake, FRAME, 0);
      }
      if (line.turn[index] === 0) {
        sampleCentreLineFrame(line, start + BRAKE_FIN_ALONG * length, FRAME);
        const side = classicFarSide(FRAME.dirX, FRAME.dirY);
        const x = railX(FRAME, side * BRAKE_FIN_ACROSS);
        const y = railY(FRAME, side * BRAKE_FIN_ACROSS);
        geometry.brakeFin.push(x, y + CLASSIC_BED_DEPTH_PX, x, y - BRAKE_FIN_HEIGHT_PX + CLASSIC_BED_DEPTH_PX);
      }
    }
  }
  for (let at = 0; at + 1 < chained.length; at += 2) emitChain(line, chained[at], chained[at + 1], geometry.chain);
  geometry.spine.unshift(trackSpine);
  geometry.left.unshift(trackLeft);
  geometry.right.unshift(trackRight);
  return geometry;
};
