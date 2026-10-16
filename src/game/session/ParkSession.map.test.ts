import { describe, expect, it } from 'vitest';
import { BIOMES } from '../biomes/content';
import { GAME_CONFIG } from '../config';
import { MAPS, MAP_BY_ID } from '../maps/content';
import { layoutOfMap, layoutOfMapId } from '../maps/parse';
import type { MapDefinition, MapId } from '../maps/types';
import { SCENARIO_BY_ID, SCENARIOS } from '../scenarios/content';
import { hashState } from '../save/hash';
import { createParkSave } from '../save/version';
import { ParkSession, SANDBOX_SEED } from './ParkSession';
import { sessionFromSave } from './fromSave';

const step = (session: ParkSession, ticks: number): void => {
  for (let t = 0; t < ticks; t += 1) session.step(GAME_CONFIG.fixedStepMs);
};
const roundTrip = (session: ParkSession): ParkSession => {
  session.syncWithWorld();
  const save = createParkSave(session.serialize(), { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 1);
  return sessionFromSave(JSON.parse(JSON.stringify(save))).session;
};

describe('a new park on a map', () => {
  it('Meadow Garden is the default: the same world, seed and rules as a park with no options', () => {
    const plain = new ParkSession(null);
    const meadow = new ParkSession(null, [], { mapId: 'meadow' });
    expect(meadow.map).toBe(plain.map);
    expect(meadow.seed).toBe(SANDBOX_SEED);
    expect(plain.seed).toBe(SANDBOX_SEED);
    plain.syncWithWorld();
    meadow.syncWithWorld();
    expect(hashState(meadow.serialize())).toBe(hashState(plain.serialize()));
    expect(Object.keys(plain.serialize().rules)).not.toContain('thirstRateMultiplier');
  });

  it.each(MAPS.map((map) => [map.id] as const))('%s: world, seed, biome rules and the map in the save', (id) => {
    const definition = MAP_BY_ID.get(id)!;
    const session = new ParkSession(null, [], { mapId: id });
    const biome = BIOMES.find((candidate) => candidate.id === definition.biome)!;
    expect(session.map.id).toBe(id);
    expect(session.world.map).toBe(session.map);
    expect(session.world.props.size).toBe(session.map.props.length);
    expect(session.seed).toBe(definition.seed);
    expect(session.rules.hungerRateMultiplier ?? 1).toBe(biome.rules.hungerRateMultiplier);
    expect(session.rules.thirstRateMultiplier ?? 1).toBe(biome.rules.thirstRateMultiplier);
    session.syncWithWorld();
    const state = session.serialize();
    expect(state.map.id).toBe(id);
    expect(state.map.biomeId).toBe(definition.biome);
    expect(Object.keys(state).slice(-3), 'map, then the schema-10 mode and grant, are written last').toEqual(['map', 'mode', 'grant']);
    expect('hungerRateMultiplier' in state.rules).toBe(biome.rules.hungerRateMultiplier !== 1);
    expect('thirstRateMultiplier' in state.rules).toBe(biome.rules.thirstRateMultiplier !== 1);
  });

  it('only Autumn Forest changes the sandbox clock; the player\'s switches win afterwards and are saved as today', () => {
    for (const map of MAPS) {
      const session = new ParkSession(null, [], { mapId: map.id });
      if (map.biome === 'autumn-forest') {
        expect(session.calendar.dayLengthSeconds).toBe(1440);
        expect(session.calendar.timeLock).toBe('dusk');
      } else {
        expect(session.calendar.dayLengthSeconds, map.id).toBe(720);
        expect(session.calendar.timeLock, map.id).toBe('auto');
      }
    }
    const autumn = new ParkSession(null, [], { mapId: 'maple-ridge' });
    expect(autumn.calendar.setTimeLock('noon')).toBe(true);
    expect(autumn.calendar.setDayLength(360)).toBe(true);
    step(autumn, 10);
    const again = roundTrip(autumn);
    expect(again.calendar.timeLock).toBe('noon');
    expect(again.calendar.dayLengthSeconds).toBe(360);
    // A restore never re-applies the biome defaults.
    expect(again.calendar.serialize()).toEqual(autumn.calendar.serialize());
  });

  it('a scenario keeps Meadow unless it declares a map', () => {
    for (const scenario of SCENARIOS) {
      const session = new ParkSession(scenario);
      expect(session.map.id, scenario.id).toBe(scenario.mapId ?? 'meadow');
      expect(session.seed).toBe(scenario.seed);
    }
    expect(SCENARIOS.slice(0, 4).every((scenario) => scenario.mapId === undefined), 'the four shipped scenarios stay on the Meadow').toBe(true);
    const onCoast = { ...SCENARIO_BY_ID.get('sunny-start')!, mapId: 'seaside-cove' as MapId, setup: { paths: [], objects: [] } };
    const session = new ParkSession(onCoast);
    expect(session.map.id).toBe('seaside-cove');
    expect(session.seed, 'a scenario keeps its own seed').toBe(onCoast.seed);
    expect(session.world.entrance).toEqual({ x: 0, y: 15 });
    // Its biome still shapes the rules and the weather (but a scenario clock is fixed).
    expect(session.rules.thirstRateMultiplier).toBe(1.06);
    expect(session.calendar.isEditable).toBe(false);
  });

  it('every scenario\'s setup is legal on its own map', () => {
    for (const scenario of SCENARIOS) {
      const session = new ParkSession(scenario);
      expect(session.world.paths.size, scenario.id).toBe(scenario.setup.paths.length + 1);
      expect(session.world.objects.size, scenario.id).toBe(scenario.setup.objects.length);
    }
  });

  it('starting objects of a map are stamped free, before the scenario setup, and never on a restore', () => {
    const base = MAP_BY_ID.get('brookside-meadow') as MapDefinition;
    const definition: MapDefinition = {
      ...base,
      startingObjects: { paths: [{ x: 15, y: 30 }, { x: 15, y: 29 }], objects: [{ definitionId: 'picnic-pocket', anchor: { x: 16, y: 29 } }] },
    };
    const layout = layoutOfMap(definition);
    const session = new ParkSession(null, [], { layout });
    expect(session.world.paths.size).toBe(3);
    expect(session.world.objects.size).toBe(1);
    expect(session.world.cash).toBe(GAME_CONFIG.startingCash);
    expect(session.world.transactions.length).toBe(0);
    const again = roundTrip(session);
    expect(again.world.paths.size).toBe(3);
    expect(again.world.objects.size).toBe(1);
  });
});

describe('save and load on every map', () => {
  it.each(MAPS.map((map) => [map.id] as const))('%s: serialize -> JSON -> fromSave is the same state and keeps playing identically', (id) => {
    const live = new ParkSession(null, [], { mapId: id });
    const frame = live.world.entrance;
    // A little park: the gate plus the lane inwards, so guests can move.
    const direction = live.world.entranceFacing === 'north' ? { x: 0, y: -1 } : live.world.entranceFacing === 'south' ? { x: 0, y: 1 } : live.world.entranceFacing === 'east' ? { x: 1, y: 0 } : { x: -1, y: 0 };
    live.world.buildPaths([1, 2, 3, 4, 5, 6].map((d) => ({ x: frame.x + direction.x * d, y: frame.y + direction.y * d })));
    live.syncWithWorld();
    step(live, 600);
    live.syncWithWorld();
    const twin = roundTrip(live);
    expect(hashState(twin.serialize())).toBe(hashState(live.serialize()));
    step(live, 300);
    step(twin, 300);
    live.syncWithWorld();
    twin.syncWithWorld();
    expect(hashState(twin.serialize())).toBe(hashState(live.serialize()));
    expect(twin.map.id).toBe(id);
    expect(twin.world.props.size).toBe(live.world.props.size);
  });

  it('a cleared obstacle stays cleared across save/load and undo-style rebuilds', () => {
    const live = new ParkSession(null, [], { mapId: 'red-rock-canyon' });
    const boulder = live.map.props.find((prop) => prop.kind === 'red-boulder')!;
    const total = live.world.props.size;
    expect(live.world.bulldoze(boulder)).toMatchObject({ removed: true, cost: 180 });
    live.syncWithWorld();
    expect(live.world.cash).toBe(GAME_CONFIG.startingCash - 180);
    const twin = roundTrip(live);
    expect(twin.world.props.size).toBe(total - 1);
    expect(twin.world.props.has(boulder.id)).toBe(false);
    expect(twin.world.cash).toBe(live.world.cash);
    // The saved ground is the land the park was played on; the layout rebuilt from the save has the remaining props.
    expect(twin.map.props.length).toBe(total - 1);
    expect(twin.map.groundKey).toBe(layoutOfMapId('red-rock-canyon').groundKey);
    // A second clear in the twin costs the same and the ids never move.
    const another = twin.map.props.find((prop) => prop.kind === 'red-boulder')!;
    expect(another.id).not.toBe(boulder.id);
    expect(twin.world.bulldoze(another)).toMatchObject({ removed: true, cost: 180 });
  });

  it('an in-place restore on a session of another map is refused', () => {
    const canyon = new ParkSession(null, [], { mapId: 'red-rock-canyon' });
    const coast = new ParkSession(null, [], { mapId: 'seaside-cove' });
    canyon.syncWithWorld();
    expect(() => coast.restoreState(canyon.serialize())).toThrow(/different map|different ruleset/);
  });
});

describe('clearing and undo (the game half: snapshot undo is serialize + fromState)', () => {
  it('a snapshot taken before a clear brings back the prop, the cash and the ledger; a drag of clears is one entry', () => {
    const live = new ParkSession(null, [], { mapId: 'maple-ridge' });
    live.syncWithWorld();
    const before = JSON.parse(JSON.stringify(live.serialize())) as ReturnType<ParkSession['serialize']>;
    const trees = [...live.world.props.values()].filter((prop) => prop.kind === 'maple-tree').slice(0, 3);
    live.world.batch(() => {
      for (const tree of trees) live.world.bulldoze(tree);
    });
    live.syncWithWorld();
    expect(live.world.props.size).toBe(before.map.props.length - 3);
    expect(live.world.cash).toBe(before.world.cash - 3 * 70);
    expect(live.serialize().world.transactions.filter((entry) => entry.category === 'land-clearing').length).toBe(3);
    // Undo: the app swaps in a session built from the snapshot.
    const undone = ParkSession.fromState(before);
    expect(undone.world.props.size).toBe(before.map.props.length);
    expect(undone.world.cash).toBe(before.world.cash);
    expect(undone.world.transactions.some((entry) => entry.category === 'land-clearing')).toBe(false);
    for (const tree of trees) expect(undone.world.propAt(tree)?.id).toBe(tree.id);
    expect(hashState(undone.serialize())).toBe(hashState(before));
    // The swap changes the layout object (a new session) but never the land identity the renderers key their terrain by.
    expect(undone.map.groundKey).toBe(live.map.groundKey);
    expect(undone.map.id).toBe(live.map.id);
  });

  it('props give no scenery appeal in step 1: the scenery scores are the same with the groves and with them gone', () => {
    const a = new ParkSession(null, [], { mapId: 'brookside-meadow' });
    const b = new ParkSession(null, [], { mapId: 'brookside-meadow' });
    for (const prop of [...b.world.props.values()]) if (prop.kind !== 'great-oak') b.world.bulldoze(prop);
    for (const session of [a, b]) {
      session.world.buildPaths([{ x: 15, y: 30 }, { x: 15, y: 29 }, { x: 15, y: 28 }]);
      session.world.buildObject('lollipop-lamp', { x: 14, y: 29 });
      session.syncWithWorld();
    }
    for (const cell of [{ x: 15, y: 30 }, { x: 15, y: 28 }, { x: 14, y: 29 }, { x: 17, y: 19 }]) {
      expect(a.scenery.scoreAt(cell), `${cell.x},${cell.y}`).toBe(b.scenery.scoreAt(cell));
    }
    expect(a.scenery.snapshot().averagePathScore).toBe(b.scenery.snapshot().averagePathScore);
  });
});
