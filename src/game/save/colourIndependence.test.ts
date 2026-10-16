import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { BUILD_BY_ID } from '../content/catalog';
import { COLOUR_SWATCHES, ENTRANCE_COLOUR_ID, colourKindOf, colourSlotsFor, isColourable } from '../content/colours';
import { SCENARIO_BY_ID } from '../scenarios/content';
import { ParkSession } from '../session/ParkSession';
import { seedDevPark } from '../session/devPark';
import { seedColourTestPark } from '../session/colourTestPark';
import { COLOUR_PRESETS } from '../content/colourPresets';
import { hashState } from './hash';
import { ownerHashes } from './determinismHarness';
import type { ParkSaveV7 } from './state';

/**
 * Phase 28: a colour is never seen by the simulation. A park recoloured and the same park left
 * alone must produce identical simulation trajectories (every owner except the world, the world with
 * the colour records removed, and the step event streams), while the colours themselves ARE world
 * state: they are saved, hashed and restored, so the full world hash differs while colours exist.
 */

const lcg = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

const withoutColours = (state: ParkSaveV7): unknown => {
  const copy = structuredClone(state);
  for (const object of copy.world.objects) delete object.colours;
  delete copy.world.gateColours;
  return copy.world;
};

const simulationHashes = (session: ParkSession): Record<string, string> => {
  const hashes = ownerHashes(session.serialize());
  delete hashes.world;
  return hashes;
};

const colourableIds = (session: ParkSession): number[] => (
  [...session.world.objects.values()].filter((object) => isColourable(object.definitionId)).map((object) => object.id)
);

const edit = (session: ParkSession, change: () => void): void => {
  change();
  // Exactly what GameApp's world listener does after every world notification.
  session.syncWithWorld();
};


const randomRecord = (id: string, random: () => number): (number | null)[] => (
  colourSlotsFor(id).map(() => (random() < 0.15 ? null : Math.floor(random() * COLOUR_SWATCHES.length)))
);

const recolourEvery = (session: ParkSession, random: () => number): void => {
  edit(session, () => {
    session.world.batch(() => {
      for (const id of colourableIds(session)) {
        session.world.setObjectColours(id, randomRecord(session.world.objects.get(id)!.definitionId, random));
      }
    });
  });
};

const randomGate = (random: () => number): (number | null)[] => randomRecord(ENTRANCE_COLOUR_ID, random);

/** The first free 2x2 anchor in scan order: the same one in two identical parks. */
const freeAnchor = (session: ParkSession, definitionId: string): { x: number; y: number } => {
  const definition = BUILD_BY_ID.get(definitionId)!;
  for (let y = 2; y < session.world.height - 2; y += 1) {
    for (let x = 2; x < session.world.width - 2; x += 1) {
      if (session.world.canPlace(definition, { x, y }, 0)) return { x, y };
    }
  }
  throw new Error('no free anchor');
};

/** Places a stall with its colour record in ONE batch (colour before placing), or without one in the twin. */
const placeWithColour = (session: ParkSession, painted: boolean): void => {
  edit(session, () => {
    session.world.batch(() => {
      const placed = session.world.buildObject('fizz-foundry', freeAnchor(session, 'fizz-foundry'));
      if (!placed) throw new Error('could not place the stall');
      if (painted) session.world.setObjectColours(placed.id, [19, 6]);
    });
  });
};

const schedule = (session: ParkSession, tick: number, random: () => number): void => {
  const ids = colourableIds(session);
  if (tick === 1) {
    edit(session, () => {
      session.world.setGateColours([19, null, 13]);
      session.world.setObjectColours(ids[0], colourSlotsFor(session.world.objects.get(ids[0])!.definitionId).map(() => 19));
      session.world.setObjectColours(ids[1], colourSlotsFor(session.world.objects.get(ids[1])!.definitionId).map((_, index) => (index === 0 ? 4 : null)));
      session.world.setObjectColours(ids[2], colourSlotsFor(session.world.objects.get(ids[2])!.definitionId).map((_, index) => (index === 1 ? 13 : null)));
    });
  }
  if (tick === 500) recolourEvery(session, random);
  if (tick === 700) edit(session, () => { session.world.setGateColours(randomGate(random)); });
  if (tick === 800) edit(session, () => { session.world.applyPresetToPark('seaside'); });
  if (tick === 1200) edit(session, () => { session.world.applyPresetToPark('midnight'); });
  if (tick === 1500) {
    edit(session, () => { ids.forEach((id, index) => { if (index % 2 === 0) session.world.clearObjectColours(id); }); });
  }
  if (tick === 2000) edit(session, () => { session.world.applyPresetToPark('candy'); });
  if (tick === 2500) recolourEvery(session, random);
  if (tick === 2600) edit(session, () => { session.world.clearGateColours(); });
  if (tick === 2700) edit(session, () => { session.world.applyPresetToPark(COLOUR_PRESETS[4].id); });
};

