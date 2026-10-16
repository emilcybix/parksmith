import { BIOME_BY_ID } from '../biomes/content';
import { GAME_CONFIG } from '../config';
import { GameWorld } from '../World';
import { isLegalMapSize, legalMapSizeText, parcelGridOf, parcelsOfRect, type CellRect } from '../land/parcels';
import { entranceFrame } from './frame';
import { layoutOfMap, parseMapRows, propFootprintSize } from './parse';
import { PROP_KIND_BY_ID } from './props';
import { MAP_FORMAT_VERSION, type MapDefinition, type MapLayout, type MapProblem, type PropPlacement } from './types';

/**
 * The map validator (Phase 24). The data tests run it over MAPS; a step-2 generator calls it on every
 * candidate. `validateMapDefinition` returns every problem it finds ([] = valid) and never throws.
 */

export type { MapProblem, MapProblemCode } from './types';

const MAP_ID_PATTERN = /^[a-z0-9-]{1,64}$/;
/** Blurbs are one picker line; the designer's longest are about 145 characters. */
export const MAXIMUM_BLURB_LENGTH = 160;
/** The voxel static chunk is 8 x 8 tiles. */
const CHUNK_TILES = 8;

/**
 * A cap tuned on the classic 32 x 32 map, scaled by the map's area (Phase 21): a 64 x 64 map may hold four times the
 * props of a 32 x 32 one. Exact (the identity) on a 32 x 32 map.
 */
export const areaScaledCap = (cap: number, width: number, height: number): number => (
  Math.round(cap * (width * height) / (GAME_CONFIG.mapWidth * GAME_CONFIG.mapHeight))
);

/**
 * Cells reachable from the gate by 4-connected steps over cells that are not water and not blocked by a prop. With
 * `within`, cells outside that inclusive rectangle count as blocked (the owned area of a Phase 21 map).
 */
export const reachableArea = (
  layout: MapLayout,
  props: Iterable<PropPlacement>,
  options: { clearClearable: boolean; within?: CellRect },
): number => {
  const { width, height } = layout;
  const blocked = new Uint8Array(width * height);
  for (let index = 0; index < blocked.length; index += 1) blocked[index] = layout.ground[index] === 2 ? 1 : 0;
  const within = options.within;
  if (within) {
    for (let index = 0; index < blocked.length; index += 1) {
      const x = index % width;
      const y = (index - x) / width;
      if (x < within.x0 || x > within.x1 || y < within.y0 || y > within.y1) blocked[index] = 1;
    }
  }
  for (const prop of props) {
    const kind = PROP_KIND_BY_ID.get(prop.kind);
    if (!kind) continue;
    if (options.clearClearable && kind.clearCost !== null) continue;
    const [w, d] = propFootprintSize(kind, prop.rotation);
    for (let dy = 0; dy < d; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) {
        const x = prop.x + dx;
        const y = prop.y + dy;
        if (x >= 0 && y >= 0 && x < width && y < height) blocked[y * width + x] = 1;
      }
    }
  }
  const start = layout.entrance.y * width + layout.entrance.x;
  if (blocked[start]) return 0;
  const seen = new Uint8Array(width * height);
  const stack = [start];
  seen[start] = 1;
  let count = 0;
  while (stack.length > 0) {
    const index = stack.pop() as number;
    count += 1;
    const x = index % width;
    const y = (index - x) / width;
    const next = [x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1, y > 0 ? index - width : -1, y < height - 1 ? index + width : -1];
    for (const candidate of next) {
      if (candidate < 0 || seen[candidate] || blocked[candidate]) continue;
      seen[candidate] = 1;
      stack.push(candidate);
    }
  }
  return count;
};

/** Prop cells per 8x8 chunk, the densest first number. */
export const maxPropCellsPerChunk = (layout: MapLayout, props: readonly PropPlacement[]): number => {
  const chunks = new Map<number, number>();
  const perRow = Math.ceil(layout.width / CHUNK_TILES);
  for (const prop of props) {
    const kind = PROP_KIND_BY_ID.get(prop.kind);
    if (!kind) continue;
    const [w, d] = propFootprintSize(kind, prop.rotation);
    for (let dy = 0; dy < d; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) {
        const key = Math.floor((prop.y + dy) / CHUNK_TILES) * perRow + Math.floor((prop.x + dx) / CHUNK_TILES);
        chunks.set(key, (chunks.get(key) ?? 0) + 1);
      }
    }
  }
  return Math.max(0, ...chunks.values());
};

