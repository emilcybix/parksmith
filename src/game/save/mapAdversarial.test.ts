import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { generateMap, generatedMapId, recipeOf } from '../maps/generator';
import { layoutFromState } from '../maps/parse';
import { PROP_KIND_BY_ID } from '../maps/props';
import { GROUND_WATER } from '../maps/types';
import { ParkSession } from '../session/ParkSession';
import { hashState } from './hash';
import type { MapState, ParkSaveV8 } from './state';
import { SaveError, type SaveErrorCode } from './version';
import { sessionFromSave } from '../session/fromSave';

/**
 * Hostile `map` values (schema 8, ARCHITECTURE.md Biomes and maps / Persistence): each is refused with its
 * code before anything is built or mutated, none hangs, and a refused in-place load leaves the live park alone.
 */

const BROOK = 'brookside-meadow';

const baseState = (mapId: 'brookside-meadow' | 'frosted-hollow' | 'red-rock-canyon' = BROOK): ParkSaveV8 => {
  const session = new ParkSession(null, [], { mapId });
  session.syncWithWorld();
  return JSON.parse(JSON.stringify(session.serialize())) as ParkSaveV8;
};
const load = (mutate: (state: ParkSaveV8) => void, mapId: Parameters<typeof baseState>[0] = BROOK): ParkSession => {
  const state = baseState(mapId);
  mutate(state);
  return ParkSession.fromState(state);
};
const refused = (mutate: (state: ParkSaveV8) => void, code: SaveErrorCode, match?: RegExp, mapId?: Parameters<typeof baseState>[0]): void => {
  let error: unknown;
  try {
    load(mutate, mapId);
  } catch (thrown) {
    error = thrown;
  }
  expect(error, 'a SaveError was thrown').toBeInstanceOf(SaveError);
  expect((error as SaveError).code).toBe(code);
  if (match) expect((error as SaveError).message).toMatch(match);
};
const water = (state: ParkSaveV8): { x: number; y: number } => {
  for (let y = 0; y < state.map.ground.length; y += 1) {
    const x = state.map.ground[y].indexOf('~');
    if (x >= 0) return { x, y };
  }
  throw new Error('no water');
};

