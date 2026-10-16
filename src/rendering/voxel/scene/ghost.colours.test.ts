import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { COLOUR_SWATCHES, colourSlotsFor, type ObjectColours } from '../../../game/content/colours';
import type { CoasterPiece } from '../../../game/coaster/design';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { ParkSession } from '../../../game/session/ParkSession';
import { seedColourTestPark } from '../../../game/session/colourTestPark';
import type { BuildDefinition, Cell } from '../../../game/types';
import { visualQuarterTurn } from '../contracts/space';
import { createModelCache } from '../blueprint/compile';
import { BOX_FLOATS, unpackBoxWord } from '../contracts/boxes';
import type { GhostState, VoxelGpuSink } from '../contracts/frame';
import { buildPalette } from '../palette';
import { GhostPreview } from './ghost';
import { REGISTRY_CONTENT, SceneModels } from './staticWorld';
import { VoxelScene } from './VoxelScene';

/**
 * Phase 28 step 2, colour before placing: the dithered ghost (and the coaster designer's draft) draw the colours
 * the next object will get. The ghost's boxes are the cached flat model of the (definition, turn) for the
 * default, and a recoloured COPY of it otherwise: the same list (same identity, so the GPU uploads nothing)
 * while neither the model nor the record changes, a new one exactly once when the choice does.
 */

const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS, COLOUR_SWATCHES.map((swatch) => swatch.rgb));
const CACHE = createModelCache();

const definitionOf = (id: string): BuildDefinition => BUILD_BY_ID.get(id)!;
const cellsFor = (definition: BuildDefinition, x: number, y: number): Cell[] => {
  const cells: Cell[] = [];
  for (let dy = 0; dy < definition.footprint[1]; dy += 1) for (let dx = 0; dx < definition.footprint[0]; dx += 1) cells.push({ x: x + dx, y: y + dy });
  return cells;
};

const parkRig = () => {
  const session = new ParkSession(null);
  seedColourTestPark(session);
  const models = new SceneModels(PALETTE, CACHE, REGISTRY_CONTENT, (message, error) => { throw new Error(`${message} ${String(error)}`); });
  return { session, models, world: session.world };
};

const materialOf = (boxes: Float32Array, box: number): number => unpackBoxWord(boxes[box * BOX_FLOATS + 3]).material;
const swatchMaterial = (swatch: number): number => PALETTE.material(COLOUR_SWATCHES[swatch].rgb);

const GHOST_KINDS = ['picnic-pocket', 'fizz-foundry', 'comfort-pavilion', 'ribbon-bench', 'tidy-totem', 'lollipop-lamp', 'sunburst-flowers', 'ripple-fountain', 'petal-roundabout', 'moonpetal-carousel', 'aurora-wheel'] as const;

