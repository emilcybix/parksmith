import { Container, Graphics } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from '../../../game/content/catalog';
import { ParkSession } from '../../../game/session/ParkSession';
import type { CoasterPiece } from '../../../game/coaster/design';
import { countGraphicsDrawCalls } from '../../drawCallCounter';
import { VIEW_ROTATIONS, type ViewRotation } from '../../viewRotation';
import { cellToView } from '../../viewRotation';
import { cellToWorld } from '../../isometric';
import { COASTER_LEVEL_VOXELS } from '../contracts/space';
import { recordedGeometry, sortedNumbers, viewFrameOf } from './overlayTestKit';
import type { CrowdBand, CrowdHeatmapView } from '../../../game/crowd/types';
import { CROWD_BAND_ALPHAS, CROWD_BAND_COLORS, CROWD_RIM_COLOR, texelDiamond, viewCell, VoxelOverlays } from './overlays';

const rig = (): { session: ParkSession; overlays: VoxelOverlays; root: Container } => {
  const session = new ParkSession(null);
  const root = new Container();
  return { session, root, overlays: new VoxelOverlays(root, () => session) };
};

const recorded = recordedGeometry;

const cells = [{ x: 10, y: 10 }, { x: 11, y: 10 }];
const piece = (x: number, y: number): CoasterPiece => ({ cell: { x, y }, height: 1 });

describe('texelDiamond', () => {
  it('keeps the 2:1 slope and whole texels for whole insets', () => {
    expect(texelDiamond(0, 0)).toEqual([0, 0, 32, 16, 0, 32, -32, 16]);
    expect(texelDiamond(64, 48, 2)).toEqual([64, 50, 92, 64, 64, 78, 36, 64]);
  });
});

describe('VoxelOverlays versions and emptiness', () => {
  it('starts empty and bumps the version on every content change', () => {
    const { overlays } = rig();
    expect(overlays.isEmpty).toBe(true);
    let version = overlays.version;
    const bumped = (): boolean => {
      const changed = overlays.version > version;
      version = overlays.version;
      return changed;
    };
    overlays.drawPreview(cells, null, true);
    expect([overlays.isEmpty, bumped()]).toEqual([false, true]);
    overlays.drawPreview(cells, null, false, false);
    expect(bumped(), 'a new preview').toBe(true);
    overlays.clearPreview();
    expect([overlays.isEmpty, bumped()]).toEqual([true, true]);
    overlays.clearPreview();
    expect(bumped(), 'clearing nothing changes nothing').toBe(false);
    overlays.drawCoasterDraft([piece(4, 4), piece(5, 4), piece(6, 4)]);
    expect([overlays.isEmpty, bumped()]).toEqual([false, true]);
    overlays.drawCoasterDraft([]);
    expect([overlays.isEmpty, bumped()]).toEqual([true, true]);
  });

  it('reset forgets selection, draft and preview', () => {
    const { overlays, session } = rig();
    const placed = session.world.seedScenarioObject('petal-roundabout', { x: 6, y: 6 })!;
    overlays.selectObject(placed);
    overlays.drawPreview(cells, null, true);
    overlays.drawCoasterDraft([piece(4, 4), piece(5, 4)]);
    expect(overlays.isEmpty).toBe(false);
    overlays.reset();
    expect(overlays.isEmpty).toBe(true);
    const calls = countGraphicsDrawCalls(() => overlays.syncWorld());
    expect(calls, 'nothing selected any more').toBe(0);
  });
});

describe('selection', () => {
  it('outlines the footprint and clears when the object is gone', () => {
    const { overlays, session } = rig();
    const placed = session.world.seedScenarioObject('petal-roundabout', { x: 6, y: 6 })!;
    overlays.selectObject(placed);
    expect(overlays.isEmpty).toBe(false);
    const version = overlays.version;
    session.world.objects.delete(placed.id);
    overlays.syncWorld();
    expect(overlays.isEmpty).toBe(true);
    expect(overlays.version).toBeGreaterThan(version);
  });
});

