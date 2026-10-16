import { BIOME_BY_ID, isBiomeId } from '../biomes/content';
import type { BiomeDefinition, BiomeId, PropLegendChar } from '../biomes/types';
import { GAME_CONFIG } from '../config';
import { hashString } from '../save/hash';
import { MAXIMUM_SAVED_COUNTER } from '../save/ranges';
import { SaveError } from '../save/version';
import { hash32 } from '../weather/random';
import { isLegalMapSize, legalMapSizeText } from '../land/parcels';
import type { Rotation } from '../types';
import { MAP_BY_ID } from './content';
import { PROP_KIND_BY_ID, isPropKindId, type PropKindDefinition } from './props';
import { generatedMapId, generatedMapName, readRecipe } from './recipe';
import {
  GROUND_ALT,
  GROUND_BASE,
  GROUND_WATER,
  MapFormatError,
  type Facing,
  type MapDefinition,
  type MapEntrance,
  type MapLayout,
  type MapProblem,
  type MapRecipe,
  type MapState,
  type PropPlacement,
} from './types';

/**
 * ASCII map parsing and the runtime layout (Phase 24).
 *
 * | char       | meaning                                                                                |
 * | `.`        | base ground, open                                                                      |
 * | `,`        | alt ground, open (buildable)                                                           |
 * | `~`        | water (never buildable, never clearable)                                               |
 * | `E`        | the gate (a path tile on base ground); facing derived from the border it is on         |
 * | `T t b R s`| 1x1 prop kinds per the biome legend (base ground under them)                           |
 * | `L`        | a 2x1 prop (two adjacent `L`; a horizontal pair = rotation 0, a vertical pair = 1)       |
 * | `#`        | a 1x1 permanent prop (canyon wall, stone wall)                                          |
 * | `X`        | a 2x2 permanent prop (four `X` in a square; anchor = top-left)                          |
 *
 * Prop ids are 1, 2, 3, ... in row-major order of the ANCHOR cell (top-left for 2x2, the first cell of an
 * `L` pair in row-major order). Rotation of a 1x1 prop is `hash32(seed, x, y) & 3` (it only varies the look),
 * a log is 0 (along x) or 1 (along y), a 2x2 prop is 0.
 */

const GROUND_CHARS = '.,~';
const PROP_CHARS = 'TtbRsL#X';
const MAP_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export const isMapIdShape = (value: unknown): value is string => typeof value === 'string' && MAP_ID_PATTERN.test(value);

/** The inward direction of the border cell (x, y) lies on; null for a corner or a cell that is not on a border. */
export const facingOfBorder = (x: number, y: number, width: number, height: number): Facing | null => {
  const onX = x === 0 || x === width - 1;
  const onY = y === 0 || y === height - 1;
  if (onX === onY) return null;
  if (onY) return y === height - 1 ? 'north' : 'south';
  return x === 0 ? 'east' : 'west';
};

/** The prop's footprint size after rotation (quarter turns swap width and depth). */
export const propFootprintSize = (definition: PropKindDefinition, rotation: Rotation): readonly [number, number] => (
  rotation % 2 === 0 ? definition.footprint : [definition.footprint[1], definition.footprint[0]]
);

export const groundRowsOf = (ground: Uint8Array, width: number, height: number): string[] => {
  const rows: string[] = [];
  for (let y = 0; y < height; y += 1) {
    let row = '';
    for (let x = 0; x < width; x += 1) row += GROUND_CHARS[ground[y * width + x]] ?? '.';
    rows.push(row);
  }
  return rows;
};

export const groundKeyOf = (id: string, biomeId: BiomeId, rows: readonly string[]): string => (
  `${id}|${biomeId}|${hashString(rows.join('/'))}`
);

export interface ParsedMap {
  readonly ground: Uint8Array;
  readonly props: PropPlacement[];
  readonly entrance: MapEntrance | null;
  readonly problems: MapProblem[];
}

