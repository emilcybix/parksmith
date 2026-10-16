import type { RowRuns } from './rowRuns';

/**
 * Row runs → disjoint boxes (the second compile stage).
 *
 * Three merges, each only of EXACTLY equal pieces:
 *   1. x runs: a row's maximal runs of one key (rowRuns.ts);
 *   2. rows → rectangles: a run continues the rectangle above it (y − 1) when that rectangle's last
 *      row has the same start, end and key;
 *   3. rectangles → boxes: a layer's rectangle continues the box below it (z − 1) when that box's
 *      last layer holds the same rectangle with the same key.
 * Every voxel belongs to exactly one run, every run to one rectangle and every rectangle to one box,
 * so the boxes are disjoint and their union is the voxel set by construction; each box has a single
 * (material, pattern) key. Merging only exact matches also makes the result independent of any
 * visiting order inside a row or layer, and needs no visited mask: the cost is linear in runs.
 *
 * Rectangles are opened in (y, x) order within a layer, so matching one layer against the next is a
 * two-pointer walk over two sorted lists (a rectangle's minimum corner is unique within its layer).
 */

/** Seven int32 per box: minX, minY, minZ, maxX, maxY, maxZ (exclusive, model space), key. */
export const MESH_BOX_STRIDE = 7;

export interface MeshBoxes {
  readonly count: number;
  readonly data: Int32Array;
}

/** Growable rectangle list for one layer; `box` is the box a rectangle currently extends. */
class RectangleList {
  x0: Int32Array = new Int32Array(64);
  x1: Int32Array = new Int32Array(64);
  y0: Int32Array = new Int32Array(64);
  y1: Int32Array = new Int32Array(64);
  key: Int32Array = new Int32Array(64);
  box: Int32Array = new Int32Array(64);
  count = 0;

  clear(): void {
    this.count = 0;
  }

  push(x0: number, x1: number, y0: number, y1: number, key: number): number {
    if (this.count === this.x0.length) this.grow();
    const index = this.count;
    this.x0[index] = x0;
    this.x1[index] = x1;
    this.y0[index] = y0;
    this.y1[index] = y1;
    this.key[index] = key;
    this.box[index] = -1;
    this.count += 1;
    return index;
  }

  private grow(): void {
    const capacity = this.x0.length * 2;
    const grown = (source: Int32Array): Int32Array => {
      const target = new Int32Array(capacity);
      target.set(source);
      return target;
    };
    this.x0 = grown(this.x0);
    this.x1 = grown(this.x1);
    this.y0 = grown(this.y0);
    this.y1 = grown(this.y1);
    this.key = grown(this.key);
    this.box = grown(this.box);
  }
}

class BoxList {
  data: Int32Array = new Int32Array(64 * MESH_BOX_STRIDE);
  count = 0;

  push(minX: number, minY: number, minZ: number, maxX: number, maxY: number, maxZ: number, key: number): number {
    if ((this.count + 1) * MESH_BOX_STRIDE > this.data.length) {
      const grown = new Int32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const offset = this.count * MESH_BOX_STRIDE;
    this.data[offset] = minX;
    this.data[offset + 1] = minY;
    this.data[offset + 2] = minZ;
    this.data[offset + 3] = maxX;
    this.data[offset + 4] = maxY;
    this.data[offset + 5] = maxZ;
    this.data[offset + 6] = key;
    this.count += 1;
    return this.count - 1;
  }
}

/** Disjoint boxes covering exactly the voxels of `runs`, in model space. */
export const meshRuns = (runs: RowRuns): MeshBoxes => {
  const { sizeY, sizeZ, rowStart, runStart, runEnd, runKey, originX, originY, originZ } = runs;
  const rectangleOfRun = new Int32Array(Math.max(1, runs.count));
  let previous = new RectangleList();
  let current = new RectangleList();
  const boxes = new BoxList();
  for (let z = 0; z < sizeZ; z += 1) {
    current.clear();
    // Rows → rectangles within the layer.
    for (let y = 0; y < sizeY; y += 1) {
      const row = z * sizeY + y;
      let above = y > 0 ? rowStart[row - 1] : 0;
      const aboveEnd = y > 0 ? rowStart[row] : 0;
      for (let run = rowStart[row]; run < rowStart[row + 1]; run += 1) {
        const start = runStart[run];
        while (above < aboveEnd && runStart[above] < start) above += 1;
        if (above < aboveEnd && runStart[above] === start && runEnd[above] === runEnd[run] && runKey[above] === runKey[run]) {
          const rectangle = rectangleOfRun[above];
          current.y1[rectangle] = y + 1;
          rectangleOfRun[run] = rectangle;
        } else {
          rectangleOfRun[run] = current.push(start, runEnd[run], y, y + 1, runKey[run]);
        }
      }
    }
    // Rectangles → boxes across layers.
    let below = 0;
    for (let rectangle = 0; rectangle < current.count; rectangle += 1) {
      const y0 = current.y0[rectangle];
      const x0 = current.x0[rectangle];
      while (below < previous.count && (previous.y0[below] < y0 || (previous.y0[below] === y0 && previous.x0[below] < x0))) {
        below += 1;
      }
      if (
        below < previous.count
        && previous.y0[below] === y0
        && previous.x0[below] === x0
        && previous.x1[below] === current.x1[rectangle]
        && previous.y1[below] === current.y1[rectangle]
        && previous.key[below] === current.key[rectangle]
      ) {
        const box = previous.box[below];
        boxes.data[box * MESH_BOX_STRIDE + 5] = originZ + z + 1;
        current.box[rectangle] = box;
      } else {
        current.box[rectangle] = boxes.push(
          originX + x0,
          originY + y0,
          originZ + z,
          originX + current.x1[rectangle],
          originY + current.y1[rectangle],
          originZ + z + 1,
          current.key[rectangle],
        );
      }
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return { count: boxes.count, data: boxes.data };
};

/**
 * Texels the boxes rasterise at one texel per voxel: each box draws its three camera-facing faces,
 * Σ (ab + bc + ca), before any depth test rejects them.
 */
export const rasterArea = (mesh: MeshBoxes): number => {
  let area = 0;
  for (let box = 0; box < mesh.count; box += 1) {
    const offset = box * MESH_BOX_STRIDE;
    const sizeX = mesh.data[offset + 3] - mesh.data[offset];
    const sizeY = mesh.data[offset + 4] - mesh.data[offset + 1];
    const sizeZ = mesh.data[offset + 5] - mesh.data[offset + 2];
    area += sizeX * sizeY + sizeY * sizeZ + sizeZ * sizeX;
  }
  return area;
};
