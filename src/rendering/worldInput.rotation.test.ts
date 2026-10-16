import { Container } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import type { Cell } from '../game/types';
import { cellOffsetOf } from './isoPlot';
import { TILE_HEIGHT, TILE_WIDTH, worldToCell } from './isometric';
import type { WorldInputHandlers } from './RendererPort';
import { VoxelCamera } from './voxel/camera';
import { cellToView, createViewFrame, fromViewCell, IDENTITY_VIEW_FRAME, pointFromView, VIEW_ROTATIONS, type ViewFrame, type XY } from './viewRotation';
import { bindWorldInput, pickCell, type PanCodes } from './worldInput';
import { containerCameraView } from './WorldRenderer';

type Listener = (event: any) => void;

class FakeCanvas {
  readonly listeners = new Map<string, Listener[]>();
  rect = { left: 10, top: 20, width: 1280, height: 800 };
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((l) => l !== listener));
  }
  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { ...this.rect };
  }
  setPointerCapture(): void {}
  dispatch(type: string, event: object): void {
    for (const l of [...(this.listeners.get(type) ?? [])]) l({ preventDefault() {}, ...event });
  }
}

class FakeKeys {
  readonly listeners = new Map<string, Listener[]>();
  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(): void {}
  press(code: string): void {
    for (const l of this.listeners.get('keydown') ?? []) l({ code, key: code });
  }
}

const PAN: PanCodes = { left: ['KeyA'], right: ['KeyD'], up: ['KeyW'], down: ['KeyS'] };
const SENS = () => ({ keyPan: 1, wheel: 1 });
const SCREEN = { width: 1280, height: 800 };

const prng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 4294967296;
};

interface Rig {
  canvas: FakeCanvas;
  keys: FakeKeys;
  camera: Container;
  calls: string[];
  frame: { current: ViewFrame };
  input: ReturnType<typeof bindWorldInput>;
  cells: (Cell | null)[];
}

const rig = (frame: ViewFrame, w: number, h: number, getFrame?: () => ViewFrame): Rig => {
  const canvas = new FakeCanvas();
  const keys = new FakeKeys();
  const camera = new Container();
  const calls: string[] = [];
  const cells: (Cell | null)[] = [];
  const holder = { current: frame };
  const handlers: WorldInputHandlers = {
    hover: (c) => { calls.push('hover'); cells.push(c); },
    start: () => calls.push('start'),
    move: () => calls.push('move'),
    end: () => calls.push('end'),
    cancel: () => calls.push('cancel'),
  };
  const input = bindWorldInput(
    canvas,
    containerCameraView(camera, () => SCREEN),
    (c) => c.x >= 0 && c.y >= 0 && c.x < w && c.y < h,
    () => handlers,
    keys,
    SENS,
    () => PAN,
    getFrame ?? (() => holder.current),
  );
  return { canvas, keys, camera, calls, frame: holder, input, cells };
};

const move = (r: Rig, x: number, y: number): void =>
  r.canvas.dispatch('pointermove', { clientX: x + 10, clientY: y + 20, button: 0 });

/** The long way: screen px -> view-space point -> world point -> floor. */
const truthCell = (camera: Container, frame: ViewFrame, sx: number, sy: number): { cell: Cell; margin: number } => {
  const world = { x: (sx - camera.x) / camera.scale.x, y: (sy - camera.y) / camera.scale.y };
  const viewPoint = cellOffsetOf(world);
  const p: XY = pointFromView(frame, viewPoint.x, viewPoint.y, { x: 0, y: 0 });
  const margin = Math.min(Math.abs(p.x - Math.round(p.x)), Math.abs(p.y - Math.round(p.y)), Math.abs(viewPoint.x - Math.round(viewPoint.x)), Math.abs(viewPoint.y - Math.round(viewPoint.y)));
  return { cell: { x: Math.floor(p.x), y: Math.floor(p.y) }, margin };
};