/** Parses the ASCII rows. Never throws: every defect is a MapProblem (the caller decides what is fatal). */
export const parseMapRows = (
  rows: readonly string[],
  width: number,
  height: number,
  biome: BiomeDefinition,
  seed: number,
  explicitGround?: readonly string[],
): ParsedMap => {
  const problems: MapProblem[] = [];
  const problem = (code: MapProblem['code'], x: number | null, y: number | null, detail: string): void => {
    problems.push({ code, at: x === null || y === null ? null : { x, y }, detail });
  };
  const ground = new Uint8Array(Math.max(0, width * height));
  const props: PropPlacement[] = [];
  let entrance: MapEntrance | null = null;
  const entrances: Array<{ x: number; y: number }> = [];

  const wellShaped = Array.isArray(rows) && rows.length === height && rows.every((row) => typeof row === 'string' && row.length === width);
  if (!wellShaped) {
    problem('rows', null, null, `needs exactly ${height} rows of ${width} characters`);
    return { ground, props, entrance, problems };
  }
  const cell = (x: number, y: number): string => (x >= 0 && y >= 0 && x < width && y < height ? rows[y][x] : '');
  const consumed = new Uint8Array(width * height);
  let nextId = 1;
  const addProp = (char: string, x: number, y: number, rotation: Rotation): void => {
    const kindId = biome.legend[char as PropLegendChar];
    const kind = kindId ? PROP_KIND_BY_ID.get(kindId) : undefined;
    if (!kind) {
      problem('legend', x, y, `'${char}' has no prop in the ${biome.name} legend`);
      return;
    }
    props.push({ id: nextId, kind: kind.id, x, y, rotation });
    nextId += 1;
  };

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (consumed[y * width + x]) continue;
      const char = rows[y][x];
      const groundIndex = GROUND_CHARS.indexOf(char);
      if (groundIndex >= 0) {
        ground[y * width + x] = groundIndex === 0 ? GROUND_BASE : groundIndex === 1 ? GROUND_ALT : GROUND_WATER;
        continue;
      }
      if (char === 'E') {
        entrances.push({ x, y });
        continue;
      }
      if (!PROP_CHARS.includes(char)) {
        problem('char', x, y, `'${char}' is not a map character`);
        continue;
      }
      consumed[y * width + x] = 1;
      if (char === 'X') {
        const square: Array<[number, number]> = [[x + 1, y], [x, y + 1], [x + 1, y + 1]];
        if (!square.every(([cx, cy]) => cell(cx, cy) === 'X' && !consumed[cy * width + cx])) {
          problem('block-shape', x, y, 'X must be a 2x2 square');
          continue;
        }
        for (const [cx, cy] of square) consumed[cy * width + cx] = 1;
        addProp('X', x, y, 0);
      } else if (char === 'L') {
        if (cell(x + 1, y) === 'L' && !consumed[y * width + x + 1]) {
          consumed[y * width + x + 1] = 1;
          addProp('L', x, y, 0);
        } else if (cell(x, y + 1) === 'L' && !consumed[(y + 1) * width + x]) {
          consumed[(y + 1) * width + x] = 1;
          addProp('L', x, y, 1);
        } else {
          problem('block-shape', x, y, 'L must be a pair of adjacent L');
        }
      } else {
        addProp(char, x, y, (hash32(seed, x, y) & 3) as Rotation);
      }
    }
  }
  // A kind must fit its character: 1x1 chars name 1x1 kinds, L a 2x1, X a 2x2.
  for (const prop of props) {
    const kind = PROP_KIND_BY_ID.get(prop.kind);
    if (!kind) continue;
    const char = Object.entries(biome.legend).find(([, id]) => id === prop.kind)?.[0];
    const expected = char === 'L' ? '2x1' : char === 'X' ? '2x2' : '1x1';
    if (`${kind.footprint[0]}x${kind.footprint[1]}` !== expected) {
      problem('legend', prop.x, prop.y, `'${char ?? '?'}' needs a ${expected} prop but '${kind.id}' is ${kind.footprint[0]}x${kind.footprint[1]}`);
    }
  }

  // Ground under props, and the optional explicit ground rows (a wrong shape or a disagreement is a 'ground' problem).
  const groundShaped = explicitGround === undefined || (Array.isArray(explicitGround)
    && explicitGround.length === height
    && explicitGround.every((row) => typeof row === 'string' && row.length === width && [...row].every((char) => GROUND_CHARS.includes(char))));
  if (!groundShaped) problem('ground', null, null, `needs exactly ${height} rows of ${width} characters from ${GROUND_CHARS}`);
  const groundOf = (x: number, y: number): number => {
    const index = GROUND_CHARS.indexOf((explicitGround as readonly string[])[y][x]);
    return index === 0 ? GROUND_BASE : index === 1 ? GROUND_ALT : GROUND_WATER;
  };
  const footprintCells = (prop: PropPlacement): Array<[number, number]> => {
    const kind = PROP_KIND_BY_ID.get(prop.kind) as PropKindDefinition;
    const [w, d] = propFootprintSize(kind, prop.rotation);
    const cells: Array<[number, number]> = [];
    for (let dy = 0; dy < d; dy += 1) for (let dx = 0; dx < w; dx += 1) cells.push([prop.x + dx, prop.y + dy]);
    return cells;
  };
  const propCell = new Uint8Array(width * height);
  for (const prop of props) {
    const kind = PROP_KIND_BY_ID.get(prop.kind);
    if (!kind) continue;
    for (const [cx, cy] of footprintCells(prop)) {
      propCell[cy * width + cx] = 1;
      const under = explicitGround !== undefined && groundShaped ? groundOf(cx, cy) : kind.surface === 'water' ? GROUND_WATER : GROUND_BASE;
      ground[cy * width + cx] = under;
      if ((under === GROUND_WATER) !== (kind.surface === 'water')) {
        problem('surface', cx, cy, `${kind.id} is a ${kind.surface} prop but stands on ${under === GROUND_WATER ? 'water' : 'land'}`);
      }
    }
  }
  if (explicitGround !== undefined && groundShaped) {
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        if (propCell[y * width + x]) continue;
        const wanted = rows[y][x] === 'E' ? GROUND_BASE : ground[y * width + x];
        if (groundOf(x, y) !== wanted) problem('ground', x, y, 'ground disagrees with rows at a cell without a prop');
      }
    }
  }

  if (entrances.length !== 1) {
    problem('entrance-count', entrances[1]?.x ?? null, entrances[1]?.y ?? null, `needs exactly one E, found ${entrances.length}`);
  } else {
    const { x, y } = entrances[0];
    const onBorder = x === 0 || y === 0 || x === width - 1 || y === height - 1;
    const facing = facingOfBorder(x, y, width, height);
    if (!onBorder) problem('entrance-border', x, y, 'E must be on the border of the map');
    else if (facing === null) problem('entrance-corner', x, y, 'E must not be on a corner');
    else entrance = { x, y, facing };
  }
  return { ground, props, entrance, problems };
};

