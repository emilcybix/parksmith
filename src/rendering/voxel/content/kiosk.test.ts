import { describe, expect, it } from 'vitest';
import { BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { footprintSize } from '../../../game/types';
import type { BuildDefinition } from '../../../game/types';
import { compileBlueprint, flattenAtRest, rotateModel } from '../blueprint/compile';
import { LIGHT_PRESET_DAY, LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT } from '../contracts/blueprint';
import type { CompiledModel, LightSource } from '../contracts/blueprint';
import { BOX_FLOATS, unpackBoxWord } from '../contracts/boxes';
import { BOX_BUDGET } from '../contracts/budgets';
import { MAT, MAT_COLOR, PATTERN } from '../contracts/palette';
import { PLOT_TOP_Z, VOXELS_PER_TILE } from '../contracts/space';
import type { QuarterTurn } from '../contracts/space';
import { buildPalette } from '../palette';
import {
  KIOSK_AWNING_DEPTH,
  KIOSK_AWNING_TOP_Z,
  KIOSK_DOOR_HEIGHT,
  KIOSK_DOOR_WIDTH,
  KIOSK_ICON_SIZE,
  KIOSK_ROOF_OVERHANG,
  KIOSK_SIDE_WINDOW_LIGHT_RADIUS,
  KIOSK_STRIPE_WIDTH,
  KIOSK_TOP_LIMIT,
  KIOSK_WALL_HEIGHT,
  KIOSK_WALL_INSET,
  KIOSK_WINDOW_BOTTOM_Z,
  KIOSK_WINDOW_LIGHT_RADIUS,
  KIOSK_WINDOW_TOP_Z,
  KIOSK_WINDOW_WIDTH,
  kiosk,
  kioskFrontLayout,
} from './kiosk';

/**
 * Design §12, kiosk, as literals: the geometry below is checked against these, not against the
 * module's own constants, so changing a constant in kiosk.ts cannot move the goalposts.
 */
const ART_BIBLE = {
  wallInset: 4,
  wallHeight: 30,
  roofOverhang: 3,
  ridgeLimit: 58,
  doorWidth: 12,
  doorHeight: 22,
  windowBottomZ: 10,
  windowTopZ: 22,
  awningDepth: 5,
  stripeWidth: 4,
  iconSize: 8,
  windowLightRadius: 28,
  /** Ride bulbs' radius: the small light the gable windows use. */
  smallLightRadius: 16,
} as const;

/**
 * This builder's own layout decisions, pinned for the same reason. The awning height and valance
 * bottoms decide how much of the service window the camera sees (see the visibility test).
 */
const LAYOUT = {
  windowWidth: 25,
  awningTopZ: 28,
  accentValanceBottomZ: 24,
  colorValanceBottomZ: 25,
  sideWindowBottomZ: 12,
  sideWindowSize: 9,
} as const;

/**
 * Shares of each front feature's camera-facing texels the camera must actually see, at both quarter
 * turns. A 2-deep recess always loses its lintel rows and a column to its jamb, so a window can show
 * at most about 77 %. The kiosks show 64–66 % of the service window, 66–76 % of each door and 60 %
 * of the gable window; the old awning hid all but 26–29 % of the service window.
 */
const MIN_VISIBLE = {
  serviceWindow: 0.6,
  door: 0.6,
  sideWindow: 0.5,
} as const;

/** Every catalog shop and facility; the registry sends all of them to the kiosk builder. */
const KIOSK_IDS = [
  'picnic-pocket',
  'fizz-foundry',
  'glacier-scoop',
  'lemon-light',
  'waffle-windmill',
  'snack-sprint',
  'cactus-cooler',
  'cocoa-chalet',
  'comfort-cabin',
  'comfort-pavilion',
  // Phase 16.
  'pretzel-pram',
  'coconut-cove',
  // Phase 29: the souvenir stalls (one ridge icon per keepsake) and the warm drink barrow.
  'brolly-booth',
  'hat-hutch',
  'balloon-bouquet',
  'plushie-parlour',
  'glow-cart',
  'bean-barrow',
] as const;

const QUARTER_TURNS: readonly QuarterTurn[] = [0, 1];
const WALL_TOP_Z = PLOT_TOP_Z + ART_BIBLE.wallHeight;
/** Grid height: one voxel over the art-bible ceiling, so anything above it would show up. */
const GRID_HEIGHT = ART_BIBLE.ridgeLimit + 1;

const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);

const definitionOf = (id: string): BuildDefinition => {
  const definition = BUILD_CATALOG.find((entry) => entry.id === id);
  if (!definition) throw new Error(`catalog has no '${id}'`);
  return definition;
};

const DEFINITIONS = KIOSK_IDS.map(definitionOf);

