import { RunBuilder } from './rowRuns';
import type { RowRuns, SolidRows } from './rowRuns';

/**
 * Hollowing (compile stage 3): removing voxels no camera ray can ever reach.
 *
 * The renderer draws each box's three camera-facing faces and lets the depth test sort them out,
 * so a mesh that tiles a solid's whole volume rasterises every hidden layer too. On tile-based and
 * early-Z GPUs that is most of an object's fragment cost (critique: a solid tree rasterises 10× its
 * visible surface).
 *
 * Why removal is exact: a ray travelling away from the camera enters a voxel only through a face
 * whose normal points back at the camera. Call N the set of such face directions over every view
 * the part can be seen from. Remove every voxel whose neighbours across all of N are solid in the
 * ORIGINAL grid. A ray that reached a removed voxel would have to come through an N face, out of a
 * neighbour that was solid. If that neighbour was kept, the ray stops there. If it was removed too,
 * repeat the argument for the first removed voxel on the ray. Either way no ray reaches a removed
 * voxel, and the first surface every ray hits, which is the whole image, is unchanged.
 *
 * The camera looks along −(1, 1, 1) and never from below, so +z is always in N.
 * - Static bodies, shown at quarter turn 0 or 1, see model +x, −x (after a turn), +y and +z. The
 *   design uses the 5-neighbour set ±x, ±y, +z for them, a little conservative on −y.
 * - Parts spinning about z also see ±x, ±y and +z.
 * - Parts that may tip about x or y can show their underside, so they need all 6 neighbours.
 */
export type HollowNeighbours = 5 | 6;

export interface ExposedFaces {
  /** Voxel faces whose +x, +y or +z neighbour is empty: the camera-facing surface. */
  readonly x: number;
  readonly y: number;
  readonly z: number;
  readonly total: number;
}

/** Length of the overlap of row `a` of `solid` with row `b` (two sorted, disjoint interval lists). */
const overlapLength = (solid: SolidRows, rowA: number, rowB: number): number => {
  let a = solid.rowStart[rowA];
  const aEnd = solid.rowStart[rowA + 1];
  let b = solid.rowStart[rowB];
  const bEnd = solid.rowStart[rowB + 1];
  let length = 0;
  while (a < aEnd && b < bEnd) {
    const from = Math.max(solid.start[a], solid.start[b]);
    const to = Math.min(solid.end[a], solid.end[b]);
    if (from < to) length += to - from;
    if (solid.end[a] < solid.end[b]) a += 1;
    else b += 1;
  }
  return length;
};

/**
 * Exposed +x/+y/+z faces of a solid, which is what a perfect mesh would rasterise at one texel per
 * voxel. The same count holds after a quarter turn, because a solid has exactly as many −x faces as
 * +x faces (one of each per solid interval).
 */
export const countExposedFaces = (solid: SolidRows): ExposedFaces => {
  const { sizeY, sizeZ } = solid;
  const x = solid.count;
  let y = 0;
  let z = 0;
  for (let layer = 0; layer < sizeZ; layer += 1) {
    for (let line = 0; line < sizeY; line += 1) {
      const row = layer * sizeY + line;
      let filled = 0;
      for (let interval = solid.rowStart[row]; interval < solid.rowStart[row + 1]; interval += 1) {
        filled += solid.end[interval] - solid.start[interval];
      }
      if (filled === 0) continue;
      y += filled - (line + 1 < sizeY ? overlapLength(solid, row, row + 1) : 0);
      z += filled - (layer + 1 < sizeZ ? overlapLength(solid, row, row + sizeY) : 0);
    }
  }
  return { x, y, z, total: x + y + z };
};

/** Intersects `count` scratch intervals with row `row` of `solid`, writing into `outStart/outEnd`. */
const intersectWithRow = (
  inStart: Int32Array,
  inEnd: Int32Array,
  count: number,
  solid: SolidRows,
  row: number,
  outStart: Int32Array,
  outEnd: Int32Array,
): number => {
  let a = 0;
  let b = solid.rowStart[row];
  const bEnd = solid.rowStart[row + 1];
  let written = 0;
  while (a < count && b < bEnd) {
    const from = Math.max(inStart[a], solid.start[b]);
    const to = Math.min(inEnd[a], solid.end[b]);
    if (from < to) {
      outStart[written] = from;
      outEnd[written] = to;
      written += 1;
    }
    if (inEnd[a] < solid.end[b]) a += 1;
    else b += 1;
  }
  return written;
};

/**
 * The runs with every interior voxel removed: a voxel is interior when its −x, +x, −y, +y and +z
 * neighbours are all solid (and −z too for `neighbours` 6), judged on the original solid.
 */
export const hollowRuns = (runs: RowRuns, solid: SolidRows, neighbours: HollowNeighbours): RowRuns => {
  const { sizeX, sizeY, sizeZ, rowStart, runStart, runEnd, runKey } = runs;
  const builder = new RunBuilder(runs.originX, runs.originY, runs.originZ, sizeX, sizeY, sizeZ, runs.count * 2);
  // Ping-pong scratch interval lists; a row holds at most ⌈sizeX / 2⌉ solid intervals.
  const capacity = sizeX + 1;
  let aStart = new Int32Array(capacity);
  let aEnd = new Int32Array(capacity);
  let bStart = new Int32Array(capacity);
  let bEnd = new Int32Array(capacity);
  for (let z = 0; z < sizeZ; z += 1) {
    for (let y = 0; y < sizeY; y += 1) {
      const row = z * sizeY + y;
      let interiorCount = 0;
      const canHaveInterior = y > 0 && y + 1 < sizeY && z + 1 < sizeZ && (neighbours === 5 || z > 0);
      if (canHaveInterior) {
        // x − 1 and x + 1 solid: each maximal solid interval [a, b) shrunk to [a + 1, b − 1).
        for (let interval = solid.rowStart[row]; interval < solid.rowStart[row + 1]; interval += 1) {
          const from = solid.start[interval] + 1;
          const to = solid.end[interval] - 1;
          if (from < to) {
            aStart[interiorCount] = from;
            aEnd[interiorCount] = to;
            interiorCount += 1;
          }
        }
        const others = neighbours === 6 ? 4 : 3;
        for (let other = 0; other < others && interiorCount > 0; other += 1) {
          const neighbour = other === 0 ? row - 1 : other === 1 ? row + 1 : other === 2 ? row + sizeY : row - sizeY;
          interiorCount = intersectWithRow(aStart, aEnd, interiorCount, solid, neighbour, bStart, bEnd);
          const swapStart = aStart;
          const swapEnd = aEnd;
          aStart = bStart;
          aEnd = bEnd;
          bStart = swapStart;
          bEnd = swapEnd;
        }
      }
      // Runs minus the interior intervals (both sorted and disjoint).
      let interior = 0;
      for (let run = rowStart[row]; run < rowStart[row + 1]; run += 1) {
        const start = runStart[run];
        const end = runEnd[run];
        const key = runKey[run];
        while (interior < interiorCount && aEnd[interior] <= start) interior += 1;
        let cursor = start;
        let next = interior;
        while (next < interiorCount && aStart[next] < end) {
          if (aStart[next] > cursor) builder.push(cursor, aStart[next], key);
          if (aEnd[next] > cursor) cursor = aEnd[next];
          if (aEnd[next] >= end) break;
          next += 1;
        }
        if (cursor < end) builder.push(cursor, end, key);
        interior = next;
      }
      builder.endRow();
    }
  }
  return builder.finish();
};
