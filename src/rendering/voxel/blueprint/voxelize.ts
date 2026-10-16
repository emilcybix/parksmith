import { COLOUR_TAG_LIMIT, materialOfShape, tagOfShape } from '../contracts/blueprint';
import type { Shape } from '../contracts/blueprint';
import { MATERIAL_LIMIT, PATTERN_LIMIT } from '../contracts/boxes';
import { PATTERN } from '../contracts/palette';
import { TAG_SHIFT } from './rowRuns';

/**
 * Shapes → a dense voxel grid (the first compile stage, contracts/blueprint.ts).
 *
 * Sampling rule: voxel (i, j, k) is the unit cube [i, i+1) × [j, j+1) × [k, k+1), and it is filled
 * when its CENTRE (i + ½, j + ½, k + ½) lies inside the shape. Centre sampling makes a shape's voxel
 * set a pure function of its parameters (no coverage thresholds to tune), keeps integer-aligned boxes
 * exact, and keeps round shapes mirror-symmetric about integer or half-integer centres.
 *
 * Extents that have a start and a length — box sides, a cylinder's length, a cone's height, a ring's
 * width, a gable's layers — are half-open, [start, start + length), so a length of n is n voxels
 * wherever it starts and two shapes that abut never share a voxel. Round boundaries — discs,
 * ellipsoids, a ring's radii, a segment's radius — are closed: a centre exactly on the surface is in.
 *
 * Rasterisation walks rows along x. Every shape gives an analytic, slightly generous estimate of its
 * span(s) on a row (a disc chord, an ellipse chord, a capsule interval), and the exact per-voxel test
 * (`shapeContains`) only settles the voxel or two at each end. The result is exactly the per-voxel
 * centre test, at a cost proportional to rows rather than to voxels — which is what keeps a 3×3 ride
 * compile inside a frame slice.
 */

/** A part's voxels over its integer bounds, x fastest: index (z · sizeY + y) · sizeX + x. */
export interface VoxelGrid {
  /** Voxel coordinates (model space) of the grid's minimum corner. */
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  /** Palette material per voxel; 0 is empty. */
  readonly material: Uint8Array;
  /**
   * Per voxel: the PATTERN id of the shape that filled it (low 5 bits) and its colour slot tag
   * (top 3 bits, `slotted` materials); 0 wherever it is empty.
   */
  readonly pattern: Uint8Array;
  /**
   * Per row (z · sizeY + y, grid-relative), the grid-relative x range [rowMinX, rowMaxX) that any
   * solid shape ever wrote; empty rows have rowMinX ≥ rowMaxX. Carving does not shrink it, so it is
   * conservative. Run extraction scans only this range, which skips most of a sparse grid.
   */
  readonly rowMinX: Int32Array;
  readonly rowMaxX: Int32Array;
}

/** Voxel index bounds, maximum exclusive. */
export interface VoxelBounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

/**
 * Largest grid one part may voxelize into. The biggest legitimate part (a 4×3-tile ride, 150 voxels
 * tall) is about 1.9 M cells; this only stops a typo'd radius from allocating gigabytes.
 */
export const MAX_GRID_CELLS = 1 << 24;

/**
 * Slack for the generous row estimates: a chord whose squared half-width is barely negative is
 * treated as touching, and the exact test then decides. Estimates may only ever be too wide.
 */
const ESTIMATE_SLACK = 1e-9;

/**
 * The farthest any grid bound may lie from the origin. Box coordinates go through float32 and GLSL
 * highp int (exact below 2^24), and depth keys add three of them, so 2^20 keeps every sum exact with
 * room to spare. Real models, at most a 4-tile ride 150 voxels tall, stay far below it.
 */
export const MAX_COORDINATE = 1 << 20;

/** First voxel index whose centre is at or above `start` (`+ 0` turns Math.ceil's −0 into 0). */
const firstCentreAtOrAbove = (start: number): number => Math.ceil(start - 0.5) + 0;
/** One past the last voxel index whose centre is below `end` (half-open extents). */
const endOfCentresBelow = (end: number): number => Math.ceil(end - 0.5) + 0;
/** One past the last voxel index whose centre is at or below `end` (closed extents). */
const endOfCentresAtOrBelow = (end: number): number => Math.floor(end - 0.5) + 1;

const squared = (value: number): number => value * value;

