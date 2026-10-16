import type { CinematicView } from '../rendering/RendererPort';

/**
 * Phase 41 step 2: the start screen's cinematic shots, pure. A fixed cycle of shots, each `MENU_SHOT_SECONDS` long with
 * a cut between them (no blend: a cut reads as film, a blend through the middle of the park looks lost):
 *   0 a slow orbit round the park, high and wide;
 *   1 a low dolly in from the gate along the way guests walk in, looking ahead and a little down;
 *   2 a rise over the landmark (the first coaster or the tallest ride), circling it;
 *   3 a lower orbit the other way round, closer in.
 * Inside a shot the motion eases in and out (smoothstep), so a cut never lands mid-whip. World voxels, z up.
 */
export const MENU_SHOT_SECONDS = 14;
export const MENU_SHOT_COUNT = 4;
const TILE = 32;
const FOV = (50 * Math.PI) / 180;

export interface ShotScene {
  /** The map in tiles. */
  width: number;
  height: number;
  /** The middle of the built park (tiles). */
  focusX: number;
  focusY: number;
  /** The gate (tiles) and the way guests walk in from it (a unit cardinal vector). */
  gateX: number;
  gateY: number;
  inwardX: number;
  inwardY: number;
  /** What the rising shot circles (tiles), or null to circle the focus. */
  landmarkX: number | null;
  landmarkY: number | null;
}

const smooth = (t: number): number => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

/**
 * The menu card covers the left of the screen, so every shot frames its subject right of the middle: the look point
 * moves left along the camera's right vector by `MENU_FRAMING` of the eye's horizontal distance to it.
 */
export const MENU_FRAMING = 0.22;

const set = (out: CinematicView, ex: number, ey: number, ez: number, tx: number, ty: number, tz: number): CinematicView => {
  const dx = tx - ex;
  const dy = ty - ey;
  const flat = Math.hypot(dx, dy) || 1;
  // Right of the view direction (z up): (dy, -dx) normalised.
  const rightX = dy / flat;
  const rightY = -dx / flat;
  out.eye[0] = ex; out.eye[1] = ey; out.eye[2] = ez;
  out.target[0] = tx - rightX * flat * MENU_FRAMING;
  out.target[1] = ty - rightY * flat * MENU_FRAMING;
  out.target[2] = tz;
  out.fovY = FOV;
  return out;
};

/** Which shot plays `seconds` after the menu opened, and how far through it (0..1). */
export const menuShotAt = (seconds: number): { shot: number; progress: number } => {
  const time = Math.max(0, seconds);
  return { shot: Math.floor(time / MENU_SHOT_SECONDS) % MENU_SHOT_COUNT, progress: (time % MENU_SHOT_SECONDS) / MENU_SHOT_SECONDS };
};

export const menuShot = (seconds: number, scene: Readonly<ShotScene>, out: CinematicView): CinematicView => {
  const { shot, progress } = menuShotAt(seconds);
  const eased = smooth(progress);
  const size = Math.max(scene.width, scene.height) * TILE;
  const fx = (scene.focusX + 0.5) * TILE;
  const fy = (scene.focusY + 0.5) * TILE;
  switch (shot) {
    case 0: {
      const angle = 0.6 + eased * 0.9;
      const radius = 0.62 * size;
      return set(out, fx + radius * Math.cos(angle), fy + radius * Math.sin(angle), 0.38 * size, fx, fy, 0);
    }
    case 1: {
      const gx = (scene.gateX + 0.5) * TILE;
      const gy = (scene.gateY + 0.5) * TILE;
      const along = (1 + eased * 9) * TILE;
      const ex = gx + scene.inwardX * along;
      const ey = gy + scene.inwardY * along;
      return set(out, ex, ey, 26, ex + scene.inwardX * 6 * TILE, ey + scene.inwardY * 6 * TILE, 8);
    }
    case 2: {
      const lx = ((scene.landmarkX ?? scene.focusX) + 0.5) * TILE;
      const ly = ((scene.landmarkY ?? scene.focusY) + 0.5) * TILE;
      const angle = 2.2 - eased * 1.1;
      const radius = 8 * TILE;
      return set(out, lx + radius * Math.cos(angle), ly + radius * Math.sin(angle), 70 + eased * 170, lx, ly, 30 + eased * 20);
    }
    default: {
      const angle = 4.0 - eased * 0.8;
      const radius = 0.4 * size;
      return set(out, fx + radius * Math.cos(angle), fy + radius * Math.sin(angle), 0.18 * size, fx, fy, 10);
    }
  }
};

/** The unit vector of a gate facing (the way guests walk in). */
export const inwardOf = (facing: 'north' | 'south' | 'east' | 'west'): { x: number; y: number } => {
  switch (facing) {
    case 'north': return { x: 0, y: -1 };
    case 'south': return { x: 0, y: 1 };
    case 'east': return { x: 1, y: 0 };
    default: return { x: -1, y: 0 };
  }
};
