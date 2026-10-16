import { describe, expect, it } from 'vitest';
import { BUILD_BY_ID } from '../content/catalog';
import { COLOUR_PRESETS } from '../content/colourPresets';
import {
  COLOUR_SWATCHES,
  ENTRANCE_COLOUR_ID,
  colourKindOf,
  colourSlotsFor,
  isColourable,
  type ObjectColours,
} from '../content/colours';
import { GAME_CONFIG } from '../config';
import { ParkSession } from '../session/ParkSession';
import { seedColourTestPark } from '../session/colourTestPark';
import { GameWorld, type ColourEdit } from '../World';
import { ownerHashes } from './determinismHarness';
import { hashState } from './hash';
import type { ParkSaveV7 } from './state';
import { SaveError, createParkSave } from './version';
import { sessionFromSave } from '../session/fromSave';

/**
 * Phase 28 step 2, adversarial review of persistence and determinism for the NEW colourable kinds (coasters,
 * stalls and facilities, comforts, scenery, the gate). The builder tests already pin scheduled recolours on the
 * colour test park; this file adds what they do not:
 *
 * - a recolour of EVERY kind (coasters included) on EVERY tick for 3,000 ticks, through the strict API, the paint
 *   batch and whole-park presets, with a save and load taken while a coaster is mid-cycle, against a twin that is
 *   never recoloured;
 * - hostile edit batches through the world API (wrong lengths, junk, the gate pseudo id as an object, huge arrays)
 *   are refused per edit without a hang and change nothing else;
 * - colour keys smuggled onto records that are not placed objects (coaster records, transactions)
 *   are ignored on load and gone after a re-save;
 * - the gate pseudo id can never be a placed object.
 */

const STEP = GAME_CONFIG.fixedStepMs;

const lcg = (seed: number) => {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
};

const colourTestPark = (): ParkSession => {
  const session = new ParkSession(null);
  const report = seedColourTestPark(session);
  if (report.problems.length > 0) throw new Error(`colour test park: ${report.problems.join(', ')}`);
  session.syncWithWorld();
  session.guests.spawnGuests(250);
  return session;
};

const colourableIds = (session: ParkSession): number[] => (
  [...session.world.objects.values()].filter((object) => isColourable(object.definitionId)).map((object) => object.id)
);

/** Every owner hash, with the world's colour records (objects and gate) stripped. */
const observable = (session: ParkSession): Record<string, string> => {
  const state = session.serialize();
  const hashes = ownerHashes(state);
  const world = structuredClone(state.world);
  for (const object of world.objects) delete object.colours;
  delete world.gateColours;
  hashes.world = hashState(world);
  return hashes;
};

const allColours = (session: ParkSession): { objects: Record<number, ObjectColours | null>; gate: ObjectColours | null } => {
  const objects: Record<number, ObjectColours | null> = {};
  for (const id of colourableIds(session)) objects[id] = session.world.objectColours(id);
  return { objects, gate: session.world.gateColours };
};

