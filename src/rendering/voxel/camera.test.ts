import { describe, expect, it } from 'vitest';
import { cellToWorld } from '../isometric';
import { pickCell } from '../worldInput';
import { cellToView, createViewFrame, VIEW_ROTATIONS } from '../viewRotation';
import { lowResSize, VoxelCamera, zoomLevelsFor } from './camera';
import { createViewTransform, setViewTransform, voxelFromView, type ViewTransform } from './contracts/view';
import { GUARD_BAND_TEXELS, LOW_RES_TEXEL_BUDGET, MAX_ZOOM_CSS_PER_TEXEL } from './contracts/budgets';

/**
 * The camera is where "crisp pixels" and "fast on a low-tier machine" meet: integer zoom, a
 * texel-snapped origin, and a low-res target that never exceeds the texel budget. Picking inverts
 * the same snapped transform the upscale draws with, so a click can never land one texel off.
 */

const MAX_TEXTURE = 8192;

interface Screen {
  name: string;
  css: [number, number];
  resolution: number;
  /** Expected [Nmin, Nmax, N0], worked out by hand from design §3. */
  levels: [number, number, number];
}

/** Pixi's autoDensity backing store: round(css · R) device px. */
const deviceSize = (screen: Screen): [number, number] =>
  [Math.round(screen.css[0] * screen.resolution), Math.round(screen.css[1] * screen.resolution)];

const SCREENS: Screen[] = [
  { name: '1280×800 @1', css: [1280, 800], resolution: 1, levels: [1, 4, 1] },
  { name: '1280×800 @1.25', css: [1280, 800], resolution: 1.25, levels: [1, 5, 1] },
  { name: '1280×800 @1.5', css: [1280, 800], resolution: 1.5, levels: [2, 6, 2] },
  { name: '1280×800 @2', css: [1280, 800], resolution: 2, levels: [2, 8, 2] },
  { name: '1280×800 @3', css: [1280, 800], resolution: 3, levels: [3, 12, 3] },
  { name: '1920×1080 @1', css: [1920, 1080], resolution: 1, levels: [1, 4, 1] },
  { name: '1920×1080 @1.25', css: [1920, 1080], resolution: 1.25, levels: [2, 5, 2] },
  { name: '1920×1080 @1.5', css: [1920, 1080], resolution: 1.5, levels: [2, 6, 2] },
  { name: '1920×1080 @2', css: [1920, 1080], resolution: 2, levels: [2, 8, 2] },
  { name: '1920×1080 @3', css: [1920, 1080], resolution: 3, levels: [3, 12, 3] },
  { name: '1440×900 @2 (laptop)', css: [1440, 900], resolution: 2, levels: [2, 8, 2] },
  { name: '393×851 @3 (phone)', css: [393, 851], resolution: 3, levels: [2, 12, 3] },
];

const cameraFor = (screen: Screen, zoomOverride: number | null = null): VoxelCamera => {
  const camera = new VoxelCamera({ zoomOverride });
  const [width, height] = deviceSize(screen);
  camera.setViewport(width, height, screen.resolution, MAX_TEXTURE);
  return camera;
};

/** A deterministic stream of numbers in [0, 1), so failures reproduce. */
const randomStream = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 4_294_967_296;
  };
};

const zoomsOf = (camera: VoxelCamera): number[] => {
  const { min, max } = camera.zoomLevels;
  return Array.from({ length: max - min + 1 }, (_unused, index) => min + index);
};

/** Wheel steps of ±100 units (one notch) at a CSS point, until the camera reaches `zoom`. */
const wheelTo = (camera: VoxelCamera, zoom: number, x = 0, y = 0): void => {
  for (let guard = 0; camera.zoom !== zoom && guard < 64; guard += 1) {
    camera.zoomAtCss(x, y, { deltaY: camera.zoom < zoom ? -100 : 100, deltaMode: 0 });
  }
  expect(camera.zoom).toBe(zoom);
};