describe('coaster draft', () => {
  const blockedPieces = (session: ParkSession): CoasterPiece[] => {
    session.world.seedScenarioObject('tidy-totem', { x: 5, y: 4 });
    return [piece(4, 4), piece(5, 4), piece(6, 4)];
  };

  it('survives hover previews and bulldoze, and dims when parked', () => {
    const { overlays, session, root } = rig();
    const pieces = blockedPieces(session);
    overlays.drawCoasterDraft(pieces, true);
    const draft = root.children[4] as Container;
    expect(draft.children.length).toBe(1);
    overlays.drawPreview(cells, null, true);
    overlays.drawPreview(cells, null, false, true);
    overlays.clearPreview();
    expect(draft.children.length, 'the draft is not a preview').toBe(1);
    expect(draft.alpha).toBe(1);
    overlays.drawCoasterDraft(pieces, false);
    expect(draft.alpha, 'parked: half, so 50 % fills dither at 25 %').toBe(0.5);
  });

  it('draws the close-the-loop guide only while the layout cannot close', () => {
    const { overlays, root } = rig();
    const open = [piece(4, 4), piece(5, 4), piece(6, 4)];
    overlays.drawCoasterDraft(open);
    const draft = root.children[4] as Container;
    const strokeCount = (): number => (draft.children[0] as Graphics).context.instructions.filter((i) => i.action === 'stroke').length;
    expect(strokeCount(), 'guide drawn').toBe(1);
    overlays.drawCoasterDraft([piece(4, 4), piece(5, 4), piece(5, 5), piece(4, 5)]);
    expect(strokeCount(), 'closable: no guide').toBe(0);
  });
});

describe('whole-texel geometry', () => {
  it('uses only whole coordinates and 1-2 texel lines for preview, selection, heatmap and draft', () => {
    const { overlays, session, root } = rig();
    const placed = session.world.seedScenarioObject('petal-roundabout', { x: 6, y: 6 })!;
    session.world.seedScenarioObject('tidy-totem', { x: 5, y: 4 });
    overlays.drawPreview(cells, BUILD_BY_ID.get('lollipop-lamp')!, true);
    overlays.selectObject(placed);
    overlays.drawCoasterDraft([piece(4, 4), piece(5, 4), piece(6, 4)]);
    session.world.seedScenarioObject('lollipop-lamp', { x: 12, y: 12 });
    session.scenery.syncWithWorld();
    overlays.setInfluenceVisible(true);
    overlays.syncWorld();
    const { coordinates, widths } = recorded(root);
    expect(coordinates.length).toBeGreaterThan(40);
    expect(coordinates.filter((value) => !Number.isInteger(value)), 'fractional coordinates').toEqual([]);
    expect(widths.length).toBeGreaterThan(0);
    for (const width of widths) expect([1, 2]).toContain(width);
  });
});

describe('heatmap', () => {
  it('only rebuilds when visible and dirty', () => {
    const { overlays, session } = rig();
    session.world.seedScenarioObject('lollipop-lamp', { x: 12, y: 12 });
    session.scenery.syncWithWorld();
    expect(countGraphicsDrawCalls(() => overlays.syncWorld()), 'hidden: nothing built').toBe(0);
    expect(overlays.isEmpty).toBe(true);
    overlays.setInfluenceVisible(true);
    expect(overlays.isEmpty, 'shown: built on the toggle').toBe(false);
    const version = overlays.version;
    expect(countGraphicsDrawCalls(() => overlays.setInfluenceVisible(true)), 'no change, no rebuild').toBe(0);
    expect(overlays.version).toBe(version);
    overlays.setInfluenceVisible(false);
    expect(overlays.isEmpty).toBe(true);
    expect(overlays.version, 'hiding is a change').toBeGreaterThan(version);
  });
});