const freezeStarting = (starting: MapDefinition['startingObjects']): MapDefinition['startingObjects'] => ({
  paths: starting.paths.map((cell) => ({ x: cell.x, y: cell.y })),
  objects: starting.objects.map((object) => ({
    definitionId: object.definitionId,
    anchor: { x: object.anchor.x, y: object.anchor.y },
    ...(object.rotation === undefined ? {} : { rotation: object.rotation }),
  })),
});

/** Builds the runtime layout of an authored map. Throws MapFormatError listing every format problem. */
export const layoutOfMap = (definition: MapDefinition, recipe: MapRecipe | null = null): MapLayout => {
  const biome = BIOME_BY_ID.get(definition.biome);
  const problems: string[] = [];
  if (!biome) problems.push(`unknown biome '${String(definition.biome)}'`);
  if (!isMapIdShape(definition.id)) problems.push('id must match [a-z0-9-]{1,64}');
  if (!biome || problems.length > 0) throw new MapFormatError(String(definition.id), problems);
  const parsed = parseMapRows(definition.rows, definition.width, definition.height, biome, definition.seed, definition.ground);
  for (const found of parsed.problems) {
    problems.push(`${found.code}${found.at ? ` at ${found.at.x},${found.at.y}` : ''}: ${found.detail}`);
  }
  if (problems.length > 0 || parsed.entrance === null) throw new MapFormatError(definition.id, problems);
  const rows = groundRowsOf(parsed.ground, definition.width, definition.height);
  return Object.freeze({
    id: definition.id,
    name: definition.name,
    biome,
    width: definition.width,
    height: definition.height,
    entrance: Object.freeze({ ...parsed.entrance }),
    ground: parsed.ground,
    groundKey: groundKeyOf(definition.id, biome.id, rows),
    props: Object.freeze(parsed.props.map((prop) => Object.freeze({ ...prop }))),
    startingObjects: freezeStarting(definition.startingObjects),
    seed: definition.seed,
    recipe: recipe === null || Object.isFrozen(recipe) ? recipe : Object.freeze({ ...recipe }),
    ...(definition.ownedArea === null ? {} : { ownedArea: Object.freeze({ ...definition.ownedArea }) }),
  });
};