/** A dense voxel grid over the (turned) footprint: material and pattern per voxel, 0 = empty. */
interface VoxelGrid {
  sizeX: number;
  sizeY: number;
  material: Uint8Array;
  pattern: Uint8Array;
  /** Voxels written by more than one box — z-fighting surfaces on a GPU. */
  overlaps: number;
  filled: number;
  /** Voxels outside the grid (the bounds test names the boxes). */
  outside: number;
}

const indexOf = (grid: VoxelGrid, x: number, y: number, z: number): number => (z * grid.sizeY + y) * grid.sizeX + x;

const inside = (grid: VoxelGrid, x: number, y: number, z: number): boolean =>
  x >= 0 && y >= 0 && z >= 0 && x < grid.sizeX && y < grid.sizeY && z < GRID_HEIGHT;

const materialAt = (grid: VoxelGrid, x: number, y: number, z: number): number =>
  inside(grid, x, y, z) ? grid.material[indexOf(grid, x, y, z)] : 0;

const patternAt = (grid: VoxelGrid, x: number, y: number, z: number): number =>
  inside(grid, x, y, z) ? grid.pattern[indexOf(grid, x, y, z)] : 0;

/** Rasterises a model-space box list over [0, sizeX) × [0, sizeY) × [0, GRID_HEIGHT). */
const gridOf = (boxes: Float32Array, boxCount: number, sizeX: number, sizeY: number): VoxelGrid => {
  const grid: VoxelGrid = {
    sizeX,
    sizeY,
    material: new Uint8Array(sizeX * sizeY * GRID_HEIGHT),
    pattern: new Uint8Array(sizeX * sizeY * GRID_HEIGHT),
    overlaps: 0,
    filled: 0,
    outside: 0,
  };
  for (let offset = 0; offset < boxCount * BOX_FLOATS; offset += BOX_FLOATS) {
    const word = unpackBoxWord(boxes[offset + 3]);
    for (let z = boxes[offset + 2]; z < boxes[offset + 2] + boxes[offset + 6]; z += 1) {
      for (let y = boxes[offset + 1]; y < boxes[offset + 1] + boxes[offset + 5]; y += 1) {
        for (let x = boxes[offset]; x < boxes[offset] + boxes[offset + 4]; x += 1) {
          if (!inside(grid, x, y, z)) {
            grid.outside += 1;
            continue;
          }
          const index = indexOf(grid, x, y, z);
          if (grid.material[index] !== 0) grid.overlaps += 1;
          else grid.filled += 1;
          grid.material[index] = word.material;
          grid.pattern[index] = word.pattern;
        }
      }
    }
  }
  return grid;
};

/** Voxels of `material` and `pattern` whose neighbour one step along (dx, dy) is empty. */
const exposedToward = (grid: VoxelGrid, material: number, pattern: number, dx: number, dy: number): number => {
  let count = 0;
  for (let z = 0; z < GRID_HEIGHT; z += 1) {
    for (let y = 0; y < grid.sizeY; y += 1) {
      for (let x = 0; x < grid.sizeX; x += 1) {
        const index = indexOf(grid, x, y, z);
        if (grid.material[index] !== material || grid.pattern[index] !== pattern) continue;
        if (materialAt(grid, x + dx, y + dy, z) === 0) count += 1;
      }
    }
  }
  return count;
};

/**
 * Whether the camera sees the (dx, dy, 0) face of voxel (x, y, z), dx + dy = 1. The projection
 * (space.ts) gives each voxel of a vertical face exactly one texel, sampled at the voxel's centre
 * across the face and a quarter or three quarters of the way up it, by the parity of the face
 * plane plus the column. From that point a 3D DDA walks the view ray (1, 1, 1) — the projection's
 * null vector, toward the camera — voxel by voxel: the texel shows the face iff the ray leaves the
 * model without entering a filled voxel. That is the depth test the GPU does for this texel.
 */
const seenByCamera = (grid: VoxelGrid, x: number, y: number, z: number, dx: number, dy: number): boolean => {
  // For a +y face (plane y + 1) and a +x face (plane x + 1) alike: x + y + 1 even samples at ¾.
  const up = ((x + y + 1) & 1) === 0 ? 0.75 : 0.25;
  // Time to the next voxel boundary along each axis, from the sample point on the face.
  let toX = dy === 1 ? 0.5 : 1;
  let toY = dy === 1 ? 1 : 0.5;
  let toZ = 1 - up;
  let voxelX = x + dx;
  let voxelY = y + dy;
  let voxelZ = z;
  while (voxelX < grid.sizeX && voxelY < grid.sizeY && voxelZ < GRID_HEIGHT) {
    if (materialAt(grid, voxelX, voxelY, voxelZ) !== 0) return false;
    const step = Math.min(toX, toY, toZ);
    if (toX === step) {
      voxelX += 1;
      toX += 1;
    }
    if (toY === step) {
      voxelY += 1;
      toY += 1;
    }
    if (toZ === step) {
      voxelZ += 1;
      toZ += 1;
    }
  }
  return true;
};

