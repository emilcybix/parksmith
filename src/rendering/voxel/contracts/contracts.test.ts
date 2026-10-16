import { describe, expect, it } from 'vitest';
import { BUILD_CATALOG } from '../../../game/content/catalog';
import { footprintSize } from '../../../game/types';
import type { Rotation } from '../../../game/types';
import { cellToWorld, worldToCell } from '../../isometric';
import { REGISTERED_CONTENT_IDS } from '../content/registry';
import {
  BoxWriter,
  BOX_FLOATS,
  buildBoxIndices,
  INDICES_PER_BOX,
  packBoxWord,
  unpackBoxWord,
  withOutlineGroup,
  withQuarterTurn,
} from './boxes';
import { packPaletteWord, queueSlotOffset, unpackPaletteWord } from './figures';
import { BAYER_4X4, lambertTerm } from './gbuffer';
import { MAT, MAT_COLOR } from './palette';
import {
  cellCentreVoxel,
  depthKey,
  depthKeyFromTexture,
  depthRangeFor,
  depthToNdc,
  fromTexelAndDepth,
  groundOffsetForTexelOffset,
  PLANE_GRADIENT_TOP,
  PLANE_GRADIENT_X,
  PLANE_GRADIENT_Y,
  projectX,
  projectY,
  rotateBoxInFootprint,
  rotatePointInFootprint,
  visualQuarterTurn,
  VOXELS_PER_TILE,
} from './space';

/**
 * The contracts are what every voxel module agrees on, so their arithmetic is pinned here once:
 * if a constant or formula changes, this file says which promise broke.
 */
describe('voxel space contract', () => {
  it('projects voxels onto exactly the legacy world-pixel grid', () => {
    for (const cell of [{ x: 0, y: 0 }, { x: 5, y: 3 }, { x: 31, y: 31 }, { x: 12, y: 27 }]) {
      const legacy = cellToWorld(cell);
      const vx = cell.x * VOXELS_PER_TILE;
      const vy = cell.y * VOXELS_PER_TILE;
      expect(projectX(vx, vy)).toBe(legacy.x);
      expect(projectY(vx, vy, 0)).toBe(legacy.y);
      const centre = cellCentreVoxel(cell);
      expect(worldToCell(projectX(centre.x, centre.y), projectY(centre.x, centre.y, 0))).toEqual(cell);
    }
  });

  it('orders every view ray by the depth key and inverts it exactly', () => {
    const range = depthRangeFor(32, 32);
    const near = { x: 101, y: 57, z: 12 };
    const far = { x: near.x - 7, y: near.y - 7, z: near.z - 7 };
    expect(projectX(near.x, near.y)).toBe(projectX(far.x, far.y));
    expect(projectY(near.x, near.y, near.z)).toBe(projectY(far.x, far.y, far.z));
    expect(depthToNdc(depthKey(near.x, near.y, near.z), range))
      .toBeLessThan(depthToNdc(depthKey(far.x, far.y, far.z), range));

    const key = depthKey(near.x, near.y, near.z);
    const sampled = (depthToNdc(key, range) + 1) / 2;
    expect(depthKeyFromTexture(sampled, range)).toBeCloseTo(key, 6);
    const back = fromTexelAndDepth(projectX(near.x, near.y), projectY(near.x, near.y, near.z), key);
    expect(back.x).toBeCloseTo(near.x, 9);
    expect(back.y).toBeCloseTo(near.y, 9);
    expect(back.z).toBeCloseTo(near.z, 9);
  });

  it('states the in-plane depth gradient of every axis-aligned face', () => {
    const texelStep = (point: { x: number; y: number; z: number }, dx: number, dy: number, face: 'top' | 'x' | 'y') => {
      // Walk one texel on the face's own plane and measure the depth-key change.
      const sx = projectX(point.x, point.y) + dx;
      const sy = projectY(point.x, point.y, point.z) + dy;
      if (face === 'top') {
        const sum = 2 * (sy + point.z);
        return (sum + point.z) - depthKey(point.x, point.y, point.z);
      }
      if (face === 'x') {
        const vy = point.x - sx;
        const vz = (point.x + vy) / 2 - sy;
        return depthKey(point.x, vy, vz) - depthKey(point.x, point.y, point.z);
      }
      const vx = sx + point.y;
      const vz = (vx + point.y) / 2 - sy;
      return depthKey(vx, point.y, vz) - depthKey(point.x, point.y, point.z);
    };
    const origin = { x: 40, y: 30, z: 5 };
    expect([texelStep(origin, 1, 0, 'top'), texelStep(origin, 0, 1, 'top')]).toEqual([...PLANE_GRADIENT_TOP]);
    expect([texelStep(origin, 1, 0, 'x'), texelStep(origin, 0, 1, 'x')]).toEqual([...PLANE_GRADIENT_X]);
    expect([texelStep(origin, 1, 0, 'y'), texelStep(origin, 0, 1, 'y')]).toEqual([...PLANE_GRADIENT_Y]);
  });

  it('re-expresses a texel offset as a move inside the ground plane', () => {
    for (const [dsx, dsy] of [[7, 0], [-21, 5], [14, 55], [0, -3]]) {
      const { dvx, dvy } = groundOffsetForTexelOffset(dsx, dsy);
      expect(projectX(dvx, dvy)).toBeCloseTo(dsx, 9);
      expect(projectY(dvx, dvy, 0)).toBeCloseTo(dsy, 9);
      expect(depthKey(dvx, dvy, 0)).toBeCloseTo(2 * dsy, 9);
    }
    expect(queueSlotOffset(3)).toEqual({ dvx: 0, dvy: 0 });
  });

  it('turns models so their front moves from +y to +x and the footprint matches footprintSize', () => {
    const definition = BUILD_CATALOG.find((entry) => entry.id === 'comfort-pavilion');
    expect(definition?.footprint).toEqual([3, 2]);
    if (!definition) return;
    const width = definition.footprint[0] * VOXELS_PER_TILE;
    const depth = definition.footprint[1] * VOXELS_PER_TILE;
    for (const rotation of [0, 1, 2, 3] as Rotation[]) {
      // Phase 40: turns 2 and 3 repeat the single turn; the footprint is the single turn's, swapped back on even turns.
      expect(visualQuarterTurn(rotation)).toBe(rotation);
      const whole = rotateBoxInFootprint(0, 0, width, depth, (rotation % 2) as 0 | 1, width);
      const [tilesX, tilesY] = footprintSize(definition, rotation);
      expect([whole.minX, whole.minY, whole.sizeX, whole.sizeY]).toEqual([0, 0, tilesX * VOXELS_PER_TILE, tilesY * VOXELS_PER_TILE]);
    }
    // The front edge (model y = depth) lands on the world +x edge (x = depth) after a quarter turn.
    expect(rotatePointInFootprint(10, depth, 1, width)).toEqual({ x: depth, y: width - 10 });
  });
});

