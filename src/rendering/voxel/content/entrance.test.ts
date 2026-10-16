import { describe, expect, it } from 'vitest';
import { BUILD_CATALOG } from '../../../game/content/catalog';
import { GUEST_ACCENTS, GUEST_COLORS } from '../../../game/guests/GuestSimulation';
import { compileBlueprint, flattenAtRest, rotateModel } from '../blueprint/compile';
import type { FlatModel } from '../blueprint/compile';
import { LIGHT_PRESET_DUSK, LIGHT_PRESET_NIGHT } from '../contracts/blueprint';
import type { CompiledModel } from '../contracts/blueprint';
import { BOX_FLOATS, BoxWriter, packBoxWord, STATIC_SLOT, unpackBoxWord } from '../contracts/boxes';
import { BOX_BUDGET } from '../contracts/budgets';
import { FIGURE_MAX_HEIGHT } from '../contracts/figures';
import { MAT, MAT_COLOR, PATTERN } from '../contracts/palette';
import type { Palette } from '../contracts/palette';
import { PATH_TOP_Z, projectX, projectY, rotateBoxInFootprint, VOXELS_PER_TILE } from '../contracts/space';
import type { QuarterTurn, SingleTurn } from '../contracts/space';
import { buildPalette } from '../palette';
import {
  ENTRANCE_BLUEPRINT_ID,
  ENTRANCE_LAMP_LIGHT_RADIUS,
  ENTRANCE_LIGHT_PRESETS,
  ENTRANCE_POST_HEIGHT,
  ENTRANCE_POST_MIN_X,
  ENTRANCE_POST_MIN_Y,
  ENTRANCE_POST_SIZE,
  ENTRANCE_TOP_LIMIT,
  ENTRANCE_WALKWAY_CLEAR_Z,
  ENTRANCE_WALKWAY_MAX_X,
  ENTRANCE_WALKWAY_MIN_X,
  entranceBlueprint,
  GLYPH_HEIGHT,
  GLYPH_WIDTH,
  GLYPHS,
  LETTER_PITCH,
  SIGN_FRONT_Y,
  TEXT_MIN_X,
  WELCOME_TEXT,
} from './entrance';
import {
  LITTER_AREA_MAX,
  LITTER_AREA_MIN,
  LITTER_CUP_SIZE,
  LITTER_OUTLINE_GROUP,
  LITTER_PIECE_GAP,
  LITTER_WRAPPER_SIZE,
  litterEmitter,
  SICK_COLOUR,
  litterPieceCount,
  litterScale,
} from './litter';

/**
 * The park gate and the litter piles, checked against the art bible (design §12), the box budgets
 * and the voxel-space contract. The gate is one static part, so "at rest" is all there is to it; the
 * visual judgement lives in the voxel-preview renders, and what can be pinned — sizes, clearances,
 * a visible and upright WELCOME, lamps and their lights, colours, determinism — is pinned here.
 */

const QUARTER_TURNS: readonly SingleTurn[] = [0, 1];
const TILE = VOXELS_PER_TILE;
/** The art bible's walkway rule: nothing solid between the posts below this height. */
const WALKWAY_RULE_Z = 40;
/** Staff wear a cap, two voxels over the tallest guest (art bible). */
const TALLEST_FIGURE = FIGURE_MAX_HEIGHT + 2;
/** Art bible: coaster supports stand 11 voxels off the tile centre, perpendicular to travel, 2×2. */
const COASTER_SUPPORT_OFFSET = 11;
const COASTER_SUPPORT_SIZE = 2;
/** The static world's curbs: one voxel wide, on the tile's outermost ring. */
const CURB_WIDTH = 1;

const gamePalette = (): Palette => buildPalette(BUILD_CATALOG, GUEST_COLORS, GUEST_ACCENTS);

interface Box {
  x: number;
  y: number;
  z: number;
  sizeX: number;
  sizeY: number;
  sizeZ: number;
  word: number;
  slot: number;
}

const boxesOf = (data: Float32Array, count: number, first = 0): Box[] =>
  Array.from({ length: count - first }, (_unused, index) => {
    const at = (first + index) * BOX_FLOATS;
    return {
      x: data[at],
      y: data[at + 1],
      z: data[at + 2],
      word: data[at + 3],
      sizeX: data[at + 4],
      sizeY: data[at + 5],
      sizeZ: data[at + 6],
      slot: data[at + 7],
    };
  });

const voxelKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;

/** Every filled voxel of a flat model → its material. */
const voxelsOf = (flat: FlatModel): Map<string, number> => {
  const voxels = new Map<string, number>();
  for (const box of boxesOf(flat.boxes, flat.boxCount)) {
    const { material } = unpackBoxWord(box.word);
    for (let z = box.z; z < box.z + box.sizeZ; z += 1) {
      for (let y = box.y; y < box.y + box.sizeY; y += 1) {
        for (let x = box.x; x < box.x + box.sizeX; x += 1) voxels.set(voxelKey(x, y, z), material);
      }
    }
  }
  return voxels;
};

const volumeOf = (boxes: Float32Array, count: number): number =>
  boxesOf(boxes, count).reduce((sum, box) => sum + box.sizeX * box.sizeY * box.sizeZ, 0);

const turnedGate = (palette: Palette, quarterTurn: QuarterTurn): CompiledModel =>
  rotateModel(compileBlueprint(entranceBlueprint(palette)), quarterTurn);

/**
 * The first voxel of `voxels` a view ray from `point` toward the camera passes through, or null.
 * The projection's null vector is (1, 1, 1) (contracts/space.ts), so moving toward the camera along
 * a view ray adds the same amount to x, y and z. The ray is cut at every voxel boundary it crosses
 * and each piece tested at its midpoint, so no voxel it clips can be missed.
 */
const firstOccluder = (voxels: ReadonlyMap<string, number>, point: readonly [number, number, number], reach: number): string | null => {
  const crossings = [0, reach];
  point.forEach((start) => {
    for (let boundary = Math.floor(start) + 1; boundary - start < reach; boundary += 1) crossings.push(boundary - start);
  });
  crossings.sort((first, second) => first - second);
  for (let index = 0; index + 1 < crossings.length; index += 1) {
    if (crossings[index + 1] - crossings[index] < 1e-9) continue;
    const along = (crossings[index] + crossings[index + 1]) / 2;
    const key = voxelKey(Math.floor(point[0] + along), Math.floor(point[1] + along), Math.floor(point[2] + along));
    if (voxels.has(key)) return key;
  }
  return null;
};

const inkCount = [...WELCOME_TEXT].reduce(
  (sum, letter) => sum + GLYPHS[letter].join('').split('').filter((cell) => cell === '#').length,
  0,
);

