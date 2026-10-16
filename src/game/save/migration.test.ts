import { describe, expect, it } from 'vitest';
import { COASTER_TYPE_BY_ID } from '../coaster/content';
import { coasterSpeedProfile, deriveCoasterStats } from '../coaster/design';
import { GAME_CONFIG } from '../config';
import { ParkSession, SANDBOX_SEED } from '../session/ParkSession';
import { mixSeed } from '../weather/random';
import { createWeatherView } from '../weather/types';
import { hashState } from './hash';
import { TO_SCHEMA_14 } from './schema14TestSupport';
import { SAVE_SCHEMA_VERSION, SaveError, createParkSave } from './version';
import { SAVE_MIGRATIONS, migrateSave } from './migrate';
import { sessionFromSave } from '../session/fromSave';

/** The frozen schema-8 state every migrated park gets (migration 7->8): the Meadow map. */
const MEADOW_MAP_V8 = {
  id: 'meadow',
  biomeId: 'meadow',
  width: 32,
  height: 32,
  entrance: { x: 15, y: 31, facing: 'north' },
  ground: Array.from({ length: 32 }, () => '................................'),
  props: [],
};
/** The same map after migration 8->9: the recipe key, last, null. */
const MEADOW_MAP_V9 = { ...MEADOW_MAP_V8, recipe: null };

/**
 * Schema 1 fixtures, captured with the code BEFORE the onboarding state existed (a populated
 * sandbox and a scenario park, both through createParkSave). They are the inputs of migration 1->2
 * and must never be regenerated.
 */
const fixtures = import.meta.glob<Record<string, unknown>>('./fixtures/*.json', { import: 'default', eager: true });
/** The old steps are frozen descriptions: their tests stop the chain at schema 9 (9 -> 10 has its own section). */
const migrateToV9 = (raw: unknown): ReturnType<typeof migrateSave> => migrateSave(raw, { latestVersion: 9 });
const fixture = (name: string): Record<string, unknown> => structuredClone(fixtures[`./fixtures/${name}`] ?? {});

describe('migration 1 -> 2 (First Day onboarding), then 2 -> 3 and 3 -> 4', () => {
  it('the fixtures really are schema 1 without an onboarding key', () => {
    for (const name of ['park-v1-sandbox.json', 'park-v1-scenario.json']) {
      const save = fixture(name) as { schemaVersion: number; state: Record<string, unknown> };
      expect(save.schemaVersion, name).toBe(1);
      expect('onboarding' in save.state, name).toBe(false);
    }
  });

  it('a sandbox park arrives with its hints already dismissed and an empty ledger', () => {
    const migrated = migrateToV9(fixture('park-v1-sandbox.json'));
    expect(migrated.schemaVersion).toBe(9);
    expect(migrated.state.onboarding).toEqual({ dismissed: true, completed: [], skipped: [], sawLitter: false });
    expect(migrated.stateHash, 'recomputed for the migrated shape').toBe(hashState(migrated.state));
  });

  it('a scenario park arrives with null onboarding', () => {
    const migrated = migrateToV9(fixture('park-v1-scenario.json'));
    expect(migrated.schemaVersion).toBe(9);
    expect(migrated.state.onboarding).toBeNull();
    expect(migrated.stateHash).toBe(hashState(migrated.state));
  });

  it('loads through fromSave into a session whose First Day tracker is dismissed (sandbox) or absent (scenario)', () => {
    const sandbox = sessionFromSave(fixture('park-v1-sandbox.json')).session;
    expect(sandbox.onboarding?.snapshot().dismissed).toBe(true);
    expect(sandbox.onboarding?.snapshot().active).toBe(false);
    expect(sessionFromSave(fixture('park-v1-scenario.json')).session.onboarding).toBeNull();
  });

  it('keeps every other part of the park byte for byte, and does not mutate the stored original', () => {
    const stored = fixture('park-v1-sandbox.json');
    const frozen = JSON.stringify(stored);
    const migrated = migrateToV9(stored);
    const rest = { ...(migrated.state as unknown as Record<string, unknown>) };
    expect(rest.map, 'schema 8 appends the Meadow map').toEqual(MEADOW_MAP_V9);
    delete rest.map;
    delete rest.onboarding;
    delete rest.calendar;
    delete rest.weather;
    const storedState = { ...(stored as { state: Record<string, unknown> }).state };
    // Migration 3->4 adds one rule key; every other rule is untouched.
    expect(rest.rules).toEqual({ ...(storedState.rules as Record<string, unknown>), wetWeatherMultiplier: 1, chainLiftCostMultiplier: 1, recolourCostMultiplier: 1 });
    delete rest.rules;
    delete storedState.rules;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(storedState));
    expect(JSON.stringify(stored), 'input untouched').toBe(frozen);
  });

  it('a schema 1 park walks the whole chain and arrives with the default calendar', () => {
    const migrated = migrateToV9(fixture('park-v1-sandbox.json'));
    expect(migrated.state.calendar).toEqual({ dayLengthSeconds: 720, anchorTick: 0, anchorUnits: 0, timeLock: 'auto', hoursEnabled: false, openHour: 8, closeHour: 21 });
  });

  it('a migrated park saves again at the current schema and reloads identically', () => {
    const { session } = sessionFromSave(fixture('park-v1-sandbox.json'));
    const state = session.serialize();
    expect(hashState(ParkSession.fromState(JSON.parse(JSON.stringify(state)) as typeof state).serialize())).toBe(hashState(state));
  });

  it('refuses a tampered schema-1 save by its schema-1 hash before migrating', () => {
    const tampered = fixture('park-v1-sandbox.json') as { state: { world: { cash: number } } };
    tampered.state.world.cash += 1;
    expect(() => migrateSave(tampered)).toThrow(SaveError);
  });

  it('keeps no-migration-path for schema 0 and too-new for the next schema', () => {
    const base = fixture('park-v1-sandbox.json');
    const code = (raw: unknown): string => {
      try { migrateSave(raw); } catch (error) { return (error as SaveError).code; }
      return 'none';
    };
    expect(code({ ...base, schemaVersion: 0 })).toBe('no-migration-path');
    expect(code({ ...base, schemaVersion: SAVE_SCHEMA_VERSION + 1 })).toBe('too-new');
  });
});