/** The ring's inner and outer radius: the rim is centred on `radius`, `thickness` wide. */
const ringRadii = (radius: number, thickness: number): { inner: number; outer: number } => ({
  inner: Math.max(0, radius - thickness / 2),
  outer: radius + thickness / 2,
});

/** Squared distance from (x, y, z) to the segment from `from` to `to`. */
const segmentDistanceSquared = (
  from: readonly [number, number, number],
  to: readonly [number, number, number],
  x: number,
  y: number,
  z: number,
): number => {
  const abX = to[0] - from[0];
  const abY = to[1] - from[1];
  const abZ = to[2] - from[2];
  const lengthSquared = abX * abX + abY * abY + abZ * abZ;
  const apX = x - from[0];
  const apY = y - from[1];
  const apZ = z - from[2];
  let t = lengthSquared > 0 ? (apX * abX + apY * abY + apZ * abZ) / lengthSquared : 0;
  t = Math.min(1, Math.max(0, t));
  return squared(apX - t * abX) + squared(apY - t * abY) + squared(apZ - t * abZ);
};

/**
 * The exact inside test at a point (the voxelizer evaluates it at voxel centres). Every shape's
 * definition lives here; the row estimates below are only a fast way to find where it is true.
 */
export const shapeContains = (shape: Shape, x: number, y: number, z: number): boolean => {
  switch (shape.kind) {
    case 'box': {
      const [minX, minY, minZ] = shape.min;
      const [sizeX, sizeY, sizeZ] = shape.size;
      return x >= minX && x < minX + sizeX && y >= minY && y < minY + sizeY && z >= minZ && z < minZ + sizeZ;
    }
    case 'cylinder': {
      const [baseX, baseY, baseZ] = shape.base;
      const radiusSquared = shape.radius * shape.radius;
      if (shape.axis === 'z') {
        const along = z - baseZ;
        return along >= 0 && along < shape.length && squared(x - baseX) + squared(y - baseY) <= radiusSquared;
      }
      if (shape.axis === 'x') {
        const along = x - baseX;
        return along >= 0 && along < shape.length && squared(y - baseY) + squared(z - baseZ) <= radiusSquared;
      }
      const along = y - baseY;
      return along >= 0 && along < shape.length && squared(x - baseX) + squared(z - baseZ) <= radiusSquared;
    }
    case 'cone': {
      const along = z - shape.base[2];
      if (!(along >= 0 && along < shape.height)) return false;
      const radius = shape.radius + ((shape.topRadius ?? 0) - shape.radius) * (along / shape.height);
      return squared(x - shape.base[0]) + squared(y - shape.base[1]) <= radius * radius;
    }
    case 'ellipsoid': {
      const [radiusX, radiusY, radiusZ] = shape.radii;
      if (radiusX <= 0 || radiusY <= 0 || radiusZ <= 0) return false;
      return squared((x - shape.center[0]) / radiusX)
        + squared((y - shape.center[1]) / radiusY)
        + squared((z - shape.center[2]) / radiusZ) <= 1;
    }
    case 'gable': {
      const [minX, minY, minZ] = shape.min;
      const maxX = minX + shape.size[0];
      const maxY = minY + shape.size[1];
      if (!(z >= minZ && z < minZ + shape.size[2])) return false;
      // Layer n (1 voxel tall) is inset 2 voxels per side per layer: the 1:2 slope in 1-voxel steps.
      const inset = 2 * Math.floor(z - minZ);
      if (shape.ridge === 'x') return x >= minX && x < maxX && y >= minY + inset && y < maxY - inset;
      return y >= minY && y < maxY && x >= minX + inset && x < maxX - inset;
    }
    case 'ring': {
      const [centerX, centerY, centerZ] = shape.center;
      const { inner, outer } = ringRadii(shape.radius, shape.thickness);
      const halfWidth = shape.width / 2;
      let along: number;
      let radialSquared: number;
      if (shape.axis === 'z') {
        along = z - centerZ;
        radialSquared = squared(x - centerX) + squared(y - centerY);
      } else if (shape.axis === 'x') {
        along = x - centerX;
        radialSquared = squared(y - centerY) + squared(z - centerZ);
      } else {
        along = y - centerY;
        radialSquared = squared(x - centerX) + squared(z - centerZ);
      }
      return along >= -halfWidth && along < halfWidth
        && radialSquared >= inner * inner && radialSquared <= outer * outer;
    }
    case 'segment':
      return segmentDistanceSquared(shape.from, shape.to, x, y, z) <= shape.radius * shape.radius;
  }
};

