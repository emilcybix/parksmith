import { describe, expect, it } from 'vitest';
import { MESH_BOX_STRIDE, meshRuns } from './greedyMesh';
import type { MeshBoxes } from './greedyMesh';
import { countExposedFaces, hollowRuns } from './hollow';
import type { HollowNeighbours } from './hollow';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { contentFor, REGISTERED_CONTENT_IDS } from '../content/registry';
import { buildPalette } from '../palette';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { voxelizeShapes } from './voxelize';
import { runsFromGrid, runVoxelCount, solidRowsOf } from './rowRuns';
import type { RowRuns } from './rowRuns';
import type { VoxelGrid } from './voxelize';

/**
 * Hollowing may only ever remove what no camera can see. These tests render the solid and the
 * hollow mesh with a CPU z-buffer — the three camera-facing faces of every box, the same rule the
 * GPU uses — from every view direction the part can take, and require identical pictures (depth,
 * key and face per sample). They also pin the exact interior definition and the exposed-face count
 * against brute force on seeded random grids.
 */

/** A deterministic stream of numbers in [0, 1), so failures reproduce. */
const randomStream = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
};

const gridOf = (sizeX: number, sizeY: number, sizeZ: number, cell: (x: number, y: number, z: number) => number): VoxelGrid => {
  const material = new Uint8Array(sizeX * sizeY * sizeZ);
  const pattern = new Uint8Array(sizeX * sizeY * sizeZ);
  for (let z = 0; z < sizeZ; z += 1) {
    for (let y = 0; y < sizeY; y += 1) {
      for (let x = 0; x < sizeX; x += 1) {
        const value = cell(x, y, z);
        material[(z * sizeY + y) * sizeX + x] = value;
        pattern[(z * sizeY + y) * sizeX + x] = value === 0 ? 0 : value % 4;
      }
    }
  }
  return {
    originX: 3,
    originY: -2,
    originZ: 1,
    sizeX,
    sizeY,
    sizeZ,
    material,
    pattern,
    rowMinX: new Int32Array(sizeY * sizeZ),
    rowMaxX: new Int32Array(sizeY * sizeZ).fill(sizeX),
  };
};

/** Blobby solids (a few overlapping boxes and balls with holes), so interiors exist. */
const randomSolid = (random: () => number): VoxelGrid => {
  const sizeX = 4 + Math.floor(random() * 14);
  const sizeY = 4 + Math.floor(random() * 14);
  const sizeZ = 3 + Math.floor(random() * 12);
  const blobs = Array.from({ length: 1 + Math.floor(random() * 4) }, () => ({
    x: random() * sizeX,
    y: random() * sizeY,
    z: random() * sizeZ,
    radius: 1.5 + random() * 7,
    round: random() < 0.5,
    material: 1 + Math.floor(random() * 5),
  }));
  const holes = random() * 0.08;
  return gridOf(sizeX, sizeY, sizeZ, (x, y, z) => {
    let material = 0;
    for (const blob of blobs) {
      const dx = x + 0.5 - blob.x;
      const dy = y + 0.5 - blob.y;
      const dz = z + 0.5 - blob.z;
      const inside = blob.round ? dx * dx + dy * dy + dz * dz <= blob.radius ** 2 : Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) <= blob.radius;
      if (inside) material = blob.material;
    }
    const hash = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43_758.5453;
    return hash - Math.floor(hash) < holes ? 0 : material;
  });
};

const filled = (runs: RowRuns): Set<string> => {
  const set = new Set<string>();
  for (let row = 0; row < runs.sizeY * runs.sizeZ; row += 1) {
    for (let run = runs.rowStart[row]; run < runs.rowStart[row + 1]; run += 1) {
      for (let x = runs.runStart[run]; x < runs.runEnd[run]; x += 1) set.add(`${x},${row % runs.sizeY},${Math.floor(row / runs.sizeY)}`);
    }
  }
  return set;
};

type Signs = readonly [number, number, number];

interface Picture {
  depth: Float64Array;
  key: Int32Array;
  face: Int8Array;
}