describe('the map key of a save', () => {
  it('a well-formed unknown map id loads as a Custom map; an exact-1 biome rule key is cosmetic', () => {
    const session = load((state) => {
      state.map.id = 'my-generated-map-7';
      (state.rules as unknown as Record<string, unknown>).hungerRateMultiplier = 1;
    });
    expect(session.map.id).toBe('my-generated-map-7');
    expect(session.map.name).toBe('Custom map');
    expect(session.map.biome.id).toBe('meadow');
    expect('hungerRateMultiplier' in session.serialize().rules, 'normalised away').toBe(false);
  });

  it('a shipped id with another land keeps the saved land (the save holds the land it was played on)', () => {
    const session = load((state) => {
      state.map.props = state.map.props.slice(0, 5);
    });
    expect(session.world.props.size).toBe(5);
    expect(session.map.name).toBe('Brookside Meadow');
  });

  const cases: Array<[string, (state: ParkSaveV8) => void, SaveErrorCode, RegExp?]> = [
    ['map missing', (s) => { delete (s as Partial<ParkSaveV8>).map; }, 'invalid-state', /map is missing/],
    ['map null', (s) => { (s as unknown as Record<string, unknown>).map = null; }, 'invalid-state'],
    ['map a number', (s) => { (s as unknown as Record<string, unknown>).map = 5; }, 'invalid-state'],
    ['map an array', (s) => { (s as unknown as Record<string, unknown>).map = []; }, 'invalid-state'],
    ['empty id', (s) => { s.map.id = ''; }, 'invalid-state', /map.id/],
    ['id with a space', (s) => { s.map.id = 'Bad Id'; }, 'invalid-state'],
    ['id too long', (s) => { s.map.id = 'a'.repeat(65); }, 'invalid-state'],
    ['id not a string', (s) => { (s.map as unknown as Record<string, unknown>).id = 7; }, 'invalid-state'],
    ['unknown biome', (s) => { (s.map as unknown as Record<string, unknown>).biomeId = 'tundra'; }, 'content-mismatch', /tundra/],
    ['biome not a string', (s) => { (s.map as unknown as Record<string, unknown>).biomeId = 3; }, 'invalid-state'],
    // Phase 21: sizes are whole 8-cell parcels from 32 to 64; a legal size still needs ground rows of that size.
    ['width 31', (s) => { s.map.width = 31; }, 'invalid-state', /whole 8-cell parcels/],
    ['height 72', (s) => { s.map.height = 72; }, 'invalid-state', /whole 8-cell parcels/],
    ['height 48 with 32 ground rows', (s) => { s.map.height = 48; }, 'invalid-state', /48 rows/],
    ['width a string', (s) => { (s.map as unknown as Record<string, unknown>).width = '32'; }, 'invalid-state'],
    ['ground not an array', (s) => { (s.map as unknown as Record<string, unknown>).ground = 'x'; }, 'invalid-state'],
    ['ground with 31 rows', (s) => { s.map.ground.pop(); }, 'invalid-state', /32 rows/],
    ['ground row too short', (s) => { s.map.ground[3] = s.map.ground[3].slice(1); }, 'invalid-state', /ground\[3\]/],
    ['ground row not a string', (s) => { (s.map.ground as unknown[])[3] = 5; }, 'invalid-state'],
    ['ground bad character', (s) => { s.map.ground[2] = `Z${s.map.ground[2].slice(1)}`; }, 'invalid-state', /not one of/],
    ['entrance missing', (s) => { delete (s.map as Partial<MapState>).entrance; }, 'invalid-state'],
    ['entrance off the border', (s) => { s.map.entrance = { x: 5, y: 5, facing: 'north' }; }, 'invalid-state', /border/],
    ['entrance on a corner', (s) => { s.map.entrance = { x: 0, y: 0, facing: 'east' }; }, 'invalid-state', /corner/],
    ['entrance outside the map', (s) => { s.map.entrance = { x: 40, y: 31, facing: 'north' }; }, 'invalid-state'],
    ['entrance not integer', (s) => { s.map.entrance = { x: 15.5, y: 31, facing: 'north' }; }, 'invalid-state'],
    ['entrance facing outwards', (s) => { s.map.entrance = { x: 15, y: 31, facing: 'south' }; }, 'invalid-state', /facing/],
    ['entrance facing garbage', (s) => { (s.map.entrance as unknown as Record<string, unknown>).facing = 'up'; }, 'invalid-state'],
    ['entrance on water', (s) => {
      const lake = water(s);
      s.map.ground[31] = s.map.ground[31].slice(0, 15) + '~' + s.map.ground[31].slice(16);
      void lake;
    }, 'invalid-state', /water/],
    ['entrance moved to a cell the world has no path on', (s) => { s.map.entrance = { x: 16, y: 31, facing: 'north' }; }, 'invalid-state', /entrance/],
    ['unknown prop kind', (s) => { (s.map.props[0] as unknown as Record<string, unknown>).kind = 'dragon'; }, 'content-mismatch', /dragon/],
    ['prop of another biome', (s) => { s.map.props[0].kind = 'palm-tree'; }, 'invalid-state', /biome/],
    ['prop kind not a string', (s) => { (s.map.props[0] as unknown as Record<string, unknown>).kind = 9; }, 'invalid-state'],
    ['prop outside the map', (s) => { s.map.props[0].x = 40; }, 'invalid-state', /outside the map/],
    ['prop negative', (s) => { s.map.props[0].y = -1; }, 'invalid-state'],
    ['2x2 prop hanging off the edge', (s) => { const oak = s.map.props.find((p) => p.kind === 'great-oak')!; oak.x = 31; }, 'invalid-state', /outside the map/],
    ['prop anchor not an integer', (s) => { s.map.props[0].x = 2.5; }, 'invalid-state'],
    ['prop on water', (s) => { const lake = water(s); s.map.props[0].x = lake.x; s.map.props[0].y = lake.y; }, 'invalid-state', /water/],
    ['prop on the entrance', (s) => { s.map.props[0].x = 15; s.map.props[0].y = 31; }, 'invalid-state', /entrance/],
    ['two props overlap', (s) => { s.map.props[1].x = s.map.props[0].x; s.map.props[1].y = s.map.props[0].y; }, 'invalid-state', /overlaps/],
    ['ids not ascending', (s) => { s.map.props[1].id = s.map.props[0].id; }, 'invalid-state', /ascending/],
    ['id zero', (s) => { s.map.props[0].id = 0; }, 'invalid-state'],
    ['id beyond 2^53', (s) => { s.map.props[0].id = 2 ** 60; }, 'invalid-state'],
    ['id not an integer', (s) => { s.map.props[0].id = 1.5; }, 'invalid-state'],
    ['rotation 4', (s) => { (s.map.props[0] as unknown as Record<string, unknown>).rotation = 4; }, 'invalid-state', /rotation/],
    ['rotation -1', (s) => { (s.map.props[0] as unknown as Record<string, unknown>).rotation = -1; }, 'invalid-state'],
    ['rotation 1.5', (s) => { (s.map.props[0] as unknown as Record<string, unknown>).rotation = 1.5; }, 'invalid-state'],
    ['props not an array', (s) => { (s.map as unknown as Record<string, unknown>).props = { length: 2 }; }, 'invalid-state'],
    ['a prop that is not an object', (s) => { (s.map.props as unknown[])[2] = 'oak'; }, 'invalid-state'],
    ['a path on a prop', (s) => {
      const tree = s.map.props.find((p) => p.kind === 'oak-tree')!;
      s.world.paths.push({ x: tree.x, y: tree.y });
    }, 'invalid-state', /prop or water/],
    ['a path on water', (s) => { const lake = water(s); s.world.paths.push(lake); }, 'invalid-state', /prop or water/],
    ['an object on a prop', (s) => {
      const tree = s.map.props.find((p) => p.kind === 'oak-tree')!;
      s.world.objects.push({ id: s.world.nextObjectId, definitionId: 'picnic-pocket', anchor: { x: tree.x, y: tree.y }, rotation: 0 });
      s.world.nextObjectId += 1;
    }, 'invalid-state', /prop or water/],
    ['hunger rule too big', (s) => { (s.rules as unknown as Record<string, unknown>).hungerRateMultiplier = 3; }, 'invalid-state', /hungerRateMultiplier/],
    ['thirst rule too small', (s) => { (s.rules as unknown as Record<string, unknown>).thirstRateMultiplier = 0.1; }, 'invalid-state', /thirstRateMultiplier/],
    ['thirst rule a string', (s) => { (s.rules as unknown as Record<string, unknown>).thirstRateMultiplier = '1.1'; }, 'invalid-state'],
    ['hunger rule null', (s) => { (s.rules as unknown as Record<string, unknown>).hungerRateMultiplier = null; }, 'invalid-state'],
  ];
  it.each(cases.map(([name, mutate, code, match]) => [name, mutate, code, match] as const))('refuses: %s', (_name, mutate, code, match) => {
    refused(mutate, code, match);
  });

  it('a 10^6-element prop array is refused without walking it (well under 50 ms) and a long ground array is bounded too', () => {
    const state = baseState();
    (state.map as unknown as Record<string, unknown>).props = new Array<unknown>(1_000_000).fill(0);
    const started = performance.now();
    expect(() => layoutFromState(state.map)).toThrow(/cap/);
    expect(performance.now() - started).toBeLessThan(50);
    const full = performance.now();
    expect(() => ParkSession.fromState(state)).toThrow(SaveError);
    expect(performance.now() - full).toBeLessThan(500);
    const rows = baseState();
    (rows.map as unknown as Record<string, unknown>).ground = new Array<string>(1_000_000).fill('.');
    expect(() => layoutFromState(rows.map)).toThrow(/32 rows/);
  });

  it('the prop cap itself is generous: exactly the maximum loads, one more does not', () => {
    const state = baseState('frosted-hollow');
    // Phase 21: one prop per cell of the largest (64 x 64) map.
    expect(GAME_CONFIG.maps.maxSavedProps).toBe(4096);
    expect(state.map.props.length).toBeLessThanOrEqual(GAME_CONFIG.maps.maxSavedProps);
    const padded = { ...state.map, props: Array.from({ length: GAME_CONFIG.maps.maxSavedProps + 1 }, (_, index) => ({ ...state.map.props[0], id: index + 1 })) };
    expect(() => layoutFromState(padded)).toThrow(/cap/);
  });

  it('nothing is normalised: a hostile map is never repaired, and the error names the path', () => {
    const state = baseState();
    state.map.props[0].rotation = 7 as never;
    try {
      layoutFromState(state.map);
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as SaveError).message).toMatch(/map\.props\[0\]\.rotation/);
    }
  });

  it('a refused in-place load leaves the live park untouched (validate before mutate)', () => {
    const live = new ParkSession(null, [], { mapId: BROOK });
    const tree = live.map.props.find((p) => p.kind === 'oak-tree')!;
    live.world.bulldoze(tree);
    live.syncWithWorld();
    const before = hashState(live.serialize());
    const propsBefore = [...live.world.props.keys()];
    const revisionBefore = live.world.propRevision;
    const hostile = baseState();
    hostile.map.props[1].kind = 'palm-tree';
    expect(() => live.restoreState(hostile)).toThrow(SaveError);
    expect(hashState(live.serialize())).toBe(before);
    expect([...live.world.props.keys()]).toEqual(propsBefore);
    expect(live.world.propRevision).toBe(revisionBefore);
  });

  it('fromSave with a re-stamped integrity hash is refused the same way (the hash guards damage, validation guards content)', () => {
    const session = new ParkSession(null, [], { mapId: BROOK });
    session.syncWithWorld();
    const state = JSON.parse(JSON.stringify(session.serialize())) as ParkSaveV8;
    state.map.biomeId = 'jungle';
    const save = { schemaVersion: 9, contentVersion: 2, savedAtTick: 0, savedAtEpochMs: 1, scenarioId: null, stateHash: hashState(state), app: { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, state };
    // Jungle with brook props: the oak is another biome's prop.
    expect(() => sessionFromSave(save)).toThrow(SaveError);
    expect(PROP_KIND_BY_ID.get('oak-tree')?.biome).toBe('meadow');
    expect(GROUND_WATER).toBe(2);
  });
});