describe('view rotation (Phase 26)', () => {
  const world = new ParkSession(null).world;
  const frameOf = (rotation: ViewRotation) => viewFrameOf(rotation, world.width, world.height);
  const mapped = (rotation: ViewRotation, list: readonly { x: number; y: number }[]) => list.map((cell) => viewCell(frameOf(rotation), cell));
  const pieces = [piece(4, 4), piece(5, 4), piece(6, 4)];

  it('draws a build preview, scenery influence and a draft in view q exactly as view 0 draws the turned layout', () => {
    const definition = BUILD_BY_ID.get('lollipop-lamp')!;
    for (const q of VIEW_ROTATIONS) {
      const turned = rig();
      turned.overlays.setView(frameOf(q));
      turned.overlays.drawPreview(cells, definition, true);
      const reference = rig();
      reference.overlays.drawPreview(mapped(q, cells), definition, true);
      // The influence entries are computed in world space (their distances are), then drawn through the view: same set of shapes.
      expect(sortedNumbers(recorded(turned.root).coordinates), `preview, view ${q}`).toEqual(sortedNumbers(recorded(reference.root).coordinates));
      expect(recorded(turned.root).widths).toEqual(recorded(reference.root).widths);
    }
  });

  it('draws the coaster draft (blocked cells and the guide) through the view', () => {
    for (const q of VIEW_ROTATIONS) {
      const turned = rig();
      turned.session.world.seedScenarioObject('tidy-totem', { x: 5, y: 4 });
      turned.overlays.setView(frameOf(q));
      turned.overlays.drawCoasterDraft(pieces);
      const geometry = recorded(turned.root).coordinates;
      // The guide runs from the last to the first piece, lifted by the height level, in view texels.
      const point = (piece: CoasterPiece) => {
        const at = cellToWorld(viewCell(frameOf(q), piece.cell));
        return [at.x, at.y + 16 - piece.height * COASTER_LEVEL_VOXELS];
      };
      const [fromX, fromY] = point(pieces[2]);
      const [toX, toY] = point(pieces[0]);
      const pairs = geometry.slice(-4);
      expect(pairs, `guide, view ${q}`).toEqual([fromX, fromY, toX, toY]);
      // The blocked cell (5, 4) is the diamond at its view cell.
      const blocked = cellToWorld(viewCell(frameOf(q), { x: 5, y: 4 }));
      expect(geometry.slice(0, 2), `blocked diamond top, view ${q}`).toEqual([blocked.x, blocked.y + 1]);
    }
  });

  it('draws the selection outline on the footprint\'s view cells', () => {
    for (const q of VIEW_ROTATIONS) {
      const { overlays, session, root } = rig();
      const placed = session.world.seedScenarioObject('petal-roundabout', { x: 6, y: 6 })!;
      overlays.setView(frameOf(q));
      overlays.selectObject(placed);
      const numbers = recorded(root).coordinates;
      for (const cell of session.world.objectFootprint(placed)) {
        const out = { x: 0, y: 0 };
        cellToView(frameOf(q), cell.x, cell.y, out);
        const top = cellToWorld(out);
        let found = false;
        for (let i = 0; i + 1 < numbers.length; i += 1) found ||= numbers[i] === top.x && numbers[i + 1] === top.y;
        expect(found, `cell ${cell.x},${cell.y} in view ${q}`).toBe(true);
      }
    }
  });

  it('keeps everything on whole texels in every view', () => {
    for (const q of VIEW_ROTATIONS) {
      const { overlays, session, root } = rig();
      const placed = session.world.seedScenarioObject('petal-roundabout', { x: 6, y: 6 })!;
      overlays.setView(frameOf(q));
      overlays.drawPreview(cells, BUILD_BY_ID.get('lollipop-lamp')!, true);
      overlays.selectObject(placed);
      overlays.drawCoasterDraft(pieces);
      expect(recorded(root).coordinates.filter((value) => !Number.isInteger(value))).toEqual([]);
    }
  });

  it('redraws retained state on a turn, bumps the version once, and a repeat or a steady frame draws nothing', () => {
    const { overlays, session, root } = rig();
    const placed = session.world.seedScenarioObject('petal-roundabout', { x: 6, y: 6 })!;
    overlays.setView(frameOf(0));
    overlays.selectObject(placed);
    overlays.drawPreview(cells, null, true);
    overlays.drawCoasterDraft(pieces);
    const before = overlays.version;
    overlays.setView(frameOf(1));
    expect(overlays.version, 'one bump for the whole turn').toBe(before + 1);
    const turnedGeometry = recorded(root).coordinates;
    // Retained in WORLD cells: turning back restores the view-0 drawing exactly.
    overlays.setView(frameOf(0));
    expect(overlays.version).toBe(before + 2);
    const reference = rig();
    reference.session.world.seedScenarioObject('petal-roundabout', { x: 6, y: 6 });
    reference.overlays.selectObject(reference.session.world.objects.get(placed.id) ?? placed);
    reference.overlays.drawPreview(cells, null, true);
    reference.overlays.drawCoasterDraft(pieces);
    expect(sortedNumbers(recorded(root).coordinates)).toEqual(sortedNumbers(recorded(reference.root).coordinates));
    expect(turnedGeometry).not.toEqual(recorded(root).coordinates);
    const steady = overlays.version;
    const calls = countGraphicsDrawCalls(() => {
      overlays.setView(frameOf(0));
    });
    expect([overlays.version, calls], 'the same view again is free').toEqual([steady, 0]);
  });

  it('a turn with nothing shown still changes the view once and keeps the overlays empty', () => {
    const { overlays } = rig();
    const before = overlays.version;
    overlays.setView(frameOf(2));
    expect([overlays.isEmpty, overlays.version]).toEqual([true, before + 1]);
    overlays.setView(frameOf(2));
    expect(overlays.version).toBe(before + 1);
  });

  it('view 0 draws the identical geometry whether or not setView was ever called', () => {
    const plain = rig();
    const viewed = rig();
    viewed.overlays.setView(frameOf(0));
    for (const target of [plain, viewed]) {
      target.overlays.drawPreview(cells, BUILD_BY_ID.get('lollipop-lamp')!, true);
      target.overlays.drawCoasterDraft(pieces);
    }
    expect(recorded(viewed.root).coordinates).toEqual(recorded(plain.root).coordinates);
  });
});

