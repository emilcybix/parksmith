import { GlTextureSystem, type GlRenderingContext, type GlTexture } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import {
  grownRowCount,
  registerVoxelUploader,
  rendererHasVoxelUploader,
  VOXEL_DATA_UPLOAD_ID,
  VOXEL_DATA_UPLOADER,
  VoxelDataSource,
} from './dataSource';

/**
 * Data textures carry the voxel scene to the GPU, and the upload budget (≤ 64 KB per steady frame)
 * rests on this uploader sending only the rows that changed. Pixi calls the uploader with the GL
 * texture bound, so a recording fake context shows exactly what would reach the driver.
 */

interface Call {
  name: 'texImage2D' | 'texSubImage2D';
  args: unknown[];
}

const fakeGl = (): { gl: GlRenderingContext; calls: Call[] } => {
  const calls: Call[] = [];
  const gl = {
    texImage2D: (...args: unknown[]) => calls.push({ name: 'texImage2D', args }),
    texSubImage2D: (...args: unknown[]) => calls.push({ name: 'texSubImage2D', args }),
  } as unknown as GlRenderingContext;
  return { gl, calls };
};

/** A GL texture as Pixi creates it: size −1 until the first upload (and again after a context restore). */
const freshGlTexture = (): GlTexture => ({
  width: -1,
  height: -1,
  target: 3553,
  internalFormat: 34836,
  format: 6408,
  type: 5126,
} as unknown as GlTexture);

const BYTES_PER_TEXEL = 16;

