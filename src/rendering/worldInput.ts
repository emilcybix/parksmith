import { eventCode, panCodes, type KeybindingOverrides } from '../settings/keybindings';
import { CAMERA_SPEED_FACTORS } from '../settings/schema';
import { getSettings } from '../settings/settingsStore';
import type { Cell } from '../game/types';
import { worldToCell } from './isometric';
import type { WorldInputHandlers } from './RendererPort';
import { fromViewCell, IDENTITY_VIEW_FRAME, type ViewFrame } from './viewRotation';

/**
 * The world's pointer, wheel and camera-key input, shared by both renderers.
 *
 * GameApp leans on semantics that are easy to lose in a rewrite, so this is the legacy binding moved
 * here unchanged and pinned by `worldInput.test.ts` for every view that uses it:
 * - `hover` fires on every pointermove that is not a pan, even inside the same cell — a tool change
 *   never redraws its blueprint itself, it waits for the next move;
 * - `move` fires while ANY button is held (P17: a right-drag moves without a start). That is a known
 *   issue, kept deliberately so both renderers behave exactly like the shipped game;
 * - `start` needs a plain left press (Alt or a held Space pans instead), `end` a left release, both
 *   inside the map; releasing anywhere lets go of the button;
 * - `pointerleave` hovers null only while no button is held; `pointercancel` resets silently;
 * - right-click cancels (and never opens the browser menu); the wheel is claimed (non-passive);
 * - camera keys are tracked by physical key (`event.code`) and share one set with Space-drag, and
 *   disabling view input drops every held key, so nothing pans behind a modal. Which codes pan comes
 *   from the keybinding registry (WASD by default plus the arrows, which always work);
 * - the hovered cell does not change during a pan or a wheel zoom.
 *
 * Each renderer supplies its own camera through `WorldInputView`: the classic renderer's continuous
 * Pixi container, the voxel renderer's texel-snapped camera.
 */

/** Camera key speed: 0.55 CSS px per ms per held direction (about 550 px/s), at every zoom. */
export const KEY_PAN_CSS_PER_MS = 0.55;

/** Multipliers from the player's camera settings; 1 and 1 reproduce the pre-settings feel. */
export interface InputSensitivity {
  keyPan: number;
  wheel: number;
}

/** The default reads the settings store live, so a change applies on the next event or frame. */
export const settingsSensitivity = (): InputSensitivity => {
  const settings = getSettings();
  return { keyPan: CAMERA_SPEED_FACTORS[settings.cameraKeySpeed], wheel: CAMERA_SPEED_FACTORS[settings.cameraZoomStep] };
};

/** The event.code values that pan each way; the default reads the settings live. */
export interface PanCodes {
  left: readonly string[];
  right: readonly string[];
  up: readonly string[];
  down: readonly string[];
}

export const settingsPanCodes = (): PanCodes => panCodes(getSettings().keybindings as KeybindingOverrides);

/** The part of a wheel event a view needs to zoom. */
export type WheelDelta = Pick<WheelEvent, 'deltaY' | 'deltaMode'>;

/** A renderer's camera, as the input binding sees it. All positions are canvas CSS px. */
export interface WorldInputView {
  /** The canvas size in the CSS px `cssToWorld` expects (classic: `app.screen`). */
  cssSize(): { width: number; height: number };
  /** Canvas CSS px → world px, through exactly the transform the frame is drawn with. */
  cssToWorld(x: number, y: number): { x: number; y: number };
  /** Drags the view by a client-px delta: the world follows the pointer. */
  panByCss(dx: number, dy: number): void;
  /** One wheel event at canvas CSS px (x, y); the point under the cursor stays put. */
  zoomAtCss(x: number, y: number, event: WheelDelta): void;
}

/** Just the canvas members the binding touches, so a Node test can stand in for the element. */
export interface WorldInputSurface {
  addEventListener<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions,
  ): void;
  removeEventListener<K extends keyof HTMLElementEventMap>(
    type: K,
    listener: (event: HTMLElementEventMap[K]) => void,
  ): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  setPointerCapture(pointerId: number): void;
}