/**
 * Z-buffer picture of boxes seen from direction `signs` (each ±1: the view comes from +axis or
 * −axis). Mirroring the axes whose sign is −1 turns every view into the renderer's own, which sees
 * the +x, +y and +z faces with the diamond projection. Two samples per texel on each axis sit at
 * quarter offsets, which no projected box edge ever passes through, so the picture has no ties.
 */
const picture = (mesh: MeshBoxes, signs: Signs, window: { minU: number; minV: number; width: number; height: number }): Picture => {
  const scale = 2;
  const width = window.width * scale;
  const height = window.height * scale;
  const depth = new Float64Array(width * height).fill(-Infinity);
  const key = new Int32Array(width * height);
  const face = new Int8Array(width * height).fill(-1);
  for (let box = 0; box < mesh.count; box += 1) {
    const offset = box * MESH_BOX_STRIDE;
    const range = (axis: number): [number, number] => {
      const low = mesh.data[offset + axis];
      const high = mesh.data[offset + 3 + axis];
      return signs[axis] > 0 ? [low, high] : [-high, -low];
    };
    const [x0, x1] = range(0);
    const [y0, y1] = range(1);
    const [z0, z1] = range(2);
    const minU = x0 - y1;
    const maxU = x1 - y0;
    const minV = (x0 + y0) / 2 - z1;
    const maxV = (x1 + y1) / 2 - z0;
    const fromI = Math.max(0, Math.floor((minU - window.minU) * scale));
    const toI = Math.min(width, Math.ceil((maxU - window.minU) * scale));
    const fromJ = Math.max(0, Math.floor((minV - window.minV) * scale));
    const toJ = Math.min(height, Math.ceil((maxV - window.minV) * scale));
    for (let j = fromJ; j < toJ; j += 1) {
      const v = window.minV + (j + 0.5) / scale;
      for (let i = fromI; i < toI; i += 1) {
        const u = window.minU + (i + 0.5) / scale;
        let bestDepth = -Infinity;
        let bestFace = -1;
        // Top face at z1.
        const topX = (2 * (v + z1) + u) / 2;
        const topY = (2 * (v + z1) - u) / 2;
        if (topX >= x0 && topX < x1 && topY >= y0 && topY < y1) {
          bestDepth = topX + topY + z1;
          bestFace = 0;
        }
        // +x face at x1.
        const sideY = x1 - u;
        const sideZ = (x1 + sideY) / 2 - v;
        if (sideY >= y0 && sideY < y1 && sideZ >= z0 && sideZ < z1 && x1 + sideY + sideZ > bestDepth) {
          bestDepth = x1 + sideY + sideZ;
          bestFace = 1;
        }
        // +y face at y1.
        const frontX = u + y1;
        const frontZ = (frontX + y1) / 2 - v;
        if (frontX >= x0 && frontX < x1 && frontZ >= z0 && frontZ < z1 && frontX + y1 + frontZ > bestDepth) {
          bestDepth = frontX + y1 + frontZ;
          bestFace = 2;
        }
        const index = j * width + i;
        if (bestFace >= 0 && bestDepth > depth[index]) {
          depth[index] = bestDepth;
          key[index] = mesh.data[offset + 6];
          face[index] = bestFace;
        }
      }
    }
  }
  return { depth, key, face };
};

/** The projected window of a mesh seen from `signs`, one texel of margin (the hollow mesh fits inside the solid's). */
const windowOf = (mesh: MeshBoxes, signs: Signs): { minU: number; minV: number; width: number; height: number } => {
  let minU = Infinity;
  let maxU = -Infinity;
  let minV = Infinity;
  let maxV = -Infinity;
  for (let box = 0; box < mesh.count; box += 1) {
    const offset = box * MESH_BOX_STRIDE;
    const [x0, x1, y0, y1, z0, z1] = [0, 1, 2].flatMap((axis) => {
      const low = mesh.data[offset + axis];
      const high = mesh.data[offset + 3 + axis];
      return signs[axis] > 0 ? [low, high] : [-high, -low];
    });
    minU = Math.min(minU, x0 - y1);
    maxU = Math.max(maxU, x1 - y0);
    minV = Math.min(minV, (x0 + y0) / 2 - z1);
    maxV = Math.max(maxV, (x1 + y1) / 2 - z0);
  }
  return { minU: Math.floor(minU) - 1, minV: Math.floor(minV) - 1, width: Math.ceil(maxU - minU) + 3, height: Math.ceil(maxV - minV) + 3 };
};