/** Closed extent [centre − half, centre + half] as voxel indices. */
const closedIndices = (centre: number, half: number): [number, number] =>
  [firstCentreAtOrAbove(centre - half), endOfCentresAtOrBelow(centre + half)];

/** Half-open extent [start, end) as voxel indices. */
const halfOpenIndices = (start: number, end: number): [number, number] =>
  [firstCentreAtOrAbove(start), endOfCentresBelow(end)];

/** Voxel index bounds that contain every voxel the shape can fill (conservative, max exclusive). */
export const shapeVoxelBounds = (shape: Shape): VoxelBounds => {
  let x: [number, number];
  let y: [number, number];
  let z: [number, number];
  switch (shape.kind) {
    case 'box':
    case 'gable':
      x = halfOpenIndices(shape.min[0], shape.min[0] + shape.size[0]);
      y = halfOpenIndices(shape.min[1], shape.min[1] + shape.size[1]);
      z = halfOpenIndices(shape.min[2], shape.min[2] + shape.size[2]);
      break;
    case 'cylinder': {
      const [baseX, baseY, baseZ] = shape.base;
      const { radius, length } = shape;
      x = shape.axis === 'x' ? halfOpenIndices(baseX, baseX + length) : closedIndices(baseX, radius);
      y = shape.axis === 'y' ? halfOpenIndices(baseY, baseY + length) : closedIndices(baseY, radius);
      z = shape.axis === 'z' ? halfOpenIndices(baseZ, baseZ + length) : closedIndices(baseZ, radius);
      break;
    }
    case 'cone': {
      const radius = Math.max(shape.radius, shape.topRadius ?? 0);
      x = closedIndices(shape.base[0], radius);
      y = closedIndices(shape.base[1], radius);
      z = halfOpenIndices(shape.base[2], shape.base[2] + shape.height);
      break;
    }
    case 'ellipsoid':
      x = closedIndices(shape.center[0], shape.radii[0]);
      y = closedIndices(shape.center[1], shape.radii[1]);
      z = closedIndices(shape.center[2], shape.radii[2]);
      break;
    case 'ring': {
      const [centerX, centerY, centerZ] = shape.center;
      const { outer } = ringRadii(shape.radius, shape.thickness);
      const half = shape.width / 2;
      x = shape.axis === 'x' ? halfOpenIndices(centerX - half, centerX + half) : closedIndices(centerX, outer);
      y = shape.axis === 'y' ? halfOpenIndices(centerY - half, centerY + half) : closedIndices(centerY, outer);
      z = shape.axis === 'z' ? halfOpenIndices(centerZ - half, centerZ + half) : closedIndices(centerZ, outer);
      break;
    }
    case 'segment': {
      const { from, to, radius } = shape;
      x = [firstCentreAtOrAbove(Math.min(from[0], to[0]) - radius), endOfCentresAtOrBelow(Math.max(from[0], to[0]) + radius)];
      y = [firstCentreAtOrAbove(Math.min(from[1], to[1]) - radius), endOfCentresAtOrBelow(Math.max(from[1], to[1]) + radius)];
      z = [firstCentreAtOrAbove(Math.min(from[2], to[2]) - radius), endOfCentresAtOrBelow(Math.max(from[2], to[2]) + radius)];
      break;
    }
  }
  return { minX: x[0], minY: y[0], minZ: z[0], maxX: x[1], maxY: y[1], maxZ: z[1] };
};

const isEmptyBounds = (bounds: VoxelBounds): boolean =>
  bounds.minX >= bounds.maxX || bounds.minY >= bounds.maxY || bounds.minZ >= bounds.maxZ;

/**
 * Up to two x-intervals of one row, as CONTINUOUS coordinates [from, to] that contain every inside
 * voxel centre (generous by construction). Reused for every row of a shape, so a compile allocates
 * nothing per row.
 */
class RowEstimate {
  count = 0;
  from0 = 0;
  to0 = 0;
  from1 = 0;
  to1 = 0;

  none(): void {
    this.count = 0;
  }

  one(from: number, to: number): void {
    this.count = 1;
    this.from0 = from;
    this.to0 = to;
  }