/**
 * Hostile `map.recipe` values (schema 9). The recipe is informational: restore validates its shape and its agreement with the
 * map (biome, id) and never regenerates, so the stored ground and props always win.
 */
describe('the recipe of a generated map in a save', () => {
  const generatedState = (biome: 'seaside' | 'meadow' | 'desert-canyon' = 'seaside', seed = 1234): ParkSaveV8 => {
    const session = new ParkSession(null, [], { layout: generateMap(recipeOf(biome, seed)).layout });
    session.syncWithWorld();
    return JSON.parse(JSON.stringify(session.serialize())) as ParkSaveV8;
  };
  const recipeCase = (name: string, mutate: (state: ParkSaveV8) => void, match: RegExp, biome: 'seaside' | 'meadow' | 'desert-canyon' = 'seaside'): [string, () => void, RegExp] => [
    name, () => { const state = generatedState(biome); mutate(state); ParkSession.fromState(state); }, match,
  ];
  const asRecord = (state: ParkSaveV8): Record<string, unknown> => state.map.recipe as unknown as Record<string, unknown>;

  it('a generated map round-trips: the recipe comes back, the name is "Generated \u00b7 seed N", the stored map wins', () => {
    const state = generatedState();
    expect(state.map.recipe).toEqual(recipeOf('seaside', 1234));
    expect(Object.keys(state.map).at(-1)).toBe('recipe');
    const session = ParkSession.fromState(state);
    expect(session.map.recipe).toEqual(state.map.recipe);
    expect(session.map.name).toBe('Generated \u00b7 seed 1234');
    expect(session.map.id).toBe(generatedMapId(recipeOf('seaside', 1234)));
    expect(hashState(session.serialize())).toBe(hashState(state));
  });

  it('a recipe of a NEWER generator version is accepted (it is informational), and so is null on a generated id', () => {
    const newer = generatedState();
    asRecord(newer).generatorVersion = 9_999;
    expect(ParkSession.fromState(newer).map.recipe?.generatorVersion).toBe(9_999);
    const bare = generatedState();
    bare.map.recipe = null;
    const session = ParkSession.fromState(bare);
    expect(session.map.recipe).toBeNull();
    expect(session.map.name).toBe('Custom map');
  });

  it('the stored map wins over the recipe: a hand-edited prop list is kept, never regenerated', () => {
    const state = generatedState();
    state.map.props = state.map.props.slice(0, 3);
    expect(ParkSession.fromState(state).world.props.size).toBe(3);
  });

  it.each([
    recipeCase('recipe a number', (s) => { (s.map as unknown as Record<string, unknown>).recipe = 5; }, /map\.recipe/),
    recipeCase('recipe a string', (s) => { (s.map as unknown as Record<string, unknown>).recipe = 'seed 1234'; }, /map\.recipe/),
    recipeCase('recipe an array', (s) => { (s.map as unknown as Record<string, unknown>).recipe = []; }, /map\.recipe/),
    recipeCase('recipe missing (the key is required at schema 9)', (s) => { delete (s.map as Partial<ParkSaveV8['map']>).recipe; }, /map\.recipe/),
    recipeCase('recipe undefined', (s) => { (s.map as unknown as Record<string, unknown>).recipe = undefined; }, /map\.recipe/),
    recipeCase('empty recipe', (s) => { (s.map as unknown as Record<string, unknown>).recipe = {}; }, /map\.recipe/),
    recipeCase('unknown key', (s) => { asRecord(s).extra = 1; }, /unknown key/),
    recipeCase('missing seed', (s) => { delete asRecord(s).seed; }, /missing/),
    recipeCase('generatorVersion 0', (s) => { asRecord(s).generatorVersion = 0; }, /generatorVersion/),
    recipeCase('generatorVersion 65536', (s) => { asRecord(s).generatorVersion = 65_536; }, /generatorVersion/),
    recipeCase('generatorVersion 1.5', (s) => { asRecord(s).generatorVersion = 1.5; }, /generatorVersion/),
    recipeCase('generatorVersion a string', (s) => { asRecord(s).generatorVersion = '1'; }, /generatorVersion/),
    recipeCase('seed -1', (s) => { asRecord(s).seed = -1; }, /seed/),
    recipeCase('seed 2^32', (s) => { asRecord(s).seed = 2 ** 32; }, /seed/),
    recipeCase('seed 1.5', (s) => { asRecord(s).seed = 1.5; }, /seed/),
    recipeCase('seed NaN', (s) => { asRecord(s).seed = Number.NaN; }, /seed/),
    recipeCase('seed a string', (s) => { asRecord(s).seed = '1234'; }, /seed/),
    recipeCase('density unknown', (s) => { asRecord(s).density = 'extreme'; }, /density/),
    recipeCase('density a number', (s) => { asRecord(s).density = 2; }, /density/),
    recipeCase('water a string', (s) => { asRecord(s).water = 'yes'; }, /water/),
    recipeCase('water on in Desert Canyon', (s) => { asRecord(s).water = true; }, /no water option/, 'desert-canyon'),
    recipeCase('recipe biome differs from the map biome', (s) => { asRecord(s).biomeId = 'winter'; }, /does not match the map biome/),
    recipeCase('recipe biome unknown', (s) => { asRecord(s).biomeId = 'moon'; }, /biomeId/),
    recipeCase('map id differs from the recipe', (s) => { s.map.id = 'gen-seaside-1235-nw'; }, /does not match the recipe/),
    recipeCase('a recipe on a shipped id', (s) => { s.map.id = 'seaside-cove'; }, /does not match the recipe/),
    recipeCase('options in the id differ from the recipe', (s) => { asRecord(s).density = 'high'; }, /does not match the recipe/),
  ])('refuses: %s', (_name, attempt, match) => {
    let error: unknown;
    try {
      attempt();
    } catch (thrown) {
      error = thrown;
    }
    expect(error).toBeInstanceOf(SaveError);
    expect((error as SaveError).code).toBe('invalid-state');
    expect((error as SaveError).message).toMatch(match);
  });

  it('a hand-made map with a recipe is refused (a shipped id never matches a generated id)', () => {
    const state = baseState();
    (state.map as unknown as Record<string, unknown>).recipe = recipeOf('meadow', 1);
    expect(() => ParkSession.fromState(state)).toThrow(/does not match the recipe/);
  });

  it('a pier on land and a palm on water are refused', () => {
    const sea = (): ParkSaveV8 => {
      const session = new ParkSession(null, [], { mapId: 'seaside-cove' });
      session.syncWithWorld();
      return JSON.parse(JSON.stringify(session.serialize())) as ParkSaveV8;
    };
    const land = (state: ParkSaveV8): { x: number; y: number } => {
      const taken = new Set(state.map.props.map((p) => `${p.x},${p.y}`));
      for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) if (state.map.ground[y][x] === '.' && !taken.has(`${x},${y}`) && !(x === 0 && y === 15)) return { x, y };
      throw new Error('no land');
    };
    const wet = (state: ParkSaveV8): { x: number; y: number } => {
      const taken = new Set(state.map.props.map((p) => `${p.x},${p.y}`));
      for (let y = 0; y < 32; y += 1) for (let x = 0; x < 32; x += 1) if (state.map.ground[y][x] === '~' && !taken.has(`${x},${y}`)) return { x, y };
      throw new Error('no water');
    };
    const piers = sea();
    const pier = piers.map.props.find((p) => p.kind === 'boardwalk-pier')!;
    Object.assign(pier, land(piers));
    expect(() => ParkSession.fromState(piers)).toThrow(/water prop but stands on land/);
    const palms = sea();
    const palm = palms.map.props.find((p) => p.kind === 'palm-tree')!;
    Object.assign(palm, wet(palms));
    expect(() => ParkSession.fromState(palms)).toThrow(/stands on water/);
    expect(() => ParkSession.fromState(sea())).not.toThrow();
  });
});