describe('voxel camera zoom levels', () => {
  it.each(SCREENS)('derives Nmin, Nmax and N0 for $name', (screen) => {
    const [width, height] = deviceSize(screen);
    const levels = zoomLevelsFor(width, height, screen.resolution, MAX_TEXTURE);
    expect([levels.min, levels.max, levels.initial]).toEqual(screen.levels);
    expect(levels.max).toBe(Math.max(levels.min + 1, Math.floor(MAX_ZOOM_CSS_PER_TEXEL * screen.resolution)));
    expect(cameraFor(screen).zoom).toBe(levels.initial);
  });

  it.each(SCREENS)('keeps the low-res target inside the texel budget at every level for $name', (screen) => {
    const [width, height] = deviceSize(screen);
    const camera = cameraFor(screen);
    const { min } = camera.zoomLevels;
    const texels = (zoom: number): number => lowResSize(width, zoom) * lowResSize(height, zoom);
    for (const zoom of zoomsOf(camera)) expect(texels(zoom)).toBeLessThanOrEqual(LOW_RES_TEXEL_BUDGET);
    // Nmin is the smallest level that fits, not merely one that does.
    if (min > 1) expect(texels(min - 1)).toBeGreaterThan(LOW_RES_TEXEL_BUDGET);
  });

  it('also respects the GPU texture and viewport limit', () => {
    const levels = zoomLevelsFor(9000, 100, 1, 8192);
    expect(lowResSize(9000, 1)).toBeGreaterThan(8192);
    expect(levels.min).toBe(2);
    expect(zoomLevelsFor(9000, 100, 1, 16_384).min).toBe(1);
  });

  it('starts at the &zoom= override, clamped into the levels', () => {
    const laptop = SCREENS[0];
    expect(cameraFor(laptop, 3).zoom).toBe(3);
    expect(cameraFor(laptop, 99).zoom).toBe(4);
    expect(cameraFor(SCREENS[4], 1).zoom, 'the override went under the budget').toBe(3);
  });
});

describe('voxel camera snapping', () => {
  it.each(SCREENS)('snaps to whole texels with a device-px offset in [−(N−1), 0] for $name', (screen) => {
    const random = randomStream(17);
    const camera = cameraFor(screen);
    const [width, height] = deviceSize(screen);
    for (const zoom of zoomsOf(camera)) {
      wheelTo(camera, zoom);
      for (let sample = 0; sample < 200; sample += 1) {
        camera.originX = (random() - 0.5) * 6000;
        camera.originY = (random() - 0.5) * 4000;
        const snap = camera.snapped();
        expect(snap.zoom).toBe(zoom);
        expect(Number.isInteger(snap.texelX) && Number.isInteger(snap.texelY)).toBe(true);
        expect(snap.offsetX).toBeGreaterThanOrEqual(-(zoom - 1));
        expect(snap.offsetX).toBeLessThanOrEqual(0);
        expect(snap.offsetY).toBeGreaterThanOrEqual(-(zoom - 1));
        expect(snap.offsetY).toBeLessThanOrEqual(0);
        expect(Number.isInteger(snap.offsetX) && Number.isInteger(snap.offsetY)).toBe(true);
        expect(snap.cameraTexelX).toBe(snap.texelX - GUARD_BAND_TEXELS);
        expect(snap.cameraTexelY).toBe(snap.texelY - GUARD_BAND_TEXELS);
        expect([snap.lowWidth, snap.lowHeight]).toEqual([lowResSize(width, zoom), lowResSize(height, zoom)]);
        // Every device pixel samples a texel inside the target, a full guard band from each edge.
        for (const [pixels, offset, low] of [[width, snap.offsetX, snap.lowWidth], [height, snap.offsetY, snap.lowHeight]]) {
          const first = Math.floor((0 - offset) / zoom) + GUARD_BAND_TEXELS;
          const last = Math.floor((pixels - 1 - offset) / zoom) + GUARD_BAND_TEXELS;
          expect(first).toBe(GUARD_BAND_TEXELS);
          expect(last).toBeLessThanOrEqual(low - 1 - GUARD_BAND_TEXELS);
        }
      }
    }
  });

  it('moves the picture by less than one device pixel when it snaps', () => {
    const camera = cameraFor(SCREENS[3]);
    const random = randomStream(5);
    for (const zoom of zoomsOf(camera)) {
      wheelTo(camera, zoom);
      for (let sample = 0; sample < 100; sample += 1) {
        camera.originX = random() * 1000;
        camera.originY = random() * 1000;
        const snap = camera.snapped();
        // Where the snapped picture puts the float origin, in device px from the canvas corner.
        const shownX = (camera.originX - snap.texelX) * zoom + snap.offsetX;
        const shownY = (camera.originY - snap.texelY) * zoom + snap.offsetY;
        expect(shownX).toBeGreaterThanOrEqual(0);
        expect(shownX).toBeLessThan(1);
        expect(shownY).toBeGreaterThanOrEqual(0);
        expect(shownY).toBeLessThan(1);
      }
    }
  });

  it.each(SCREENS)('picks through exactly the texel the upscale draws, at every level, for $name', (screen) => {
    const random = randomStream(99);
    const camera = cameraFor(screen);
    const [width, height] = deviceSize(screen);
    for (const zoom of zoomsOf(camera)) {
      wheelTo(camera, zoom);
      for (let sample = 0; sample < 100; sample += 1) {
        camera.originX = (random() - 0.5) * 3000;
        camera.originY = (random() - 0.5) * 3000;
        const snap = camera.snapped();
        // The centre of a random device pixel, as a pointer event would report it in CSS px.
        const pixelX = Math.floor(random() * width);
        const pixelY = Math.floor(random() * height);
        const world = camera.cssToWorld((pixelX + 0.5) / screen.resolution, (pixelY + 0.5) / screen.resolution);
        // The upscale: device px p shows low-res texel floor((p − offset) / N) + G.
        const lowX = Math.floor((pixelX - snap.offsetX) / zoom) + GUARD_BAND_TEXELS;
        const lowY = Math.floor((pixelY - snap.offsetY) / zoom) + GUARD_BAND_TEXELS;
        expect(Math.floor(world.x)).toBe(lowX + snap.cameraTexelX);
        expect(Math.floor(world.y)).toBe(lowY + snap.cameraTexelY);
        expect(world.x).toBeCloseTo((pixelX + 0.5 - snap.offsetX) / zoom + snap.texelX, 9);
        expect(world.y).toBeCloseTo((pixelY + 0.5 - snap.offsetY) / zoom + snap.texelY, 9);
      }
    }
  });
});