  two(from0: number, to0: number, from1: number, to1: number): void {
    this.count = 2;
    this.from0 = from0;
    this.to0 = to0;
    this.from1 = from1;
    this.to1 = to1;
  }

  /** A chord of half-width √halfSquared around `centre` (nothing if it is clearly negative). */
  chord(centre: number, halfSquared: number, slack: number): void {
    if (halfSquared < -slack) {
      this.none();
      return;
    }
    const half = Math.sqrt(Math.max(0, halfSquared));
    this.one(centre - half, centre + half);
  }
}

/** Interval of x where the quadratic a·x² + b·x + c ≤ 0 (a > 0), widened by the slack; null if none. */
const quadraticInterval = (a: number, b: number, c: number, slack: number): [number, number] | null => {
  const discriminant = b * b - 4 * a * c;
  if (discriminant < -slack) return null;
  const root = Math.sqrt(Math.max(0, discriminant));
  return [(-b - root) / (2 * a), (-b + root) / (2 * a)];
};

/**
 * Row estimate for a capsule (every point within `radius` of the segment): it is convex, so its row
 * interval is the hull of the rows through both end spheres and through the body cylinder clipped
 * to the segment's slab.
 */
const segmentRow = (shape: Extract<Shape, { kind: 'segment' }>, y: number, z: number, out: RowEstimate): void => {
  const { from, to, radius } = shape;
  const radiusSquared = radius * radius;
  const slack = ESTIMATE_SLACK * (1 + radiusSquared);
  let low = Infinity;
  let high = -Infinity;
  const fromHalfSquared = radiusSquared - squared(y - from[1]) - squared(z - from[2]);
  if (fromHalfSquared >= -slack) {
    const half = Math.sqrt(Math.max(0, fromHalfSquared));
    low = Math.min(low, from[0] - half);
    high = Math.max(high, from[0] + half);
  }
  const toHalfSquared = radiusSquared - squared(y - to[1]) - squared(z - to[2]);
  if (toHalfSquared >= -slack) {
    const half = Math.sqrt(Math.max(0, toHalfSquared));
    low = Math.min(low, to[0] - half);
    high = Math.max(high, to[0] + half);
  }
  const abX = to[0] - from[0];
  const abY = to[1] - from[1];
  const abZ = to[2] - from[2];
  const lengthSquared = abX * abX + abY * abY + abZ * abZ;
  if (lengthSquared > 0) {
    // Points (x, y, z) with x' = x − from.x: distance² to the line is α·x'² + β·x' + γ, and the
    // projection parameter t = (x'·abX + f) / L² must lie in [0, 1].
    const dy = y - from[1];
    const dz = z - from[2];
    const f = dy * abY + dz * abZ;
    const unitX = abX / Math.sqrt(lengthSquared);
    const e = f / Math.sqrt(lengthSquared);
    const alpha = 1 - unitX * unitX;
    const beta = -2 * unitX * e;
    const gamma = dy * dy + dz * dz - e * e - radiusSquared;
    let bodyFrom = -Infinity;
    let bodyTo = Infinity;
    if (alpha > 1e-12) {
      const interval = quadraticInterval(alpha, beta, gamma, slack);
      if (interval === null) bodyFrom = Infinity;
      else [bodyFrom, bodyTo] = interval;
    } else if (gamma > slack) {
      bodyFrom = Infinity;
    }
    if (abX !== 0) {
      const t0 = (0 - f) / abX;
      const t1 = (lengthSquared - f) / abX;
      bodyFrom = Math.max(bodyFrom, Math.min(t0, t1));
      bodyTo = Math.min(bodyTo, Math.max(t0, t1));
    } else {
      const t = f / lengthSquared;
      if (t < -ESTIMATE_SLACK || t > 1 + ESTIMATE_SLACK) bodyFrom = Infinity;
    }
    if (bodyFrom <= bodyTo) {
      low = Math.min(low, from[0] + bodyFrom);
      high = Math.max(high, from[0] + bodyTo);
    }
  }
  if (low <= high) out.one(low, high);
  else out.none();
};