describe('paint hover (Phase 28 step 2)', () => {
  const world = new ParkSession(null).world;
  const frameOf = (rotation: ViewRotation) => viewFrameOf(rotation, world.width, world.height);
  const targetCells = [{ x: 6, y: 6 }, { x: 7, y: 6 }, { x: 6, y: 7 }, { x: 7, y: 7 }];
  const TEAL = 0x3aa7a3;

  it('is retained, outlines the target in white and tints it; empty input clears it', () => {
    const { overlays, root } = rig();
    expect(overlays.isEmpty).toBe(true);
    const before = overlays.version;
    overlays.setPaintHover(targetCells, TEAL);
    expect(overlays.isEmpty).toBe(false);
    expect(overlays.version, 'one change').toBe(before + 1);
    const { widths } = recorded(root);
    expect(widths, 'a 2-texel outline, like the selection').toContain(2);
    overlays.setPaintHover([], null);
    expect(overlays.isEmpty).toBe(true);
    expect(overlays.version).toBe(before + 2);
    overlays.clearPaintHover();
    expect(overlays.version, 'clearing nothing is free').toBe(before + 2);
  });

  it('the same cells and tint again cost nothing: no version bump, no drawing; a new cell, tint or clear is one change', () => {
    const { overlays } = rig();
    overlays.setPaintHover(targetCells, TEAL);
    const version = overlays.version;
    const calls = countGraphicsDrawCalls(() => {
      overlays.setPaintHover(targetCells.map((cell) => ({ ...cell })), TEAL);
      overlays.setPaintHover(targetCells, TEAL);
    });
    expect([overlays.version, calls]).toEqual([version, 0]);
    overlays.setPaintHover(targetCells, null);
    expect(overlays.version, 'tint change').toBe(version + 1);
    overlays.setPaintHover(targetCells.slice(0, 2), null);
    expect(overlays.version, 'cell change').toBe(version + 2);
    overlays.clearPaintHover();
    expect(overlays.version, 'clear').toBe(version + 3);
  });

  it('a brush without a colour draws the outline only; a colour adds one 25 % fill per cell', () => {
    const outlineOnly = rig();
    outlineOnly.overlays.setPaintHover(targetCells, null);
    const tinted = rig();
    tinted.overlays.setPaintHover(targetCells, TEAL);
    const count = (root: Container): number => {
      let fills = 0;
      const visit = (node: Container): void => {
        if (node instanceof Graphics) fills += node.context.instructions.filter((instruction) => instruction.action === 'fill').length;
        node.children.forEach((child) => visit(child as Container));
      };
      visit(root);
      return fills;
    };
    expect(count(outlineOnly.root)).toBe(0);
    expect(count(tinted.root)).toBe(targetCells.length);
  });

  it('draws the target on its view cells in every rotation, redraws on a turn with one bump, and stays on whole texels', () => {
    for (const q of VIEW_ROTATIONS) {
      const { overlays, root } = rig();
      overlays.setView(frameOf(q));
      overlays.setPaintHover(targetCells, TEAL);
      const numbers = recorded(root).coordinates;
      for (const cell of targetCells) {
        const out = { x: 0, y: 0 };
        cellToView(frameOf(q), cell.x, cell.y, out);
        const top = cellToWorld(out);
        let found = false;
        for (let i = 0; i + 1 < numbers.length; i += 1) found ||= numbers[i] === top.x && numbers[i + 1] === top.y;
        expect(found, `cell ${cell.x},${cell.y} in view ${q}`).toBe(true);
      }
      expect(numbers.filter((value) => !Number.isInteger(value))).toEqual([]);
    }
    const { overlays, root } = rig();
    overlays.setView(frameOf(0));
    overlays.setPaintHover(targetCells, TEAL);
    const before = overlays.version;
    const atZero = recorded(root).coordinates;
    overlays.setView(frameOf(1));
    expect(overlays.version, 'one bump for the turn').toBe(before + 1);
    expect(recorded(root).coordinates).not.toEqual(atZero);
    overlays.setView(frameOf(0));
    expect(sortedNumbers(recorded(root).coordinates), 'retained in world cells: turning back restores the drawing').toEqual(sortedNumbers(atZero));
  });

  it('a new park forgets it', () => {
    const { overlays } = rig();
    overlays.setPaintHover(targetCells, TEAL);
    overlays.reset();
    expect(overlays.isEmpty).toBe(true);
  });
});

