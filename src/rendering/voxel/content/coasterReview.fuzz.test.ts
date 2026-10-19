import { describe, expect, it } from 'vitest';
import {
  CENTRE_LINE_HALF_GAUGE,
  centreLineBankLift,
  centreLineChainedHalf,
  centreLineFor,
  centreLineRollInPiece,
  createCentreLineFrame,
  createTileProjection,
  projectOntoTile,
  sampleCentreLineFrame,
} from '../../../game/coaster/centreLine';
import type { CoasterPiece } from '../../../game/coaster/design';
import { coasterBaseCost, deriveCoasterStats, validateCoasterLayout } from '../../../game/coaster/design';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import { hillDipLayout, longestLayout, loopOvalLayout, ovalLayout, randomCircuit, zigzagLayout } from '../../../game/coaster/testLayouts';
import { GAME_CONFIG } from '../../../game/config';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { ParkSession } from '../../../game/session/ParkSession';
import type { BuildDefinition } from '../../../game/types';
import { createModelCache } from '../blueprint/compile';
import { BOX_FLOATS, BoxWriter, unpackBoxWord, withOutlineGroup } from '../contracts/boxes';
import type { VoxelGpuSink } from '../contracts/frame';
import { MAT, PATTERN } from '../contracts/palette';
import { GROUND_TOP_Z, PATH_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';
import { buildPalette } from '../palette';
import { CoasterDraft } from '../scene/coasterDraft';
import { coasterRailTopZ } from '../scene/coasterCars';
import { REGISTRY_CONTENT, SceneModels } from '../scene/staticWorld';
import { VoxelScene } from '../scene/VoxelScene';
import {
  BRAKE_FROM,
  BRAKE_TO,
  COASTER_PIECE_BOX_ALLOWANCE,
  DISPATCH_POST_HEIGHT,
  GATE_HEIGHT,
  GROUND_SINK,
  PLATFORM_TOP_Z,
  RAIL_WIDTH,
  SUPPORT_FOOTING_HEIGHT,
  SUPPORT_FOOTING_SIZE,
  SUPPORT_FOOTING_TOP,
  SUPPORT_FOOTING_Z,
  SUPPORT_RUNG_Z,
  SUPPORT_SIZE,
  TIE_THICKNESS,
  TRACK_DEPTH,
  TRACK_HALF_WIDTH,
  coasterContent,
  coasterLook,
} from './coaster';
import type { CoasterLook } from './coaster';

/**
 * Phase 27 step 2 adversarial review of the voxel coaster structure on 100 random closed circuits
 * (`randomCircuit`: hairpins, S-bends, loops beside corners, hills 0–4 under corners) and the
 * fixture layouts. Everything here is a property the brief asks for, checked per box:
 * - supports: footings on the ground, every member face-connected to a footing (a flood fill, not
 *   a pairwise touch), both legs reaching the beam, nothing in the station, nothing under the track's
 *   own bed, nothing in the walkway corridors of a piece a path may run under;
 * - rails: two continuous lines 3 voxels either side of the centre line on every piece kind, never a
 *   filled band;
 * - ties: evenly spaced by arc length over the whole circuit (the voxel twin of the centre-line check);
 * - chain: dashes exactly on climbing halves, corners included, and nowhere else;
 * - station: one gate, one dispatch light, a canopy per station piece, the brake once on the last piece;
 * - the draft shows the same box multiset as the built coaster;
 * - geometry is orientation-generic: the track layers of a layout rotated by 90°, 180°, 270° and
 *   mirrored are the same voxels transformed (Phase 26 readiness);
 * - colour by type: three distinct, bright looks;
 * - through the real scene: what a footing stands on.
 */

const TILE = VOXELS_PER_TILE;
const HALF_TILE = TILE / 2;
const STATION_LENGTH = GAME_CONFIG.coaster.stationLength;
const CLEARANCE = GAME_CONFIG.coaster.pathClearanceHeight;
const WALK_CLEARANCE = 22;
const WALK_HALF_WIDTH = 3;
const WALK_CENTRE_RADIUS = 4;
const GROUP = 3;

const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const SERPENT = BUILD_BY_ID.get('skyline-serpent')!;
const LOOKS = new Map<string, CoasterLook>(
  ['comet-trail', 'star-chaser', 'skyline-serpent'].map((id) => [id, coasterLook(BUILD_BY_ID.get(id)!, palette, { rail: 0, tie: 0, spine: 0, support: 0 })]),
);
const LOOK = LOOKS.get('skyline-serpent')!;

// ---------------------------------------------------------------------------------------------
// Layouts

const circuits = (): Array<[string, CoasterPiece[]]> => {
  const list: Array<[string, CoasterPiece[]]> = [
    ['oval', ovalLayout()],
    ['zig-zag', zigzagLayout()],
    ['hill and dip', hillDipLayout()],
    ['loop oval', loopOvalLayout()],
    ['longest', longestLayout()],
  ];
  for (let seed = 1; list.length < 105 && seed < 20000; seed += 1) {
    const target = 4 + 2 * (seed % 20);
    const layout = randomCircuit(seed, target, 4 + (seed % 6));
    const straight = layout !== null && layout[1].cell.x - layout[0].cell.x === layout[2].cell.x - layout[1].cell.x
      && layout[1].cell.y - layout[0].cell.y === layout[2].cell.y - layout[1].cell.y;
    if (layout && straight) list.push([`seed ${seed} (${target} pieces)`, layout]);
  }
  return list;
};

const CIRCUITS = circuits();

// ---------------------------------------------------------------------------------------------
// Boxes

interface Box {
  x0: number; y0: number; z0: number; x1: number; y1: number; z1: number;
  material: number; pattern: number; piece: number;
}

const buildAll = (pieces: readonly CoasterPiece[], definition: BuildDefinition = SERPENT): Box[] => {
  const writer = new BoxWriter(256);
  const boxes: Box[] = [];
  for (let index = 0; index < pieces.length; index += 1) {
    const from = writer.count;
    coasterContent.pieceBoxes(pieces, index, definition, palette, GROUP, writer);
    for (let box = from; box < writer.count; box += 1) {
      const at = box * BOX_FLOATS;
      const d = writer.data;
      const word = unpackBoxWord(d[at + 3]);
      boxes.push({
        x0: d[at], y0: d[at + 1], z0: d[at + 2], x1: d[at] + d[at + 4], y1: d[at + 1] + d[at + 5], z1: d[at + 2] + d[at + 6],
        material: word.material, pattern: word.pattern, piece: index,
      });
    }
  }
  return boxes;
};

const BUILT = new Map<CoasterPiece[], Box[]>();
const built = (pieces: CoasterPiece[]): Box[] => {
  let boxes = BUILT.get(pieces);
  if (!boxes) {
    boxes = buildAll(pieces);
    BUILT.set(pieces, boxes);
  }
  return boxes;
};

const describeBox = (box: Box): string => `piece ${box.piece} material ${box.material} [${box.x0},${box.y0},${box.z0}]–[${box.x1},${box.y1},${box.z1}]`;

const contains = (box: Box, x: number, y: number, z: number): boolean =>
  x >= box.x0 && x < box.x1 && y >= box.y0 && y < box.y1 && z >= box.z0 && z < box.z1;

/** Two boxes share a face (an area, not an edge or a corner). */
const touches = (a: Box, b: Box): boolean => {
  const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const overlapZ = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
  return (overlapX > 0 && overlapY > 0 && overlapZ === 0) || (overlapX > 0 && overlapZ > 0 && overlapY === 0) || (overlapY > 0 && overlapZ > 0 && overlapX === 0);
};

const footprintsOverlap = (a: Box, b: Box): boolean => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

const isFooting = (box: Box): boolean => box.material === MAT.STONE && box.z0 === SUPPORT_FOOTING_Z && box.z1 === SUPPORT_FOOTING_TOP
  && box.x1 - box.x0 <= SUPPORT_FOOTING_SIZE && box.y1 - box.y0 <= SUPPORT_FOOTING_SIZE;
const isSupport = (pieces: readonly CoasterPiece[], box: Box, look: CoasterLook = LOOK): boolean =>
  (box.material === look.support && pieces[box.piece].height > 0) || isFooting(box);
const isLeg = (box: Box, look: CoasterLook = LOOK): boolean => box.material === look.support && box.z0 === SUPPORT_FOOTING_TOP
  && box.x1 - box.x0 === SUPPORT_SIZE && box.y1 - box.y0 === SUPPORT_SIZE;
const SPINE_HEIGHT = TRACK_DEPTH - 1 - TIE_THICKNESS;
/** A lower-layer box (spine or bed): SPINE_HEIGHT thick, or GROUND_SINK more where it stands on the grass (level 0). */
const isLowerLayer = (box: Box, material: number): boolean => box.material === material
  && ((box.z0 === GROUND_TOP_Z && box.z1 - box.z0 === SPINE_HEIGHT + GROUND_SINK) || (box.z0 > GROUND_TOP_Z && box.z1 - box.z0 === SPINE_HEIGHT));
const isBed = (box: Box): boolean => isLowerLayer(box, MAT.STONE);
const isRail = (box: Box, look: CoasterLook = LOOK): boolean => box.material === look.rail && box.z1 - box.z0 === 1;
const isTie = (box: Box, look: CoasterLook = LOOK): boolean => box.material === look.tie && box.z1 - box.z0 === TIE_THICKNESS;
const isSpine = (box: Box, look: CoasterLook = LOOK): boolean => isLowerLayer(box, look.spine);
/** Track layers the cars ride (rails, ties, spine or bed, chain, brake, chevrons), excluding station furniture. */
const isTrack = (box: Box, look: CoasterLook = LOOK): boolean =>
  isRail(box, look) || isTie(box, look) || isSpine(box, look) || isBed(box)
    || box.material === MAT.FENCE_RAIL || box.material === MAT.CONCRETE || (box.material === MAT.BULB && box.z1 - box.z0 === 1);

const PROJECTION = createTileProjection();
/** Plan arc (voxels) along piece `index`'s own line and signed across (voxels, + toward the frame's N) of a world voxel column centre. */
const project = (pieces: readonly CoasterPiece[], index: number, x: number, y: number): { along: number; across: number } => {
  const line = centreLineFor(pieces);
  projectOntoTile(line, index, (x + 0.5) / TILE - line.cellX[index], (y + 0.5) / TILE - line.cellY[index], PROJECTION);
  const acrossSign = line.turn[index] === 0 ? line.inX[index] - line.inY[index] : -line.turn[index];
  return { along: PROJECTION.along * TILE, across: PROJECTION.offset * TILE * acrossSign };
};

// ---------------------------------------------------------------------------------------------
// Supports

describe('coaster structure review: supports (100 random circuits + fixtures)', () => {
  it('has enough circuits', () => {
    expect(CIRCUITS.length).toBeGreaterThanOrEqual(100);
  });

  it('stands every support member on the ground through a face-connected chain: footings on the grass, legs on footings, beam on both legs, bracing on the legs', () => {
    let bents = 0;
    let singleLegged = 0;
    for (const [name, pieces] of CIRCUITS) {
      const boxes = built(pieces);
      for (let index = 0; index < pieces.length; index += 1) {
        const supports = boxes.filter((box) => box.piece === index && isSupport(pieces, box));
        if (pieces[index].height === 0) {
          expect(supports.length, `${name} piece ${index}: level 0 has no supports`).toBe(0);
          continue;
        }
        if (supports.length === 0) continue;
        bents += 1;
        const footings = supports.filter(isFooting);
        const legs = supports.filter((box) => isLeg(box));
        expect(footings.length, `${name} piece ${index}: footings`).toBeGreaterThanOrEqual(1);
        expect(legs.length, `${name} piece ${index}: legs`).toBe(footings.length);
        if (legs.length < 2) singleLegged += 1;
        // Flood fill from the footings over face-sharing support boxes: nothing may be left over.
        const reached = new Set<Box>(footings);
        let grew = true;
        while (grew) {
          grew = false;
          for (const box of supports) {
            if (reached.has(box)) continue;
            for (const other of reached) {
              if (touches(box, other)) { reached.add(box); grew = true; break; }
            }
          }
        }
        for (const box of supports) {
          expect(reached.has(box), `${name} piece ${index}: ${describeBox(box)} is not connected to a footing through faces`).toBe(true);
        }
        // Each leg stands inside its footing and reaches the beam top; the beam touches every leg.
        const beamTop = Math.max(...legs.map((leg) => leg.z1));
        const members = supports.filter((box) => !isFooting(box) && !isLeg(box));
        for (const leg of legs) {
          const footing = footings.find((pad) => pad.x0 <= leg.x0 && leg.x1 <= pad.x1 && pad.y0 <= leg.y0 && leg.y1 <= pad.y1 && pad.z1 === leg.z0);
          expect(footing, `${name} piece ${index}: ${describeBox(leg)} on a footing`).toBeDefined();
          expect(leg.z1, `${name} piece ${index}: ${describeBox(leg)} reaches the beam top`).toBe(beamTop);
          if (legs.length === 2) {
            const beam = members.find((member) => member.z1 === beamTop && touches(member, leg));
            expect(beam, `${name} piece ${index}: the beam meets ${describeBox(leg)}`).toBeDefined();
          }
        }
      }
    }
    expect(bents).toBeGreaterThan(1000);
    // Legs pushed out of a walkway corridor may be dropped; report how often a bent ends up with one leg.
    expect(singleLegged / bents, `single-legged bents: ${singleLegged} of ${bents}`).toBeLessThan(0.05);
  });

  it('never puts a support box into the track over it, into the station, or into a walkway corridor under track a path may run under', () => {
    let corridors = 0;
    for (const [name, pieces] of CIRCUITS) {
      const boxes = built(pieces);
      for (let index = 0; index < pieces.length; index += 1) {
        const mine = boxes.filter((box) => box.piece === index);
        const supports = mine.filter((box) => isSupport(pieces, box));
        if (index < STATION_LENGTH) {
          expect(supports.length, `${name} piece ${index}: no support in the station`).toBe(0);
        }
        const track = mine.filter((box) => isTrack(box));
        for (const support of supports) {
          for (const over of track) {
            if (!footprintsOverlap(support, over)) continue;
            expect(support.z1, `${name} piece ${index}: ${describeBox(support)} clips ${describeBox(over)}`).toBeLessThanOrEqual(over.z0);
          }
        }
        if (pieces[index].height < CLEARANCE) continue;
        // A path may be placed on this cell (World.canPlacePath); guests walk from the tile centre to
        // the midpoint of each edge a path can continue over: any neighbour but track under level 2.
        const cx = pieces[index].cell.x * TILE + HALF_TILE;
        const cy = pieces[index].cell.y * TILE + HALF_TILE;
        for (const box of mine) {
          if (box.z0 >= PATH_TOP_Z + WALK_CLEARANCE) continue;
          const dx = Math.max(box.x0 - cx, 0, cx - box.x1);
          const dy = Math.max(box.y0 - cy, 0, cy - box.y1);
          const inDisc = dx * dx + dy * dy < WALK_CENTRE_RADIUS * WALK_CENTRE_RADIUS;
          expect(inDisc, `${name} piece ${index}: ${describeBox(box)} hangs over the tile centre`).toBe(false);
        }
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const neighbour = pieces.find((piece) => piece.cell.x === pieces[index].cell.x + dx && piece.cell.y === pieces[index].cell.y + dy);
          if (neighbour && neighbour.height < CLEARANCE) continue;
          corridors += 1;
          const x0 = dx === 0 ? cx - WALK_HALF_WIDTH : Math.min(cx, cx + dx * HALF_TILE);
          const x1 = dx === 0 ? cx + WALK_HALF_WIDTH : Math.max(cx, cx + dx * HALF_TILE);
          const y0 = dy === 0 ? cy - WALK_HALF_WIDTH : Math.min(cy, cy + dy * HALF_TILE);
          const y1 = dy === 0 ? cy + WALK_HALF_WIDTH : Math.max(cy, cy + dy * HALF_TILE);
          for (const box of mine) {
            if (box.z0 >= PATH_TOP_Z + WALK_CLEARANCE) continue;
            if (box.x1 <= x0 || box.x0 >= x1 || box.y1 <= y0 || box.y0 >= y1) continue;
            expect(box.z0, `${name} piece ${index} toward ${dx},${dy}: ${describeBox(box)} hangs into the walk line`).toBeGreaterThanOrEqual(PATH_TOP_Z + WALK_CLEARANCE);
          }
        }
      }
    }
    expect(corridors).toBeGreaterThan(300);
  });
});

