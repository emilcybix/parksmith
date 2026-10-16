import { describe, expect, it } from 'vitest';
import type { Axis, Shape, Vec3 } from '../contracts/blueprint';
import {
  filledVoxelCount,
  materialAt,
  MAX_COORDINATE,
  shapeContains,
  shapeVoxelBounds,
  validateShape,
  voxelizeShapes,
} from './voxelize';
import type { VoxelGrid } from './voxelize';

/**
 * The voxelizer decides what every model looks like at one texel per voxel, so its rule is pinned
 * exactly: voxel (i, j, k) is filled when its centre is inside the shape, the later shape wins, and
 * material 0 and the floor carve. The fast row-span rasteriser is held to that per-voxel rule by
 * brute force over seeded random shapes, and each shape kind to its analytic volume and symmetry.
 */

/** A deterministic stream of numbers in [0, 1), so failures reproduce. */
const randomStream = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
};

const NO_FLOOR = -1_000;

const voxels = (shapes: readonly Shape[], floorZ = NO_FLOOR): VoxelGrid => voxelizeShapes(shapes, floorZ, 'test');

const countOf = (shape: Shape): number => filledVoxelCount(voxels([shape]));

/** Every filled voxel as "x,y,z" (model space). */
const voxelSet = (grid: VoxelGrid): Set<string> => {
  const set = new Set<string>();
  for (let k = 0; k < grid.sizeZ; k += 1) {
    for (let j = 0; j < grid.sizeY; j += 1) {
      for (let i = 0; i < grid.sizeX; i += 1) {
        if (grid.material[(k * grid.sizeY + j) * grid.sizeX + i] !== 0) {
          set.add(`${grid.originX + i},${grid.originY + j},${grid.originZ + k}`);
        }
      }
    }
  }
  return set;
};

const mapped = (set: Set<string>, transform: (x: number, y: number, z: number) => Vec3): Set<string> =>
  new Set([...set].map((key) => transform(...(key.split(',').map(Number) as [number, number, number])).join(',')));

const between = (random: () => number, low: number, high: number): number => low + random() * (high - low);

const AXES: readonly Axis[] = ['x', 'y', 'z'];

/** A random shape of the given kind around the origin region, with fractional parameters. */
const randomShape = (random: () => number, kind: Shape['kind'], material: number): Shape => {
  const point = (): Vec3 => [between(random, -6, 26), between(random, -6, 26), between(random, -4, 22)];
  const axis = AXES[Math.floor(random() * 3)];
  const pattern = Math.floor(random() * 15);
  switch (kind) {
    case 'box':
      return { kind, min: point(), size: [between(random, 0, 14), between(random, 0, 14), between(random, 0, 14)], material, pattern };
    case 'cylinder':
      return { kind, base: point(), radius: between(random, 0, 9), length: between(random, 0, 16), axis, material, pattern };
    case 'cone':
      return { kind, base: point(), radius: between(random, 0, 10), height: between(random, 0.5, 14), topRadius: random() < 0.5 ? 0 : between(random, 0, 10), material, pattern };
    case 'ellipsoid':
      return { kind, center: point(), radii: [between(random, 0, 10), between(random, 0, 10), between(random, 0, 10)], material, pattern };
    case 'gable':
      return { kind, min: point(), size: [between(random, 0, 18), between(random, 0, 18), between(random, 0, 8)], ridge: random() < 0.5 ? 'x' : 'y', material, pattern };
    case 'ring':
      return { kind, center: point(), radius: between(random, 0, 11), thickness: between(random, 0, 5), width: between(random, 0, 6), axis, material, pattern };
    case 'segment':
      return { kind, from: point(), to: point(), radius: between(random, 0, 4), material, pattern };
  }
};

const KINDS: readonly Shape['kind'][] = ['box', 'cylinder', 'cone', 'ellipsoid', 'gable', 'ring', 'segment'];