describe('ghost colours (GhostPreview)', () => {
  it.each(GHOST_KINDS)('%s: no record is the cached flat model; a record is a copy that repaints exactly the tagged boxes', (id) => {
    const { world, models } = parkRig();
    const definition = definitionOf(id);
    const slots = colourSlotsFor(id);
    const flat = models.objectFlat(definition, 0);
    expect(flat.tags, 'a colourable kind has tagged boxes').not.toBeNull();
    const ghost = new GhostPreview();
    ghost.set(cellsFor(definition, 4, 4), definition, true, false, 0);
    expect(ghost.resolve(world, models)!.boxes, 'defaults: the cached flat model, same identity as before colours').toBe(flat.boxes);

    const record: ObjectColours = Object.freeze(slots.map((_slot, index) => 19 - 3 * index));
    expect(ghost.set(cellsFor(definition, 4, 4), definition, true, false, 0, record)).toBe(true);
    const state = ghost.resolve(world, models)!;
    expect(state.boxes).not.toBe(flat.boxes);
    expect(state.boxCount, 'box count is the model\'s').toBe(flat.boxCount);
    for (let box = 0; box < flat.boxCount; box += 1) {
      const at = box * BOX_FLOATS;
      for (const field of [0, 1, 2, 4, 5, 6, 7]) expect(state.boxes[at + field]).toBe(flat.boxes[at + field]);
      const tag = flat.tags![box];
      const slot = slots.find((candidate) => candidate.tag === tag);
      const swatch = slot ? record[slots.indexOf(slot)] : null;
      const expected = swatch !== null && swatch !== undefined ? swatchMaterial(swatch) : materialOf(flat.boxes, box);
      expect(materialOf(state.boxes, box), `box ${box} (tag ${tag})`).toBe(expected);
      const was = unpackBoxWord(flat.boxes[at + 3]);
      const now = unpackBoxWord(state.boxes[at + 3]);
      expect([now.group, now.pattern, now.quarterTurn]).toEqual([was.group, was.pattern, was.quarterTurn]);
    }
    // The flat model itself is never touched.
    expect(models.objectFlat(definition, 0).boxes).toBe(flat.boxes);
  });

  it('identity changes only when the choice does: repeats and equal records keep the same box list, a change makes one new list', () => {
    const { world, models } = parkRig();
    const definition = definitionOf('picnic-pocket');
    const cells = cellsFor(definition, 4, 4);
    const ghost = new GhostPreview();
    const first: ObjectColours = Object.freeze([19, null]);
    ghost.set(cells, definition, true, false, 0, first);
    const a = ghost.resolve(world, models)!.boxes;
    expect(ghost.resolve(world, models)!.boxes, 'resolving again').toBe(a);
    expect(ghost.set(cells, definition, true, false, 0, first), 'the same request').toBe(false);
    expect(ghost.set(cells, definition, true, false, 0, Object.freeze([19, null])), 'an equal record that is another array').toBe(false);
    expect(ghost.resolve(world, models)!.boxes).toBe(a);
    // Moving the cursor (another cell) moves an origin, not the boxes.
    ghost.set(cellsFor(definition, 9, 9), definition, true, false, 0, first);
    const moved = ghost.resolve(world, models)!;
    expect(moved.boxes, 'a move keeps the list').toBe(a);
    expect([moved.originX, moved.originY]).toEqual([9 * 32, 9 * 32]);
    // Validity changes the tint, not the boxes.
    ghost.set(cellsFor(definition, 9, 9), definition, false, false, 0, first);
    expect(ghost.resolve(world, models)!.boxes).toBe(a);
    // A different record: one new list.
    expect(ghost.set(cellsFor(definition, 9, 9), definition, true, false, 0, Object.freeze([6, 13]))).toBe(true);
    const b = ghost.resolve(world, models)!.boxes;
    expect(b).not.toBe(a);
    expect(ghost.resolve(world, models)!.boxes).toBe(b);
    // Back to defaults: the cached flat model again.
    ghost.set(cellsFor(definition, 9, 9), definition, true, false, 0, null);
    expect(ghost.resolve(world, models)!.boxes).toBe(models.objectFlat(definition, 0).boxes);
    // And to the first record again: an equal list (rebuilt once), its materials the same as the first time.
    ghost.set(cellsFor(definition, 9, 9), definition, true, false, 0, first);
    const again = ghost.resolve(world, models)!.boxes;
    expect([...again.subarray(0, 64)]).toEqual([...a.subarray(0, 64)]);
  });

  it('a turn (rotation) uses the turned flat model, recoloured the same', () => {
    const { world, models } = parkRig();
    const definition = definitionOf('picnic-pocket');
    const ghost = new GhostPreview();
    const record: ObjectColours = Object.freeze([19, 6]);
    ghost.set(cellsFor(definition, 4, 4), definition, true, false, 0, record);
    const q0 = ghost.resolve(world, models)!.boxes;
    ghost.set(cellsFor(definition, 4, 4), definition, true, false, 1, record);
    const q1 = ghost.resolve(world, models)!;
    expect(q1.boxes).not.toBe(q0);
    const flat1 = models.objectFlat(definition, 1);
    expect(q1.boxCount).toBe(flat1.boxCount);
    for (let box = 0; box < flat1.boxCount; box += 1) {
      const tag = flat1.tags![box];
      const expected = tag === 1 ? swatchMaterial(19) : tag === 2 ? swatchMaterial(6) : materialOf(flat1.boxes, box);
      expect(materialOf(q1.boxes, box)).toBe(expected);
    }
  });

  it('a kind with no slots, an all-default record and a swatch the palette lacks all keep the cached flat model', () => {
    const { world, models } = parkRig();
    const tree = definitionOf('confetti-tree');
    const ghost = new GhostPreview();
    ghost.set(cellsFor(tree, 4, 4), tree, true, false, 0, Object.freeze([3, 4]));
    expect(ghost.resolve(world, models)!.boxes, 'trees stay as they are').toBe(models.objectFlat(tree, 0).boxes);
    const stall = definitionOf('picnic-pocket');
    ghost.set(cellsFor(stall, 4, 4), stall, true, false, 0, Object.freeze([null, null]));
    expect(ghost.resolve(world, models)!.boxes).toBe(models.objectFlat(stall, 0).boxes);
    ghost.set(cellsFor(stall, 4, 4), stall, true, false, 0, Object.freeze([99, 99]));
    expect(ghost.resolve(world, models)!.boxes, 'unknown swatches repaint nothing').toBe(models.objectFlat(stall, 0).boxes);
  });

  it('a bulldoze ghost shows the colours the marked object has, from one stable list', () => {
    const { world, models, session } = parkRig();
    const stall = [...world.objects.values()].find((object) => object.definitionId === 'picnic-pocket')!;
    const definition = definitionOf('picnic-pocket');
    const turn = visualQuarterTurn(stall.rotation);
    const ghost = new GhostPreview();
    ghost.set([stall.anchor], null, true, true, 0);
    const plain = ghost.resolve(world, models)!.boxes;
    // Phase 40: the dev park turns its stalls toward their paths, so the cached flat is the stall's own turn.
    expect(plain, 'a default object: the cached flat').toBe(models.objectFlat(definition, turn).boxes);
    world.setObjectColours(stall.id, [19, 6]);
    session.syncWithWorld();
    const painted = ghost.resolve(world, models)!.boxes;
    expect(painted).not.toBe(plain);
    expect(ghost.resolve(world, models)!.boxes, 'resolved again after a world change: the same list').toBe(painted);
    const flat = models.objectFlat(definition, turn);
    for (let box = 0; box < flat.boxCount; box += 1) {
      const tag = flat.tags![box];
      expect(materialOf(painted, box)).toBe(tag === 1 ? swatchMaterial(19) : tag === 2 ? swatchMaterial(6) : materialOf(flat.boxes, box));
    }
    world.clearObjectColours(stall.id);
    expect(ghost.resolve(world, models)!.boxes).toBe(models.objectFlat(definition, turn).boxes);
  });
});

