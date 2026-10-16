import { Container, Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { VIEW_ROTATIONS } from '../../viewRotation';
import { HINT_STEP_MS, VoxelHints } from './hints';
import { recordedGeometry, viewFrameOf } from './overlayTestKit';
import { viewCell } from './overlays';

const MARKERS = [{ cells: [{ x: 4, y: 5 }, { x: 5, y: 5 }] }];

const rig = (reducedMotion = false) => {
  const root = new Container();
  root.addChild(new Container(), new Container(), new Container());
  const hints = new VoxelHints(root, 2, () => reducedMotion);
  const layer = root.children[2] as Container;
  return { root, hints, layer };
};

describe('VoxelHints', () => {
  it('is empty by default and sits at the requested layer index', () => {
    const { hints, root } = rig();
    expect(hints.isEmpty).toBe(true);
    expect(root.children).toHaveLength(4);
  });

  it('set makes it non-empty, with the bright phase showing, and empty list clears it', () => {
    const { hints, layer } = rig();
    hints.set(MARKERS);
    expect(hints.isEmpty).toBe(false);
    const [bright, dim] = layer.children as Graphics[];
    expect([bright.visible, dim.visible]).toEqual([true, false]);
    const version = hints.version;
    hints.set([]);
    expect(hints.isEmpty).toBe(true);
    expect(layer.children).toHaveLength(0);
    expect(hints.version).toBeGreaterThan(version);
  });

  it('setting nothing on an empty marker changes nothing', () => {
    const { hints } = rig();
    hints.set([]);
    expect(hints.version).toBe(0);
  });

  it('does not leak children when set is called repeatedly', () => {
    const { hints, layer } = rig();
    for (let i = 0; i < 5; i += 1) hints.set(MARKERS);
    expect(layer.children).toHaveLength(2);
  });

  it('bumps the version only when the pulse phase changes', () => {
    const { hints, layer } = rig();
    hints.set(MARKERS);
    const start = hints.version;
    hints.update(0);
    hints.update(HINT_STEP_MS - 1);
    expect(hints.version).toBe(start);
    hints.update(HINT_STEP_MS);
    expect(hints.version).toBe(start + 1);
    const [bright, dim] = layer.children as Graphics[];
    expect([bright.visible, dim.visible]).toEqual([false, true]);
    hints.update(HINT_STEP_MS + 100);
    expect(hints.version).toBe(start + 1);
    hints.update(HINT_STEP_MS * 2);
    expect(hints.version).toBe(start + 2);
    expect(bright.visible).toBe(true);
  });

  it('never bumps the version under reduced motion', () => {
    const { hints, layer } = rig(true);
    hints.set(MARKERS);
    const start = hints.version;
    for (let ms = 0; ms < HINT_STEP_MS * 6; ms += 100) hints.update(ms);
    expect(hints.version).toBe(start);
    expect((layer.children[0] as Graphics).visible).toBe(true);
  });

  it('reset empties it and a second reset is a no-op', () => {
    const { hints } = rig();
    hints.set(MARKERS);
    hints.reset();
    expect(hints.isEmpty).toBe(true);
    const version = hints.version;
    hints.reset();
    expect(hints.version).toBe(version);
  });

  it('keeps no reference to the markers it was given', () => {
    const { hints, layer } = rig();
    const cells = [{ x: 1, y: 1 }];
    hints.set([{ cells }]);
    cells.push({ x: 2, y: 2 });
    expect(layer.children).toHaveLength(2);
    expect(hints.isEmpty).toBe(false);
  });
});

describe('VoxelHints in a turned view (Phase 26)', () => {
  const frameOf = (rotation: 0 | 1 | 2 | 3) => viewFrameOf(rotation, 32, 20);

  it('paints the ring in view q exactly as view 0 paints the turned cells', () => {
    for (const q of VIEW_ROTATIONS) {
      const turned = rig();
      turned.hints.setView(frameOf(q));
      turned.hints.set(MARKERS);
      const reference = rig();
      reference.hints.set([{ cells: MARKERS[0].cells.map((cell) => viewCell(frameOf(q), cell)) }]);
      expect(recordedGeometry(turned.root), `view ${q}`).toEqual(recordedGeometry(reference.root));
    }
  });

  it('repaints on a turn keeping the pulse phase, bumps the version once, and a repeat is free', () => {
    const { hints, layer, root } = rig();
    hints.set(MARKERS);
    hints.update(HINT_STEP_MS);
    const flat = recordedGeometry(root).coordinates;
    const before = hints.version;
    hints.setView(frameOf(1));
    expect(hints.version).toBe(before + 1);
    const [bright, dim] = layer.children as Graphics[];
    expect([bright.visible, dim.visible], 'dim phase kept').toEqual([false, true]);
    expect(recordedGeometry(root).coordinates).not.toEqual(flat);
    hints.setView(frameOf(1));
    expect(hints.version).toBe(before + 1);
    expect(layer.children, 'no leak').toHaveLength(2);
    hints.setView(frameOf(0));
    hints.update(0);
    expect(recordedGeometry(root).coordinates, 'turning back restores view 0').toEqual(flat);
  });

  it('keeps the world cells through reset-free turns and forgets them on reset', () => {
    const { hints, layer } = rig();
    hints.set(MARKERS);
    hints.reset();
    hints.setView(frameOf(2));
    expect(layer.children).toHaveLength(0);
    expect(hints.isEmpty).toBe(true);
  });
});
