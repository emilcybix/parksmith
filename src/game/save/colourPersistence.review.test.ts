import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from '../content/catalog';
import {
  COLOUR_SWATCHES,
  RIDE_COLOUR_SLOTS,
  colourSlotsFor,
  isColourable,
  normaliseObjectColours,
  validateObjectColours,
} from '../content/colours';
import { GAME_CONFIG } from '../config';
import { ParkSession } from '../session/ParkSession';
import { seedDevPark } from '../session/devPark';
import { GameWorld } from '../World';
import { ownerHashes } from './determinismHarness';
import { hashState } from './hash';
import type { ParkSaveV7 } from './state';
import { SaveError, createParkSave } from './version';
import { migrateSave } from './migrate';
import { sessionFromSave } from '../session/fromSave';

/**
 * Phase 28 step 1, adversarial review of persistence, determinism and simulation independence.
 *
 * What the builder tests already pin is not repeated. This file adds:
 * - a recolour on EVERY tick for 3,000 ticks while guests ride, including a save and load in the
 *   middle, against a twin that is never recoloured: simulation-observable state, event streams and
 *   the world without colours stay identical, while appearanceVersion counts each real change once;
 * - a recolour never leaks into the catalog, the slot table, another object or a caller's array;
 * - demolish, rebuild on the same cells, and restore of the pre-demolish state;
 * - a save round trip keeps the envelope hash, and the normaliser only ever produces records the
 *   strict world API accepts (cosmetic undo feeds one into the other);
 * - duplicate JSON keys and a very large hostile record, without a hang.
 */

const STEP = GAME_CONFIG.fixedStepMs;

const lcg = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

const devPark = (): ParkSession => {
  const session = new ParkSession(null);
  const report = seedDevPark(session);
  if (report.skipped.length > 0) throw new Error(`dev park skipped ${report.skipped.join(', ')}`);
  session.syncWithWorld();
  session.guests.spawnGuests(250);
  return session;
};

const colourableIds = (session: ParkSession): number[] => (
  [...session.world.objects.values()].filter((object) => isColourable(object.definitionId)).map((object) => object.id)
);

/** Simulation-observable state: every owner except the world, plus the world with the colour records stripped. */
const observable = (session: ParkSession): Record<string, string> => {
  const state = session.serialize();
  const hashes = ownerHashes(state);
  const world = structuredClone(state.world);
  for (const object of world.objects) delete object.colours;
  hashes.world = hashState(world);
  return hashes;
};

const coloursOf = (session: ParkSession): Record<number, readonly (number | null)[] | null> => {
  const result: Record<number, readonly (number | null)[] | null> = {};
  for (const id of colourableIds(session)) result[id] = session.world.objectColours(id);
  return result;
};

