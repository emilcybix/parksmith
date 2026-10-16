import { describe, expect, it } from 'vitest';
import { createViewFrame, VIEW_ROTATIONS, viewMapSize, type ViewRotation } from '../viewRotation';
import { plotMarginCells, VoxelCamera } from './camera';
import { createViewTransform, setViewTransform, type ViewTransform } from './contracts/view';

/**
 * Phase 11 (PA-021): the voxel camera clamp. The ground point under the viewport centre stays inside the plot
 * rectangle (view cells) expanded by `plotMarginCells`, so a plot cell is always on screen, and the clamp is a
 * strict no-op for a camera that stays inside (no float drift, the entrance framing and the turn chain untouched).
 */

const MAX_TEXTURE = 8192;

/** The audited viewports (CSS px) at DPR 1 and 2. */
const SCREENS: [number, number, number][] = [];
for (const [width, height] of [[1100, 690], [1280, 800], [1366, 768], [1440, 900], [1920, 1080]]) {
  for (const dpr of [1, 2]) SCREENS.push([width, height, dpr]);
}

/** Meadow (32 x 32) and a non-square generated map. */
const MAPS: [number, number][] = [[32, 32], [40, 24]];

const random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
};

const cameraFor = (screen: [number, number, number], zoom: number): VoxelCamera => {
  const camera = new VoxelCamera({ zoomOverride: zoom });
  camera.setViewport(Math.round(screen[0] * screen[2]), Math.round(screen[1] * screen[2]), screen[2], MAX_TEXTURE);
  return camera;
};

const zoomsFor = (screen: [number, number, number]): number[] => {
  const levels = cameraFor(screen, 1).zoomLevels;
  return Array.from({ length: levels.max - levels.min + 1 }, (_unused, index) => levels.min + index);
};

const deviceOf = (screen: [number, number, number]): [number, number] =>
  [Math.round(screen[0] * screen[2]), Math.round(screen[1] * screen[2])];

/** True when some plot cell's centre (view cells, ground plane) lies inside the viewport. */
const plotCellVisible = (camera: VoxelCamera, device: [number, number], width: number, height: number): boolean => {
  const right = camera.originX + device[0] / camera.zoom;
  const bottom = camera.originY + device[1] / camera.zoom;
  for (let u = 0; u < width; u += 1) {
    for (let v = 0; v < height; v += 1) {
      const x = (u - v) * 32;
      const y = (u + v + 1) * 16;
      if (x >= camera.originX && x <= right && y >= camera.originY && y <= bottom) return true;
    }
  }
  return false;
};

/** The ground point (view cells) under the viewport centre. */
const centreGround = (camera: VoxelCamera, device: [number, number]): [number, number] => {
  const cx = camera.originX + device[0] / 2 / camera.zoom;
  const cy = camera.originY + device[1] / 2 / camera.zoom;
  return [(cx / 32 + cy / 16) / 2, (cy / 16 - cx / 32) / 2];
};

