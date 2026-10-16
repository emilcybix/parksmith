import { describe, expect, it } from 'vitest';
import { COASTER_TYPE_BY_ID } from '../../../game/coaster/content';
import { coasterBaseCost, deriveCoasterStats } from '../../../game/coaster/design';
import { longestLayout, ovalLayout } from '../../../game/coaster/testLayouts';
import { GAME_CONFIG } from '../../../game/config';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { SCENARIOS } from '../../../game/scenarios/content';
import { seedDevPark } from '../../../game/session/devPark';
import { ParkSession } from '../../../game/session/ParkSession';
import type { BuildDefinition, Cell } from '../../../game/types';
import { coasterHeadIndex, coasterInterpolatedRemaining } from '../../coasterTrain';
import { createModelCache } from '../blueprint/compile';
import type { ModelCache } from '../blueprint/compile';
import { placeholderContent } from '../content/placeholder';
import type { Blueprint } from '../contracts/blueprint';
import { LIGHT_PRESET_NIGHT } from '../contracts/blueprint';
import { TRANSFORM_FLOATS } from '../contracts/boxes';
import { DEV_PARK_BOX_BUDGET, MAX_PARK_BOX_BUDGET } from '../contracts/budgets';
import type { ObjectContent } from '../contracts/content';
import type { DynamicTexture, GhostState, TexelBounds, VoxelGpuSink } from '../contracts/frame';
import type { FigureRange } from '../contracts/figures';
import {
  GHOST_COVERAGE_INVALID,
  GHOST_COVERAGE_VALID,
  GHOST_TINT_BULLDOZE,
  GHOST_TINT_INVALID,
  GHOST_TINT_VALID,
} from '../contracts/gbuffer';
import { MAT } from '../contracts/palette';
import { coasterCarSlotKey } from '../contracts/rigid';
import type { PartDriver } from '../contracts/rigid';
import { chunkIndexOfCell, visualQuarterTurn, VOXELS_PER_TILE } from '../contracts/space';
import { buildPalette } from '../palette';
import { createCoasterCarPoses, placeCoasterCars } from './coasterCars';
import { setPoseRotation } from './rigid';
import { PLACEHOLDER_CONTENT, REGISTRY_CONTENT, SceneModels } from './staticWorld';
import type { SceneContent } from './staticWorld';
import { VoxelScene } from './VoxelScene';

/**
 * VoxelScene against a recording sink (contracts/frame.ts), the way the legacy renderer's frame and
 * construction cost guards work: the scene is pure, so every rule about what a frame may send can be
 * asserted in Node.
 * - Frame cost: a steady dev-park frame with 300 guests rebuilds no chunk, stages only dynamic rows
 *   (figures that moved, parts that turned) and stays within the 64 KiB per frame budget.
 * - Construction cost: a decoration rebuilds one chunk, a path tile its own chunk and the chunks its
 *   curbs and fences touch, a batched bulldozer drag one pass.
 * - Budgets: the dev park and a max park within DEV_PARK_BOX_BUDGET and MAX_PARK_BOX_BUDGET, with
 *   the placeholders and with the content authored so far.
 * - The ghost, ride motion, trains, litter, lights, session and sink swaps.
 */

const TILE = VOXELS_PER_TILE;
const PALETTE = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const KIB = 1024;
const CACHES = new Map<SceneContent, ModelCache>();
const cacheFor = (content: SceneContent): ModelCache => {
  let cache = CACHES.get(content);
  if (!cache) {
    cache = createModelCache();
    CACHES.set(content, cache);
  }
  return cache;
};

interface ChunkCall {
  index: number;
  count: number;
  bounds: TexelBounds | null;
}

interface DynamicCall {
  texture: DynamicTexture;
  count: number;
  rowStart: number;
  rowEnd: number;
}

interface GhostCall {
  boxes: Float32Array;
  boxCount: number;
  origin: [number, number, number];
  coverage: number;
  tint: number;
}

/** Records every sink call; `take()` returns and forgets them. */
class RecordingSink implements VoxelGpuSink {
  chunks: ChunkCall[] = [];
  dynamics: DynamicCall[] = [];
  ranges: FigureRange[][] = [];
  ghosts: (GhostCall | null)[] = [];
  drafts: (GhostCall | null)[] = [];
  /** The latest data array per dynamic texture, as a GPU copy would hold it. */
  readonly latest = new Map<DynamicTexture, Float32Array>();

  setChunk(index: number, _boxes: Float32Array, boxCount: number, bounds: TexelBounds | null): void {
    this.chunks.push({ index, count: boxCount, bounds: bounds ? { ...bounds } : null });
  }

  setDynamic(texture: DynamicTexture, data: Float32Array, count: number, rowStart: number, rowEnd: number): void {
    this.dynamics.push({ texture, count, rowStart, rowEnd });
    this.latest.set(texture, data);
  }

  setFigureRanges(ranges: readonly FigureRange[]): void {
    this.ranges.push(ranges.map((range) => ({ ...range })));
  }

  setGhost(ghost: GhostState | null): void {
    this.ghosts.push(ghost === null ? null : {
      boxes: ghost.boxes,
      boxCount: ghost.boxCount,
      origin: [ghost.originX, ghost.originY, ghost.originZ],
      coverage: ghost.coverage,
      tint: ghost.tint,
    });
  }