const OWNER = 'ParkSession';
const refuse = (path: string, problem: string): never => {
  throw new SaveError('invalid-state', `${OWNER} cannot restore: map${path === '' ? '' : `.${path}`} ${problem}`);
};
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);
const isInt = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value);

/** The validated, plain prop list of a saved map (a hostile list is refused before anything is iterated). */
const readProps = (value: unknown, biome: BiomeDefinition, width: number, height: number, water: (x: number, y: number) => boolean, entrance: MapEntrance): PropPlacement[] => {
  if (!Array.isArray(value)) return refuse('props', 'is not an array');
  // The length is checked BEFORE the walk: a million-element array is refused without touching it.
  if (value.length > GAME_CONFIG.maps.maxSavedProps) {
    return refuse('props', `has ${value.length} entries, above the ${GAME_CONFIG.maps.maxSavedProps} cap`);
  }
  const claimed = new Set<number>();
  const props: PropPlacement[] = [];
  let previous = 0;
  value.forEach((raw: unknown, index) => {
    const path = `props[${index}]`;
    if (!isRecord(raw)) return refuse(path, 'is not an object');
    const { id, kind, x, y, rotation } = raw;
    if (!isInt(id) || id < 1 || id > MAXIMUM_SAVED_COUNTER) return refuse(`${path}.id`, `must be an integer in 1..${MAXIMUM_SAVED_COUNTER}`);
    if (id <= previous) refuse(`${path}.id`, 'is not strictly ascending');
    previous = id;
    if (typeof kind !== 'string') return refuse(`${path}.kind`, 'is not a string');
    if (!isPropKindId(kind)) {
      throw new SaveError('content-mismatch', `This save uses the map prop '${kind}', which this version of the game does not have.`);
    }
    const definition = PROP_KIND_BY_ID.get(kind) as PropKindDefinition;
    if (definition.biome !== biome.id) refuse(`${path}.kind`, `'${kind}' does not belong to the ${biome.id} biome`);
    if (!isInt(x) || !isInt(y)) return refuse(path, 'has no integer anchor');
    if (rotation !== 0 && rotation !== 1 && rotation !== 2 && rotation !== 3) return refuse(`${path}.rotation`, 'must be 0, 1, 2 or 3');
    const [w, d] = propFootprintSize(definition, rotation);
    if (x < 0 || y < 0 || x + w > width || y + d > height) return refuse(path, 'has a footprint outside the map');
    for (let dy = 0; dy < d; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) {
        const cx = x + dx;
        const cy = y + dy;
        if (water(cx, cy) !== (definition.surface === 'water')) {
          refuse(path, definition.surface === 'water' ? `is a water prop but stands on land at ${cx},${cy}` : `stands on water at ${cx},${cy}`);
        }
        if (cx === entrance.x && cy === entrance.y) refuse(path, 'stands on the entrance');
        const key = cy * width + cx;
        if (claimed.has(key)) refuse(path, `overlaps another prop at ${cx},${cy}`);
        claimed.add(key);
      }
    }
    props.push({ id, kind, x, y, rotation });
  });
  return props;
};

/**
 * Builds the layout of a SAVED map and validates it completely first (pure; nothing is allocated that
 * outlives a refusal). Policy: a missing or non-object map, a malformed id, a size that is not whole parcels in the land bounds, ground rows
 * of the wrong shape, an entrance off the border or facing the wrong way or on water, a prop of another biome,
 * out of the map, overlapping, on water or on the entrance, bad ids or rotation -> `invalid-state`; an unknown biome
 * or prop kind -> `content-mismatch` (like an unknown scenario). An unknown but well-formed id is fine: the layout is
 * in the save, and the UI says 'Custom map'.
 */