describe('voxelize: the centre rule, exactly', () => {
  it.each(KINDS)('fills exactly the voxels whose centres a %s contains, all inside its bounds', (kind) => {
    const random = randomStream(KINDS.indexOf(kind) + 11);
    const wrong: string[] = [];
    for (let sample = 0; sample < 60; sample += 1) {
      const shape = randomShape(random, kind, 7);
      const grid = voxels([shape]);
      const bounds = shapeVoxelBounds(shape);
      let inside = 0;
      for (let k = bounds.minZ - 2; k < bounds.maxZ + 2; k += 1) {
        for (let j = bounds.minY - 2; j < bounds.maxY + 2; j += 1) {
          for (let i = bounds.minX - 2; i < bounds.maxX + 2; i += 1) {
            const expected = shapeContains(shape, i + 0.5, j + 0.5, k + 0.5);
            if (expected) {
              inside += 1;
              const inBounds = i >= bounds.minX && i < bounds.maxX && j >= bounds.minY && j < bounds.maxY && k >= bounds.minZ && k < bounds.maxZ;
              if (!inBounds) wrong.push(`sample ${sample}: voxel ${i},${j},${k} is outside the bounds`);
            }
            if ((materialAt(grid, i, j, k) !== 0) !== expected) wrong.push(`sample ${sample}: voxel ${i},${j},${k} should be ${expected ? 'filled' : 'empty'}`);
          }
        }
      }
      if (filledVoxelCount(grid) !== inside) wrong.push(`sample ${sample}: ${filledVoxelCount(grid)} filled, ${inside} inside`);
    }
    expect(wrong.slice(0, 5), `${kind}: ${wrong.length} mismatches`).toEqual([]);
  });

  it('lets the later shape win, carves with material 0 and below the floor, and keeps patterns per shape', () => {
    const random = randomStream(99);
    const wrong: string[] = [];
    for (let sample = 0; sample < 30; sample += 1) {
      const shapes: Shape[] = Array.from({ length: 2 + Math.floor(random() * 3) }, () => {
        const material = random() < 0.25 ? 0 : 1 + Math.floor(random() * 4);
        return randomShape(random, KINDS[Math.floor(random() * KINDS.length)], material);
      });
      const floorZ = random() < 0.5 ? NO_FLOOR : between(random, -2, 12);
      const grid = voxels(shapes, floorZ);
      const region = shapes.map(shapeVoxelBounds).reduce((union, bounds) => ({
        minX: Math.min(union.minX, bounds.minX),
        minY: Math.min(union.minY, bounds.minY),
        minZ: Math.min(union.minZ, bounds.minZ),
        maxX: Math.max(union.maxX, bounds.maxX),
        maxY: Math.max(union.maxY, bounds.maxY),
        maxZ: Math.max(union.maxZ, bounds.maxZ),
      }));
      for (let k = region.minZ - 1; k < region.maxZ + 1; k += 1) {
        for (let j = region.minY - 1; j < region.maxY + 1; j += 1) {
          for (let i = region.minX - 1; i < region.maxX + 1; i += 1) {
            let material = 0;
            let pattern = 0;
            if (k + 0.5 >= floorZ) {
              for (const shape of shapes) {
                if (shapeContains(shape, i + 0.5, j + 0.5, k + 0.5)) {
                  material = shape.material;
                  pattern = shape.material === 0 ? 0 : shape.pattern ?? 0;
                }
              }
            }
            if (materialAt(grid, i, j, k) !== material) wrong.push(`sample ${sample}: material at ${i},${j},${k}`);
            else if (material !== 0) {
              const index = ((k - grid.originZ) * grid.sizeY + (j - grid.originY)) * grid.sizeX + (i - grid.originX);
              if (grid.pattern[index] !== pattern) wrong.push(`sample ${sample}: pattern at ${i},${j},${k}`);
            }
          }
        }
      }
    }
    expect(wrong.slice(0, 5), `${wrong.length} mismatches`).toEqual([]);
  });

  it('records a conservative written x range for every row', () => {
    const random = randomStream(5);
    for (let sample = 0; sample < 30; sample += 1) {
      const grid = voxels([randomShape(random, 'ring', 3), randomShape(random, 'ellipsoid', 4), randomShape(random, 'segment', 0)]);
      for (let row = 0; row < grid.sizeY * grid.sizeZ; row += 1) {
        for (let i = 0; i < grid.sizeX; i += 1) {
          if (grid.material[row * grid.sizeX + i] !== 0) {
            expect(i >= grid.rowMinX[row] && i < grid.rowMaxX[row], `sample ${sample} row ${row} x ${i}`).toBe(true);
          }
        }
      }
    }
  });
});