/** The analytic row estimate of every shape kind at the row through voxel centres (y, z). */
const estimateRow = (shape: Shape, y: number, z: number, out: RowEstimate): void => {
  switch (shape.kind) {
    case 'box':
      out.one(shape.min[0], shape.min[0] + shape.size[0]);
      return;
    case 'cylinder': {
      const [baseX, baseY, baseZ] = shape.base;
      const radiusSquared = shape.radius * shape.radius;
      const slack = ESTIMATE_SLACK * (1 + radiusSquared);
      if (shape.axis === 'z') out.chord(baseX, radiusSquared - squared(y - baseY), slack);
      else if (shape.axis === 'y') out.chord(baseX, radiusSquared - squared(z - baseZ), slack);
      else if (squared(y - baseY) + squared(z - baseZ) <= radiusSquared + slack) out.one(baseX, baseX + shape.length);
      else out.none();
      return;
    }
    case 'cone': {
      const along = z - shape.base[2];
      const radius = shape.radius + ((shape.topRadius ?? 0) - shape.radius) * (along / shape.height);
      const radiusSquared = radius * radius;
      out.chord(shape.base[0], radiusSquared - squared(y - shape.base[1]), ESTIMATE_SLACK * (1 + radiusSquared));
      return;
    }
    case 'ellipsoid': {
      const [radiusX, radiusY, radiusZ] = shape.radii;
      if (radiusX <= 0 || radiusY <= 0 || radiusZ <= 0) {
        out.none();
        return;
      }
      const rest = 1 - squared((y - shape.center[1]) / radiusY) - squared((z - shape.center[2]) / radiusZ);
      if (rest < -ESTIMATE_SLACK) {
        out.none();
        return;
      }
      const half = radiusX * Math.sqrt(Math.max(0, rest));
      out.one(shape.center[0] - half, shape.center[0] + half);
      return;
    }
    case 'gable': {
      const inset = 2 * Math.floor(z - shape.min[2]);
      if (shape.ridge === 'y') {
        const from = shape.min[0] + inset;
        const to = shape.min[0] + shape.size[0] - inset;
        if (from < to) out.one(from, to);
        else out.none();
      } else if (y >= shape.min[1] + inset && y < shape.min[1] + shape.size[1] - inset) {
        out.one(shape.min[0], shape.min[0] + shape.size[0]);
      } else {
        out.none();
      }
      return;
    }
    case 'ring': {
      const [centerX, centerY, centerZ] = shape.center;
      const { inner, outer } = ringRadii(shape.radius, shape.thickness);
      const slack = ESTIMATE_SLACK * (1 + outer * outer);
      if (shape.axis === 'x') {
        const radialSquared = squared(y - centerY) + squared(z - centerZ);
        if (radialSquared <= outer * outer + slack && radialSquared >= inner * inner - slack) {
          out.one(centerX - shape.width / 2, centerX + shape.width / 2);
        } else {
          out.none();
        }
        return;
      }
      // Axis z: the annulus lies in (x, y); axis y: in (x, z). Either way the row cuts it in a chord
      // of the outer circle with the inner circle's chord taken out.
      const offset = shape.axis === 'z' ? y - centerY : z - centerZ;
      const outerSquared = outer * outer - offset * offset;
      if (outerSquared < -slack) {
        out.none();
        return;
      }
      const outerHalf = Math.sqrt(Math.max(0, outerSquared));
      const innerSquared = inner * inner - offset * offset;
      if (innerSquared <= 0) {
        out.one(centerX - outerHalf, centerX + outerHalf);
        return;
      }
      const innerHalf = Math.sqrt(innerSquared);
      out.two(centerX - outerHalf, centerX - innerHalf, centerX + innerHalf, centerX + outerHalf);
      return;
    }
    case 'segment':
      segmentRow(shape, y, z, out);
      return;
  }
};

const assertFinite = (value: number, what: string, label: string): void => {
  if (!Number.isFinite(value)) throw new Error(`${label}: ${what} must be a finite number (got ${value})`);
};

const assertNonNegative = (value: number, what: string, label: string): void => {
  assertFinite(value, what, label);
  if (value < 0) throw new Error(`${label}: ${what} must not be negative (got ${value})`);
};

/**
 * Rejects shapes that cannot be packed (material or pattern out of the box word's range) or that
 * are nonsense (non-finite or negative extents). A thrown error names the shape, so a content test
 * points straight at the typo instead of at a garbled model.
 */