  setDraft(draft: GhostState | null): void {
    this.drafts.push(draft === null ? null : {
      boxes: draft.boxes,
      boxCount: draft.boxCount,
      origin: [draft.originX, draft.originY, draft.originZ],
      coverage: draft.coverage,
      tint: draft.tint,
    });
  }

  clear(): void {
    this.chunks = [];
    this.dynamics = [];
    this.ranges = [];
    this.ghosts = [];
  }

  dynamic(texture: DynamicTexture): DynamicCall[] {
    return this.dynamics.filter((call) => call.texture === texture);
  }
}

interface Rig {
  session: ParkSession;
  scene: VoxelScene;
  sink: RecordingSink;
  errors: string[];
}

const rig = (session: ParkSession, content: SceneContent = REGISTRY_CONTENT, prewarmBudgetMs = 0): Rig => {
  const sink = new RecordingSink();
  const errors: string[] = [];
  const scene = new VoxelScene(session, PALETTE, cacheFor(content), {
    sink,
    content,
    prewarmBudgetMs,
    reportError: (message) => errors.push(message),
  });
  // The renderer's wiring: every world notification reaches syncWorld.
  session.world.subscribe(() => scene.syncWorld());
  return { session, scene, sink, errors };
};

const devPark = (): ParkSession => {
  const session = new ParkSession(null);
  seedDevPark(session);
  return session;
};

let clock = 0;
/** One frame: the scene's update with a monotonic frame clock. */
const frame = (scene: VoxelScene, stepFraction = 0.5): void => {
  clock += 16;
  scene.update(16, clock, stepFraction);
};

const totalBoxes = (scene: VoxelScene): number => {
  let total = 0;
  for (let chunk = 0; chunk < scene.chunkCount; chunk += 1) total += scene.chunkBoxCount(chunk);
  return total;
};

describe('scene: frame cost', () => {
  it.each([['placeholder content', PLACEHOLDER_CONTENT], ['the content authored so far', REGISTRY_CONTENT]] as const)(
    'a steady dev-park frame with 300 guests rebuilds nothing and stages only dynamic rows (%s)',
    (_name, content) => {
      const session = devPark();
      session.guests.spawnGuests(300);
      for (let step = 0; step < 100; step += 1) session.step(GAME_CONFIG.fixedStepMs);
      const { scene, sink } = rig(session, content, 4);
      frame(scene);
      frame(scene);
      sink.clear();
      for (let index = 0; index < 10; index += 1) {
        session.step(GAME_CONFIG.fixedStepMs);
        frame(scene, index / 10);
        const stats = { ...scene.stats };
        expect(stats.chunksRebuilt, `frame ${index}: no chunk rebuilt`).toBe(0);
        expect(stats.bytesStaged, `frame ${index}: ${stats.bytesStaged} bytes staged`).toBeLessThanOrEqual(64 * KIB);
      }
      expect(sink.chunks, 'no chunk was sent').toEqual([]);
      expect(sink.ghosts, 'no ghost was sent').toEqual([]);
      expect(sink.dynamic('figures').some((call) => call.rowEnd > call.rowStart), 'walking guests stage figure rows').toBe(true);
      const figures = sink.dynamic('figures').at(-1)!;
      expect(figures.count, 'every visible figure is packed').toBeGreaterThan(100);
      expect(sink.ranges.length, 'figure ranges every frame').toBe(10);
    },
  );
});