describe('crowd heatmap (Phase 14)', () => {
  const world = new ParkSession(null).world;
  const frameOf = (rotation: ViewRotation) => viewFrameOf(rotation, world.width, world.height);
  // A corridor of each band, the severe pair adjacent so the rim goes round the pair, not between.
  const crowdCells = [{ x: 4, y: 8 }, { x: 5, y: 8 }, { x: 6, y: 8 }, { x: 7, y: 8 }, { x: 8, y: 8 }, { x: 9, y: 8 }];
  const crowdBands: CrowdBand[] = [0, 1, 1, 2, 3, 3];
  const viewOf = (revision: number, cells = crowdCells, bands = crowdBands): CrowdHeatmapView => ({ revision, cells, bands });
  const instructionsOf = (root: Container) => {
    const out: { action: string; color?: number; alpha?: number; width?: number }[] = [];
    const visit = (node: Container): void => {
      if (node instanceof Graphics) {
        for (const instruction of node.context.instructions) {
          const style = (instruction.data as { style?: { color?: number; alpha?: number; width?: number } }).style;
          out.push({ action: instruction.action, color: style?.color, alpha: style?.alpha, width: style?.width });
        }
      }
      node.children.forEach((child) => visit(child as Container));
    };
    visit(root);
    return out;
  };

  it('is the bottom layer, empty and hidden until a view is given', () => {
    const { overlays, root } = rig();
    expect(root.children.length).toBe(7);
    const crowd = root.children[1] as Container;
    expect([crowd.visible, crowd.children.length]).toEqual([false, 0]);
    overlays.setCrowdHeatmap(viewOf(1));
    expect([crowd.visible, crowd.children.length, overlays.isEmpty]).toEqual([true, 1, false]);
  });

  it('draws the four bands (one fill each, in band order, colour and eighths alpha) and a white 1-texel rim round the severe set', () => {
    const { overlays, root } = rig();
    overlays.setCrowdHeatmap(viewOf(1));
    const instructions = instructionsOf(root);
    expect(instructions.map((entry) => entry.action)).toEqual(['fill', 'fill', 'fill', 'fill', 'stroke']);
    expect(instructions.slice(0, 4).map((entry) => entry.color)).toEqual([...CROWD_BAND_COLORS]);
    expect(instructions.slice(0, 4).map((entry) => entry.alpha)).toEqual([...CROWD_BAND_ALPHAS]);
    for (const alpha of CROWD_BAND_ALPHAS) expect(Number.isInteger(alpha * 8)).toBe(true);
    expect(instructions[4]).toMatchObject({ color: CROWD_RIM_COLOR, alpha: 1, width: 1 });
    // One diamond per tile, then the rim: the 6 outer sides of the severe pair (none between the two).
    const graphic = (root.children[1] as Container).children[0] as Graphics;
    const steps = graphic.context.instructions.flatMap((instruction) =>
      (instruction.data as { path: { instructions: { action: string }[] } }).path.instructions.map((step) => step.action));
    expect([steps.filter((step) => step === 'poly').length, steps.filter((step) => step === 'lineTo').length]).toEqual([6, 6]);
    expect(recorded(root).coordinates.filter((value) => !Number.isInteger(value))).toEqual([]);
  });

  it('a view without severe tiles has no rim; an empty view draws nothing', () => {
    const { overlays, root } = rig();
    overlays.setCrowdHeatmap(viewOf(1, crowdCells.slice(0, 4), crowdBands.slice(0, 4)));
    expect(instructionsOf(root).map((entry) => entry.action)).toEqual(['fill', 'fill', 'fill']);
    overlays.setCrowdHeatmap(viewOf(2, [], []));
    expect([overlays.isEmpty, instructionsOf(root).length]).toEqual([true, 0]);
  });

  it('the same revision again costs zero Graphics calls and no version bump, whatever arrays it comes in', () => {
    const { overlays } = rig();
    overlays.setCrowdHeatmap(viewOf(7));
    const version = overlays.version;
    const calls = countGraphicsDrawCalls(() => {
      for (let frame = 0; frame < 30; frame += 1) {
        overlays.setCrowdHeatmap(viewOf(7, crowdCells.map((cell) => ({ ...cell })), crowdBands.slice()));
      }
    });
    expect([calls, overlays.version]).toEqual([0, version]);
    expect(countGraphicsDrawCalls(() => overlays.setCrowdHeatmap(viewOf(8))), 'a new revision redraws').toBeGreaterThan(0);
    expect(overlays.version).toBe(version + 1);
  });

  it('retains a copy: a caller mutating its arrays after the call changes nothing until a new revision', () => {
    const { overlays, root } = rig();
    const cells = crowdCells.map((cell) => ({ ...cell }));
    const bands = crowdBands.slice();
    overlays.setCrowdHeatmap({ revision: 1, cells, bands });
    const before = recorded(root).coordinates;
    cells[0].x = 30;
    bands[0] = 3;
    overlays.setView(frameOf(1));
    overlays.setView(frameOf(0));
    expect(recorded(root).coordinates).toEqual(before);
  });

  it('nothing is drawn while hidden; hiding and re-showing the same revision is one change each and draws nothing', () => {
    const { overlays } = rig();
    overlays.setCrowdHeatmap(viewOf(3));
    const version = overlays.version;
    expect(countGraphicsDrawCalls(() => overlays.setCrowdHeatmap(null))).toBe(0);
    expect([overlays.isEmpty, overlays.version]).toEqual([true, version + 1]);
    expect(countGraphicsDrawCalls(() => {
      overlays.setCrowdHeatmap(null);
      overlays.setView(frameOf(2));
      overlays.syncWorld();
    }), 'hidden: a turn and a world sync build nothing').toBe(0);
    overlays.setView(frameOf(0));
    const shown = overlays.version;
    // Back in the view it was drawn in, but the turns made it stale: the re-show redraws once.
    expect(countGraphicsDrawCalls(() => overlays.setCrowdHeatmap(viewOf(3)))).toBeGreaterThan(0);
    expect(overlays.version).toBe(shown + 1);
    overlays.setCrowdHeatmap(null);
    const hidden = overlays.version;
    expect(countGraphicsDrawCalls(() => overlays.setCrowdHeatmap(viewOf(3))), 'no turn: the kept drawing is shown').toBe(0);
    expect([overlays.isEmpty, overlays.version]).toEqual([false, hidden + 1]);
  });

  it('is drawn on the view cells in every rotation, redraws once on a turn, and turning back restores view 0', () => {
    for (const q of VIEW_ROTATIONS) {
      const turned = rig();
      turned.overlays.setView(frameOf(q));
      turned.overlays.setCrowdHeatmap(viewOf(1));
      const reference = rig();
      reference.overlays.setCrowdHeatmap(viewOf(1, crowdCells.map((cell) => viewCell(frameOf(q), cell))));
      expect(sortedNumbers(recorded(turned.root).coordinates), `view ${q}`).toEqual(sortedNumbers(recorded(reference.root).coordinates));
      expect(recorded(turned.root).coordinates.filter((value) => !Number.isInteger(value))).toEqual([]);
    }
    const { overlays, root } = rig();
    overlays.setCrowdHeatmap(viewOf(1));
    const atZero = recorded(root).coordinates;
    const before = overlays.version;
    overlays.setView(frameOf(1));
    expect(overlays.version, 'one bump for the turn').toBe(before + 1);
    expect(recorded(root).coordinates).not.toEqual(atZero);
    expect(countGraphicsDrawCalls(() => overlays.setCrowdHeatmap(viewOf(1))), 'steady after the turn').toBe(0);
    overlays.setView(frameOf(0));
    expect(recorded(root).coordinates).toEqual(atZero);
  });

  it('a new park forgets it (its revision may repeat): the same revision after reset is drawn afresh', () => {
    const { overlays } = rig();
    overlays.setCrowdHeatmap(viewOf(5));
    overlays.reset();
    expect(overlays.isEmpty).toBe(true);
    expect(countGraphicsDrawCalls(() => overlays.setCrowdHeatmap(viewOf(5)))).toBeGreaterThan(0);
    expect(overlays.isEmpty).toBe(false);
  });

  it('shares the ground with the scenery heatmap below it without disturbing that layer', () => {
    const { overlays, session, root } = rig();
    session.world.seedScenarioObject('lollipop-lamp', { x: 12, y: 12 });
    session.scenery.syncWithWorld();
    overlays.setInfluenceVisible(true);
    const influence = root.children[2] as Container;
    const drawn = influence.children[0];
    overlays.setCrowdHeatmap(viewOf(1));
    overlays.setCrowdHeatmap(null);
    expect(influence.children[0], 'the scenery layer is untouched').toBe(drawn);
  });
});

describe('preview on a path (QA 2026-10-14)', () => {
  it('a preview diamond on a path cell sits on the raised path top, 3 texels up; elsewhere on the ground', () => {
    const { overlays, session, root } = rig();
    overlays.drawPreview([{ x: 6, y: 6 }], null, true, true);
    const ground = recorded(root).coordinates.slice();
    overlays.clearPreview();
    session.world.seedScenarioPaths([{ x: 6, y: 6 }]);
    overlays.drawPreview([{ x: 6, y: 6 }], null, true, true);
    const raised = recorded(root).coordinates;
    // The diamond's top vertex (cell (6, 6): ground y 16 x 12 = 192, inset 1) moves 3 texels up.
    expect(ground).toContain(193);
    expect(raised).toContain(190);
    expect(raised).not.toContain(193);
  });
});
