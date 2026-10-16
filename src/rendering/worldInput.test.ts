import { Container } from 'pixi.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ParkSession } from '../game/session/ParkSession';
import type { Cell } from '../game/types';
import { cellToWorld, TILE_HEIGHT } from './isometric';
import type { WorldInputHandlers } from './RendererPort';
import { VoxelCamera } from './voxel/camera';
import { bindWorldInput, KEY_PAN_CSS_PER_MS } from './worldInput';
import { containerCameraView, WorldRenderer } from './WorldRenderer';

/**
 * GameApp depends on subtle input semantics that no other test can see: hover fires on every move,
 * a right-drag fires `move` (legacy P17, kept on purpose), Space shares the camera key set, and so
 * on ([RS] §3.5). Vitest runs in Node without a DOM, so this file drives the input binding with a
 * fake canvas and a fake key target and pins every one of those rules for each renderer's view.
 */

type Listener = (event: any) => void;

/** Just enough of an HTMLCanvasElement for the input binding, plus a way to fire events at it. */
class FakeCanvas {
  readonly listeners = new Map<string, { listener: Listener; options: unknown }[]>();
  readonly captured: number[] = [];
  readonly style = { cursor: '' };
  rect = { left: 10, top: 20, width: 1280, height: 800 };

  addEventListener(type: string, listener: Listener, options?: unknown): void {
    const list = this.listeners.get(type) ?? [];
    list.push({ listener, options });
    this.listeners.set(type, list);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry.listener !== listener));
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return { ...this.rect };
  }

  setPointerCapture(pointerId: number): void {
    this.captured.push(pointerId);
  }

  dispatch(type: string, event: object): void {
    for (const { listener } of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((total, list) => total + list.length, 0);
  }
}

/** Stands in for `window`: the binding listens for camera keys there, not on the canvas. */
class FakeKeyTarget {
  readonly listeners = new Map<string, Listener[]>();

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, (this.listeners.get(type) ?? []).filter((entry) => entry !== listener));
  }

  press(key: string): void {
    for (const listener of this.listeners.get('keydown') ?? []) listener({ key });
  }

  release(key: string): void {
    for (const listener of this.listeners.get('keyup') ?? []) listener({ key });
  }

  get listenerCount(): number {
    return [...this.listeners.values()].reduce((total, list) => total + list.length, 0);
  }
}

interface PointerOptions {
  button?: number;
  altKey?: boolean;
  shiftKey?: boolean;
  pointerId?: number;
}

const pointerEvent = (client: { x: number; y: number }, options: PointerOptions = {}) => ({
  clientX: client.x,
  clientY: client.y,
  button: options.button ?? 0,
  altKey: options.altKey ?? false,
  shiftKey: options.shiftKey ?? false,
  pointerId: options.pointerId ?? 7,
});

/** An event that remembers whether the binding called preventDefault on it. */
const cancellableEvent = <T extends object>(fields: T) => {
  const event = { ...fields, prevented: false, preventDefault: () => { event.prevented = true; } };
  return event;
};

const recordHandlers = (calls: string[]): WorldInputHandlers => {
  const name = (cell: Cell | null): string => (cell ? `${cell.x},${cell.y}` : 'null');
  return {
    hover: (cell) => { calls.push(`hover ${name(cell)}`); },
    start: (cell, modifiers) => { calls.push(`start ${name(cell)}${modifiers?.shift ? ' shift' : ''}`); },
    move: (cell) => { calls.push(`move ${name(cell)}`); },
    end: (cell) => { calls.push(`end ${name(cell)}`); },
    cancel: () => { calls.push('cancel'); },
  };
};

/** The world-px point at the middle of a tile's diamond: far from every edge, whatever the snap. */
const tileCentre = (cell: Cell): { x: number; y: number } => {
  const top = cellToWorld(cell);
  return { x: top.x, y: top.y + TILE_HEIGHT / 2 };
};