/** Meadow's gate on its 32 x 32 map, in the one view that puts it at the bottom of the picture. */
const MEADOW_GATE = { x: 15, y: 31 };
const MEADOW_VIEW = createViewFrame(0, 32, 32);

describe('voxel camera wheel zoom', () => {
  it('keeps the world point under the cursor within one texel', () => {
    const random = randomStream(3);
    for (const screen of SCREENS) {
      const camera = cameraFor(screen);
      camera.focusEntranceInView(MEADOW_VIEW, MEADOW_GATE.x, MEADOW_GATE.y);
      const { width, height } = camera.cssSize();
      for (let step = 0; step < 60; step += 1) {
        const cursor = { x: random() * width, y: random() * height };
        const before = camera.cssToWorld(cursor.x, cursor.y);
        const zoom = camera.zoom;
        camera.zoomAtCss(cursor.x, cursor.y, { deltaY: random() < 0.5 ? -100 : 100, deltaMode: 0 });
        const after = camera.cssToWorld(cursor.x, cursor.y);
        if (camera.zoom === zoom) continue;
        expect(Math.abs(after.x - before.x), `${screen.name} x`).toBeLessThan(1);
        expect(Math.abs(after.y - before.y), `${screen.name} y`).toBeLessThan(1);
      }
    }
  });

  it('steps one level per 100 units, accumulating small deltas and normalising lines and pages', () => {
    const camera = cameraFor(SCREENS[0], 3);
    const wheel = (deltaY: number, deltaMode = 0): void => camera.zoomAtCss(640, 400, { deltaY, deltaMode });
    wheel(40);
    wheel(40);
    expect(camera.zoom, 'a partial notch zoomed').toBe(3);
    wheel(40);
    expect(camera.zoom).toBe(2);
    wheel(-60);
    wheel(-40);
    expect(camera.zoom, 'reversing kept the old direction\'s remainder').toBe(3);
    wheel(-3, 1);
    wheel(-3, 1);
    expect(camera.zoom, 'two notches of three lines are 96 units').toBe(3);
    wheel(-3, 1);
    expect(camera.zoom, 'lines are 16 px each').toBe(4);
    wheel(1, 2);
    expect(camera.zoom, 'a page is a viewport height').toBe(1);
  });

  it('drops the accumulated wheel at a limit, so the first notch back responds', () => {
    const camera = cameraFor(SCREENS[0]);
    for (let notch = 0; notch < 10; notch += 1) camera.zoomAtCss(0, 0, { deltaY: -100, deltaMode: 0 });
    expect(camera.zoom).toBe(camera.zoomLevels.max);
    camera.zoomAtCss(0, 0, { deltaY: -950, deltaMode: 0 });
    camera.zoomAtCss(0, 0, { deltaY: 100, deltaMode: 0 });
    expect(camera.zoom).toBe(camera.zoomLevels.max - 1);
    camera.zoomAtCss(0, 0, { deltaY: 0, deltaMode: 0 });
    camera.zoomAtCss(0, 0, { deltaY: Number.NaN, deltaMode: 0 });
    expect(camera.zoom).toBe(camera.zoomLevels.max - 1);
  });
});