export const validateMapDefinition = (definition: MapDefinition): MapProblem[] => {
  const problems: MapProblem[] = [];
  const add = (code: MapProblem['code'], at: { x: number; y: number } | null, detail: string): void => {
    problems.push({ code, at, detail });
  };
  if (definition.formatVersion !== MAP_FORMAT_VERSION) add('format', null, `formatVersion must be ${MAP_FORMAT_VERSION}`);
  if (typeof definition.id !== 'string' || !MAP_ID_PATTERN.test(definition.id)) add('format', null, 'id must match [a-z0-9-]{1,64}');
  if (typeof definition.name !== 'string' || definition.name.trim().length === 0) add('format', null, 'name is empty');
  if (typeof definition.blurb !== 'string' || definition.blurb.length === 0 || definition.blurb.length > MAXIMUM_BLURB_LENGTH) {
    add('format', null, `blurb must be 1..${MAXIMUM_BLURB_LENGTH} characters`);
  }
  const biome = BIOME_BY_ID.get(definition.biome);
  if (!biome) {
    add('format', null, `unknown biome '${String(definition.biome)}'`);
    return problems;
  }
  if (!Number.isInteger(definition.seed) || definition.seed < 0 || definition.seed > 0xffffffff) add('seed', null, 'seed must be a uint32');
  if (!isLegalMapSize(definition.width, definition.height)) {
    add('size', null, `map sizes are ${legalMapSizeText()} (this one is ${definition.width} x ${definition.height})`);
    return problems;
  }
  const parsed = parseMapRows(definition.rows, definition.width, definition.height, biome, definition.seed, definition.ground);
  problems.push(...parsed.problems);
  if (parsed.entrance === null || parsed.problems.some((found) => found.code === 'rows')) return problems;

  const layout = layoutFromParsed(definition);
  if (layout === null) return problems;
  const { entrance } = layout;
  const frame = entranceFrame(entrance);

  // The cell just inside the gate must be inside the map and open.
  const inward = frame.toWorld(0, 1);
  const propCells = new Set<number>();
  for (const prop of layout.props) {
    const kind = PROP_KIND_BY_ID.get(prop.kind);
    if (!kind) continue;
    const [w, d] = propFootprintSize(kind, prop.rotation);
    for (let dy = 0; dy < d; dy += 1) for (let dx = 0; dx < w; dx += 1) propCells.add((prop.y + dy) * layout.width + prop.x + dx);
  }
  const blockedAt = (x: number, y: number): boolean => (
    layout.ground[y * layout.width + x] === 2 || propCells.has(y * layout.width + x)
  );
  const inside = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < layout.width && y < layout.height;
  if (!inside(inward.x, inward.y) || blockedAt(inward.x, inward.y)) {
    add('entrance-inward-blocked', inward, 'the cell inside the gate must be open');
  }

  const maxProps = areaScaledCap(GAME_CONFIG.maps.maxProps, layout.width, layout.height);
  if (layout.props.length > maxProps) {
    add('too-many-props', null, `${layout.props.length} props exceed the ${maxProps} cap`);
  }
  const densest = maxPropCellsPerChunk(layout, layout.props);
  if (densest > GAME_CONFIG.maps.maxPropCellsPerChunk) {
    add('chunk-density', null, `a chunk holds ${densest} prop cells, above ${GAME_CONFIG.maps.maxPropCellsPerChunk}`);
  }

  // The First Day apron: the six lanes beside the gate, `depth` cells deep, free of props and water.
  const { lateral, depth } = GAME_CONFIG.maps.firstDayApron;
  apron: for (let d = 0; d < depth; d += 1) {
    for (let l = lateral[0]; l <= lateral[1]; l += 1) {
      const cell = frame.toWorld(l, d);
      if (!inside(cell.x, cell.y)) {
        add('apron-blocked', cell, 'the First Day apron leaves the map');
        break apron;
      }
      if (blockedAt(cell.x, cell.y)) {
        add('apron-blocked', cell, 'the First Day apron is blocked by a prop or water');
        break apron;
      }
    }
  }

  const owned = definition.ownedArea;
  let ownedOk = true;
  if (owned !== null) {
    ownedOk = [owned.x0, owned.y0, owned.x1, owned.y1].every(Number.isInteger)
      && owned.x0 >= 0 && owned.y0 >= 0 && owned.x1 < definition.width && owned.y1 < definition.height
      && owned.x0 <= owned.x1 && owned.y0 <= owned.y1
      && entrance.x >= owned.x0 && entrance.x <= owned.x1 && entrance.y >= owned.y0 && entrance.y <= owned.y1;
    if (!ownedOk) add('owned-area', null, 'ownedArea must be a rectangle inside the map that contains the gate');
    else if (parcelsOfRect(parcelGridOf(definition.width, definition.height), owned) === null) {
      ownedOk = false;
      add('owned-area', null, `ownedArea must be whole ${GAME_CONFIG.land.parcelSize}-cell parcels`);
    }
  }

  // Open area: what a new park can use without spending (on a Phase 21 map, inside the starting owned area). Cleared
  // area: the whole map with every clearable prop gone, against the cap scaled by the map's area.
  const open = reachableArea(layout, layout.props, { clearClearable: false, ...(owned !== null && ownedOk ? { within: owned } : {}) });
  if (open < GAME_CONFIG.maps.minimumOpenArea) add('open-area', null, `${open} cells are open from the gate, below ${GAME_CONFIG.maps.minimumOpenArea}`);
  const cleared = reachableArea(layout, layout.props, { clearClearable: true });
  const minimumCleared = areaScaledCap(GAME_CONFIG.maps.minimumClearedArea, layout.width, layout.height);
  if (cleared < minimumCleared) {
    add('cleared-area', null, `${cleared} cells are reachable with every clearable prop cleared, below ${minimumCleared}`);
  }
  if (!ownedOk) return problems;

  // Starting content must be placeable: stamp it into a scratch world.
  const starting = definition.startingObjects;
  if (starting.paths.length > 0 || starting.objects.length > 0) {
    const scratch = new GameWorld(0, 1, layout);
    for (const cell of starting.paths) {
      if (!scratch.canPlacePath(cell)) add('starting-object', cell, 'a starting path tile is blocked');
      else scratch.seedScenarioPaths([cell]);
    }
    for (const object of starting.objects) {
      if (scratch.seedScenarioObject(object.definitionId, object.anchor, object.rotation ?? 0) === null) {
        add('starting-object', object.anchor, `a starting ${object.definitionId} cannot be placed`);
      }
    }
  }
  return problems;
};

/** The layout of a definition whose rows parsed, without throwing (used after parseMapRows succeeded). */
const layoutFromParsed = (definition: MapDefinition): MapLayout | null => {
  try {
    return layoutOfMap(definition);
  } catch {
    return null;
  }
};