describe('scene: construction cost', () => {
  it('rebuilds one chunk for a decoration', () => {
    const { session, scene, sink } = rig(devPark());
    frame(scene);
    sink.clear();
    const cell: Cell = { x: 25, y: 12 };
    expect(session.world.buildObject('confetti-tree', cell), 'the tree fits').not.toBeNull();
    frame(scene);
    expect(scene.stats.chunksRebuilt, 'a decoration touches at most two chunks').toBeLessThanOrEqual(2);
    expect(sink.chunks.map((call) => call.index), 'its own chunk').toEqual([chunkIndexOfCell(cell.x, cell.y, session.world.width)]);
    frame(scene);
    expect(scene.stats.chunksRebuilt, 'and nothing after').toBe(0);
  });

  it('rebuilds a path tile\'s own chunk and only the chunks its curbs and fences touch', () => {
    const { session, scene, sink } = rig(devPark());
    frame(scene);
    sink.clear();
    const world = session.world;
    // Beside the west plot of the first ride block (the carousel at 7..9 × 22..24), outside the grid.
    const cell: Cell = { x: 6, y: 23 };
    expect(world.canPlacePath(cell), 'the tile is free').toBe(true);
    const before = scene.chunkHash(chunkIndexOfCell(9, 24, world.width));
    world.buildPaths([cell]);
    frame(scene);
    const expected = new Set([chunkIndexOfCell(cell.x, cell.y, world.width)]);
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const neighbour = { x: cell.x + dx, y: cell.y + dy };
      if (world.paths.has(`${neighbour.x},${neighbour.y}`)) expected.add(chunkIndexOfCell(neighbour.x, neighbour.y, world.width));
      const object = world.objectAt(neighbour);
      if (object && BUILD_BY_ID.get(object.definitionId)?.kind === 'ride') {
        const definition = BUILD_BY_ID.get(object.definitionId) as BuildDefinition;
        const [wide, deep] = [definition.footprint[object.rotation % 2], definition.footprint[(object.rotation + 1) % 2]];
        expected.add(chunkIndexOfCell(object.anchor.x + wide - 1, object.anchor.y + deep - 1, world.width));
      }
    }
    const rebuilt = sink.chunks.map((call) => call.index);
    expect(rebuilt.every((index) => expected.has(index)), `rebuilt ${rebuilt} ⊆ ${[...expected]}`).toBe(true);
    expect(rebuilt, 'its own chunk').toContain(chunkIndexOfCell(cell.x, cell.y, world.width));
    expect(scene.chunkHash(chunkIndexOfCell(9, 24, world.width)), 'the carousel fence opened').not.toBe(before);
  });

  it('rebuilds a batched 12-tile bulldozer drag in one pass', () => {
    const { session, scene, sink } = rig(devPark());
    frame(scene);
    sink.clear();
    const world = session.world;
    let notifications = 0;
    world.subscribe(() => {
      notifications += 1;
    });
    const drag = Array.from({ length: 12 }, (_unused, step) => ({ x: 8 + step, y: 26 }));
    const removed = world.batch(() => drag.filter((cell) => world.bulldoze(cell).removed).length);
    expect(removed, 'the street went').toBe(12);
    expect(notifications, 'one notification for the whole drag').toBe(1);
    frame(scene);
    const rebuilt = sink.chunks.map((call) => call.index);
    expect(rebuilt.length, 'something was rebuilt').toBeGreaterThan(0);
    expect(new Set(rebuilt).size, 'each chunk once').toBe(rebuilt.length);
    sink.clear();
    frame(scene);
    expect(sink.chunks, 'one pass: nothing left for the next frame').toEqual([]);
  });

  it('coalesces the dev park\'s synchronous notifications into one diff and one build', () => {
    const session = new ParkSession(null);
    const { scene, sink } = rig(session, PLACEHOLDER_CONTENT);
    frame(scene);
    sink.clear();
    let notifications = 0;
    session.world.subscribe(() => {
      notifications += 1;
    });
    seedDevPark(session);
    expect(notifications, 'seeding notifies once per object').toBeGreaterThan(50);
    frame(scene);
    const rebuilt = sink.chunks.map((call) => call.index);
    expect(new Set(rebuilt).size, 'every chunk at most once').toBe(rebuilt.length);
    expect(rebuilt.length, 'at most every chunk').toBeLessThanOrEqual(scene.chunkCount);
  });
});

describe('scene: budgets', () => {
  /** The heaviest 3×3 ride with this content, by compiled boxes over both quarter turns. */
  const heaviestSquareRide = (content: SceneContent): { definition: BuildDefinition; boxes: number } => {
    const models = new SceneModels(PALETTE, cacheFor(content), content, () => undefined);
    let best: { definition: BuildDefinition; boxes: number } | null = null;
    for (const definition of BUILD_CATALOG) {
      if (definition.kind !== 'ride' || definition.custom || definition.footprint[0] !== 3 || definition.footprint[1] !== 3) continue;
      const boxes = Math.max(models.objectModel(definition, 0).boxCount, models.objectModel(definition, 1).boxCount);
      if (!best || boxes > best.boxes) best = { definition, boxes };
    }
    return best!;
  };

  /** A path grid every fourth row and column, and the heaviest 3×3 ride on every plot between. */
  const maxPark = (definition: BuildDefinition): ParkSession => {
    const session = new ParkSession(null);
    const world = session.world;
    world.addMoney(10_000_000, 'Max park funding');
    const paths: Cell[] = [];
    for (let y = 0; y < world.height; y += 1) {
      for (let x = 0; x < world.width; x += 1) if (x % 4 === 3 || y % 4 === 3) paths.push({ x, y });
    }
    world.buildPaths(paths);
    for (let y = 0; y + 3 <= world.height; y += 4) {
      for (let x = 0; x + 3 <= world.width; x += 4) world.seedScenarioObject(definition.id, { x, y }, ((x + y) / 4 % 4) as 0 | 1 | 2 | 3);
    }
    return session;
  };

  it.each([['placeholder content', PLACEHOLDER_CONTENT], ['the content authored so far', REGISTRY_CONTENT]] as const)(
    'keeps the dev park and a max park within budget (%s)',
    (_name, content) => {
      const dev = rig(devPark(), content);
      frame(dev.scene);
      const devBoxes = totalBoxes(dev.scene);
      expect(devBoxes, `dev park: ${devBoxes} boxes`).toBeLessThanOrEqual(DEV_PARK_BOX_BUDGET);
      const heaviest = heaviestSquareRide(content);
      const park = maxPark(heaviest.definition);
      const rides = [...park.world.objects.values()].filter((object) => object.definitionId === heaviest.definition.id).length;
      expect(rides, 'a ride on every plot of the grid').toBe(64);
      const max = rig(park, content);
      frame(max.scene);
      const maxBoxes = totalBoxes(max.scene);
      expect(maxBoxes, `max park: ${rides} × ${heaviest.definition.id} (${heaviest.boxes} boxes each) = ${maxBoxes} boxes`)
        .toBeLessThanOrEqual(MAX_PARK_BOX_BUDGET);
    },
  );
});