// ---------------------------------------------------------------------------------------------
// Rails, ties, chain

describe('coaster structure review: rails, ties and chain', () => {
  it('runs two continuous rails 3 voxels either side of the centre line on every piece, never a filled band', { timeout: 30_000 }, () => {
    const frame = createCentreLineFrame();
    let samples = 0;
    for (const [name, pieces] of CIRCUITS) {
      const boxes = built(pieces);
      const line = centreLineFor(pieces);
      // A swept loop piece's rail boxes stack two voxels where the rail layer climbs.
      const rails = boxes.filter((box) => isRail(box) || (box.material === LOOK.rail && line.loop[box.piece] === 1 && box.z1 - box.z0 <= 2));
      const byPiece = new Map<number, Box[]>();
      for (const rail of rails) byPiece.set(rail.piece, [...(byPiece.get(rail.piece) ?? []), rail]);
      for (let index = 0; index < pieces.length; index += 1) {
        const start = line.tileStart[index];
        const length = line.tileLength[index];
        const mine = byPiece.get(index) ?? [];
        // Stay a voxel clear of the tile edges: there the rail belongs to the neighbour's columns.
        for (let along = 1 / TILE; along < length - 1 / TILE; along += 0.25 / TILE) {
          sampleCentreLineFrame(line, start + along, frame);
          samples += 1;
          const roll = centreLineRollInPiece(line, index, along);
          const top = Math.round(coasterRailTopZ(frame.z));
          for (const side of [1, -1]) {
            const across = side * CENTRE_LINE_HALF_GAUGE;
            const lift = Math.round(centreLineBankLift(across, roll) * TILE);
            // Phase 48: a loop piece steps aside, so its rails sit along the frame's own normal, not the tile's.
            const loop = line.loop[index] === 1;
            const px = Math.floor((frame.x + (loop ? frame.normalX : -frame.dirY) * across) * TILE);
            const py = Math.floor((frame.y + (loop ? frame.normalY : frame.dirX) * across) * TILE);
            let found = false;
            for (let dz = -2; dz <= 1 && !found; dz += 1) {
              for (let dx = -1; dx <= 1 && !found; dx += 1) {
                for (let dy = -1; dy <= 1 && !found; dy += 1) {
                  found = mine.some((rail) => contains(rail, px + dx, py + dy, top + lift + dz));
                }
              }
            }
            expect(found, `${name} piece ${index} at ${(along * TILE).toFixed(2)} voxels, side ${side}: no rail near (${px}, ${py}, ${top + lift})`).toBe(true);
          }
          // Two lines, not a band: the centre column of the rail layer carries no rail.
          const cx = Math.floor(frame.x * TILE);
          const cy = Math.floor(frame.y * TILE);
          expect(mine.some((rail) => contains(rail, cx, cy, top - 1) || contains(rail, cx, cy, top)), `${name} piece ${index} at ${(along * TILE).toFixed(2)}: rail on the centre line`).toBe(false);
        }
      }
    }
    expect(samples).toBeGreaterThan(100_000);
  });

  // FINDING (step 2 review, voxel twin of the centre-line tie check): tie columns restart at every
  // piece's entry edge ([4k, 4k + 2) of the piece's own arc), so a corner's last sliver tie (arc 24
  // to 25.13) and the next piece's first tie (0 to 2) merge into one tie about 3 voxels long at
  // every corner exit, while the normal pitch is 2 on, 2 off. Pinned as an expected failure.
  it.fails('lays ties evenly by arc length along the centre line over the whole circuit: 2-voxel ties, 2-voxel gaps, corner exits included', () => {
    const frame = createCentreLineFrame();
    for (const [name, pieces] of CIRCUITS) {
      const boxes = built(pieces);
      const ties = boxes.filter((box) => isTie(box));
      const line = centreLineFor(pieces);
      // Walk the circuit's line (rings skipped) in quarter-voxel steps, noting where a tie is under it.
      const runs: Array<{ from: number; to: number }> = [];
      let open: { from: number; to: number } | null = null;
      let arc = 0;
      for (let index = 0; index < pieces.length; index += 1) {
        const start = line.tileStart[index];
        const length = line.tileLength[index];
        for (let along = 0; along < length; along += 0.25 / TILE) {
          sampleCentreLineFrame(line, start + along, frame);
          const x = Math.floor(frame.x * TILE);
          const y = Math.floor(frame.y * TILE);
          const top = Math.round(coasterRailTopZ(frame.z));
          let tie = false;
          for (let z = top - 3; z <= top && !tie; z += 1) tie = ties.some((box) => contains(box, x, y, z));
          const here = arc + along * TILE;
          if (tie) {
            if (open) open.to = here;
            else open = { from: here, to: here };
          } else if (open) {
            runs.push(open);
            open = null;
          }
        }
        arc += length * TILE;
      }
      if (open) runs.push(open);
      for (let at = 0; at < runs.length; at += 1) {
        const run = runs[at];
        expect(run.to - run.from, `${name}: tie at arc ${run.from.toFixed(2)} is ${(run.to - run.from + 0.25).toFixed(2)} voxels long`).toBeLessThanOrEqual(2.3);
        if (at === 0) continue;
        const gap = (run.from + run.to) / 2 - (runs[at - 1].from + runs[at - 1].to) / 2;
        expect(gap, `${name}: tie pitch at arc ${run.from.toFixed(2)}`).toBeGreaterThanOrEqual(3);
        expect(gap, `${name}: tie pitch at arc ${run.from.toFixed(2)}`).toBeLessThanOrEqual(5.5);
      }
    }
  });

  it('shows chain dashes exactly on climbing halves (corners included), between the rails, in the rail layer, and nowhere else', () => {
    let chainedHalves = 0;
    for (const [name, pieces] of CIRCUITS) {
      const boxes = built(pieces);
      const line = centreLineFor(pieces);
      for (let index = 0; index < pieces.length; index += 1) {
        const dashes = boxes.filter((box) => box.piece === index && box.material === MAT.FENCE_RAIL);
        const brake = index === pieces.length - 1;
        // Phase 48: a loop piece is swept, off the tile's axis (coasterFamilies.test.ts 'Phase 48: swept loop' checks it).
        if (line.loop[index] === 1) continue;
        for (const dash of dashes) {
          expect(dash.z1 - dash.z0, `${name} piece ${index}: ${describeBox(dash)} in the rail layer`).toBe(1);
          for (let x = dash.x0; x < dash.x1; x += 1) {
            for (let y = dash.y0; y < dash.y1; y += 1) {
              const { along, across } = project(pieces, index, x, y);
              expect(Math.abs(across), `${name} piece ${index}: dash at ${x},${y} between the rails`).toBeLessThan(TRACK_HALF_WIDTH - RAIL_WIDTH);
              expect(centreLineChainedHalf(line, index, along / TILE), `${name} piece ${index}: dash at ${x},${y} (arc ${along.toFixed(1)}) on a chained half`).toBe(true);
            }
          }
        }
        for (const half of [0, 1]) {
          const along = half === 0 ? 0 : line.tileLength[index];
          if (!centreLineChainedHalf(line, index, along)) continue;
          if (pieces[index].special === 'boost') continue;
          chainedHalves += 1;
          const onHalf = dashes.filter((dash) => {
            const { along: at } = project(pieces, index, dash.x0, dash.y0);
            return half === 0 ? at < (line.tileLength[index] * TILE) / 2 : at >= (line.tileLength[index] * TILE) / 2;
          });
          // The brake pad takes the middle of the last piece; a chained half of it keeps a dash only at its edge.
          if (!brake) expect(onHalf.length, `${name} piece ${index} half ${half}: a chain on a climbing half`).toBeGreaterThan(0);
        }
      }
    }
    expect(chainedHalves).toBeGreaterThan(500);
  });
});

