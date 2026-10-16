import { describe, expect, it } from 'vitest';
import { coasterCarSeats } from '../../coasterCarFrame';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import type { CoasterTypeDefinition } from '../../../game/coaster/content';
import { validateCoasterLayout } from '../../../game/coaster/design';
import {
  CENTRE_LINE_BANK_MAX,
  CENTRE_LINE_CORNER_RADIUS,
  centreLineFor,
  centreLineRollInPiece,
  centreLineSupportDistance,
  createCentreLineFrame,
  sampleCentreLineFrame,
} from '../../../game/coaster/centreLine';
import type { CoasterPiece } from '../../../game/coaster/design';
import { longestLayout } from '../../../game/coaster/testLayouts';
import { GAME_CONFIG } from '../../../game/config';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { ParkSession } from '../../../game/session/ParkSession';
import { seedDevPark } from '../../../game/session/devPark';
import type { BuildDefinition } from '../../../game/types';
import { compileBlueprint, compileBlueprintReport, flattenAtRest, rotateModel } from '../blueprint/compile';
import { BOX_FLOATS, BoxWriter, STATIC_SLOT, unpackBoxWord } from '../contracts/boxes';
import { BOX_BUDGET, COASTER_BOX_BUDGET, RASTER_TO_EXPOSED_RATIO } from '../contracts/budgets';
import { MAT, PATTERN } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { COASTER_LEVEL_VOXELS, GROUND_TOP_Z, PATH_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';
import { buildPalette } from '../palette';
import { coasterRailTopZ, createCoasterTrack, createCoasterTrackPoint, sampleCoasterTrack } from '../scene/coasterCars';
import {
  BRAKE_FROM,
  BRAKE_TO,
  CANOPY_BOTTOM_Z,
  CAR_HALF_LENGTH,
  CAR_HALF_WIDTH,
  CAR_HEIGHT,
  CAR_NOSE_LENGTH,
  COUPLING_HALF_LENGTH,
  COUPLING_LENGTH,
  COASTER_PIECE_BOX_ALLOWANCE,
  DISPATCH_POST_HEIGHT,
  GATE_HEIGHT,
  GROUND_SINK,
  LOOP_OUTER_RADIUS,
  LOOP_RAIL_RADIUS,
  LOOP_RAIL_THICKNESS,
  PLATFORM_TOP_Z,
  RAIL_WIDTH,
  SPINE_HALF_WIDTH,
  SUPPORT_BAY,
  SUPPORT_FOOTING_SIZE,
  SUPPORT_FOOTING_TOP,
  SUPPORT_FOOTING_Z,
  SUPPORT_RUNG_Z,
  SUPPORT_SIZE,
  TIE_HALF_WIDTH,
  TIE_PERIOD,
  TIE_THICKNESS,
  TRACK_DEPTH,
  TRACK_HALF_WIDTH,
  coasterContent,
  coasterLook,
} from './coaster';
import type { CoasterLook } from './coaster';

/**
 * Coaster track and cars (content/coaster.ts), checked against the rules the rest of the renderer
 * relies on rather than against the module's own arithmetic:
 * - the static world files a piece's boxes under its tile's chunk and asserts no two boxes overlap,
 *   so every piece stays in its tile (a loop ring may overhang into the next one) and no box of a
 *   layout overlaps another — on the dev park's coaster, on handcrafted layouts with turns, ramps,
 *   loops, boosts and turning stations, and on seeded random height and special variations;
 * - the cars ride the smooth centre line (game/coaster/centreLine.ts, scene/coasterCars.ts), so the
 *   rail top is 13L + 5 at the middle of every piece, the spine follows the line's height, two rails
 *   run 3 voxels either side of it on ties every 4 voxels of arc, corners are round quarter circles
 *   of radius 16 that join their neighbours edge to edge and bank with the outer rail up, and a loop
 *   ring's rails sit on the circle the cars actually take;
 * - supports stand on footings, reach their beam, never reach into the track and never float, and
 *   guests walk under track of level ≥ 2 on a path, so nothing hangs into the 22 voxels over the
 *   walk lines there;
 * - the lift chain shows only on climbing halves, the brake pad only on the run into the station,
 *   the station has its gate and dispatch light, and the three types read in their own colours;
 * - box budgets (BOX_BUDGET, COASTER_BOX_BUDGET).
 */

const TILE = VOXELS_PER_TILE;
const HALF_TILE = TILE / 2;
/** Any outline group: every box must carry the one the static world passes in. */
const GROUP = 7;
/** Guests are ≤ 20 voxels tall (art bible); the track keeps 22 clear over the path where they walk. */
const WALK_CLEARANCE = 22;
/** Half the width of a walking guest with arms out (art bible: torso 4 wide, arms 1 each side). */
const WALK_HALF_WIDTH = 3;
/** Supports keep at least this far from a tile centre (design: never at the tile centre). */
const SUPPORT_CENTRE_CLEARANCE = 4;
const STATION_LENGTH = GAME_CONFIG.coaster.stationLength;
/** A rail is one voxel high. */
const RAIL_HEIGHT_VOXELS = 1;
/** The 64-piece serpentine (40 corners, hills 0 to 4): the longest coaster the designer allows. */
const LONGEST = longestLayout();
/** Building every piece of the longest coaster, as one chunk rebuild would (ms; measured about 5). */
const COMPILE_BUDGET_MS = 250;

const palette: Palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);

const definitionOf = (id: string): BuildDefinition => {
  const definition = BUILD_BY_ID.get(id);
  if (!definition) throw new Error(`no catalog entry ${id}`);
  return definition;
};

const typeOf = (id: string): CoasterTypeDefinition => {
  const type = COASTER_TYPE_BY_ID.get(id);
  if (!type) throw new Error(`no coaster type ${id}`);
  return type;
};

const LOOKS = new Map<string, CoasterLook>();
const lookOf = (id: string): CoasterLook => {
  let look = LOOKS.get(id);
  if (!look) {
    look = coasterLook(definitionOf(id), palette, { rail: 0, tie: 0, spine: 0, support: 0 });
    LOOKS.set(id, look);
  }
  return look;
};

const COASTER_IDS = ['comet-trail', 'star-chaser', 'skyline-serpent'] as const;

// ---------------------------------------------------------------------------------------------
// Layouts

type Special = CoasterPiece['special'];

/**
 * A closed layout from a start cell and one move per piece (E, W, N = −y, S = +y); the last move
 * closes the loop back onto the start.
 */
const walk = (
  start: { x: number; y: number },
  moves: string,
  heights: readonly number[],
  specials: Readonly<Record<number, Special>> = {},
): CoasterPiece[] => {
  const pieces: CoasterPiece[] = [];
  let x = start.x;
  let y = start.y;
  for (let index = 0; index < moves.length; index += 1) {
    const special = specials[index];
    pieces.push({ cell: { x, y }, height: heights[index] ?? 0, ...(special ? { special } : {}) });
    const move = moves[index];
    if (move === 'E') x += 1;
    else if (move === 'W') x -= 1;
    else if (move === 'S') y += 1;
    else y -= 1;
  }
  if (x !== start.x || y !== start.y) throw new Error(`layout ${moves} does not close`);
  return pieces;
};

interface Layout {
  name: string;
  definitionId: (typeof COASTER_IDS)[number];
  pieces: CoasterPiece[];
}

const devParkCoaster = (): CoasterPiece[] => {
  const session = new ParkSession(null);
  seedDevPark(session);
  const [record] = session.world.coasters.values();
  if (!record) throw new Error('the dev park lost its coaster');
  return record.pieces;
};