export const validateShape = (shape: Shape, label: string): void => {
  if (!Number.isInteger(shape.material) || shape.material < 0 || shape.material >= MATERIAL_LIMIT * COLOUR_TAG_LIMIT) {
    throw new Error(`${label}: material must be an integer in [0, ${MATERIAL_LIMIT}), plus 256 per colour tag (got ${shape.material})`);
  }
  if (materialOfShape(shape.material) === 0 && shape.material !== 0) {
    throw new Error(`${label}: a carve (material 0) cannot carry a colour tag (got ${shape.material})`);
  }
  const pattern = shape.pattern ?? PATTERN.PLAIN;
  if (!Number.isInteger(pattern) || pattern < 0 || pattern >= PATTERN_LIMIT) {
    throw new Error(`${label}: pattern must be an integer in [0, ${PATTERN_LIMIT}) (got ${pattern})`);
  }
  const vector = (value: readonly number[], what: string, nonNegative: boolean): void => {
    value.forEach((component, axis) => (nonNegative ? assertNonNegative : assertFinite)(component, `${what}[${axis}]`, label));
  };
  switch (shape.kind) {
    case 'box':
    case 'gable':
      vector(shape.min, 'min', false);
      vector(shape.size, 'size', true);
      return;
    case 'cylinder':
      vector(shape.base, 'base', false);
      assertNonNegative(shape.radius, 'radius', label);
      assertNonNegative(shape.length, 'length', label);
      return;
    case 'cone':
      vector(shape.base, 'base', false);
      assertNonNegative(shape.radius, 'radius', label);
      assertNonNegative(shape.topRadius ?? 0, 'topRadius', label);
      assertNonNegative(shape.height, 'height', label);
      return;
    case 'ellipsoid':
      vector(shape.center, 'center', false);
      vector(shape.radii, 'radii', true);
      return;
    case 'ring':
      vector(shape.center, 'center', false);
      assertNonNegative(shape.radius, 'radius', label);
      assertNonNegative(shape.thickness, 'thickness', label);
      assertNonNegative(shape.width, 'width', label);
      return;
    case 'segment':
      vector(shape.from, 'from', false);
      vector(shape.to, 'to', false);
      assertNonNegative(shape.radius, 'radius', label);
      return;
    default:
      throw new Error(`${label}: unknown shape kind '${(shape as { kind: string }).kind}'`);
  }
};

/** Writes one shape into the grid (material 0 carves), row by row. */
const rasterizeShape = (grid: VoxelGrid, shape: Shape): void => {
  const bounds = shapeVoxelBounds(shape);
  const gridMaxX = grid.originX + grid.sizeX;
  const minX = Math.max(bounds.minX, grid.originX);
  const maxX = Math.min(bounds.maxX, gridMaxX);
  const minY = Math.max(bounds.minY, grid.originY);
  const maxY = Math.min(bounds.maxY, grid.originY + grid.sizeY);
  const minZ = Math.max(bounds.minZ, grid.originZ);
  const maxZ = Math.min(bounds.maxZ, grid.originZ + grid.sizeZ);
  if (minX >= maxX || minY >= maxY || minZ >= maxZ) return;
  if (shape.kind === 'cone' && shape.height <= 0) return;
  const material = materialOfShape(shape.material);
  const pattern = material === 0 ? 0 : (shape.pattern ?? PATTERN.PLAIN) | (tagOfShape(shape.material) << TAG_SHIFT);
  const row = new RowEstimate();
  for (let k = minZ; k < maxZ; k += 1) {
    const centreZ = k + 0.5;
    for (let j = minY; j < maxY; j += 1) {
      const centreY = j + 0.5;
      estimateRow(shape, centreY, centreZ, row);
      const rowIndex = (k - grid.originZ) * grid.sizeY + (j - grid.originY);
      const rowOffset = rowIndex * grid.sizeX - grid.originX;
      for (let span = 0; span < row.count; span += 1) {
        // The estimate contains every inside centre; step one voxel further out on each side for
        // floating-point safety, then let the exact test trim both ends.
        let start = Math.max(minX, firstCentreAtOrAbove(span === 0 ? row.from0 : row.from1) - 1);
        let end = Math.min(maxX, endOfCentresAtOrBelow(span === 0 ? row.to0 : row.to1) + 1);
        while (start < end && !shapeContains(shape, start + 0.5, centreY, centreZ)) start += 1;
        while (end > start && !shapeContains(shape, end - 0.5, centreY, centreZ)) end -= 1;
        if (start < end) {
          grid.material.fill(material, rowOffset + start, rowOffset + end);
          grid.pattern.fill(pattern, rowOffset + start, rowOffset + end);
          if (material !== 0) {
            grid.rowMinX[rowIndex] = Math.min(grid.rowMinX[rowIndex], start - grid.originX);
            grid.rowMaxX[rowIndex] = Math.max(grid.rowMaxX[rowIndex], end - grid.originX);
          }
        }
      }
    }
  }
};