describe('entrance gate', () => {
  const palette = gamePalette();
  const ink = palette.material(MAT_COLOR.INK);

  it('compiles within its box budget and the art bible height at both quarter turns', () => {
    const blueprint = entranceBlueprint(palette);
    expect(blueprint.id, 'one gate, one blueprint id').toBe(ENTRANCE_BLUEPRINT_ID);
    expect(blueprint.footprint, 'the gate stands on the 1×1 entrance path tile').toEqual([1, 1]);
    expect(blueprint.parts.map((part) => part.id), 'a static gate: the body and no moving parts').toEqual(['body']);
    for (const quarterTurn of QUARTER_TURNS) {
      const model = turnedGate(palette, quarterTurn);
      expect(model.boxCount, `q${quarterTurn} has boxes`).toBeGreaterThan(0);
      expect(model.boxCount, `q${quarterTurn} within BOX_BUDGET.entrance`).toBeLessThanOrEqual(BOX_BUDGET.entrance);
      expect(model.top, `q${quarterTurn} top within the art bible's ${ENTRANCE_TOP_LIMIT}`).toBeLessThanOrEqual(ENTRANCE_TOP_LIMIT);
    }
    expect(ENTRANCE_TOP_LIMIT, 'the art bible limit').toBe(64);
  });

  it('stays inside its tile and on the path top at both quarter turns', () => {
    for (const quarterTurn of QUARTER_TURNS) {
      const model = turnedGate(palette, quarterTurn);
      expect(model.footprint, `q${quarterTurn} footprint`).toEqual([1, 1]);
      for (const box of boxesOf(flattenAtRest(model).boxes, model.boxCount)) {
        const where = `q${quarterTurn} box at (${box.x}, ${box.y}, ${box.z})`;
        expect(box.x, `${where}: x ≥ 0`).toBeGreaterThanOrEqual(0);
        expect(box.y, `${where}: y ≥ 0`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.sizeX, `${where}: x within the tile`).toBeLessThanOrEqual(TILE);
        expect(box.y + box.sizeY, `${where}: y within the tile`).toBeLessThanOrEqual(TILE);
        expect(box.z, `${where}: stands on the path top`).toBeGreaterThanOrEqual(PATH_TOP_Z);
        expect(box.slot, `${where}: static`).toBe(STATIC_SLOT);
      }
    }
  });

  it('is deterministic', () => {
    const first = entranceBlueprint(palette);
    const second = entranceBlueprint(gamePalette());
    expect(second, 'same palette content, same blueprint').toEqual(first);
    for (const quarterTurn of QUARTER_TURNS) {
      const a = flattenAtRest(turnedGate(palette, quarterTurn));
      const b = flattenAtRest(turnedGate(palette, quarterTurn));
      expect([...b.boxes], `q${quarterTurn} boxes`).toEqual([...a.boxes]);
    }
  });

  it('has nothing overlapping at rest', () => {
    for (const quarterTurn of QUARTER_TURNS) {
      const model = turnedGate(palette, quarterTurn);
      const partVoxels = model.parts.reduce((sum, part) => sum + volumeOf(part.boxes, part.boxCount), 0);
      expect(voxelsOf(flattenAtRest(model)).size, `q${quarterTurn}: the union of the parts at rest is their sum`).toBe(partVoxels);
    }
  });

  it('builds 6×6×48 posts at the tile edges from the art bible colours', () => {
    expect([ENTRANCE_POST_SIZE, ENTRANCE_POST_HEIGHT], 'art bible post size').toEqual([6, 48]);
    const voxels = voxelsOf(flattenAtRest(turnedGate(palette, 0)));
    const post = palette.material(MAT_COLOR.ENTRANCE_POST);
    for (const postX of ENTRANCE_POST_MIN_X) {
      for (let z = PATH_TOP_Z; z < PATH_TOP_Z + ENTRANCE_POST_HEIGHT; z += 1) {
        for (let y = ENTRANCE_POST_MIN_Y; y < ENTRANCE_POST_MIN_Y + ENTRANCE_POST_SIZE; y += 1) {
          for (let x = postX; x < postX + ENTRANCE_POST_SIZE; x += 1) {
            expect(voxels.get(voxelKey(x, y, z)), `post voxel (${x}, ${y}, ${z})`).toBe(post);
          }
        }
      }
    }
    expect(ENTRANCE_POST_MIN_X[0], 'left post at the west edge').toBeLessThanOrEqual(2);
    expect(TILE - (ENTRANCE_POST_MIN_X[1] + ENTRANCE_POST_SIZE), 'right post at the east edge').toBeLessThanOrEqual(2);

    const expected = new Set([MAT_COLOR.ENTRANCE_POST, MAT_COLOR.SIGN, MAT_COLOR.ARCH_PINK, MAT_COLOR.INK, MAT_COLOR.LAMP_GLOW]);
    const used = new Set([...voxels.values()]);
    for (const material of used) {
      expect(expected.has(palette.baseColor(material)), `material ${material} is an art bible colour`).toBe(true);
      if (material !== MAT.LAMP_GLOW) expect(palette.flags(material), `material ${material} is plain`).toBe(0);
    }
    const shown = [...new Set([...used].map((material) => palette.baseColor(material)))].sort((a, b) => a - b);
    expect(shown, 'every gate colour shows').toEqual([...expected].sort((a, b) => a - b));
  });

  it('keeps the walkway clear below z 40 at both quarter turns', () => {
    expect(ENTRANCE_WALKWAY_CLEAR_Z, 'the art bible rule').toBeGreaterThanOrEqual(WALKWAY_RULE_Z);
    expect(ENTRANCE_WALKWAY_CLEAR_Z, 'every figure walks under the sign').toBeGreaterThan(PATH_TOP_Z + TALLEST_FIGURE);
    // Guests walk along the tile's centre line; the walkway must hold them with room to pass.
    expect(ENTRANCE_WALKWAY_MIN_X, 'walkway reaches past the centre line').toBeLessThanOrEqual(TILE / 2 - 4);
    expect(ENTRANCE_WALKWAY_MAX_X, 'walkway reaches past the centre line').toBeGreaterThanOrEqual(TILE / 2 + 4);
    for (const quarterTurn of QUARTER_TURNS) {
      const walkway = rotateBoxInFootprint(
        ENTRANCE_WALKWAY_MIN_X, 0, ENTRANCE_WALKWAY_MAX_X - ENTRANCE_WALKWAY_MIN_X, TILE, quarterTurn, TILE,
      );
      const model = turnedGate(palette, quarterTurn);
      for (const box of boxesOf(flattenAtRest(model).boxes, model.boxCount)) {
        const intersects = box.x < walkway.minX + walkway.sizeX && walkway.minX < box.x + box.sizeX
          && box.y < walkway.minY + walkway.sizeY && walkway.minY < box.y + box.sizeY;
        if (!intersects) continue;
        expect(box.z, `q${quarterTurn}: box at (${box.x}, ${box.y}, ${box.z}) over the walkway`).toBeGreaterThanOrEqual(WALKWAY_RULE_Z);
      }
    }
  });

  it('shows every letter of WELCOME on a face the camera sees, at both quarter turns', () => {
    for (const quarterTurn of QUARTER_TURNS) {
      const voxels = voxelsOf(flattenAtRest(turnedGate(palette, quarterTurn)));
      // The front is model +y: world +y at quarter turn 0, world +x at quarter turn 1.
      const normal: readonly [number, number, number] = quarterTurn === 0 ? [0, 1, 0] : [1, 0, 0];
      const inked = [...voxels].filter(([, material]) => material === ink).map(([key]) => key.split(',').map(Number));
      expect(inked.length, `q${quarterTurn}: every inked glyph cell is a voxel`).toBe(inkCount);
      for (const [x, y, z] of inked) {
        const front = voxelKey(x + normal[0], y + normal[1], z + normal[2]);
        expect(voxels.has(front), `q${quarterTurn}: ink (${x}, ${y}, ${z}) faces open air`).toBe(false);
        // A point on the front face, off its centre lines, so the ray never grazes a voxel edge.
        const facePoint: readonly [number, number, number] = quarterTurn === 0
          ? [x + 0.51, y + 1, z + 0.53]
          : [x + 1, y + 0.52, z + 0.53];
        expect(firstOccluder(voxels, facePoint, 4 * TILE), `q${quarterTurn}: nothing hides ink (${x}, ${y}, ${z})`).toBeNull();
      }
    }
  });

  it('reads WELCOME left to right on screen at both quarter turns', () => {
    for (const quarterTurn of QUARTER_TURNS) {
      const voxels = voxelsOf(flattenAtRest(turnedGate(palette, quarterTurn)));
      const columns: number[][] = [...WELCOME_TEXT].map(() => []);
      for (const [key, material] of voxels) {
        if (material !== ink) continue;
        const [x, y] = key.split(',').map(Number);
        // Undo the turn to find the letter: q1 put model x at world y = 31 − x (space.ts).
        const modelX = quarterTurn === 0 ? x : TILE - 1 - y;
        const letter = Math.floor((modelX - TEXT_MIN_X) / LETTER_PITCH);
        // Texel column of the visible face's centre (+y face at q0, +x face at q1).
        const texelX = quarterTurn === 0 ? Math.floor(projectX(x + 0.5, y + 1)) : Math.floor(projectX(x + 1, y + 0.5));
        columns[letter].push(texelX);
      }
      const centres = columns.map((texels) => texels.reduce((sum, texel) => sum + texel, 0) / texels.length);
      for (let letter = 1; letter < centres.length; letter += 1) {
        expect(centres[letter], `q${quarterTurn}: ${WELCOME_TEXT[letter]} right of ${WELCOME_TEXT[letter - 1]}`).toBeGreaterThan(centres[letter - 1]);
      }
    }
  });

  it('lands every letter upright on screen at quarter turn 0, the turn the gate is drawn at', () => {
    const voxels = voxelsOf(flattenAtRest(turnedGate(palette, 0)));
    const texels = [...WELCOME_TEXT].map(() => new Set<string>());
    for (const [key, material] of voxels) {
      if (material !== ink) continue;
      const [x, y, z] = key.split(',').map(Number);
      expect(y, 'the lettering is the sign front layer').toBe(SIGN_FRONT_Y - 1);
      // The texel whose centre ray hits this voxel's front face: invert projectX/projectY on the
      // face plane y = SIGN_FRONT_Y and check it lands back in the voxel.
      const texelX = x - SIGN_FRONT_Y;
      const texelY = Math.floor(projectY(x + 0.5, SIGN_FRONT_Y, z + 0.5));
      const hitX = texelX + 0.5 + SIGN_FRONT_Y;
      const hitZ = (hitX + SIGN_FRONT_Y) / 2 - (texelY + 0.5);
      expect([Math.floor(hitX), Math.floor(hitZ)], `texel (${texelX}, ${texelY}) shows voxel (${x}, ${z})`).toEqual([x, z]);
      const letter = Math.floor((x - TEXT_MIN_X) / LETTER_PITCH);
      texels[letter].add(`${texelX},${texelY}`);
    }
    [...WELCOME_TEXT].forEach((letter, index) => {
      const letterTexelX = TEXT_MIN_X + index * LETTER_PITCH - SIGN_FRONT_Y;
      const rows = [...texels[index]].map((texel) => Number(texel.split(',')[1]));
      const letterTop = Math.min(...rows);
      const bitmap = Array.from({ length: GLYPH_HEIGHT }, (_unused, row) =>
        Array.from({ length: GLYPH_WIDTH }, (_unusedColumn, column) =>
          (texels[index].has(`${letterTexelX + column},${letterTop + row}`) ? '#' : '.')).join(''));
      expect(bitmap, `${letter} (letter ${index}) is its upright glyph on screen`).toEqual(GLYPHS[letter]);
      expect(Math.max(...rows) - letterTop, `${letter} is ${GLYPH_HEIGHT} texels tall`).toBe(GLYPH_HEIGHT - 1);
    });
  });

  it('lights its two lanterns at dusk and night with the art bible lamp radius', () => {
    for (const quarterTurn of QUARTER_TURNS) {
      const model = turnedGate(palette, quarterTurn);
      const voxels = voxelsOf(flattenAtRest(model));
      expect(model.lights.length, `q${quarterTurn}: a light per lantern`).toBe(ENTRANCE_POST_MIN_X.length);
      for (const light of model.lights) {
        const [x, y, z] = light.position;
        expect(light.radius, 'art bible lamp light radius').toBe(64);
        expect(light.radius, 'the exported lamp radius').toBe(ENTRANCE_LAMP_LIGHT_RADIUS);
        expect(light.presets, 'on at dusk and night only').toBe(LIGHT_PRESET_DUSK | LIGHT_PRESET_NIGHT);
        expect(light.presets, 'the exported presets').toBe(ENTRANCE_LIGHT_PRESETS);
        expect(light.color, 'lamp colour').toBe(MAT_COLOR.LAMP_GLOW);
        expect(voxels.get(voxelKey(Math.floor(x), Math.floor(y), Math.floor(z))), `q${quarterTurn}: light (${x}, ${y}, ${z}) sits in a glowing core`)
          .toBe(MAT.LAMP_GLOW);
      }
    }
  });
});

