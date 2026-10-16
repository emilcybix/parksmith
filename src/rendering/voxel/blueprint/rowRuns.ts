import type { VoxelGrid } from './voxelize';

/**
 * A part's voxels as row runs: every row of the grid (one y and z) as its maximal x-runs of a
 * single key, key = material | (pattern | tag << 5) << 8. Material 0 is empty, so 0 is never a key.
 *
 * The greedy mesher and the hollowing pass both work on runs instead of voxels. Their cost then
 * follows the number of runs, a few per row, rather than the grid's volume, which matters because
 * a 4×3-tile ride's grid holds about two million cells. Only the one scan that extracts the runs
 * from the dense grid touches every cell.
 */
export interface RowRuns {
  /** Model-space voxel coordinates of the grid's minimum corner (same as the VoxelGrid's). */
  readonly originX: number;
  readonly originY: number;
  readonly originZ: number;
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  /** The runs of row r = z · sizeY + y (grid-relative y and z) are [rowStart[r], rowStart[r + 1]). */
  readonly rowStart: Int32Array;
  /** Grid-relative x of each run's first voxel, and one past its last. Sorted within a row. */
  readonly runStart: Int32Array;
  readonly runEnd: Int32Array;
  readonly runKey: Int32Array;
  readonly count: number;
}

/**
 * Solid intervals per row: the same rows with the key dropped, so touching runs merge. Exposure and
 * the interior test only care whether a voxel is filled, not what fills it.
 */
export interface SolidRows {
  readonly sizeX: number;
  readonly sizeY: number;
  readonly sizeZ: number;
  readonly rowStart: Int32Array;
  readonly start: Int32Array;
  readonly end: Int32Array;
  readonly count: number;
}

/**
 * Phase 28: a run's "shade" byte is the PATTERN id (low 5 bits) plus the colour slot tag (top 3 bits,
 * contracts/blueprint.ts `slotted`), so only voxels of the same material, pattern AND tag merge. For an
 * untagged blueprint the tag is 0 and the key is exactly what it was before.
 */
export const TAG_SHIFT = 5;
const PATTERN_MASK = (1 << TAG_SHIFT) - 1;

export const runKeyOf = (material: number, shade: number): number => material | (shade << 8);
export const materialOfKey = (key: number): number => key & 255;
export const patternOfKey = (key: number): number => (key >>> 8) & PATTERN_MASK;
export const tagOfKey = (key: number): number => key >>> (8 + TAG_SHIFT);

/**
 * Collects runs row by row into growable typed arrays. Rows must be closed in order with
 * `endRow`, including empty ones, so row r's runs are always found at rowStart[r].
 */
export class RunBuilder {
  private start: Int32Array;
  private end: Int32Array;
  private key: Int32Array;
  private readonly rowStart: Int32Array;
  private rows = 0;
  count = 0;

  constructor(
    private readonly originX: number,
    private readonly originY: number,
    private readonly originZ: number,
    private readonly sizeX: number,
    private readonly sizeY: number,
    private readonly sizeZ: number,
    initialCapacity: number,
  ) {
    const capacity = Math.max(16, initialCapacity);
    this.start = new Int32Array(capacity);
    this.end = new Int32Array(capacity);
    this.key = new Int32Array(capacity);
    this.rowStart = new Int32Array(sizeY * sizeZ + 1);
  }

  push(start: number, end: number, key: number): void {
    if (this.count === this.start.length) this.grow();
    this.start[this.count] = start;
    this.end[this.count] = end;
    this.key[this.count] = key;
    this.count += 1;
  }

  endRow(): void {
    this.rows += 1;
    this.rowStart[this.rows] = this.count;
  }

  finish(): RowRuns {
    if (this.rows !== this.sizeY * this.sizeZ) {
      throw new Error(`RunBuilder: ${this.rows} rows closed, expected ${this.sizeY * this.sizeZ}`);
    }
    return {
      originX: this.originX,
      originY: this.originY,
      originZ: this.originZ,
      sizeX: this.sizeX,
      sizeY: this.sizeY,
      sizeZ: this.sizeZ,
      rowStart: this.rowStart,
      runStart: this.start.subarray(0, this.count),
      runEnd: this.end.subarray(0, this.count),
      runKey: this.key.subarray(0, this.count),
      count: this.count,
    };
  }

  private grow(): void {
    const capacity = this.start.length * 2;
    const start = new Int32Array(capacity);
    const end = new Int32Array(capacity);
    const key = new Int32Array(capacity);
    start.set(this.start);
    end.set(this.end);
    key.set(this.key);
    this.start = start;
    this.end = end;
    this.key = key;
  }
}

/**
 * Maximal runs of equal (material, pattern) in every row of a dense grid. Only the x range the
 * voxelizer recorded as written is scanned, so empty rows and the air around a shape cost nothing.
 */
export const runsFromGrid = (grid: VoxelGrid): RowRuns => {
  const { sizeX, sizeY, sizeZ, material, pattern, rowMinX, rowMaxX } = grid;
  const builder = new RunBuilder(grid.originX, grid.originY, grid.originZ, sizeX, sizeY, sizeZ, sizeY * sizeZ * 2);
  const rows = sizeY * sizeZ;
  for (let row = 0; row < rows; row += 1) {
    const base = row * sizeX;
    const rowEnd = rowMaxX[row];
    let x = rowMinX[row];
    while (x < rowEnd) {
      const filled = material[base + x];
      if (filled === 0) {
        x += 1;
        continue;
      }
      const shade = pattern[base + x];
      let end = x + 1;
      while (end < rowEnd && material[base + end] === filled && pattern[base + end] === shade) end += 1;
      builder.push(x, end, runKeyOf(filled, shade));
      x = end;
    }
    builder.endRow();
  }
  return builder.finish();
};

/** Merges touching runs of each row into solid intervals. */
export const solidRowsOf = (runs: RowRuns): SolidRows => {
  const rows = runs.sizeY * runs.sizeZ;
  const rowStart = new Int32Array(rows + 1);
  const start = new Int32Array(Math.max(1, runs.count));
  const end = new Int32Array(Math.max(1, runs.count));
  let count = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let run = runs.rowStart[row]; run < runs.rowStart[row + 1]; run += 1) {
      if (count > rowStart[row] && end[count - 1] === runs.runStart[run]) {
        end[count - 1] = runs.runEnd[run];
      } else {
        start[count] = runs.runStart[run];
        end[count] = runs.runEnd[run];
        count += 1;
      }
    }
    rowStart[row + 1] = count;
  }
  return {
    sizeX: runs.sizeX,
    sizeY: runs.sizeY,
    sizeZ: runs.sizeZ,
    rowStart,
    start: start.subarray(0, count),
    end: end.subarray(0, count),
    count,
  };
};

/** Filled voxels of a run encoding. */
export const runVoxelCount = (runs: RowRuns): number => {
  let voxels = 0;
  for (let run = 0; run < runs.count; run += 1) voxels += runs.runEnd[run] - runs.runStart[run];
  return voxels;
};
