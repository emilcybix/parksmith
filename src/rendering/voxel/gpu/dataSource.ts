import { ExtensionType, extensions, GlTextureSystem, TextureSource } from 'pixi.js';
import type { GlRenderingContext, GlTexture, GLTextureUploader } from 'pixi.js';

/**
 * RGBA32F data textures for vertex pulling (boxes, transforms, figures, templates, litter, lights),
 * uploaded by dirty row range.
 *
 * Pixi's own 'buffer' uploader re-sends the whole texture on every update. Voxel data changes a few
 * rows at a time — one chunk after a placement, the figure and transform rows every frame — so these
 * sources carry a dirty row range and a custom TextureUploaderWebGL extension sends exactly those
 * rows with texSubImage2D (texImage2D only when the size changes, i.e. on first use, on growth and
 * after a context restore, when Pixi recreates every GL texture and the whole CPU copy goes up again).
 *
 * The Float32Array `resource` IS the CPU copy: it is always complete, so a restored context needs
 * nothing but the next bind.
 */

export const VOXEL_DATA_UPLOAD_ID = 'voxel-data';

const FLOATS_PER_TEXEL = 4;
const BYTES_PER_TEXEL = FLOATS_PER_TEXEL * Float32Array.BYTES_PER_ELEMENT;

export interface VoxelDataSourceOptions {
  /** Texels per row (the contract's *_TEX_WIDTH). */
  width: number;
  /** Rows to allocate up front; the texture grows by powers of two as needed. */
  rows?: number;
  label?: string;
}

/** Smallest power-of-two multiple of `current` (≥ 1) that holds `needed`. */
export const grownRowCount = (current: number, needed: number): number => {
  let rows = Math.max(1, current);
  while (rows < needed) rows *= 2;
  return rows;
};

export class VoxelDataSource extends TextureSource<Float32Array> {
  /** Rows [dirtyRowStart, dirtyRowEnd) changed on the CPU since the last upload; equal = clean. */
  dirtyRowStart = 0;
  dirtyRowEnd = 0;
  /** Bytes the uploader has sent since the last takeUploadedBytes(), full uploads included. */
  private uploadedBytes = 0;
  /**
   * texSubImage2D takes the rows as their own view, so the byte count a GL call reports is the
   * bytes actually sent (the measurement harness counts view sizes). One view is kept and reused
   * while the dirty range stays the same — the steady state of every per-frame texture.
   */
  private rowsView: Float32Array | null = null;
  private rowsViewStart = -1;
  private rowsViewEnd = -1;

  constructor(options: VoxelDataSourceOptions) {
    const rows = Math.max(1, Math.ceil(options.rows ?? 1));
    super({
      resource: new Float32Array(options.width * rows * FLOATS_PER_TEXEL),
      width: options.width,
      height: rows,
      format: 'rgba32float',
      alphaMode: 'no-premultiply-alpha',
      scaleMode: 'nearest',
      autoGarbageCollect: false,
      label: options.label,
    });
    this.uploadMethodId = VOXEL_DATA_UPLOAD_ID;
  }

  /** Floats per texture row. */
  get rowFloats(): number {
    return this.pixelWidth * FLOATS_PER_TEXEL;
  }

  get rowCount(): number {
    return this.pixelHeight;
  }

  /**
   * Makes room for `rows` rows (doubling), keeping the data. A size change re-allocates the GL
   * texture and uploads everything once; it only happens as a list grows past its high-water mark.
   */
  ensureRows(rows: number): void {
    if (rows <= this.pixelHeight) return;
    const grownRows = grownRowCount(this.pixelHeight, rows);
    const grown = new Float32Array(this.rowFloats * grownRows);
    grown.set(this.resource);
    this.resource = grown;
    this.rowsView = null;
    this.rowsViewStart = -1;
    this.rowsViewEnd = -1;
    this.resize(this.pixelWidth, grownRows);
  }

  /** Adds rows [start, end) to the dirty range (clamped to the texture). */
  markRows(start: number, end: number): void {
    const from = Math.max(0, Math.floor(start));
    const to = Math.min(this.pixelHeight, Math.ceil(end));
    if (to <= from) return;
    if (this.dirtyRowEnd <= this.dirtyRowStart) {
      this.dirtyRowStart = from;
      this.dirtyRowEnd = to;
      return;
    }
    this.dirtyRowStart = Math.min(this.dirtyRowStart, from);
    this.dirtyRowEnd = Math.max(this.dirtyRowEnd, to);
  }

