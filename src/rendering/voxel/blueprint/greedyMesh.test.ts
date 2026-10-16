import { describe, expect, it } from 'vitest';
import { MESH_BOX_STRIDE, meshRuns, rasterArea } from './greedyMesh';
import type { MeshBoxes } from './greedyMesh';
import { materialOfKey, patternOfKey, runKeyOf, runsFromGrid, runVoxelCount, solidRowsOf } from './rowRuns';
import type { RowRuns } from './rowRuns';
import type { VoxelGrid } from './voxelize';

/**
 * The mesher's promise is exact: boxes are pairwise disjoint, their union is the voxel set, and
 * every box has one (material, pattern). Seeded random grids of every density hold it to that; a
 * few hand-built grids pin how rows and layers merge.
 */

/** A deterministic stream of numbers in [0, 1), so failures reproduce. */
const randomStream = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
};

/** A dense grid from a per-voxel function returning [material, pattern] (0 material = empty). */
const gridOf = (
  size: readonly [number, number, number],
  origin: readonly [number, number, number],
  cell: (x: number, y: number, z: number) => readonly [number, number],
): VoxelGrid => {
  const [sizeX, sizeY, sizeZ] = size;
  const material = new Uint8Array(sizeX * sizeY * sizeZ);
  const pattern = new Uint8Array(sizeX * sizeY * sizeZ);
  for (let z = 0; z < sizeZ; z += 1) {
    for (let y = 0; y < sizeY; y += 1) {
      for (let x = 0; x < sizeX; x += 1) {
        const [filled, shade] = cell(x, y, z);
        const index = (z * sizeY + y) * sizeX + x;
        material[index] = filled;
        pattern[index] = filled === 0 ? 0 : shade;
      }
    }
  }
  return {
    originX: origin[0],
    originY: origin[1],
    originZ: origin[2],
    sizeX,
    sizeY,
    sizeZ,
    material,
    pattern,
    rowMinX: new Int32Array(sizeY * sizeZ),
    rowMaxX: new Int32Array(sizeY * sizeZ).fill(sizeX),
  };
};

/** Random grid: `density` of voxels filled with one of `keys` (material, pattern) pairs. */
const randomGrid = (random: () => number, density: number, keys: number): VoxelGrid => {
  const size: [number, number, number] = [1 + Math.floor(random() * 14), 1 + Math.floor(random() * 14), 1 + Math.floor(random() * 10)];
  const origin: [number, number, number] = [Math.floor(random() * 40) - 20, Math.floor(random() * 40) - 20, Math.floor(random() * 10)];
  // Blocky fields merge more: pick the key per 2×2×2 cell half of the time.
  const blocky = random() < 0.5;
  const seedOf = (x: number, y: number, z: number): number => (blocky ? ((x >> 1) * 73_856_093) ^ ((y >> 1) * 19_349_663) ^ ((z >> 1) * 83_492_791) : x * 31 + y * 17 + z * 7);
  const salt = Math.floor(random() * 1_000_000);
  return gridOf(size, origin, (x, y, z) => {
    const hash = randomStream(seedOf(x, y, z) + salt);
    hash();
    if (hash() >= density) return [0, 0];
    const key = Math.floor(hash() * keys);
    return [1 + (key % 3), key < 3 ? 0 : 8 + key];
  });
};

const voxelKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** Every filled voxel of a grid → its run key. */
const gridVoxels = (grid: VoxelGrid): Map<string, number> => {
  const voxels = new Map<string, number>();
  for (let z = 0; z < grid.sizeZ; z += 1) {
    for (let y = 0; y < grid.sizeY; y += 1) {
      for (let x = 0; x < grid.sizeX; x += 1) {
        const index = (z * grid.sizeY + y) * grid.sizeX + x;
        if (grid.material[index] !== 0) voxels.set(voxelKey(grid.originX + x, grid.originY + y, grid.originZ + z), runKeyOf(grid.material[index], grid.pattern[index]));
      }
    }
  }
  return voxels;
};

/** Every voxel the boxes cover → key; throws on the first voxel covered twice. */
const meshVoxels = (mesh: MeshBoxes): Map<string, number> => {
  const voxels = new Map<string, number>();
  for (let box = 0; box < mesh.count; box += 1) {
    const offset = box * MESH_BOX_STRIDE;
    const [minX, minY, minZ, maxX, maxY, maxZ, key] = mesh.data.subarray(offset, offset + MESH_BOX_STRIDE);
    expect(maxX > minX && maxY > minY && maxZ > minZ, `box ${box} is not empty`).toBe(true);
    for (let z = minZ; z < maxZ; z += 1) {
      for (let y = minY; y < maxY; y += 1) {
        for (let x = minX; x < maxX; x += 1) {
          const at = voxelKey(x, y, z);
          if (voxels.has(at)) throw new Error(`voxel ${at} is covered twice`);
          voxels.set(at, key);
        }
      }
    }
  }
  return voxels;
};

const runsAreMaximal = (runs: RowRuns): boolean => {
  for (let row = 0; row < runs.sizeY * runs.sizeZ; row += 1) {
    for (let run = runs.rowStart[row] + 1; run < runs.rowStart[row + 1]; run += 1) {
      const touching = runs.runEnd[run - 1] === runs.runStart[run];
      if (runs.runEnd[run - 1] > runs.runStart[run] || (touching && runs.runKey[run - 1] === runs.runKey[run])) return false;
    }
  }
  return true;
};