describe('voxel camera pan, focus and resize', () => {
  it('pans by Δcss · R / N texels, following the pointer', () => {
    const camera = cameraFor(SCREENS[3], 4);
    camera.originX = 100;
    camera.originY = 50;
    camera.panByCss(30, -12);
    expect(camera.originX).toBeCloseTo(100 - 30 * 2 / 4, 12);
    expect(camera.originY).toBeCloseTo(50 + 12 * 2 / 4, 12);
  });

  it('centres a cell\'s top vertex, like the classic camera', () => {
    for (const screen of SCREENS) {
      const camera = cameraFor(screen);
      const { width, height } = camera.cssSize();
      for (const zoom of zoomsOf(camera)) {
        wheelTo(camera, zoom);
        for (const cell of [{ x: 0, y: 0 }, { x: 13.25, y: 7.5 }, { x: 31, y: 31 }]) {
          camera.focusCell(cell);
          const centre = camera.cssToWorld(width / 2, height / 2);
          const expected = cellToWorld(cell);
          expect(Math.abs(centre.x - expected.x)).toBeLessThan(1);
          expect(Math.abs(centre.y - expected.y)).toBeLessThan(1);
        }
      }
    }
  });

  it('centres a fractional cell coordinate exactly like focusCell, without a Cell object (the sweep\'s per-frame call)', () => {
    for (const screen of SCREENS) {
      const a = cameraFor(screen);
      const b = cameraFor(screen);
      for (const [x, y] of [[0, 0], [13.25, 7.5], [16, 16], [31.9, 2.1]]) {
        a.focusCell({ x, y });
        b.focusCellXY(x, y);
        expect(b.originX).toBeCloseTo(a.originX, 9);
        expect(b.originY).toBeCloseTo(a.originY, 9);
      }
    }
  });

  it('frames the entrance the way the classic camera does', () => {
    for (const screen of SCREENS) {
      const camera = cameraFor(screen);
      const { width, height } = camera.cssSize();
      camera.focusEntranceInView(MEADOW_VIEW, MEADOW_GATE.x, MEADOW_GATE.y);
      const shown = camera.cssToWorld(width * 0.5, height * 0.18);
      const expected = cellToWorld({ x: 15.5, y: 20 });
      expect(Math.abs(shown.x - expected.x), screen.name).toBeLessThan(1);
      expect(Math.abs(shown.y - expected.y), screen.name).toBeLessThan(1);
    }
  });

  it('keeps the viewport centre and the zoom through a resize, clamping the zoom to the new levels', () => {
    const camera = cameraFor(SCREENS[5]);
    const target = cellToWorld({ x: 9, y: 21 });
    const expectCentred = (cssWidth: number, cssHeight: number): void => {
      const centre = camera.cssToWorld(cssWidth / 2, cssHeight / 2);
      expect(Math.abs(centre.x - target.x)).toBeLessThan(1);
      expect(Math.abs(centre.y - target.y)).toBeLessThan(1);
    };
    camera.focusCell({ x: 9, y: 21 });
    camera.setViewport(1280, 800, 1, MAX_TEXTURE);
    expect(camera.zoom).toBe(1);
    expectCentred(1280, 800);
    // At N = 1 or 2 a 4000×3000 canvas would blow the texel budget, so the zoom is pushed up to 3.
    camera.setViewport(4000, 3000, 1, MAX_TEXTURE);
    expect(camera.zoomLevels.min).toBe(3);
    expect(camera.zoom).toBe(3);
    expectCentred(4000, 3000);
    // Back on the small canvas the zoom stays where it was pushed, since it still fits.
    camera.setViewport(1280, 800, 1, MAX_TEXTURE);
    expect(camera.zoom).toBe(3);
    expectCentred(1280, 800);
  });

  it('leaves the picture exactly in place on a resize that does not change an axis', () => {
    const random = randomStream(11);
    const camera = cameraFor(SCREENS[3]);
    for (let sample = 0; sample < 200; sample += 1) {
      // Origins just below a texel edge are where a rounding step would move the picture a pixel.
      camera.originX = Math.floor(random() * 2000) - Number.EPSILON * 1024;
      camera.originY = Math.floor(random() * 2000) + random();
      const before = camera.snapped();
      camera.setViewport(2560, 1600, 2, MAX_TEXTURE);
      expect(camera.snapped(), 'a no-op resize moved the picture').toEqual(before);
      camera.setViewport(2560, 1000, 2, MAX_TEXTURE);
      const heightOnly = camera.snapped();
      expect([heightOnly.texelX, heightOnly.offsetX], 'a height change moved the picture sideways').toEqual([before.texelX, before.offsetX]);
      camera.setViewport(2560, 1600, 2, MAX_TEXTURE);
    }
  });

  it('scales N with the resolution when only the DPR changes, so the park keeps its CSS size', () => {
    const camera = cameraFor(SCREENS[0]);
    camera.focusCell({ x: 16, y: 16 });
    expect(camera.zoom).toBe(1);
    camera.setViewport(2560, 1600, 2, MAX_TEXTURE);
    expect(camera.zoom).toBe(2);
    const { width, height } = camera.cssSize();
    expect([width, height]).toEqual([1280, 800]);
    const centre = camera.cssToWorld(width / 2, height / 2);
    const expected = cellToWorld({ x: 16, y: 16 });
    expect(Math.abs(centre.x - expected.x)).toBeLessThan(1);
    expect(Math.abs(centre.y - expected.y)).toBeLessThan(1);
    camera.setViewport(1280, 800, 1, MAX_TEXTURE);
    expect(camera.zoom).toBe(1);
  });
});