describe('box records', () => {
  it('packs every field of a box word losslessly and below 2^24', () => {
    for (const [material, group, pattern, turn] of [[0, 0, 0, 0], [255, 255, 31, 3], [17, 200, 9, 1]]) {
      const word = packBoxWord(material, group, pattern, turn);
      expect(word).toBeLessThan(2 ** 24);
      expect(Math.fround(word)).toBe(word);
      expect(unpackBoxWord(word)).toEqual({ material, group, pattern, quarterTurn: turn });
      expect(unpackBoxWord(withOutlineGroup(word, 42)).group).toBe(42);
      expect(unpackBoxWord(withQuarterTurn(word, 2)).quarterTurn).toBe(2);
      expect(unpackBoxWord(withQuarterTurn(word, 2)).material).toBe(material);
    }
  });

  it('grows a box writer without losing boxes and translates copies', () => {
    const writer = new BoxWriter(1);
    for (let index = 0; index < 100; index += 1) writer.push(index, 0, 0, 1, 1, 1, index, 0);
    expect(writer.count).toBe(100);
    expect(writer.data[99 * BOX_FLOATS]).toBe(99);
    const copy = new BoxWriter();
    copy.pushTranslated(writer.data, 3, 10, 20, 30);
    expect(Array.from(copy.data.subarray(BOX_FLOATS, BOX_FLOATS + 4))).toEqual([11, 20, 30, 1]);
  });

  it('indexes three faces of four corners per box', () => {
    const indices = buildBoxIndices(2);
    expect(indices.length).toBe(2 * INDICES_PER_BOX);
    expect(Array.from(indices.subarray(0, 6))).toEqual([0, 1, 2, 2, 1, 3]);
    expect(Array.from(indices.subarray(18, 24))).toEqual([12, 13, 14, 14, 13, 15]);
    expect(Math.max(...indices)).toBe(23);
  });
});

describe('shading and dither constants', () => {
  it('lights top faces exactly and +y faces brighter than +x faces', () => {
    expect(lambertTerm(0, 0, 1)).toBeCloseTo(1, 9);
    expect(lambertTerm(0, 1, 0)).toBeGreaterThan(lambertTerm(1, 0, 0));
    expect(lambertTerm(0, 0, -1)).toBe(0);
  });

  it('uses every Bayer threshold once, strictly inside (0, 1)', () => {
    expect([...BAYER_4X4].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_unused, rank) => (rank + 0.5) / 16));
  });

  it('packs figure palette words losslessly', () => {
    expect(unpackPaletteWord(packPaletteWord(12, 255, 3))).toEqual({ shirt: 12, hair: 255, skin: 3 });
  });

  it('gives every fixed material a colour and a unique id', () => {
    const ids = Object.values(MAT);
    expect(new Set(ids).size).toBe(ids.length);
    expect(Math.min(...ids)).toBe(1);
    expect(Math.max(...ids)).toBeLessThan(64);
    for (const name of Object.keys(MAT) as (keyof typeof MAT)[]) expect(MAT_COLOR[name]).toBeGreaterThanOrEqual(0);
  });
});

describe('content registry', () => {
  it('lists every catalog object that is neither a path nor a coaster', () => {
    const expected = BUILD_CATALOG
      .filter((definition) => definition.kind !== 'path' && !definition.custom)
      .map((definition) => definition.id)
      .sort();
    expect([...REGISTERED_CONTENT_IDS].sort()).toEqual(expected);
  });
});
