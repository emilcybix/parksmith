import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { hash32 } from '../weather/random';
import { hashState } from '../save/hash';
import { GameWorld } from '../World';
import { SANDBOX_SEED } from '../session/ParkSession';
import { DEFAULT_MAP_ID, MAPS, MAP_BY_ID, isMapId, mapsOfBiome } from './content';
import { entranceFrame } from './frame';
import { groundRowsOf, layoutFromState, layoutOfMap, layoutOfMapId, MEADOW_LAYOUT, propFootprintSize } from './parse';
import { PROP_KIND_BY_ID } from './props';
import { GROUND_ALT, GROUND_BASE, GROUND_WATER, MapFormatError, type MapId } from './types';
import { maxPropCellsPerChunk, reachableArea, validateMapDefinition } from './validate';
import { BIOME_IDS } from '../biomes/types';

/** The designer's table (phase24 design, section 5): props, permanent, water, alt, open, cleared, densest chunk. */
const STATS: Record<MapId, { props: number; permanent: number; water: number; alt: number; open: number; cleared: number; chunk: number; entrance: [number, number, string] }> = {
  meadow: { props: 0, permanent: 0, water: 0, alt: 0, open: 1024, cleared: 1024, chunk: 0, entrance: [15, 31, 'north'] },
  'brookside-meadow': { props: 73, permanent: 1, water: 68, alt: 0, open: 874, cleared: 952, chunk: 16, entrance: [15, 31, 'north'] },
  // Refreshed in step 2 (the one map that changed on purpose): sea on two shores, a pier, three sea stacks, sand under the palms.
  'seaside-cove': { props: 76, permanent: 9, water: 311, alt: 239, open: 629, cleared: 701, chunk: 12, entrance: [0, 15, 'east'] },
  'red-rock-canyon': { props: 177, permanent: 120, water: 0, alt: 70, open: 596, cleared: 892, chunk: 23, entrance: [16, 0, 'south'] },
  'frosted-hollow': { props: 279, permanent: 2, water: 62, alt: 21, open: 520, cleared: 953, chunk: 33, entrance: [9, 31, 'north'] },
  'emerald-ruins': { props: 201, permanent: 3, water: 87, alt: 39, open: 447, cleared: 925, chunk: 28, entrance: [31, 22, 'west'] },
  'maple-ridge': { props: 278, permanent: 44, water: 0, alt: 121, open: 726, cleared: 980, chunk: 26, entrance: [22, 31, 'north'] },
  // Phase 21: the first estate (64 x 64); `open` is the whole map here (the validator measures the owned area for it).
  'meadow-estate': { props: 194, permanent: 5, water: 180, alt: 270, open: 3703, cleared: 3896, chunk: 12, entrance: [31, 63, 'north'] },
};