describe('migration 2 -> 3 (park calendar)', () => {
  const names = ['park-v2-sandbox.json', 'park-v2-scenario.json'];

  it('the fixtures really are schema 2 without a calendar key', () => {
    for (const name of names) {
      const save = fixture(name) as { schemaVersion: number; state: Record<string, unknown> };
      expect(save.schemaVersion, name).toBe(2);
      expect('calendar' in save.state, name).toBe(false);
    }
  });

  it('adds the default calendar anchored at tick 0 and keeps the rest of the park byte for byte', () => {
    for (const name of names) {
      const stored = fixture(name);
      const frozen = JSON.stringify(stored);
      const migrated = migrateToV9(stored);
      expect(migrated.schemaVersion, name).toBe(9);
      expect(migrated.state.calendar, name).toEqual({ dayLengthSeconds: 720, anchorTick: 0, anchorUnits: 0, timeLock: 'auto', hoursEnabled: false, openHour: 8, closeHour: 21 });
      expect(migrated.stateHash, name).toBe(hashState(migrated.state));
      const rest = { ...(migrated.state as unknown as Record<string, unknown>) };
      expect(rest.map, name).toEqual(MEADOW_MAP_V9);
      delete rest.map;
      delete rest.calendar;
      delete rest.weather;
      const storedState = { ...(stored as { state: Record<string, unknown> }).state };
      delete rest.rules;
      delete storedState.rules;
      expect(JSON.stringify(rest), name).toBe(JSON.stringify(storedState));
      expect(JSON.stringify(stored), 'input untouched').toBe(frozen);
    }
  });

  it('an old park keeps its age-derived time: day and clock are the same pure function a new park gets', () => {
    const { session, save } = sessionFromSave(fixture('park-v2-sandbox.json'));
    const view = session.calendarView();
    expect(save.savedAtTick).toBe(420);
    // 420 ticks of a 7200-tick day, starting at 06:00.
    expect(view.day).toBe(1);
    expect(view.hour).toBe(7);
    expect(view.minute).toBe(24);
    expect(session.calendar.isEditable).toBe(true);
    expect(sessionFromSave(fixture('park-v2-scenario.json')).session.calendar.isEditable).toBe(false);
  });

  it('a tampered schema-2 save is refused by its schema-2 hash', () => {
    const tampered = fixture('park-v2-sandbox.json') as { state: { world: { cash: number } } };
    tampered.state.world.cash += 1;
    expect(() => migrateSave(tampered)).toThrow(SaveError);
  });
});

describe('migration 3 -> 4 (weather, opening hours, wet weather rule)', () => {
  const names = ['park-v3-sandbox.json', 'park-v3-scenario.json', 'park-v3-sandbox-late.json'];

  it('the fixtures really are schema 3: no weather, no opening hours, no wet weather rule', () => {
    for (const name of names) {
      const save = fixture(name) as { schemaVersion: number; contentVersion: number; state: Record<string, unknown> };
      const state = save.state as { calendar: Record<string, unknown>; rules: Record<string, unknown> };
      expect(save.schemaVersion, name).toBe(3);
      expect(save.contentVersion, name).toBe(1);
      expect('weather' in save.state, name).toBe(false);
      expect('hoursEnabled' in state.calendar, name).toBe(false);
      expect('wetWeatherMultiplier' in state.rules, name).toBe(false);
    }
  });

  it('adds the three pieces with defaults, recomputes the hash and keeps the rest of the park byte for byte', () => {
    for (const name of names) {
      const stored = fixture(name) as { state: Record<string, unknown> };
      const frozen = JSON.stringify(stored);
      const migrated = migrateToV9(stored);
      const state = migrated.state as unknown as Record<string, unknown> & {
        rules: Record<string, unknown>;
        calendar: Record<string, unknown>;
        weather: Record<string, unknown>;
        seed: number;
      };
      expect(migrated.schemaVersion, name).toBe(9);
      expect(state.rules.wetWeatherMultiplier, name).toBe(1);
      expect(state.calendar, name).toMatchObject({ hoursEnabled: false, openHour: 8, closeHour: 21 });
      expect(state.weather, name).toEqual({
        enabled: true, severity: 'normal', rngState: mixSeed(state.seed), chainKind: 'sunny', firstDay: 1, days: [],
      });
      expect(migrated.stateHash, name).toBe(hashState(migrated.state));
      const rest = { ...state };
      const original = { ...stored.state } as Record<string, unknown> & { rules: Record<string, unknown>; calendar: Record<string, unknown> };
      expect({ ...state.rules, wetWeatherMultiplier: undefined, chainLiftCostMultiplier: undefined, recolourCostMultiplier: undefined }, name).toEqual({ ...original.rules, wetWeatherMultiplier: undefined, chainLiftCostMultiplier: undefined, recolourCostMultiplier: undefined });
      const calendar = { ...state.calendar };
      delete calendar.hoursEnabled; delete calendar.openHour; delete calendar.closeHour;
      expect(calendar, name).toEqual(original.calendar);
      for (const key of ['weather', 'rules', 'calendar', 'map']) { delete rest[key]; delete original[key]; }
      expect(JSON.stringify(rest), name).toBe(JSON.stringify(original));
      expect(JSON.stringify(stored), 'input untouched').toBe(frozen);
    }
  });

  it('the frozen seed mixer in the migration equals the live one (sandbox and scenario seeds)', () => {
    const seeds = [SANDBOX_SEED, 0x50a1_0101, 0, 1, 0xffffffff];
    const migration = SAVE_MIGRATIONS.find((step) => step.from === 3)!;
    const base = fixture('park-v3-sandbox.json') as { state: object };
    for (const seed of seeds) {
      const migrated = migration.migrate({ ...base, state: { ...base.state, seed } }) as { state: { weather: { rngState: number } } };
      expect(migrated.state.weather.rngState).toBe(mixSeed(seed));
    }
  });

  it('loads through fromSave: forecast is deterministic and equals a fresh session of the same seed and day', () => {
    for (const name of names) {
      const { session, save, contentDrift } = sessionFromSave(fixture(name));
      expect(contentDrift, 'old balance is reported').toBe('older');
      expect(session.weather.days.length, name).toBeGreaterThanOrEqual(3);
      const again = sessionFromSave(fixture(name)).session;
      expect(again.weatherForecast(), name).toEqual(session.weatherForecast());
      expect(JSON.stringify(again.weather.serialize()), name).toBe(JSON.stringify(session.weather.serialize()));
      // It continues from the park's own tick, not from day 1.
      expect(session.weatherViewInto(createWeatherView()).day).toBe(session.calendarView().day);
      expect(save.savedAtTick).toBe(session.world.tick);
    }
  });

  it('a late park draws from its own day: day 2 or later, with yesterday kept', () => {
    const { session } = sessionFromSave(fixture('park-v3-sandbox-late.json'));
    expect(session.calendarView().day).toBeGreaterThanOrEqual(2);
    expect(session.weather.firstDay).toBe(session.calendarView().day - 1);
    expect(session.weather.days.length).toBe(1 + 1 + 2);
  });

  it('the old scenario park keeps its fixed weather rules (weather on, normal severity, hours off) and its seed', () => {
    const { session } = sessionFromSave(fixture('park-v3-scenario.json'));
    expect(session.weather.enabled).toBe(true);
    expect(session.weather.severity).toBe('normal');
    expect(session.calendar.hoursEnabled).toBe(false);
    expect(session.setWeatherEnabled(false), 'still not editable').toBe(false);
  });

  it('a migrated park saves again at the current schema and reloads identically', () => {
    for (const name of names) {
      const { session } = sessionFromSave(fixture(name));
      const state = session.serialize();
      const reloaded = ParkSession.fromState(JSON.parse(JSON.stringify(state)) as typeof state).serialize();
      expect(hashState(reloaded), name).toBe(hashState(state));
    }
  });

  it('a tampered schema-3 save is refused by its schema-3 hash', () => {
    const tampered = fixture('park-v3-sandbox.json') as { state: { world: { cash: number } } };
    tampered.state.world.cash += 1;
    expect(() => migrateSave(tampered)).toThrow(SaveError);
  });

  it('the migrated park keeps playing: it steps without error and the weather stays covered', () => {
    const { session } = sessionFromSave(fixture('park-v3-sandbox.json'));
    for (let tick = 0; tick < 300; tick += 1) session.step(100);
    expect(session.weatherForecast().length).toBe(8);
  });
});

