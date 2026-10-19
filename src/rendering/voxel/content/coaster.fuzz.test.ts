import { describe, expect, it } from 'vitest';
import { centreLineFor, createCentreLineSample, sampleCentreLine } from '../../../game/coaster/centreLine';
import type { CoasterPiece } from '../../../game/coaster/design';
import { randomCircuit } from '../../../game/coaster/testLayouts';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { BOX_FLOATS, BoxWriter, unpackBoxWord } from '../contracts/boxes';
import { MAT } from '../contracts/palette';
import { GROUND_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';
import { buildPalette } from '../palette';
import { coasterRailTopZ } from '../scene/coasterCars';
import { coasterContent, coasterLook, GROUND_SINK, SUPPORT_FOOTING_TOP, SUPPORT_FOOTING_Z, TIE_THICKNESS } from './coaster';

/**
 * Property tests on random closed circuits (any piece mix: hairpins, S-bends, loops next to corners,
 * hills 0 to 4 under corners): the track has a spine under its own centre line at the line's height,
 * nothing overlaps, every box stays in its tile (a loop ring may overhang), and every support box
 * stands on the ground or touches another support box.
 */
const TILE = VOXELS_PER_TILE;
const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const definition = BUILD_BY_ID.get('skyline-serpent')!;
const look = coasterLook(definition, palette, { rail: 0, tie: 0, spine: 0, support: 0 });

const circuits = (): Array<[string, CoasterPiece[]]> => {
  const list: Array<[string, CoasterPiece[]]> = [];
  for (let seed = 1; list.length < 40 && seed < 6000; seed += 1) {
    const target = 4 + 2 * (seed % 20);
    const layout = randomCircuit(seed, target, 4 + (seed % 6));
    // A valid coaster has a straight station (its first three pieces on one line).
    const straight = layout !== null && layout[1].cell.x - layout[0].cell.x === layout[2].cell.x - layout[1].cell.x
      && layout[1].cell.y - layout[0].cell.y === layout[2].cell.y - layout[1].cell.y;
    if (layout && straight) list.push([`seed ${seed} (${target} pieces)`, layout]);
  }
  return list;
};

interface Box { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number; material: number; piece: number }

const readAll = (writer: BoxWriter, owner: readonly number[]): Box[] => {
  const boxes: Box[] = [];
  for (let box = 0; box < writer.count; box += 1) {
    const at = box * BOX_FLOATS;
    const d = writer.data;
    boxes.push({ x0: d[at], y0: d[at + 1], z0: d[at + 2], x1: d[at] + d[at + 4], y1: d[at + 1] + d[at + 5], z1: d[at + 2] + d[at + 6], material: unpackBoxWord(d[at + 3]).material, piece: owner[box] });
  }
  return boxes;
};

const touches = (a: Box, b: Box): boolean => {
  const overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const overlapY = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  const overlapZ = Math.min(a.z1, b.z1) - Math.max(a.z0, b.z0);
  return (overlapX > 0 && overlapY > 0 && overlapZ === 0) || (overlapX > 0 && overlapZ > 0 && overlapY === 0) || (overlapY > 0 && overlapZ > 0 && overlapX === 0);
};

describe('coaster track: random circuits', () => {
  it('puts a spine under the whole centre line, never overlaps itself, keeps boxes in their tiles and never floats a support', () => {
    const all = circuits();
    expect(all.length).toBeGreaterThan(30);
    const sample = createCentreLineSample();
    const ringMaterials = new Set<number>([look.rail, look.tie, look.spine]);
    for (const [name, pieces] of all) {
      const writer = new BoxWriter(256);
      const owner: number[] = [];
      for (let index = 0; index < pieces.length; index += 1) {
        const from = writer.count;
        coasterContent.pieceBoxes(pieces, index, definition, palette, 1, writer);
        for (let box = from; box < writer.count; box += 1) owner.push(index);
      }
      const boxes = readAll(writer, owner);
      // Occupancy set to find overlaps, and the spine top of every column.
      const occupied = new Map<number, number>();
      const key = (x: number, y: number, z = 0): number => ((x + 64) * 4096 + (y + 64)) * 512 + z;
      boxes.forEach((box, at) => {
        const piece = pieces[box.piece];
        const ring = piece.special === 'loop' && ringMaterials.has(box.material);
        const tile = piece.cell;
        if (!ring) {
          expect(box.x0 >= tile.x * TILE && box.x1 <= (tile.x + 1) * TILE && box.y0 >= tile.y * TILE && box.y1 <= (tile.y + 1) * TILE,
            `${name} piece ${box.piece} box in its tile`).toBe(true);
        }
        for (let x = box.x0; x < box.x1; x += 1) {
          for (let y = box.y0; y < box.y1; y += 1) {
            for (let z = box.z0; z < box.z1; z += 1) {
              const voxel = key(x, y, z);
              const other = occupied.get(voxel);
              if (other !== undefined) {
                throw new Error(`${name}: overlap at ${x},${y},${z}: piece ${box.piece} material ${box.material} vs piece ${boxes[other].piece} material ${boxes[other].material} cells ${JSON.stringify(pieces.map((q) => [q.cell.x, q.cell.y, q.height, q.special ?? '']))}`);
              }
              occupied.set(voxel, at);
            }
          }
        }
      });
      // The spine of the plain track: the same layout without specials (a loop's ring is built over it).
      const plain = pieces.map((piece): CoasterPiece => ({ cell: piece.cell, height: piece.height }));
      const plainWriter = new BoxWriter(256);
      const plainOwner: number[] = [];
      for (let index = 0; index < plain.length; index += 1) {
        const from = plainWriter.count;
        coasterContent.pieceBoxes(plain, index, definition, palette, 1, plainWriter);
        for (let box = from; box < plainWriter.count; box += 1) plainOwner.push(index);
      }
      const top = new Map<number, number>();
      for (const box of readAll(plainWriter, plainOwner)) {
        // The bed is 2 thick, 3 where it stands on the grass (a footing is STONE too, 2 thick from the grass).
        const stationBed = box.material === MAT.STONE && box.z1 - box.z0 === 2 + (box.z0 === GROUND_TOP_Z ? GROUND_SINK : 0);
        if (box.material !== look.spine && !stationBed) continue;
        for (let x = box.x0; x < box.x1; x += 1) {
          for (let y = box.y0; y < box.y1; y += 1) {
            const column = key(x, y);
            top.set(column, Math.max(top.get(column) ?? 0, box.z1 + TIE_THICKNESS + 1));
          }
        }
      }
      // Under the line: a spine column whose rail top is the line's height to within two voxels.
      const line = centreLineFor(pieces);
      let holes = 0;
      let worst = 0;
      const holePieces = new Set<number>();
      for (let distance = 0; distance < line.totalLength; distance += 0.01) {
        // The plain layout has no loops, so its spine is under the line without Phase 48's loop step.
        sampleCentreLine(line, distance, sample, false);
        if (sample.ringAngle > 0) continue;
        const surface = top.get(key(Math.floor(sample.x * TILE), Math.floor(sample.y * TILE)));
        if (surface === undefined) { holes += 1; holePieces.add(sample.piece); continue; }
        worst = Math.max(worst, Math.abs(surface - coasterRailTopZ(sample.z)));
      }
      expect(holes, `${name}: columns without a spine under the centre line (pieces ${[...holePieces]})`).toBe(0);
      expect(worst, `${name}: rail top vs the line's height (voxels)`).toBeLessThanOrEqual(2.5);
      // Supports: footings on the grass, everything else touching another support box.
      const supports = boxes.filter((box) => (box.material === look.support && pieces[box.piece].height > 0)
        || (box.material === MAT.STONE && box.z0 === SUPPORT_FOOTING_Z && box.z1 === SUPPORT_FOOTING_TOP));
      for (const support of supports) {
        const attached = support.z0 === SUPPORT_FOOTING_Z || supports.some((other) => other !== support && other.piece === support.piece && touches(support, other));
        expect(attached, `${name}: support box of piece ${support.piece} at ${support.x0},${support.y0},${support.z0} floats`).toBe(true);
      }
    }
  });
});