const runTwins = (make: () => ParkSession, steps: number, placeAt?: number): void => {
  const plain = make();
  const painted = make();
  const random = lcg(0x5eed);
  const eventsPlain: string[] = [];
  const eventsPainted: string[] = [];
  let sawColours = false;
  for (let tick = 0; tick <= steps; tick += 1) {
    if (tick === placeAt) { placeWithColour(plain, false); placeWithColour(painted, true); }
    schedule(painted, tick, random);
    sawColours ||= painted.world.gateColours !== null || [...painted.world.objects.values()].some((object) => object.colours !== undefined);
    if (tick % 50 === 0 || tick === steps) {
      const left = plain.serialize();
      const right = painted.serialize();
      expect(simulationHashes(painted), `owners at tick ${tick}`).toEqual(simulationHashes(plain));
      expect(hashState(withoutColours(right) as never), `world without colours at tick ${tick}`).toBe(hashState(withoutColours(left) as never));
      expect(painted.world.version, `version at tick ${tick}`).toBe(plain.world.version);
      expect(painted.world.pathVersion).toBe(plain.world.pathVersion);
      expect(painted.world.cash).toBe(plain.world.cash);
      const coloured = right.world.gateColours !== undefined || right.world.objects.some((object) => object.colours !== undefined);
      if (coloured) expect(hashState(right.world), `a coloured world hashes differently at tick ${tick}`).not.toBe(hashState(left.world));
      else expect(hashState(right.world), `an uncoloured twin hashes the same at tick ${tick}`).toBe(hashState(left.world));
    }
    eventsPlain.push(JSON.stringify(plain.step(GAME_CONFIG.fixedStepMs)));
    eventsPainted.push(JSON.stringify(painted.step(GAME_CONFIG.fixedStepMs)));
  }
  expect(sawColours).toBe(true);
  expect(plain.guests.guests.size, 'the park really ran with guests').toBeGreaterThan(30);
  expect(plain.world.tick).toBe(steps + 1);
  expect(plain.rides.rides.size).toBeGreaterThanOrEqual(3);
  expect([...plain.rides.rides.values()].some((ride) => ride.completedCycles > 0), 'rides completed cycles').toBe(true);
  expect(eventsPainted).toEqual(eventsPlain);
  expect(hashState(painted.serialize().guests)).toBe(hashState(plain.serialize().guests));
  // Recolouring is free: no recolour ever posted a transaction (the twins' ledgers are equal).
  expect(painted.world.transactions.map((t) => [t.amount, t.label, t.category])).toEqual(plain.world.transactions.map((t) => [t.amount, t.label, t.category]));
  expect(painted.world.cash).toBe(plain.world.cash);
};

const devPark = (): ParkSession => {
  const session = new ParkSession(null);
  const report = seedDevPark(session);
  if (report.skipped.length > 0) throw new Error(`dev park skipped ${report.skipped.join(', ')}`);
  session.syncWithWorld();
  session.guests.spawnGuests(250);
  return session;
};

/** Every colourable kind on the map: the dev park plus a Comet Trail, a Skyline Serpent and a fountain. */
const colourTestPark = (): ParkSession => {
  const session = new ParkSession(null);
  const report = seedColourTestPark(session);
  if (report.problems.length > 0) throw new Error(`colour test park: ${report.problems.join(', ')}`);
  session.syncWithWorld();
  session.guests.spawnGuests(250);
  return session;
};