/** Where camera keys are heard: the window, so they work wherever the pointer is. */
export interface KeyEventSource {
  addEventListener(type: 'keydown' | 'keyup', listener: (event: KeyboardEvent) => void): void;
  removeEventListener(type: 'keydown' | 'keyup', listener: (event: KeyboardEvent) => void): void;
}

/**
 * Camera px (the space `cssToWorld` returns) to the WORLD cell under it in view `frame`. The renderer
 * draws view cell (u, v) with the plain isometric projection, so the pick is the view-space cell mapped
 * back. For rotation 0 this is exactly `worldToCell`. A point exactly on a view-cell edge picks the
 * view cell given by floor in VIEW space.
 */
export const pickCell = (frame: ViewFrame, worldX: number, worldY: number): Cell =>
  fromViewCell(frame, worldToCell(worldX, worldY));

export interface WorldInput {
  /** The last in-map cell under the pointer, or null. */
  readonly hoveredCell: Cell | null;
  /**
   * True between a non-panning pointerdown and its pointerup/pointercancel: a tool gesture (path
   * drag, bulldoze drag, coaster drag, placement press) is held. A view turn waits for it to end,
   * because the gesture's cells were picked in the old orientation.
   */
  readonly gestureHeld: boolean;
  /**
   * Re-picks the cell under the last known pointer position after the mapping changed (a view turn)
   * and fires `hover` like a pointermove would. No-op while panning or with no known position; never
   * fires start/move/end.
   */
  rehover(): void;
  /** Off releases every held key and ignores new presses; releases are always heard. */
  setViewInputEnabled(enabled: boolean): void;
  /** Applies the held camera keys for one frame, one pan per held direction. */
  keyPan(deltaMs: number): void;
  /** Removes every listener the binding added. */
  destroy(): void;
}

/**
 * Binds the world input to `canvas`. `isInside` and `getHandlers` are read on every event, so a new
 * session's world and handlers registered after mount both take effect without rebinding.
 */