/** Directions a part is seen from: from above only for 5 neighbours, from everywhere for 6. */
const viewsFor = (neighbours: HollowNeighbours): Signs[] => {
  const views: Signs[] = [];
  for (const sz of neighbours === 5 ? [1] : [1, -1]) for (const sx of [1, -1]) for (const sy of [1, -1]) views.push([sx, sy, sz]);
  return views;
};

const firstDifference = (a: Picture, b: Picture): number => {
  for (let index = 0; index < a.depth.length; index += 1) {
    if (a.depth[index] !== b.depth[index] || a.key[index] !== b.key[index] || a.face[index] !== b.face[index]) return index;
  }
  return -1;
};

describe('exposed faces', () => {
  it('counts every +x, +y and +z voxel face whose neighbour is empty', () => {
    const random = randomStream(31);
    for (let sample = 0; sample < 80; sample += 1) {
      const grid = randomSolid(random);
      const runs = runsFromGrid(grid);
      const set = filled(runs);
      let expected = 0;
      for (const voxel of set) {
        const [x, y, z] = voxel.split(',').map(Number);
        for (const [dx, dy, dz] of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) if (!set.has(`${x + dx},${y + dy},${z + dz}`)) expected += 1;
      }
      expect(countExposedFaces(solidRowsOf(runs)).total, `sample ${sample}`).toBe(expected);
    }
  });

  it('matches a solid block exactly: one face per surface voxel and side', () => {
    const exposed = countExposedFaces(solidRowsOf(runsFromGrid(gridOf(5, 4, 3, () => 1))));
    expect([exposed.x, exposed.y, exposed.z, exposed.total]).toEqual([12, 15, 20, 47]);
  });
});

