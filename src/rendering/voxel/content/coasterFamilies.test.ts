import { describe, expect, it } from 'vitest';
import { centreLineFor, createCentreLineFrame, sampleCentreLineFrame } from '../../../game/coaster/centreLine';
import { hillDipLayout, layoutFromMoves, ovalLayout } from '../../../game/coaster/testLayouts';
import { COASTER_HANG_OFFSET_VOXELS, coasterHangOffset, coasterRailTopZ } from '../scene/coasterCars';
import { BUILD_BY_ID, BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { compileBlueprint } from '../blueprint/compile';
import { BOX_FLOATS, BoxWriter, unpackBoxWord } from '../contracts/boxes';
import { MAT } from '../contracts/palette';
import { buildPalette } from '../palette';
import { COASTER_PIECE_BOX_ALLOWANCE, GANTRY_LEG_ACROSS, INVERTED_TRACK_LIFT, TRACK_DEPTH, coasterContent } from './coaster';

/** Phase 39 art: the wooden family's lattice bents and timber look, and the wild mouse's single car. */
const palette = buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);
const LAYOUT = hillDipLayout();
/** Piece 6 of the hill-and-dip stands at level 3 on a flat crest: a bent with a braced bay. */
const TALL = 6;

const boxesOf = (definitionId: string, index: number): Float32Array[] => {
  const writer = new BoxWriter(64);
  coasterContent.pieceBoxes(LAYOUT, index, BUILD_BY_ID.get(definitionId)!, palette, 1, writer);
  return Array.from({ length: writer.count }, (_unused, box) => writer.data.slice(box * BOX_FLOATS, box * BOX_FLOATS + 8));
};
const overlaps = (a: Float32Array, b: Float32Array): boolean =>
  a[0] < b[0] + b[4] && b[0] < a[0] + a[4] && a[1] < b[1] + b[5] && b[1] < a[1] + a[5] && a[2] < b[2] + b[6] && b[2] < a[2] + a[6];

describe('Phase 39: coaster family art (voxel)', () => {
  it('the wooden coaster braces every bay both ways, in timber, and no two of its boxes overlap', () => {
    expect(LAYOUT[TALL].height).toBe(3);
    const wooden = boxesOf('timber-twister', TALL);
    const steel = boxesOf('star-chaser', TALL);
    expect(wooden.length).toBeGreaterThan(steel.length);
    const materials = new Set(wooden.map((box) => unpackBoxWord(box[3]).material));
    expect(materials.has(MAT.TIMBER)).toBe(true);
    expect(materials.has(MAT.WOOD)).toBe(true);
    for (let a = 0; a < wooden.length; a += 1) {
      for (let b = a + 1; b < wooden.length; b += 1) expect(overlaps(wooden[a], wooden[b]), `boxes ${a} and ${b}`).toBe(false);
    }
  });

  it('the wild mouse lead car has a mouse face, and every family car compiles', () => {
    for (const id of ['whisker-mouse', 'timber-twister']) {
      const definition = BUILD_BY_ID.get(id)!;
      const car = compileBlueprint(coasterContent.carBlueprint(definition, 0, palette));
      expect(car.boxCount, id).toBeGreaterThan(0);
      const riders = compileBlueprint(coasterContent.riderBlueprint(definition, 0, palette));
      expect(riders.boxCount, `${id} riders`).toBeGreaterThan(0);
    }
    const mouse = compileBlueprint(coasterContent.carBlueprint(BUILD_BY_ID.get('whisker-mouse')!, 0, palette));
    const comet = compileBlueprint(coasterContent.carBlueprint(BUILD_BY_ID.get('comet-trail')!, 0, palette));
    expect(mouse.top, 'the ears stand above a plain car').toBeGreaterThan(comet.top);
  });
});