/** Handcrafted layouts: every piece kind, and the station and loop corner cases. */
const HANDCRAFTED: readonly Layout[] = [
  { name: 'dev park', definitionId: 'star-chaser', pieces: devParkCoaster() },
  { name: 'longest serpentine', definitionId: 'skyline-serpent', pieces: LONGEST },
  {
    name: 'turns and hills',
    definitionId: 'comet-trail',
    pieces: walk({ x: 2, y: 4 }, 'EEENENEESSSWWWWWWN', [0, 0, 0, 1, 2, 2, 2, 1, 1, 2, 2, 2, 1, 1, 0, 0, 0, 0]),
  },
  {
    name: 'summit, loop and ramped boost',
    definitionId: 'skyline-serpent',
    pieces: walk({ x: 2, y: 6 }, 'EEEEEEENNNWWWWWWWSSS',
      [0, 0, 0, 1, 2, 3, 4, 4, 4, 3, 2, 2, 2, 1, 1, 0, 0, 0, 0, 0], { 5: 'boost', 11: 'loop' }),
  },
  {
    name: 'loop after a drop',
    definitionId: 'star-chaser',
    pieces: walk({ x: 2, y: 5 }, 'EEEEEENNWWWWWWSS', [0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 2, 2, 1, 0, 0, 0], { 10: 'loop' }),
  },
  {
    name: 'loops on ramps',
    definitionId: 'skyline-serpent',
    pieces: walk({ x: 2, y: 3 }, 'EEEEEEESSWWWWWWWNN',
      [0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 2, 1, 1, 0, 0, 0, 0, 0], { 5: 'loop', 11: 'loop' }),
  },
  {
    name: 'station turning in from the far side, out to the near side',
    definitionId: 'comet-trail',
    pieces: walk({ x: 3, y: 8 }, 'NNEESSSWWWNE', [0, 0, 0, 1, 2, 2, 2, 1, 1, 1, 1, 0]),
  },
  {
    name: 'station turning off to the far side at both ends',
    definitionId: 'star-chaser',
    pieces: walk({ x: 3, y: 5 }, 'EENNNWWWSSES', [0, 0, 0, 1, 2, 2, 2, 2, 1, 1, 0, 0]),
  },
  {
    name: 'loop right before a straight station, boost on the far straight',
    definitionId: 'skyline-serpent',
    pieces: walk({ x: 3, y: 3 }, 'EEEESSWWWWWWNNEE',
      [0, 0, 0, 1, 2, 2, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0], { 8: 'boost', 15: 'loop' }),
  },
  {
    name: 'loop from the near side into a turning station',
    definitionId: 'skyline-serpent',
    pieces: walk({ x: 4, y: 5 }, 'EEEESSSWWWWNNN', [0, 0, 0, 1, 2, 2, 2, 2, 1, 1, 1, 0, 0, 0], { 13: 'loop' }),
  },
  {
    name: 'loop from the far side into a turning station',
    definitionId: 'skyline-serpent',
    pieces: walk({ x: 4, y: 5 }, 'EEEENNNWWWWSSS', [0, 0, 0, 1, 2, 2, 2, 2, 1, 1, 1, 0, 0, 0], { 13: 'loop' }),
  },
  {
    name: 'summit at level 4 with a long drop',
    definitionId: 'skyline-serpent',
    pieces: walk({ x: 2, y: 2 }, 'EEEEEEEESSSSWWWWWWWWNNNN',
      [0, 0, 0, 1, 2, 3, 4, 4, 4, 4, 4, 3, 2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
  },
];

/** Shapes the random variations re-height and re-decorate (each closes on itself). */
const SHAPES: readonly { start: { x: number; y: number }; moves: string }[] = [
  { start: { x: 2, y: 6 }, moves: 'EEEEEEENNNWWWWWWWSSS' },
  { start: { x: 2, y: 4 }, moves: 'EEENENEESSSWWWWWWN' },
  { start: { x: 3, y: 3 }, moves: 'EEEESSWWWWWWNNEE' },
  { start: { x: 4, y: 5 }, moves: 'EEEENNNWWWWSSS' },
  { start: { x: 3, y: 8 }, moves: 'NNEESSSWWWNE' },
  { start: { x: 5, y: 2 }, moves: 'SSSSEENNESSSEENNNNNWWWWW' },
];

/** Deterministic PRNG (mulberry32) so the random variations are the same on every run. */
const random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
};

/**
 * Valid skyline-serpent layouts (the type with every feature): each shape with random hills
 * (station flat, ±1 level per piece, 0–4) and random loops and boosts on straight pieces.
 */
const randomLayouts = (count: number, seed: number): Layout[] => {
  const next = random(seed);
  const type = typeOf('skyline-serpent');
  const layouts: Layout[] = [];
  for (let attempt = 0; layouts.length < count && attempt < count * 200; attempt += 1) {
    const shape = SHAPES[attempt % SHAPES.length];
    const base = walk(shape.start, shape.moves, []);
    const heights: number[] = [];
    for (let index = 0; index < base.length; index += 1) {
      if (index < STATION_LENGTH) heights.push(0);
      else heights.push(Math.min(type.maximumHeight, Math.max(0, heights[index - 1] + Math.floor(next() * 3) - 1)));
    }
    const specials: Record<number, Special> = {};
    for (let index = STATION_LENGTH; index < base.length; index += 1) {
      if (next() < 0.25) specials[index] = next() < 0.5 ? 'loop' : 'boost';
    }
    const pieces = walk(shape.start, shape.moves, heights, specials);
    if (!validateCoasterLayout(pieces, type).ok) continue;
    layouts.push({ name: `random ${layouts.length} (${shape.moves})`, definitionId: 'skyline-serpent', pieces });
  }
  return layouts;
};

const RANDOM_LAYOUTS = randomLayouts(36, 20_260_930);
const ALL_LAYOUTS: readonly Layout[] = [...HANDCRAFTED, ...RANDOM_LAYOUTS];

// ---------------------------------------------------------------------------------------------
// Boxes

interface TestBox {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
  material: number;
  group: number;
  pattern: number;
  quarterTurn: number;
  slot: number;
  piece: number;
}

const readBoxes = (writer: BoxWriter, from: number, piece: number): TestBox[] => {
  const boxes: TestBox[] = [];
  for (let box = from; box < writer.count; box += 1) {
    const at = box * BOX_FLOATS;
    const data = writer.data;
    const word = unpackBoxWord(data[at + 3]);
    boxes.push({
      x0: data[at],
      y0: data[at + 1],
      z0: data[at + 2],
      x1: data[at] + data[at + 4],
      y1: data[at + 1] + data[at + 5],
      z1: data[at + 2] + data[at + 6],
      material: word.material,
      group: word.group,
      pattern: word.pattern,
      quarterTurn: word.quarterTurn,
      slot: data[at + 7],
      piece,
    });
  }
  return boxes;
};

/** Each piece's boxes, built in layout order into one writer (as a chunk rebuild does). */
const buildLayout = (layout: Layout): TestBox[][] => {
  const definition = definitionOf(layout.definitionId);
  const writer = new BoxWriter(16);
  const pieces: TestBox[][] = [];
  for (let index = 0; index < layout.pieces.length; index += 1) {
    const from = writer.count;
    coasterContent.pieceBoxes(layout.pieces, index, definition, palette, GROUP, writer);
    pieces.push(readBoxes(writer, from, index));
  }
  return pieces;
};

const BUILT = new Map<Layout, TestBox[][]>(ALL_LAYOUTS.map((layout) => [layout, buildLayout(layout)]));
const built = (layout: Layout): TestBox[][] => BUILT.get(layout) ?? buildLayout(layout);

const overlaps = (a: TestBox, b: TestBox): boolean =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1 && a.z0 < b.z1 && b.z0 < a.z1;

/** Whether two boxes share a face (touch over an area, not just an edge or a corner). */
const touches = (a: TestBox, b: TestBox): boolean => {
  const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const overlapZ = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
  const sharesX = overlapX > 0;
  const sharesY = overlapY > 0;
  const sharesZ = overlapZ > 0;
  if (sharesX && sharesY && overlapZ === 0) return true;
  if (sharesX && sharesZ && overlapY === 0) return true;
  if (sharesY && sharesZ && overlapX === 0) return true;
  return false;
};

const contains = (box: TestBox, x: number, y: number, z: number): boolean =>
  x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1 && z >= box.z0 && z < box.z1;

const describeBox = (box: TestBox): string =>
  `piece ${box.piece} material ${box.material} [${box.x0},${box.y0},${box.z0}]–[${box.x1},${box.y1},${box.z1}]`;

/** Horizontal distance from a box's footprint to a point (0 inside). */
const footprintDistance = (box: TestBox, x: number, y: number): number => {
  const dx = Math.max(box.x0 - x, 0, x - box.x1);
  const dy = Math.max(box.y0 - y, 0, y - box.y1);
  return Math.hypot(dx, dy);
};

interface Step {
  dx: number;
  dy: number;
}

const around = (pieces: readonly CoasterPiece[], index: number): { previous: CoasterPiece; piece: CoasterPiece; next: CoasterPiece } => {
  const count = pieces.length;
  return { previous: pieces[(index - 1 + count) % count], piece: pieces[index], next: pieces[(index + 1) % count] };
};

const centreOf = (piece: CoasterPiece): { x: number; y: number } =>
  ({ x: piece.cell.x * TILE + HALF_TILE, y: piece.cell.y * TILE + HALF_TILE });

/** The materials the track layers of a layout's type are built from. */
const trackMaterials = (layout: Layout): Set<number> => {
  const look = lookOf(layout.definitionId);
  return new Set<number>([look.rail, look.tie, look.spine]);
};

const SPINE_HEIGHT = TRACK_DEPTH - RAIL_HEIGHT_VOXELS - TIE_THICKNESS;
/** A lower-layer box: 2 thick, or 3 where it stands on the grass (a level-0 column reaches down from the path top). */
const isLowerLayer = (box: TestBox, material: number): boolean => box.material === material
  && ((box.z0 === GROUND_TOP_Z && box.z1 - box.z0 === SPINE_HEIGHT + GROUND_SINK) || (box.z0 > GROUND_TOP_Z && box.z1 - box.z0 === SPINE_HEIGHT));
/** The station's stone bed under its track (like the spine it replaces). */
const isBedBox = (box: TestBox): boolean => isLowerLayer(box, MAT.STONE);
/** A tie: 1 thick in the tie material (the canopy shares the material on two types, 2 thick and high up). */
const isTieBox = (layout: Layout, box: TestBox): boolean => box.material === lookOf(layout.definitionId).tie && box.z1 - box.z0 === TIE_THICKNESS;
/** The spine, or the station's bed. */
const isSpineBox = (layout: Layout, box: TestBox): boolean => isLowerLayer(box, lookOf(layout.definitionId).spine) || isBedBox(box);

/**
 * Boxes of the track layers (rails, ties, spine or bed, chain, brake, chevrons): what the cars ride.
 * Station furniture in the same materials (the accent edge and valance, the canopy, the festoon and
 * dispatch bulbs) stands beside or well over the level-0 track, so on a station piece only boxes at
 * track height count.
 */
const isTrackBox = (layout: Layout, box: TestBox): boolean => {
  const look = lookOf(layout.definitionId);
  const material = box.material === look.rail || box.material === look.tie || box.material === look.spine
    || box.material === MAT.FENCE_RAIL || box.material === MAT.CONCRETE || box.material === MAT.BULB || isBedBox(box);
  if (!material) return false;
  if (box.piece >= STATION_LENGTH || layout.pieces[box.piece].height > 0) return true;
  // Level-0 track layers are 1 to 3 high (the bed reaches the grass) and end under 13 even where the station's end climbs away.
  return box.z1 - box.z0 <= SPINE_HEIGHT + GROUND_SINK && box.z1 <= PLATFORM_TOP_Z + 8 && !(box.material === MAT.STONE && !isBedBox(box));
};

/** Track boxes of a loop piece: the only ones that may belong to a ring overhanging the tile. */
const isRingBox = (layout: Layout, box: TestBox): boolean =>
  layout.pieces[box.piece].special === 'loop' && trackMaterials(layout).has(box.material);

const isFootingBox = (box: TestBox): boolean => box.material === MAT.STONE && box.z0 === SUPPORT_FOOTING_Z && box.z1 === SUPPORT_FOOTING_TOP
  && box.x1 - box.x0 <= SUPPORT_FOOTING_SIZE && box.y1 - box.y0 <= SUPPORT_FOOTING_SIZE;
/** Support boxes: the type's support material (the station's steel posts share it on one type, but a station piece is level 0) and footings. */
const isSupportBox = (layout: Layout, box: TestBox): boolean =>
  (box.material === lookOf(layout.definitionId).support && layout.pieces[box.piece].height > 0) || isFootingBox(box);

const railBox = (layout: Layout, box: TestBox): boolean => box.material === lookOf(layout.definitionId).rail && box.z1 - box.z0 === RAIL_HEIGHT_VOXELS;

// ---------------------------------------------------------------------------------------------
// Track

describe('coaster track pieces', () => {
  it('builds valid fixture layouts: every handcrafted and random layout is a coaster its type allows', () => {
    expect(RANDOM_LAYOUTS.length, 'enough random variations').toBe(36);
    for (const layout of ALL_LAYOUTS) {
      expect(validateCoasterLayout(layout.pieces, typeOf(layout.definitionId)), layout.name).toEqual({ ok: true });
    }
    const features = RANDOM_LAYOUTS.flatMap((layout) => layout.pieces.map((piece) => piece.special ?? 'plain'));
    expect(features.filter((feature) => feature === 'loop').length, 'random layouts have loops').toBeGreaterThan(10);
    expect(features.filter((feature) => feature === 'boost').length, 'random layouts have boosts').toBeGreaterThan(10);
  });

  it('emits whole-voxel static boxes in the outline group, coloured from the palette by type', () => {
    for (const layout of ALL_LAYOUTS) {
      const definition = definitionOf(layout.definitionId);
      const look = lookOf(layout.definitionId);
      const allowed = new Set<number>([
        look.rail, look.tie, look.spine, look.support, MAT.FENCE_RAIL, MAT.CONCRETE, MAT.BULB, MAT.STONE, MAT.STEEL, MAT.FENCE_POST,
        palette.material(definition.color), palette.material(definition.accent),
      ]);
      for (const box of built(layout).flat()) {
        const label = `${layout.name}: ${describeBox(box)}`;
        for (const value of [box.x0, box.y0, box.z0, box.x1, box.y1, box.z1]) {
          expect(Number.isInteger(value), `${label} on whole voxels`).toBe(true);
        }
        expect(box.x1 > box.x0 && box.y1 > box.y0 && box.z1 > box.z0, `${label} not empty`).toBe(true);
        expect(box.z0, `${label} stands on the grass or above`).toBeGreaterThanOrEqual(GROUND_TOP_Z);
        expect(allowed.has(box.material), `${label} uses a track, support, station or catalog material`).toBe(true);
        expect(box.group, `${label} outline group`).toBe(GROUP);
        expect(box.slot, `${label} is static`).toBe(STATIC_SLOT);
        const canopy = box.material === palette.material(definition.color) && box.z0 === CANOPY_BOTTOM_Z && box.z1 - box.z0 === 2 && box.piece < STATION_LENGTH;
        expect(box.pattern, `${label} pattern`).toBe(canopy ? PATTERN.STRIPES : PATTERN.PLAIN);
      }
    }
  }, 20_000);

  it('reads differently per coaster type: rails are the accent, ties and supports differ', () => {
    const looks = COASTER_IDS.map((id) => lookOf(id));
    for (let a = 0; a < looks.length; a += 1) {
      expect(looks[a].rail, `${COASTER_IDS[a]} rails are its accent`).toBe(palette.material(definitionOf(COASTER_IDS[a]).accent));
      for (let b = a + 1; b < looks.length; b += 1) {
        expect(looks[a].rail, 'rails differ').not.toBe(looks[b].rail);
        expect(looks[a].tie, 'ties differ').not.toBe(looks[b].tie);
        expect(looks[a].support, 'supports differ').not.toBe(looks[b].support);
      }
    }
    // The dev park coaster (Star Chaser) is built in its own look, not the step-1 brown and yellow.
    const dev = built(HANDCRAFTED[0]).flat();
    expect(dev.some((box) => box.material === MAT.TRACK || box.material === MAT.RAIL || box.material === MAT.SUPPORT), 'no step-1 materials').toBe(false);
  });

  it('keeps every box inside its own tile; only a loop ring overhangs, into the next tile only', () => {
    for (const layout of ALL_LAYOUTS) {
      for (const boxes of built(layout)) {
        for (const box of boxes) {
          const { piece, next } = around(layout.pieces, box.piece);
          const x0 = piece.cell.x * TILE;
          const y0 = piece.cell.y * TILE;
          const inside = box.x0 >= x0 && box.x1 <= x0 + TILE && box.y0 >= y0 && box.y1 <= y0 + TILE;
          if (inside) continue;
          const minX = Math.min(piece.cell.x, next.cell.x) * TILE;
          const minY = Math.min(piece.cell.y, next.cell.y) * TILE;
          const maxX = (Math.max(piece.cell.x, next.cell.x) + 1) * TILE;
          const maxY = (Math.max(piece.cell.y, next.cell.y) + 1) * TILE;
          const label = `${layout.name}: ${describeBox(box)}`;
          expect(isRingBox(layout, box), `${label} leaves its tile only as part of a loop ring`).toBe(true);
          expect(box.x0 >= minX && box.x1 <= maxX && box.y0 >= minY && box.y1 <= maxY, `${label} overhangs ≤ 1 tile, into the next piece's`)
            .toBe(true);
        }
      }
    }
  });

  it('never overlaps two boxes, within a piece or between the pieces of a layout', () => {
    for (const layout of ALL_LAYOUTS) {
      const boxes = built(layout).flat();
      for (let a = 0; a < boxes.length; a += 1) {
        for (let b = a + 1; b < boxes.length; b += 1) {
          if (overlaps(boxes[a], boxes[b])) {
            expect.fail(`${layout.name}: ${describeBox(boxes[a])} overlaps ${describeBox(boxes[b])}`);
          }
        }
      }
    }
  });

  /** Where the centre line is at the middle of piece `index`, in voxels, and its plan direction. */
  const middleOf = (pieces: readonly CoasterPiece[], index: number) => {
    const track = createCoasterTrack(pieces);
    const point = createCoasterTrackPoint();
    sampleCoasterTrack(track, track.centreDistance[index], point);
    return { x: point.x, y: point.y, z: point.z, directionX: Math.cos(point.yaw), directionY: Math.sin(point.yaw) };
  };

  it('puts the rail top at 13L + 5 at the middle of every piece — where the cars ride — over the spine, rails 3 either side', () => {
    const bankStep = Math.round(3 * Math.tan(CENTRE_LINE_BANK_MAX));
    expect(bankStep, 'a corner apex lifts the outer rail one voxel and drops the inner one').toBe(1);
    for (const layout of ALL_LAYOUTS) {
      const line = centreLineFor(layout.pieces);
      built(layout).forEach((boxes, index) => {
        const piece = layout.pieces[index];
        const railTop = coasterRailTopZ(piece.height);
        expect(railTop, 'the art bible rail top').toBe(COASTER_LEVEL_VOXELS * piece.height + 5);
        const label = `${layout.name} piece ${index}`;
        const middle = middleOf(layout.pieces, index);
        expect(middle.z, `${label}: the line is at the rail top there`).toBeCloseTo(railTop, 9);
        const column = (x: number, y: number) => boxes.filter((box) => box.x0 <= x && x < box.x1 && box.y0 <= y && y < box.y1
          && box.z0 < railTop + 3 && box.z1 > railTop - TRACK_DEPTH - 2 && isTrackBox(layout, box));
        // The column under the line: the spine (or the station's stone bed), 2 thick (3 from the grass at level 0), its top 2 under the rail top.
        const under = column(Math.floor(middle.x), Math.floor(middle.y));
        const spine = under.find((box) => isSpineBox(layout, box));
        expect(spine, `${label}: spine under the line`).toBeDefined();
        const lowest = spine!;
        expect(Math.abs(lowest.z1 + RAIL_HEIGHT_VOXELS + TIE_THICKNESS - railTop), `${label}: spine top two under the rail top`).toBeLessThanOrEqual(1);
        expect(lowest.z1 - lowest.z0, `${label}: spine 2 thick, plus the sink on the grass`).toBe(SPINE_HEIGHT + (lowest.z0 === GROUND_TOP_Z ? GROUND_SINK : 0));
        // Rails, 2 voxels wide, 3 voxels either side of the line, 1 voxel high; banked on a corner's apex.
        const turn = line.turn[index];
        const tops: number[] = [];
        for (const side of [-1, 1]) {
          const x = Math.floor(middle.x - middle.directionY * side * (TRACK_HALF_WIDTH - 1));
          const y = Math.floor(middle.y + middle.directionX * side * (TRACK_HALF_WIDTH - 1));
          const rail = column(x, y).find((box) => railBox(layout, box));
          expect(rail, `${label}: rail ${side * (TRACK_HALF_WIDTH - 1)} across the line`).toBeDefined();
          tops.push(rail?.z1 ?? 0);
          if (turn === 0) expect(rail?.z1, `${label}: a straight's rail top is the line's`).toBe(railTop);
        }
        if (turn !== 0) {
          // side −1 is the right of travel (−N): the outside of a left turn (turn +1). At ground level
          // the inner rail cannot drop into the ground, so only the outer one moves.
          const outer = turn > 0 ? tops[0] : tops[1];
          const inner = turn > 0 ? tops[1] : tops[0];
          expect(outer - railTop, `${label}: banked at the apex, outer rail up`).toBe(bankStep);
          expect(railTop - inner, `${label}: banked at the apex, inner rail down`).toBe(piece.height > 0 ? bankStep : 0);
        }
      });
    }
  });

  it('rounds every corner: rails exactly on radius 16 ± [2, 4), spine within 1, ties within 3, nothing past 4, inside the tile', () => {
    let turns = 0;
    const radius = CENTRE_LINE_CORNER_RADIUS * TILE;
    for (const layout of ALL_LAYOUTS) {
      const line = centreLineFor(layout.pieces);
      built(layout).forEach((boxes, index) => {
        if (line.turn[index] === 0) return;
        turns += 1;
        const cornerX = (line.cellX[index] + 0.5 - 0.5 * line.inX[index] + CENTRE_LINE_CORNER_RADIUS * line.outX[index]) * TILE;
        const cornerY = (line.cellY[index] + 0.5 - 0.5 * line.inY[index] + CENTRE_LINE_CORNER_RADIUS * line.outY[index]) * TILE;
        const label = `${layout.name} piece ${index}`;
        let rails = 0;
        let ties = 0;
        let spines = 0;
        for (let y = 0; y < TILE; y += 1) {
          for (let x = 0; x < TILE; x += 1) {
            const worldX = line.cellX[index] * TILE + x;
            const worldY = line.cellY[index] * TILE + y;
            const distance = Math.abs(Math.hypot(worldX + 0.5 - cornerX, worldY + 0.5 - cornerY) - radius);
            const column = boxes.filter((box) => isTrackBox(layout, box) && box.x0 <= worldX && worldX < box.x1 && box.y0 <= worldY && worldY < box.y1);
            const isRail = column.some((box) => railBox(layout, box));
            const isSpine = column.some((box) => isSpineBox(layout, box));
            const isTie = column.some((box) => isTieBox(layout, box));
            expect(isRail, `${label}: rail exactly where the column centre is 2 to 4 from the arc (${x},${y})`)
              .toBe(distance >= TRACK_HALF_WIDTH - RAIL_WIDTH && distance < TRACK_HALF_WIDTH);
            // A station corner stands in its stone bed over the whole band instead of on a spine.
            expect(isSpine, `${label}: spine exactly within 1 of the arc (${x},${y})`).toBe(distance < (index < STATION_LENGTH ? TRACK_HALF_WIDTH : SPINE_HALF_WIDTH));
            if (isTie) expect(distance, `${label}: ties within 3 of the arc (${x},${y})`).toBeLessThan(TIE_HALF_WIDTH);
            if (distance >= TRACK_HALF_WIDTH) expect(column.length, `${label}: no track past 4 from the arc (${x},${y})`).toBe(0);
            if (isRail) rails += 1;
            if (isTie) ties += 1;
            if (isSpine) spines += 1;
          }
        }
        // Two quarter annuli 2 wide at radii 12–14 and 18–20: about π/4 · (2 · 26 + 2 · 38) ≈ 100 columns.
        expect(rails, `${label}: rail columns`).toBeGreaterThan(80);
        expect(rails, `${label}: rail columns`).toBeLessThan(130);
        expect(spines, `${label}: spine columns`).toBeGreaterThan(20);
        // 7 radial bars about 2 wide over 6 voxels: around 80 columns.
        expect(ties, `${label}: tie columns`).toBeGreaterThan(50);
        expect(ties, `${label}: tie columns`).toBeLessThan(110);
      });
    }
    expect(turns, 'corners checked').toBeGreaterThan(50);
    // 3 to 4 s alone (every fixture and random layout, per column): the 5 s default flakes under the full suite's load.
  }, 20_000);

  it('joins neighbouring pieces edge to edge: the rail and spine columns on the two sides of a shared edge line up', { timeout: 30_000 }, () => {
    let joins = 0;
    for (const layout of ALL_LAYOUTS) {
      const pieces = layout.pieces;
      const boxes = built(layout).flat();
      const layers: ReadonlyArray<[string, (box: TestBox) => boolean]> = [['rail', (box) => railBox(layout, box)], ['spine', (box) => isSpineBox(layout, box)]];
      const layerAt = (x: number, y: number, is: (box: TestBox) => boolean): TestBox | undefined => boxes
        .filter((box) => is(box) && box.x0 <= x && x < box.x1 && box.y0 <= y && y < box.y1)
        .sort((a, b) => a.z0 - b.z0)[0];
      pieces.forEach((piece, index) => {
        const next = pieces[(index + 1) % pieces.length];
        const dx = next.cell.x - piece.cell.x;
        const dy = next.cell.y - piece.cell.y;
        if (Math.abs(dx) + Math.abs(dy) !== 1) return;
        // Voxel columns just before and just after the shared edge, across the 32 columns of the edge.
        const edge = dx !== 0 ? (dx > 0 ? next.cell.x : piece.cell.x) * TILE : (dy > 0 ? next.cell.y : piece.cell.y) * TILE;
        for (let across = 0; across < TILE; across += 1) {
          const base = (dx !== 0 ? piece.cell.y : piece.cell.x) * TILE + across;
          for (const [name, is] of layers) {
            // A station piece has its stone bed over the whole band instead of a spine.
            if (name === 'spine' && (index < STATION_LENGTH || (index + 1) % pieces.length < STATION_LENGTH)) continue;
            const before = dx !== 0 ? layerAt(edge - 1, base, is) : layerAt(base, edge - 1, is);
            const after = dx !== 0 ? layerAt(edge, base, is) : layerAt(base, edge, is);
            const label = `${layout.name} edge ${index}|${index + 1} column ${across} ${name}`;
            expect(before !== undefined, `${label}: the same columns carry it on both sides`).toBe(after !== undefined);
            if (before && after) {
              expect(Math.abs(before.z1 - after.z1), `${label}: meets within a voxel (a steep climb: two)`).toBeLessThanOrEqual(2);
            }
          }
        }
        joins += 1;
      });
    }
    expect(joins, 'joins checked').toBeGreaterThan(500);
  });

  /** The spine under a voxel position (a loop ring may stand above it): the lowest box of the spine material or the station's bed. */
  const spineUnder = (layout: Layout, boxes: readonly TestBox[], x: number, y: number): TestBox | undefined => boxes
    .filter((box) => isSpineBox(layout, box) && box.x0 <= Math.floor(x) && Math.floor(x) < box.x1 && box.y0 <= Math.floor(y) && Math.floor(y) < box.y1)
    .sort((a, b) => a.z0 - b.z0)[0];

  it('sits the car line on the spine along every piece, in thin treads that never step more than two voxels', { timeout: 30_000 }, () => {
    let samples = 0;
    let ramped = 0;
    let worstRiser = 0;
    for (const layout of ALL_LAYOUTS) {
      const pieces = layout.pieces;
      const boxes = built(layout).flat();
      const track = createCoasterTrack(pieces);
      const point = createCoasterTrackPoint();
      let previousTop = Number.NaN;
      pieces.forEach((piece, index) => {
        const next = pieces[(index + 1) % pieces.length];
        if (next.height !== piece.height) ramped += 1;
        const first = track.tileStart[index];
        const length = track.tileLength[index];
        const steps = Math.round(length * TILE * 4);
        for (let sample = 0; sample < steps; sample += 1) {
          // Along the piece's own tile: the track this piece built, never the loop ring after it.
          sampleCoasterTrack(track, first + (length * (sample + 0.5)) / steps, point);
          const spine = spineUnder(layout, boxes, point.x, point.y);
          const label = `${layout.name} piece ${index} at ${sample}/${steps}`;
          expect(spine, `${label}: spine under the car`).toBeDefined();
          const top = (spine?.z1 ?? 0) + RAIL_HEIGHT_VOXELS + TIE_THICKNESS;
          // Rounded to the voxel at the column centre, so within half a voxel plus the climb over the
          // half column between the sample and that centre (≤ 1.3 voxels a voxel, over ≤ 0.71).
          expect(Math.abs(top - point.z), `${label}: car z on the rail top`).toBeLessThanOrEqual(1.5);
          if (!Number.isNaN(previousTop)) worstRiser = Math.max(worstRiser, Math.abs(top - previousTop));
          previousTop = top;
          samples += 1;
        }
      });
    }
    expect(worstRiser, 'riser between neighbouring samples along the line').toBeLessThanOrEqual(2);
    expect(ramped, 'ramps checked').toBeGreaterThan(10);
    expect(samples, 'samples checked').toBeGreaterThan(5000);
  });

  it('lays a tie every 4 voxels of arc under the rails, 1 thick, and the rails on them', () => {
    let checked = 0;
    for (const layout of ALL_LAYOUTS) {
      const line = centreLineFor(layout.pieces);
      built(layout).forEach((boxes, index) => {
        const label = `${layout.name} piece ${index}`;
        // A loop piece's ring has ties too, all at or over the rail top on the piece's exit edge.
        const exitTop = layout.pieces[index].special === 'loop'
          ? sampleCoasterTrack(createCoasterTrack(layout.pieces), line.tileStart[index] + line.tileLength[index], createCoasterTrackPoint()).z
          : Number.POSITIVE_INFINITY;
        const ties = boxes.filter((box) => isTieBox(layout, box) && box.z0 < exitTop - 1);
        // A loop piece's straight ties are hard to tell from its ring's: the ring test covers them.
        if (layout.pieces[index].special === 'loop') return;
        const rails = boxes.filter((box) => railBox(layout, box));
        // Distinct tie positions along the line: the ties are 2 columns long, 4 apart, so cluster boxes
        // by the voxel column they share with the rails' direction (every tie box is at most 2 wide along).
        const along = line.inX[index] !== 0 && line.turn[index] === 0 ? 'x' : line.turn[index] === 0 ? 'y' : null;
        if (along) {
          const starts = new Set(ties.map((tie) => Math.floor((along === 'x' ? tie.x0 : tie.y0) / TIE_PERIOD)));
          expect(starts.size, `${label}: ${starts.size} ties on a straight piece`).toBeGreaterThanOrEqual(TILE / TIE_PERIOD - 1);
          expect(starts.size, `${label}: ties on a straight piece`).toBeLessThanOrEqual(TILE / TIE_PERIOD + 1);
        } else {
          expect(ties.length, `${label}: ties on a corner`).toBeGreaterThanOrEqual(5);
        }
        // Where a rail stands over a tie column, it stands exactly on it.
        for (const rail of rails) {
          for (const tie of ties) {
            if (rail.x0 < tie.x1 && tie.x0 < rail.x1 && rail.y0 < tie.y1 && tie.y0 < rail.y1 && Math.abs(rail.z0 - tie.z1) <= 2) {
              expect(rail.z0, `${label}: ${describeBox(rail)} rests on ${describeBox(tie)}`).toBe(tie.z1);
              checked += 1;
            }
          }
        }
      });
    }
    expect(checked, 'rail-on-tie contacts checked').toBeGreaterThan(2000);
  });

  it('banks corners: the outer rail is never lower than the inner one and rises at the apex; straights are level', () => {
    let corners = 0;
    for (const layout of ALL_LAYOUTS) {
      const line = centreLineFor(layout.pieces);
      built(layout).forEach((boxes, index) => {
        if (line.turn[index] === 0) return;
        corners += 1;
        const cornerX = (line.cellX[index] + 0.5 - 0.5 * line.inX[index] + CENTRE_LINE_CORNER_RADIUS * line.outX[index]) * TILE;
        const cornerY = (line.cellY[index] + 0.5 - 0.5 * line.inY[index] + CENTRE_LINE_CORNER_RADIUS * line.outY[index]) * TILE;
        const radius = CENTRE_LINE_CORNER_RADIUS * TILE;
        const rails = boxes.filter((box) => railBox(layout, box));
        // Pair inner and outer rail columns by the angle round the corner (1-degree bins).
        const byAngle = new Map<number, { inner: number[]; outer: number[] }>();
        for (const rail of rails) {
          for (let x = rail.x0; x < rail.x1; x += 1) {
            for (let y = rail.y0; y < rail.y1; y += 1) {
              const dx = x + 0.5 - cornerX;
              const dy = y + 0.5 - cornerY;
              const distance = Math.hypot(dx, dy);
              const bin = Math.round((Math.atan2(dy, dx) * 180) / Math.PI);
              const entry = byAngle.get(bin) ?? { inner: [], outer: [] };
              (distance < radius ? entry.inner : entry.outer).push(rail.z1);
              byAngle.set(bin, entry);
            }
          }
        }
        let lift = 0;
        for (const [bin, entry] of byAngle) {
          if (entry.inner.length === 0 || entry.outer.length === 0) continue;
          const inner = Math.max(...entry.inner);
          const outer = Math.min(...entry.outer);
          // Rounding can put the two a voxel apart either way on a steep ramp; the outer never dips under by two.
          expect(outer - inner, `${layout.name} piece ${index} at ${bin}°: outer rail not under the inner`).toBeGreaterThanOrEqual(-1);
          lift = Math.max(lift, Math.max(...entry.outer) - Math.min(...entry.inner));
        }
        // At ground level only the outer rail moves (the inner cannot drop into the ground).
        expect(lift, `${layout.name} piece ${index}: the outer rail rises over the inner somewhere round the corner`)
          .toBeGreaterThanOrEqual(layout.pieces[index].height > 0 ? 2 : 1);
      });
    }
    expect(corners, 'corners checked').toBeGreaterThan(50);
  });

  it('stands every raised piece on a bent: two legs on footings up to a beam under the spine, braced by height, nothing floating or clipping', () => {
    let bents = 0;
    const levels = new Map<number, { rungs: number; braces: number }>();
    for (const layout of ALL_LAYOUTS) {
      const look = lookOf(layout.definitionId);
      const line = centreLineFor(layout.pieces);
      built(layout).forEach((boxes, index) => {
        const piece = layout.pieces[index];
        const label = `${layout.name} piece ${index} (level ${piece.height})`;
        const supports = boxes.filter((box) => isSupportBox(layout, box));
        if (piece.height === 0) {
          // No footings and nothing standing on the path top but the station's platform: no supports on the ground, none in the station.
          expect(supports.length, `${label}: no supports on the ground (and none in the station)`).toBe(0);
          expect(boxes.filter((box) => box.material === look.support && box.z0 === SUPPORT_FOOTING_TOP).length, `${label}: no legs`).toBe(0);
          return;
        }
        bents += 1;
        const footings = supports.filter((box) => box.material === MAT.STONE);
        const legs = supports.filter((box) => box.material === look.support && box.z0 === SUPPORT_FOOTING_TOP);
        expect(footings.length, `${label}: two footings`).toBe(2);
        expect(legs.length, `${label}: two legs`).toBe(2);
        const beamTop = Math.max(...legs.map((leg) => leg.z1));
        for (const leg of legs) {
          expect([leg.x1 - leg.x0, leg.y1 - leg.y0], `${label}: 2×2 leg`).toEqual([SUPPORT_SIZE, SUPPORT_SIZE]);
          expect(leg.z1, `${label}: both legs reach the beam top`).toBe(beamTop);
          const footing = footings.find((pad) => pad.x0 <= leg.x0 && leg.x1 <= pad.x1 && pad.y0 <= leg.y0 && leg.y1 <= pad.y1);
          expect(footing, `${label}: ${describeBox(leg)} stands on a footing`).toBeDefined();
          expect(footing?.z1, `${label}: the footing is one voxel on the path top`).toBe(leg.z0);
        }
        // The legs stand 8 either side of the line at the bent on its plan normal (moved only off a walkway corridor).
        const frame = createCentreLineFrame();
        sampleCentreLineFrame(line, centreLineSupportDistance(line, index), frame);
        for (const leg of legs) {
          const dx = (leg.x0 + leg.x1) / 2 - frame.x * TILE;
          const dy = (leg.y0 + leg.y1) / 2 - frame.y * TILE;
          const across = -dx * frame.dirY + dy * frame.dirX;
          const along = dx * frame.dirX + dy * frame.dirY;
          const moved = piece.height >= GAME_CONFIG.coaster.pathClearanceHeight;
          expect(Math.abs(across), `${label}: ${describeBox(leg)} 8 from the line`).toBeGreaterThanOrEqual(moved ? 6 : 7);
          expect(Math.abs(across), `${label}: ${describeBox(leg)} not far from the line`).toBeLessThanOrEqual(moved ? 17 : 9);
          expect(Math.abs(along), `${label}: ${describeBox(leg)} at the bent`).toBeLessThanOrEqual(moved ? 9 : 1.5);
        }
        // Never into the track: every support box ends at or under the lowest track voxel over it.
        const track = boxes.filter((box) => isTrackBox(layout, box));
        for (const support of supports) {
          for (const over of track) {
            if (over.x0 < support.x1 && support.x0 < over.x1 && over.y0 < support.y1 && support.y0 < over.y1) {
              expect(support.z1, `${label}: ${describeBox(support)} stays under ${describeBox(over)}`).toBeLessThanOrEqual(over.z0);
            }
          }
        }
        // The beam meets the spine (within a voxel: the bent's strip reads the lowest spine bottom).
        const spineOver = track.filter((box) => box.material === look.spine && box.z0 >= beamTop && box.z0 <= beamTop + 1
          && supports.some((support) => support.z1 === beamTop && box.x0 < support.x1 && support.x0 < box.x1 && box.y0 < support.y1 && support.y0 < box.y1));
        expect(spineOver.length, `${label}: the beam carries the spine`).toBeGreaterThan(0);
        // Nothing floats: every support box shares a face with another support box or stands on the ground.
        for (const support of supports) {
          const grounded = support.z0 === SUPPORT_FOOTING_Z;
          const attached = supports.some((other) => other !== support && touches(support, other));
          expect(grounded || attached, `${label}: ${describeBox(support)} touches a leg, beam, rung, brace or the ground`).toBe(true);
        }
        // Bracing grows with height: a rung at z 23 from level 2, a diagonal per 12-voxel bay above it.
        const rungs = supports.filter((box) => box.material === look.support && box.z0 === SUPPORT_RUNG_Z && box.z1 - box.z0 === 2 && box.z0 < beamTop - 2);
        const braces = supports.filter((box) => box.material === look.support && box.z0 > SUPPORT_RUNG_Z + 1 && box.z1 < beamTop - 2 && box.z1 - box.z0 <= 4);
        const stats = levels.get(piece.height) ?? { rungs: 0, braces: 0 };
        stats.rungs += rungs.length > 0 ? 1 : 0;
        stats.braces += braces.length > 0 ? 1 : 0;
        levels.set(piece.height, stats);
        if (beamTop >= SUPPORT_RUNG_Z + 2 + 2) expect(rungs.length, `${label}: a rung above walking height`).toBeGreaterThan(0);
        else expect(rungs.length + braces.length, `${label}: no bracing on a low bent`).toBe(0);
        if (beamTop >= SUPPORT_RUNG_Z + 2 + SUPPORT_BAY + 2) expect(braces.length, `${label}: a diagonal brace in the bay`).toBeGreaterThanOrEqual(4);
      });
    }
    expect(bents, 'bents checked').toBeGreaterThan(200);
    expect(levels.get(1)?.rungs ?? 0, 'level 1: legs and beam only').toBe(0);
    expect(levels.get(2)?.rungs ?? 0, 'level 2: rungs').toBeGreaterThan(0);
    expect(levels.get(2)?.braces ?? 0, 'level 2: no diagonals').toBe(0);
    expect(levels.get(3)?.braces ?? 0, 'level 3: diagonals').toBeGreaterThan(0);
    expect(levels.get(4)?.braces ?? 0, 'level 4: diagonals').toBeGreaterThan(0);
  });

  it('leaves 22 voxels over every walk line under track at level ≥ 2 that a path could reach', () => {
    // A path may run under a piece of level ≥ 2 and on into any neighbour that is not track below
    // level 2 (World.canPlacePath); guests (≤ 20, 6 wide with arms) walk the lines from the tile
    // centre to its edges. Over the centre itself, and along each such line, nothing hangs lower
    // than 22 voxels above the path top.
    let corridors = 0;
    const directions: readonly Step[] = [{ dx: 1, dy: 0 }, { dx: -1, dy: 0 }, { dx: 0, dy: 1 }, { dx: 0, dy: -1 }];
    for (const layout of ALL_LAYOUTS) {
      const levels = new Map(layout.pieces.map((piece) => [`${piece.cell.x},${piece.cell.y}`, piece.height]));
      built(layout).forEach((boxes, index) => {
        const piece = layout.pieces[index];
        if (piece.height < GAME_CONFIG.coaster.pathClearanceHeight) return;
        const centre = centreOf(piece);
        for (const box of boxes) {
          if (footprintDistance(box, centre.x, centre.y) >= SUPPORT_CENTRE_CLEARANCE) continue;
          expect(box.z0, `${layout.name} piece ${index}: ${describeBox(box)} clears guests at the centre`)
            .toBeGreaterThanOrEqual(PATH_TOP_Z + WALK_CLEARANCE);
        }
        for (const direction of directions) {
          const neighbour = levels.get(`${piece.cell.x + direction.dx},${piece.cell.y + direction.dy}`);
          if (neighbour !== undefined && neighbour < GAME_CONFIG.coaster.pathClearanceHeight) continue;
          corridors += 1;
          const x0 = direction.dx === 0 ? centre.x - WALK_HALF_WIDTH : Math.min(centre.x, centre.x + direction.dx * HALF_TILE);
          const x1 = direction.dx === 0 ? centre.x + WALK_HALF_WIDTH : Math.max(centre.x, centre.x + direction.dx * HALF_TILE);
          const y0 = direction.dy === 0 ? centre.y - WALK_HALF_WIDTH : Math.min(centre.y, centre.y + direction.dy * HALF_TILE);
          const y1 = direction.dy === 0 ? centre.y + WALK_HALF_WIDTH : Math.max(centre.y, centre.y + direction.dy * HALF_TILE);
          for (const box of boxes) {
            if (box.x1 <= x0 || box.x0 >= x1 || box.y1 <= y0 || box.y0 >= y1) continue;
            expect(box.z0, `${layout.name} piece ${index} toward ${direction.dx},${direction.dy}: ${describeBox(box)} clears the walk line`)
              .toBeGreaterThanOrEqual(PATH_TOP_Z + WALK_CLEARANCE);
          }
        }
      });
    }
    expect(corridors, 'walk lines checked').toBeGreaterThan(300);
  });

  it('shows the lift chain only on climbing halves, and the brake pad and fin only on the run into the station', () => {
    let chained = 0;
    let brakes = 0;
    for (const layout of ALL_LAYOUTS) {
      const line = centreLineFor(layout.pieces);
      const last = layout.pieces.length - 1;
      built(layout).forEach((boxes, index) => {
        const label = `${layout.name} piece ${index}`;
        const dashes = boxes.filter((box) => box.material === MAT.FENCE_RAIL);
        const climbs = line.chained[index] === 1 || line.chained[(index + last) % layout.pieces.length] === 1;
        if (!climbs) expect(dashes.length, `${label}: no chain off a climb`).toBe(0);
        else if (line.turn[index] === 0 && layout.pieces[index].special !== 'boost') {
          expect(dashes.length, `${label}: chain dashes on a climbing straight`).toBeGreaterThanOrEqual(2);
          chained += 1;
        }
        for (const dash of dashes) expect(dash.z1 - dash.z0, `${label}: ${describeBox(dash)} in the rail layer`).toBe(1);
        const pads = boxes.filter((box) => box.material === MAT.CONCRETE);
        const fins = boxes.filter((box) => box.material === MAT.FENCE_POST);
        if (index !== last) {
          expect(pads.length, `${label}: no brake pad before the last piece`).toBe(0);
          expect(fins.length, `${label}: no brake fin before the last piece`).toBe(0);
          return;
        }
        brakes += 1;
        expect(pads.length, `${label}: a brake pad on the last piece`).toBeGreaterThan(0);
        const centre = centreOf(layout.pieces[index]);
        const alongX = line.inX[index] !== 0;
        for (const pad of pads) {
          const from = (alongX ? pad.x0 : pad.y0) - (alongX ? centre.x : centre.y) + HALF_TILE;
          const to = (alongX ? pad.x1 : pad.y1) - (alongX ? centre.x : centre.y) + HALF_TILE;
          if (line.turn[index] === 0) expect(from >= BRAKE_FROM - 1 && to <= BRAKE_TO + 1, `${label}: ${describeBox(pad)} over the middle of the piece`).toBe(true);
        }
        if (line.turn[index] === 0) {
          expect(fins.length, `${label}: a brake fin beside a straight last piece`).toBe(1);
          const beside = boxes.find((box) => (railBox(layout, box) || isTieBox(layout, box)) && touches(box, fins[0]));
          expect(beside, `${label}: the fin hangs on the rail or a tie`).toBeDefined();
        }
      });
    }
    expect(chained, 'climbing straights with a chain').toBeGreaterThan(20);
    expect(brakes, 'last pieces checked').toBe(ALL_LAYOUTS.length);
  });

  it('keeps every piece within its box allowance, and the longest coaster within its budget and build time', () => {
    let plain = 0;
    let corners = 0;
    for (const layout of ALL_LAYOUTS) {
      const line = centreLineFor(layout.pieces);
      built(layout).forEach((boxes, index) => {
        const { previous, piece, next } = around(layout.pieces, index);
        const rampedArms = (previous.height !== piece.height ? 1 : 0) + (next.height !== piece.height ? 1 : 0);
        const turning = line.turn[index] !== 0;
        const station = index < STATION_LENGTH;
        let allowance = turning
          ? (rampedArms > 0 ? COASTER_PIECE_BOX_ALLOWANCE.rampedTurn : COASTER_PIECE_BOX_ALLOWANCE.turn)
          : COASTER_PIECE_BOX_ALLOWANCE.plain + rampedArms * COASTER_PIECE_BOX_ALLOWANCE.ramp;
        allowance += piece.height * COASTER_PIECE_BOX_ALLOWANCE.bentPerLevel;
        if (station) allowance += COASTER_PIECE_BOX_ALLOWANCE.station;
        if (piece.special === 'boost') allowance += COASTER_PIECE_BOX_ALLOWANCE.boost;
        if (piece.special === 'loop') allowance += COASTER_PIECE_BOX_ALLOWANCE.loop;
        if (next.height > piece.height || previous.height < piece.height) allowance += COASTER_PIECE_BOX_ALLOWANCE.chain;
        if (index === layout.pieces.length - 1) allowance += COASTER_PIECE_BOX_ALLOWANCE.brake;
        if (rampedArms === 0 && !station && !piece.special && !turning) {
          plain += 1;
          expect(boxes.length, `${layout.name} piece ${index}: a flat straight piece`)
            .toBeLessThanOrEqual(BOX_BUDGET.coasterPerPiece + piece.height * BOX_BUDGET.coasterBentPerLevel);
        }
        if (turning) corners += 1;
        expect(boxes.length, `${layout.name} piece ${index}: within its allowance`).toBeLessThanOrEqual(allowance);
      });
    }
    expect(COASTER_PIECE_BOX_ALLOWANCE.plain, 'the plain allowance is the contract budget').toBe(BOX_BUDGET.coasterPerPiece);
    expect(COASTER_PIECE_BOX_ALLOWANCE.turn, 'the corner allowance is the contract budget').toBe(BOX_BUDGET.coasterTurnPiece);
    expect(plain, 'flat straight pieces checked').toBeGreaterThan(50);
    expect(corners, 'corners checked').toBeGreaterThan(50);

    const type = typeOf('skyline-serpent');
    const pieces = LONGEST;
    expect(pieces.length, 'the longest layout the designer allows').toBe(GAME_CONFIG.coaster.maximumPieces);
    expect(validateCoasterLayout(pieces, type), 'the budget layout is a real coaster').toEqual({ ok: true });
    const line = centreLineFor(pieces);
    const definition = definitionOf('skyline-serpent');
    const writer = new BoxWriter(16);
    const started = performance.now();
    for (let index = 0; index < pieces.length; index += 1) {
      coasterContent.pieceBoxes(pieces, index, definition, palette, GROUP, writer);
    }
    const milliseconds = performance.now() - started;
    const turns = Array.from(line.turn).filter((turn) => turn !== 0).length;
    expect(turns, 'most pieces are corners').toBeGreaterThan(40);
    expect(writer.count, `the longest coaster (${turns} corners)`).toBeLessThanOrEqual(COASTER_BOX_BUDGET.longest);
    expect(writer.count, 'and it is a lot more than a flat one').toBeGreaterThan(3000);
    expect(milliseconds, 'a chunk rebuild of every piece stays in one slice').toBeLessThan(COMPILE_BUDGET_MS);
    const dev = built(HANDCRAFTED[0]).reduce((sum, boxes) => sum + boxes.length, 0);
    expect(HANDCRAFTED[0].pieces.length, 'the dev park coaster').toBe(16);
    expect(dev, 'dev coaster boxes').toBeLessThanOrEqual(COASTER_BOX_BUDGET.devPark);
  });

  it('builds the station on the far side: a stone platform level with the rail top, a canopy clear of guests, a gate and a dispatch light', () => {
    let ringOverStations = 0;
    for (const layout of ALL_LAYOUTS) {
      const line = centreLineFor(layout.pieces);
      const definition = definitionOf(layout.definitionId);
      const canopyMaterial = palette.material(definition.color);
      const accent = palette.material(definition.accent);
      const [first, second] = layout.pieces;
      const alongX = second.cell.x !== first.cell.x;
      built(layout).forEach((boxes, index) => {
        const label = `${layout.name} piece ${index}`;
        const platforms = boxes.filter((box) => box.material === MAT.STONE && box.z0 === GROUND_TOP_Z && box.z1 === PLATFORM_TOP_Z);
        const canopies = boxes.filter((box) => box.material === canopyMaterial && box.pattern === PATTERN.STRIPES);
        if (index >= STATION_LENGTH) {
          expect(platforms.length + canopies.length, `${label}: no station off the station`).toBe(0);
          return;
        }
        // A turning first piece that the last piece's loop ring reaches over keeps its platform only.
        const ringOver = index === 0 && line.turn[0] !== 0 && layout.pieces[layout.pieces.length - 1].special === 'loop';
        if (ringOver) ringOverStations += 1;
        expect([platforms.length, canopies.length], `${label}: platform and canopy`).toEqual([1, ringOver ? 0 : 1]);
        if (ringOver) return;
        const centre = centreOf(layout.pieces[index]);
        const look = lookOf(layout.definitionId);
        for (const box of boxes.filter((part) => !isTrackBox(layout, part) && !(part.material === MAT.STONE && part.z1 < PLATFORM_TOP_Z))) {
          // Far side: −y beside a station along x, −x beside one along y (away from the camera).
          const nearEdge = alongX ? box.y1 : box.x1;
          expect(nearEdge, `${label}: ${describeBox(box)} on the far side`).toBeLessThanOrEqual((alongX ? centre.y : centre.x) - TRACK_HALF_WIDTH);
        }
        expect(platforms[0].z1, `${label}: platform top level with the rail top`).toBe(PLATFORM_TOP_Z);
        // The station's track stands in a paved pit: a stone bed from the grass under the whole track width instead of the spine.
        const beds = boxes.filter((box) => box.material === MAT.STONE && box.z0 === GROUND_TOP_Z && box.z1 === PLATFORM_TOP_Z - 2);
        expect(beds.length, `${label}: a stone bed under the station track`).toBeGreaterThan(0);
        expect(boxes.some((box) => box.material === look.spine), `${label}: no spine under the station`).toBe(false);
        // Festoon bulbs hang under the canopy's track-side edge, so the station reads at night.
        const bulbs = boxes.filter((box) => box.material === MAT.BULB && box.z1 <= CANOPY_BOTTOM_Z && box.z0 > PLATFORM_TOP_Z + DISPATCH_POST_HEIGHT);
        expect(bulbs.length >= 1 && bulbs.length <= 2, `${label}: one or two festoon bulbs (${bulbs.length})`).toBe(true);
        for (const bulb of bulbs) {
          expect(bulb.z1, `${label}: bulb under the canopy`).toBeLessThan(CANOPY_BOTTOM_Z);
          expect(bulb.z0, `${label}: bulb above standing guests`).toBeGreaterThanOrEqual(PLATFORM_TOP_Z + WALK_CLEARANCE - 4);
        }
        // The gate: two accent posts and a bar at the entry end of the first piece; the dispatch light at the exit end of the last.
        const gatePosts = boxes.filter((box) => box.material === accent && box.z0 === PLATFORM_TOP_Z && box.z1 === PLATFORM_TOP_Z + GATE_HEIGHT);
        const gateBars = boxes.filter((box) => box.material === accent && box.z0 === PLATFORM_TOP_Z + GATE_HEIGHT);
        const lightPosts = boxes.filter((box) => box.material === MAT.STEEL && box.z0 === PLATFORM_TOP_Z && box.z1 === PLATFORM_TOP_Z + DISPATCH_POST_HEIGHT);
        const lightBulbs = boxes.filter((box) => box.material === MAT.BULB && box.z0 === PLATFORM_TOP_Z + DISPATCH_POST_HEIGHT);
        // The gate stands at the entry end of the first piece and the light at the exit end of the last,
        // when the platform reaches that end (a turning station end loses the part inside its arc).
        const stationSign = alongX ? Math.sign(second.cell.x - first.cell.x) : Math.sign(second.cell.y - first.cell.y);
        const low = alongX ? platforms[0].x0 - layout.pieces[index].cell.x * TILE : platforms[0].y0 - layout.pieces[index].cell.y * TILE;
        const high = alongX ? platforms[0].x1 - layout.pieces[index].cell.x * TILE : platforms[0].y1 - layout.pieces[index].cell.y * TILE;
        const entryEnd = stationSign > 0 ? low === 0 : high === TILE;
        const exitEnd = stationSign > 0 ? high === TILE : low === 0;
        if (index === 0 && entryEnd) {
          expect([gatePosts.length, gateBars.length], `${label}: the queue gate`).toEqual([2, 1]);
          for (const post of gatePosts) expect(touches(post, gateBars[0]), `${label}: the bar sits on ${describeBox(post)}`).toBe(true);
        } else {
          expect(gatePosts.length + gateBars.length, `${label}: no gate elsewhere`).toBe(0);
        }
        if (index === STATION_LENGTH - 1 && exitEnd) {
          expect([lightPosts.length, lightBulbs.length], `${label}: the dispatch light`).toEqual([1, 1]);
          expect(touches(lightPosts[0], lightBulbs[0]), `${label}: the bulb sits on its post`).toBe(true);
        } else {
          expect(lightPosts.length + lightBulbs.length, `${label}: no dispatch light elsewhere`).toBe(0);
        }
        expect(PLATFORM_TOP_Z, 'the rail top at level 0').toBe(coasterRailTopZ(0));
        expect(CANOPY_BOTTOM_Z - PLATFORM_TOP_Z, 'a standing guest (≤ 20) fits under the canopy').toBeGreaterThanOrEqual(WALK_CLEARANCE);
      });
    }
    expect(ringOverStations, 'turning first pieces under a ring checked').toBeGreaterThan(0);
  });

  it('rings a loop piece so the cars\' loop path runs on its rails, from the centre line\'s own rotated ring', () => {
    let samples = 0;
    let rampedRings = 0;
    for (const layout of ALL_LAYOUTS) {
      const pieces = layout.pieces;
      const look = lookOf(layout.definitionId);
      const boxes = built(layout).flat();
      const track = createCoasterTrack(pieces);
      const point = createCoasterTrackPoint();
      pieces.forEach((piece, index) => {
        if (piece.special !== 'loop' || track.loop[index] === 0) return;
        const ringStart = track.tileStart[index] + track.tileLength[index];
        const ringLength = track.tileStart[index + 1] - ringStart;
        // The ring stands on the piece's exit edge, in the vertical plane of travel, rotated by the
        // track's pitch there: its centre is M + 16 · (−sin α along, cos α up).
        sampleCoasterTrack(track, ringStart, point);
        const base = { x: point.x, y: point.y, z: point.z };
        const pitch = track.ringEntryPitch[index];
        if (Math.abs(pitch) > 0.05) rampedRings += 1;
        const direction = { dx: Math.round(Math.cos(point.yaw)), dy: Math.round(Math.sin(point.yaw)) };
        const across = { x: direction.dy !== 0 ? 1 : 0, y: direction.dx !== 0 ? 1 : 0 };
        const centreX = base.x - direction.dx * LOOP_RAIL_RADIUS * Math.sin(pitch);
        const centreY = base.y - direction.dy * LOOP_RAIL_RADIUS * Math.sin(pitch);
        const centreZ = base.z + LOOP_RAIL_RADIUS * Math.cos(pitch);
        const rails = new Set<number>([look.rail]);
        const ring = new Set<number>([look.rail, look.tie, look.spine]);
        for (let sample = 1; sample < 64; sample += 1) {
          sampleCoasterTrack(track, ringStart + (ringLength * sample) / 64, point);
          // Near the bottom the track is the running surface; the ring stands on it (and a climbing
          // track rises under its far half), so look at the ring from 14 voxels up.
          if (point.z < base.z + 14) continue;
          samples += 1;
          const radius = Math.hypot(point.x - centreX, point.y - centreY, point.z - centreZ);
          expect(radius, `${layout.name} loop ${index}: the cars run 16 from the ring centre`).toBeCloseTo(LOOP_RAIL_RADIUS, 6);
          const outX = (point.x - centreX) / radius;
          const outY = (point.y - centreY) / radius;
          const outZ = (point.z - centreZ) / radius;
          const filled = (distance: number, lateral: number, materials: ReadonlySet<number>): boolean => boxes.some((box) =>
            box.piece === index && materials.has(box.material) && contains(box,
              Math.floor(point.x + outX * distance + across.x * lateral),
              Math.floor(point.y + outY * distance + across.y * lateral),
              Math.floor(point.z + outZ * distance)));
          const label = `${layout.name} loop ${index} at ${point.pitch.toFixed(2)} rad`;
          expect(filled(-1, 0.5, ring), `${label}: the cars' side of the ring is open`).toBe(false);
          expect(filled(LOOP_OUTER_RADIUS - LOOP_RAIL_RADIUS + 1, 0.5, ring), `${label}: the ring is 4 thick`).toBe(false);
          // A 1-voxel digital ring can pass a ray diagonally, so look for rail in the 3×3 voxels of
          // the ring plane around the running surface, and for the spine behind the ties.
          for (const lateral of [-TRACK_HALF_WIDTH + 1, TRACK_HALF_WIDTH - 1]) {
            const x = Math.floor(point.x + outX * 1 + across.x * lateral);
            const y = Math.floor(point.y + outY * 1 + across.y * lateral);
            const z = Math.floor(point.z + outZ * 1);
            let railThere = false;
            for (let along = -1; along <= 1; along += 1) {
              for (let up = -1; up <= 1; up += 1) {
                railThere ||= boxes.some((box) => box.piece === index && rails.has(box.material) && contains(box, x + direction.dx * along, y + direction.dy * along, z + up));
              }
            }
            expect(railThere, `${label}: a rail on the running surface ${lateral} across`).toBe(true);
          }
          expect(filled(LOOP_RAIL_THICKNESS + 1, 0.5, new Set([look.spine])), `${label}: the spine behind the rails`).toBe(true);
        }
      });
    }
    expect(samples, 'loop samples checked').toBeGreaterThan(300);
    expect(rampedRings, 'rings on ramps checked').toBeGreaterThan(3);
  });

  it('marks a boost piece with glowing chevrons between the rails, level with the rail tops', () => {
    let boosts = 0;
    for (const layout of ALL_LAYOUTS) {
      const look = lookOf(layout.definitionId);
      built(layout).forEach((boxes, index) => {
        const { piece, next } = around(layout.pieces, index);
        // Station pieces glow too (festoon bulbs under the canopy); boosts are never on the station.
        const chevrons = boxes.filter((box) => box.material === MAT.BULB && index >= STATION_LENGTH);
        if (piece.special !== 'boost') {
          expect(chevrons.length, `${layout.name} piece ${index}: chevrons only on boosts`).toBe(0);
          return;
        }
        boosts += 1;
        // Four chevrons of 8 voxels (a 2×2 tip and two 1×2 arms), however the treads split them.
        const voxels = chevrons.reduce((sum, box) => sum + (box.x1 - box.x0) * (box.y1 - box.y0) * (box.z1 - box.z0), 0);
        expect(voxels, `${layout.name} piece ${index}: 4 chevrons`).toBe(32);
        const centre = centreOf(piece);
        const direction = { dx: next.cell.x - piece.cell.x, dy: next.cell.y - piece.cell.y };
        const rails = boxes.filter((box) => box.material === look.rail);
        for (const chevron of chevrons) {
          const across = direction.dx !== 0 ? [chevron.y0 - centre.y, chevron.y1 - centre.y] : [chevron.x0 - centre.x, chevron.x1 - centre.x];
          const inner = TRACK_HALF_WIDTH - RAIL_WIDTH;
          expect(across[0] >= -inner && across[1] <= inner, `${layout.name} piece ${index}: chevron between the rails`).toBe(true);
          expect(chevron.z1 - chevron.z0, 'one voxel, like the rails').toBe(1);
          // In the rails' layer: a rail beside it shares its z.
          const beside = rails.find((rail) => rail.z0 === chevron.z0
            && (direction.dx !== 0 ? rail.x0 < chevron.x1 && chevron.x0 < rail.x1 : rail.y0 < chevron.y1 && chevron.y0 < rail.y1));
          expect(beside, `${layout.name} piece ${index}: ${describeBox(chevron)} level with a rail beside it`).toBeDefined();
        }
      });
    }
    expect(boosts, 'boost pieces checked').toBeGreaterThan(10);
  });

  it('is deterministic and stateless: a piece is the same whatever was built before it', () => {
    for (const layout of HANDCRAFTED) {
      const forward = buildLayout(layout);
      const definition = definitionOf(layout.definitionId);
      const writer = new BoxWriter(4);
      for (let index = layout.pieces.length - 1; index >= 0; index -= 1) {
        const from = writer.count;
        coasterContent.pieceBoxes(layout.pieces, index, definition, palette, GROUP, writer);
        expect(readBoxes(writer, from, index), `${layout.name} piece ${index} built backwards`).toEqual(forward[index]);
      }
      expect(buildLayout(layout), `${layout.name} rebuilt`).toEqual(forward);
    }
  });

  it('agrees with the centre line about banking: the roll is zero on straights and signed by the turn', () => {
    for (const layout of HANDCRAFTED) {
      const line = centreLineFor(layout.pieces);
      for (let index = 0; index < line.pieceCount; index += 1) {
        const apex = centreLineRollInPiece(line, index, line.tileLength[index] / 2);
        if (line.turn[index] === 0) expect(apex).toBe(0);
        else expect(Math.sign(apex)).toBe(-line.turn[index]);
      }
    }
  });

  it('survives malformed layouts without throwing or overlapping itself', () => {
    const definition = definitionOf('skyline-serpent');
    const malformed: CoasterPiece[][] = [
      [],
      [{ cell: { x: 3, y: 3 }, height: 2 }],
      [{ cell: { x: 3, y: 3 }, height: 0 }, { cell: { x: 4, y: 3 }, height: 1 }],
      [{ cell: { x: 3, y: 3 }, height: 1 }, { cell: { x: 5, y: 4 }, height: 4, special: 'loop' }, { cell: { x: 3, y: 3 }, height: 0 }],
      [{ cell: { x: 3, y: 3 }, height: 1 }, { cell: { x: 4, y: 3 }, height: 4, special: 'boost' }, { cell: { x: 5, y: 3 }, height: 1 }],
      [{ cell: { x: 3, y: 3 }, height: 4 }, { cell: { x: 4, y: 3 }, height: 4 }, { cell: { x: 4, y: 4 }, height: 4 }, { cell: { x: 3, y: 4 }, height: 4 }],
    ];
    for (const pieces of malformed) {
      const writer = new BoxWriter(4);
      for (let index = 0; index < pieces.length; index += 1) {
        const from = writer.count;
        expect(() => coasterContent.pieceBoxes(pieces, index, definition, palette, GROUP, writer), `${pieces.length} pieces`).not.toThrow();
        const boxes = readBoxes(writer, from, index);
        for (let a = 0; a < boxes.length; a += 1) {
          for (let b = a + 1; b < boxes.length; b += 1) {
            expect(overlaps(boxes[a], boxes[b]), `malformed piece ${index}: ${describeBox(boxes[a])} vs ${describeBox(boxes[b])}`).toBe(false);
          }
        }
      }
      if (pieces.length === 0) expect(writer.count, 'nothing to build').toBe(0);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Cars

const voxelCount = (boxes: Float32Array, count: number): number => {
  let voxels = 0;
  for (let box = 0; box < count; box += 1) {
    const at = box * BOX_FLOATS;
    voxels += boxes[at + 4] * boxes[at + 5] * boxes[at + 6];
  }
  return voxels;
};

const materialsOf = (boxes: Float32Array, count: number): Set<number> => {
  const materials = new Set<number>();
  for (let box = 0; box < count; box += 1) materials.add(unpackBoxWord(boxes[box * BOX_FLOATS + 3]).material);
  return materials;
};

/** Car roles of a type: lead, middle, and the serpent's tail car. */
const rolesOf = (id: string): Array<[string, number]> => {
  const cars = typeOf(id).trainCars;
  return id === 'skyline-serpent' ? [['lead', 0], ['middle', 1], ['last', cars - 1]] : [['lead', 0], ['middle', 1]];
};

const compiledBox = (boxes: Float32Array, box: number) => {
  const at = box * BOX_FLOATS;
  return {
    x0: boxes[at], y0: boxes[at + 1], z0: boxes[at + 2],
    x1: boxes[at] + boxes[at + 4], y1: boxes[at + 1] + boxes[at + 5], z1: boxes[at + 2] + boxes[at + 6],
    material: unpackBoxWord(boxes[at + 3]).material,
  };
};

describe('coaster cars', () => {
  const counts: string[] = [];
  for (const id of COASTER_IDS) {
    for (const [role, carIndex] of rolesOf(id)) {
      it(`${id} ${role} car: compiles in car space within budget, deterministic, at both quarter turns`, () => {
        const definition = definitionOf(id);
        const blueprint = coasterContent.carBlueprint(definition, carIndex, palette);
        expect(blueprint.floorZ, 'the wheels reach below the rail top, the floor is below them').toBe(-1);
        expect(blueprint.parts.map((part) => part.id), 'one body, posed as a whole').toEqual(['body']);
        expect(coasterContent.carBlueprint(definition, carIndex, palette), 'deterministic blueprint').toEqual(blueprint);
        const report = compileBlueprintReport(blueprint);
        const model = report.model;
        counts.push(`${id} ${role} car ${model.boxCount}`);
        expect(model.boxCount, 'BOX_BUDGET.coasterCar').toBeLessThanOrEqual(BOX_BUDGET.coasterCar);
        expect(Number.isFinite(report.parts[0].rasterRatio), `raster/exposed reported (${RASTER_TO_EXPOSED_RATIO} is not a gate)`).toBe(true);
        const part = model.parts[0];
        // The shared envelope x [-5, 5) y [-4, 4) z [-1, 8); only the lead's nose and the tail leave it, along x.
        const [minX, minY, minZ] = part.min;
        const [maxX, maxY, maxZ] = part.max;
        expect(minX, 'back').toBe(role === 'last' ? -CAR_HALF_LENGTH - CAR_NOSE_LENGTH : -CAR_HALF_LENGTH);
        expect(maxX, 'front').toBe(role === 'lead' ? CAR_HALF_LENGTH + CAR_NOSE_LENGTH : CAR_HALF_LENGTH);
        expect([minY, minZ]).toEqual([-(CAR_HALF_WIDTH + 1), -1]);
        expect(maxY).toBe(CAR_HALF_WIDTH + 1);
        // Guide wheels sit outside the rails (to |y| = 5) and nothing else leaves the 8 wide body.
        expect(maxZ, 'the cockpit backrests are one above the rim, the star chaser fin two').toBeLessThanOrEqual(CAR_HEIGHT + 3);
        const again = compileBlueprint(coasterContent.carBlueprint(definition, carIndex, palette));
        expect(Array.from(again.parts[0].boxes), 'deterministic boxes').toEqual(Array.from(part.boxes));
        for (const quarterTurn of [0, 1] as const) {
          const turned = rotateModel(model, quarterTurn);
          const flat = flattenAtRest(turned);
          const perPart = turned.parts.reduce((sum, each) => sum + voxelCount(each.boxes, each.boxCount), 0);
          expect(voxelCount(flat.boxes, flat.boxCount), `q${quarterTurn}: no part overlaps another at rest`).toBe(perPart);
          expect(turned.boxCount, `q${quarterTurn}: box count`).toBe(model.boxCount);
        }
      });
    }

    it(`${id}: wheels sit on the rails, the body wears the coaster's colour, seats and restraints are in its accent`, () => {
      const definition = definitionOf(id);
      const colour = palette.material(definition.color);
      const accent = palette.material(definition.accent);
      const middle = compileBlueprint(coasterContent.carBlueprint(definition, 1, palette)).parts[0];
      let wheels = 0;
      for (let box = 0; box < middle.boxCount; box += 1) {
        const b = compiledBox(middle.boxes, box);
        if (b.material !== MAT.INK) continue;
        wheels += 1;
        expect(b.z0, 'running wheels start on the rail top').toBe(0);
        expect(Math.min(Math.abs(b.y0), Math.abs(b.y1)), 'over the rails (|y| 2 to 4)').toBeGreaterThanOrEqual(2);
        expect(Math.max(Math.abs(b.y0), Math.abs(b.y1))).toBeLessThanOrEqual(4);
      }
      expect(wheels, 'four running wheels, two bogies').toBeGreaterThanOrEqual(4);
      const materials = materialsOf(middle.boxes, middle.boxCount);
      expect(materials.has(colour), 'body colour').toBe(true);
      expect(materials.has(accent), 'seats and bars in the accent').toBe(true);
      expect(materials.has(MAT.TRAIN), 'the chassis').toBe(true);
      expect(materials.has(MAT.LAMP_GLOW), 'only the lead car carries lamps').toBe(false);
      // Seats show from above: an accent floor patch with nothing over it.
      let open = false;
      for (let box = 0; box < middle.boxCount && !open; box += 1) {
        const b = compiledBox(middle.boxes, box);
        if (b.material !== accent) continue;
        open = true;
        for (let other = 0; other < middle.boxCount; other += 1) {
          const o = compiledBox(middle.boxes, other);
          if (o.z0 >= b.z1 && o.x0 < b.x1 && b.x0 < o.x1 && o.y0 < b.y1 && b.y0 < o.y1) open = false;
        }
      }
      expect(open, 'seats open to the sky').toBe(true);
    });

    it(`${id}: the lead car has a nose with lamps ahead of the body and a different silhouette from the middle car`, () => {
      const definition = definitionOf(id);
      const lead = compileBlueprint(coasterContent.carBlueprint(definition, 0, palette)).parts[0];
      const middle = compileBlueprint(coasterContent.carBlueprint(definition, 1, palette)).parts[0];
      let lamp = false;
      for (let box = 0; box < lead.boxCount; box += 1) {
        const b = compiledBox(lead.boxes, box);
        if (b.material === MAT.LAMP_GLOW && b.x1 > CAR_HALF_LENGTH) lamp = true;
      }
      expect(lamp, 'a glowing lamp on the nose, beyond the body').toBe(true);
      expect(lead.max[0]).toBeGreaterThan(middle.max[0]);
      expect(lead.boxCount).toBeGreaterThan(middle.boxCount - 4);
    });

    it(`${id} riders: one per seat of the car in guest colours, never the car's own, and a coupling of two small half-bars`, () => {
      const definition = definitionOf(id);
      const guests = new Set<number>([
        ...GUEST_COLORS.map((rgb) => palette.material(rgb)),
        MAT.SKIN_1, MAT.SKIN_2, MAT.SKIN_3, MAT.SKIN_4, MAT.HAIR_DARK, MAT.HAIR_BROWN, MAT.HAIR_BLOND,
      ]);
      for (let carIndex = 0; carIndex < typeOf(id).trainCars; carIndex += 1) {
        const blueprint = coasterContent.riderBlueprint(definition, carIndex, palette);
        expect(coasterContent.riderBlueprint(definition, carIndex, palette), 'deterministic').toEqual(blueprint);
        const model = compileBlueprint(blueprint);
        counts.push(`${id} riders car ${carIndex} ${model.boxCount}`);
        expect(model.boxCount, 'BOX_BUDGET.coasterRiders').toBeLessThanOrEqual(BOX_BUDGET.coasterRiders);
        const type = typeOf(id);
        const seats = coasterCarSeats(carIndex, type.trainCapacity, type.trainCars);
        // Shirt, face and hair per rider, raised arms on the looping types: a full train shows its capacity.
        expect(model.boxCount, `car ${carIndex} seats ${seats}`).toBeGreaterThanOrEqual(3 * seats);
        expect(model.boxCount, `car ${carIndex} seats ${seats}`).toBeLessThanOrEqual(4 * seats);
        const part = model.parts[0];
        for (let box = 0; box < part.boxCount; box += 1) {
          const b = compiledBox(part.boxes, box);
          expect(guests.has(b.material), `rider material ${b.material}`).toBe(true);
          expect(b.x0 >= -CAR_HALF_LENGTH + 1 && b.x1 <= CAR_HALF_LENGTH - 1, 'riders sit inside the cockpit (x)').toBe(true);
          expect(b.y0 >= -3 && b.y1 <= 3, 'inside the cockpit (y)').toBe(true);
          expect(b.z0, 'seated above the cockpit floor').toBeGreaterThanOrEqual(5);
        }
        // Riders never overlap the car's own boxes (no z-fighting between the two parts).
        const car = compileBlueprint(coasterContent.carBlueprint(definition, carIndex, palette)).parts[0];
        for (let box = 0; box < part.boxCount; box += 1) {
          const r = compiledBox(part.boxes, box);
          for (let other = 0; other < car.boxCount; other += 1) {
            const c = compiledBox(car.boxes, other);
            const overlaps = Math.min(r.x1, c.x1) > Math.max(r.x0, c.x0) && Math.min(r.y1, c.y1) > Math.max(r.y0, c.y0)
              && Math.min(r.z1, c.z1) > Math.max(r.z0, c.z0);
            expect(overlaps, `rider box ${box} overlaps car box ${other} (car ${carIndex})`).toBe(false);
          }
        }
      }
      const coupling = compileBlueprint(coasterContent.couplingBlueprint(definition, palette));
      counts.push(`${id} coupling ${coupling.boxCount}`);
      expect(coupling.boxCount, 'BOX_BUDGET.coasterCoupling').toBeLessThanOrEqual(BOX_BUDGET.coasterCoupling);
      expect([...coupling.parts[0].min].slice(0, 2), 'a half-bar from its pivot (the hitch) along +x').toEqual([0, -1]);
      expect(coupling.parts[0].max[0]).toBe(COUPLING_HALF_LENGTH);
      expect(2 * COUPLING_HALF_LENGTH).toBe(COUPLING_LENGTH);
    });
  }

  it('gives each coaster its own car models: lead and middle, and a tail for the serpent, shared by every middle car', () => {
    const ids = new Set<string>();
    for (const id of COASTER_IDS) {
      const definition = definitionOf(id);
      for (const [, carIndex] of rolesOf(id)) ids.add(coasterContent.carBlueprint(definition, carIndex, palette).id);
      expect(coasterContent.carBlueprint(definition, 2, palette).id, 'every middle car is one model').toBe(
        coasterContent.carBlueprint(definition, 1, palette).id,
      );
    }
    expect(ids.size, 'comet and star chaser: lead + middle, serpent: lead + middle + tail').toBe(7);
  });

  it('reads as three different trains: the middle cars of the three types share no body-colour set', () => {
    const sets = COASTER_IDS.map((id) => {
      const middle = compileBlueprint(coasterContent.carBlueprint(definitionOf(id), 1, palette)).parts[0];
      return [...materialsOf(middle.boxes, middle.boxCount)].sort().join(',');
    });
    expect(new Set(sets).size).toBe(3);
  });

  it('reports the box counts', () => {
    console.log(`train models: ${counts.join('; ')}`);
    expect(counts.length).toBeGreaterThan(0);
  });
});
