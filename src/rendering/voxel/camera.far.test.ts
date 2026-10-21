import { describe, expect, it } from 'vitest';
import { createViewFrame, VIEW_ROTATIONS } from '../viewRotation';
import { VoxelCamera, lowResSize, nearestLevel, zoomLevelList, zoomLevelsFor } from './camera';
import { GUARD_BAND_TEXELS, LOW_RES_TEXEL_BUDGET } from './contracts/budgets';
import { createViewTransform, setViewTransform } from './contracts/view';

/**
 * Phase 55 step 1: the far levels (k = 2 and 4 world texels per low-res texel) in the camera's math. The renderer does
 * not offer them yet (`farLevels` off), so these run the camera with them on.
 */
const MAX_TEXTURE = 8192;
const NOTCH = { deltaY: 100, deltaMode: 0 };

const farCamera = (width: number, height: number, resolution: number, zoom?: number): VoxelCamera => {
  const camera = new VoxelCamera({ farLevels: true, zoomOverride: zoom ?? null });
  camera.setViewport(Math.round(width * resolution), Math.round(height * resolution), resolution, MAX_TEXTURE);
  return camera;
};

const levelsOf = (camera: VoxelCamera): string[] => camera.levelList.map((level) => `${level.zoom}/${level.texelScale}`);