/** One way of standing the binding up. Every semantic below runs against each of them. */
interface Driver {
  readonly canvas: FakeCanvas;
  readonly keys: FakeKeyTarget;
  readonly calls: string[];
  hoveredCell(): Cell | null;
  setViewInputEnabled(enabled: boolean): void;
  /** One frame of held camera keys. */
  keyPan(deltaMs: number): void;
  /** Client coordinates that land on a world-px point through this driver's current transform. */
  clientAtWorld(point: { x: number; y: number }): { x: number; y: number };
  /** Removes the handlers, as before GameApp has called setInputHandlers. */
  clearHandlers(): void;
  destroy?(): void;
}

/** A continuous legacy camera: a Pixi container, CSS px position, uniform scale. */
interface ContainerDriver extends Driver {
  readonly camera: Container;
}

const CANVAS_CSS = { width: 1280, height: 800 };

/**
 * The legacy renderer itself, driven through its own binding: its Application is never initialised
 * in Node, so the canvas and screen the binding reads are stubbed onto it, and `window` is the fake
 * key target.
 */
const worldRendererDriver = (): ContainerDriver => {
  const canvas = new FakeCanvas();
  const keys = new FakeKeyTarget();
  const calls: string[] = [];
  vi.stubGlobal('window', keys);
  const renderer = new WorldRenderer(new ParkSession(null));
  (renderer.app as unknown as { renderer: unknown }).renderer = { canvas, screen: { ...CANVAS_CSS } };
  const internals = renderer as unknown as { camera: Container; bindInput(): void };
  internals.camera.position.set(-40, 120);
  internals.camera.scale.set(0.72);
  internals.bindInput();
  renderer.setInputHandlers(recordHandlers(calls));
  const camera = internals.camera;
  return {
    canvas,
    keys,
    calls,
    camera,
    hoveredCell: () => renderer.hoveredCell,
    setViewInputEnabled: (enabled) => renderer.setViewInputEnabled(enabled),
    keyPan: (deltaMs) => renderer.update(deltaMs, 0),
    clientAtWorld: (point) => ({
      x: canvas.rect.left + (camera.x + point.x * camera.scale.x) * (canvas.rect.width / CANVAS_CSS.width),
      y: canvas.rect.top + (camera.y + point.y * camera.scale.y) * (canvas.rect.height / CANVAS_CSS.height),
    }),
    clearHandlers: () => renderer.setInputHandlers(null as unknown as WorldInputHandlers),
  };
};

/** The shared binding on its own, over the classic camera adapter, with an explicit key target. */
const continuousDriver = (): ContainerDriver => {
  const canvas = new FakeCanvas();
  const keys = new FakeKeyTarget();
  const calls: string[] = [];
  const camera = new Container();
  camera.position.set(-40, 120);
  camera.scale.set(0.72);
  let handlers: WorldInputHandlers | null = recordHandlers(calls);
  const input = bindWorldInput(
    canvas,
    containerCameraView(camera, () => CANVAS_CSS),
    (cell) => cell.x >= 0 && cell.y >= 0 && cell.x < 32 && cell.y < 32,
    () => handlers,
    keys,
  );
  return {
    canvas,
    keys,
    calls,
    camera,
    hoveredCell: () => input.hoveredCell,
    setViewInputEnabled: (enabled) => input.setViewInputEnabled(enabled),
    keyPan: (deltaMs) => input.keyPan(deltaMs),
    clientAtWorld: (point) => ({
      x: canvas.rect.left + (camera.x + point.x * camera.scale.x) * (canvas.rect.width / CANVAS_CSS.width),
      y: canvas.rect.top + (camera.y + point.y * camera.scale.y) * (canvas.rect.height / CANVAS_CSS.height),
    }),
    clearHandlers: () => { handlers = null; },
    destroy: () => input.destroy(),
  };
};

/** The voxel renderer's camera: DPR 2, three device px per texel, a fractional origin. */
interface SnappedDriver extends Driver {
  readonly camera: VoxelCamera;
}