const saveAndLoad = (session: ParkSession): ParkSession => {
  const save = createParkSave(session.serialize(), { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0);
  return sessionFromSave(JSON.parse(JSON.stringify(save))).session;
};

describe('a recolour on every tick never reaches the simulation', () => {
  it('3,000 ticks of recolours while guests ride, with a save and load at tick 1,500, match a twin that is never recoloured', () => {
    const plain = devPark();
    let painted = devPark();
    const random = lcg(0xc0105);
    const ids = colourableIds(painted);
    expect(ids.length, 'every colourable ride of the dev park').toBeGreaterThanOrEqual(10);

    let notifications = 0;
    let unsubscribe = painted.world.subscribe(() => { notifications += 1; });
    let appearanceBase = painted.world.appearanceVersion;
    let changedEdits = 0;
    let maxRiders = 0;
    const eventsPlain: string[] = [];
    const eventsPainted: string[] = [];

    for (let tick = 0; tick < 3000; tick += 1) {
      // One to three edits per tick: a random record, a single-slot change, or a reset.
      const edits = 1 + Math.floor(random() * 3);
      for (let edit = 0; edit < edits; edit += 1) {
        const id = ids[Math.floor(random() * ids.length)];
        const slots = colourSlotsFor(painted.world.objects.get(id)!.definitionId);
        const roll = random();
        const result = roll < 0.1
          ? painted.world.clearObjectColours(id)
          : painted.world.setObjectColours(id, slots.map(() => (random() < 0.2 ? null : Math.floor(random() * COLOUR_SWATCHES.length))));
        expect(result.ok).toBe(true);
        if (result.ok && result.changed) changedEdits += 1;
      }
      // What GameApp's world listener does after every notification.
      painted.syncWithWorld();

      if (tick === 1500) {
        const before = coloursOf(painted);
        const versionBefore = painted.world.version;
        unsubscribe();
        expect(painted.world.appearanceVersion - appearanceBase, 'appearanceVersion counts each real change exactly once').toBe(changedEdits);
        expect(notifications, 'one notification per real change, none for a no-op').toBe(changedEdits);
        painted = saveAndLoad(painted);
        expect(coloursOf(painted), 'the save carried every record').toEqual(before);
        expect(painted.world.version, 'restore keeps the saved version').toBe(versionBefore);
        notifications = 0;
        changedEdits = 0;
        appearanceBase = painted.world.appearanceVersion;
        unsubscribe = painted.world.subscribe(() => { notifications += 1; });
      }

      if (tick % 100 === 0) {
        expect(observable(painted), `simulation-observable state at tick ${tick}`).toEqual(observable(plain));
        expect(painted.world.version).toBe(plain.world.version);
        expect(painted.world.pathVersion).toBe(plain.world.pathVersion);
      }
      eventsPlain.push(JSON.stringify(plain.step(STEP)));
      eventsPainted.push(JSON.stringify(painted.step(STEP)));
      let riders = 0;
      for (const ride of plain.rides.rides.values()) riders += ride.riderGuestIds.length;
      maxRiders = Math.max(maxRiders, riders);
    }
    unsubscribe();

    expect(painted.world.appearanceVersion - appearanceBase).toBe(changedEdits);
    expect(notifications).toBe(changedEdits);
    expect(maxRiders, 'guests were really riding while the rides were repainted').toBeGreaterThan(5);
    expect(eventsPainted, 'the step event streams are identical').toEqual(eventsPlain);
    const left = plain.serialize();
    const right = painted.serialize();
    expect(observable(painted)).toEqual(observable(plain));
    expect(hashState(right.guests), 'guests').toBe(hashState(left.guests));
    expect(hashState(right.management), 'finances and ratings').toBe(hashState(left.management));
    expect(hashState(right.rides), 'ride runtime').toBe(hashState(left.rides));
    expect(right.world.cash).toBe(left.world.cash);
    expect(right.world.objects.some((object) => object.colours !== undefined), 'the painted twin really holds colours').toBe(true);
    expect(hashState(right.world), 'colours ARE world state').not.toBe(hashState(left.world));
  }, 240_000);
});

describe('a recolour never leaks', () => {
  it('into the catalog, the slot table, another object of the same definition, or a caller array', () => {
    const world = new GameWorld(200_000);
    const a = world.buildObject('comet-cups', { x: 3, y: 3 })!;
    const b = world.buildObject('comet-cups', { x: 9, y: 3 })!;
    const catalogBefore = JSON.stringify(BUILD_BY_ID.get('comet-cups'));
    const slotsBefore = JSON.stringify(RIDE_COLOUR_SLOTS);
    expect(Object.isFrozen(RIDE_COLOUR_SLOTS['comet-cups'])).toBe(true);
    expect(Object.isFrozen(COLOUR_SWATCHES[0])).toBe(true);

    const input: (number | null)[] = [5, 6];
    world.setObjectColours(a.id, input);
    input[0] = 0;
    input.push(1);
    expect(world.objectColours(a.id)).toEqual([5, 6]);
    expect(world.objectColours(b.id), 'the sibling stays at defaults').toBeNull();
    expect(JSON.stringify(BUILD_BY_ID.get('comet-cups'))).toBe(catalogBefore);
    expect(JSON.stringify(RIDE_COLOUR_SLOTS)).toBe(slotsBefore);

    const record = world.objectColours(a.id) as (number | null)[];
    expect(() => { record[0] = 1; }, 'the stored record is frozen').toThrow();

    const state = world.serialize();
    state.objects.find((object) => object.id === a.id)!.colours![0] = 7;
    expect(world.objectColours(a.id), 'a serialize() copy does not alias the live record').toEqual([5, 6]);

    // Restore copies too: editing the state afterwards changes nothing live.
    const other = new GameWorld(200_000);
    const saved = world.serialize();
    other.restore(saved);
    saved.objects.find((object) => object.id === a.id)!.colours![1] = 9;
    expect(other.objectColours(a.id)).toEqual([5, 6]);
    expect(other.objectColours(b.id)).toBeNull();
  });
});

describe('demolish, rebuild and restore', () => {
  it('a bulldozed ride takes its record with it, a rebuild on the same cells starts at defaults, and restoring the old state brings it back', () => {
    const world = new GameWorld(200_000);
    const ride = world.buildObject('aurora-wheel', { x: 6, y: 6 })!;
    world.setObjectColours(ride.id, [1, 2, 3]);
    const before = world.serialize();

    const appearance = world.appearanceVersion;
    expect(world.bulldoze(ride.anchor).removed).toBe(true);
    expect(world.objectColours(ride.id)).toBeNull();
    expect(world.appearanceVersion, 'a bulldoze is a version change, not a recolour').toBe(appearance);
    expect(JSON.stringify(world.serialize())).not.toContain('colours');

    const rebuilt = world.buildObject('aurora-wheel', { x: 6, y: 6 })!;
    expect(rebuilt.id).not.toBe(ride.id);
    expect(world.objectColours(rebuilt.id), 'a new ride on the same cells never inherits a record').toBeNull();

    world.restore(JSON.parse(JSON.stringify(before)) as typeof before);
    expect(world.objectColours(ride.id)).toEqual([1, 2, 3]);
    expect(world.objects.has(rebuilt.id)).toBe(false);
    expect(world.appearanceVersion).toBeGreaterThan(appearance);
  });
});

describe('save round trip', () => {
  it('a recoloured park keeps its envelope hash through JSON, and a reload re-serializes byte for byte', () => {
    const session = devPark();
    for (let tick = 0; tick < 120; tick += 1) session.step(STEP);
    const ids = colourableIds(session);
    ids.forEach((id, index) => {
      const slots = colourSlotsFor(session.world.objects.get(id)!.definitionId);
      session.world.setObjectColours(id, slots.map((_slot, slot) => (index + slot * 5) % COLOUR_SWATCHES.length));
    });
    session.syncWithWorld();
    const state = session.serialize();
    const save = createParkSave(state, { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0);
    const text = JSON.stringify(save);
    const migrated = migrateSave(JSON.parse(text));
    expect(migrated.stateHash).toBe(save.stateHash);
    const loaded = sessionFromSave(JSON.parse(text)).session;
    expect(hashState(loaded.serialize())).toBe(save.stateHash);
    expect(JSON.stringify(loaded.serialize())).toBe(JSON.stringify(state));
    for (const id of ids) expect(Object.isFrozen(loaded.world.objectColours(id))).toBe(true);
  });

  it('whatever the normaliser keeps, the strict API accepts unchanged (cosmetic undo feeds one into the other)', () => {
    const random = lcg(77);
    const pool: unknown[] = [null, undefined, -1, 0, 1, 20, 21, 1.5, '3', true, {}, [], 1e9, -0, Number.NaN];
    for (const definitionId of Object.keys(RIDE_COLOUR_SLOTS)) {
      for (let round = 0; round < 300; round += 1) {
        const length = Math.floor(random() * 7);
        const raw = Array.from({ length }, () => (random() < 0.5 ? Math.floor(random() * 24) - 1 : pool[Math.floor(random() * pool.length)]));
        const normalised = normaliseObjectColours(definitionId, raw);
        if (normalised === null) continue;
        expect(validateObjectColours(definitionId, normalised), `${definitionId} ${JSON.stringify(raw)}`).toEqual(normalised);
      }
    }
  });
});

describe('hostile JSON shapes', () => {
  const baseSave = () => {
    const session = devPark();
    const id = colourableIds(session).find((candidate) => session.world.objects.get(candidate)!.definitionId === 'comet-cups')!;
    session.world.setObjectColours(id, [4, 5]);
    session.syncWithWorld();
    const save = createParkSave(session.serialize(), { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0);
    return { id, text: JSON.stringify(save), hash: save.stateHash };
  };

  /** Re-stamps the hash of a JSON text whose parse differs from its text (duplicate keys): the hash covers the parse. */
  const restamp = (text: string, oldHash: string): string => {
    const parsed = JSON.parse(text) as { state: unknown };
    return text.replace(`"stateHash":"${oldHash}"`, `"stateHash":"${hashState(parsed.state)}"`);
  };

  it('a duplicated colours key: JSON keeps the last one, which is then validated like any record', () => {
    const { id, text, hash } = baseSave();
    const needle = '"colours":[4,5]';
    expect(text.split(needle).length - 1).toBe(1);
    const lastWins = restamp(text.replace(needle, '"colours":[1,2],"colours":[99,-3]'), hash);
    expect(sessionFromSave(JSON.parse(lastWins)).session.world.objectColours(id), 'the last (hostile) one, normalised').toBeNull();
    const lastValid = restamp(text.replace(needle, '"colours":[99,-3],"colours":[7,null]'), hash);
    expect(sessionFromSave(JSON.parse(lastValid)).session.world.objectColours(id)).toEqual([7, null]);
  });

  it('a duplicated colours key without a re-stamped hash is still an integrity failure only if the parse changed', () => {
    const { text } = baseSave();
    const changed = text.replace('"colours":[4,5]', '"colours":[4,5],"colours":[6,5]');
    expect(() => sessionFromSave(JSON.parse(changed))).toThrow(SaveError);
    const same = text.replace('"colours":[4,5]', '"colours":[9,9],"colours":[4,5]');
    expect(() => sessionFromSave(JSON.parse(same)), 'the parse is identical, so is the hash').not.toThrow();
  });

  it('a one-million-entry record loads, normalises to the slot count and does not hang', () => {
    const { id, text, hash } = baseSave();
    const huge = `[${new Array<string>(1_000_000).fill('3').join(',')}]`;
    const started = performance.now();
    const loaded = sessionFromSave(JSON.parse(restamp(text.replace('"colours":[4,5]', `"colours":${huge}`), hash))).session;
    expect(loaded.world.objectColours(id)).toEqual([3, 3]);
    expect(performance.now() - started, 'linear, not quadratic').toBeLessThan(20_000);
    expect(JSON.stringify(loaded.serialize().world.objects.find((object) => object.id === id))).toContain('"colours":[3,3]');
  }, 60_000);

  it('colours on owners that are not the world are ignored on load and gone after a re-save', () => {
    const { text, hash } = baseSave();
    const parsed = JSON.parse(text) as { state: ParkSaveV7 };
    (parsed.state.rides.rides[0] as unknown as { colours: number[] }).colours = [1, 2];
    expect(parsed.state.world.coasters.length, 'the dev park has a coaster').toBeGreaterThan(0);
    (parsed.state.world.coasters[0].pieces[0] as unknown as { colours: number[] }).colours = [1, 2];
    const tampered = restamp(JSON.stringify(parsed), hash);
    const loaded = sessionFromSave(JSON.parse(tampered)).session;
    const resaved = loaded.serialize();
    expect(JSON.stringify(resaved.rides)).not.toContain('colours');
    expect(JSON.stringify(resaved.world.coasters)).not.toContain('colours');
  });
});

describe('the frozen v5 fixtures', () => {
  it('load with every ride at defaults and keep their simulation equal to a never-coloured run', () => {
    // Raw import so the test reads the file as stored, not a module-cached object someone mutated.
    const sources = import.meta.glob<string>('./fixtures/park-v5-*.json', { query: '?raw', import: 'default', eager: true });
    expect(Object.keys(sources).sort()).toEqual(['./fixtures/park-v5-sandbox-rides.json', './fixtures/park-v5-scenario.json']);
    for (const [name, text] of Object.entries(sources)) {
      expect(text.includes('colours'), `${name} predates colours`).toBe(false);
      const raw = JSON.parse(text) as { schemaVersion: number; stateHash: string };
      expect(raw.schemaVersion).toBe(5);
      const { session } = sessionFromSave(JSON.parse(text));
      for (const object of session.world.objects.values()) expect(session.world.objectColours(object.id), name).toBeNull();
      // Recolouring a loaded v5 park and running it changes nothing a guest can see.
      const twin = sessionFromSave(JSON.parse(text)).session;
      for (const id of colourableIds(twin)) {
        twin.world.setObjectColours(id, colourSlotsFor(twin.world.objects.get(id)!.definitionId).map(() => 13));
      }
      twin.syncWithWorld();
      for (let tick = 0; tick < 300; tick += 1) {
        expect(JSON.stringify(twin.step(STEP))).toBe(JSON.stringify(session.step(STEP)));
      }
      expect(observable(twin), name).toEqual(observable(session));
    }
  }, 60_000);
});
