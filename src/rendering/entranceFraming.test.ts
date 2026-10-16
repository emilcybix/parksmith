import { describe, expect, it } from 'vitest';
import { MAPS } from '../game/maps/content';
import { layoutOfMapId } from '../game/maps/parse';
import { cellToWorld } from './isometric';
import { ENTRANCE_ANCHOR_DEPTH, ENTRANCE_ANCHOR_HEIGHT_FRACTION, entranceFocus } from './entranceFraming';
import { cellToView, createViewFrame, VIEW_ROTATIONS } from './viewRotation';
import { ParkSession } from '../game/session/ParkSession';
import { VoxelCamera } from './voxel/camera';

/**
 * Phase 24: the shared entrance-framing rule. Meadow's gate on its view-0 south edge keeps the long-standing anchor cell
 * (15.5, 20), so every Meadow camera is as it was; any other gate or view uses the legacy framing only when the gate is
 * at the bottom of the picture, else the midpoint of the gate and the map centre.
 */

const frameFor = (rotation: 0 | 1 | 2 | 3) => createViewFrame(rotation, 32, 32);

describe('entranceFocus', () => {
  it('Meadow: view 0 anchors on (15.5, 20), every other view centres the midpoint', () => {
    const gate = layoutOfMapId('meadow').entrance;
    expect(entranceFocus(frameFor(0), gate)).toEqual({ mode: 'anchor', viewX: 15.5, viewY: 20 });
    for (const rotation of [1, 2, 3] as const) expect(entranceFocus(frameFor(rotation), gate), `view ${rotation}`).toEqual({ mode: 'midpoint' });
    expect(ENTRANCE_ANCHOR_DEPTH).toBe(11);
    expect(ENTRANCE_ANCHOR_HEIGHT_FRACTION).toBe(0.18);
  });

  it('exactly one view puts any gate at the bottom of the picture, and that view anchors 11 cells above it', () => {
    for (const map of MAPS.filter((candidate) => candidate.width === 32)) {
      const gate = layoutOfMapId(map.id).entrance;
      const anchors = VIEW_ROTATIONS.map((rotation) => entranceFocus(frameFor(rotation), gate)).filter((focus) => focus.mode === 'anchor');
      expect(anchors, map.id).toHaveLength(1);
      const [anchor] = anchors;
      if (anchor.mode !== 'anchor') throw new Error('unreachable');
      expect(anchor.viewY, map.id).toBe(31 - ENTRANCE_ANCHOR_DEPTH);
    }
  });

  it('Red Rock Canyon (gate (16, 0), south) anchors in view 2 and Seaside Cove (gate (0, 15), east) in view 3', () => {
    const red = layoutOfMapId('red-rock-canyon').entrance;
    expect([red.x, red.y, red.facing]).toEqual([16, 0, 'south']);
    expect(entranceFocus(frameFor(2), red)).toEqual({ mode: 'anchor', viewX: 15.5, viewY: 20 });
    const cove = layoutOfMapId('seaside-cove').entrance;
    expect([cove.x, cove.y, cove.facing]).toEqual([0, 15, 'east']);
    expect(entranceFocus(frameFor(3), cove)).toEqual({ mode: 'anchor', viewX: 15.5, viewY: 20 });
    expect(entranceFocus(frameFor(0), cove)).toEqual({ mode: 'midpoint' });
  });
});

describe('the voxel camera frames any gate', () => {
  const cameraAt = (): VoxelCamera => {
    const camera = new VoxelCamera({ zoomOverride: null });
    camera.setViewport(1440, 800, 1, 16384);
    return camera;
  };

  it('puts the anchor at 18 % of the screen height and the middle of the width', () => {
    const camera = cameraAt();
    const red = layoutOfMapId('red-rock-canyon').entrance;
    camera.focusEntranceInView(frameFor(2), red.x, red.y);
    const size = camera.cssSize();
    const shown = camera.cssToWorld(size.width * 0.5, size.height * 0.18);
    const expected = cellToWorld({ x: 15.5, y: 20 });
    expect(Math.abs(shown.x - expected.x)).toBeLessThan(1);
    expect(Math.abs(shown.y - expected.y)).toBeLessThan(1);
  });

  it('a gate in a view that does not put it at the bottom is centred with the park heart (midpoint rule), on screen in all views', () => {
    // The 32 x 32 maps (the view arithmetic below is theirs); the Phase 21 estate has its own test below.
    for (const map of MAPS.filter((candidate) => candidate.width === 32)) {
      const gate = layoutOfMapId(map.id).entrance;
      for (const rotation of VIEW_ROTATIONS) {
        const camera = cameraAt();
        const frame = frameFor(rotation);
        camera.focusEntranceInView(frame, gate.x, gate.y);
        const size = camera.cssSize();
        const snap = camera.snapped();
        // The gate's cell middle, in the view, in screen px.
        const view = { x: rotation === 0 ? gate.x : rotation === 1 ? 31 - gate.y : rotation === 2 ? 31 - gate.x : gate.y, y: rotation === 0 ? gate.y : rotation === 1 ? gate.x : rotation === 2 ? 31 - gate.y : 31 - gate.x };
        const texel = cellToWorld(view);
        const x = (texel.x - camera.originX) * snap.zoom;
        const y = (texel.y + 16 - camera.originY) * snap.zoom;
        expect(x, `${map.id} view ${rotation}`).toBeGreaterThan(0);
        expect(x).toBeLessThan(size.width * snap.zoom);
        expect(y).toBeGreaterThan(0);
        expect(y).toBeLessThan(size.height * snap.zoom);
      }
    }
  });
});

describe('Phase 21: an estate frames its gate with the owned land', () => {
  const cameraAt = (): VoxelCamera => {
    const camera = new VoxelCamera({ zoomOverride: null });
    camera.setViewport(1440, 800, 1, 16384);
    return camera;
  };

  it('Meadow Estate anchors in view 0 (gate on the south edge) and centres gate and owned heart in the other views', () => {
    const session = new ParkSession(null, [], { mapId: 'meadow-estate' });
    const { entrance, heart } = session.world;
    expect([entrance.x, entrance.y]).toEqual([31, 63]);
    expect(heart).toEqual({ x: 31.5, y: 51.5 });
    expect(entranceFocus(createViewFrame(0, 64, 64), entrance)).toEqual({ mode: 'anchor', viewX: 31.5, viewY: 52 });
    for (const rotation of VIEW_ROTATIONS) {
      const camera = cameraAt();
      const frame = createViewFrame(rotation, 64, 64);
      camera.focusEntranceInView(frame, entrance.x, entrance.y, heart);
      const size = camera.cssSize();
      const snap = camera.snapped();
      for (const cell of [entrance, { x: Math.round(heart.x), y: Math.round(heart.y) }]) {
        const view = { x: 0, y: 0 };
        cellToView(frame, cell.x, cell.y, view);
        const texel = cellToWorld(view);
        const x = (texel.x - camera.originX) * snap.zoom;
        const y = (texel.y + 16 - camera.originY) * snap.zoom;
        expect(x, `view ${rotation}`).toBeGreaterThan(0);
        expect(x, `view ${rotation}`).toBeLessThan(size.width * snap.zoom);
        expect(y, `view ${rotation}`).toBeGreaterThan(0);
        expect(y, `view ${rotation}`).toBeLessThan(size.height * snap.zoom);
      }
    }
  });
});