const SNAPPED_RESOLUTION = 2;

const snappedDriver = (): SnappedDriver => {
  const canvas = new FakeCanvas();
  const keys = new FakeKeyTarget();
  const calls: string[] = [];
  const camera = new VoxelCamera({ zoomOverride: 3 });
  camera.setViewport(CANVAS_CSS.width * SNAPPED_RESOLUTION, CANVAS_CSS.height * SNAPPED_RESOLUTION, SNAPPED_RESOLUTION, 8192);
  camera.originX = -700.37;
  camera.originY = 150.71;
  let handlers: WorldInputHandlers | null = recordHandlers(calls);
  const input = bindWorldInput(
    canvas,
    camera,
    (cell) => cell.x >= 0 && cell.y >= 0 && cell.x < 32 && cell.y < 32,
    () => handlers,
    keys,
  );
  return {
    canvas,
    keys,
    calls,
    camera,
    hoveredCell: () => input.hoveredCell,
    setViewInputEnabled: (enabled) => input.setViewInputEnabled(enabled),
    keyPan: (deltaMs) => input.keyPan(deltaMs),
    clientAtWorld: (point) => {
      // The snapped transform, written out: world texel t starts at device px (t − texel)·N + offset.
      const snap = camera.snapped();
      const css = camera.cssSize();
      return {
        x: canvas.rect.left
          + ((point.x - snap.texelX) * snap.zoom + snap.offsetX) / SNAPPED_RESOLUTION * (canvas.rect.width / css.width),
        y: canvas.rect.top
          + ((point.y - snap.texelY) * snap.zoom + snap.offsetY) / SNAPPED_RESOLUTION * (canvas.rect.height / css.height),
      };
    },
    clearHandlers: () => { handlers = null; },
    destroy: () => input.destroy(),
  };
};

const DRIVERS: { name: string; create: () => Driver }[] = [
  { name: 'WorldRenderer', create: worldRendererDriver },
  { name: 'bindWorldInput, continuous view', create: continuousDriver },
  { name: 'bindWorldInput, snapped voxel view', create: snappedDriver },
];

const CONTAINER_DRIVERS: { name: string; create: () => ContainerDriver }[] = [
  { name: 'WorldRenderer', create: worldRendererDriver },
  { name: 'bindWorldInput', create: continuousDriver },
];

afterEach(() => {
  vi.unstubAllGlobals();
});

const CELL_A = { x: 5, y: 7 };
const CELL_B = { x: 6, y: 7 };
/** Far off the map's west corner. */
const OUTSIDE = { x: -900, y: 40 };