describe('hollowing', () => {
  it.each([5, 6] as HollowNeighbours[])('removes exactly the voxels whose %i neighbours are all solid', (neighbours) => {
    const random = randomStream(100 + neighbours);
    const directions = [[-1, 0, 0], [1, 0, 0], [0, -1, 0], [0, 1, 0], [0, 0, 1], ...(neighbours === 6 ? [[0, 0, -1]] : [])];
    for (let sample = 0; sample < 80; sample += 1) {
      const runs = runsFromGrid(randomSolid(random));
      const set = filled(runs);
      const expected = new Set([...set].filter((voxel) => {
        const [x, y, z] = voxel.split(',').map(Number);
        return !directions.every(([dx, dy, dz]) => set.has(`${x + dx},${y + dy},${z + dz}`));
      }));
      const hollow = hollowRuns(runs, solidRowsOf(runs), neighbours);
      const kept = filled(hollow);
      expect(kept, `sample ${sample}`).toEqual(expected);
      // The exposed +x/+y/+z faces of the solid are all still there, facing the same empty voxel;
      // the only new ones face a removed voxel (the sealed cavity no view can enter).
      const exposedFaces = (voxels: Set<string>): Set<string> => {
        const faces = new Set<string>();
        for (const voxel of voxels) {
          const [x, y, z] = voxel.split(',').map(Number);
          for (const [axis, dx, dy, dz] of [['x', 1, 0, 0], ['y', 0, 1, 0], ['z', 0, 0, 1]] as const) {
            if (!voxels.has(`${x + dx},${y + dy},${z + dz}`)) faces.add(`${voxel}+${axis}`);
          }
        }
        return faces;
      };
      const solidFaces = exposedFaces(set);
      const hollowFaces = exposedFaces(kept);
      const lost = [...solidFaces].filter((face) => !hollowFaces.has(face));
      const cavityOnly = [...hollowFaces].filter((face) => !solidFaces.has(face)).every((face) => {
        const [voxel, axis] = face.split('+');
        const [x, y, z] = voxel.split(',').map(Number);
        const neighbour = axis === 'x' ? `${x + 1},${y},${z}` : axis === 'y' ? `${x},${y + 1},${z}` : `${x},${y},${z + 1}`;
        return set.has(neighbour) && !kept.has(neighbour);
      });
      expect(lost, `sample ${sample}: no camera-facing surface face is lost`).toEqual([]);
      expect(cavityOnly, `sample ${sample}: new faces only face removed voxels`).toBe(true);
    }
  });

  it('turns a solid block into a shell open at the bottom (5) or closed (6)', () => {
    const runs = runsFromGrid(gridOf(10, 10, 10, () => 2));
    expect(runVoxelCount(hollowRuns(runs, solidRowsOf(runs), 5))).toBe(1000 - 8 * 8 * 9);
    expect(runVoxelCount(hollowRuns(runs, solidRowsOf(runs), 6))).toBe(1000 - 8 * 8 * 8);
  });

  it.each([5, 6] as HollowNeighbours[])('keeps the picture identical from every view a part with %i-neighbour hollowing can take', (neighbours) => {
    const random = randomStream(900 + neighbours);
    let hollowedSomething = 0;
    for (let sample = 0; sample < 60; sample += 1) {
      const grid = randomSolid(random);
      const runs = runsFromGrid(grid);
      const hollow = hollowRuns(runs, solidRowsOf(runs), neighbours);
      if (hollow.count !== runs.count || runVoxelCount(hollow) < runVoxelCount(runs)) hollowedSomething += 1;
      const solidMesh = meshRuns(runs);
      const hollowMesh = meshRuns(hollow);
      for (const signs of viewsFor(neighbours)) {
        const window = windowOf(solidMesh, signs);
        const solidPicture = picture(solidMesh, signs, window);
        const hollowPicture = picture(hollowMesh, signs, window);
        expect(firstDifference(solidPicture, hollowPicture), `sample ${sample} view ${signs.join(',')}`).toBe(-1);
      }
    }
    expect(hollowedSomething, 'the random solids actually had interiors to remove').toBeGreaterThan(30);
  });

  it('shows the difference when a view outside the neighbour set sees in: 5-neighbour shells are open below', () => {
    const runs = runsFromGrid(gridOf(10, 10, 10, () => 2));
    const solidMesh = meshRuns(runs);
    const openBelow = meshRuns(hollowRuns(runs, solidRowsOf(runs), 5));
    const fromBelow: Signs = [1, 1, -1];
    const window = windowOf(solidMesh, fromBelow);
    expect(firstDifference(picture(solidMesh, fromBelow, window), picture(openBelow, fromBelow, window)), 'the picture test can fail').not.toBe(-1);
    const closed = meshRuns(hollowRuns(runs, solidRowsOf(runs), 6));
    expect(firstDifference(picture(solidMesh, fromBelow, window), picture(closed, fromBelow, window))).toBe(-1);
  });
});

describe('hollowing in the four view directions of the rotated map (Phase 26)', () => {
  // A view turn keeps the data in world voxels and looks at it along another diagonal: the camera then sees
  // +x/+y, -x/+y, -x/-y or +x/-y faces (always from above). The 5-neighbour set (-x, +x, -y, +y, +z) is exactly
  // what those four views can enter through, and the 6-neighbour set of moving parts also covers every tilt.
  const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);

  it('every catalog model keeps the same first surface in each of the four views after hollowing (static body: 5, moving parts: 6)', () => {
    let parts = 0;
    for (const id of REGISTERED_CONTENT_IDS) {
      const definition = BUILD_BY_ID.get(id);
      if (!definition) continue;
      const blueprint = contentFor(id).blueprint(definition, palette);
      blueprint.parts.forEach((part, index) => {
        const grid = voxelizeShapes(part.shapes, blueprint.floorZ ?? 1, `${id}/${part.id}`);
        const runs = runsFromGrid(grid);
        if (runs.count === 0) return;
        const neighbours: HollowNeighbours = index === 0 ? 5 : 6;
        const solidMesh = meshRuns(runs);
        const hollowMesh = meshRuns(hollowRuns(runs, solidRowsOf(runs), neighbours));
        for (const signs of viewsFor(5)) {
          const window = windowOf(solidMesh, signs);
          expect(firstDifference(picture(solidMesh, signs, window), picture(hollowMesh, signs, window)), `${id}/${part.id} view ${signs.join(',')}`).toBe(-1);
        }
        parts += 1;
      });
    }
    expect(parts, 'the catalog content was checked').toBeGreaterThan(20);
  });
});