describe('Phase 39 step 3: the inverted coaster art', () => {
  const OVAL = ovalLayout();
  const boxes = (id: string, index: number): Float32Array[] => {
    const writer = new BoxWriter(64);
    coasterContent.pieceBoxes(OVAL, index, BUILD_BY_ID.get(id)!, palette, 1, writer);
    return Array.from({ length: writer.count }, (_unused, box) => writer.data.slice(box * BOX_FLOATS, box * BOX_FLOATS + 8));
  };

  it('draws the track a level up and its gantry clear of the hanging cars', () => {
    // Piece 6 of the oval: a straight at level 2, an even index, so it carries a gantry.
    const lifted = boxes('bat-wing', 6);
    const plain = boxes('comet-trail', 6);
    const highest = (list: Float32Array[]) => Math.max(...list.map((box) => box[2] + box[6]));
    expect(highest(lifted)).toBeGreaterThanOrEqual(highest(plain) + INVERTED_TRACK_LIFT - 1);
    // Nothing of the inverted piece reaches into the column the cars hang in (|across| < 6 voxels, under the spine).
    const railTop = coasterRailTopZ(2) + INVERTED_TRACK_LIFT;
    for (const box of lifted) {
      const centreAcross = Math.abs(box[1] + box[5] / 2 - (4 * 32 + 16));
      const belowTrack = box[2] < railTop - TRACK_DEPTH;
      if (belowTrack) expect(centreAcross, `box at z ${box[2]}`).toBeGreaterThanOrEqual(GANTRY_LEG_ACROSS - 2);
    }
  });

  it('hangs the train: its cars sit below the normal rail top on an inverted coaster only', () => {
    expect(coasterHangOffset('bat-wing')).toBe(COASTER_HANG_OFFSET_VOXELS);
    expect(COASTER_HANG_OFFSET_VOXELS).toBeLessThan(0);
    expect(coasterHangOffset('comet-trail')).toBe(0);
    expect(coasterHangOffset(undefined)).toBe(0);
  });
});

describe('Phase 44: the shuttle art', () => {
  /** A shuttle: the launch station, a run-up and a spike to level 5. */
  const SHUTTLE = layoutFromMoves({ x: 4, y: 4 }, 'EEEEEEEEE', [0, 0, 0, 0, 1, 2, 3, 4, 5]);
  SHUTTLE[0].launchSpeed = 7;
  const boxes = (index: number): Float32Array[] => {
    const writer = new BoxWriter(64);
    coasterContent.pieceBoxes(SHUTTLE, index, BUILD_BY_ID.get('thunder-launch')!, palette, 1, writer);
    return Array.from({ length: writer.count }, (_unused, box) => writer.data.slice(box * BOX_FLOATS, box * BOX_FLOATS + 8));
  };
  const materialsOf = (list: Float32Array[]) => new Set(list.map((box) => unpackBoxWord(box[3]).material));

  it('launch chevrons light the station after its first piece; no brake at the spike top and no chain on it', () => {
    expect(materialsOf(boxes(1)).has(MAT.BULB)).toBe(true);
    expect(materialsOf(boxes(2)).has(MAT.BULB)).toBe(true);
    const top = materialsOf(boxes(SHUTTLE.length - 1));
    expect(top.has(MAT.CONCRETE), 'no brake pad').toBe(false);
    expect(top.has(MAT.FENCE_POST), 'no brake fin').toBe(false);
    for (let index = 3; index < SHUTTLE.length; index += 1) expect(materialsOf(boxes(index)).has(MAT.FENCE_RAIL), `piece ${index}`).toBe(false);
  });

  it('every piece compiles inside its tile, no two boxes overlapping', () => {
    for (let index = 0; index < SHUTTLE.length; index += 1) {
      const list = boxes(index);
      expect(list.length).toBeGreaterThan(0);
      for (const box of list) {
        expect(box[0]).toBeGreaterThanOrEqual(SHUTTLE[index].cell.x * 32);
        expect(box[0] + box[4]).toBeLessThanOrEqual(SHUTTLE[index].cell.x * 32 + 32);
      }
      for (let a = 0; a < list.length; a += 1) {
        for (let b = a + 1; b < list.length; b += 1) expect(overlaps(list[a], list[b]), `piece ${index}: boxes ${a} and ${b}`).toBe(false);
      }
    }
  });
});