describe('scene: ghost', () => {
  const definition = (id: string): BuildDefinition => BUILD_BY_ID.get(id) as BuildDefinition;

  it('shows the model of a build preview at the footprint corner, tinted by validity', () => {
    const { session, scene, sink } = rig(new ParkSession(null));
    frame(scene);
    sink.clear();
    const carousel = definition('moonpetal-carousel');
    const cells = session.world.footprintCells(carousel, { x: 5, y: 7 }, 1);
    scene.setPreview(cells, carousel, true, false, 1);
    frame(scene);
    const models = new SceneModels(PALETTE, cacheFor(REGISTRY_CONTENT), REGISTRY_CONTENT, () => undefined);
    const flat = models.objectFlat(carousel, visualQuarterTurn(1));
    expect(sink.ghosts, 'one ghost').toHaveLength(1);
    const ghost = sink.ghosts[0]!;
    expect(ghost.boxes, 'the cached flat model itself, so the GPU uploads it once').toBe(flat.boxes);
    expect([ghost.boxCount, ...ghost.origin, ghost.coverage, ghost.tint], 'placed and tinted valid')
      .toEqual([flat.boxCount, 5 * TILE, 7 * TILE, 0, GHOST_COVERAGE_VALID, GHOST_TINT_VALID]);

    // The same request again (GameApp repeats it on every pointermove) sends nothing.
    scene.setPreview(cells, carousel, true, false, 1);
    frame(scene);
    expect(sink.ghosts, 'repeats cost nothing').toHaveLength(1);

    // Moving the cursor moves the origin, not the boxes; invalid screens sparser and red.
    const moved = session.world.footprintCells(carousel, { x: 6, y: 7 }, 1);
    scene.setPreview(moved, carousel, false, false, 1);
    frame(scene);
    const next = sink.ghosts[1]!;
    expect(next.boxes, 'same boxes').toBe(flat.boxes);
    expect([...next.origin, next.coverage, next.tint], 'moved, invalid').toEqual([6 * TILE, 7 * TILE, 0, GHOST_COVERAGE_INVALID, GHOST_TINT_INVALID]);

    // Rotating swaps in the other quarter turn's model.
    scene.setPreview(moved, carousel, true, false, 0);
    frame(scene);
    expect(sink.ghosts[2]!.boxes, 'the unturned model').toBe(models.objectFlat(carousel, 0).boxes);

    scene.clearPreview();
    frame(scene);
    expect(sink.ghosts.at(-1), 'cleared').toBeNull();
  });

  it('has no ghost for paths and coasters', () => {
    const { scene, sink } = rig(new ParkSession(null));
    frame(scene);
    sink.clear();
    scene.setPreview([{ x: 4, y: 4 }], definition('sunstone-path'), true, false, 0);
    frame(scene);
    scene.setPreview([{ x: 4, y: 4 }], definition('star-chaser'), true, false, 0);
    frame(scene);
    expect(sink.ghosts, 'nothing to draw').toEqual([null, null]);
  });

  it('marks the object under a bulldoze preview, and lets go of it when it is gone', () => {
    const { session, scene, sink } = rig(devPark());
    frame(scene);
    sink.clear();
    const world = session.world;
    const kiosk = [...world.objects.values()].find((object) => object.definitionId === 'picnic-pocket')!;
    const cell = { x: kiosk.anchor.x + 1, y: kiosk.anchor.y + 1 };
    scene.setPreview([cell], null, true, true, 0);
    frame(scene);
    const ghost = sink.ghosts[0]!;
    const models = new SceneModels(PALETTE, cacheFor(REGISTRY_CONTENT), REGISTRY_CONTENT, () => undefined);
    const flat = models.objectFlat(definition('picnic-pocket'), visualQuarterTurn(kiosk.rotation));
    expect(ghost.boxes, 'the kiosk\'s own model').toBe(flat.boxes);
    expect([...ghost.origin, ghost.tint], 'over the kiosk, in the bulldoze tint').toEqual([kiosk.anchor.x * TILE, kiosk.anchor.y * TILE, 0, GHOST_TINT_BULLDOZE]);

    world.bulldoze(cell);
    frame(scene);
    expect(sink.ghosts.at(-1), 'the object went, so did its ghost').toBeNull();

    // Over a path: nothing to mark (the overlay diamond is the preview).
    scene.setPreview([{ x: 15, y: 20 }], null, true, true, 0);
    frame(scene);
    expect(sink.ghosts.at(-1), 'paths have no ghost').toBeNull();
  });
});