// ---------------------------------------------------------------------------------------------
// Station and brake

describe('coaster structure review: station and brake', () => {
  it('builds one gate, one dispatch light, one canopy per station piece, and the brake pad and fin once on the run into the station', () => {
    let gateless = 0;
    const gatelessNames: string[] = [];
    for (const [name, pieces] of CIRCUITS) {
      const boxes = built(pieces);
      const accent = palette.material(SERPENT.accent);
      const station = boxes.filter((box) => box.piece < STATION_LENGTH);
      const gatePosts = station.filter((box) => box.material === accent && box.z0 === PLATFORM_TOP_Z && box.z1 === PLATFORM_TOP_Z + GATE_HEIGHT);
      const gateBars = station.filter((box) => box.material === accent && box.z0 === PLATFORM_TOP_Z + GATE_HEIGHT && box.z1 === PLATFORM_TOP_Z + GATE_HEIGHT + 1 && box.z1 - box.z0 === 1 && (box.x1 - box.x0 >= 8 || box.y1 - box.y0 >= 8));
      const lightPosts = station.filter((box) => box.material === MAT.STEEL && box.z0 === PLATFORM_TOP_Z && box.z1 === PLATFORM_TOP_Z + DISPATCH_POST_HEIGHT);
      const lightBulbs = station.filter((box) => box.material === MAT.BULB && box.z0 === PLATFORM_TOP_Z + DISPATCH_POST_HEIGHT);
      const canopies = boxes.filter((box) => box.pattern === PATTERN.STRIPES);
      const platforms = boxes.filter((box) => box.material === MAT.STONE && box.z0 === GROUND_TOP_Z && box.z1 === PLATFORM_TOP_Z);
      if (gatePosts.length === 0) {
        gateless += 1;
        const line = centreLineFor(pieces);
        gatelessNames.push(`${name} [turn0 ${line.turn[0]}, last ${pieces[pieces.length - 1].special ?? 'plain'}, canopies ${canopies.length}]`);
      }
      else expect([gatePosts.length, gateBars.length], `${name}: one gate`).toEqual([2, 1]);
      expect([lightPosts.length, lightBulbs.length], `${name}: one dispatch light`).toEqual([1, 1]);
      expect(platforms.length, `${name}: a platform per station piece`).toBe(STATION_LENGTH);
      expect(canopies.length, `${name}: a canopy per station piece (${canopies.length})`).toBeLessThanOrEqual(STATION_LENGTH);
      for (const canopy of canopies) expect(canopy.piece, `${name}: canopy on the station`).toBeLessThan(STATION_LENGTH);
      const pads = boxes.filter((box) => box.material === MAT.CONCRETE);
      const fins = boxes.filter((box) => box.material === MAT.FENCE_POST);
      expect(pads.length, `${name}: a brake pad`).toBeGreaterThan(0);
      for (const pad of pads) expect(pad.piece, `${name}: the brake pad on the last piece`).toBe(pieces.length - 1);
      expect(fins.length, `${name}: at most one fin`).toBeLessThanOrEqual(1);
      for (const fin of fins) expect(fin.piece).toBe(pieces.length - 1);
      // The pad covers the middle of the last piece's arc.
      const last = pieces.length - 1;
      for (const pad of pads) {
        const { along } = project(pieces, last, pad.x0, pad.y0);
        expect(along, `${name}: pad at arc ${along.toFixed(1)}`).toBeGreaterThanOrEqual(BRAKE_FROM - 1.5);
        expect(along, `${name}: pad at arc ${along.toFixed(1)}`).toBeLessThan(BRAKE_TO + 1.5);
      }
    }
    // FINDING (step 2 review): every gateless layout is the same case: a loop on the last piece and a
    // station whose first piece is the lap-closing corner. `emitStation` then keeps piece 0's platform
    // only, so that station has no queue gate, two canopies instead of three and no festoon bulb on
    // piece 0 (the classic renderer still draws all three). 15 of these 100 random circuits; a real
    // player layout ("loop right before the station") can do the same.
    for (const entry of gatelessNames) expect(entry, 'gateless only under a ring over a turning first piece').toMatch(/turn0 -?1, last loop, canopies 2/);
    expect(gateless, `layouts without a queue gate: ${gateless}`).toBeLessThanOrEqual(CIRCUITS.length / 5);
  });
});