describe('Phase 55: far zoom levels (camera)', () => {
  it('the list is the far levels at the smallest N, then every N; without them it is the old range', () => {
    const levels = zoomLevelsFor(1920, 1080, 1, MAX_TEXTURE);
    expect(zoomLevelList(levels, false).map((level) => `${level.zoom}/${level.texelScale}`)).toEqual(['1/1', '2/1', '3/1', '4/1']);
    expect(levelsOf(farCamera(1920, 1080, 1))).toEqual(['1/4', '1/2', '1/1', '2/1', '3/1', '4/1']);
    // A DPR-2 laptop: N = 2 is the smallest that fits, so its far levels are 2/4 and 2/2 (0.5 and 1 device px per texel).
    expect(levelsOf(farCamera(1440, 900, 2)).slice(0, 3)).toEqual(['2/4', '2/2', '2/1']);
    // The far levels fill the same target as the smallest N: inside the budget.
    const far = farCamera(1920, 1080, 1);
    far.setLevelAtCss(0, 960, 540);
    const snap = far.snapped();
    expect(snap.lowWidth * snap.lowHeight).toBeLessThanOrEqual(LOW_RES_TEXEL_BUDGET);
    expect(snap.lowWidth).toBe(lowResSize(1920, 1));
  });

  it('starts at the k = 1 level it always did, and nearestLevel picks by device px per world texel', () => {
    const camera = farCamera(1920, 1080, 1);
    expect([camera.zoom, camera.texelScale, camera.levelIndex]).toEqual([1, 1, 2]);
    const list = camera.levelList;
    expect(nearestLevel(list, 0.25)).toBe(0);
    expect(nearestLevel(list, 0.5)).toBe(1);
    expect(nearestLevel(list, 0.3)).toBe(0);
    expect(nearestLevel(list, 3)).toBe(4);
    expect(nearestLevel(list, 100)).toBe(list.length - 1);
  });

  it('a 64 x 64 map (about 4,096 x 2,150 texels) fits on 1920 x 1080 at DPR 1 at k = 4; k = 2 shows 94 % of its width', () => {
    const camera = farCamera(1920, 1080, 1);
    camera.setLevelAtCss(0, 960, 540);
    const a = camera.cssToWorld(0, 0);
    const b = camera.cssToWorld(1920, 1080);
    expect(b.x - a.x).toBeGreaterThanOrEqual(4096);
    expect(b.y - a.y).toBeGreaterThanOrEqual(2150);
    camera.setLevelAtCss(1, 960, 540);
    const c = camera.cssToWorld(0, 0);
    const d = camera.cssToWorld(1920, 1080);
    expect((d.x - c.x) / 4096).toBeCloseTo(0.94, 2);
  });

  it('the snapped camera: whole low-res texels, the guard band in world texels, and the upscale inverse', () => {
    for (const [width, height, resolution] of [[1920, 1080, 1], [1280, 800, 1.25], [1440, 900, 2], [1001, 777, 1]] as const) {
      const camera = farCamera(width, height, resolution);
      for (let index = 0; index < 2; index += 1) {
        camera.setLevelAtCss(index, width / 2, height / 2);
        for (let pan = 0; pan < 25; pan += 1) {
          camera.panByCss(((pan * 37) % 23) - 11, ((pan * 53) % 19) - 9);
          const snap = camera.snapped();
          const k = snap.texelScale;
          expect(k).toBe(index === 0 ? 4 : 2);
          expect(Number.isInteger(snap.texelX / k) && Number.isInteger(snap.texelY / k)).toBe(true);
          expect(snap.cameraTexelX).toBe(snap.texelX - GUARD_BAND_TEXELS * k);
          expect(snap.offsetX).toBeLessThanOrEqual(0);
          expect(snap.offsetX).toBeGreaterThanOrEqual(-(snap.zoom - 1));
          // Device px p shows low-res texel floor((p - offset) / N), world texel k times that from the snapped origin.
          for (const deviceX of [0, 1, 7, Math.round(width * resolution) - 1]) {
            const world = camera.cssToWorld(deviceX / resolution, 0).x;
            const lowTexel = Math.floor((deviceX - snap.offsetX) / snap.zoom);
            expect(world).toBeGreaterThanOrEqual(snap.texelX + lowTexel * k - 1e-9);
            expect(world).toBeLessThan(snap.texelX + (lowTexel + 1) * k + 1e-9);
          }
        }
      }
    }
  });

  it('the wheel steps out to the quarter scale and back, keeping the point under the cursor', () => {
    const camera = farCamera(1920, 1080, 1);
    camera.focusCell({ x: 20, y: 20 });
    const under = camera.cssToWorld(700, 400);
    const scales: number[] = [];
    for (let notch = 0; notch < 4; notch += 1) {
      camera.zoomAtCss(700, 400, NOTCH);
      scales.push(camera.texelScale);
      const now = camera.cssToWorld(700, 400);
      // The snap moves the picture by less than one low-res texel.
      expect(Math.abs(now.x - under.x)).toBeLessThan(camera.texelScale + 1e-9);
      expect(Math.abs(now.y - under.y)).toBeLessThan(camera.texelScale + 1e-9);
    }
    expect(scales).toEqual([2, 4, 4, 4]);
    camera.zoomAtCss(700, 400, { deltaY: -100, deltaMode: 0 });
    camera.zoomAtCss(700, 400, { deltaY: -100, deltaMode: 0 });
    expect([camera.zoom, camera.texelScale]).toEqual([1, 1]);
  });

  it('a drag moves the world with the pointer: R x k / N world texels per CSS px', () => {
    const camera = farCamera(1440, 900, 2);
    camera.setLevelAtCss(0, 720, 450);
    const before = camera.originX;
    camera.panByCss(-10, 0);
    expect(camera.originX - before).toBe(10 * 2 * camera.texelScale / camera.zoom);
  });

  it('Q x 4 gives back the identical snapped camera at the far levels too', () => {
    const transforms = VIEW_ROTATIONS.map((q) => setViewTransform(createViewFrame(q, 64, 64), createViewTransform()));
    for (const [width, height, resolution] of [[1920, 1080, 1], [1280, 800, 1.25], [1440, 900, 2]] as const) {
      const camera = farCamera(width, height, resolution);
      for (let index = 0; index < 2; index += 1) {
        camera.setLevelAtCss(index, width / 2, height / 2);
        for (let trial = 0; trial < 20; trial += 1) {
          camera.focusCell({ x: (trial * 7) % 64, y: (trial * 13) % 64 });
          camera.panByCss((trial * 29) % 61 - 30, (trial * 17) % 41 - 20);
          const key = (): string => JSON.stringify(camera.snapped());
          const before = key();
          for (let turn = 0; turn < 4; turn += 1) camera.retargetForTurn(transforms[turn], transforms[(turn + 1) & 3]);
          expect(key()).toBe(before);
        }
      }
    }
  });

  it('a resize keeps a far level; a move to another DPR keeps the park\'s size on screen', () => {
    const camera = farCamera(1920, 1080, 1);
    camera.setLevelAtCss(0, 960, 540);
    camera.setViewport(1600, 900, 1, MAX_TEXTURE);
    expect([camera.zoom, camera.texelScale]).toEqual([1, 4]);
    // To DPR 2: the smallest N becomes 2, so 1 / 4 device px per texel is now 2 / 4 at half the CSS size: 0.5.
    camera.setViewport(3200, 1800, 2, MAX_TEXTURE);
    expect(camera.zoom / camera.texelScale).toBe(0.5);
  });
});