describe.each(DRIVERS)('world input semantics ($name)', ({ create }) => {
  const at = (driver: Driver, cell: Cell) => driver.clientAtWorld(tileCentre(cell));
  const outside = (driver: Driver) => driver.clientAtWorld(OUTSIDE);

  it('hovers on every pointermove, even inside the same cell, and tracks the hovered cell', () => {
    const driver = create();
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_A)));
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_A)));
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_B)));
    expect(driver.calls).toEqual(['hover 5,7', 'hover 5,7', 'hover 6,7']);
    expect(driver.hoveredCell()).toEqual(CELL_B);
  });

  it('hovers null off the map and forgets the hovered cell', () => {
    const driver = create();
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_A)));
    driver.canvas.dispatch('pointermove', pointerEvent(outside(driver)));
    expect(driver.calls).toEqual(['hover 5,7', 'hover null']);
    expect(driver.hoveredCell()).toBeNull();
  });

  it('starts only on a plain left press inside the map', () => {
    const driver = create();
    driver.canvas.dispatch('pointerdown', pointerEvent(outside(driver)));
    driver.canvas.dispatch('pointerup', pointerEvent(outside(driver)));
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A), { button: 2 }));
    driver.canvas.dispatch('pointerup', pointerEvent(at(driver, CELL_A), { button: 2 }));
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A)));
    expect(driver.calls).toEqual(['start 5,7']);
  });

  it('reports the Shift key held at pointer down to the tool (the Paint tool paints every part), and only then', () => {
    const driver = create();
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A), { shiftKey: true }));
    driver.canvas.dispatch('pointerup', pointerEvent(at(driver, CELL_A), { shiftKey: true }));
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A)));
    expect(driver.calls.filter((call) => call.startsWith('start'))).toEqual(['start 5,7 shift', 'start 5,7']);
  });

  it('turns a middle press, an Alt-left press and a Space-left press into a pan', () => {
    const driver = create();
    for (const options of [{ button: 1 }, { button: 0, altKey: true }]) {
      driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A), { ...options, pointerId: 3 }));
      driver.canvas.dispatch('pointerup', pointerEvent(at(driver, CELL_A), options));
    }
    driver.keys.press(' ');
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A), { pointerId: 4 }));
    driver.canvas.dispatch('pointerup', pointerEvent(at(driver, CELL_A)));
    // A pan never starts, moves or ends a tool gesture, and it captures the pointer.
    expect(driver.calls).toEqual([]);
    expect(driver.canvas.captured).toEqual([3, 3, 4]);
  });

  it('neither hovers nor moves while panning, and hovers again once the pan ends', () => {
    const driver = create();
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_A)));
    const start = at(driver, CELL_A);
    driver.canvas.dispatch('pointerdown', pointerEvent(start, { button: 1 }));
    driver.canvas.dispatch('pointermove', pointerEvent({ x: start.x + 300, y: start.y + 90 }, { button: 1 }));
    expect(driver.calls).toEqual(['hover 5,7']);
    expect(driver.hoveredCell(), 'a pan updated the hovered cell').toEqual(CELL_A);
    driver.canvas.dispatch('pointerup', pointerEvent({ x: start.x + 300, y: start.y + 90 }, { button: 1 }));
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_B)));
    expect(driver.calls).toEqual(['hover 5,7', 'hover 6,7']);
  });

  it('moves while any button is held inside the map — including the right button (P17, kept)', () => {
    const driver = create();
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_A)));
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A), { button: 2 }));
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_B), { button: 2 }));
    driver.canvas.dispatch('pointermove', pointerEvent(outside(driver), { button: 2 }));
    driver.canvas.dispatch('pointerup', pointerEvent(outside(driver), { button: 2 }));
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_A)));
    expect(driver.calls).toEqual(['hover 5,7', 'hover 6,7', 'move 6,7', 'hover null', 'hover 5,7']);
  });

  it('drags a left gesture from start through every move to an end inside the map', () => {
    const driver = create();
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A)));
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_A)));
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_B)));
    driver.canvas.dispatch('pointerup', pointerEvent(at(driver, CELL_B)));
    expect(driver.calls).toEqual(['start 5,7', 'hover 5,7', 'move 5,7', 'hover 6,7', 'move 6,7', 'end 6,7']);
  });

  it('ends only on a left release inside the map, but always lets go of the button', () => {
    const driver = create();
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A)));
    driver.canvas.dispatch('pointerup', pointerEvent(outside(driver)));
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_B)));
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A), { button: 2 }));
    driver.canvas.dispatch('pointerup', pointerEvent(at(driver, CELL_A), { button: 2 }));
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_A)));
    expect(driver.calls).toEqual(['start 5,7', 'hover 6,7', 'hover 5,7']);
  });

  it('hovers null on pointerleave only while no button is held', () => {
    const driver = create();
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_A)));
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A)));
    driver.canvas.dispatch('pointerleave', {});
    expect(driver.hoveredCell(), 'a held drag lost its cell on leave').toEqual(CELL_A);
    driver.canvas.dispatch('pointerup', pointerEvent(at(driver, CELL_A)));
    driver.canvas.dispatch('pointerleave', {});
    expect(driver.calls).toEqual(['hover 5,7', 'start 5,7', 'end 5,7', 'hover null']);
    expect(driver.hoveredCell()).toBeNull();
  });

  it('resets both the pan and the held button on pointercancel, without telling the game', () => {
    const driver = create();
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A), { button: 1 }));
    driver.canvas.dispatch('pointercancel', {});
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_B)));
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A)));
    driver.canvas.dispatch('pointercancel', {});
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_B)));
    driver.canvas.dispatch('pointerleave', {});
    expect(driver.calls).toEqual(['hover 6,7', 'start 5,7', 'hover 6,7', 'hover null']);
  });

  it('cancels on contextmenu and suppresses the browser menu', () => {
    const driver = create();
    const event = cancellableEvent(pointerEvent(at(driver, CELL_A), { button: 2 }));
    driver.canvas.dispatch('contextmenu', event);
    expect(driver.calls).toEqual(['cancel']);
    expect(event.prevented).toBe(true);
  });

  it('claims the wheel (non-passive, preventDefault) without hovering or moving the hovered cell', () => {
    const driver = create();
    const wheelListeners = driver.canvas.listeners.get('wheel') ?? [];
    expect(wheelListeners).toHaveLength(1);
    expect(wheelListeners[0].options).toEqual({ passive: false });
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_A)));
    const event = cancellableEvent({ ...pointerEvent(at(driver, CELL_B)), deltaY: -300, deltaMode: 0 });
    driver.canvas.dispatch('wheel', event);
    expect(event.prevented).toBe(true);
    expect(driver.calls).toEqual(['hover 5,7']);
    expect(driver.hoveredCell()).toEqual(CELL_A);
  });

  it('shares Space between the camera key set and Space-drag', () => {
    const driver = create();
    driver.keys.press(' ');
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A)));
    driver.canvas.dispatch('pointerup', pointerEvent(at(driver, CELL_A)));
    driver.keys.release(' ');
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A)));
    expect(driver.calls).toEqual(['start 5,7']);
  });

  it('drops every held key when view input is disabled and ignores new ones until it is back', () => {
    const driver = create();
    driver.keys.press(' ');
    driver.setViewInputEnabled(false);
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A)));
    driver.canvas.dispatch('pointerup', pointerEvent(at(driver, CELL_A)));
    driver.keys.press(' ');
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A)));
    driver.canvas.dispatch('pointerup', pointerEvent(at(driver, CELL_A)));
    expect(driver.calls, 'Space still panned behind a modal').toEqual(['start 5,7', 'end 5,7', 'start 5,7', 'end 5,7']);

    driver.setViewInputEnabled(true);
    driver.keys.press(' ');
    driver.setViewInputEnabled(false);
    driver.setViewInputEnabled(true);
    driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A)));
    expect(driver.calls.at(-1), 'a key held across a modal stayed held').toBe('start 5,7');
  });

  it('delivers nothing, and throws nothing, before the game has registered its handlers', () => {
    const driver = create();
    driver.clearHandlers();
    expect(() => {
      driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_A)));
      driver.canvas.dispatch('pointerdown', pointerEvent(at(driver, CELL_A)));
      driver.canvas.dispatch('pointerup', pointerEvent(at(driver, CELL_A)));
      driver.canvas.dispatch('contextmenu', cancellableEvent({}));
      driver.canvas.dispatch('pointerleave', {});
    }).not.toThrow();
    expect(driver.calls).toEqual([]);
    expect(driver.hoveredCell()).toBeNull();
  });

  it('removes every listener it added on destroy', () => {
    const driver = create();
    if (!driver.destroy) return;
    expect(driver.canvas.listenerCount).toBe(7);
    expect(driver.keys.listenerCount).toBe(2);
    driver.destroy();
    expect(driver.canvas.listenerCount).toBe(0);
    expect(driver.keys.listenerCount).toBe(0);
    driver.canvas.dispatch('pointermove', pointerEvent(at(driver, CELL_A)));
    driver.keys.press('d');
    driver.keyPan(100);
    expect(driver.calls).toEqual([]);
  });

  it('maps client px through the canvas rect, scaled when the rect and the canvas disagree', () => {
    const driver = create();
    const first = at(driver, CELL_A);
    // The same CSS point, seen through a canvas drawn at half size and shifted by (5, 7).
    const scaled = {
      x: driver.canvas.rect.left + 5 + (first.x - driver.canvas.rect.left) / 2,
      y: driver.canvas.rect.top + 7 + (first.y - driver.canvas.rect.top) / 2,
    };
    driver.canvas.rect = {
      left: driver.canvas.rect.left + 5,
      top: driver.canvas.rect.top + 7,
      width: driver.canvas.rect.width / 2,
      height: driver.canvas.rect.height / 2,
    };
    driver.canvas.dispatch('pointermove', pointerEvent(scaled));
    expect(driver.calls).toEqual(['hover 5,7']);
  });
});

