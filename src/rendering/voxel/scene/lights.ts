import type { LightSource } from '../contracts/blueprint';
import { LIGHT_CAPACITY, LIGHT_FLOATS, LIGHT_TEX_WIDTH, LIGHT_TEXELS } from '../contracts/frame';

/**
 * Point lights for the dusk/night light pass (contracts/frame.ts LIGHT layout, two texels each):
 *   texel 0: x, y, z (world voxels), radius
 *   texel 1: r, g, b (0..1, sRGB), preset bitmask
 *
 * Lights belong to the models that declare them (lamps, lit windows, ride bulbs), and those models
 * only change when a static chunk is rebuilt, so each chunk keeps its own small list and the table
 * the GPU reads is re-packed from the chunk lists only after a rebuild pass. A steady frame never
 * touches the lights, and the light pass stays one draw however many chunks carry lights.
 */

const CHANNEL_SCALE = 1 / 255;

/** Lights per texture row: 256 texels, two per light. */
export const LIGHTS_PER_ROW = LIGHT_TEX_WIDTH / LIGHT_TEXELS;

/** Texture rows `count` lights occupy. */
export const lightRowsFor = (count: number): number => Math.ceil(Math.max(0, count) / LIGHTS_PER_ROW);

/** One chunk's lights in LIGHT layout. Grows by doubling and never shrinks, so rebuilds reuse it. */
export class LightList {
  data = new Float32Array(4 * LIGHT_FLOATS);
  count = 0;

  clear(): void {
    this.count = 0;
  }

  /** Appends a light at world voxel (x, y, z); `color` is 0xRRGGBB, `presets` a LIGHT_PRESET_* mask. */
  push(x: number, y: number, z: number, radius: number, color: number, presets: number): void {
    if ((this.count + 1) * LIGHT_FLOATS > this.data.length) {
      const grown = new Float32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    const at = this.count * LIGHT_FLOATS;
    const data = this.data;
    data[at] = x;
    data[at + 1] = y;
    data[at + 2] = z;
    data[at + 3] = radius;
    data[at + 4] = ((color >> 16) & 255) * CHANNEL_SCALE;
    data[at + 5] = ((color >> 8) & 255) * CHANNEL_SCALE;
    data[at + 6] = (color & 255) * CHANNEL_SCALE;
    data[at + 7] = presets;
    this.count += 1;
  }

  /**
   * Appends a model's light placed at the model's world origin. Light positions from rotateModel
   * are already turned (blueprint/compile.ts), so only the placement origin is added.
   */
  pushPlaced(light: LightSource, originX: number, originY: number, originZ: number): void {
    this.push(
      originX + light.position[0],
      originY + light.position[1],
      originZ + light.position[2],
      light.radius,
      light.color,
      light.presets,
    );
  }
}

/**
 * The packed table the GPU reads. `pack` concatenates the chunk lists in chunk order, so its
 * contents depend only on the chunks, never on the order they were rebuilt in.
 */
export class LightTable {
  readonly data = new Float32Array(LIGHT_CAPACITY * LIGHT_FLOATS);
  count = 0;

  /** Re-packs every chunk's lights (clamped to LIGHT_CAPACITY); returns the live count. */
  pack(chunks: readonly LightList[]): number {
    let count = 0;
    for (let chunk = 0; chunk < chunks.length && count < LIGHT_CAPACITY; chunk += 1) {
      const list = chunks[chunk];
      const take = Math.min(list.count, LIGHT_CAPACITY - count);
      if (take <= 0) continue;
      this.data.set(list.data.subarray(0, take * LIGHT_FLOATS), count * LIGHT_FLOATS);
      count += take;
    }
    this.count = count;
    return count;
  }

  /** Texture rows the live lights occupy. */
  get rows(): number {
    return lightRowsFor(this.count);
  }
}