describe('scene: motion', () => {
  /** A 1×1 model whose one moving part turns with the ride's spin. */
  const spinner: PartDriver = (motion, out) => setPoseRotation(out, 0, 0, 1, motion.spin / 1000);
  const moving = (driver: PartDriver): ObjectContent => ({
    blueprint: (definition): Blueprint => ({
      id: `test:spinner:${definition.id}`,
      footprint: definition.footprint,
      parts: [
        { id: 'body', pivot: [0, 0, 0], shapes: [{ kind: 'box', min: [4, 4, 1], size: [8, 8, 4], material: MAT.STEEL }] },
        { id: 'rotor', pivot: [48, 48, 10], shapes: [{ kind: 'box', min: [40, 44, 9], size: [16, 8, 2], material: MAT.WOOD }] },
      ],
      lights: [{ position: [16, 16, 30], radius: 16, color: 0xffffff, presets: LIGHT_PRESET_NIGHT }],
    }),
    drivers: { rotor: driver },
  });
  const contentWith = (driver: PartDriver): SceneContent => ({ ...PLACEHOLDER_CONTENT, objectContent: () => moving(driver) });

  it('turns an open ride\'s parts and leaves no dirty rows once a ride is at rest', () => {
    const session = new ParkSession(null);
    const placed = session.world.seedScenarioObject('petal-roundabout', { x: 6, y: 6 });
    session.rides.syncWithWorld();
    const { scene, sink } = rig(session, contentWith(spinner));
    frame(scene);
    const table = () => sink.latest.get('transforms')!;
    const slotPose = (): number[] => [...table().subarray(0, TRANSFORM_FLOATS)];
    const first = slotPose();
    frame(scene);
    frame(scene);
    expect(slotPose(), 'an idle ride ticks over').not.toEqual(first);
    // Closed (no runtime): motion eases to 0 and the part settles.
    session.rides.rides.delete(placed!.id);
    for (let index = 0; index < 400; index += 1) frame(scene);
    sink.clear();
    frame(scene);
    expect(sink.dynamic('transforms').filter((call) => call.rowEnd > call.rowStart), 'a ride at rest uploads nothing').toEqual([]);
  });

  it('stands still while the game is paused and carries on from the same angle afterwards', () => {
    const session = new ParkSession(null);
    session.world.seedScenarioObject('petal-roundabout', { x: 6, y: 6 });
    session.rides.syncWithWorld();
    const { scene, sink } = rig(session, contentWith(spinner));
    for (let index = 0; index < 5; index += 1) frame(scene);
    const table = () => sink.latest.get('transforms')!;
    const slotPose = (): number[] => [...table().subarray(0, TRANSFORM_FLOATS)];
    scene.setMachineryPaused(true);
    frame(scene);
    const held = slotPose();
    sink.clear();
    for (let index = 0; index < 30; index += 1) frame(scene);
    expect(slotPose(), 'machinery does not turn while paused').toEqual(held);
    expect(sink.dynamic('transforms').filter((call) => call.rowEnd > call.rowStart), 'and uploads nothing').toEqual([]);
    scene.setMachineryPaused(false);
    frame(scene);
    expect(slotPose(), 'it turns again on resume').not.toEqual(held);
  });

  it('retires a driver that throws or poses nowhere: reported once, part at rest', () => {
    for (const bad of [
      (): void => {
        throw new Error('driver exploded');
      },
      (_motion: unknown, out: { dx: number }): void => {
        out.dx = Number.NaN;
      },
    ] as PartDriver[]) {
      const session = new ParkSession(null);
      session.world.seedScenarioObject('petal-roundabout', { x: 6, y: 6 });
      session.world.seedScenarioObject('petal-roundabout', { x: 12, y: 6 });
      session.rides.syncWithWorld();
      const { scene, errors, sink } = rig(session, contentWith(bad));
      expect(() => {
        for (let index = 0; index < 5; index += 1) frame(scene);
      }, 'a content bug never throws out of the frame').not.toThrow();
      expect(errors, 'one report for the driver').toHaveLength(1);
      const data = sink.latest.get('transforms')!;
      for (let slot = 0; slot < 2; slot += 1) {
        expect([...data.subarray(slot * TRANSFORM_FLOATS + 4, slot * TRANSFORM_FLOATS + 8)], 'identity rotation at rest').toEqual([0, 0, 0, 1]);
      }
    }
  });

  it('runs a coaster train along the shared timing and parks it otherwise', () => {
    const session = devPark();
    const { scene, sink } = rig(session, PLACEHOLDER_CONTENT);
    frame(scene);
    const record = [...session.world.coasters.values()][0];
    const cars = COASTER_TYPE_BY_ID.get('star-chaser')!.trainCars;
    const poses = createCoasterCarPoses(cars);
    const carPivot = (car: number): number[] => {
      // The first slots belong to whoever the rebuild met first; find the car through its pose.
      const data = sink.latest.get('transforms')!;
      const target = [poses.data[car * 7], poses.data[car * 7 + 1], poses.data[car * 7 + 2]].map(Math.fround);
      for (let slot = 0; slot < data.length / TRANSFORM_FLOATS; slot += 1) {
        const at = slot * TRANSFORM_FLOATS;
        if (data[at] === target[0] && data[at + 1] === target[1] && data[at + 2] === target[2]) return target;
      }
      return [];
    };
    placeCoasterCars(record, coasterHeadIndex(record, null), cars, poses);
    frame(scene);
    expect(carPivot(0), 'parked at the station').not.toEqual([]);
    const runtime = session.rides.getRide(record.objectId)!;
    runtime.status = 'running';
    runtime.cycleRemainingSeconds = record.stats.durationSeconds - GAME_CONFIG.coaster.stationLoadSeconds - 1.5;
    frame(scene);
    // frame() runs half a step into the next one, and the train is drawn at that interpolated time.
    const shown = coasterInterpolatedRemaining(runtime.cycleRemainingSeconds, record.stats.durationSeconds, 0.5);
    placeCoasterCars(record, coasterHeadIndex(record, shown), cars, poses);
    expect(carPivot(0), 'the lead car is where the shared timing puts it').not.toEqual([]);
    expect(coasterCarSlotKey(0), 'cars are keyed 1000 + index').toBe(1000);
  });
});