describe('voxelize: every shape kind', () => {
  it('keeps integer boxes exact and half-open, so abutting boxes never share a voxel', () => {
    const grid = voxels([{ kind: 'box', min: [3, -2, 1], size: [5, 4, 3], material: 9 }]);
    expect(filledVoxelCount(grid)).toBe(60);
    expect([grid.originX, grid.originY, grid.originZ, grid.sizeX, grid.sizeY, grid.sizeZ]).toEqual([3, -2, 1, 5, 4, 3]);
    expect(materialAt(grid, 7, 1, 3)).toBe(9);
    expect(materialAt(grid, 8, 1, 3), 'max x is exclusive').toBe(0);
    const abutting = voxels([
      { kind: 'box', min: [0, 0, 0], size: [4, 4, 4], material: 1 },
      { kind: 'box', min: [4, 0, 0], size: [4, 4, 4], material: 2 },
    ]);
    expect(filledVoxelCount(abutting)).toBe(128);
    expect(materialAt(abutting, 3, 0, 0)).toBe(1);
    expect(materialAt(abutting, 4, 0, 0)).toBe(2);
    // Off-lattice boxes take the voxels whose centres they contain.
    expect(countOf({ kind: 'box', min: [0.6, 0, 0], size: [0.8, 1, 1], material: 1 }), 'no centre in [0.6, 1.4)').toBe(0);
    expect(countOf({ kind: 'box', min: [0.6, 0, 0], size: [1, 1, 1], material: 1 }), 'centre 1.5 in [0.6, 1.6)').toBe(1);
    expect(materialAt(voxels([{ kind: 'box', min: [0.6, 0, 0], size: [1, 1, 1], material: 1 }]), 1, 0, 0)).toBe(1);
  });

  it('fills cylinders to their disc area on every axis, symmetrically about the axis', () => {
    const radius = 12;
    const length = 10;
    const byAxis = AXES.map((axis) => {
      const base: Vec3 = axis === 'x' ? [0, 16, 16] : axis === 'y' ? [16, 0, 16] : [16, 16, 0];
      return voxelSet(voxels([{ kind: 'cylinder', base, radius, length, axis, material: 1 }]));
    });
    const [alongX, alongY, alongZ] = byAxis;
    expect(alongZ.size / (Math.PI * radius * radius * length)).toBeCloseTo(1, 1);
    expect(alongX, 'x cylinder is the z cylinder with x and z swapped').toEqual(mapped(alongZ, (x, y, z) => [z, y, x]));
    expect(alongY, 'y cylinder is the z cylinder with y and z swapped').toEqual(mapped(alongZ, (x, y, z) => [x, z, y]));
    // Centre 16 is a voxel corner: voxel i mirrors to 31 − i.
    expect(mapped(alongZ, (x, y, z) => [31 - x, y, z])).toEqual(alongZ);
    expect(mapped(alongZ, (x, y, z) => [y, x, z])).toEqual(alongZ);
    expect([...alongZ].filter((key) => key.startsWith('15,15,')).length, 'the axis column runs the whole length').toBe(length);
  });

  it('fills cones and frustums to their volume, narrowing layer by layer', () => {
    const cone = voxels([{ kind: 'cone', base: [20, 20, 0], radius: 16, height: 20, topRadius: 4, material: 1 }]);
    const volume = (Math.PI * 20 * (16 * 16 + 16 * 4 + 4 * 4)) / 3;
    expect(filledVoxelCount(cone) / volume).toBeCloseTo(1, 1);
    let previous = Infinity;
    for (let k = 0; k < 20; k += 1) {
      let layer = 0;
      for (let j = 0; j < 40; j += 1) for (let i = 0; i < 40; i += 1) layer += materialAt(cone, i, j, k) !== 0 ? 1 : 0;
      expect(layer, `layer ${k} is no wider than the one below`).toBeLessThanOrEqual(previous);
      previous = layer;
    }
    const set = voxelSet(cone);
    expect(mapped(set, (x, y, z) => [39 - x, 39 - y, z])).toEqual(set);
    // Centred on a voxel centre, a pointed cone keeps a one-voxel tip; on a voxel corner the top
    // layer (radius 0.25 at its centre height) holds no centre at all.
    const pointed = voxels([{ kind: 'cone', base: [8.5, 8.5, 0], radius: 6, height: 12, material: 1 }]);
    expect([...voxelSet(pointed)].filter((key) => key.endsWith(',11')), 'the top layer is the tip voxel alone').toEqual(['8,8,11']);
    expect(filledVoxelCount(voxels([{ kind: 'cone', base: [8, 8, 0], radius: 6, height: 12, material: 1 }])))
      .toBe(filledVoxelCount(voxels([{ kind: 'cone', base: [8, 8, 0], radius: 6, height: 12, topRadius: 0, material: 1 }])));
    expect(countOf({ kind: 'cone', base: [8, 8, 0], radius: 6, height: 0, material: 1 }), 'zero height').toBe(0);
  });

  it('fills ellipsoids to 4/3·π·abc with every mirror symmetry', () => {
    const grid = voxels([{ kind: 'ellipsoid', center: [20, 20, 20], radii: [12, 9, 7], material: 1 }]);
    expect(filledVoxelCount(grid) / ((4 / 3) * Math.PI * 12 * 9 * 7)).toBeCloseTo(1, 1);
    const set = voxelSet(grid);
    expect(mapped(set, (x, y, z) => [39 - x, y, z])).toEqual(set);
    expect(mapped(set, (x, y, z) => [x, 39 - y, z])).toEqual(set);
    expect(mapped(set, (x, y, z) => [x, y, 39 - z])).toEqual(set);
    const sphere = voxelSet(voxels([{ kind: 'ellipsoid', center: [10, 10, 10], radii: [8, 8, 8], material: 1 }]));
    expect(mapped(sphere, (x, y, z) => [z, x, y]), 'a sphere is the same under axis rotation').toEqual(sphere);
    expect(countOf({ kind: 'ellipsoid', center: [5, 5, 5], radii: [4, 0, 4], material: 1 }), 'a zero radius is empty').toBe(0);
  });

  it('steps gables 1:2 — each 1-voxel layer insets 2 voxels per side — along either ridge', () => {
    const size: Vec3 = [30, 22, 12];
    const alongX = voxels([{ kind: 'gable', min: [0, 0, 0], size, ridge: 'x', material: 1 }]);
    const expected = Array.from({ length: size[2] }, (_unused, layer) => size[0] * Math.max(0, size[1] - 4 * layer)).reduce((a, b) => a + b, 0);
    expect(filledVoxelCount(alongX)).toBe(expected);
    for (let layer = 0; layer < 6; layer += 1) {
      expect(materialAt(alongX, 29, 2 * layer, layer), `layer ${layer} starts 2·${layer} in`).toBe(1);
      expect(materialAt(alongX, 29, 2 * layer - 1, layer), `layer ${layer} leaves the step before it`).toBe(0);
      expect(materialAt(alongX, 0, 21 - 2 * layer, layer)).toBe(1);
      expect(materialAt(alongX, 0, 22 - 2 * layer, layer)).toBe(0);
    }
    expect(materialAt(alongX, 5, 10, 5), 'the ridge is 2 voxels wide').toBe(1);
    expect(materialAt(alongX, 5, 10, 6), 'nothing above the ridge').toBe(0);
    const alongY = voxels([{ kind: 'gable', min: [0, 0, 0], size: [22, 30, 12], ridge: 'y', material: 1 }]);
    expect(voxelSet(alongY)).toEqual(mapped(voxelSet(alongX), (x, y, z) => [y, x, z]));
  });

  it('fills rings to their annulus volume with an empty middle, on every axis', () => {
    const ring = voxels([{ kind: 'ring', center: [30, 30, 10], radius: 20, thickness: 4, width: 4, axis: 'z', material: 1 }]);
    expect(filledVoxelCount(ring) / (Math.PI * (22 * 22 - 18 * 18) * 4)).toBeCloseTo(1, 1);
    expect(materialAt(ring, 29, 29, 9), 'the middle is empty').toBe(0);
    expect(materialAt(ring, 49, 29, 9), 'the rim at radius 19.5 is solid').toBe(1);
    const set = voxelSet(ring);
    expect(mapped(set, (x, y, z) => [59 - x, y, z])).toEqual(set);
    expect(mapped(set, (x, y, z) => [y, x, z])).toEqual(set);
    const alongY = voxelSet(voxels([{ kind: 'ring', center: [30, 10, 30], radius: 20, thickness: 4, width: 4, axis: 'y', material: 1 }]));
    expect(alongY).toEqual(mapped(set, (x, y, z) => [x, z, y]));
    const alongX = voxelSet(voxels([{ kind: 'ring', center: [10, 30, 30], radius: 20, thickness: 4, width: 4, axis: 'x', material: 1 }]));
    expect(alongX).toEqual(mapped(set, (x, y, z) => [z, y, x]));
  });

  it('fills segments as capsules: body and caps, symmetric end to end', () => {
    const from: Vec3 = [10, 10, 10];
    const to: Vec3 = [40, 30, 20];
    // Radius 5: thinner capsules on integer endpoints stray a few % from πr²L by lattice effects.
    const radius = 5;
    const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
    const capsule = voxels([{ kind: 'segment', from, to, radius, material: 1 }]);
    expect(filledVoxelCount(capsule) / (Math.PI * radius * radius * length + (4 / 3) * Math.PI * radius ** 3)).toBeCloseTo(1, 1);
    const reversed = voxels([{ kind: 'segment', from: to, to: from, radius, material: 1 }]);
    expect(voxelSet(reversed), 'direction does not matter').toEqual(voxelSet(capsule));
    const ball = voxelSet(voxels([{ kind: 'segment', from: [8, 8, 8], to: [8, 8, 8], radius: 5, material: 1 }]));
    expect(ball, 'a zero-length segment is a ball').toEqual(voxelSet(voxels([{ kind: 'ellipsoid', center: [8, 8, 8], radii: [5, 5, 5], material: 1 }])));
  });
});