const scenarioPark = (): ParkSession => {
  const session = new ParkSession(SCENARIO_BY_ID.get('garden-gala')!, ['hungry-tourists', 'lean-crew', 'grand-opening']);
  edit(session, () => {
    const cells = [];
    for (let y = 27; y >= 12; y -= 1) cells.push({ x: 15, y });
    session.world.buildPaths(cells);
    // Starter objects are free, so the park has enough rides whatever the scenario's budget.
    for (const definitionId of ['petal-roundabout', 'moonpetal-carousel', 'comet-cups', 'aurora-wheel', 'picnic-pocket']) {
      let placed = false;
      for (let y = 26; y >= 6 && !placed; y -= 1) placed = session.world.seedScenarioObject(definitionId, { x: 16, y }) !== null;
      if (!placed) throw new Error(`scenario fixture could not place ${definitionId}`);
    }
  });
  session.operations.hireStaff('cleaner');
  return session;
};

describe('colours never reach the simulation', () => {
  it('the developer park, 3,000 steps: a recoloured twin has identical owners, world (minus colours) and events', () => {
    runTwins(devPark, 3000);
  }, 120_000);

  it('the colour test park (every colourable kind, three coasters), gate, presets and place-with-colour, 3,000 steps: the same', () => {
    const kinds = new Set([...colourTestPark().world.objects.values()].map((object) => colourKindOf(object.definitionId)));
    expect([...kinds].filter((kind) => kind !== null).sort()).toEqual(['coaster', 'comfort', 'ride', 'scenery', 'stall']);
    runTwins(colourTestPark, 3000, 700);
  }, 120_000);

  it('a scenario park, 3,000 steps: the same', () => {
    expect(colourableIds(scenarioPark()).length).toBeGreaterThanOrEqual(3);
    runTwins(scenarioPark, 3000);
  }, 120_000);
});

describe('syncing after a recolour is a no-op for every owner', () => {
  it('serialize() does not need a sync after a recolour (colours do not move version) and a sync changes nothing', () => {
    const session = devPark();
    for (let tick = 0; tick < 200; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
    const id = colourableIds(session)[0];
    expect(session.world.setObjectColours(id, colourSlotsFor(session.world.objects.get(id)!.definitionId).map((_, index) => 3 + index)).ok).toBe(true);
    const before = ownerHashes(session.serialize());
    delete before.world;
    session.syncWithWorld();
    const after = ownerHashes(session.serialize());
    delete after.world;
    expect(after).toEqual(before);
    for (let tick = 0; tick < 100; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
  });
});

describe('colours are world state: hash and save', () => {
  it('two identical parks differing by one recolour differ in the world owner hash and in no other owner', () => {
    const a = devPark();
    const b = devPark();
    for (let tick = 0; tick < 100; tick += 1) { a.step(GAME_CONFIG.fixedStepMs); b.step(GAME_CONFIG.fixedStepMs); }
    expect(ownerHashes(a.serialize())).toEqual(ownerHashes(b.serialize()));
    const target = colourableIds(b)[0];
    b.world.setObjectColours(target, colourSlotsFor(b.world.objects.get(target)!.definitionId).map((_, index) => (index === 0 ? 19 : null)));
    const left = ownerHashes(a.serialize());
    const right = ownerHashes(b.serialize());
    expect(right.world).not.toBe(left.world);
    delete left.world;
    delete right.world;
    expect(right).toEqual(left);
  });

  it('an uncoloured park serializes without any colours key (so its schema-5 state hash is unchanged)', () => {
    const state = devPark().serialize();
    expect(JSON.stringify(state)).not.toContain('colours');
  });
});

describe('static guard: only the world, the colour content and the save layer know about colours', () => {
  const sources = import.meta.glob<string>(['../**/*.ts', '!../**/*.test.ts', '!../**/*.testSupport.ts'], { query: '?raw', import: 'default', eager: true });
  const allowed = (path: string): boolean => (
    path === '../World.ts' || path === '../types.ts' || path.startsWith('./') // the save directory itself
    || path.startsWith('../content/colour') // the colour content: slots, presets, cost
    || path === '../session/colourTestPark.ts' // test support: seeds a park for the renderer and UI tests
  );

  it('no simulation source reads a colour record, appearanceVersion or the colour content', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    const pattern = /\.colours\b|appearanceVersion|appearanceCounter|ObjectColours|content\/colours/;
    const offenders = Object.entries(sources).filter(([path, text]) => !allowed(path) && pattern.test(text)).map(([path]) => path);
    expect(offenders).toEqual([]);
  });
});