/** Emits one pile into a fresh writer and returns its boxes. */
const pile = (palette: Palette, cellX: number, cellY: number, units: number): Box[] => {
  const out = new BoxWriter(4);
  litterEmitter(cellX, cellY, units, palette, out);
  return boxesOf(out.data, out.count);
};

/** Voxels between two boxes on the ground plane (negative when they overlap). */
const groundGap = (first: Box, second: Box): number => Math.max(
  second.x - (first.x + first.sizeX),
  first.x - (second.x + second.sizeX),
  second.y - (first.y + first.sizeY),
  first.y - (second.y + second.sizeY),
);

describe('litter emitter', () => {
  const palette = gamePalette();
  const MAP_SIZE = 32;

  it('Phase 29: lays a sick puddle in the middle of a sick pile, which every piece keeps its gap from', () => {
    const sickWord = packBoxWord(palette.material(SICK_COLOUR), LITTER_OUTLINE_GROUP, PATTERN.PLAIN, 0);
    for (const [cellX, cellY] of [[0, 0], [15, 30], [7, 21], [31, 31]]) {
      for (const units of [1, 3, 9, 40]) {
        const out = new BoxWriter(4);
        litterEmitter(cellX, cellY, units, palette, out, true);
        const boxes = boxesOf(out.data, out.count);
        const puddle = boxes.filter((box) => box.word === sickWord);
        const pieces = boxes.filter((box) => box.word !== sickWord);
        expect(puddle.length, `cell (${cellX}, ${cellY}) x${units}: two flat patches`).toBe(2);
        for (const box of puddle) {
          expect([box.z, box.sizeZ], 'flat on the path').toEqual([PATH_TOP_Z, 1]);
          expect(box.x - cellX * TILE).toBeGreaterThanOrEqual(LITTER_AREA_MIN);
          expect(box.y + box.sizeY - cellY * TILE).toBeLessThanOrEqual(LITTER_AREA_MAX);
        }
        expect(pieces.length, 'most pieces still find room').toBeGreaterThanOrEqual(Math.min(litterPieceCount(units), 6));
        for (const piece of pieces) {
          for (const patch of puddle) expect(groundGap(piece, patch), 'no piece lies in the puddle').toBeGreaterThanOrEqual(LITTER_PIECE_GAP);
        }
      }
    }
    expect(pile(palette, 7, 21, 9), 'a pile that is not sick is drawn as before').toEqual((() => {
      const out = new BoxWriter(4);
      litterEmitter(7, 21, 9, palette, out, false);
      return boxesOf(out.data, out.count);
    })());
  });

  it('grows along the legacy pile scale, two pieces at one unit up to eight', () => {
    expect(litterScale(1), 'legacy 0.8 + 0.09 · units').toBeCloseTo(0.89, 10);
    expect(litterScale(100), 'legacy scale stops growing at 1.6').toBeCloseTo(1.6, 10);
    expect(litterPieceCount(0), 'an empty pile shows nothing').toBe(0);
    expect(litterPieceCount(1), 'a wrapper and a cup, like the legacy art').toBe(2);
    expect(litterPieceCount(300), 'four times the base area at full scale').toBe(8);
    for (let units = 1; units < 20; units += 1) {
      expect(litterPieceCount(units + 1), `no fewer pieces at ${units + 1} units`).toBeGreaterThanOrEqual(litterPieceCount(units));
    }
    expect(pile(palette, 4, 4, 0), 'nothing for zero units').toEqual([]);
  });

  it('is deterministic and keeps every piece in place as the pile grows', () => {
    for (const [cellX, cellY] of [[0, 0], [15, 30], [7, 21], [31, 31]]) {
      expect(pile(palette, cellX, cellY, 6), `cell (${cellX}, ${cellY}) twice`).toEqual(pile(palette, cellX, cellY, 6));
      for (let units = 1; units < 12; units += 1) {
        const smaller = pile(palette, cellX, cellY, units);
        const larger = pile(palette, cellX, cellY, units + 1);
        expect(larger.slice(0, smaller.length), `cell (${cellX}, ${cellY}): ${units} units is a prefix of ${units + 1}`).toEqual(smaller);
      }
    }
  });

  it('appends to the writer without touching what it already holds', () => {
    const out = new BoxWriter(1);
    out.push(1, 2, 3, 4, 5, 6, 7);
    litterEmitter(3, 5, 9, palette, out);
    expect(out.count, 'the old box and the pile').toBe(1 + litterPieceCount(9));
    expect(boxesOf(out.data, 1)[0], 'the old box').toEqual({ x: 1, y: 2, z: 3, sizeX: 4, sizeY: 5, sizeZ: 6, word: 7, slot: 0 });
    expect(boxesOf(out.data, out.count, 1), 'the same pile as in a fresh writer').toEqual(pile(palette, 3, 5, 9));
  });

  it('lays whole cups and wrappers flat on the path top, inside the litter square, never touching', () => {
    const cupWord = packBoxWord(palette.material(MAT_COLOR.LITTER_CUP), LITTER_OUTLINE_GROUP, PATTERN.PLAIN, 0);
    const wrapperWord = packBoxWord(palette.material(MAT_COLOR.LITTER_WRAPPER), LITTER_OUTLINE_GROUP, PATTERN.PLAIN, 0);
    expect(palette.baseColor(unpackBoxWord(cupWord).material), 'cup colour').toBe(MAT_COLOR.LITTER_CUP);
    expect(palette.baseColor(unpackBoxWord(wrapperWord).material), 'wrapper colour').toBe(MAT_COLOR.LITTER_WRAPPER);
    expect([...LITTER_CUP_SIZE], 'art bible cup').toEqual([2, 2, 3]);
    expect([...LITTER_WRAPPER_SIZE], 'art bible wrapper').toEqual([3, 3, 1]);
    expect(LITTER_PIECE_GAP, 'pieces never touch, so two never read as one blob').toBeGreaterThanOrEqual(1);
    for (let cellY = 0; cellY < MAP_SIZE; cellY += 1) {
      for (let cellX = 0; cellX < MAP_SIZE; cellX += 1) {
        const boxes = pile(palette, cellX, cellY, 40);
        expect(boxes.length, `cell (${cellX}, ${cellY}): every piece of a full pile finds room`).toBe(litterPieceCount(40));
        boxes.forEach((box, index) => {
          const where = `cell (${cellX}, ${cellY}) piece ${index}`;
          const cup = box.word === cupWord;
          expect(cup || box.word === wrapperWord, `${where}: a plain cup or wrapper in the litter group`).toBe(true);
          expect([box.sizeX, box.sizeY, box.sizeZ], `${where}: whole piece`).toEqual([...(cup ? LITTER_CUP_SIZE : LITTER_WRAPPER_SIZE)]);
          expect(box.z, `${where}: on the path top`).toBe(PATH_TOP_Z);
          expect(box.slot, `${where}: static layout`).toBe(STATIC_SLOT);
          expect(box.x - cellX * TILE, `${where}: x in the square`).toBeGreaterThanOrEqual(LITTER_AREA_MIN);
          expect(box.y - cellY * TILE, `${where}: y in the square`).toBeGreaterThanOrEqual(LITTER_AREA_MIN);
          expect(box.x + box.sizeX - cellX * TILE, `${where}: x in the square`).toBeLessThanOrEqual(LITTER_AREA_MAX);
          expect(box.y + box.sizeY - cellY * TILE, `${where}: y in the square`).toBeLessThanOrEqual(LITTER_AREA_MAX);
          for (const other of boxes.slice(index + 1)) {
            expect(groundGap(box, other), `${where}: keeps a gap to the next pieces`).toBeGreaterThanOrEqual(LITTER_PIECE_GAP);
          }
        });
      }
    }
  });

  it('shows a cup and a wrapper in the smallest pile and scatters differently per cell', () => {
    const arrangements = new Set<string>();
    for (let cellY = 0; cellY < MAP_SIZE; cellY += 4) {
      for (let cellX = 0; cellX < MAP_SIZE; cellX += 4) {
        const boxes = pile(palette, cellX, cellY, 1);
        expect(boxes.map((box) => box.sizeZ).sort(), `cell (${cellX}, ${cellY}): a wrapper and a cup`).toEqual([1, 3]);
        arrangements.add(pile(palette, cellX, cellY, 9).map((box) => `${box.x - cellX * TILE},${box.y - cellY * TILE},${box.sizeZ}`).join(' '));
      }
    }
    expect(arrangements.size, 'every sampled cell scatters its own way').toBe((MAP_SIZE / 4) ** 2);
  });

  it('keeps its square clear of curbs, coaster supports and the entrance gate', () => {
    expect(LITTER_AREA_MIN, 'inside the curb ring').toBeGreaterThanOrEqual(CURB_WIDTH);
    expect(LITTER_AREA_MAX, 'inside the curb ring').toBeLessThanOrEqual(TILE - CURB_WIDTH);
    expect(LITTER_AREA_MIN, 'clear of the support 11 voxels before the centre')
      .toBeGreaterThanOrEqual(TILE / 2 - COASTER_SUPPORT_OFFSET + COASTER_SUPPORT_SIZE / 2);
    expect(LITTER_AREA_MAX, 'clear of the support 11 voxels past the centre')
      .toBeLessThanOrEqual(TILE / 2 + COASTER_SUPPORT_OFFSET - COASTER_SUPPORT_SIZE / 2);
    const tallest = PATH_TOP_Z + Math.max(LITTER_CUP_SIZE[2], LITTER_WRAPPER_SIZE[2]);
    const gate = flattenAtRest(turnedGate(palette, 0));
    for (const box of boxesOf(gate.boxes, gate.boxCount)) {
      const overSquare = box.x < LITTER_AREA_MAX && LITTER_AREA_MIN < box.x + box.sizeX
        && box.y < LITTER_AREA_MAX && LITTER_AREA_MIN < box.y + box.sizeY;
      if (overSquare) expect(box.z, `gate box at (${box.x}, ${box.y}, ${box.z}) clears the litter`).toBeGreaterThanOrEqual(tallest);
    }
  });
});