describe.each(CONTAINER_DRIVERS)('continuous legacy camera ($name)', ({ create }) => {
  it('pans by the raw client delta while dragging', () => {
    const driver = create();
    const before = { x: driver.camera.x, y: driver.camera.y };
    driver.canvas.rect = { ...driver.canvas.rect, width: 640, height: 400 };
    driver.canvas.dispatch('pointerdown', pointerEvent({ x: 100, y: 100 }, { button: 1 }));
    driver.canvas.dispatch('pointermove', pointerEvent({ x: 130, y: 80 }, { button: 1 }));
    driver.canvas.dispatch('pointermove', pointerEvent({ x: 131.5, y: 90 }, { button: 1 }));
    // The rect-to-canvas ratio (2 here) is not applied to pan deltas: legacy behaviour, kept.
    expect(driver.camera.x).toBe(before.x + 31.5);
    expect(driver.camera.y).toBe(before.y - 10);
  });

  it('zooms continuously around the cursor: s′ = clamp(s·exp(−0.0012·Δy), 0.42, 1.65)', () => {
    const driver = create();
    const cursorCss = { x: 400, y: 260 };
    const client = { x: driver.canvas.rect.left + cursorCss.x, y: driver.canvas.rect.top + cursorCss.y };
    for (const deltaY of [-100, -100, 250, 40, -3000, 5000]) {
      const scale = driver.camera.scale.x;
      const before = {
        x: (cursorCss.x - driver.camera.x) / scale,
        y: (cursorCss.y - driver.camera.y) / scale,
      };
      driver.canvas.dispatch('wheel', cancellableEvent({ clientX: client.x, clientY: client.y, deltaY, deltaMode: 0 }));
      const expected = Math.min(1.65, Math.max(0.42, scale * Math.exp(-deltaY * 0.0012)));
      expect(driver.camera.scale.x).toBe(expected);
      expect(driver.camera.scale.y).toBe(expected);
      expect(driver.camera.x).toBe(cursorCss.x - before.x * expected);
      expect(driver.camera.y).toBe(cursorCss.y - before.y * expected);
    }
    expect(driver.camera.scale.x).toBe(0.42);
  });

  it('key-pans 0.55 CSS px per ms for each held direction, arrows and WASD alike', () => {
    const driver = create();
    // The same float operations, in the same order, as the legacy camera: one += or -= per key.
    const step = (deltaMs: number): number => 0.55 * deltaMs;
    let x = driver.camera.x;
    let y = driver.camera.y;
    driver.keys.press('A');
    driver.keyPan(100);
    x += step(100);
    expect(driver.camera.x).toBe(x);
    driver.keys.press('ArrowRight');
    driver.keyPan(100);
    x += step(100);
    x -= step(100);
    expect(driver.camera.x, 'opposite keys should cancel').toBe(x);
    driver.keys.release('a');
    driver.keys.release('ARROWRIGHT');
    driver.keys.press('w');
    driver.keys.press('ArrowDown');
    driver.keys.press('s');
    driver.keyPan(10);
    y += step(10);
    y -= step(10);
    expect(driver.camera.y).toBe(y);
    driver.keys.release('ArrowDown');
    driver.keys.release('S');
    driver.keyPan(20);
    y += step(20);
    expect(driver.camera.y).toBe(y);
    expect(driver.camera.x, 'a released key kept panning').toBe(x);
    driver.setViewInputEnabled(false);
    driver.keyPan(1000);
    expect(driver.camera.y, 'held keys survived disabling view input').toBe(y);
  });

  it('never pans or zooms from key presses while view input is disabled', () => {
    const driver = create();
    const start = { x: driver.camera.x, y: driver.camera.y };
    driver.setViewInputEnabled(false);
    driver.keys.press('d');
    driver.keyPan(100);
    expect({ x: driver.camera.x, y: driver.camera.y }).toEqual(start);
  });
});