const EMPTY_GRID: VoxelGrid = {
  originX: 0,
  originY: 0,
  originZ: 0,
  sizeX: 0,
  sizeY: 0,
  sizeZ: 0,
  material: new Uint8Array(0),
  pattern: new Uint8Array(0),
  rowMinX: new Int32Array(0),
  rowMaxX: new Int32Array(0),
};

/**
 * Voxelizes shapes in order into one grid over the union of the solid shapes' bounds: a later shape
 * overwrites earlier voxels, material 0 carves, and nothing below `floorZ` (voxel centres under it)
 * is kept — the grid simply starts at the first voxel layer whose centre is at or above the floor.
 */
export const voxelizeShapes = (shapes: readonly Shape[], floorZ: number, label = 'part'): VoxelGrid => {
  assertFinite(floorZ, 'floorZ', label);
  const union: VoxelBounds = { minX: Infinity, minY: Infinity, minZ: Infinity, maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity };
  shapes.forEach((shape, index) => {
    validateShape(shape, `${label} shape ${index} (${shape.kind})`);
    if (shape.material === 0) return;
    const bounds = shapeVoxelBounds(shape);
    if (isEmptyBounds(bounds) || (shape.kind === 'cone' && shape.height <= 0)) return;
    union.minX = Math.min(union.minX, bounds.minX);
    union.minY = Math.min(union.minY, bounds.minY);
    union.minZ = Math.min(union.minZ, bounds.minZ);
    union.maxX = Math.max(union.maxX, bounds.maxX);
    union.maxY = Math.max(union.maxY, bounds.maxY);
    union.maxZ = Math.max(union.maxZ, bounds.maxZ);
  });
  union.minZ = Math.max(union.minZ, firstCentreAtOrAbove(floorZ));
  if (isEmptyBounds(union)) return EMPTY_GRID;
  for (const bound of [union.minX, union.minY, union.minZ, union.maxX, union.maxY, union.maxZ]) {
    if (Math.abs(bound) > MAX_COORDINATE) {
      throw new Error(`${label}: voxel coordinate ${bound} is beyond ±${MAX_COORDINATE} — check the shape positions`);
    }
  }
  const sizeX = union.maxX - union.minX;
  const sizeY = union.maxY - union.minY;
  const sizeZ = union.maxZ - union.minZ;
  const cells = sizeX * sizeY * sizeZ;
  if (cells > MAX_GRID_CELLS) {
    throw new Error(`${label}: ${sizeX}×${sizeY}×${sizeZ} voxels exceeds the ${MAX_GRID_CELLS}-cell limit — check the shape sizes`);
  }
  const grid: VoxelGrid = {
    originX: union.minX,
    originY: union.minY,
    originZ: union.minZ,
    sizeX,
    sizeY,
    sizeZ,
    material: new Uint8Array(cells),
    pattern: new Uint8Array(cells),
    rowMinX: new Int32Array(sizeY * sizeZ).fill(sizeX),
    rowMaxX: new Int32Array(sizeY * sizeZ),
  };
  for (const shape of shapes) rasterizeShape(grid, shape);
  return grid;
};

/** Number of filled voxels (material ≠ 0). */
export const filledVoxelCount = (grid: VoxelGrid): number => {
  let count = 0;
  for (let index = 0; index < grid.material.length; index += 1) if (grid.material[index] !== 0) count += 1;
  return count;
};

/** Material at a model-space voxel index, 0 outside the grid (tests and tooling). */
export const materialAt = (grid: VoxelGrid, x: number, y: number, z: number): number => {
  const i = x - grid.originX;
  const j = y - grid.originY;
  const k = z - grid.originZ;
  if (i < 0 || j < 0 || k < 0 || i >= grid.sizeX || j >= grid.sizeY || k >= grid.sizeZ) return 0;
  return grid.material[(k * grid.sizeY + j) * grid.sizeX + i];
};