describe('the shipped maps', () => {
  it('lists eight maps (seven 32 x 32 and the Phase 21 estate), at least one per biome, with unique ids, and the default is Meadow Garden', () => {
    expect(MAPS.length).toBe(8);
    expect(new Set(MAPS.map((map) => map.id)).size).toBe(8);
    expect(DEFAULT_MAP_ID).toBe('meadow');
    expect(MAPS[0].id).toBe('meadow');
    for (const biome of BIOME_IDS) expect(mapsOfBiome(biome).length, biome).toBeGreaterThanOrEqual(1);
    expect(mapsOfBiome('meadow').map((map) => map.id)).toEqual(['meadow', 'brookside-meadow', 'meadow-estate']);
    expect(isMapId('seaside-cove')).toBe(true);
    expect(isMapId('nowhere')).toBe(false);
  });

  it.each(MAPS.map((map) => [map.id] as const))('%s passes the validator and matches the designed numbers', (id) => {
    const map = MAP_BY_ID.get(id)!;
    expect(validateMapDefinition(map)).toEqual([]);
    const layout = layoutOfMap(map);
    const stats = STATS[id];
    expect(layout.props.length, 'props').toBe(stats.props);
    expect(layout.props.filter((prop) => PROP_KIND_BY_ID.get(prop.kind)!.clearCost === null).length, 'permanent').toBe(stats.permanent);
    let water = 0;
    let alt = 0;
    for (const ground of layout.ground) {
      if (ground === GROUND_WATER) water += 1;
      if (ground === GROUND_ALT) alt += 1;
    }
    expect(water, 'water').toBe(stats.water);
    expect(alt, 'alt').toBe(stats.alt);
    expect(reachableArea(layout, layout.props, { clearClearable: false }), 'open').toBe(stats.open);
    expect(reachableArea(layout, layout.props, { clearClearable: true }), 'cleared').toBe(stats.cleared);
    expect(maxPropCellsPerChunk(layout, layout.props), 'densest chunk').toBe(stats.chunk);
    // Phase 21: the classic maps are 32 x 32 and wholly owned; an estate is larger and starts with an owned area.
    expect(layout.width).toBe(map.ownedArea === null ? GAME_CONFIG.mapWidth : 64);
    expect(layout.height).toBe(map.ownedArea === null ? GAME_CONFIG.mapHeight : 64);
    expect(layout.entrance.facing).toBeDefined();
    // The decision every map must offer (the cleared area is larger than what is free), except the empty Meadow.
    expect(stats.cleared).toBeGreaterThanOrEqual(stats.open);
    expect(stats.open).toBeGreaterThanOrEqual(GAME_CONFIG.maps.minimumOpenArea);
  });

  it('the four facings are all exercised by the shipped maps', () => {
    const facings = new Set(MAPS.map((map) => layoutOfMap(map).entrance.facing));
    expect([...facings].sort()).toEqual(['east', 'north', 'south', 'west']);
  });

  it('the Meadow layout is today\'s world: gate (15, 31) facing north, no props, all base ground, the sandbox seed', () => {
    expect(MEADOW_LAYOUT.id).toBe('meadow');
    expect(MEADOW_LAYOUT.entrance).toEqual({ x: 15, y: 31, facing: 'north' });
    expect(MEADOW_LAYOUT.props).toEqual([]);
    expect([...MEADOW_LAYOUT.ground].every((value) => value === GROUND_BASE)).toBe(true);
    expect(MEADOW_LAYOUT.seed).toBe(SANDBOX_SEED);
    expect(MEADOW_LAYOUT.biome.id).toBe('meadow');
    expect(layoutOfMapId('meadow')).toBe(MEADOW_LAYOUT);
    expect(layoutOfMapId('red-rock-canyon')).toBe(layoutOfMapId('red-rock-canyon'));
    expect(() => layoutOfMapId('nowhere')).toThrow(MapFormatError);
    const world = new GameWorld();
    expect(world.entrance).toEqual({ x: 15, y: 31 });
    expect(world.entranceFacing).toBe('north');
    expect(world.width).toBe(32);
  });

  it('prop ids follow the row-major order of the anchor; rotations follow the rule', () => {
    for (const map of MAPS) {
      const layout = layoutOfMap(map);
      let previous: { x: number; y: number } | null = null;
      layout.props.forEach((prop, index) => {
        expect(prop.id).toBe(index + 1);
        if (previous) expect(prop.y > previous.y || (prop.y === previous.y && prop.x > previous.x), `${map.id} #${prop.id}`).toBe(true);
        previous = prop;
        const kind = PROP_KIND_BY_ID.get(prop.kind)!;
        if (kind.footprint[0] === 2 && kind.footprint[1] === 2) expect(prop.rotation).toBe(0);
        else if (kind.footprint[0] === 2) expect([0, 1]).toContain(prop.rotation);
        else expect(prop.rotation).toBe(hash32(map.seed, prop.x, prop.y) & 3);
        // The anchor is the min corner and the footprint is on the map.
        const [w, d] = propFootprintSize(kind, prop.rotation);
        expect(prop.x + w).toBeLessThanOrEqual(layout.width);
        expect(prop.y + d).toBeLessThanOrEqual(layout.height);
      });
    }
  });

  it('round trip: layout -> world.serializeMap -> layoutFromState gives the same land and props', () => {
    for (const map of MAPS) {
      const layout = layoutOfMap(map);
      const world = new GameWorld(5000, 1, layout);
      const state = world.serializeMap();
      expect(state.ground).toEqual(groundRowsOf(layout.ground, layout.width, layout.height));
      expect(state.props.length).toBe(layout.props.length);
      const restored = layoutFromState(JSON.parse(JSON.stringify(state)));
      expect(restored.id).toBe(layout.id);
      expect(restored.name).toBe(layout.name);
      expect(restored.entrance).toEqual(layout.entrance);
      expect(restored.groundKey).toBe(layout.groundKey);
      expect([...restored.ground]).toEqual([...layout.ground]);
      expect(restored.props).toEqual(layout.props);
      expect(restored.biome).toBe(layout.biome);
      expect(restored.seed, 'a restored layout has no map seed').toBeNull();
    }
  });

  it('the entrance frame: Meadow\'s toWorld is (15 + l, 31 - d), and every facing maps a lane consistently', () => {
    const meadow = entranceFrame({ x: 15, y: 31, facing: 'north' });
    expect(meadow.toWorld(0, 0)).toEqual({ x: 15, y: 31 });
    expect(meadow.toWorld(-2, 11)).toEqual({ x: 13, y: 20 });
    expect(meadow.toWorld(3, 5)).toEqual({ x: 18, y: 26 });
    expect(meadow.rotation).toBe(0);
    expect(meadow.rectToWorld(1, 5, 3, 3)).toEqual({ x: 16, y: 24 });
    const east = entranceFrame({ x: 0, y: 15, facing: 'east' });
    expect(east.toWorld(0, 4)).toEqual({ x: 4, y: 15 });
    expect(east.toWorld(1, 4)).toEqual({ x: 4, y: 16 });
    expect(east.rotation).toBe(1);
    const south = entranceFrame({ x: 16, y: 0, facing: 'south' });
    expect(south.toWorld(1, 2)).toEqual({ x: 15, y: 2 });
    expect(south.rectToWorld(0, 2, 3, 2)).toEqual({ x: 14, y: 2 });
    const west = entranceFrame({ x: 31, y: 22, facing: 'west' });
    expect(west.toWorld(1, 3)).toEqual({ x: 28, y: 21 });
  });
});