describe('voxel camera clamp (Phase 11, PA-021)', () => {
  it('keeps at least one plot cell on screen after random pan, zoom, focus and turn sequences, at every audited size, zoom and view', () => {
    const failures: string[] = [];
    const next = random(11);
    for (const [mapWidth, mapHeight] of MAPS) {
      const frames = VIEW_ROTATIONS.map((q) => createViewFrame(q, mapWidth, mapHeight));
      const transforms: ViewTransform[] = frames.map((frame) => setViewTransform(frame, createViewTransform()));
      for (const screen of SCREENS) {
        const device = deviceOf(screen);
        for (const zoom of zoomsFor(screen)) {
          for (const startView of VIEW_ROTATIONS) {
            const camera = cameraFor(screen, zoom);
            let view: ViewRotation = startView;
            const bounds = (): void => {
              const size = viewMapSize(frames[view]);
              camera.setPlotBounds(size.width, size.height);
            };
            bounds();
            for (let step = 0; step < 24; step += 1) {
              const pick = next();
              if (pick < 0.4) {
                camera.panByCss(Math.round(next() * 6000 - 3000), Math.round(next() * 6000 - 3000));
              } else if (pick < 0.55) {
                camera.zoomAtCss(next() * screen[0], next() * screen[1], { deltaY: next() < 0.5 ? -100 : 100, deltaMode: 0 });
              } else if (pick < 0.75) {
                camera.focusCell({ x: Math.floor(next() * 120) - 40, y: Math.floor(next() * 120) - 40 });
              } else if (pick < 0.85) {
                camera.focusWorld(next() * 8000 - 4000, next() * 8000 - 4000, next(), next());
              } else {
                const to = ((view + (next() < 0.5 ? 1 : 3)) & 3) as ViewRotation;
                camera.retargetForTurn(transforms[view], transforms[to]);
                view = to;
                bounds();
              }
              const size = viewMapSize(frames[view]);
              if (!plotCellVisible(camera, device, size.width, size.height) && failures.length < 12) {
                failures.push(`${mapWidth}x${mapHeight} ${screen.join('x')} zoom ${camera.zoom} view ${view} step ${step}: centre ${centreGround(camera, device).join(', ')}`);
              }
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('pins the centre ground point inside the expanded plot rectangle', () => {
    const camera = cameraFor([1280, 800, 1], 2);
    camera.setPlotBounds(32, 32);
    camera.panByCss(-100_000, 0);
    const [gx, gy] = centreGround(camera, [1280, 800]);
    const margin = plotMarginCells(1280 / 2 / 2, 800 / 2 / 2);
    expect(margin).toBeCloseTo(Math.max(2, 200 / 64 - 1));
    expect(gx).toBeGreaterThanOrEqual(-margin - 1e-9);
    expect(gx).toBeLessThanOrEqual(32 + margin + 1e-9);
    expect(gy).toBeGreaterThanOrEqual(-margin - 1e-9);
    expect(gy).toBeLessThanOrEqual(32 + margin + 1e-9);
    expect(Math.abs(gx - 32 - margin) < 1e-9 || Math.abs(gy + margin) < 1e-9, 'it slides along an edge').toBe(true);
  });

  it('is bit-identical to an unclamped camera while the camera stays inside the plot', () => {
    const next = random(7);
    let compared = 0;
    for (const screen of SCREENS) {
      const device = deviceOf(screen);
      for (const zoom of zoomsFor(screen)) {
        const clamped = cameraFor(screen, zoom);
        const free = cameraFor(screen, zoom);
        clamped.setPlotBounds(32, 32);
        for (let step = 0; step < 40; step += 1) {
          const pick = next();
          const apply = (camera: VoxelCamera, values: number[]): void => {
            if (pick < 0.5) camera.panByCss(values[0], values[1]);
            else if (pick < 0.7) camera.zoomAtCss(values[2], values[3], { deltaY: values[4], deltaMode: 0 });
            else camera.focusCell({ x: values[5], y: values[6] });
          };
          const values = [
            Math.round(next() * 200 - 100), Math.round(next() * 200 - 100),
            next() * screen[0], next() * screen[1], next() < 0.5 ? -100 : 100,
            Math.floor(next() * 28) + 2, Math.floor(next() * 28) + 2,
          ];
          apply(free, values);
          const [gx, gy] = centreGround(free, device);
          const margin = plotMarginCells(device[0] / 2 / free.zoom, device[1] / 2 / free.zoom);
          const inside = gx >= -margin && gx <= 32 + margin && gy >= -margin && gy <= 32 + margin;
          apply(clamped, values);
          if (inside) {
            compared += 1;
            expect([clamped.originX, clamped.originY, clamped.zoom]).toEqual([free.originX, free.originY, free.zoom]);
          } else {
            // Re-sync both on a plot cell (absolute) before going on.
            free.focusCell({ x: 16, y: 16 });
            clamped.focusCell({ x: 16, y: 16 });
            expect([clamped.originX, clamped.originY]).toEqual([free.originX, free.originY]);
          }
        }
      }
    }
    expect(compared).toBeGreaterThan(500);
  });

  it('never moves the entrance framing, at every audited size, zoom and view', () => {
    const failures: string[] = [];
    for (const [mapWidth, mapHeight] of MAPS) {
      // Gates on each edge, Meadow's (15, 31) first.
      const gates: [number, number][] = [[15, mapHeight - 1], [0, Math.floor(mapHeight / 2)], [Math.floor(mapWidth / 2), 0], [mapWidth - 1, 3]];
      for (const screen of SCREENS) {
        for (const zoom of zoomsFor(screen)) {
          for (const q of VIEW_ROTATIONS) {
            const frame = createViewFrame(q, mapWidth, mapHeight);
            const size = viewMapSize(frame);
            for (const [gx, gy] of gates) {
              const free = cameraFor(screen, zoom);
              const clamped = cameraFor(screen, zoom);
              clamped.setPlotBounds(size.width, size.height);
              free.focusEntranceInView(frame, gx, gy);
              clamped.focusEntranceInView(frame, gx, gy);
              if ((clamped.originX !== free.originX || clamped.originY !== free.originY) && failures.length < 12) {
                failures.push(`${mapWidth}x${mapHeight} gate ${gx},${gy} ${screen.join('x')} zoom ${zoom} view ${q}`);
              }
            }
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('does nothing without plot bounds (0 x 0), and setting bounds moves nothing by itself', () => {
    const camera = cameraFor([1280, 800, 1], 1);
    camera.panByCss(-100_000, 50_000);
    const far = [camera.originX, camera.originY];
    expect(far[0]).toBeGreaterThan(90_000);
    camera.setPlotBounds(32, 32);
    expect([camera.originX, camera.originY]).toEqual(far);
    camera.panByCss(0, 0);
    expect(camera.originX, 'the next move clamps').toBeLessThan(far[0]);
  });
});