interface Visibility {
  /** Faces of the feature that face (dx, dy) and are not covered by a neighbour. */
  exposed: number;
  /** Of those, the ones whose texel shows the feature. */
  seen: number;
}

/** Camera visibility of the exposed (dx, dy) faces of every `material`/`pattern` voxel `where` accepts. */
const visibilityOf = (
  grid: VoxelGrid,
  material: number,
  pattern: number,
  dx: number,
  dy: number,
  where: (x: number, y: number) => boolean = () => true,
): Visibility => {
  const visibility = { exposed: 0, seen: 0 };
  for (let z = 0; z < GRID_HEIGHT; z += 1) {
    for (let y = 0; y < grid.sizeY; y += 1) {
      for (let x = 0; x < grid.sizeX; x += 1) {
        const index = indexOf(grid, x, y, z);
        if (grid.material[index] !== material || grid.pattern[index] !== pattern || !where(x, y)) continue;
        if (materialAt(grid, x + dx, y + dy, z) !== 0) continue;
        visibility.exposed += 1;
        if (seenByCamera(grid, x, y, z, dx, dy)) visibility.seen += 1;
      }
    }
  }
  return visibility;
};

interface Built {
  model: CompiledModel;
  grid: VoxelGrid;
  /** The turned footprint, in voxels. */
  width: number;
  depth: number;
}

const builds = new Map<string, Built>();

/** Built lazily inside the tests, so a content bug fails a test instead of the file's collection. */
const build = (definition: BuildDefinition, quarterTurn: QuarterTurn): Built => {
  const key = `${definition.id}:${quarterTurn}`;
  const cached = builds.get(key);
  if (cached) return cached;
  const model = rotateModel(compileBlueprint(kiosk.blueprint(definition, palette)), quarterTurn);
  const [tilesWide, tilesDeep] = footprintSize(definition, quarterTurn);
  const width = tilesWide * VOXELS_PER_TILE;
  const depth = tilesDeep * VOXELS_PER_TILE;
  const flat = flattenAtRest(model);
  const built = { model, grid: gridOf(flat.boxes, flat.boxCount, width, depth), width, depth };
  builds.set(key, built);
  return built;
};

/** Every box of every part, at rest, as model-space min and max corners. */
const eachBox = (model: CompiledModel, visit: (min: readonly number[], max: readonly number[]) => void): void => {
  for (const part of model.parts) {
    for (let offset = 0; offset < part.boxCount * BOX_FLOATS; offset += BOX_FLOATS) {
      const min = [part.boxes[offset] + part.pivot[0], part.boxes[offset + 1] + part.pivot[1], part.boxes[offset + 2] + part.pivot[2]];
      visit(min, [min[0] + part.boxes[offset + 4], min[1] + part.boxes[offset + 5], min[2] + part.boxes[offset + 6]]);
    }
  }
};

const materialsOf = (model: CompiledModel): Set<number> => {
  const materials = new Set<number>();
  for (const part of model.parts) {
    for (let offset = 0; offset < part.boxCount * BOX_FLOATS; offset += BOX_FLOATS) {
      materials.add(unpackBoxWord(part.boxes[offset + 3]).material);
    }
  }
  return materials;
};

/** Where the model's front (+y) and right gable (+x) point once the model is turned. */
interface TurnedAxes {
  /** World (x, y) step of model +y. */
  front: readonly [number, number];
  /** The turned footprint's extent along model y and along model x, in voxels. */
  frontExtent: number;
  sideExtent: number;
  /** A world position's model y and model x (continuous: rotatePointInFootprint's inverse). */
  alongFront(position: readonly number[]): number;
  alongSide(position: readonly number[]): number;
}

/** Quarter turn 1 maps model (x, y) to world (y, W − x) (space.ts): model +y → world +x, +x → −y. */
const axesOf = (quarterTurn: QuarterTurn, width: number, depth: number): TurnedAxes => (quarterTurn === 0
  ? { front: [0, 1], frontExtent: depth, sideExtent: width, alongFront: (position) => position[1], alongSide: (position) => position[0] }
  : { front: [1, 0], frontExtent: width, sideExtent: depth, alongFront: (position) => position[0], alongSide: (position) => depth - position[1] });