describe('VoxelCamera: view rotation (Phase 26)', () => {
  const frames = VIEW_ROTATIONS.map((q) => createViewFrame(q, 32, 32));
  const transformOf = (frame: ReturnType<typeof createViewFrame>): ViewTransform => setViewTransform(frame, createViewTransform());

  it('keeps the ground point under the middle of the screen through a turn, in every view and at every zoom', () => {
    for (const zoom of [1, 2, 3, 4]) {
      const camera = cameraFor(SCREENS[0]);
      camera.setZoomAtCss(zoom, 640, 400);
      camera.focusCell({ x: 9, y: 21 });
      let from = frames[0];
      const groundAtCentre = (frame: typeof from): { x: number; y: number } => {
        const size = camera.cssSize();
        const texel = camera.cssToWorld(size.width / 2, size.height / 2);
        return voxelFromView(transformOf(frame), texel.y + texel.x / 2, texel.y - texel.x / 2, { x: 0, y: 0 });
      };
      const start = groundAtCentre(from);
      for (const to of [frames[1], frames[2], frames[3], frames[0], frames[3], frames[1]]) {
        camera.retargetForTurn(transformOf(from), transformOf(to));
        // The WORLD ground voxel under the middle of the screen never moves (the centre is exact: dyadic maths).
        // cssToWorld reads the SNAPPED camera (a whole texel), so the comparison is good to one texel.
        const now = groundAtCentre(to);
        expect(Math.abs(now.x - start.x), `zoom ${zoom}: view ${from.rotation} to ${to.rotation}, x`).toBeLessThanOrEqual(1.5);
        expect(Math.abs(now.y - start.y), `zoom ${zoom}: view ${from.rotation} to ${to.rotation}, y`).toBeLessThanOrEqual(1.5);
        from = to;
      }
    }
  });

  it('four turns restore the origin bit for bit (quarter-texel origin) and to float precision otherwise', () => {
    const camera = cameraFor(SCREENS[0], 2);
    camera.originX = 123.25;
    camera.originY = -77.5;
    const start = [camera.originX, camera.originY];
    for (let turn = 0; turn < 4; turn += 1) camera.retargetForTurn(transformOf(frames[turn]), transformOf(frames[(turn + 1) & 3]));
    expect([camera.originX, camera.originY]).toEqual(start);
    camera.originX = 0.123456789;
    camera.originY = 4.987654321;
    for (let turn = 0; turn < 4; turn += 1) camera.retargetForTurn(transformOf(frames[turn]), transformOf(frames[(turn + 1) & 3]));
    expect(camera.originX).toBeCloseTo(0.123456789, 9);
    expect(camera.originY).toBeCloseTo(4.987654321, 9);
  });

  it('retargetForTurn keeps zoom, the texel budget and the snapped camera well formed', () => {
    const camera = cameraFor(SCREENS[0], 2);
    camera.focusCell({ x: 4, y: 30 });
    const before = camera.snapped();
    camera.retargetForTurn(transformOf(frames[0]), transformOf(frames[1]));
    const after = camera.snapped();
    expect([after.zoom, after.lowWidth, after.lowHeight]).toEqual([before.zoom, before.lowWidth, before.lowHeight]);
    expect(after.lowWidth * after.lowHeight).toBeLessThanOrEqual(LOW_RES_TEXEL_BUDGET);
    expect(Number.isInteger(after.texelX) && Number.isInteger(after.offsetX)).toBe(true);
  });

  it('cssToWorld agrees with pickCell in the four views: the clicked cell is the cell the voxel transform names', () => {
    for (const frame of frames) {
      const t = transformOf(frame);
      for (const zoom of [1, 2, 4]) {
        const camera = cameraFor(SCREENS[0]);
        camera.setZoomAtCss(zoom, 100, 100);
        camera.focusCell({ x: 15, y: 15 });
        camera.retargetForTurn(transformOf(frames[0]), t);
        for (const [x, y] of [[640.3, 400.2], [300.3, 200.2], [900.3, 600.2], [500.3, 700.2]]) {
          const texel = camera.cssToWorld(x, y);
          // Ground voxel in view space, then back through the transform to the world.
          const u = texel.y + texel.x / 2;
          const v = texel.y - texel.x / 2;
          const world = voxelFromView(t, u, v, { x: 0, y: 0 });
          expect(pickCell(frame, texel.x, texel.y), `view ${frame.rotation} zoom ${zoom}`)
            .toEqual({ x: Math.floor(world.x / 32), y: Math.floor(world.y / 32) });
        }
      }
    }
  });

  it('focusEntranceInView keeps the gate on screen in every view, and view 0 is the long-standing framing', () => {
    const entrance = { x: 15, y: 31 };
    const a = cameraFor(SCREENS[0], 2);
    a.focusWorld(cellToWorld({ x: 15.5, y: 20 }).x, cellToWorld({ x: 15.5, y: 20 }).y, 0.5, 0.18);
    const b = cameraFor(SCREENS[0], 2);
    b.focusEntranceInView(frames[0], entrance.x, entrance.y);
    expect([b.originX, b.originY]).toEqual([a.originX, a.originY]);
    for (const frame of frames) {
      const camera = cameraFor(SCREENS[0], 2);
      camera.focusEntranceInView(frame, entrance.x, entrance.y);
      const gate = cellToView(frame, entrance.x, entrance.y, { x: 0, y: 0 });
      const texel = cellToWorld({ x: gate.x, y: gate.y });
      const snap = camera.snapped();
      const size = camera.cssSize();
      const x = (texel.x - camera.originX) * snap.zoom;
      const y = (texel.y + 16 - camera.originY) * snap.zoom;
      if (frame.rotation === 0) continue; // the long-standing framing puts the gate at the screen's left edge
      expect(x, `view ${frame.rotation}: gate inside horizontally`).toBeGreaterThan(0);
      expect(x).toBeLessThan(size.width * snap.zoom);
      expect(y, `view ${frame.rotation}: gate inside vertically`).toBeGreaterThan(0);
      expect(y).toBeLessThan(size.height * snap.zoom);
    }
  });
});