// ---- Scene level: what the sink is sent ---------------------------------------------------------------

class Sink implements VoxelGpuSink {
  ghosts: (GhostState | null)[] = [];
  drafts: (GhostState | null)[] = [];
  setChunk(): void {}
  setDynamic(): void {}
  setFigureRanges(): void {}
  setGhost(ghost: GhostState | null): void { this.ghosts.push(ghost === null ? null : { ...ghost }); }
  setDraft(draft: GhostState | null): void { this.drafts.push(draft === null ? null : { ...draft }); }
}

const sceneRig = () => {
  const session = new ParkSession(null);
  const sink = new Sink();
  const scene = new VoxelScene(session, PALETTE, CACHE, { sink, content: REGISTRY_CONTENT, prewarmBudgetMs: 0, reportError: (message) => { throw new Error(message); } });
  session.world.subscribe(() => scene.syncWorld());
  scene.update(16, 16, 0);
  return { session, scene, sink };
};

describe('ghost colours (VoxelScene): uploads follow identity', () => {
  it('uploads a ghost once per choice: repeats and cursor moves stage nothing, a changed choice stages one list', () => {
    const { scene } = sceneRig();
    const definition = definitionOf('lollipop-lamp');
    const record: ObjectColours = Object.freeze([19, 6]);
    let clock = 16;
    const frame = (): number => {
      clock += 16;
      scene.update(16, clock, 0);
      return scene.stats.bytesStaged;
    };
    scene.setPreview(cellsFor(definition, 4, 4), definition, true, false, 0, record);
    expect(frame(), 'the first coloured ghost uploads').toBeGreaterThan(0);
    scene.setPreview(cellsFor(definition, 4, 4), definition, true, false, 0, record);
    expect(frame(), 'the same request again').toBe(0);
    scene.setPreview(cellsFor(definition, 6, 4), definition, true, false, 0, Object.freeze([19, 6]));
    expect(frame(), 'a move with an equal record: an origin, no upload').toBe(0);
    scene.setPreview(cellsFor(definition, 6, 4), definition, true, false, 0, Object.freeze([0, 6]));
    expect(frame(), 'a changed choice').toBeGreaterThan(0);
    expect(frame(), 'and nothing more').toBe(0);
    scene.setPreview(cellsFor(definition, 6, 4), definition, true, false, 0, null);
    expect(frame(), 'back to the default flat model').toBeGreaterThan(0);
    expect(frame()).toBe(0);
  });

  it('with no record the ghost is exactly what it was before colours: the cached flat list', () => {
    const { scene, sink } = sceneRig();
    const definition = definitionOf('fizz-foundry');
    const models = new SceneModels(PALETTE, CACHE, REGISTRY_CONTENT, () => undefined);
    scene.setPreview(cellsFor(definition, 4, 4), definition, true, false, 0);
    scene.update(16, 32, 0);
    expect(sink.ghosts.at(-1)!.boxes).toBe(models.objectFlat(definition, 0).boxes);
  });
});