/**
 * Schema 4 fixtures, captured with the code BEFORE lift hills (`freeClimb`, the chain lift cost
 * rule) existed: a sandbox with three coasters (one mid-cycle) and a scenario park with cards.
 * They are the inputs of migration 4->5 and must never be regenerated.
 */
describe('migration 4 -> 5 (lift hills: every old piece is chained)', () => {
  const names = ['park-v4-sandbox-coaster.json', 'park-v4-scenario.json'];
  type Piece = Record<string, unknown>;
  const coastersOf = (save: Record<string, unknown>): Array<{ pieces: Piece[]; stats: Record<string, unknown> }> =>
    ((save.state as { world: { coasters: Array<{ pieces: Piece[]; stats: Record<string, unknown> }> } }).world.coasters);

  it('the fixtures really are schema 4 with no freeClimb key and no chain lift rule', () => {
    for (const name of names) {
      const save = fixture(name) as { schemaVersion: number; state: { rules: Record<string, unknown> } };
      expect(save.schemaVersion, name).toBe(4);
      expect(JSON.stringify(save), name).not.toContain('freeClimb');
      expect('chainLiftCostMultiplier' in save.state.rules, name).toBe(false);
    }
    expect(coastersOf(fixture('park-v4-sandbox-coaster.json')).length).toBeGreaterThanOrEqual(2);
  });

  it('adds the rule, keeps every piece chained and leaves the rest of the park byte for byte', () => {
    for (const name of names) {
      const stored = fixture(name);
      const frozen = JSON.stringify(stored);
      const migrated = migrateToV9(stored);
      expect(migrated.schemaVersion, name).toBe(9);
      expect(migrated.stateHash, name).toBe(hashState(migrated.state));
      const state = migrated.state as unknown as { rules: Record<string, unknown> };
      const original = (stored as { state: { rules: Record<string, unknown> } }).state;
      expect(state.rules, name).toEqual({ ...original.rules, chainLiftCostMultiplier: 1, recolourCostMultiplier: 1 });
      const withoutMap = { ...migrated.state } as unknown as Record<string, unknown>;
      expect(withoutMap.map, name).toEqual(MEADOW_MAP_V9);
      delete withoutMap.map;
      expect(JSON.stringify(withoutMap).replace(',"chainLiftCostMultiplier":1', '').replace(',"recolourCostMultiplier":1', ''), name)
        .toBe(JSON.stringify((stored as { state: unknown }).state));
      expect(JSON.stringify(stored), 'input untouched').toBe(frozen);
    }
  });

  it('drops a hand-edited freeClimb key: every old piece becomes chained', () => {
    const stored = fixture('park-v4-sandbox-coaster.json');
    for (const record of coastersOf(stored)) for (const piece of record.pieces) piece.freeClimb = true;
    // The hash covers the edited shape, so re-stamp it the way a hand-edit plus a fresh export would.
    (stored as { stateHash: string }).stateHash = hashState((stored as { state: never }).state);
    const migrated = migrateToV9(stored);
    for (const record of coastersOf(migrated as unknown as Record<string, unknown>)) {
      for (const piece of record.pieces) expect('freeClimb' in piece).toBe(false);
    }
  });

  it('a tampered schema-4 save is refused by its schema-4 hash', () => {
    const tampered = fixture('park-v4-sandbox-coaster.json') as { state: { world: { cash: number } } };
    tampered.state.world.cash += 1;
    expect(() => migrateSave(tampered)).toThrow(SaveError);
  });

  it('loads through fromSave with the saved stats untouched and the chained model still reproducing them', () => {
    const storedCoasters = coastersOf(fixture('park-v4-sandbox-coaster.json'));
    const { session } = sessionFromSave(fixture('park-v4-sandbox-coaster.json'));
    expect(session.rules.chainLiftCostMultiplier).toBe(1);
    const records = [...session.world.coasters.values()];
    expect(records.length).toBe(storedCoasters.length);
    records.forEach((record, index) => {
      expect(record.stats, 'saved stats win').toEqual(storedCoasters[index].stats);
      expect(record.pieces.every((piece) => piece.freeClimb === undefined)).toBe(true);
      const type = COASTER_TYPE_BY_ID.get(session.world.objects.get(record.objectId)!.definitionId)!;
      expect(coasterSpeedProfile(record.pieces).travelSeconds, 'chained numbers are unchanged').toEqual(record.stats.travelSeconds);
      expect(deriveCoasterStats(record.pieces, type), 'derived stats equal the stored ones').toEqual(record.stats);
    });
    const state = session.serialize();
    expect(hashState(ParkSession.fromState(JSON.parse(JSON.stringify(state)) as typeof state).serialize())).toBe(hashState(state));
  });

  it('the migrated park keeps running exactly like the same park loaded twice, 600 steps on', () => {
    const run = (): string => {
      const { session } = sessionFromSave(fixture('park-v4-sandbox-coaster.json'));
      for (let tick = 0; tick < 600; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
      return hashState(session.serialize());
    };
    expect(run()).toBe(run());
  });

  it('the migrated scenario park keeps its cards and loads', () => {
    const { session } = sessionFromSave(fixture('park-v4-scenario.json'));
    expect(session.activeCards.length).toBe(2);
    expect(session.rules.chainLiftCostMultiplier).toBe(1);
  });
});

/**
 * Schema 5 fixtures, captured with the code BEFORE colour customisation (Phase 28) existed: the
 * developer park (every flat ride, a coaster, services, scenery, staff, 400 ticks of guests) and a
 * scenario park with a ride. They are the inputs of migration 5->6 and must never be regenerated.
 */
describe('migration 5 -> 6 (colour customisation: every object keeps the default colours)', () => {
  const names = ['park-v5-sandbox-rides.json', 'park-v5-scenario.json'];
  type ObjectRecord = Record<string, unknown>;
  const objectsOf = (save: Record<string, unknown>): ObjectRecord[] => (
    (save.state as { world: { objects: ObjectRecord[] } }).world.objects
  );

  it('the fixtures really are schema 5, without any colours key', () => {
    for (const name of names) {
      const save = fixture(name) as { schemaVersion: number };
      expect(save.schemaVersion, name).toBe(5);
      expect(JSON.stringify(save), name).not.toContain('colours');
    }
    const ids = new Set(objectsOf(fixture('park-v5-sandbox-rides.json')).map((object) => object.definitionId));
    for (const id of ['petal-roundabout', 'comet-cups', 'cloud-hopper', 'aurora-wheel', 'moonpetal-carousel', 'bumble-coach', 'harbor-swings', 'splash-rings', 'gale-spinner', 'thunder-drum', 'star-chaser']) {
      expect(ids.has(id), `the sandbox fixture has a ${id}`).toBe(true);
    }
    expect(objectsOf(fixture('park-v5-scenario.json')).some((object) => object.definitionId === 'petal-roundabout')).toBe(true);
  });

  it('migrates to the current schema; no object has a record and the state is byte for byte the same', () => {
    for (const name of names) {
      const stored = fixture(name);
      const frozen = JSON.stringify(stored);
      const migrated = migrateToV9(stored);
      expect(migrated.schemaVersion, name).toBe(9);
      for (const object of objectsOf(migrated as unknown as Record<string, unknown>)) expect('colours' in object, name).toBe(false);
      // The chain continues 6->7, which adds the one rule key `recolourCostMultiplier`; nothing else changes.
      const expected = JSON.parse(JSON.stringify((stored as { state: { rules: Record<string, unknown> } }).state)) as { rules: Record<string, unknown> };
      expected.rules.recolourCostMultiplier = 1;
      (expected as Record<string, unknown>).map = MEADOW_MAP_V9;
      expect(JSON.stringify(migrated.state), `${name}: the state is unchanged but for the schema-7 rule and the schema-8 map`).toBe(JSON.stringify(expected));
      expect(migrated.stateHash, `${name}: an uncoloured park hashes as the same state plus the new rule`).toBe(hashState(expected));
      expect(migrated.stateHash, name).toBe(hashState(migrated.state));
      expect(JSON.stringify(stored), 'input untouched').toBe(frozen);
    }
  });

  it('drops a hand-edited colours key (a v5 save cannot carry colours)', () => {
    const stored = fixture('park-v5-sandbox-rides.json');
    for (const object of objectsOf(stored)) object.colours = [1, 2];
    (stored as { stateHash: string }).stateHash = hashState((stored as { state: never }).state);
    const migrated = migrateToV9(stored);
    for (const object of objectsOf(migrated as unknown as Record<string, unknown>)) expect('colours' in object).toBe(false);
    const { session } = sessionFromSave(stored);
    for (const object of session.world.objects.values()) expect(session.world.objectColours(object.id)).toBeNull();
  });

  it('loads through fromSave with every ride on defaults, and serialize() equals the migrated state', () => {
    for (const name of names) {
      const migrated = migrateSave(fixture(name));
      const { session } = sessionFromSave(fixture(name));
      for (const object of session.world.objects.values()) expect(object.colours, name).toBeUndefined();
      expect(session.serialize(), name).toEqual(migrated.state);
      expect(hashState(session.serialize()), name).toBe(migrated.stateHash);
    }
  });

  it('a migrated park can be recoloured, saved at the current schema, and reloaded with its colours', () => {
    const { session } = sessionFromSave(fixture('park-v5-sandbox-rides.json'));
    const ride = [...session.world.objects.values()].find((object) => object.definitionId === 'aurora-wheel')!;
    expect(session.world.setObjectColours(ride.id, [19, null, 6]).ok).toBe(true);
    const state = session.serialize();
    const envelope = createParkSave(state, { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0);
    expect(envelope.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    const reloaded = sessionFromSave(JSON.parse(JSON.stringify(envelope))).session;
    expect(reloaded.world.objectColours(ride.id)).toEqual([19, null, 6]);
    expect(hashState(reloaded.serialize())).toBe(hashState(state));
  });

  it('a tampered schema-5 save is refused by its schema-5 hash', () => {
    const tampered = fixture('park-v5-sandbox-rides.json') as { state: { world: { cash: number } } };
    tampered.state.world.cash += 1;
    expect(() => migrateSave(tampered)).toThrow(SaveError);
  });

  it('the migrated park keeps running exactly like the same park loaded twice, 600 steps on', () => {
    const run = (): string => {
      const { session } = sessionFromSave(fixture('park-v5-sandbox-rides.json'));
      for (let tick = 0; tick < 600; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
      return hashState(session.serialize());
    };
    expect(run()).toBe(run());
  });

  it('the migrated scenario park keeps its cards and loads', () => {
    const { session } = sessionFromSave(fixture('park-v5-scenario.json'));
    expect(session.activeCards.length, 'cards are truncated to the scenario slots').toBe(2);
    expect(session.scenarioDefinition?.id).toBe('garden-gala');
  });
});

/**
 * Schema 6 fixtures, captured with the code BEFORE colour customisation step 2 (the gate colours and the
 * recolour cost rule): the developer park with a colour record on every flat ride, and a scenario park.
 * They are the inputs of migration 6->7 and must never be regenerated.
 */
describe('migration 6 -> 7 (gate colours and the recolour cost rule)', () => {
  const names = ['park-v6-sandbox-colours.json', 'park-v6-scenario.json'];
  type ObjectRecord = Record<string, unknown>;
  const objectsOf = (save: Record<string, unknown>): ObjectRecord[] => (
    (save.state as { world: { objects: ObjectRecord[] } }).world.objects
  );

  it('the fixtures really are schema 6: coloured rides, no gate record, no recolour rule', () => {
    for (const name of names) {
      const save = fixture(name) as { schemaVersion: number; state: { rules: Record<string, unknown>; world: Record<string, unknown> } };
      expect(save.schemaVersion, name).toBe(6);
      expect('recolourCostMultiplier' in save.state.rules, name).toBe(false);
      expect('gateColours' in save.state.world, name).toBe(false);
    }
    const coloured = objectsOf(fixture('park-v6-sandbox-colours.json')).filter((object) => 'colours' in object);
    expect(coloured.length).toBe(12);
    expect(new Set(coloured.map((object) => object.definitionId)).size, 'every flat ride has its own record').toBe(10);
    expect(objectsOf(fixture('park-v6-scenario.json')).some((object) => 'colours' in object)).toBe(false);
  });

  it('migrates to the current schema adding exactly the rule; every record and everything else is kept byte for byte', () => {
    for (const name of names) {
      const stored = fixture(name);
      const frozen = JSON.stringify(stored);
      const migrated = migrateToV9(stored);
      expect(migrated.schemaVersion, name).toBe(9);
      expect(migrated.state.rules.recolourCostMultiplier, name).toBe(1);
      expect(migrated.state.world.gateColours, name).toBeUndefined();
      const expected = JSON.parse(JSON.stringify((stored as { state: { rules: Record<string, unknown> } }).state)) as { rules: Record<string, unknown> };
      expected.rules.recolourCostMultiplier = 1;
      (expected as Record<string, unknown>).map = MEADOW_MAP_V9;
      expect(JSON.stringify(migrated.state), name).toBe(JSON.stringify(expected));
      expect(migrated.stateHash, name).toBe(hashState(migrated.state));
      expect(JSON.stringify(stored), 'input untouched').toBe(frozen);
    }
  });

  it('drops a hand-edited gateColours (a v6 save cannot carry a gate record) and keeps the object records', () => {
    const stored = fixture('park-v6-sandbox-colours.json') as { stateHash: string; state: { world: Record<string, unknown> } };
    stored.state.world.gateColours = [1, 2, 3];
    stored.stateHash = hashState(stored.state as never);
    const migrated = migrateToV9(stored);
    expect('gateColours' in migrated.state.world).toBe(false);
    expect(objectsOf(migrated as unknown as Record<string, unknown>).filter((object) => 'colours' in object).length).toBe(12);
    const { session } = sessionFromSave(stored);
    expect(session.world.gateColours).toBeNull();
  });

  it('loads through fromSave: recoloured rides kept, gate default, multiplier 1; serialize() equals the migrated state', () => {
    for (const name of names) {
      const migrated = migrateSave(fixture(name));
      const { session } = sessionFromSave(fixture(name));
      expect(session.world.gateColours, name).toBeNull();
      expect(session.rules.recolourCostMultiplier, name).toBe(1);
      expect(session.serialize(), name).toEqual(migrated.state);
      expect(hashState(session.serialize()), name).toBe(migrated.stateHash);
    }
    const { session } = sessionFromSave(fixture('park-v6-sandbox-colours.json'));
    const coloured = [...session.world.objects.values()].filter((object) => object.colours);
    expect(coloured.length).toBe(12);
    for (const object of coloured) expect(session.world.objectColours(object.id)).toEqual(object.colours);
  });

  it('a migrated park can colour a stall, a coaster and the gate, save at the current schema and reload with all of it', () => {
    const { session } = sessionFromSave(fixture('park-v6-sandbox-colours.json'));
    const find = (definitionId: string): number => [...session.world.objects.values()].find((object) => object.definitionId === definitionId)!.id;
    const stall = find('picnic-pocket');
    const coaster = find('star-chaser');
    const lamp = find('lollipop-lamp');
    expect(session.world.setObjectColours(stall, [19, 6]).ok).toBe(true);
    expect(session.world.setObjectColours(coaster, [null, 4, 12, 13]).ok).toBe(true);
    expect(session.world.setObjectColours(lamp, [null, 5]).ok).toBe(true);
    expect(session.world.setGateColours([1, null, 13]).ok).toBe(true);
    const state = session.serialize();
    const envelope = createParkSave(state, { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0);
    expect(envelope.schemaVersion).toBe(SAVE_SCHEMA_VERSION);
    const reloaded = sessionFromSave(JSON.parse(JSON.stringify(envelope))).session;
    expect(reloaded.world.objectColours(stall)).toEqual([19, 6]);
    expect(reloaded.world.objectColours(coaster)).toEqual([null, 4, 12, 13]);
    expect(reloaded.world.objectColours(lamp)).toEqual([null, 5]);
    expect(reloaded.world.gateColours).toEqual([1, null, 13]);
    expect(hashState(reloaded.serialize())).toBe(hashState(state));
  });

  it('a v6 record on a kind that became colourable in step 2 is kept (restore normalises it to the new slot table)', () => {
    const stored = fixture('park-v6-sandbox-colours.json') as { stateHash: string; state: { world: { objects: ObjectRecord[] } } };
    const objects = stored.state.world.objects;
    const stall = objects.find((object) => object.definitionId === 'picnic-pocket')!;
    const coaster = objects.find((object) => object.definitionId === 'star-chaser')!;
    stall.colours = [3, 4, 5];
    coaster.colours = [2];
    stored.stateHash = hashState(stored.state as never);
    const { session } = sessionFromSave(stored);
    expect(session.world.objectColours(stall.id as number)).toEqual([3, 4]);
    expect(session.world.objectColours(coaster.id as number)).toEqual([2, null, null, null]);
  });

  it('a tampered schema-6 save is refused by its schema-6 hash', () => {
    const tampered = fixture('park-v6-sandbox-colours.json') as { state: { world: { cash: number } } };
    tampered.state.world.cash += 1;
    expect(() => migrateSave(tampered)).toThrow(SaveError);
  });

  it('the migrated park plays exactly like the v5 original: colours and the new rule never change the simulation', () => {
    const strip = (state: unknown): string => {
      const copy = JSON.parse(JSON.stringify(state)) as { rules: Record<string, unknown>; world: { objects: ObjectRecord[]; gateColours?: unknown } };
      delete copy.rules.recolourCostMultiplier;
      delete copy.world.gateColours;
      for (const object of copy.world.objects) delete object.colours;
      return hashState(copy as never);
    };
    const play = (name: string): string => {
      const { session } = sessionFromSave(fixture(name));
      for (let tick = 0; tick < 600; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
      return strip(session.serialize());
    };
    // The v6 fixture is the v5 fixture's park with every flat ride recoloured afterwards.
    expect(play('park-v6-sandbox-colours.json')).toBe(play('park-v5-sandbox-rides.json'));
    expect(play('park-v6-sandbox-colours.json')).toBe(play('park-v6-sandbox-colours.json'));
  });

  it('the migrated scenario park keeps its cards and loads', () => {
    const { session } = sessionFromSave(fixture('park-v6-scenario.json'));
    expect(session.activeCards.length).toBe(2);
    expect(session.scenarioDefinition?.id).toBe('garden-gala');
  });
});

/**
 * Schema 7 fixtures, captured with the code BEFORE biomes and maps (Phase 24): the developer park (a recoloured
 * ride and gate), the First Day route mid-progress and a scenario park with a ride. They are the inputs of
 * migration 7->8 and must never be regenerated.
 */
describe('migration 7 -> 8 (biomes and maps: every old park is on the Meadow map)', () => {
  const names = ['park-v7-sandbox-devpark.json', 'park-v7-sandbox-firstday.json', 'park-v7-scenario.json'];
  const stateOf = (save: Record<string, unknown>): Record<string, unknown> => save.state as Record<string, unknown>;

  it('the fixtures really are schema 7: no map, no biome rule keys', () => {
    for (const name of names) {
      const save = fixture(name) as { schemaVersion: number; state: Record<string, unknown> & { rules: Record<string, unknown> } };
      expect(save.schemaVersion, name).toBe(7);
      expect('map' in save.state, name).toBe(false);
      expect('hungerRateMultiplier' in save.state.rules, name).toBe(false);
      expect('thirstRateMultiplier' in save.state.rules, name).toBe(false);
    }
  });

  it('migrates to the stored state plus the frozen Meadow map, appended last, and re-stamps the hash', () => {
    for (const name of names) {
      const stored = fixture(name);
      const frozen = JSON.stringify(stored);
      const migrated = migrateSave(stored, { latestVersion: 8 });
      expect(migrated.schemaVersion, name).toBe(8);
      const expected = JSON.parse(JSON.stringify(stateOf(stored))) as Record<string, unknown>;
      expected.map = MEADOW_MAP_V8;
      expect(JSON.stringify(migrated.state), name).toBe(JSON.stringify(expected));
      expect(Object.keys(migrated.state).at(-1), name).toBe('map');
      expect(migrated.stateHash, name).toBe(hashState(expected));
      expect(JSON.stringify(stored), 'input untouched').toBe(frozen);
      // The stored hash is the schema-7 hash of the same state minus the map: loading changed nothing else.
      const withoutMap = { ...migrated.state } as unknown as Record<string, unknown>;
      delete withoutMap.map;
      expect(hashState(withoutMap), name).toBe((stored as { stateHash: string }).stateHash);
    }
  });

  it('fromSave on a v7 park gives a Meadow Garden park whose serialize() is exactly the migrated state', () => {
    for (const name of names) {
      const { session, save } = sessionFromSave(fixture(name));
      expect(session.map.id, name).toBe('meadow');
      expect(session.map.biome.id).toBe('meadow');
      expect(session.world.entrance).toEqual({ x: 15, y: 31 });
      expect(session.world.props.size).toBe(0);
      expect(hashState(session.serialize()), name).toBe(save.stateHash);
    }
  });

  it('the migrated parks play 600 ticks, twice, identically (and continue exactly like the same park loaded twice)', () => {
    for (const name of names) {
      const run = (): string => {
        const { session } = sessionFromSave(fixture(name));
        for (let tick = 0; tick < 600; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
        return hashState(session.serialize());
      };
      expect(run(), name).toBe(run());
    }
  });

  it('drops a hand-edited map and hand-edited biome rule keys: a v7 save cannot carry them', () => {
    const stored = fixture('park-v7-scenario.json') as { stateHash: string; state: Record<string, unknown> & { rules: Record<string, unknown> } };
    stored.state.map = { id: 'red-rock-canyon', biomeId: 'desert-canyon', width: 1, height: 1, entrance: { x: 0, y: 0, facing: 'north' }, ground: [], props: [] };
    stored.state.rules.hungerRateMultiplier = 1.2;
    stored.state.rules.thirstRateMultiplier = 0.9;
    stored.stateHash = hashState(stored.state);
    const migrated = migrateToV9(stored);
    expect(migrated.state.map).toEqual(MEADOW_MAP_V9);
    expect('hungerRateMultiplier' in migrated.state.rules).toBe(false);
    expect('thirstRateMultiplier' in migrated.state.rules).toBe(false);
    expect(sessionFromSave(stored).session.map.id).toBe('meadow');
  });

  it('a tampered v7 save is refused by its integrity hash before any migration runs', () => {
    const stored = fixture('park-v7-sandbox-firstday.json') as { state: { world: { cash: number } } };
    stored.state.world.cash += 1;
    expect(() => migrateSave(stored)).toThrow(SaveError);
    try {
      migrateToV9(stored);
    } catch (error) {
      expect((error as SaveError).code).toBe('corrupt');
    }
  });

  it('the First Day fixture keeps its tutorial progress and its pacing-route park', () => {
    const { session } = sessionFromSave(fixture('park-v7-sandbox-firstday.json'));
    expect(session.onboarding).not.toBeNull();
    expect(session.world.objects.size).toBeGreaterThanOrEqual(5);
    expect(session.world.paths.size).toBeGreaterThan(10);
    const dev = sessionFromSave(fixture('park-v7-sandbox-devpark.json')).session;
    expect(dev.world.objects.size).toBeGreaterThan(50);
    expect(dev.world.gateColours).not.toBeNull();
  });
});

/**
 * Schema 8 fixtures (Phase 24 step 2), captured with the step-1 code BEFORE state.ts changed: a Meadow park with a ride, the OLD
 * Seaside Cove with a cleared palm, a path and a ride, a Red Rock Canyon park with two cleared boulders and a ride, and a
 * scenario park. They are the inputs of migration 8->9 and must never be regenerated.
 */
describe('migration 8 -> 9 (generated maps: the map gains a recipe, null for every hand-made map)', () => {
  const names = ['park-v8-sandbox-meadow.json', 'park-v8-sandbox-seaside-old.json', 'park-v8-sandbox-red-rock.json', 'park-v8-scenario.json'];
  type Envelope = { schemaVersion: number; stateHash: string; state: Record<string, unknown> & { map: Record<string, unknown> } };

  it('the fixtures really are schema 8: a map without a recipe', () => {
    for (const name of names) {
      const save = fixture(name) as unknown as Envelope;
      expect(save.schemaVersion, name).toBe(8);
      expect('recipe' in save.state.map, name).toBe(false);
      expect(Object.keys(save.state.map), name).toEqual(['id', 'biomeId', 'width', 'height', 'entrance', 'ground', 'props']);
    }
  });

  it('migrates to schema 9: map.recipe = null appended last inside map, everything else byte for byte, hash re-stamped', () => {
    for (const name of names) {
      const stored = fixture(name) as unknown as Envelope;
      const frozen = JSON.stringify(stored);
      const migrated = migrateToV9(stored);
      expect(migrated.schemaVersion, name).toBe(9);
      const expected = JSON.parse(JSON.stringify(stored.state)) as Envelope['state'];
      expected.map = { ...expected.map, recipe: null };
      expect(JSON.stringify(migrated.state), name).toBe(JSON.stringify(expected));
      expect(Object.keys(migrated.state.map).at(-1), name).toBe('recipe');
      expect(migrated.stateHash, name).toBe(hashState(expected));
      expect(JSON.stringify(stored), 'input untouched').toBe(frozen);
      // The stripped state (no `map`) hashes as it did at schema 8: nothing but the map moved.
      const strip = (state: unknown): unknown => { const copy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>; delete copy.map; return copy; };
      expect(hashState(strip(migrated.state)), name).toBe(hashState(strip(stored.state)));
    }
  });

  it('drops a hand-edited recipe: a v8 save cannot carry one', () => {
    const stored = fixture('park-v8-sandbox-meadow.json') as unknown as Envelope;
    stored.state.map.recipe = { generatorVersion: 1, biomeId: 'meadow', seed: 1, density: 'normal', water: true };
    stored.stateHash = hashState(stored.state);
    const migrated = migrateToV9(stored);
    expect(migrated.state.map.recipe).toBeNull();
    expect(sessionFromSave(stored).session.map.recipe).toBeNull();
  });

  it('fromSave gives the same park as at schema 8 (a null recipe), and serialize() is exactly the migrated state', () => {
    for (const name of names) {
      const { session, save } = sessionFromSave(fixture(name));
      expect(session.map.recipe, name).toBeNull();
      expect(hashState(session.serialize()), name).toBe(save.stateHash);
    }
  });

  it('the OLD Seaside Cove save restores its OLD land byte for byte (the refreshed map is content, the save holds the land it was played on)', () => {
    const stored = fixture('park-v8-sandbox-seaside-old.json') as unknown as Envelope;
    const { session } = sessionFromSave(fixture('park-v8-sandbox-seaside-old.json'));
    expect(session.map.id).toBe('seaside-cove');
    expect(session.map.name).toBe('Seaside Cove');
    const restored = session.world.serializeMap();
    expect(JSON.stringify(restored)).toBe(JSON.stringify({ ...stored.state.map, recipe: null }));
    // Old ground: 230 water tiles and 84 sand tiles, 66 props left after one cleared palm; none of the new kinds.
    const counts = { water: 0, alt: 0 };
    for (const cell of session.map.ground) { if (cell === 2) counts.water += 1; if (cell === 1) counts.alt += 1; }
    expect(counts).toEqual({ water: 230, alt: 84 });
    expect(session.world.props.size).toBe(66);
    expect([...session.world.props.values()].some((prop) => prop.kind === 'boardwalk-pier' || prop.kind === 'tide-rock')).toBe(false);
    // And it is NOT the refreshed map a fresh Seaside Cove park has.
    const fresh = new ParkSession(null, [], { mapId: 'seaside-cove' });
    expect(fresh.world.serializeMap().ground).not.toEqual(restored.ground);
  });

  it('the migrated parks play 600 ticks, twice, identically', () => {
    for (const name of names) {
      const run = (): string => {
        const { session } = sessionFromSave(fixture(name));
        for (let tick = 0; tick < 600; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
        return hashState(session.serialize());
      };
      expect(run(), name).toBe(run());
    }
  });

  it('a tampered v8 save is refused by its integrity hash before any migration runs', () => {
    const stored = fixture('park-v8-sandbox-red-rock.json') as unknown as Envelope & { state: { world: { cash: number } } };
    stored.state.world.cash += 1;
    expect(() => migrateSave(stored)).toThrow(SaveError);
  });
});

describe('migration 12 -> 13 (Neighborhoods & Crowd Flow: the optional crowd field)', () => {
  type V12Envelope = { schemaVersion: number; stateHash: string; state: Record<string, unknown> & { rules: Record<string, unknown> } };
  const names = ['park-v12-sandbox-themed.json', 'park-v12-scenario.json', 'park-v12-run-stage.json'];

  it('is a link of the chain (13 -> 14 follows, Phase 21, then 14 -> 15, Phase 29)', () => {
    expect(SAVE_SCHEMA_VERSION).toBe(15);
    expect(SAVE_MIGRATIONS.at(-3)).toMatchObject({ from: 12, to: 13 });
  });

  it('keeps every schema-12 park byte for byte (state and hash): no rule, no field, no feedback', () => {
    for (const name of names) {
      const stored = fixture(name) as unknown as V12Envelope;
      expect(stored.schemaVersion, name).toBe(12);
      const frozen = JSON.stringify(stored);
      const migrated = migrateSave(stored, TO_SCHEMA_14);
      expect(migrated.schemaVersion, name).toBe(14);
      expect(JSON.stringify(migrated.state), `${name} state byte for byte`).toBe(JSON.stringify(stored.state));
      expect(migrated.stateHash, name).toBe(stored.stateHash);
      expect('crowd' in migrated.state, name).toBe(false);
      expect('crowdFeedback' in migrated.state.rules, name).toBe(false);
      expect(JSON.stringify(stored), 'input untouched').toBe(frozen);
    }
  });

  it('drops a hand-edited crowd field and crowdFeedback key (a schema-12 build ignored both), keeping key order', () => {
    const stored = fixture('park-v12-sandbox-themed.json') as unknown as V12Envelope;
    const original = JSON.stringify(stored.state);
    stored.state.rules.crowdFeedback = 1;
    stored.state.crowd = { version: 1, pressure: [[5, 1024]] };
    stored.stateHash = hashState(stored.state);
    const migrated = migrateSave(stored, TO_SCHEMA_14);
    expect(JSON.stringify(migrated.state)).toBe(original);
    expect(migrated.stateHash).toBe(hashState(JSON.parse(original)));
  });

  it('a schema-16 save is too new', () => {
    const stored = fixture('park-v12-scenario.json') as unknown as V12Envelope;
    stored.schemaVersion = 16;
    expect(() => migrateSave(stored)).toThrow(/newer version/);
  });
});

describe('migration 14 -> 15 (Guest life & souvenirs: four fields on every guest)', () => {
  type Envelope = { schemaVersion: number; stateHash: string; state: Record<string, any> };
  const v13 = import.meta.glob<Record<string, unknown>>('./fixtures/v13/park-v13-*.json', { import: 'default', eager: true });
  const names = Object.keys(v13);

  it('is the last link of the chain', () => {
    expect(SAVE_MIGRATIONS.at(-1)).toMatchObject({ from: 14, to: 15 });
  });

  it('gives every saved guest no nausea, a comfortable warmth, no souvenirs and no activity, and changes nothing else', () => {
    expect(names.length).toBe(3);
    for (const name of names) {
      const stored = structuredClone(v13[name]) as unknown as Envelope;
      const frozen = JSON.stringify(stored);
      const at14 = migrateSave(stored, TO_SCHEMA_14) as unknown as Envelope;
      const at15 = migrateSave(stored) as unknown as Envelope;
      expect(at15.schemaVersion, name).toBe(15);
      const guests = at14.state.guests.guests as Array<Record<string, unknown>>;
      expect(guests.length, `${name} has guests to migrate`).toBeGreaterThan(0);
      expect(at15.state.guests.guests, name).toEqual(guests.map((guest) => ({ ...guest, nausea: 0, warmth: 50, souvenirs: 0, activity: null })));
      const { guests: _later, ...restLater } = at15.state;
      const { guests: _earlier, ...restEarlier } = at14.state;
      void _later;
      void _earlier;
      expect(JSON.stringify(restLater), `${name}: everything but the guests is byte for byte`).toBe(JSON.stringify(restEarlier));
      expect({ ...at15.state.guests, guests: [] }, name).toEqual({ ...at14.state.guests, guests: [] });
      expect(at15.stateHash, name).toBe(hashState(at15.state));
      expect(JSON.stringify(stored), 'input untouched').toBe(frozen);
    }
  });

  it('loads every schema-13 fixture through fromSave, and serialize() equals the migrated state', () => {
    for (const name of names) {
      const migrated = migrateSave(structuredClone(v13[name]));
      const { session } = sessionFromSave(structuredClone(v13[name]));
      expect(session.serialize(), name).toEqual(migrated.state);
    }
  });

  it('refuses a guest whose activity does not fit its state', () => {
    const stored = structuredClone(v13[names[0]]) as unknown as Envelope;
    const migrated = migrateSave(stored) as unknown as Envelope;
    const state = structuredClone(migrated.state);
    const guest = state.guests.guests[0] as Record<string, unknown>;
    guest.activity = guest.state === 'wandering' ? 'seatLeft' : 'cheer';
    expect(guest.state === 'wandering' || guest.state !== 'pausing', 'the activity is not one its state allows').toBe(true);
    expect(() => ParkSession.fromState(state as never)).toThrow(/activity/);
  });
});