/** World-space (point-space) point to camera-space px for a view-0 projection. */
const project0 = (px: number, py: number): { x: number; y: number } => ({
  x: (px - py) * (TILE_WIDTH / 2),
  y: (px + py) * (TILE_HEIGHT / 2),
});

const ZOOMS = [0.42, 0.55, 0.7, 0.85, 1, 1.2, 1.4, 1.65];

describe('rotated picking', () => {
  it('differential fuzz over views x zooms x pointer positions', () => {
    for (const [w, h] of [[32, 32], [7, 5]] as const) {
      const rnd = prng(w * 31 + h);
      for (const q of VIEW_ROTATIONS) {
        const frame = createViewFrame(q, w, h);
        for (const zoom of ZOOMS) {
          const r = rig(frame, w, h);
          r.camera.scale.set(zoom);
          r.camera.position.set((rnd() - 0.5) * 1200 + 640, (rnd() - 0.5) * 400 + 200);
          // a view-0 reference binding with its own camera, aimed through the same world point
          for (let i = 0; i < 500; i++) {
            const sx = rnd() * SCREEN.width;
            const sy = rnd() * SCREEN.height;
            const { cell, margin } = truthCell(r.camera, frame, sx, sy);
            if (margin < 1e-6) continue;
            r.cells.length = 0;
            move(r, sx, sy);
            const inside = cell.x >= 0 && cell.y >= 0 && cell.x < w && cell.y < h;
            expect(r.cells[0]).toEqual(inside ? cell : null);
            expect(pickCell(frame, (sx - r.camera.x) / zoom, (sy - r.camera.y) / zoom)).toEqual(cell);
          }
        }
      }
    }
  });

  it('picking in view q equals picking the inverse-rotated point in view 0', () => {
    const w = 32;
    const h = 20;
    const rnd = prng(99);
    for (const q of VIEW_ROTATIONS) {
      const frame = createViewFrame(q, w, h);
      const view0 = rig(createViewFrame(0, w, h), w, h);
      view0.camera.scale.set(1);
      view0.camera.position.set(0, 0);
      const viewQ = rig(frame, w, h);
      viewQ.camera.scale.set(1);
      viewQ.camera.position.set(0, 0);
      for (let i = 0; i < 400; i++) {
        // a view-space point; the matching world point is its inverse rotation
        const size = (q & 1) === 0 ? { w, h } : { w: h, h: w };
        const u = rnd() * size.w;
        const v = rnd() * size.h;
        if (Math.abs(u - Math.round(u)) < 1e-6 || Math.abs(v - Math.round(v)) < 1e-6) continue;
        const px = project0(u, v);
        const world = pointFromView(frame, u, v, { x: 0, y: 0 });
        const p0 = project0(world.x, world.y);
        viewQ.cells.length = 0;
        view0.cells.length = 0;
        move(viewQ, px.x, px.y);
        move(view0, p0.x, p0.y);
        expect(viewQ.cells[0]).toEqual(view0.cells[0]);
        expect(viewQ.cells[0]).toEqual({ x: Math.floor(world.x), y: Math.floor(world.y) });
      }
    }
  });

  it('every cell centre, projected through its view and the camera, picks that cell', () => {
    for (const [w, h] of [[32, 32], [7, 5]] as const) {
      for (const q of VIEW_ROTATIONS) {
        const frame = createViewFrame(q, w, h);
        const r = rig(frame, w, h);
        r.camera.scale.set(0.9);
        r.camera.position.set(600, 100);
        const out: XY = { x: 0, y: 0 };
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            cellToView(frame, x, y, out);
            const wp = project0(out.x + 0.5, out.y + 0.5);
            r.cells.length = 0;
            move(r, wp.x * 0.9 + 600, wp.y * 0.9 + 100);
            expect(r.cells[0]).toEqual({ x, y });
          }
        }
      }
    }
  });

  it('pins the tie rule: a view-cell edge picks floor in view space', () => {
    for (const q of VIEW_ROTATIONS) {
      const frame = createViewFrame(q, 8, 8);
      // exact edge (3, 4) of the view grid: the view cell is (3, 4), whatever world cell that is
      const world = project0(3, 4);
      const out: XY = { x: 0, y: 0 };
      cellToView(frame, 0, 0, out); // keep the import honest
      const expected = pickCell(frame, world.x, world.y);
      const viewCell = worldToCell(world.x, world.y);
      expect(viewCell).toEqual({ x: 3, y: 4 });
      expect(expected).toEqual(fromViewCell(frame, viewCell));
    }
  });

  it('q = 0: omitted, identity and an explicit frame give identical hover sequences', () => {
    const rnd = prng(5);
    const a = rig(IDENTITY_VIEW_FRAME, 32, 32, undefined);
    const b = rig(createViewFrame(0, 32, 32), 32, 32);
    const c = rig(IDENTITY_VIEW_FRAME, 32, 32);
    // `a` uses the default getter, built by binding without the 8th argument
    const canvas = new FakeCanvas();
    const camera = new Container();
    const seen: (Cell | null)[] = [];
    bindWorldInput(canvas, containerCameraView(camera, () => SCREEN), (cell) => cell.x >= 0 && cell.y >= 0 && cell.x < 32 && cell.y < 32,
      () => ({ hover: (cell) => seen.push(cell), start() {}, move() {}, end() {}, cancel() {} }), new FakeKeys(), SENS, () => PAN);
    for (const rg of [a, b, c]) rg.camera.position.set(640, 100);
    camera.position.set(640, 100);
    for (let i = 0; i < 4000; i++) {
      const sx = rnd() * SCREEN.width;
      const sy = rnd() * SCREEN.height;
      move(a, sx, sy);
      move(b, sx, sy);
      move(c, sx, sy);
      canvas.dispatch('pointermove', { clientX: sx + 10, clientY: sy + 20, button: 0 });
    }
    expect(a.cells).toEqual(seen);
    expect(b.cells).toEqual(seen);
    expect(c.cells).toEqual(seen);
  });

  it('pan follows the screen in every view: keys and drag give identical deltas', () => {
    for (const q of VIEW_ROTATIONS) {
      const r = rig(createViewFrame(q, 16, 16), 16, 16);
      r.camera.position.set(0, 0);
      r.keys.press('KeyA');
      r.input.keyPan(10);
      expect(r.camera.x).toBeCloseTo(5.5);
      expect(r.camera.y).toBe(0);
      r.keys.press('KeyW');
      r.input.keyPan(10);
      expect(r.camera.y).toBeCloseTo(5.5);
      r.canvas.dispatch('pointerdown', { clientX: 100, clientY: 100, button: 1, pointerId: 1 });
      r.canvas.dispatch('pointermove', { clientX: 130, clientY: 90, button: 1 });
      expect(r.camera.x).toBeCloseTo(5.5 * 2 + 30);
      expect(r.camera.y).toBeCloseTo(5.5 - 10);
    }
  });

  it('start, move and end pick through the view', () => {
    const frame = createViewFrame(1, 16, 16);
    const r = rig(frame, 16, 16);
    r.camera.position.set(640, 100);
    const out: XY = { x: 0, y: 0 };
    cellToView(frame, 5, 9, out);
    const p = project0(out.x + 0.5, out.y + 0.5);
    const ev = { clientX: p.x + 640 + 10, clientY: p.y + 100 + 20, button: 0, altKey: false, pointerId: 1 };
    const got: string[] = [];
    const canvas = r.canvas;
    const handlers: WorldInputHandlers = {
      hover: (c) => got.push(`h${c?.x},${c?.y}`),
      start: (c) => got.push(`s${c.x},${c.y}`),
      move: (c) => got.push(`m${c.x},${c.y}`),
      end: (c) => got.push(`e${c.x},${c.y}`),
      cancel() {},
    };
    const input = bindWorldInput(canvas, containerCameraView(r.camera, () => SCREEN), () => true, () => handlers, new FakeKeys(), SENS, () => PAN, () => frame);
    void input;
    canvas.dispatch('pointerdown', ev);
    canvas.dispatch('pointermove', ev);
    canvas.dispatch('pointerup', ev);
    expect(got).toEqual(['s5,9', 'h5,9', 'm5,9', 'e5,9']);
  });

  it('rehover: re-picks under a still pointer, never fires move, no-ops without a position', () => {
    const w = 16;
    let frame = createViewFrame(0, w, w);
    const r = rig(frame, w, w, () => frame);
    r.camera.position.set(640, 100);
    r.input.rehover();
    expect(r.calls).toEqual([]);
    const out: XY = { x: 0, y: 0 };
    const p = project0(6.5, 3.5);
    move(r, p.x + 640, p.y + 100);
    expect(r.cells).toEqual([{ x: 6, y: 3 }]);
    r.calls.length = 0;
    frame = createViewFrame(1, w, w);
    r.input.rehover();
    cellToView(createViewFrame(0, w, w), 0, 0, out);
    expect(r.calls).toEqual(['hover']);
    const expected = pickCell(frame, p.x, p.y);
    expect(r.cells[1]).toEqual(expected);
    expect(r.input.hoveredCell).toEqual(expected);
    // a button held: still only hover
    r.canvas.dispatch('pointerdown', { clientX: p.x + 650, clientY: p.y + 120, button: 0, pointerId: 1 });
    r.calls.length = 0;
    r.input.rehover();
    expect(r.calls).toEqual(['hover']);
    // pointerleave clears (button released first)
    r.canvas.dispatch('pointerup', { clientX: p.x + 650, clientY: p.y + 120, button: 0 });
    r.canvas.dispatch('pointerleave', {});
    r.calls.length = 0;
    r.input.rehover();
    expect(r.calls).toEqual([]);
    // panning: no-op
    r.canvas.dispatch('pointermove', { clientX: p.x + 650, clientY: p.y + 120, button: 0 });
    r.canvas.dispatch('pointerdown', { clientX: 5, clientY: 5, button: 1, pointerId: 1 });
    r.calls.length = 0;
    r.input.rehover();
    expect(r.calls).toEqual([]);
  });

  it('gestureHeld: true only between a tool press and its release or cancel, never while panning', () => {
    const frame = createViewFrame(0, 16, 16);
    const r = rig(frame, 16, 16);
    const at = { clientX: 700, clientY: 200, pointerId: 1 };
    expect(r.input.gestureHeld).toBe(false);
    r.canvas.dispatch('pointerdown', { ...at, button: 0, altKey: false });
    expect(r.input.gestureHeld).toBe(true);
    r.canvas.dispatch('pointermove', { ...at, button: 0 });
    expect(r.input.gestureHeld).toBe(true);
    r.canvas.dispatch('pointerup', { ...at, button: 0 });
    expect(r.input.gestureHeld).toBe(false);
    r.canvas.dispatch('pointerdown', { ...at, button: 0, altKey: false });
    r.canvas.dispatch('pointercancel', {});
    expect(r.input.gestureHeld, 'a cancelled gesture is over').toBe(false);
    r.canvas.dispatch('pointerdown', { ...at, button: 1 });
    expect(r.input.gestureHeld, 'a middle-button pan is no tool gesture').toBe(false);
    r.canvas.dispatch('pointerup', { ...at, button: 1 });
    expect(r.input.gestureHeld).toBe(false);
  });

  it('the voxel camera works through the binding at identity', () => {
    const cam = new VoxelCamera();
    const canvas = new FakeCanvas();
    const seen: (Cell | null)[] = [];
    bindWorldInput(
      canvas,
      {
        cssSize: () => SCREEN,
        cssToWorld: (x, y) => cam.cssToWorld(x, y),
        panByCss: () => {},
        zoomAtCss: () => {},
      },
      () => true,
      () => ({ hover: (c) => seen.push(c), start() {}, move() {}, end() {}, cancel() {} }),
      new FakeKeys(),
    );
    canvas.dispatch('pointermove', { clientX: 100, clientY: 100, button: 0 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).not.toBeNull();
  });
});