describe('kiosk content', () => {
  it('builds to the art-bible dimensions and its pinned layout', () => {
    expect(KIOSK_WALL_INSET, 'walls inset 4').toBe(ART_BIBLE.wallInset);
    expect(KIOSK_WALL_HEIGHT, 'walls 30 tall').toBe(ART_BIBLE.wallHeight);
    expect(KIOSK_ROOF_OVERHANG, 'roof overhang 3').toBe(ART_BIBLE.roofOverhang);
    expect(KIOSK_TOP_LIMIT, 'ridge ≤ 58').toBe(ART_BIBLE.ridgeLimit);
    expect([KIOSK_DOOR_WIDTH, KIOSK_DOOR_HEIGHT], 'door 12×22').toEqual([ART_BIBLE.doorWidth, ART_BIBLE.doorHeight]);
    expect([KIOSK_WINDOW_BOTTOM_Z, KIOSK_WINDOW_TOP_Z], 'window z 10–22').toEqual([ART_BIBLE.windowBottomZ, ART_BIBLE.windowTopZ]);
    expect(KIOSK_AWNING_DEPTH, 'awning 5 deep').toBe(ART_BIBLE.awningDepth);
    expect(KIOSK_STRIPE_WIDTH, '4-wide stripes').toBe(ART_BIBLE.stripeWidth);
    expect(KIOSK_ICON_SIZE, '8×8 icon').toBe(ART_BIBLE.iconSize);
    expect(KIOSK_WINDOW_LIGHT_RADIUS, 'window light radius 28').toBe(ART_BIBLE.windowLightRadius);
    expect(KIOSK_SIDE_WINDOW_LIGHT_RADIUS, 'gable windows: the small light').toBe(ART_BIBLE.smallLightRadius);
    expect(KIOSK_WINDOW_WIDTH, 'service window 25 wide').toBe(LAYOUT.windowWidth);
    expect(KIOSK_AWNING_TOP_Z, 'awning meets the wall at z 28').toBe(LAYOUT.awningTopZ);
  });

  it('covers exactly the catalog shops and facilities', () => {
    const served = BUILD_CATALOG.filter((definition) => definition.kind === 'shop' || definition.kind === 'facility').map((definition) => definition.id);
    expect([...served].sort(), 'every shop and facility is a kiosk, and nothing else is').toEqual([...KIOSK_IDS].sort());
  });

  it('gives every definition its own blueprint id, and builds deterministically', () => {
    const ids = DEFINITIONS.map((definition) => kiosk.blueprint(definition, palette).id);
    expect(new Set(ids).size, 'blueprint ids are the compile cache key').toBe(DEFINITIONS.length);
    for (const definition of DEFINITIONS) {
      const first = kiosk.blueprint(definition, palette);
      const second = kiosk.blueprint(definition, palette);
      expect(JSON.stringify(second), `${definition.id}: two builds are equal`).toBe(JSON.stringify(first));
      const firstBoxes = compileBlueprint(first).parts[0].boxes;
      const secondBoxes = compileBlueprint(second).parts[0].boxes;
      expect(Array.from(secondBoxes), `${definition.id}: two compiles are equal`).toEqual(Array.from(firstBoxes));
    }
  });

  it('is a single static body, so its swept volume is its rest pose', () => {
    expect(kiosk.drivers, 'no moving parts, no drivers').toBeUndefined();
    for (const definition of DEFINITIONS) {
      expect(kiosk.blueprint(definition, palette).parts.map((part) => part.id), definition.id).toEqual(['body']);
    }
  });

  it('refuses footprints its layout cannot fit', () => {
    const narrow: BuildDefinition = { ...definitionOf('picnic-pocket'), id: 'narrow-kiosk', footprint: [1, 1] };
    const deep: BuildDefinition = { ...definitionOf('picnic-pocket'), id: 'deep-kiosk', footprint: [2, 3] };
    expect(() => kiosk.blueprint(narrow, palette), 'a 1-wide front has no room for window and door').toThrow(/narrow-kiosk/);
    expect(() => kiosk.blueprint(deep, palette), 'a 3-deep gable lifts the icon past the ceiling').toThrow(/deep-kiosk/);
  });

  for (const definition of DEFINITIONS) {
    describe(definition.id, () => {
      for (const quarterTurn of QUARTER_TURNS) {
        describe(`quarter turn ${quarterTurn}`, () => {
          it('compiles within the box budget', () => {
            expect(() => build(definition, quarterTurn), 'compiles').not.toThrow();
            const { model } = build(definition, quarterTurn);
            expect(model.boxCount, 'boxes, all parts, after hollowing').toBeGreaterThan(0);
            expect(model.boxCount, `BOX_BUDGET.kiosk (${BOX_BUDGET.kiosk})`).toBeLessThanOrEqual(BOX_BUDGET.kiosk);
          });

          it('stays inside its footprint, on the plot, under the art-bible ceiling', () => {
            const { model, grid, width, depth } = build(definition, quarterTurn);
            eachBox(model, (min, max) => {
              expect(min[0], 'x ≥ 0').toBeGreaterThanOrEqual(0);
              expect(min[1], 'y ≥ 0').toBeGreaterThanOrEqual(0);
              expect(min[2], 'nothing reaches into the plot slab').toBeGreaterThanOrEqual(PLOT_TOP_Z);
              expect(max[0], 'x inside 32 · footprint').toBeLessThanOrEqual(width);
              expect(max[1], 'y inside 32 · footprint').toBeLessThanOrEqual(depth);
              expect(max[2], `top ≤ ${ART_BIBLE.ridgeLimit}`).toBeLessThanOrEqual(ART_BIBLE.ridgeLimit);
            });
            expect(grid.outside, 'no voxel outside the footprint').toBe(0);
            expect(model.top, `model top ≤ ${ART_BIBLE.ridgeLimit}`).toBeLessThanOrEqual(ART_BIBLE.ridgeLimit);
          });

          it('has no parts overlapping at rest', () => {
            const { model, grid } = build(definition, quarterTurn);
            let partVoxels = 0;
            for (const part of model.parts) {
              for (let offset = 0; offset < part.boxCount * BOX_FLOATS; offset += BOX_FLOATS) {
                partVoxels += part.boxes[offset + 4] * part.boxes[offset + 5] * part.boxes[offset + 6];
              }
            }
            expect(grid.overlaps, 'no voxel is drawn twice').toBe(0);
            expect(grid.filled, 'the at-rest union equals the sum of the parts').toBe(partVoxels);
          });

          it('turns its door and service window to the camera-facing front', () => {
            const { grid, width, depth } = build(definition, quarterTurn);
            const [dx, dy] = axesOf(quarterTurn, width, depth).front;
            const windowArea = LAYOUT.windowWidth * (ART_BIBLE.windowTopZ - ART_BIBLE.windowBottomZ);
            const doorArea = ART_BIBLE.doorWidth * ART_BIBLE.doorHeight * kioskFrontLayout(definition).doors.length;
            expect(exposedToward(grid, MAT.GLASS, PATTERN.WINDOW, dx, dy), 'every voxel of the service window has an open face toward the front')
              .toBe(windowArea);
            expect(exposedToward(grid, palette.material(MAT_COLOR.TIMBER), PATTERN.PLANKS, dx, dy), 'every door voxel has an open face toward the front')
              .toBe(doorArea);
            expect(exposedToward(grid, MAT.GLASS, PATTERN.WINDOW, -dx, -dy), 'nothing glazed faces away on the front axis')
              .toBe(0);
          });

          it('lets the camera see most of its service window, doors and gable window', () => {
            const { grid, width, depth } = build(definition, quarterTurn);
            const axes = axesOf(quarterTurn, width, depth);
            const [dx, dy] = axes.front;
            const share = ({ exposed, seen }: Visibility): number => (exposed === 0 ? 0 : seen / exposed);
            const serviceWindow = visibilityOf(grid, MAT.GLASS, PATTERN.WINDOW, dx, dy);
            expect(serviceWindow.exposed, 'the service window faces the camera').toBe(LAYOUT.windowWidth * (ART_BIBLE.windowTopZ - ART_BIBLE.windowBottomZ));
            expect(share(serviceWindow), `service window: ${serviceWindow.seen}/${serviceWindow.exposed} texels seen`)
              .toBeGreaterThanOrEqual(MIN_VISIBLE.serviceWindow);
            // Each door on its own, told apart by its span along the model's x (the turned side axis).
            const modelWidth = definition.footprint[0] * VOXELS_PER_TILE;
            const modelX = (x: number, y: number): number => (quarterTurn === 0 ? x : modelWidth - 1 - y);
            const timber = palette.material(MAT_COLOR.TIMBER);
            for (const door of kioskFrontLayout(definition).doors) {
              const seen = visibilityOf(grid, timber, PATTERN.PLANKS, dx, dy, (x, y) => modelX(x, y) >= door.from && modelX(x, y) < door.to);
              expect(seen.exposed, `door [${door.from}, ${door.to}) faces the camera`).toBe(ART_BIBLE.doorWidth * ART_BIBLE.doorHeight);
              expect(share(seen), `door [${door.from}, ${door.to}): ${seen.seen}/${seen.exposed} texels seen`)
                .toBeGreaterThanOrEqual(MIN_VISIBLE.door);
            }
            // The gable end facing the camera: model +x (world +x) at quarter turn 0, model −x (world +y) at 1.
            const [sideX, sideY] = quarterTurn === 0 ? [1, 0] : [0, 1];
            const gableWindow = visibilityOf(grid, MAT.GLASS, PATTERN.WINDOW, sideX, sideY);
            expect(gableWindow.exposed, 'one 9×9 gable window faces the camera').toBe(LAYOUT.sideWindowSize * LAYOUT.sideWindowSize);
            expect(share(gableWindow), `gable window: ${gableWindow.seen}/${gableWindow.exposed} texels seen`)
              .toBeGreaterThanOrEqual(MIN_VISIBLE.sideWindow);
          });

          it('lights the path in front of the service window and each gable window at dusk and night', () => {
            const { model, width, depth } = build(definition, quarterTurn);
            const axes = axesOf(quarterTurn, width, depth);
            expect(model.lights, 'the service window and the two gable windows').toHaveLength(3);
            for (const light of model.lights) {
              const [x, y] = light.position;
              expect(light.color, 'warm window light').toBe(MAT_COLOR.WINDOW_GLOW);
              expect(light.presets & (LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT), 'on at dusk and night').toBe(LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT);
              expect(light.presets & LIGHT_PRESET_DAY, 'off by day, like the glass glow').toBe(0);
              expect(x >= 0 && x < width && y >= 0 && y < depth, 'inside the footprint').toBe(true);
            }
            const byRadius = (radius: number): LightSource[] => model.lights.filter((light) => light.radius === radius);
            const [service] = byRadius(ART_BIBLE.windowLightRadius);
            expect(service, 'art bible: the service window light has radius 28').toBeDefined();
            const serviceZ = service.position[2];
            expect(axes.alongFront(service.position), 'in front of the front wall').toBeGreaterThanOrEqual(axes.frontExtent - ART_BIBLE.wallInset);
            expect(serviceZ, 'at window height').toBeGreaterThanOrEqual(ART_BIBLE.windowBottomZ);
            expect(serviceZ, 'at window height').toBeLessThan(ART_BIBLE.windowTopZ);
            const gables = byRadius(ART_BIBLE.smallLightRadius);
            expect(gables, 'one small light per gable window').toHaveLength(2);
            const sides = gables.map((light) => axes.alongSide(light.position)).sort((a, b) => a - b);
            expect(sides[0], 'outside the model −x gable wall').toBeLessThanOrEqual(ART_BIBLE.wallInset);
            expect(sides[1], 'outside the model +x gable wall').toBeGreaterThanOrEqual(axes.sideExtent - ART_BIBLE.wallInset);
            for (const light of gables) {
              expect(light.position[2], 'at gable-window height').toBeGreaterThanOrEqual(LAYOUT.sideWindowBottomZ);
              expect(light.position[2], 'at gable-window height').toBeLessThan(LAYOUT.sideWindowBottomZ + LAYOUT.sideWindowSize);
            }
          });

          it('uses plain palette colours, glass only through MAT.GLASS', () => {
            const materials = materialsOf(build(definition, quarterTurn).model);
            for (const material of materials) {
              if (material === MAT.GLASS) continue;
              expect(palette.flags(material), `material ${material} is plain`).toBe(0);
            }
            expect(materials.has(MAT.GLASS), 'glazed').toBe(true);
            expect(materials.has(palette.material(definition.color)), 'walls in the catalog colour').toBe(true);
            expect(materials.has(palette.material(definition.accent)), 'roof in the catalog accent').toBe(true);
          });
        });
      }

      describe('in model space', () => {
        const wall = palette.material(definition.color);
        const accent = palette.material(definition.accent);
        const layout = kioskFrontLayout(definition);
        const width = definition.footprint[0] * VOXELS_PER_TILE;
        const depth = definition.footprint[1] * VOXELS_PER_TILE;
        const frontY = depth - ART_BIBLE.wallInset;

        it('stands its walls inset 4 and 30 tall, patterned by kind', () => {
          const { grid } = build(definition, 0);
          const wallPattern = definition.kind === 'facility' ? PATTERN.BRICK : PATTERN.PLANKS;
          const inset = ART_BIBLE.wallInset;
          const probeX = inset + 4;
          const probeY = depth / 2;
          expect(materialAt(grid, inset - 1, probeY, 5), 'nothing outside the west wall').toBe(0);
          expect(materialAt(grid, inset, probeY, 5), 'west wall').toBe(wall);
          expect(materialAt(grid, width - inset - 1, probeY, 5), 'east wall').toBe(wall);
          expect(materialAt(grid, width - inset, probeY, 5), 'nothing outside the east wall').toBe(0);
          expect(materialAt(grid, probeX, inset, WALL_TOP_Z - 1), 'top wall course at z 30').toBe(wall);
          expect(materialAt(grid, probeX, inset - 1, WALL_TOP_Z - 1), 'nothing outside the back wall').toBe(0);
          expect(patternAt(grid, probeX, inset, 5), 'brick facilities, plank shops').toBe(wallPattern);
        });

        it('steps its gable roof 1:2 in 1-voxel steps with a 3-voxel overhang, ridge ≤ 58', () => {
          const { grid } = build(definition, 0);
          const eave = ART_BIBLE.wallInset - ART_BIBLE.roofOverhang;
          // A column clear of the icon and the gable ends.
          const probeX = ART_BIBLE.wallInset + 6;
          let ridgeTop = WALL_TOP_Z;
          for (let layer = 0; WALL_TOP_Z + layer < GRID_HEIGHT; layer += 1) {
            const z = WALL_TOP_Z + layer;
            let minY = Infinity;
            let maxY = -Infinity;
            for (let y = 0; y < depth; y += 1) {
              if (materialAt(grid, probeX, y, z) !== accent || patternAt(grid, probeX, y, z) !== PATTERN.ROOF) continue;
              minY = Math.min(minY, y);
              maxY = Math.max(maxY, y);
            }
            if (minY === Infinity) break;
            expect(minY, `layer ${layer}: the back slope steps 2 per voxel of height`).toBe(eave + 2 * layer);
            expect(maxY, `layer ${layer}: the front slope steps 2 per voxel of height`).toBe(depth - eave - 1 - 2 * layer);
            ridgeTop = z + 1;
          }
          expect(ridgeTop, 'a roof at all').toBeGreaterThan(WALL_TOP_Z + 4);
          expect(ridgeTop, 'art bible: ridge ≤ 58').toBeLessThanOrEqual(ART_BIBLE.ridgeLimit);
          expect(materialAt(grid, eave, eave + 1, WALL_TOP_Z), 'eave corner, 3 past both walls').toBe(accent);
          expect(materialAt(grid, width - eave - 1, depth - eave - 2, WALL_TOP_Z), 'eave corner, 3 past both walls').toBe(accent);
          expect(materialAt(grid, eave, depth / 2, WALL_TOP_Z + 2), 'hollow under the west barge boards').toBe(0);
          expect(materialAt(grid, width - ART_BIBLE.wallInset - 1, depth / 2, WALL_TOP_Z + 2), 'gable end in the wall colour').toBe(wall);
          expect(materialAt(grid, width - ART_BIBLE.wallInset, depth / 2, WALL_TOP_Z + 2), 'hollow under the east barge boards').toBe(0);
        });

        it('hangs a 5-deep awning of 4-wide stripes over the window, pale at both ends', () => {
          const { grid } = build(definition, 0);
          const valanceZ = LAYOUT.colorValanceBottomZ;
          const edgeY = frontY - 1 + ART_BIBLE.awningDepth - 1;
          const materials: number[] = [];
          let from = Infinity;
          let to = -Infinity;
          for (let x = 0; x < width; x += 1) {
            const material = materialAt(grid, x, edgeY, valanceZ);
            if (material === 0) continue;
            from = Math.min(from, x);
            to = Math.max(to, x + 1);
            materials.push(material);
          }
          expect(from, 'inside the awning span').toBeGreaterThanOrEqual(layout.awning.from);
          expect(to, 'inside the awning span').toBeLessThanOrEqual(layout.awning.to);
          expect(from, 'covers the window').toBeLessThanOrEqual(layout.window.from);
          expect(to, 'covers the window').toBeGreaterThanOrEqual(layout.window.to);
          expect(materials.length % (2 * ART_BIBLE.stripeWidth), 'an odd number of whole stripes').toBe(ART_BIBLE.stripeWidth);
          materials.forEach((material, index) => {
            const stripe = Math.floor(index / ART_BIBLE.stripeWidth);
            expect(material, `stripe ${stripe}: accent and colour alternate, accent at the ends`).toBe(stripe % 2 === 0 ? accent : wall);
          });
          // 5 deep: from the wall voxel it hangs from to the edge of the footprint.
          const stripeX = from + 1;
          expect(materialAt(grid, stripeX, frontY - 1, LAYOUT.awningTopZ - 1), 'hangs from the wall').toBe(accent);
          expect(materialAt(grid, stripeX, frontY - 1, LAYOUT.awningTopZ), 'meets the wall at z 28').toBe(wall);
          expect(materialAt(grid, stripeX, edgeY, valanceZ), 'front edge').toBe(accent);
          expect(materialAt(grid, stripeX, edgeY + 1, valanceZ), 'nothing past the front edge').toBe(0);
          expect(edgeY + 1, 'stays inside the footprint').toBeLessThanOrEqual(depth);
          // The scalloped edge: the accent valances hang a voxel below the colour ones, and nothing lower.
          const colorX = from + ART_BIBLE.stripeWidth + 1;
          expect(materialAt(grid, stripeX, edgeY, LAYOUT.accentValanceBottomZ), 'accent valance reaches z 24').toBe(accent);
          expect(materialAt(grid, colorX, edgeY, LAYOUT.accentValanceBottomZ), 'colour valance stops at z 25').toBe(0);
          for (let y = frontY; y < depth; y += 1) {
            for (let x = layout.awning.from; x < layout.awning.to; x += 1) {
              expect(materialAt(grid, x, y, LAYOUT.accentValanceBottomZ - 1), 'nothing of the awning below z 24').toBe(0);
            }
          }
        });

        it('puts one 8×8 icon for its service kind on the ridge', () => {
          const { grid } = build(definition, 0);
          const eave = ART_BIBLE.wallInset - ART_BIBLE.roofOverhang;
          const ridgeTop = WALL_TOP_Z + Math.ceil((depth - 2 * eave) / 4);
          const iconMaterials = new Set<number>();
          const centreX = width / 2;
          const centreY = depth / 2;
          for (let z = ridgeTop; z < GRID_HEIGHT; z += 1) {
            for (let y = 0; y < depth; y += 1) {
              for (let x = 0; x < width; x += 1) {
                const material = materialAt(grid, x, y, z);
                if (material === 0) continue;
                iconMaterials.add(material);
                expect(Math.abs(x + 0.5 - centreX), 'icon within 8 along x').toBeLessThanOrEqual(ART_BIBLE.iconSize / 2);
                expect(Math.abs(y + 0.5 - centreY), 'icon within 8 along y').toBeLessThanOrEqual(ART_BIBLE.iconSize / 2);
              }
            }
          }
          const service = definition.stats?.serviceType;
          const souvenir = definition.stats?.souvenir;
          const white = palette.material(MAT_COLOR.WHITE);
          // Phase 29 keepsakes: umbrella pole, canopy and tip | straw brim and coloured crown | string and balloon |
          // teddy fur and snout | stick and glowing star.
          const souvenirIcon = souvenir === 'umbrella' ? [palette.material(MAT_COLOR.INK), wall, white]
            : souvenir === 'hat' ? [palette.material(MAT_COLOR.HAIR_BLOND), wall]
              : souvenir === 'balloon' ? [white, wall]
                : souvenir === 'plush' ? [palette.material(MAT_COLOR.HAIR_BROWN), white]
                  : [white, palette.material(MAT_COLOR.LAMP_GLOW)];
          const expected = service === 'food'
            ? [MAT_COLOR.HAIR_BLOND, MAT_COLOR.HAIR_BROWN, MAT_COLOR.FOLIAGE].map((rgb) => palette.material(rgb))
            : service === 'drink'
              ? [wall, palette.material(MAT_COLOR.WHITE), palette.material(MAT_COLOR.ARCH_PINK)]
              : service === 'souvenir'
                ? souvenirIcon
                : [palette.material(MAT_COLOR.WHITE), wall];
          expect([...iconMaterials].sort(), `${service} icon: bun, patty, lettuce | cup, lid, straw | sign, door`)
            .toEqual([...expected].sort());
        });

        if (definition.stats?.serviceType === 'drink') {
          it('shows a cup with a straw leaning out of it, not a cupcake', () => {
            const { grid } = build(definition, 0);
            const straw = palette.material(MAT_COLOR.ARCH_PINK);
            const lid = palette.material(MAT_COLOR.WHITE);
            const centreX = width / 2;
            const centreY = depth / 2;
            let lidZ = -1;
            const strawX = new Map<number, number[]>();
            for (let z = 0; z < GRID_HEIGHT; z += 1) {
              for (let y = centreY - 4; y < centreY + 4; y += 1) {
                for (let x = centreX - 4; x < centreX + 4; x += 1) {
                  const material = materialAt(grid, x, y, z);
                  if (material === lid) lidZ = Math.max(lidZ, z);
                  if (material === straw) strawX.set(z, [...(strawX.get(z) ?? []), x]);
                }
              }
            }
            const rows = [...strawX.keys()].sort((a, b) => a - b);
            const lowest = strawX.get(rows[0]) ?? [];
            const highest = strawX.get(rows[rows.length - 1]) ?? [];
            expect(rows[rows.length - 1] - lidZ, 'the straw rises well clear of the lid').toBeGreaterThanOrEqual(4);
            expect(Math.min(...highest), 'the straw leans toward model +x (screen right at both turns)').toBeGreaterThan(Math.min(...lowest));
            expect(materialAt(grid, centreX - 4, centreY, lidZ), 'the lid is no wider than the cup').toBe(0);
            expect(materialAt(grid, centreX + 3, centreY, lidZ), 'the lid is no wider than the cup').toBe(0);
          });
        }
      });
    });
  }
});