const saveAndLoad = (session: ParkSession): ParkSession => {
  const save = createParkSave(session.serialize(), { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0);
  return sessionFromSave(JSON.parse(JSON.stringify(save))).session;
};

const coasterIds = (session: ParkSession): number[] => (
  [...session.world.objects.values()].filter((object) => colourKindOf(object.definitionId) === 'coaster').map((object) => object.id)
);

const randomRecord = (definitionId: string, random: () => number): (number | null)[] => (
  colourSlotsFor(definitionId).map(() => (random() < 0.25 ? null : Math.floor(random() * COLOUR_SWATCHES.length)))
);

describe('review: every colourable kind recoloured on every tick never reaches the simulation', () => {
  it('3,000 ticks, coasters included, with a save and load while a coaster is mid-cycle, match a never-recoloured twin', () => {
    const plain = colourTestPark();
    let painted = colourTestPark();
    const random = lcg(0x28c0de);
    const ids = colourableIds(painted);
    const kinds = new Set(ids.map((id) => colourKindOf(painted.world.objects.get(id)!.definitionId)));
    expect([...kinds].sort()).toEqual(['coaster', 'comfort', 'ride', 'scenery', 'stall']);
    const coasters = coasterIds(painted);
    expect(coasters.length).toBeGreaterThanOrEqual(3);

    let savedAt = -1;
    let coasterCycles = 0;
    const eventsPlain: string[] = [];
    const eventsPainted: string[] = [];
    for (let tick = 0; tick < 3000; tick += 1) {
      const roll = random();
      if (roll < 0.05) {
        painted.world.applyPresetToPark(COLOUR_PRESETS[Math.floor(random() * COLOUR_PRESETS.length)].id);
      } else if (roll < 0.25) {
        // A paint gesture: several objects and maybe the gate, one batch.
        const edits: ColourEdit[] = [];
        for (let n = 0; n < 4; n += 1) {
          const id = ids[Math.floor(random() * ids.length)];
          edits.push({ objectId: id, colours: random() < 0.2 ? null : randomRecord(painted.world.objects.get(id)!.definitionId, random) });
        }
        if (random() < 0.5) edits.push({ gate: true, colours: random() < 0.2 ? null : randomRecord(ENTRANCE_COLOUR_ID, random) });
        expect(painted.world.recolourBatch(edits).refused).toEqual([]);
      } else {
        // Always at least one coaster per tick, plus one other object.
        const coaster = coasters[tick % coasters.length];
        expect(painted.world.setObjectColours(coaster, randomRecord(painted.world.objects.get(coaster)!.definitionId, random)).ok).toBe(true);
        const other = ids[Math.floor(random() * ids.length)];
        expect(painted.world.setObjectColours(other, randomRecord(painted.world.objects.get(other)!.definitionId, random)).ok).toBe(true);
      }
      painted.syncWithWorld();

      const midCycle = coasters.some((id) => {
        const ride = painted.rides.rides.get(id);
        return ride !== undefined && ride.status === 'running' && ride.riderGuestIds.length > 0;
      });
      if (savedAt < 0 && tick >= 1500 && midCycle) {
        const before = allColours(painted);
        const versionBefore = painted.world.version;
        painted = saveAndLoad(painted);
        expect(allColours(painted), 'the save carried every record, the gate too').toEqual(before);
        expect(painted.world.version).toBe(versionBefore);
        savedAt = tick;
      }

      if (tick % 100 === 0) {
        expect(observable(painted), `simulation-observable state at tick ${tick}`).toEqual(observable(plain));
        expect(painted.world.version).toBe(plain.world.version);
      }
      eventsPlain.push(JSON.stringify(plain.step(STEP)));
      eventsPainted.push(JSON.stringify(painted.step(STEP)));
    }
    for (const id of coasters) coasterCycles += plain.rides.rides.get(id)?.completedCycles ?? 0;
    expect(savedAt, 'a coaster was running with riders when the park was saved').toBeGreaterThanOrEqual(1500);
    expect(coasterCycles, 'the coasters really ran').toBeGreaterThan(0);
    expect(eventsPainted).toEqual(eventsPlain);
    expect(observable(painted)).toEqual(observable(plain));
    expect(painted.world.cash).toBe(plain.world.cash);
    expect(painted.world.transactions.length, 'a recolour through the world posts nothing').toBe(plain.world.transactions.length);
  }, 300_000);
});

describe('review: hostile edits through the world API are refused per edit and never hang', () => {
  const world = (): { world: GameWorld; ids: Record<string, number> } => {
    const session = new ParkSession(null);
    seedColourTestPark(session);
    const ids: Record<string, number> = {};
    for (const object of session.world.objects.values()) ids[object.definitionId] ??= object.id;
    return { world: session.world, ids };
  };

  it('wrong slot counts, junk entries, unknown ids, a tree and a million-entry array: refused, the rest applied, one notification', () => {
    const { world: w, ids } = world();
    const huge = new Array(1_000_000).fill(1);
    let notifications = 0;
    w.subscribe(() => { notifications += 1; });
    const version = w.version;
    const started = performance.now();
    const result = w.recolourBatch([
      { objectId: ids['comet-trail'], colours: [1, 2, 3] },
      { objectId: ids['comet-trail'], colours: [1, 2, 3, 4, 5] },
      { objectId: ids['picnic-pocket'], colours: [1, 'x' as never] },
      { objectId: ids['ribbon-bench'], colours: [-1, 2] },
      { objectId: ids['ripple-fountain'], colours: [21] },
      { objectId: ids['confetti-tree'], colours: [1] },
      { objectId: 999_999, colours: [1] },
      { objectId: ids['lollipop-lamp'], colours: huge },
      { gate: true, colours: [1, 2] },
      { gate: true, colours: huge },
      { objectId: ids['sunburst-flowers'], colours: [4, 5] },
    ]);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(result.refused.map((entry) => [entry.index, entry.reason])).toEqual([
      [0, 'invalid-colours'], [1, 'invalid-colours'], [2, 'invalid-colours'], [3, 'invalid-colours'], [4, 'invalid-colours'],
      [5, 'not-colourable'], [6, 'unknown-object'], [7, 'invalid-colours'], [8, 'invalid-colours'], [9, 'invalid-colours'],
    ]);
    expect(result.changedObjectIds).toEqual([ids['sunburst-flowers']]);
    expect(result.changedCount).toBe(1);
    expect(notifications).toBe(1);
    expect(w.version, 'a recolour never moves version').toBe(version);
    for (const id of ['comet-trail', 'picnic-pocket', 'ribbon-bench', 'ripple-fountain', 'lollipop-lamp']) expect(w.objectColours(ids[id]), id).toBeNull();
    expect(w.gateColours).toBeNull();
  });

  it('a batch that is entirely refused does not notify and does not move appearanceVersion', () => {
    const { world: w, ids } = world();
    let notifications = 0;
    w.subscribe(() => { notifications += 1; });
    const appearance = w.appearanceVersion;
    const result = w.recolourBatch([{ objectId: ids['confetti-tree'], colours: [1] }, { gate: true, colours: [] }]);
    expect(result.changedCount).toBe(0);
    expect(notifications).toBe(0);
    expect(w.appearanceVersion).toBe(appearance);
  });

  it('the gate pseudo id is never a catalog id, so it can never be placed or carried by a placed object', () => {
    expect(BUILD_BY_ID.has(ENTRANCE_COLOUR_ID)).toBe(false);
    const session = new ParkSession(null);
    seedColourTestPark(session);
    const state = session.serialize() as ParkSaveV7;
    const object = state.world.objects[0];
    const forged = structuredClone(state);
    forged.world.objects[0] = { ...object, definitionId: ENTRANCE_COLOUR_ID, colours: [1, 2, 3] };
    const save = createParkSave(forged, { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0);
    expect(() => sessionFromSave(JSON.parse(JSON.stringify(save)))).toThrow(SaveError);
  });
});

describe('review: colour keys smuggled onto records that are not placed objects', () => {
  it('a coaster record and a transaction carrying colours load, are ignored and are gone after a re-save', () => {
    const session = new ParkSession(null);
    seedColourTestPark(session);
    session.syncWithWorld();
    const state = session.serialize() as ParkSaveV7;
    const forged = structuredClone(state) as unknown as {
      world: { coasters: Record<string, unknown>[]; transactions: Record<string, unknown>[]; objects: { colours?: unknown }[] };
      rules: Record<string, unknown>;
    };
    expect(forged.world.coasters.length).toBeGreaterThan(0);
    for (const record of forged.world.coasters) record.colours = [1, 2, 3, 4];
    if (forged.world.transactions[0]) forged.world.transactions[0].colours = [5];
    // (The rules are compared key for key with the session's ruleset, so an extra key there is refused like any
    // other rules tampering: not a colour policy, not tested here.)
    const save = createParkSave(forged as unknown as ParkSaveV7, { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0);
    const loaded = sessionFromSave(JSON.parse(JSON.stringify(save))).session;
    expect(loaded.world.gateColours).toBeNull();
    for (const id of coasterIds(loaded)) expect(loaded.world.objectColours(id), 'a coaster record is not the object').toBeNull();
    const again = JSON.stringify(loaded.serialize());
    expect(again).not.toMatch(/"colours"/);
    expect(again).not.toMatch(/"gateColours"/);
    expect(observable(loaded)).toEqual(observable(session));
  });
});