describe('Phase 45: tall track art', () => {
  const TALL_LAYOUT = layoutFromMoves({ x: 2, y: 2 }, `${'E'.repeat(18)}SS${'W'.repeat(18)}NN`,
    [0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, 0, 1, 2, 1, 0]);
  it('a level-10 piece stands on a braced tower reaching the ground, no two boxes overlapping', () => {
    const writer = new BoxWriter(64);
    coasterContent.pieceBoxes(TALL_LAYOUT, 12, BUILD_BY_ID.get('titan-hyper')!, palette, 1, writer);
    const list = Array.from({ length: writer.count }, (_unused, box) => writer.data.slice(box * BOX_FLOATS, box * BOX_FLOATS + 8));
    expect(Math.max(...list.map((box) => box[2] + box[6]))).toBeGreaterThanOrEqual(coasterRailTopZ(10) - 1);
    expect(Math.min(...list.map((box) => box[2]))).toBeLessThanOrEqual(1);
    for (let a = 0; a < list.length; a += 1) {
      for (let b = a + 1; b < list.length; b += 1) expect(overlaps(list[a], list[b]), `boxes ${a} and ${b}`).toBe(false);
    }
  });
});

describe('Phase 46: element art', () => {
  const OVAL_MOVES = `${'E'.repeat(10)}${'S'.repeat(4)}${'W'.repeat(10)}${'N'.repeat(4)}`;
  const OVAL_HEIGHTS = [0, 0, 0, 1, 2, 3, 3, 3, 3, 3, 2, 1, 0];
  const cases: Array<[string, ReturnType<typeof layoutFromMoves>, number[]]> = [
    ['corkscrew', layoutFromMoves({ x: 2, y: 2 }, OVAL_MOVES, OVAL_HEIGHTS, { 5: 'corkscrew' as never }), [5, 6]],
    ['zero-g-roll', layoutFromMoves({ x: 2, y: 2 }, OVAL_MOVES, OVAL_HEIGHTS, { 5: 'zero-g-roll' as never }), [5, 6]],
    ['airtime-hill', layoutFromMoves({ x: 2, y: 2 }, OVAL_MOVES, OVAL_HEIGHTS, { 5: 'airtime-hill' as never }), [5]],
    ['cobra-roll', layoutFromMoves({ x: 2, y: 2 }, 'EEEEEESWWWWWWN', [0, 0, 0, 1, 2, 2, 2, 2, 1, 0, 0, 0, 0, 0], { 6: 'cobra-roll' as never }), [6, 7]],
  ];
  it.each(cases)('%s: swept track inside its tiles, no two boxes overlapping, within budget', (_kind, layout, indices) => {
    for (const index of indices) {
      const writer = new BoxWriter(64);
      coasterContent.pieceBoxes(layout, index, BUILD_BY_ID.get('titan-hyper')!, palette, 1, writer);
      const list = Array.from({ length: writer.count }, (_unused, box) => writer.data.slice(box * BOX_FLOATS, box * BOX_FLOATS + 8));
      expect(list.length).toBeGreaterThan(20);
      expect(list.length, 'box allowance').toBeLessThanOrEqual(COASTER_PIECE_BOX_ALLOWANCE.element + 12 * COASTER_PIECE_BOX_ALLOWANCE.bentPerLevel);
      const cell = layout[index].cell;
      for (const box of list) {
        expect(box[0]).toBeGreaterThanOrEqual(cell.x * 32);
        expect(box[0] + box[4]).toBeLessThanOrEqual(cell.x * 32 + 32);
        expect(box[1]).toBeGreaterThanOrEqual(cell.y * 32);
        expect(box[1] + box[5]).toBeLessThanOrEqual(cell.y * 32 + 32);
      }
      for (let a = 0; a < list.length; a += 1) {
        for (let b = a + 1; b < list.length; b += 1) expect(overlaps(list[a], list[b]), `piece ${index}: boxes ${a} and ${b}`).toBe(false);
      }
    }
  });
});

