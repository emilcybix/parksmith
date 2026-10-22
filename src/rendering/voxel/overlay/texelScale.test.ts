import { Container } from 'pixi.js';
import { afterEach, describe, expect, it } from 'vitest';
import { ParkSession } from '../../../game/session/ParkSession';
import { VoxelEffects } from './effects';
import { VoxelHints } from './hints';
import { recordedGeometry } from './overlayTestKit';
import { VoxelOverlays, overlayStrokeWidth } from './overlays';

/**
 * Phase 55 step 4: the overlays at the far zoom levels. The overlay root is scaled by 1 / k, so strokes are drawn k
 * times as wide (they stay 1 and 2 texels on screen) and the pixel-art badges and effects are hidden: an overview.
 */
const CELLS = [{ x: 4, y: 4 }, { x: 5, y: 4 }, { x: 4, y: 5 }];

describe('Phase 55: overlays at a texel scale', () => {
  let overlays: VoxelOverlays | null = null;
  afterEach(() => {
    // The stroke scale is shared by every overlay layer: leave it at 1 for the other tests.
    overlays?.setTexelScale(1);
  });

  it('strokes keep their width on screen: k times as wide in world texels, the same scale again is free', () => {
    const session = new ParkSession(null);
    const root = new Container();
    overlays = new VoxelOverlays(root, () => session);
    overlays.drawPreview(CELLS, null, true, false);
    const near = recordedGeometry(root).widths;
    expect(near.length).toBeGreaterThan(0);
    const version = overlays.version;
    overlays.setTexelScale(4);
    expect(overlays.version).toBe(version + 1);
    expect(overlayStrokeWidth(1)).toBe(4);
    expect(recordedGeometry(root).widths).toEqual(near.map((width) => width * 4));
    overlays.setTexelScale(4);
    expect(overlays.version, 'the same scale again changes nothing').toBe(version + 1);
    overlays.setTexelScale(1);
    expect(recordedGeometry(root).widths).toEqual(near);
  });

  it('the hint ring is repainted at the new width', () => {
    const session = new ParkSession(null);
    const root = new Container();
    overlays = new VoxelOverlays(new Container(), () => session);
    const hints = new VoxelHints(root, 0, () => true);
    hints.set([{ cells: CELLS }]);
    const near = recordedGeometry(root).widths;
    overlays.setTexelScale(2);
    hints.restroke();
    expect(recordedGeometry(root).widths).toEqual(near.map((width) => width * 2));
  });

  it('hidden effects count as empty and keep running; one version bump per change', () => {
    const session = new ParkSession(null);
    const effects = new VoxelEffects(new Container(), () => session, () => null);
    effects.show({ kind: 'money-spend', x: 10, y: 10, objectId: null, amount: 1_150 });
    effects.update(16);
    expect(effects.isEmpty).toBe(false);
    const version = effects.version;
    effects.setHidden(true);
    effects.setHidden(true);
    expect(effects.version).toBe(version + 1);
    expect(effects.isEmpty).toBe(true);
    effects.setHidden(false);
    expect(effects.isEmpty).toBe(false);
  });
});