describe('row runs', () => {
  it('encode exactly the filled voxels as maximal runs of one key, and merge touching runs into solid intervals', () => {
    const random = randomStream(7);
    for (let sample = 0; sample < 150; sample += 1) {
      const grid = randomGrid(random, random(), 1 + Math.floor(random() * 5));
      const runs = runsFromGrid(grid);
      expect(runsAreMaximal(runs), `sample ${sample}: runs are sorted, disjoint and maximal`).toBe(true);
      const fromRuns = new Map<string, number>();
      for (let row = 0; row < runs.sizeY * runs.sizeZ; row += 1) {
        const y = runs.originY + (row % runs.sizeY);
        const z = runs.originZ + Math.floor(row / runs.sizeY);
        for (let run = runs.rowStart[row]; run < runs.rowStart[row + 1]; run += 1) {
          for (let x = runs.runStart[run]; x < runs.runEnd[run]; x += 1) fromRuns.set(voxelKey(runs.originX + x, y, z), runs.runKey[run]);
        }
      }
      expect(fromRuns, `sample ${sample}`).toEqual(gridVoxels(grid));
      expect(runVoxelCount(runs)).toBe(fromRuns.size);
      const solid = solidRowsOf(runs);
      let solidVoxels = 0;
      for (let row = 0; row < solid.sizeY * solid.sizeZ; row += 1) {
        for (let interval = solid.rowStart[row]; interval < solid.rowStart[row + 1]; interval += 1) {
          solidVoxels += solid.end[interval] - solid.start[interval];
          if (interval > solid.rowStart[row]) expect(solid.start[interval], 'solid intervals never touch').toBeGreaterThan(solid.end[interval - 1]);
        }
      }
      expect(solidVoxels).toBe(fromRuns.size);
    }
  });

  it('packs material and pattern into one key and back', () => {
    expect(runKeyOf(255, 31)).toBe(255 + 31 * 256);
    expect([materialOfKey(runKeyOf(17, 9)), patternOfKey(runKeyOf(17, 9))]).toEqual([17, 9]);
  });
});

describe('greedy mesh', () => {
  it('covers every voxel exactly once with a box of its own key, on seeded random grids', () => {
    const random = randomStream(2024);
    for (let sample = 0; sample < 300; sample += 1) {
      const grid = randomGrid(random, sample % 10 === 0 ? 1 : random(), 1 + Math.floor(random() * 6));
      const runs = runsFromGrid(grid);
      const mesh = meshRuns(runs);
      expect(meshVoxels(mesh), `sample ${sample}: union of boxes == voxel set, keys equal`).toEqual(gridVoxels(grid));
      expect(mesh.count, `sample ${sample}: never more boxes than runs`).toBeLessThanOrEqual(runs.count);
    }
  });

  it('merges a uniform block into one box and equal layers into one box', () => {
    const block = meshRuns(runsFromGrid(gridOf([7, 5, 4], [10, 20, 1], () => [3, 2])));
    expect(block.count).toBe(1);
    expect(Array.from(block.data.subarray(0, MESH_BOX_STRIDE))).toEqual([10, 20, 1, 17, 25, 5, runKeyOf(3, 2)]);
    // A disc repeated on four layers: one box per distinct row span, each 4 layers tall.
    const disc = (x: number, y: number): boolean => (x - 5.5) ** 2 + (y - 5.5) ** 2 <= 25;
    const cylinder = meshRuns(runsFromGrid(gridOf([12, 12, 4], [0, 0, 0], (x, y) => (disc(x, y) ? [1, 0] : [0, 0]))));
    const layer = meshRuns(runsFromGrid(gridOf([12, 12, 1], [0, 0, 0], (x, y) => (disc(x, y) ? [1, 0] : [0, 0]))));
    expect(cylinder.count).toBe(layer.count);
    for (let box = 0; box < cylinder.count; box += 1) expect(cylinder.data[box * MESH_BOX_STRIDE + 5] - cylinder.data[box * MESH_BOX_STRIDE + 2]).toBe(4);
  });

  it('merges only exactly equal rows and rectangles, and never across a key change', () => {
    // Rows [0, 4) then [0, 5): not equal, two boxes.
    const widening = meshRuns(runsFromGrid(gridOf([5, 2, 1], [0, 0, 0], (x, y) => (x < 4 + y ? [1, 0] : [0, 0]))));
    expect(widening.count).toBe(2);
    // The same block with a pattern change halfway along x: two boxes.
    const patterned = meshRuns(runsFromGrid(gridOf([6, 3, 3], [0, 0, 0], (x) => [5, x < 3 ? 1 : 2])));
    expect(patterned.count).toBe(2);
    // A 3D checkerboard cannot merge at all.
    const checker = meshRuns(runsFromGrid(gridOf([4, 4, 4], [0, 0, 0], (x, y, z) => ((x + y + z) % 2 === 0 ? [1, 0] : [2, 0]))));
    expect(checker.count).toBe(64);
    const empty = meshRuns(runsFromGrid(gridOf([3, 3, 3], [0, 0, 0], () => [0, 0])));
    expect(empty.count).toBe(0);
  });

  it('measures rasterised area as the three camera-facing faces of every box', () => {
    const mesh = meshRuns(runsFromGrid(gridOf([6, 3, 3], [0, 0, 0], (x) => [5, x < 2 ? 1 : 2])));
    // Boxes 2×3×3 and 4×3×3.
    expect(rasterArea(mesh)).toBe((2 * 3 + 3 * 3 + 3 * 2) + (4 * 3 + 3 * 3 + 3 * 4));
  });
});