describe('Phase 48: swept loop', () => {
  const OVAL_MOVES = `${'E'.repeat(10)}${'S'.repeat(4)}${'W'.repeat(10)}${'N'.repeat(4)}`;
  const OVAL_HEIGHTS = [0, 0, 0, 1, 2, 2, 2, 2, 2, 2, 1, 0];
  const cases: Array<[string, ReturnType<typeof layoutFromMoves>, number]> = [
    ['flat', layoutFromMoves({ x: 2, y: 2 }, OVAL_MOVES, OVAL_HEIGHTS, { 6: 'loop' as never }), 6],
    ['on a climb', layoutFromMoves({ x: 2, y: 2 }, OVAL_MOVES, OVAL_HEIGHTS, { 3: 'loop' as never }), 3],
    ['into a turn', layoutFromMoves({ x: 2, y: 2 }, OVAL_MOVES, OVAL_HEIGHTS, { 9: 'loop' as never }), 9],
  ];
  const piecesOf = (layout: ReturnType<typeof layoutFromMoves>, index: number): Float32Array[] => {
    const writer = new BoxWriter(64);
    coasterContent.pieceBoxes(layout, index, BUILD_BY_ID.get('titan-hyper')!, palette, 1, writer);
    return Array.from({ length: writer.count }, (_unused, box) => writer.data.slice(box * BOX_FLOATS, box * BOX_FLOATS + 8));
  };
  const filledAt = (boxes: readonly Float32Array[], x: number, y: number, z: number): boolean => boxes.some((box) =>
    box[0] <= x && x < box[0] + box[4] && box[1] <= y && y < box[1] + box[5] && box[2] <= z && z < box[2] + box[6]);

  it.each(cases)('%s: in its tile and the next, clear of the next piece, within budget, rails under the cars', (_name, layout, index) => {
    const loop = piecesOf(layout, index);
    const next = piecesOf(layout, index + 1);
    const here = layout[index].cell;
    const there = layout[index + 1].cell;
    expect(loop.length, 'box allowance').toBeLessThanOrEqual(COASTER_PIECE_BOX_ALLOWANCE.plain + COASTER_PIECE_BOX_ALLOWANCE.loop
      + 2 * COASTER_PIECE_BOX_ALLOWANCE.ramp + 4 * COASTER_PIECE_BOX_ALLOWANCE.bentPerLevel + COASTER_PIECE_BOX_ALLOWANCE.chain);
    for (const box of loop) {
      expect(box[0]).toBeGreaterThanOrEqual(Math.min(here.x, there.x) * 32);
      expect(box[0] + box[4]).toBeLessThanOrEqual((Math.max(here.x, there.x) + 1) * 32);
      expect(box[1]).toBeGreaterThanOrEqual(Math.min(here.y, there.y) * 32);
      expect(box[1] + box[5]).toBeLessThanOrEqual((Math.max(here.y, there.y) + 1) * 32);
    }
    for (let a = 0; a < loop.length; a += 1) {
      for (let b = a + 1; b < loop.length; b += 1) expect(overlaps(loop[a], loop[b]), `loop boxes ${a} and ${b}`).toBe(false);
      for (const other of next) expect(overlaps(loop[a], other), `loop box ${a} and the next piece`).toBe(false);
    }
    // Along the loop piece and round its ring, a rail voxel within a voxel of each rail (3 either side along the frame).
    const line = centreLineFor(layout);
    const frame = createCentreLineFrame();
    const start = line.tileStart[index];
    const end = line.tileStart[index + 1];
    let checked = 0;
    for (let distance = start + 2 / 32; distance < end - 2 / 32; distance += 0.5 / 32) {
      sampleCentreLineFrame(line, distance, frame);
      for (const side of [-1, 1]) {
        const x = frame.x * 32 + frame.normalX * side * 3;
        const y = frame.y * 32 + frame.normalY * side * 3;
        const z = coasterRailTopZ(frame.z) + frame.normalZ * side * 3;
        let found = false;
        for (let dx = -1; dx <= 1 && !found; dx += 1) {
          for (let dy = -1; dy <= 1 && !found; dy += 1) {
            for (let dz = -2; dz <= 1 && !found; dz += 1) found = filledAt(loop, Math.floor(x) + dx, Math.floor(y) + dy, Math.floor(z) + dz);
          }
        }
        expect(found, `rail ${side} at arc ${(distance - start).toFixed(3)}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });
});
