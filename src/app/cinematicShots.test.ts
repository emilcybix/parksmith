import { describe, expect, it } from 'vitest';
import { MENU_SHOT_COUNT, MENU_SHOT_SECONDS, inwardOf, menuShot, menuShotAt, type ShotScene } from './cinematicShots';
import type { CinematicView } from '../rendering/RendererPort';

const scene: ShotScene = { width: 32, height: 32, focusX: 16, focusY: 18, gateX: 15, gateY: 31, inwardX: 0, inwardY: -1, landmarkX: 10, landmarkY: 8 };
const view = (): CinematicView => ({ eye: [0, 0, 0], target: [0, 0, 0], fovY: 0 });

describe('Phase 41 step 2: the menu shots', () => {
  it('cycles four shots with a cut between them', () => {
    expect(menuShotAt(0)).toEqual({ shot: 0, progress: 0 });
    expect(menuShotAt(MENU_SHOT_SECONDS * 1.5).shot).toBe(1);
    expect(menuShotAt(MENU_SHOT_SECONDS * MENU_SHOT_COUNT).shot).toBe(0);
  });

  it('every shot keeps its eye above the ground and looks at the park', () => {
    for (let seconds = 0; seconds < MENU_SHOT_SECONDS * MENU_SHOT_COUNT; seconds += 0.5) {
      const shot = menuShot(seconds, scene, view());
      expect(shot.eye[2]).toBeGreaterThan(20);
      expect(shot.fovY).toBeGreaterThan(0);
      expect(shot.target[0]).toBeGreaterThan(0);
      expect(shot.target[0]).toBeLessThan(32 * 32);
    }
  });

  it('eases: no jump inside a shot, still at its ends', () => {
    const a = menuShot(MENU_SHOT_SECONDS * 0.5, scene, view()).eye.slice();
    const b = menuShot(MENU_SHOT_SECONDS * 0.5 + 1 / 60, scene, view()).eye.slice();
    expect(Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])).toBeLessThan(10);
    const start = menuShot(0, scene, view()).eye.slice();
    const next = menuShot(1 / 60, scene, view()).eye.slice();
    expect(Math.hypot(start[0] - next[0], start[1] - next[1])).toBeLessThan(0.1);
  });

  it('the dolly walks in from the gate the way guests do', () => {
    const early = menuShot(MENU_SHOT_SECONDS * 1.05, scene, view());
    const late = menuShot(MENU_SHOT_SECONDS * 1.95, scene, view());
    expect(late.eye[1]).toBeLessThan(early.eye[1]);
    expect(inwardOf('north')).toEqual({ x: 0, y: -1 });
    expect(inwardOf('east')).toEqual({ x: 1, y: 0 });
  });
});