  /**
   * Copies rows [rowStart, rowEnd) of `source` — a CPU copy in this texture's layout and width —
   * and marks them. A plain loop, so a per-frame copy allocates nothing.
   */
  writeRows(source: Float32Array, rowStart: number, rowEnd: number): void {
    if (rowEnd <= rowStart) return;
    this.ensureRows(rowEnd);
    const target = this.resource;
    const rowFloats = this.rowFloats;
    const end = Math.min(rowEnd * rowFloats, source.length);
    for (let index = rowStart * rowFloats; index < end; index += 1) target[index] = source[index];
    this.markRows(rowStart, rowEnd);
  }

  /**
   * Replaces the first `floats` values (a whole box list after a rebuild) and marks the rows they
   * cover. Rows past them keep stale data, which is never drawn: draws stop at the live count.
   */
  writePrefix(source: Float32Array, floats: number): void {
    const count = Math.max(0, Math.min(floats, source.length));
    const rows = Math.max(1, Math.ceil(count / this.rowFloats));
    this.ensureRows(rows);
    if (count > 0) this.resource.set(count === source.length ? source : source.subarray(0, count));
    this.markRows(0, rows);
  }

  /** Uploads the dirty rows now (one texSubImage2D) if there are any; true if it had work. */
  flush(): boolean {
    if (this.dirtyRowEnd <= this.dirtyRowStart) return false;
    this.update();
    return true;
  }

  /** Bytes sent to the GPU since the previous call. */
  takeUploadedBytes(): number {
    const bytes = this.uploadedBytes;
    this.uploadedBytes = 0;
    return bytes;
  }

  /** Called by the uploader with this source's GL texture bound. */
  uploadTo(glTexture: GlTexture, gl: GlRenderingContext): void {
    const width = this.pixelWidth;
    const height = this.pixelHeight;
    if (glTexture.width !== width || glTexture.height !== height) {
      gl.texImage2D(glTexture.target, 0, glTexture.internalFormat, width, height, 0, glTexture.format, glTexture.type, this.resource);
      glTexture.width = width;
      glTexture.height = height;
      this.uploadedBytes += width * height * BYTES_PER_TEXEL;
    } else if (this.dirtyRowEnd > this.dirtyRowStart) {
      const start = this.dirtyRowStart;
      const rows = this.dirtyRowEnd - start;
      gl.texSubImage2D(glTexture.target, 0, 0, start, width, rows, glTexture.format, glTexture.type, this.viewOfRows(start, this.dirtyRowEnd));
      this.uploadedBytes += width * rows * BYTES_PER_TEXEL;
    }
    this.dirtyRowStart = 0;
    this.dirtyRowEnd = 0;
  }

  private viewOfRows(start: number, end: number): Float32Array {
    if (this.rowsView === null || this.rowsViewStart !== start || this.rowsViewEnd !== end) {
      this.rowsView = this.resource.subarray(start * this.rowFloats, end * this.rowFloats);
      this.rowsViewStart = start;
      this.rowsViewEnd = end;
    }
    return this.rowsView;
  }
}

/** The TextureUploaderWebGL extension: Pixi binds the source's texture, then calls this. */
export const VOXEL_DATA_UPLOADER: GLTextureUploader = {
  id: VOXEL_DATA_UPLOAD_ID,
  upload(source: TextureSource, glTexture: GlTexture, gl: GlRenderingContext): void {
    if (!(source instanceof VoxelDataSource)) {
      throw new Error(`The ${VOXEL_DATA_UPLOAD_ID} uploader only uploads VoxelDataSource textures`);
    }
    source.uploadTo(glTexture, gl);
  },
};

/**
 * Registers the dirty-row uploader. Pixi copies its uploader table when the renderer's texture
 * system is constructed, so this must run before `app.init` (boot.ts `beforeInit`). Idempotent.
 */
export const registerVoxelUploader = (): void => {
  if (GlTextureSystem.uploadExtensions[VOXEL_DATA_UPLOAD_ID] === VOXEL_DATA_UPLOADER) return;
  extensions.add({ type: ExtensionType.TextureUploaderWebGL, name: VOXEL_DATA_UPLOAD_ID, ref: VOXEL_DATA_UPLOADER });
};

/** Whether a renderer was built with the uploader (it must have been registered before init). */
export const rendererHasVoxelUploader = (textureSystem: unknown): boolean => {
  const uploads = (textureSystem as { _uploads?: Record<string, unknown> })._uploads;
  return uploads?.[VOXEL_DATA_UPLOAD_ID] === VOXEL_DATA_UPLOADER;
};
