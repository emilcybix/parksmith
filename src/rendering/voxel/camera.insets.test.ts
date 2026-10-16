import { describe, expect, it } from 'vitest';
import { hudInsets } from '../../ui/layoutModel';
import type { ViewInsets } from '../RendererPort';
import { VoxelCamera } from './camera';

/**
 * Phase 36 (the Phase 11 item "at 1100x690 panning up can leave the plot just behind the build dock"): in headless
 * Chromium a long pan up or left at 1100x690 parked the whole Meadow plot behind the dock or Park Pulse, because the
 * clamp kept a plot cell under the VIEWPORT, not under the part of it the HUD leaves uncovered. With the HUD's insets
 * the clamp works on the uncovered rectangle; without them it is the Phase 11 clamp, bit for bit.
 */

const MAX_TEXTURE = 8192;
const SCREENS: [number, number, number][] = [];
for (const [width, height] of [[1100, 690], [1280, 800], [1366, 768], [1920, 1080]]) {
  for (const dpr of [1, 2]) SCREENS.push([width, height, dpr]);
}

const cameraFor = (screen: [number, number, number], zoom: number): VoxelCamera => {
  const camera = new VoxelCamera({ zoomOverride: zoom });
  camera.setViewport(Math.round(screen[0] * screen[2]), Math.round(screen[1] * screen[2]), screen[2], MAX_TEXTURE);
  return camera;
};

const zoomsFor = (screen: [number, number, number]): number[] => {
  const levels = cameraFor(screen, 1).zoomLevels;
  return Array.from({ length: levels.max - levels.min + 1 }, (_unused, index) => levels.min + index);
};

/** True when some plot cell's centre lies inside the rectangle the insets leave uncovered (CSS px → texels). */
const plotCellInSafeArea = (camera: VoxelCamera, screen: [number, number, number], insets: ViewInsets, size: number): boolean => {
  const toTexels = screen[2] / camera.zoom;
  const left = camera.originX + insets.left * toTexels;
  const right = camera.originX + (screen[0] - insets.right) * toTexels;
  const top = camera.originY + insets.top * toTexels;
  const bottom = camera.originY + (screen[1] - insets.bottom) * toTexels;
  for (let u = 0; u < size; u += 1) {
    for (let v = 0; v < size; v += 1) {
      const x = (u - v) * 32;
      const y = (u + v + 1) * 16;
      if (x >= left && x <= right && y >= top && y <= bottom) return true;
    }
  }
  return false;
};

const PANS: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0], [1, 1], [-1, -1], [1, -1], [-1, 1]];

describe('Phase 36: the camera clamp keeps a plot cell clear of the HUD', () => {
  it('after a long pan in any direction a Meadow plot cell is in the uncovered area, at every audited screen and zoom', () => {
    const insets = hudInsets(1, false);
    const failures: string[] = [];
    for (const screen of SCREENS) {
      for (const zoom of zoomsFor(screen)) {
        for (const [dx, dy] of PANS) {
          const camera = cameraFor(screen, zoom);
          camera.setPlotBounds(32, 32);
          camera.setSafeInsets(insets);
          // Panning drags the world with the pointer: a positive dy moves the view up (north).
          camera.panByCss(dx * 100_000, dy * 100_000);
          if (!plotCellInSafeArea(camera, screen, insets, 32) && failures.length < 12) {
            failures.push(`${screen.join('x')} zoom ${zoom} pan ${dx},${dy}`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('the old clamp (no insets) can leave the plot behind the dock at 1100x690: the case this fixes', () => {
    const insets = hudInsets(1, false);
    const camera = cameraFor([1100, 690, 1], 2);
    camera.setPlotBounds(32, 32);
    camera.panByCss(0, 100_000);
    expect(plotCellInSafeArea(camera, [1100, 690, 1], insets, 32)).toBe(false);
    camera.setSafeInsets(insets);
    camera.panByCss(0, 1);
    expect(plotCellInSafeArea(camera, [1100, 690, 1], insets, 32)).toBe(true);
  });

  it('setting insets moves nothing by itself, and null insets clamp exactly like a camera that never had any', () => {
    const plain = cameraFor([1280, 800, 1], 2);
    const reset = cameraFor([1280, 800, 1], 2);
    for (const camera of [plain, reset]) camera.setPlotBounds(32, 32);
    const before = [reset.originX, reset.originY];
    reset.setSafeInsets(hudInsets(1, false));
    expect([reset.originX, reset.originY]).toEqual(before);
    reset.setSafeInsets(null);
    for (const [dx, dy] of PANS) {
      plain.panByCss(dx * 50_000, dy * 37_000);
      reset.panByCss(dx * 50_000, dy * 37_000);
      expect([reset.originX, reset.originY]).toEqual([plain.originX, plain.originY]);
    }
  });

  it('a focus with insets puts the cell in the middle of the uncovered area', () => {
    const camera = cameraFor([1100, 690, 1], 2);
    camera.setPlotBounds(32, 32);
    const insets = hudInsets(1, true);
    const at = camera.safeCentreFractions(insets);
    expect(at.x).toBeCloseTo((58 + (1100 - 592)) / 2 / 1100);
    expect(at.y).toBeCloseTo((94 + (690 - insets.bottom)) / 2 / 690);
    camera.focusCellXY(16, 16, at.x, at.y);
    const world = camera.cssToWorld(at.x * 1100, at.y * 690);
    expect(world.x).toBeCloseTo((16 - 16) * 32, 0);
    expect(world.y).toBeCloseTo((16 + 16) * 16, 0);
    // Without insets the fractions are the middle, as before.
    expect(camera.safeCentreFractions(null)).toEqual({ x: 0.5, y: 0.5 });
  });
});