/**
 * Identity of the hand-made maps (Phase 24 step 2): the layout hashes below were captured from the step-1 code BEFORE any
 * step-2 edit. Hand-made maps are data and must never be regenerated; Seaside Cove is the one that changed on purpose.
 */
const LAYOUT_PINS: Record<string, string> = {
  'meadow': 'b6967afe933d2026',
  'brookside-meadow': '050cd18a7aa553d3',
  'seaside-cove': '825752e966ca2d12',
  'red-rock-canyon': '36cd10ef5e7c1b4a',
  'frosted-hollow': 'a15e68bfc2e6febe',
  'emerald-ruins': 'b730c7d9c220823e',
  'maple-ridge': 'a08ef523da599a50'
};

describe('hand-made map identity', () => {
  const hashOf = (id: string): string => {
    const layout = layoutOfMapId(id);
    return hashState({ id: layout.id, name: layout.name, biome: layout.biome.id, rows: groundRowsOf(layout.ground, 32, 32), entrance: layout.entrance, props: layout.props, key: layout.groundKey, seed: layout.seed });
  };
  it.each(['meadow', 'brookside-meadow', 'red-rock-canyon', 'frosted-hollow', 'emerald-ruins', 'maple-ridge'])('%s is bit-identical to step 1', (id) => {
    expect(hashOf(id)).toBe(LAYOUT_PINS[id]);
  });
  it('Seaside Cove changed on purpose', () => {
    expect(hashOf('seaside-cove')).not.toBe(LAYOUT_PINS['seaside-cove']);
  });
  it('no unchanged map carries explicit ground rows, and every hand-made layout has a null recipe', () => {
    for (const map of MAPS) {
      expect(map.ground !== undefined, map.id).toBe(map.id === 'seaside-cove');
      expect(layoutOfMapId(map.id).recipe, map.id).toBeNull();
    }
  });
});