describe('snapped voxel camera through the binding', () => {
  it('pans by the client delta · R / N texels while dragging', () => {
    const driver = snappedDriver();
    const origin = { x: driver.camera.originX, y: driver.camera.originY };
    driver.canvas.dispatch('pointerdown', pointerEvent({ x: 200, y: 200 }, { button: 1 }));
    driver.canvas.dispatch('pointermove', pointerEvent({ x: 230, y: 185 }, { button: 1 }));
    expect(driver.camera.originX).toBeCloseTo(origin.x - 30 * SNAPPED_RESOLUTION / 3, 9);
    expect(driver.camera.originY).toBeCloseTo(origin.y + 15 * SNAPPED_RESOLUTION / 3, 9);
  });

  it('zooms one whole level per notch, keeping the texel under the cursor', () => {
    const driver = snappedDriver();
    const cursor = { x: driver.canvas.rect.left + 333.3, y: driver.canvas.rect.top + 222.2 };
    const before = driver.camera.cssToWorld(333.3, 222.2);
    driver.canvas.dispatch('wheel', cancellableEvent({ clientX: cursor.x, clientY: cursor.y, deltaY: -100, deltaMode: 0 }));
    expect(driver.camera.zoom).toBe(4);
    const after = driver.camera.cssToWorld(333.3, 222.2);
    expect(Math.abs(after.x - before.x)).toBeLessThan(1);
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);
    driver.canvas.dispatch('wheel', cancellableEvent({ clientX: cursor.x, clientY: cursor.y, deltaY: 50, deltaMode: 0 }));
    expect(driver.camera.zoom, 'half a notch zoomed').toBe(4);
  });

  it('key-pans at the legacy CSS speed, converted to texels', () => {
    const driver = snappedDriver();
    const origin = { x: driver.camera.originX, y: driver.camera.originY };
    driver.keys.press('ArrowLeft');
    driver.keys.press('S');
    driver.keyPan(40);
    const texels = KEY_PAN_CSS_PER_MS * 40 * SNAPPED_RESOLUTION / 3;
    expect(driver.camera.originX).toBeCloseTo(origin.x - texels, 9);
    expect(driver.camera.originY).toBeCloseTo(origin.y + texels, 9);
  });
});