describe('scene: litter and lights', () => {
  it('stages litter only when a pile changes', () => {
    const session = devPark();
    const { scene, sink } = rig(session, PLACEHOLDER_CONTENT);
    frame(scene);
    sink.clear();
    frame(scene);
    expect(sink.dynamic('litter'), 'no change, no litter upload').toEqual([]);
    expect(session.operations.addLitter({ x: 15, y: 20 }, 3), 'a pile').toBeGreaterThan(0);
    frame(scene);
    const staged = sink.dynamic('litter');
    expect(staged.length, 'the pile is staged').toBe(1);
    expect(staged[0].count, 'with its boxes').toBeGreaterThan(0);
    expect(staged[0].rowEnd, 'whole rows from 0').toBeGreaterThan(0);
    sink.clear();
    frame(scene);
    expect(sink.dynamic('litter'), 'then nothing').toEqual([]);
    session.operations.litter.clear();
    frame(scene);
    expect(sink.dynamic('litter').map((call) => call.count), 'swept away').toEqual([0]);
  });

  it('re-packs the lights when chunks are rebuilt, and only then', () => {
    const session = new ParkSession(null);
    session.world.seedScenarioObject('lollipop-lamp', { x: 4, y: 4 });
    session.world.seedScenarioObject('lollipop-lamp', { x: 20, y: 20 });
    const lamp: ObjectContent = {
      blueprint: (definition): Blueprint => ({
        id: `test:lamp:${definition.id}`,
        footprint: definition.footprint,
        parts: [{ id: 'body', pivot: [0, 0, 0], shapes: [{ kind: 'box', min: [15, 15, 1], size: [2, 2, 44], material: MAT.STEEL }] }],
        lights: [{ position: [16, 16, 47], radius: 64, color: 0xffe66d, presets: LIGHT_PRESET_NIGHT }],
      }),
    };
    const content: SceneContent = { ...PLACEHOLDER_CONTENT, objectContent: (id) => id === 'lollipop-lamp' ? lamp : placeholderContent() };
    const { scene, sink } = rig(session, content);
    frame(scene);
    expect(sink.dynamic('lights').map((call) => call.count), 'both lamps').toEqual([2]);
    sink.clear();
    frame(scene);
    expect(sink.dynamic('lights'), 'steady frames send no lights').toEqual([]);
    session.world.bulldoze({ x: 4, y: 4 });
    frame(scene);
    expect(sink.dynamic('lights').map((call) => call.count), 'one lamp left').toEqual([1]);
  });
});