describe('VoxelDataSource', () => {
  it('is an RGBA32F, nearest, non-premultiplied texture uploaded by the voxel uploader', () => {
    const source = new VoxelDataSource({ width: 256, rows: 3 });
    expect(source.format).toBe('rgba32float');
    expect(source.scaleMode).toBe('nearest');
    expect(source.alphaMode).toBe('no-premultiply-alpha');
    expect(source.uploadMethodId).toBe(VOXEL_DATA_UPLOAD_ID);
    expect(source.autoGarbageCollect, 'a culled chunk must keep its GPU copy').toBe(false);
    expect(source.resource.length).toBe(256 * 3 * 4);
  });

  it('unions dirty rows and clamps them to the texture', () => {
    const source = new VoxelDataSource({ width: 4, rows: 8 });
    source.markRows(5, 6);
    source.markRows(2, 3);
    expect([source.dirtyRowStart, source.dirtyRowEnd]).toEqual([2, 6]);
    source.markRows(7, 20);
    expect([source.dirtyRowStart, source.dirtyRowEnd]).toEqual([2, 8]);
    source.markRows(4, 4);
    expect([source.dirtyRowStart, source.dirtyRowEnd], 'an empty range changes nothing').toEqual([2, 8]);
  });

  it('copies exactly the changed rows of a CPU copy, growing by powers of two and keeping data', () => {
    const source = new VoxelDataSource({ width: 2, rows: 1 });
    const cpu = new Float32Array(2 * 4 * 6).map((_unused, index) => index + 1);
    source.writeRows(cpu, 0, 1);
    expect(source.rowCount).toBe(1);
    source.writeRows(cpu, 4, 6);
    expect(source.rowCount, 'grown to the next power of two').toBe(8);
    const rowFloats = 8;
    expect(Array.from(source.resource.subarray(0, rowFloats)), 'row 0 kept through growth').toEqual(Array.from(cpu.subarray(0, rowFloats)));
    expect(Array.from(source.resource.subarray(rowFloats, 4 * rowFloats)).every((value) => value === 0), 'rows 1–3 untouched').toBe(true);
    expect(Array.from(source.resource.subarray(4 * rowFloats, 6 * rowFloats))).toEqual(Array.from(cpu.subarray(4 * rowFloats, 6 * rowFloats)));
    expect([source.dirtyRowStart, source.dirtyRowEnd]).toEqual([0, 6]);
  });

  it('replaces a whole box list and marks the rows it covers', () => {
    const source = new VoxelDataSource({ width: 4, rows: 1 });
    const boxes = new Float32Array(4 * 4 * 3).fill(7);
    source.writePrefix(boxes, 4 * 4 * 2 + 3);
    expect(source.rowCount).toBe(4);
    expect([source.dirtyRowStart, source.dirtyRowEnd]).toEqual([0, 3]);
    expect(source.resource[4 * 4 * 2 + 2]).toBe(7);
    expect(source.resource[4 * 4 * 2 + 3], 'past the prefix stays as it was').toBe(0);
  });

  it('uploads everything on first use, then only dirty rows as their own view', () => {
    const source = new VoxelDataSource({ width: 256, rows: 16 });
    const texture = freshGlTexture();
    const { gl, calls } = fakeGl();
    source.uploadTo(texture, gl);
    expect(calls.map((call) => call.name)).toEqual(['texImage2D']);
    expect(calls[0].args.slice(3, 5)).toEqual([256, 16]);
    expect(calls[0].args[8]).toBe(source.resource);
    expect([texture.width, texture.height]).toEqual([256, 16]);
    expect(source.takeUploadedBytes()).toBe(256 * 16 * BYTES_PER_TEXEL);

    source.markRows(3, 5);
    source.uploadTo(texture, gl);
    const sub = calls[1];
    expect(sub.name).toBe('texSubImage2D');
    expect(sub.args.slice(2, 6), 'x 0, y = first dirty row, full width, dirty row count').toEqual([0, 3, 256, 2]);
    const rows = sub.args[8] as Float32Array;
    expect(rows.length, 'exactly the dirty rows are sent').toBe(256 * 2 * 4);
    expect(rows.buffer).toBe(source.resource.buffer);
    expect(rows.byteOffset).toBe(3 * 256 * BYTES_PER_TEXEL);
    expect(source.takeUploadedBytes()).toBe(256 * 2 * BYTES_PER_TEXEL);
    expect([source.dirtyRowStart, source.dirtyRowEnd], 'clean after the upload').toEqual([0, 0]);

    source.uploadTo(texture, gl);
    expect(calls, 'a clean texture uploads nothing').toHaveLength(2);

    source.markRows(3, 5);
    source.uploadTo(texture, gl);
    expect(calls[2].args[8], 'the steady per-frame range reuses its view (no allocation)').toBe(rows);
  });

  it('re-uploads in full after growth and after a context restore (a fresh GL texture)', () => {
    const source = new VoxelDataSource({ width: 4, rows: 2 });
    const { gl, calls } = fakeGl();
    const texture = freshGlTexture();
    source.uploadTo(texture, gl);
    source.writeRows(new Float32Array(4 * 4 * 3), 2, 3);
    source.uploadTo(texture, gl);
    expect(calls.map((call) => call.name)).toEqual(['texImage2D', 'texImage2D']);
    expect(calls[1].args.slice(3, 5)).toEqual([4, 4]);

    const restored = freshGlTexture();
    source.uploadTo(restored, gl);
    expect(calls[2].name, 'a restored context gets the whole CPU copy').toBe('texImage2D');
    expect(calls[2].args[8]).toBe(source.resource);
  });

  it('flushes only when rows are dirty', () => {
    const source = new VoxelDataSource({ width: 4, rows: 2 });
    expect(source.flush()).toBe(false);
    source.markRows(0, 1);
    expect(source.flush()).toBe(true);
  });

  it('grows row counts by doubling', () => {
    expect(grownRowCount(0, 1)).toBe(1);
    expect(grownRowCount(1, 5)).toBe(8);
    expect(grownRowCount(8, 8)).toBe(8);
    expect(grownRowCount(3, 7)).toBe(12);
  });
});

describe('voxel data uploader', () => {
  it('uploads only voxel data sources', () => {
    const { gl } = fakeGl();
    const notOurs = { uploadMethodId: VOXEL_DATA_UPLOAD_ID } as unknown as VoxelDataSource;
    expect(() => VOXEL_DATA_UPLOADER.upload(notOurs, freshGlTexture(), gl, 2)).toThrow(/VoxelDataSource/);
  });

  it('registers once, before init, under its upload method id', () => {
    registerVoxelUploader();
    registerVoxelUploader();
    expect(GlTextureSystem.uploadExtensions[VOXEL_DATA_UPLOAD_ID]).toBe(VOXEL_DATA_UPLOADER);
    expect(rendererHasVoxelUploader({ _uploads: { [VOXEL_DATA_UPLOAD_ID]: VOXEL_DATA_UPLOADER } })).toBe(true);
    expect(rendererHasVoxelUploader({ _uploads: {} }), 'a renderer built before registration').toBe(false);
    expect(rendererHasVoxelUploader({})).toBe(false);
  });
});