describe('camera sensitivity (settings)', () => {
  const rig = (sensitivity?: () => { keyPan: number; wheel: number }) => {
    const canvas = new FakeCanvas();
    const keys = new FakeKeyTarget();
    const wheels: number[] = [];
    const pans: number[] = [];
    const view = {
      cssSize: () => CANVAS_CSS,
      cssToWorld: (x: number, y: number) => ({ x, y }),
      panByCss: (dx: number) => { pans.push(dx); },
      zoomAtCss: (_x: number, _y: number, event: { deltaY: number }) => { wheels.push(event.deltaY); },
    };
    const input = bindWorldInput(canvas, view, () => true, () => null, keys, sensitivity);
    return { canvas, keys, wheels, pans, input };
  };

  it('scales the key pan and the wheel by the factors, read live on each event', () => {
    let factors = { keyPan: 1, wheel: 1 };
    const { canvas, keys, wheels, pans, input } = rig(() => factors);
    canvas.dispatch('wheel', cancellableEvent({ clientX: 10, clientY: 10, deltaY: -100, deltaMode: 0 }));
    keys.press('ArrowLeft');
    input.keyPan(100);
    factors = { keyPan: 0.5, wheel: 1.75 };
    canvas.dispatch('wheel', cancellableEvent({ clientX: 10, clientY: 10, deltaY: -100, deltaMode: 0 }));
    input.keyPan(100);
    expect(wheels).toEqual([-100, -175]);
    expect(pans[1]).toBeCloseTo(pans[0] / 2, 9);
  });

  it('the default factors are the settings store: normal speed is exactly the legacy 0.55 px per ms', () => {
    const { keys, pans, input } = rig();
    keys.press('ArrowLeft');
    input.keyPan(100);
    expect(Math.abs(pans[0])).toBe(KEY_PAN_CSS_PER_MS * 100);
  });
});