describe('scene: sessions and sinks', () => {
  it('resets everything on setSession and matches a fresh scene of the new park', () => {
    const sandbox = new ParkSession(null);
    sandbox.world.addMoney(1_000_000, 'Session test funding');
    sandbox.world.buildPaths([{ x: 15, y: 30 }, { x: 15, y: 29 }, { x: 14, y: 29 }]);
    sandbox.world.seedScenarioObject('moonpetal-carousel', { x: 10, y: 10 });
    sandbox.world.seedScenarioObject('lollipop-lamp', { x: 16, y: 29 });
    sandbox.operations.addLitter({ x: 15, y: 30 }, 2);
    const { scene, sink } = rig(sandbox);
    for (let index = 0; index < 3; index += 1) frame(scene);
    scene.setPreview([{ x: 3, y: 3 }], BUILD_BY_ID.get('confetti-tree')!, true, false, 0);
    frame(scene);
    sink.clear();

    const scenario = new ParkSession(SCENARIOS.find((definition) => definition.setup.objects.length > 0)!);
    scene.setSession(scenario);
    scenario.world.subscribe(() => scene.syncWorld());
    frame(scene);
    expect(sink.chunks.map((call) => call.index).sort((a, b) => a - b), 'every chunk re-sent')
      .toEqual(Array.from({ length: scene.chunkCount }, (_unused, index) => index));
    expect(sink.ghosts, 'the ghost is cleared').toEqual([null]);
    expect(sink.dynamic('litter').map((call) => call.count), 'the old park\'s litter is gone').toEqual([0]);
    const fresh = rig(scenario);
    frame(fresh.scene);
    for (let chunk = 0; chunk < scene.chunkCount; chunk += 1) {
      expect(scene.chunkHash(chunk), `chunk ${chunk} equals a fresh scene`).toBe(fresh.scene.chunkHash(chunk));
    }
  });

  it('setSession also drops ride motions, trains, the litter signature and the coaster draft, and re-sends what an identical park needs', () => {
    const litteredPark = (): ParkSession => {
      const session = devPark();
      session.operations.addLitter({ x: 15, y: 20 }, 3);
      return session;
    };
    const { scene, sink } = rig(litteredPark());
    frame(scene);
    frame(scene);
    const pieces = [0, 1, 2].map((x) => ({ cell: { x: 4 + x, y: 4 }, height: 0 }));
    scene.setCoasterDraft(pieces, BUILD_BY_ID.get('star-chaser')!, true);
    frame(scene);
    const internals = scene as unknown as { motions: Map<number, unknown>; trains: unknown[]; animated: unknown[] };
    expect(internals.motions.size + internals.trains.length, 'the dev park has rides and a train to forget').toBeGreaterThan(0);
    expect(sink.dynamic('litter').at(-1)?.count, 'the litter was sent').toBeGreaterThan(0);
    expect(sink.drafts.at(-1)?.boxCount, 'the draft was sent').toBeGreaterThan(0);
    sink.clear();
    sink.drafts = [];

    scene.setSession(litteredPark());
    expect([internals.motions.size, internals.trains.length, internals.animated.length], 'motions, trains and animated parts are empty at once').toEqual([0, 0, 0]);
    frame(scene);
    expect(sink.dynamic('litter').at(-1)?.count, 'identical litter is sent again (the old signature must not suppress it)').toBeGreaterThan(0);
    expect(sink.drafts, 'the draft is cleared once, not kept for the new park').toEqual([null]);
  });

  it('sends everything again to a new sink', () => {
    const session = devPark();
    session.guests.spawnGuests(40);
    for (let step = 0; step < 20; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    session.operations.addLitter({ x: 15, y: 20 }, 3);
    const { scene } = rig(session, PLACEHOLDER_CONTENT);
    frame(scene);
    frame(scene);
    const next = new RecordingSink();
    scene.setSink(next);
    frame(scene);
    expect(next.chunks.length, 'every chunk').toBe(scene.chunkCount);
    for (const texture of ['transforms', 'figures', 'litter', 'lights'] as const) {
      const call = next.dynamic(texture)[0];
      expect(call, `${texture} sent`).toBeDefined();
      if (call.count > 0) expect([call.rowStart, call.rowEnd > 0], `${texture}: from row 0`).toEqual([0, true]);
    }
    expect(next.ghosts, 'and the (empty) ghost').toEqual([null]);
  });

  it('knows where every object\'s top is, for overlay badges', () => {
    const session = devPark();
    const { scene } = rig(session, PLACEHOLDER_CONTENT);
    frame(scene);
    for (const object of session.world.objects.values()) {
      expect(scene.objectTop(object.id), `object ${object.id} has a top`).toBeGreaterThan(0);
    }
    expect(scene.objectTop(987_654), 'unknown objects have none').toBeNull();
  });
});

describe('scene: coaster centre line (Phase 27)', () => {
  it('rebuilds a coaster\'s own chunks once when it is built, and no frame after that rebuilds anything, train running', () => {
    const session = new ParkSession(null);
    session.world.setBuildAccessPolicy(null);
    session.world.addMoney(5_000_000, 'test');
    const { scene, sink } = rig(session, REGISTRY_CONTENT);
    frame(scene);
    frame(scene);
    sink.clear();
    const pieces = longestLayout({ x: 2, y: 2 });
    const type = COASTER_TYPE_BY_ID.get('skyline-serpent')!;
    const placed = session.world.placeCoaster('skyline-serpent', pieces, deriveCoasterStats(pieces, type), coasterBaseCost(pieces, type));
    if ('error' in placed) throw new Error(`placement failed: ${placed.error}`);
    session.syncWithWorld();
    const started = performance.now();
    frame(scene);
    const rebuildMs = performance.now() - started;
    const expected = new Set(pieces.map((piece) => chunkIndexOfCell(piece.cell.x, piece.cell.y, session.world.width)));
    const rebuilt = sink.chunks.map((call) => call.index);
    expect(new Set(rebuilt).size, 'each chunk once').toBe(rebuilt.length);
    expect(rebuilt.every((index) => expected.has(index)), `rebuilt ${rebuilt} ⊆ the coaster's chunks ${[...expected]}`).toBe(true);
    expect(rebuilt.length, 'every chunk the track touches').toBe(expected.size);
    const boxes = sink.chunks.reduce((sum, call) => sum + call.count, 0);
    expect(boxes, 'the longest coaster with corners everywhere (about 5 500 boxes)').toBeLessThanOrEqual(7_000);
    expect(rebuildMs, 'one frame that rebuilds the coaster\'s chunks (software, ms)').toBeLessThan(1_000);

    // The ride runs: frames move the train through the transform slots and nothing else.
    const runtime = session.rides.getRide(placed.id)!;
    runtime.status = 'running';
    const duration = session.world.coasters.get(placed.id)!.stats.durationSeconds;
    sink.clear();
    let moved = 0;
    for (let index = 0; index < 60; index += 1) {
      runtime.cycleRemainingSeconds = Math.max(0.2, duration - GAME_CONFIG.coaster.stationLoadSeconds - 0.1 * index);
      frame(scene, (index % 10) / 10);
      expect(scene.stats.chunksRebuilt, `frame ${index}: no chunk rebuilt`).toBe(0);
      expect(scene.stats.bytesStaged, `frame ${index}: staged`).toBeLessThanOrEqual(64 * KIB);
      if (sink.dynamic('transforms').length > moved) moved = sink.dynamic('transforms').length;
    }
    expect(sink.chunks, 'no chunk was sent while the train ran').toEqual([]);
    expect(moved, 'the train\'s transforms were staged').toBeGreaterThan(10);
  });

  it('shows riders by swapping poses, never by rebuilding: parked and running, filling and emptying, 0 chunks rebuilt', () => {
    const session = new ParkSession(null);
    session.world.setBuildAccessPolicy(null);
    session.world.addMoney(5_000_000, 'test');
    const { scene, sink } = rig(session, REGISTRY_CONTENT);
    frame(scene);
    const pieces = longestLayout({ x: 2, y: 2 });
    const type = COASTER_TYPE_BY_ID.get('skyline-serpent')!;
    const placed = session.world.placeCoaster('skyline-serpent', pieces, deriveCoasterStats(pieces, type), coasterBaseCost(pieces, type));
    if ('error' in placed) throw new Error(`placement failed: ${placed.error}`);
    session.syncWithWorld();
    frame(scene);
    frame(scene);
    const cars = type.trainCars;
    const runtime = session.rides.getRide(placed.id)!;
    const duration = session.world.coasters.get(placed.id)!.stats.durationSeconds;
    /** Slots whose pose is the collapse pose (contracts/rigid.ts COLLAPSED_PART_QUATERNION). */
    const collapsed = (): number => {
      const data = sink.latest.get('transforms')!;
      let count = 0;
      for (let at = 0; at + TRANSFORM_FLOATS <= data.length; at += TRANSFORM_FLOATS) {
        if (data[at + 4] === 0.5 && data[at + 5] === 0.5 && data[at + 6] === 0 && data[at + 7] === 0) count += 1;
      }
      return count;
    };
    expect(runtime.status, 'a built coaster starts idle').not.toBe('running');
    expect(collapsed(), 'parked: every rider part is collapsed').toBe(cars);

    const rebuildsOver = (frames: number, setup: (index: number) => void): number => {
      let rebuilt = 0;
      for (let index = 0; index < frames; index += 1) {
        setup(index);
        frame(scene, (index % 10) / 10);
        rebuilt += scene.stats.chunksRebuilt;
        expect(scene.stats.bytesStaged, `frame ${index}: staged`).toBeLessThanOrEqual(64 * KIB);
      }
      return rebuilt;
    };
    sink.clear();
    // Running with 4 of 8 seats taken: the serpent seats 2 2 1 1 1 1, so the front 2 cars carry riders.
    runtime.status = 'running';
    runtime.riderGuestIds = [1, 2, 3, 4];
    expect(rebuildsOver(60, (index) => {
      runtime.cycleRemainingSeconds = Math.max(0.2, duration - GAME_CONFIG.coaster.stationLoadSeconds - 0.1 * index);
    }), 'running with riders rebuilds nothing').toBe(0);
    expect(collapsed(), 'the four rear cars are empty').toBe(cars - 2);
    // Someone left the last seats empty then everyone got off.
    runtime.status = 'idle';
    runtime.riderGuestIds = [];
    expect(rebuildsOver(5, () => undefined), 'emptying rebuilds nothing').toBe(0);
    expect(collapsed(), 'parked again: no riders anywhere').toBe(cars);
    runtime.status = 'running';
    runtime.riderGuestIds = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(rebuildsOver(5, () => {
      runtime.cycleRemainingSeconds = duration - GAME_CONFIG.coaster.stationLoadSeconds - 2;
    }), 'filling again rebuilds nothing').toBe(0);
    expect(collapsed(), 'a full train: every car loaded').toBe(0);
    // A waiting train (queue boarding) or a broken one shows nobody, whatever the head count.
    for (const status of ['waiting', 'broken', 'maintenance', 'closed'] as const) {
      runtime.status = status;
      frame(scene);
      expect(collapsed(), `${status}: no riders`).toBe(cars);
    }
    expect(sink.chunks, 'no chunk was sent in any of it').toEqual([]);
  });

  it('keeps the dev park within its box budget with every coaster type as a rounded oval beside it', () => {
    const session = devPark();
    session.world.setBuildAccessPolicy(null);
    session.world.addMoney(5_000_000, 'test');
    let placed = 0;
    for (const [typeId, start] of [['comet-trail', { x: 1, y: 1 }], ['star-chaser', { x: 12, y: 1 }], ['skyline-serpent', { x: 21, y: 1 }]] as const) {
      const type = COASTER_TYPE_BY_ID.get(typeId)!;
      const pieces = ovalLayout(start);
      const result = session.world.placeCoaster(typeId, pieces, deriveCoasterStats(pieces, type), coasterBaseCost(pieces, type));
      if (!('error' in result)) placed += 1;
    }
    expect(placed, 'three ovals fit the dev park\'s free corner').toBeGreaterThanOrEqual(1);
    const { scene } = rig(session, REGISTRY_CONTENT);
    frame(scene);
    frame(scene);
    expect(totalBoxes(scene), 'the whole dev park, ovals included').toBeLessThanOrEqual(DEV_PARK_BOX_BUDGET);
  });
});
