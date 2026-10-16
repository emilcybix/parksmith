/**
 * Box records: the one geometry primitive the voxel renderer draws.
 *
 * A compiled model, a static chunk, the litter list and the ghost preview are all flat lists of
 * axis-aligned boxes in RGBA32F data textures. The vertex shader pulls a box by index and emits its
 * three camera-facing faces as quads; nothing is instanced (SwiftShader instancing costs ~20 µs per
 * instance, and tiny instances are inefficient on real GPUs too), and nothing is meshed per frame.
 *
 * Layout, two texels per box:
 *   texel 0: minX, minY, minZ, word   (word = packBoxWord(material, group, pattern, quarterTurn))
 *   texel 1: sizeX, sizeY, sizeZ, slot (0 = static; k > 0 = rigid transform k − 1, and the box is
 *            then in part-local voxels relative to that part's pivot)
 * All values are integers below 2^24, so they are exact in float32 and in GLSL highp int.
 */

export const BOX_TEXELS = 2;
export const BOX_FLOATS = BOX_TEXELS * 4;
/** Row width of box data textures, in texels (512 boxes per row). */
export const BOX_TEX_WIDTH = 1024;
export const BOXES_PER_ROW = BOX_TEX_WIDTH / BOX_TEXELS;

/** Vertex pulling: box = gl_VertexID / 12, face = (gl_VertexID % 12) / 4, corner = gl_VertexID & 3. */
export const VERTICES_PER_BOX = 12;
export const INDICES_PER_BOX = 18;

export const MATERIAL_LIMIT = 256;
export const OUTLINE_GROUP_LIMIT = 256;
export const PATTERN_LIMIT = 32;

export const STATIC_SLOT = 0;

/** material 0..255 | group << 8 | pattern << 16 (5 bits) | quarterTurn << 21 (2 bits); < 2^23. */
export const packBoxWord = (material: number, group: number, pattern: number, quarterTurn: number): number =>
  material + group * 256 + pattern * 65_536 + quarterTurn * 2_097_152;

export interface BoxWord {
  material: number;
  group: number;
  pattern: number;
  quarterTurn: number;
}

export const unpackBoxWord = (word: number): BoxWord => ({
  material: word & 255,
  group: (word >>> 8) & 255,
  pattern: (word >>> 16) & 31,
  quarterTurn: (word >>> 21) & 3,
});

/** Replaces the outline group of a packed word (compiled models use group 0; placement sets it). */
export const withOutlineGroup = (word: number, group: number): number =>
  word - ((word >>> 8) & 255) * 256 + group * 256;

/**
 * Replaces the material byte of a packed word (Phase 28 recolour: the box keeps its outline group,
 * pattern and quarter turn). Exact in float: the word is below 2^23.
 */
export const withMaterial = (word: number, material: number): number => word - (word & 255) + material;

/** Replaces the quarter turn of a packed word (directional patterns follow a rotated model). */
export const withQuarterTurn = (word: number, quarterTurn: number): number =>
  word - ((word >>> 21) & 3) * 2_097_152 + quarterTurn * 2_097_152;

/**
 * Growable box list in BOX layout. Never shrinks its storage, so a rebuild into a cleared writer
 * allocates nothing once warm. `data` may be longer than `count * BOX_FLOATS`; only the prefix is
 * meaningful.
 */
export class BoxWriter {
  data: Float32Array;
  count = 0;

  constructor(initialCapacity = 256) {
    this.data = new Float32Array(Math.max(1, initialCapacity) * BOX_FLOATS);
  }

  get capacity(): number {
    return this.data.length / BOX_FLOATS;
  }

  clear(): void {
    this.count = 0;
  }

  ensureCapacity(boxes: number): void {
    if (boxes <= this.capacity) return;
    let capacity = this.capacity;
    while (capacity < boxes) capacity *= 2;
    const grown = new Float32Array(capacity * BOX_FLOATS);
    grown.set(this.data.subarray(0, this.count * BOX_FLOATS));
    this.data = grown;
  }

  push(
    minX: number,
    minY: number,
    minZ: number,
    sizeX: number,
    sizeY: number,
    sizeZ: number,
    word: number,
    slot = STATIC_SLOT,
  ): void {
    this.ensureCapacity(this.count + 1);
    const offset = this.count * BOX_FLOATS;
    const data = this.data;
    data[offset] = minX;
    data[offset + 1] = minY;
    data[offset + 2] = minZ;
    data[offset + 3] = word;
    data[offset + 4] = sizeX;
    data[offset + 5] = sizeY;
    data[offset + 6] = sizeZ;
    data[offset + 7] = slot;
    this.count += 1;
  }

  /** Appends `count` boxes already in BOX layout, translated by (dx, dy, dz). */
  pushTranslated(source: Float32Array, count: number, dx: number, dy: number, dz: number): void {
    this.ensureCapacity(this.count + count);
    const data = this.data;
    let to = this.count * BOX_FLOATS;
    for (let from = 0; from < count * BOX_FLOATS; from += BOX_FLOATS, to += BOX_FLOATS) {
      data[to] = source[from] + dx;
      data[to + 1] = source[from + 1] + dy;
      data[to + 2] = source[from + 2] + dz;
      data[to + 3] = source[from + 3];
      data[to + 4] = source[from + 4];
      data[to + 5] = source[from + 5];
      data[to + 6] = source[from + 6];
      data[to + 7] = source[from + 7];
    }
    this.count += count;
  }
}

/**
 * Shared index buffer for `boxCapacity` boxes: per box b and face f, q = 12b + 4f and the indices
 * are [q, q+1, q+2, q+2, q+1, q+3]. Every box draw starts at 0 and passes size = count · 18, so the
 * buffer only has to cover the largest single draw.
 */
export const buildBoxIndices = (boxCapacity: number): Uint32Array => {
  const indices = new Uint32Array(boxCapacity * INDICES_PER_BOX);
  for (let box = 0, at = 0; box < boxCapacity; box += 1) {
    for (let face = 0; face < 3; face += 1, at += 6) {
      const q = box * VERTICES_PER_BOX + face * 4;
      indices[at] = q;
      indices[at + 1] = q + 1;
      indices[at + 2] = q + 2;
      indices[at + 3] = q + 2;
      indices[at + 4] = q + 1;
      indices[at + 5] = q + 3;
    }
  }
  return indices;
};

/**
 * Rigid transforms (ride parts, coaster cars), two texels each in a 256-wide texture so a row is
 * only 4 KiB and dirty-row uploads stay small:
 *   texel 0: pivot x, y, z in world voxels, 0
 *   texel 1: unit quaternion x, y, z, w (world orientation of the part)
 * Slots are allocated densely (lowest free index) so animated parts stay in few rows.
 */
export const TRANSFORM_TEXELS = 2;
export const TRANSFORM_FLOATS = TRANSFORM_TEXELS * 4;
export const TRANSFORM_TEX_WIDTH = 256;
export const TRANSFORM_CAPACITY = 4096;

/** Dynamic box lists (litter, ghost) use the static layout in their own small textures. */
export const DYNAMIC_BOX_TEX_WIDTH = 256;
