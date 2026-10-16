import { describe, expect, it } from 'vitest';
import { createViewFrame, VIEW_ROTATIONS, type ViewRotation } from '../viewRotation';
import { VoxelCamera } from './camera';
import { createViewTransform, setViewTransform, type ViewTransform } from './contracts/view';

/**
 * Phase 26 review (GPU/perf reviewer): the turn recentre must give back the IDENTICAL snapped camera after
 * any sequence of turns that ends in the starting view, at every integer zoom and every screen. A snapped
 * texel or sub-texel offset that differs by one after Q x 4 moves the whole picture by a texel and swaps the
 * world-anchored Bayer phase (ghost, see-through, figure shadows, weather), which the design's pixel round
 * trip (design 5.2) forbids. Reviewer-added. Fixed by the camera's turn chain (retargetForTurn restores the origin
 * it left in a view while only turns moved the camera).
 */

const frames = VIEW_ROTATIONS.map((q) => createViewFrame(q, 32, 32));
const transforms: ViewTransform[] = frames.map((frame) => setViewTransform(frame, createViewTransform()));

const SCREENS: [number, number, number][] = [
  [1280, 800, 1], [1280, 800, 1.25], [1280, 800, 1.5], [1280, 800, 3], [1366, 768, 1], [1920, 1080, 1.25], [1440, 900, 2], [1001, 777, 1],
];

const cameraFor = (css: [number, number, number], zoom: number): VoxelCamera => {
  const camera = new VoxelCamera({ zoomOverride: zoom });
  camera.setViewport(Math.round(css[0] * css[2]), Math.round(css[1] * css[2]), css[2], 8192);
  return camera;
};

const snapKey = (camera: VoxelCamera): string => {
  const snap = camera.snapped();
  return `${snap.texelX},${snap.texelY},${snap.offsetX},${snap.offsetY},${snap.zoom}`;
};

const random = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

describe('camera turn recentre: snapped round trip (review)', () => {
  it('Q x 4 gives back the identical snapped camera at every zoom, screen and pan position', () => {
    const failures: string[] = [];
    const next = random(26);
    for (const css of SCREENS) {
      for (let zoom = 1; zoom <= 12; zoom += 1) {
        const camera = cameraFor(css, zoom);
        if (camera.zoom !== zoom) continue;
        for (let trial = 0; trial < 40; trial += 1) {
          camera.focusCell({ x: Math.floor(next() * 32), y: Math.floor(next() * 32) });
          // Pans as a pointer drag produces them (CSS px times R / N), the common non-dyadic origins.
          camera.panByCss(Math.round(next() * 400 - 200), Math.round(next() * 400 - 200));
          const before = snapKey(camera);
          const origin = [camera.originX, camera.originY];
          for (let turn = 0; turn < 4; turn += 1) camera.retargetForTurn(transforms[turn], transforms[(turn + 1) & 3]);
          const after = snapKey(camera);
          if (after !== before && failures.length < 12) {
            failures.push(`${css.join('x')} zoom ${zoom}: ${before} -> ${after} (origin ${origin.join(', ')} -> ${camera.originX}, ${camera.originY})`);
          }
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('100 random turns ending in the start view give back the identical snapped camera (no drift)', () => {
    const failures: string[] = [];
    const next = random(100);
    for (const css of SCREENS) {
      for (const zoom of [1, 2, 3, 5, 6]) {
        const camera = cameraFor(css, zoom);
        if (camera.zoom !== zoom) continue;
        camera.focusCell({ x: 9, y: 21 });
        camera.panByCss(37, -11);
        const before = snapKey(camera);
        let view: ViewRotation = 0;
        for (let turn = 0; turn < 100; turn += 1) {
          const to = ((view + (next() < 0.5 ? 1 : 3)) & 3) as ViewRotation;
          camera.retargetForTurn(transforms[view], transforms[to]);
          view = to;
        }
        camera.retargetForTurn(transforms[view], transforms[0]);
        const after = snapKey(camera);
        if (after !== before) failures.push(`${css.join('x')} zoom ${zoom}: ${before} -> ${after}`);
      }
    }
    expect(failures).toEqual([]);
  });
});