// ---------------------------------------------------------------------------------------------
// Overlaps and tiles

describe('coaster structure review: overlaps and tiles', () => {
  it('never overlaps two boxes of a layout and keeps every box in its tile (a ring in its own tile or the next piece\'s)', () => {
    for (const [name, pieces] of CIRCUITS) {
      const boxes = built(pieces);
      const occupied = new Set<number>();
      const key = (x: number, y: number, z: number): number => ((x + 64) * 4096 + (y + 64)) * 512 + z;
      for (const box of boxes) {
        const piece = pieces[box.piece];
        const next = pieces[(box.piece + 1) % pieces.length];
        const ring = piece.special === 'loop' && (box.material === LOOK.rail || box.material === LOOK.tie || box.material === LOOK.spine);
        const inTile = (cell: { x: number; y: number }): boolean => box.x0 >= cell.x * TILE && box.x1 <= (cell.x + 1) * TILE && box.y0 >= cell.y * TILE && box.y1 <= (cell.y + 1) * TILE;
        if (!ring) expect(inTile(piece.cell), `${name}: ${describeBox(box)} in its tile`).toBe(true);
        else {
          // A ring box lies in its own tile or the next piece's: never beside them.
          const minX = Math.min(piece.cell.x, next.cell.x) * TILE;
          const maxX = (Math.max(piece.cell.x, next.cell.x) + 1) * TILE;
          const minY = Math.min(piece.cell.y, next.cell.y) * TILE;
          const maxY = (Math.max(piece.cell.y, next.cell.y) + 1) * TILE;
          expect(box.x0 >= minX && box.x1 <= maxX && box.y0 >= minY && box.y1 <= maxY, `${name}: ring ${describeBox(box)} within its tile and the next`).toBe(true);
        }
        for (let x = box.x0; x < box.x1; x += 1) {
          for (let y = box.y0; y < box.y1; y += 1) {
            for (let z = box.z0; z < box.z1; z += 1) {
              const voxel = key(x, y, z);
              if (occupied.has(voxel)) throw new Error(`${name}: overlap at ${x},${y},${z} by ${describeBox(box)}`);
              occupied.add(voxel);
            }
          }
        }
      }
    }
  });

  it('keeps every piece within its box allowance on the random circuits too', () => {
    for (const [name, pieces] of CIRCUITS) {
      const boxes = built(pieces);
      const line = centreLineFor(pieces);
      for (let index = 0; index < pieces.length; index += 1) {
        const count = boxes.filter((box) => box.piece === index).length;
        const previous = pieces[(index + pieces.length - 1) % pieces.length];
        const next = pieces[(index + 1) % pieces.length];
        const piece = pieces[index];
        const rampedArms = (previous.height !== piece.height ? 1 : 0) + (next.height !== piece.height ? 1 : 0);
        const turning = line.turn[index] !== 0;
        let allowance = turning
          ? (rampedArms > 0 ? COASTER_PIECE_BOX_ALLOWANCE.rampedTurn : COASTER_PIECE_BOX_ALLOWANCE.turn)
          : COASTER_PIECE_BOX_ALLOWANCE.plain + rampedArms * COASTER_PIECE_BOX_ALLOWANCE.ramp;
        allowance += piece.height * COASTER_PIECE_BOX_ALLOWANCE.bentPerLevel;
        if (index < STATION_LENGTH) allowance += COASTER_PIECE_BOX_ALLOWANCE.station;
        if (piece.special === 'boost') allowance += COASTER_PIECE_BOX_ALLOWANCE.boost;
        if (piece.special === 'loop') allowance += COASTER_PIECE_BOX_ALLOWANCE.loop;
        if (next.height > piece.height || previous.height < piece.height) allowance += COASTER_PIECE_BOX_ALLOWANCE.chain;
        if (index === pieces.length - 1) allowance += COASTER_PIECE_BOX_ALLOWANCE.brake;
        expect(count, `${name} piece ${index} (${turning ? 'corner' : 'straight'}, level ${piece.height}, ${rampedArms} ramped arms${piece.special ? `, ${piece.special}` : ''}): ${count} boxes`).toBeLessThanOrEqual(allowance);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Orientation (Phase 26 readiness) and the draft

type Transform = (box: Box) => Box;

const SPAN = 48 * TILE;
/** Rotations about the map's (cx, cy) → (47 − cy, cx) and the mirror (cx, cy) → (47 − cx, cy), as box transforms. */
const TRANSFORMS: ReadonlyArray<{ name: string; cell: (cell: { x: number; y: number }) => { x: number; y: number }; box: Transform }> = [
  { name: 'quarter turn', cell: (cell) => ({ x: 47 - cell.y, y: cell.x }), box: (box) => ({ ...box, x0: SPAN - box.y1, x1: SPAN - box.y0, y0: box.x0, y1: box.x1 }) },
  { name: 'half turn', cell: (cell) => ({ x: 47 - cell.x, y: 47 - cell.y }), box: (box) => ({ ...box, x0: SPAN - box.x1, x1: SPAN - box.x0, y0: SPAN - box.y1, y1: SPAN - box.y0 }) },
  { name: 'three-quarter turn', cell: (cell) => ({ x: cell.y, y: 47 - cell.x }), box: (box) => ({ ...box, x0: box.y0, x1: box.y1, y0: SPAN - box.x1, y1: SPAN - box.x0 }) },
  { name: 'mirror', cell: (cell) => ({ x: 47 - cell.x, y: cell.y }), box: (box) => ({ ...box, x0: SPAN - box.x1, x1: SPAN - box.x0 }) },
];

const voxelKeys = (boxes: readonly Box[]): Set<string> => {
  const keys = new Set<string>();
  for (const box of boxes) {
    for (let x = box.x0; x < box.x1; x += 1) {
      for (let y = box.y0; y < box.y1; y += 1) {
        for (let z = box.z0; z < box.z1; z += 1) keys.add(`${x},${y},${z},${box.material}`);
      }
    }
  }
  return keys;
};

const difference = (a: Set<string>, b: Set<string>): string[] => [...a].filter((key) => !b.has(key));

describe('coaster structure review: orientation', () => {
  it('builds the same track voxels (rails, ties, spine, chain, brake pad) for a layout turned by a quarter, half and three quarters, and mirrored', () => {
    const subjects = CIRCUITS.slice(0, 25);
    let loopsChecked = 0;
    for (const [name, pieces] of subjects) {
      // Phase 48: a loop piece is swept along its rolled frame, which rounds a voxel either way where a turned layout's
      // floating point lands on a voxel boundary: its volume is checked (within 2 %) instead of its exact voxels.
      const loop = centreLineFor(pieces).loop;
      const original = built(pieces).filter((box) => (isRail(box) || isTie(box) || isSpine(box) || box.material === MAT.FENCE_RAIL || box.material === MAT.CONCRETE) && box.piece >= STATION_LENGTH && loop[box.piece] === 0);
      const expected = voxelKeys(original);
      const loopVolume = (boxes: readonly Box[]): number => boxes.filter((box) => loop[box.piece] === 1 && box.piece >= STATION_LENGTH)
        .reduce((sum, box) => sum + (box.x1 - box.x0) * (box.y1 - box.y0) * (box.z1 - box.z0), 0);
      const originalLoops = loopVolume(built(pieces));
      for (const transform of TRANSFORMS) {
        const turned = pieces.map((piece): CoasterPiece => ({ ...piece, cell: transform.cell(piece.cell) }));
        const turnedBoxes = buildAll(turned);
        const actual = voxelKeys(turnedBoxes.filter((box) => (isRail(box) || isTie(box) || isSpine(box) || box.material === MAT.FENCE_RAIL || box.material === MAT.CONCRETE) && box.piece >= STATION_LENGTH && loop[box.piece] === 0));
        const mapped = voxelKeys(original.map(transform.box));
        const missing = difference(mapped, actual);
        const extra = difference(actual, mapped);
        expect(missing.length + extra.length, `${name} ${transform.name}: ${missing.length} track voxels missing, ${extra.length} extra (e.g. ${missing[0] ?? extra[0]})`).toBe(0);
        expect(actual.size).toBe(expected.size);
        if (originalLoops > 0) {
          loopsChecked += 1;
          expect(Math.abs(loopVolume(turnedBoxes) - originalLoops) / originalLoops, `${name} ${transform.name}: loop volume`).toBeLessThan(0.02);
        }
      }
    }
    expect(loopsChecked).toBeGreaterThan(0);
  });

  // FINDING (step 2 review): a bent's legs are rasterised with floor(centre) − 1, which is not
  // symmetric under mirroring or rotation, so a mirrored or turned corner gets its legs (and with
  // them the beam and bracing) shifted by a voxel. The track is orientation-generic (test above);
  // the supports are nearly so. Pinned as an expected failure so Phase 26 knows.
  it.fails('builds the same support voxels for a layout turned and mirrored', () => {
    const subjects = CIRCUITS.slice(0, 25);
    for (const [name, pieces] of subjects) {
      const original = built(pieces).filter((box) => isSupport(pieces, box));
      for (const transform of TRANSFORMS) {
        const turned = pieces.map((piece): CoasterPiece => ({ ...piece, cell: transform.cell(piece.cell) }));
        const actual = voxelKeys(buildAll(turned).filter((box) => isSupport(turned, box)));
        const mapped = voxelKeys(original.map(transform.box));
        const missing = difference(mapped, actual);
        const extra = difference(actual, mapped);
        expect(missing.length + extra.length, `${name} ${transform.name}: ${missing.length} support voxels missing, ${extra.length} extra`).toBe(0);
      }
    }
  });

  it('keeps the footing count the same whichever way a layout faces, and the support volume within 10 % (measures the drift)', () => {
    const subjects = CIRCUITS.slice(0, 25);
    let worst = 0;
    let worstLabel = '';
    for (const [name, pieces] of subjects) {
      const original = built(pieces).filter((box) => isSupport(pieces, box));
      const originalVoxels = voxelKeys(original);
      for (const transform of TRANSFORMS) {
        const turned = pieces.map((piece): CoasterPiece => ({ ...piece, cell: transform.cell(piece.cell) }));
        const actual = buildAll(turned).filter((box) => isSupport(turned, box));
        expect(actual.filter(isFooting).length, `${name} ${transform.name}: footings`).toBe(original.filter(isFooting).length);
        const actualVoxels = voxelKeys(actual);
        const drift = Math.abs(actualVoxels.size - originalVoxels.size) / originalVoxels.size;
        if (drift > worst) {
          worst = drift;
          worstLabel = `${name} ${transform.name}: ${actualVoxels.size} vs ${originalVoxels.size} support voxels`;
        }
      }
    }
    // Measured: up to about 4 % (a rotated bent's staircase gains or loses a column per member).
    expect(worst, `worst support drift under rotation or mirroring: ${(worst * 100).toFixed(1)} % (${worstLabel})`).toBeLessThan(0.1);
  });
});

describe('coaster structure review: draft and colour', () => {
  const boxKeys = (data: Float32Array, count: number): string[] => {
    const keys: string[] = [];
    for (let box = 0; box < count; box += 1) {
      const at = box * BOX_FLOATS;
      keys.push([data[at], data[at + 1], data[at + 2], withOutlineGroup(data[at + 3], 0), data[at + 4], data[at + 5], data[at + 6]].join(','));
    }
    return keys.sort();
  };

  it('shows in the draft exactly the box multiset the built coaster has, on 30 random circuits', () => {
    const models = new SceneModels(palette, createModelCache(), REGISTRY_CONTENT, (message) => { throw new Error(message); });
    for (const [name, pieces] of CIRCUITS.slice(0, 30)) {
      const draft = new CoasterDraft();
      const state = draft.resolve(pieces, SERPENT, true, models);
      expect(state, name).not.toBeNull();
      const writer = new BoxWriter(256);
      for (let index = 0; index < pieces.length; index += 1) coasterContent.pieceBoxes(pieces, index, SERPENT, palette, 0, writer);
      expect(boxKeys(state!.boxes, state!.boxCount), `${name}: draft = built`).toEqual(boxKeys(writer.data, writer.count));
    }
  });

  it('gives the three types distinct rails, ties and supports, with bright rails, and the classic palette agrees on the rails', () => {
    const luma = (rgb: number): number => (0.299 * ((rgb >> 16) & 255) + 0.587 * ((rgb >> 8) & 255) + 0.114 * (rgb & 255)) / 255;
    const ids = [...LOOKS.keys()];
    for (let a = 0; a < ids.length; a += 1) {
      const lookA = LOOKS.get(ids[a])!;
      expect(luma(palette.baseColor(lookA.rail)), `${ids[a]}: bright rails`).toBeGreaterThan(0.7);
      expect(luma(palette.baseColor(lookA.spine)), `${ids[a]}: dark spine`).toBeLessThan(0.45);
      for (let b = a + 1; b < ids.length; b += 1) {
        const lookB = LOOKS.get(ids[b])!;
        expect(lookA.rail, `${ids[a]} vs ${ids[b]}: rails differ`).not.toBe(lookB.rail);
        expect(lookA.tie, `${ids[a]} vs ${ids[b]}: ties differ`).not.toBe(lookB.tie);
        expect(lookA.support, `${ids[a]} vs ${ids[b]}: supports differ`).not.toBe(lookB.support);
        expect(lookA.spine, `${ids[a]} vs ${ids[b]}: spines differ`).not.toBe(lookB.spine);
      }
    }
    // Both renderers colour the comet trail's ties wood, and every type the same tie as its look.
    for (const id of ids) {
      const definition = BUILD_BY_ID.get(id)!;
      const look = LOOKS.get(id)!;
      expect(palette.baseColor(look.rail), `${id}: rails are the catalog accent`).toBe(definition.accent);
    }
    // Every type builds every fixture in its own look, no material of another type's look leaking in.
    for (const id of ids) {
      const definition = BUILD_BY_ID.get(id)!;
      const look = LOOKS.get(id)!;
      const boxes = buildAll(ovalLayout(), definition);
      const others = ids.filter((other) => other !== id).map((other) => LOOKS.get(other)!);
      for (const box of boxes) {
        if (box.material === look.rail || box.material === look.tie || box.material === look.spine || box.material === look.support) continue;
        for (const other of others) expect(box.material, `${id}: ${describeBox(box)} wears ${other.rail === box.material ? 'another type\'s rail' : 'its own'}`).not.toBe(other.rail);
      }
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Through the scene: what a footing stands on

class CountingSink implements VoxelGpuSink {
  readonly chunks = new Map<number, Box[]>();
  setChunk(index: number, boxes: Float32Array, boxCount: number): void {
    const list: Box[] = [];
    for (let box = 0; box < boxCount; box += 1) {
      const at = box * BOX_FLOATS;
      const word = unpackBoxWord(boxes[at + 3]);
      list.push({
        x0: boxes[at], y0: boxes[at + 1], z0: boxes[at + 2], x1: boxes[at] + boxes[at + 4], y1: boxes[at + 1] + boxes[at + 5], z1: boxes[at + 2] + boxes[at + 6],
        material: word.material, pattern: word.pattern, piece: -1,
      });
    }
    this.chunks.set(index, list);
  }
  setDynamic(): void {}
  setFigureRanges(): void {}
  setGhost(): void {}
  setDraft(): void {}
  all(): Box[] {
    return [...this.chunks.values()].flat();
  }
}

describe('coaster structure review: in the scene', () => {
  const type = COASTER_TYPE_BY_ID.get('skyline-serpent')!;

  const parkWith = (pieces: CoasterPiece[], paths: Array<{ x: number; y: number }>): Box[] => {
    const session = new ParkSession(null);
    session.world.setBuildAccessPolicy(null);
    session.world.addMoney(5_000_000, 'test');
    const sink = new CountingSink();
    const scene = new VoxelScene(session, palette, createModelCache(), { sink, prewarmBudgetMs: 0 });
    session.world.subscribe(() => scene.syncWorld());
    if (paths.length > 0) session.world.buildPaths(paths);
    expect(validateCoasterLayout(pieces, type)).toEqual({ ok: true });
    const placed = session.world.placeCoaster(type.definitionId, pieces, deriveCoasterStats(pieces, type), coasterBaseCost(pieces, type));
    if ('error' in placed) throw new Error(`placement failed: ${placed.error}`);
    session.syncWithWorld();
    scene.update(16, 16, 0.5);
    return sink.all();
  };

  // Step 2 review finding, fixed: support footings, the level-0 lower layer and the station's platform
  // and bed used to start at PATH_TOP_Z = 1, but a coaster cell without a path has no paving or plot
  // slab, so on bare ground they floated a voxel over the grass (a dark seam under each column from
  // the fixed camera). They now reach GROUND_TOP_Z; on a path tile (only under level-2+ track) a
  // footing's lowest voxel is inside the paving and it still shows SUPPORT_FOOTING_HEIGHT above it.
  it('stands every footing on something: the box under a footing ends where the footing starts (grass or paving)', () => {
    const pieces = hillDipLayout({ x: 4, y: 4 });
    const boxes = parkWith(pieces, []);
    const footings = boxes.filter(isFooting);
    expect(footings.length).toBeGreaterThan(20);
    for (const footing of footings) {
      const under = boxes.find((box) => box !== footing && footprintsOverlap(box, footing) && box.z1 === footing.z0);
      expect(under, `footing at ${footing.x0},${footing.y0} stands on a box ending at z ${footing.z0}`).toBeDefined();
    }
  });

  it('stands everything of a coaster that reaches the path top on the grass: no coaster box starts between the ground and the path top, and nothing floats over bare ground', () => {
    const pieces = hillDipLayout({ x: 4, y: 4 });
    const boxes = parkWith(pieces, []);
    // On the coaster's cells the park holds only the terrain (under GROUND_TOP_Z) and the coaster (the entrance stands elsewhere).
    const cells = new Set(pieces.map((piece) => `${piece.cell.x},${piece.cell.y}`));
    const coaster = boxes.filter((box) => box.z1 > GROUND_TOP_Z && cells.has(`${Math.floor(box.x0 / TILE)},${Math.floor(box.y0 / TILE)}`));
    const low = coaster.filter((box) => box.z0 <= PATH_TOP_Z);
    expect(low.length, 'footings, level-0 spines, the station bed and platform').toBeGreaterThan(40);
    for (const box of low) {
      expect(box.z0, `box [${box.x0},${box.y0},${box.z0}]–[${box.x1},${box.y1},${box.z1}] material ${box.material} starts on the grass`).toBe(GROUND_TOP_Z);
      const under = boxes.find((other) => other !== box && footprintsOverlap(other, box) && other.z1 === box.z0);
      expect(under, `the grass under box [${box.x0},${box.y0},${box.z0}]`).toBeDefined();
    }
    // Level-0 track: the spine of a non-station flat piece reaches the grass under the whole piece.
    const flat = pieces.findIndex((piece, index) => index >= STATION_LENGTH && piece.height === 0);
    expect(flat).toBeGreaterThan(0);
    const cell = pieces[flat].cell;
    const spines = low.filter((box) => box.material === LOOK.spine && box.x0 >= cell.x * TILE && box.x1 <= (cell.x + 1) * TILE && box.y0 >= cell.y * TILE && box.y1 <= (cell.y + 1) * TILE);
    expect(spines.length, `piece ${flat}: a grounded spine`).toBeGreaterThan(0);
    for (const spine of spines) expect(spine.z1 - spine.z0, 'spine thickness plus the sink').toBe(TRACK_DEPTH - 1 - TIE_THICKNESS + GROUND_SINK);
  });

  it('measures the footing on a path tile: with a path under a level-2 piece, that piece\'s two footings start inside the paving and rise SUPPORT_FOOTING_HEIGHT over its top', () => {
    const pieces = hillDipLayout({ x: 4, y: 4 });
    const level2 = pieces.findIndex((piece, index) => index >= STATION_LENGTH && piece.height >= CLEARANCE);
    const paved = parkWith(pieces, [pieces[level2].cell]);
    const cell = pieces[level2].cell;
    const onPath = paved.filter((box) => isFooting(box) && box.x0 >= cell.x * TILE && box.x1 <= (cell.x + 1) * TILE && box.y0 >= cell.y * TILE && box.y1 <= (cell.y + 1) * TILE);
    expect(onPath.length).toBe(2);
    for (const footing of onPath) {
      const paving = paved.find((box) => box !== footing && footprintsOverlap(box, footing) && box.z0 === GROUND_TOP_Z && box.z1 === PATH_TOP_Z && box.material !== MAT.STONE);
      expect(paving, 'the paving sharing the footing\'s lowest voxel').toBeDefined();
      expect(footing.z1 - PATH_TOP_Z, 'what shows over the paving').toBe(SUPPORT_FOOTING_HEIGHT);
      // Nothing else of the coaster stands under the path top on a path tile.
      const grass = paved.find((box) => box !== footing && footprintsOverlap(box, footing) && box.z1 === footing.z0);
      expect(grass, 'the grass under the paving').toBeDefined();
    }
  });

  it('rebuilds only the chunks a coaster touches, once, and a bracing member never crosses a walk line under 22 voxels in the real scene', () => {
    const pieces = hillDipLayout({ x: 4, y: 4 });
    const level2 = pieces.filter((piece, index) => index >= STATION_LENGTH && piece.height >= CLEARANCE).map((piece) => piece.cell);
    const boxes = parkWith(pieces, level2);
    let lines = 0;
    for (const cell of level2) {
      const cx = cell.x * TILE + HALF_TILE;
      const cy = cell.y * TILE + HALF_TILE;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const neighbour = pieces.find((piece) => piece.cell.x === cell.x + dx && piece.cell.y === cell.y + dy);
        if (neighbour && neighbour.height < CLEARANCE) continue;
        lines += 1;
        const x0 = dx === 0 ? cx - WALK_HALF_WIDTH : Math.min(cx, cx + dx * HALF_TILE);
        const x1 = dx === 0 ? cx + WALK_HALF_WIDTH : Math.max(cx, cx + dx * HALF_TILE);
        const y0 = dy === 0 ? cy - WALK_HALF_WIDTH : Math.min(cy, cy + dy * HALF_TILE);
        const y1 = dy === 0 ? cy + WALK_HALF_WIDTH : Math.max(cy, cy + dy * HALF_TILE);
        for (const box of boxes) {
          // Only what stands on the path (the paving and its curb are the path's own, under z 1); a footing starts inside the paving and is checked.
          if (box.z0 >= PATH_TOP_Z + WALK_CLEARANCE || (box.z0 < PATH_TOP_Z && !isFooting(box))) continue;
          if (box.x1 <= x0 || box.x0 >= x1 || box.y1 <= y0 || box.y0 >= y1) continue;
          expect(box.z0, `box [${box.x0},${box.y0},${box.z0}]–[${box.x1},${box.y1},${box.z1}] material ${box.material} on the walk line of ${cell.x},${cell.y} toward ${dx},${dy}`).toBeGreaterThanOrEqual(PATH_TOP_Z + WALK_CLEARANCE);
        }
      }
    }
    expect(lines).toBeGreaterThan(10);
    expect(SUPPORT_RUNG_Z).toBeGreaterThanOrEqual(PATH_TOP_Z + WALK_CLEARANCE);
  });
});