describe('voxelize: grid, floor and validation', () => {
  it('starts the grid at the first layer whose centre is on or above the floor', () => {
    const tower: Shape = { kind: 'box', min: [0, 0, -5], size: [2, 2, 10], material: 1 };
    expect(voxelizeShapes([tower], 1).originZ).toBe(1);
    expect(filledVoxelCount(voxelizeShapes([tower], 1))).toBe(16);
    expect(voxelizeShapes([tower], 0).originZ).toBe(0);
    expect(Object.is(voxelizeShapes([tower], 0).originZ, 0), 'never −0').toBe(true);
    expect(filledVoxelCount(voxelizeShapes([tower], 5.5)), 'a centre exactly on the floor stays').toBe(0);
    expect(filledVoxelCount(voxelizeShapes([tower], 4.5))).toBe(4);
    expect(filledVoxelCount(voxelizeShapes([tower], 10)), 'all below the floor').toBe(0);
  });

  it('bounds the grid by solid shapes only and returns an empty grid for nothing solid', () => {
    const grid = voxels([
      { kind: 'box', min: [0, 0, 0], size: [4, 4, 4], material: 1 },
      { kind: 'box', min: [-50, -50, -50], size: [100, 100, 100], material: 0 },
    ]);
    expect([grid.sizeX, grid.sizeY, grid.sizeZ], 'the carve does not grow the grid').toEqual([4, 4, 4]);
    expect(filledVoxelCount(grid)).toBe(0);
    const empty = voxels([{ kind: 'box', min: [0, 0, 0], size: [4, 4, 4], material: 0 }]);
    expect([empty.sizeX, empty.sizeY, empty.sizeZ]).toEqual([0, 0, 0]);
    expect(voxels([]).material.length).toBe(0);
  });

  it('stores a colour slot tag in the top bits of the pattern byte and the palette material in the material grid', () => {
    const grid = voxels([{ kind: 'box', min: [0, 0, 0], size: [2, 1, 1], material: 7 + 3 * 256, pattern: 5 }, { kind: 'box', min: [2, 0, 0], size: [1, 1, 1], material: 7, pattern: 5 }]);
    expect(Array.from(grid.material)).toEqual([7, 7, 7]);
    expect(Array.from(grid.pattern)).toEqual([5 | (3 << 5), 5 | (3 << 5), 5]);
    expect(() => validateShape({ kind: 'box', min: [0, 0, 0], size: [1, 1, 1], material: 3 * 256 }, 'tag')).toThrow(/carve/);
  });

  it('rejects shapes it cannot pack or draw, naming the shape', () => {
    const box = (overrides: Partial<Extract<Shape, { kind: 'box' }>>): Shape => ({ kind: 'box', min: [0, 0, 0], size: [1, 1, 1], material: 1, ...overrides });
    expect(() => validateShape(box({ material: 2048 }), 'kiosk')).toThrow(/kiosk: material/);
    expect(() => validateShape(box({ material: 256 }), 'kiosk'), 'a tagged carve').toThrow(/carve/);
    expect(() => validateShape(box({ material: -1 }), 'kiosk')).toThrow(/material/);
    expect(() => validateShape(box({ material: 1.5 }), 'kiosk')).toThrow(/material/);
    expect(() => validateShape(box({ pattern: 32 }), 'kiosk')).toThrow(/pattern/);
    expect(() => validateShape(box({ size: [1, -1, 1] }), 'kiosk')).toThrow(/size\[1\]/);
    expect(() => validateShape(box({ min: [0, Number.NaN, 0] }), 'kiosk')).toThrow(/min\[1\]/);
    expect(() => validateShape({ kind: 'segment', from: [0, 0, 0], to: [1, 1, 1], radius: -1, material: 1 }, 'arm')).toThrow(/arm: radius/);
    expect(() => validateShape({ kind: 'blob', material: 1 } as unknown as Shape, 'x')).toThrow(/unknown shape kind 'blob'/);
    expect(() => voxelizeShapes([box({ material: 2100 })], 1, "blueprint 'kiosk:test' part 'body'")).toThrow(/kiosk:test.*shape 0 \(box\)/);
    expect(() => voxels([box({ size: [4000, 4000, 4000] })])).toThrow(/cell limit/);
    expect(() => voxels([box({ min: [MAX_COORDINATE + 10, 0, 0] })])).toThrow(/beyond/);
    expect(() => voxelizeShapes([box({})], Number.NaN)).toThrow(/floorZ/);
  });
});