describe('camera keys follow the keybinding registry', () => {
  const rig = (panKeys?: () => { left: string[]; right: string[]; up: string[]; down: string[] }) => {
    const canvas = new FakeCanvas();
    const keys = new FakeKeyTarget();
    const pans: Array<[number, number]> = [];
    const view = {
      cssSize: () => CANVAS_CSS,
      cssToWorld: (x: number, y: number) => ({ x, y }),
      panByCss: (dx: number, dy: number) => { pans.push([dx, dy]); },
      zoomAtCss: () => undefined,
    };
    const input = bindWorldInput(canvas, view, () => true, () => null, keys, () => ({ keyPan: 1, wheel: 1 }), panKeys);
    return { keys, pans, input };
  };
  const press = (keys: FakeKeyTarget, event: object): void => {
    for (const listener of keys.listeners.get('keydown') ?? []) listener(event as never);
  };

  it('pans by physical key: an AZERTY Z on the KeyW position moves up', () => {
    const { keys, pans, input } = rig();
    press(keys, { key: 'z', code: 'KeyW' });
    input.keyPan(100);
    expect(pans).toEqual([[0, 0.55 * 100]]);
  });

  it('a character that is not on the physical pan key does nothing', () => {
    const { keys, pans, input } = rig();
    press(keys, { key: 'w', code: 'KeyZ' });
    input.keyPan(100);
    expect(pans).toEqual([]);
  });

  it('uses the injected codes: a rebound pan key works and the old one stops, arrows stay', () => {
    const { keys, pans, input } = rig(() => ({ left: ['KeyJ', 'ArrowLeft'], right: ['KeyD', 'ArrowRight'], up: ['KeyW', 'ArrowUp'], down: ['KeyS', 'ArrowDown'] }));
    press(keys, { key: 'a', code: 'KeyA' });
    input.keyPan(100);
    expect(pans).toEqual([]);
    press(keys, { key: 'j', code: 'KeyJ' });
    input.keyPan(100);
    expect(pans).toEqual([[0.55 * 100, 0]]);
    keys.press('ArrowLeft');
    input.keyPan(100);
    expect(pans, 'one pan per direction however many keys are held').toHaveLength(2);
  });

  it('ignores a key held with Ctrl, Cmd or Alt (Ctrl+S must not nudge the camera)', () => {
    const { keys, pans, input } = rig();
    press(keys, { key: 's', code: 'KeyS', ctrlKey: true });
    press(keys, { key: 'a', code: 'KeyA', metaKey: true });
    input.keyPan(100);
    expect(pans).toEqual([]);
  });

  it('releases by code even when the key character changed (Shift released first)', () => {
    const { keys, pans, input } = rig();
    press(keys, { key: 'W', code: 'KeyW', shiftKey: true });
    for (const listener of keys.listeners.get('keyup') ?? []) listener({ key: 'w', code: 'KeyW' } as never);
    input.keyPan(100);
    expect(pans).toEqual([]);
  });
});