describe('coaster draft colours (VoxelScene)', () => {
  const layout = (): CoasterPiece[] => {
    const pieces: CoasterPiece[] = [];
    for (let x = 3; x < 11; x += 1) pieces.push({ cell: { x, y: 6 }, height: x > 5 && x < 9 ? 1 : 0 });
    for (let y = 7; y < 10; y += 1) pieces.push({ cell: { x: 10, y }, height: 0 });
    for (let x = 10; x >= 3; x -= 1) pieces.push({ cell: { x, y: 10 }, height: 0 });
    for (let y = 9; y > 6; y -= 1) pieces.push({ cell: { x: 3, y }, height: 0 });
    return pieces;
  };

  it.each(['comet-trail', 'star-chaser', 'skyline-serpent'])('%s: the draft is the real track in the chosen colours, rebuilt once per choice', (id) => {
    const { scene, sink } = sceneRig();
    const definition = definitionOf(id);
    const pieces = layout();
    let clock = 100;
    const frame = (): number => {
      clock += 16;
      scene.update(16, clock, 0);
      return scene.stats.bytesStaged;
    };
    scene.setCoasterDraft(pieces, definition, true);
    frame();
    const plain = sink.drafts.at(-1)!;
    expect(plain.boxCount).toBeGreaterThan(100);
    const plainBoxes = plain.boxes.slice(0, plain.boxCount * BOX_FLOATS);

    const record: ObjectColours = Object.freeze([19, 6, 13, 0]);
    scene.setCoasterDraft(pieces, definition, true, record);
    expect(frame(), 'a changed choice uploads the draft').toBeGreaterThan(0);
    const coloured = sink.drafts.at(-1)!;
    expect(coloured.boxes, 'a new list').not.toBe(plain.boxes);
    expect(coloured.boxCount, 'the same boxes').toBe(plain.boxCount);
    let changed = 0;
    for (let box = 0; box < plain.boxCount; box += 1) {
      const at = box * BOX_FLOATS;
      for (const field of [0, 1, 2, 4, 5, 6, 7]) expect(coloured.boxes[at + field], `box ${box} field ${field}`).toBe(plainBoxes[at + field]);
      if (coloured.boxes[at + 3] !== plainBoxes[at + 3]) changed += 1;
    }
    expect(changed, 'rails, supports, the canopy and the parked train follow the record').toBeGreaterThan(30);

    scene.setCoasterDraft(pieces, definition, true, Object.freeze([19, 6, 13, 0]));
    expect(frame(), 'an equal record again: nothing').toBe(0);
    expect(sink.drafts.at(-1)!.boxes, 'the same list').toBe(coloured.boxes);
    scene.setCoasterDraft(pieces, definition, true, null);
    expect(frame(), 'back to defaults').toBeGreaterThan(0);
    const back = sink.drafts.at(-1)!;
    expect([...back.boxes.subarray(0, back.boxCount * BOX_FLOATS)], 'the default draft is byte for byte the first one').toEqual([...plainBoxes]);
  });
});