export const bindWorldInput = (
  canvas: WorldInputSurface,
  view: WorldInputView,
  isInside: (cell: Cell) => boolean,
  getHandlers: () => WorldInputHandlers | null,
  keySource: KeyEventSource = window,
  sensitivity: () => InputSensitivity = settingsSensitivity,
  panKeys: () => PanCodes = settingsPanCodes,
  viewFrame: () => ViewFrame = () => IDENTITY_VIEW_FRAME,
  /**
   * Voxel leftovers: a renderer whose surfaces stand above the ground (the voxel path top is PATH_PICK_LIFT texels up)
   * may re-pick: given the ground pick and the world point, return the cell the player sees there. Absent = the ground
   * pick, exactly as before (the classic renderer).
   */
  refinePick?: (ground: Cell, worldX: number, worldY: number) => Cell,
): WorldInput => {
  const keys = new Set<string>();
  let panning = false;
  let pointerDown = false;
  let lastPointer = { x: 0, y: 0 };
  let currentCell: Cell | null = null;
  let viewInputEnabled = true;
  let lastHoverClient: { clientX: number; clientY: number } | null = null;

  const eventToScreen = (event: { clientX: number; clientY: number }): { x: number; y: number } => {
    const rect = canvas.getBoundingClientRect();
    const size = view.cssSize();
    return {
      x: (event.clientX - rect.left) * (size.width / rect.width),
      y: (event.clientY - rect.top) * (size.height / rect.height),
    };
  };

  const eventToCell = (event: { clientX: number; clientY: number }): Cell => {
    const screen = eventToScreen(event);
    const world = view.cssToWorld(screen.x, screen.y);
    const ground = pickCell(viewFrame(), world.x, world.y);
    return refinePick ? refinePick(ground, world.x, world.y) : ground;
  };

  const onContextMenu = (event: MouseEvent): void => {
    event.preventDefault();
    getHandlers()?.cancel();
  };

  const onPointerDown = (event: PointerEvent): void => {
    pointerDown = true;
    lastPointer = { x: event.clientX, y: event.clientY };
    if (event.button === 1 || (event.button === 0 && (event.altKey || keys.has('Space')))) {
      panning = true;
      lastHoverClient = null;
      canvas.setPointerCapture(event.pointerId);
      return;
    }
    lastHoverClient = { clientX: event.clientX, clientY: event.clientY };
    if (event.button === 0) {
      const cell = eventToCell(event);
      if (isInside(cell)) getHandlers()?.start(cell, { shift: event.shiftKey === true });
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (panning) {
      view.panByCss(event.clientX - lastPointer.x, event.clientY - lastPointer.y);
      lastPointer = { x: event.clientX, y: event.clientY };
      return;
    }
    lastHoverClient = { clientX: event.clientX, clientY: event.clientY };
    const cell = eventToCell(event);
    const inside = isInside(cell);
    currentCell = inside ? cell : null;
    getHandlers()?.hover(currentCell);
    if (pointerDown && inside) getHandlers()?.move(cell);
  };

  const onPointerUp = (event: PointerEvent): void => {
    if (panning) {
      panning = false;
    } else if (event.button === 0) {
      const cell = eventToCell(event);
      if (isInside(cell)) getHandlers()?.end(cell);
    }
    pointerDown = false;
  };

  const onPointerCancel = (): void => {
    lastHoverClient = null;
    panning = false;
    pointerDown = false;
  };

  const onPointerLeave = (): void => {
    if (pointerDown) return;
    lastHoverClient = null;
    currentCell = null;
    getHandlers()?.hover(null);
  };

  const onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const point = eventToScreen(event);
    const { wheel } = sensitivity();
    view.zoomAtCss(point.x, point.y, wheel === 1 ? event : { deltaY: event.deltaY * wheel, deltaMode: event.deltaMode });
  };

  const onKeyDown = (event: KeyboardEvent): void => {
    if (!viewInputEnabled) return;
    // Ctrl, Cmd and Alt combinations belong to the browser (Ctrl+S must not nudge the camera).
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    keys.add(eventCode(event));
  };

  // Always released, even if the layer changed while the key was held.
  const onKeyUp = (event: KeyboardEvent): void => {
    keys.delete(eventCode(event));
  };

  canvas.addEventListener('contextmenu', onContextMenu);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  keySource.addEventListener('keydown', onKeyDown);
  keySource.addEventListener('keyup', onKeyUp);

  return {
    get hoveredCell(): Cell | null {
      return currentCell;
    },
    get gestureHeld(): boolean {
      return pointerDown && !panning;
    },
    rehover(): void {
      if (panning || !lastHoverClient) return;
      const cell = eventToCell(lastHoverClient);
      currentCell = isInside(cell) ? cell : null;
      getHandlers()?.hover(currentCell);
    },
    setViewInputEnabled(enabled: boolean): void {
      viewInputEnabled = enabled;
      if (!enabled) keys.clear();
    },
    keyPan(deltaMs: number): void {
      const speed = KEY_PAN_CSS_PER_MS * deltaMs * sensitivity().keyPan;
      const pan = panKeys();
      const held = (codes: readonly string[]): boolean => codes.some((code) => keys.has(code));
      const left = held(pan.left);
      const right = held(pan.right);
      const up = held(pan.up);
      const down = held(pan.down);
      // One pan per direction, in the legacy order, so the classic camera's float maths is unchanged.
      if (left) view.panByCss(speed, 0);
      if (right) view.panByCss(-speed, 0);
      if (up) view.panByCss(0, speed);
      if (down) view.panByCss(0, -speed);
    },
    destroy(): void {
      canvas.removeEventListener('contextmenu', onContextMenu);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('wheel', onWheel);
      keySource.removeEventListener('keydown', onKeyDown);
      keySource.removeEventListener('keyup', onKeyUp);
      keys.clear();
    },
  };
};