export const layoutFromState = (state: MapState): MapLayout => {
  if (!isRecord(state)) return refuse('', 'is missing or not an object');
  const { id, biomeId, width, height } = state as Record<string, unknown>;
  if (!isMapIdShape(id)) return refuse('id', 'must match [a-z0-9-]{1,64}');
  if (typeof biomeId !== 'string') return refuse('biomeId', 'is not a string');
  if (!isBiomeId(biomeId)) {
    throw new SaveError('content-mismatch', `This save was played on the biome '${biomeId}', which this version of the game does not have.`);
  }
  const biome = BIOME_BY_ID.get(biomeId) as BiomeDefinition;
  if (!isInt(width) || !isInt(height) || !isLegalMapSize(width, height)) {
    return refuse('width', `and height must be ${legalMapSizeText()}`);
  }
  const rows: unknown = state.ground;
  if (!Array.isArray(rows) || rows.length !== height) return refuse('ground', `must be ${height} rows`);
  const ground = new Uint8Array(width * height);
  const groundRows: string[] = [];
  rows.forEach((row: unknown, y) => {
    if (typeof row !== 'string' || row.length !== width) return refuse(`ground[${y}]`, `must be a string of ${width} characters`);
    for (let x = 0; x < width; x += 1) {
      const index = GROUND_CHARS.indexOf(row[x]);
      if (index < 0) return refuse(`ground[${y}]`, `has the character '${row[x]}', which is not one of ${GROUND_CHARS}`);
      ground[y * width + x] = index === 0 ? GROUND_BASE : index === 1 ? GROUND_ALT : GROUND_WATER;
    }
    groundRows.push(row);
  });
  const rawEntrance: unknown = state.entrance;
  if (!isRecord(rawEntrance) || !isInt(rawEntrance.x) || !isInt(rawEntrance.y)) return refuse('entrance', 'is not an integer cell');
  const { x: ex, y: ey, facing } = rawEntrance;
  if (ex < 0 || ey < 0 || ex >= width || ey >= height) return refuse('entrance', 'is outside the map');
  const expected = facingOfBorder(ex, ey, width, height);
  if (expected === null) return refuse('entrance', 'must be on the border of the map and not on a corner');
  if (facing !== expected) return refuse('entrance.facing', `must be '${expected}' for a gate on this border`);
  if (ground[ey * width + ex] === GROUND_WATER) return refuse('entrance', 'is on water');
  const entrance: MapEntrance = { x: ex, y: ey, facing: expected };
  const props = readProps(state.props, biome, width, height, (x, y) => ground[y * width + x] === GROUND_WATER, entrance);
  const recipe = readSavedRecipe((state as unknown as Record<string, unknown>).recipe, id, biomeId);
  const shipped = MAP_BY_ID.get(id as never);
  return Object.freeze({
    id,
    name: recipe !== null ? generatedMapName(recipe) : shipped && shipped.biome === biome.id ? shipped.name : 'Custom map',
    biome,
    width,
    height,
    entrance: Object.freeze(entrance),
    ground,
    groundKey: groundKeyOf(id, biome.id, groundRows),
    props: Object.freeze(props.map((prop) => Object.freeze(prop))),
    startingObjects: Object.freeze({ paths: Object.freeze([]), objects: Object.freeze([]) }),
    seed: null,
    recipe,
  });
};

/** Validates the saved recipe WITHOUT regenerating (the stored ground and props win). null is a hand-made map. */
const readSavedRecipe = (value: unknown, mapId: string, biomeId: string): MapRecipe | null => {
  if (value === null) return null;
  const read = readRecipe(value);
  if ('problem' in read) return refuse('recipe', read.problem);
  if (read.biomeId !== biomeId) return refuse('recipe.biomeId', `'${read.biomeId}' does not match the map biome '${biomeId}'`);
  if (mapId !== generatedMapId(read)) return refuse('id', `'${mapId}' does not match the recipe (expected '${generatedMapId(read)}')`);
  return read;
};

const layoutCache = new Map<string, MapLayout>();

/**
 * The layout of a shipped map by id (memoised: layouts are immutable, so sessions share them). Throws
 * MapFormatError for an id that is not in MAPS, or for a malformed map.
 */
export const layoutOfMapId = (id: string): MapLayout => {
  const cached = layoutCache.get(id);
  if (cached) return cached;
  const definition = MAP_BY_ID.get(id as never);
  if (!definition) throw new MapFormatError(id, ['is not a map this game ships']);
  const layout = layoutOfMap(definition);
  layoutCache.set(id, layout);
  return layout;
};

/** The default map as a layout (today's world: a gate at (15, 31) facing north, no props, all base ground). */
export const MEADOW_LAYOUT: MapLayout = layoutOfMapId('meadow');
