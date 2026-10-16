import { describe, expect, it } from 'vitest';
import { createViewFrame } from '../viewRotation';
import { CAMERA_EASE_MAX_STEP_MS, CAMERA_EASE_MS, easeOutCubic, VoxelCamera } from './camera';
import { createViewTransform, setViewTransform } from './contracts/view';

/**
 * Phase 11 (PA-021): the eased focus. `easeTo` glides over CAMERA_EASE_MS with ease-out cubic; pan, drag and wheel
 * cancel it where it is; a turn, resize or another focus completes it first. Reduced motion (the renderer's choice)
 * is covered in VoxelRenderer.test.ts.
 */

const setUp = (): { camera: VoxelCamera; start: [number, number]; target: [number, number] } => {
  const camera = new VoxelCamera({ zoomOverride: 2 });
  camera.setViewport(1280, 800, 1, 8192);
  camera.setPlotBounds(32, 32);
  camera.focusCell({ x: 4, y: 6 });
  const start: [number, number] = [camera.originX, camera.originY];
  camera.focusCell({ x: 25, y: 20 });
  const target: [number, number] = [camera.originX, camera.originY];
  camera.originX = start[0];
  camera.originY = start[1];
  return { camera, start, target };
};

const distance = (camera: VoxelCamera, target: [number, number]): number =>
  Math.hypot(camera.originX - target[0], camera.originY - target[1]);

describe('voxel camera ease (Phase 11, PA-021)', () => {
  it('reaches the target exactly in 250 ms and then stops', () => {
    const { camera, target } = setUp();
    expect(CAMERA_EASE_MS).toBe(250);
    camera.easeTo(target[0], target[1]);
    expect(camera.easeActive).toBe(true);
    let elapsed = 0;
    while (camera.stepEase(16)) elapsed += 16;
    elapsed += 16;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(250 + 16);
    expect([camera.originX, camera.originY]).toEqual(target);
    expect(camera.easeActive).toBe(false);
    expect(camera.stepEase(16), 'nothing left to do').toBe(false);
    expect([camera.originX, camera.originY]).toEqual(target);
  });

  it('a slow frame advances the glide by at most CAMERA_EASE_MAX_STEP_MS, so a hitch cannot swallow it', () => {
    const { camera, target } = setUp();
    camera.easeTo(target[0], target[1]);
    expect(camera.stepEase(400), 'a 400 ms hitch does not finish a 250 ms glide').toBe(true);
    let steps = 1;
    while (camera.stepEase(400)) steps += 1;
    expect(steps + 1).toBe(Math.ceil(CAMERA_EASE_MS / CAMERA_EASE_MAX_STEP_MS));
    expect([camera.originX, camera.originY]).toEqual(target);
  });

  it('follows a monotone ease-out curve: always closer, fastest at first', () => {
    const { camera, target } = setUp();
    camera.easeTo(target[0], target[1]);
    const distances = [distance(camera, target)];
    while (camera.stepEase(10)) distances.push(distance(camera, target));
    distances.push(distance(camera, target));
    for (let index = 1; index < distances.length; index += 1) expect(distances[index]).toBeLessThan(distances[index - 1]);
    const steps = distances.slice(1).map((value, index) => distances[index] - value);
    expect(steps[0]).toBeGreaterThan(steps[steps.length - 2]);
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
  });

  it('is cancelled where it is by a pan or a wheel', () => {
    for (const input of ['pan', 'wheel'] as const) {
      const { camera, target } = setUp();
      camera.easeTo(target[0], target[1]);
      camera.stepEase(100);
      const mid = [camera.originX, camera.originY];
      if (input === 'pan') camera.panByCss(0, 0);
      else camera.zoomAtCss(10, 10, { deltaY: 30, deltaMode: 0 });
      expect(camera.easeActive, input).toBe(false);
      expect([camera.originX, camera.originY], `${input} stops it where it was`).toEqual(mid);
      camera.stepEase(500);
      expect([camera.originX, camera.originY], `${input}: no more glide`).toEqual(mid);
    }
  });

  it('is completed at once by a turn: the turn starts from the target', () => {
    const frames = [createViewFrame(0, 32, 32), createViewFrame(1, 32, 32)];
    const [from, to] = frames.map((frame) => setViewTransform(frame, createViewTransform()));
    const { camera, target } = setUp();
    camera.easeTo(target[0], target[1]);
    camera.stepEase(60);
    camera.retargetForTurn(from, to);
    expect(camera.easeActive).toBe(false);
    const reference = new VoxelCamera({ zoomOverride: 2 });
    reference.setViewport(1280, 800, 1, 8192);
    reference.originX = target[0];
    reference.originY = target[1];
    reference.retargetForTurn(from, to);
    expect([camera.originX, camera.originY]).toEqual([reference.originX, reference.originY]);
  });

  it('is completed at once by a resize and by a new focus', () => {
    {
      const { camera, target } = setUp();
      camera.easeTo(target[0], target[1]);
      camera.stepEase(60);
      camera.setViewport(1280, 800, 1, 8192);
      expect(camera.easeActive).toBe(false);
      expect([camera.originX, camera.originY], 'same size: exactly at the target').toEqual(target);
    }
    {
      const { camera, target } = setUp();
      camera.easeTo(target[0], target[1]);
      camera.stepEase(60);
      camera.focusCellXY(16, 16);
      expect(camera.easeActive, 'the sweep or a new focus').toBe(false);
      camera.stepEase(100);
      const check = new VoxelCamera({ zoomOverride: 2 });
      check.setViewport(1280, 800, 1, 8192);
      check.focusCellXY(16, 16);
      expect([camera.originX, camera.originY]).toEqual([check.originX, check.originY]);
    }
  });

  it('clamps its target first and snaps when there is nowhere to go', () => {
    const { camera, start } = setUp();
    camera.easeTo(start[0], start[1]);
    expect(camera.easeActive, 'already there').toBe(false);
    camera.easeTo(-1_000_000, -1_000_000);
    while (camera.stepEase(16));
    const outside = new VoxelCamera({ zoomOverride: 2 });
    outside.setViewport(1280, 800, 1, 8192);
    outside.setPlotBounds(32, 32);
    outside.focusWorld(-1_000_000 + 1280 / 2 / 2, -1_000_000 + 800 / 2 / 2);
    expect([camera.originX, camera.originY], 'lands on the clamped point').toEqual([outside.originX, outside.originY]);
  });
});
