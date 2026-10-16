import { describe, expect, it } from 'vitest';
import { SAVE_CONTENT_VERSION, SAVE_SCHEMA_VERSION, SaveError, createParkSave, invalidState, contentDriftOf } from './version';
import { SAVE_MIGRATIONS, assertMigrationChain, migrateSave, parseSaveText, readSchemaVersion, type SaveMigration } from './migrate';
import { hashState } from './hash';
import type { ParkSaveV7 } from './state';

const catchSaveError = (action: () => unknown): SaveError => {
  try {
    action();
  } catch (error) {
    expect(error, 'a SaveError was thrown').toBeInstanceOf(SaveError);
    return error as SaveError;
  }
  throw new Error('expected a SaveError');
};

/** A fake historical shape: schema 0 stored the tick as `tick` and cash inside state. */
const fakeV0Save = () => ({
  schemaVersion: 0,
  tick: 42,
  contentVersion: 1,
  savedAtEpochMs: 0,
  scenarioId: null,
  state: { cash: 100, world: { tick: 42 } },
  app: { speed: 2 },
});

/** A complete, correctly hashed current-schema envelope around a minimal state. */
const currentSave = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const state = { world: { tick: 1 }, scenarioId: null, mode: 'sandbox' };
  return {
    schemaVersion: SAVE_SCHEMA_VERSION, contentVersion: 1, savedAtTick: 1, savedAtEpochMs: 0, scenarioId: null, mode: 'sandbox',
    stateHash: hashState(state),
    app: { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, state,
    ...overrides,
  };
};

const fakeV0ToV1: SaveMigration = {
  from: 0,
  to: 1,
  description: 'rename tick to savedAtTick and move app speed into a clock',
  migrate: (save) => {
    const { tick, app, ...rest } = save as { tick: number; app: { speed: number } } & Record<string, unknown>;
    return { ...rest, schemaVersion: 1, savedAtTick: tick, app: { clock: { speed: app.speed, simulationTimeMs: 0 }, tourNodeId: null } };
  },
};

const fakeV1ToV2: SaveMigration = {
  from: 1,
  to: 2,
  description: 'add a contentVersion',
  migrate: (save) => ({ ...save, schemaVersion: 2, contentVersion: 1 }),
};

describe('versions', () => {
  it('is at schema 15 with the First Day, calendar, weather, lift hill, colour, gate colour, map, recipe, game-mode, run, one-shot ledger, crowd field, land and guest life migrations, content version 6', () => {
    expect(SAVE_SCHEMA_VERSION, 'schema').toBe(15);
    expect(SAVE_CONTENT_VERSION, 'content (2: weather and the arrival curve; 3: Phase 16 content and the two ruleset keys; 4: Phase 14 crowdFeedback; 5: Phase 29 guest life; 6: Phase 39 coaster families)').toBe(6);
    expect(SAVE_MIGRATIONS.map((migration) => [migration.from, migration.to]), 'fourteen migrations').toEqual([[1, 2], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9], [9, 10], [10, 11], [11, 12], [12, 13], [13, 14], [14, 15]]);
    expect(() => assertMigrationChain(SAVE_MIGRATIONS), 'the shipped chain is consistent').not.toThrow();
  });
});

describe('createParkSave', () => {
  it('stamps versions and header fields from the state', () => {
    const state = { scenarioId: 'penny-lane', world: { tick: 77 } } as unknown as ParkSaveV7;
    const save = createParkSave(state, { clock: { speed: 1, simulationTimeMs: 7700 }, tourNodeId: 'opener' }, 1_700_000_000_000);
    expect(save.schemaVersion, 'schema stamped').toBe(SAVE_SCHEMA_VERSION);
    expect(save.contentVersion, 'content stamped').toBe(SAVE_CONTENT_VERSION);
    expect(save.savedAtTick, 'tick from the world').toBe(77);
    expect(save.scenarioId, 'scenario copied to the header').toBe('penny-lane');
    expect(save.savedAtEpochMs, 'caller supplied wall clock').toBe(1_700_000_000_000);
    expect(save.app.tourNodeId, 'tour node kept as metadata').toBe('opener');
  });
});

describe('readSchemaVersion', () => {
  it('reads the version and rejects anything that is not a save', () => {
    expect(readSchemaVersion({ schemaVersion: 3 }), 'valid').toBe(3);
    for (const bad of [null, 'text', 5, [], {}, { schemaVersion: '1' }, { schemaVersion: 1.5 }, { schemaVersion: -1 }]) {
      expect(catchSaveError(() => readSchemaVersion(bad)).code, `rejects ${JSON.stringify(bad)}`).toBe('not-a-save');
    }
  });
});

describe('assertMigrationChain', () => {
  it('accepts a contiguous chain ending at the latest version and rejects gaps, overlaps and big steps', () => {
    expect(() => assertMigrationChain([fakeV0ToV1, fakeV1ToV2], 2), 'contiguous').not.toThrow();
    expect(() => assertMigrationChain([fakeV0ToV1], 2), 'does not reach latest').toThrow(/ends at 1/);
    expect(() => assertMigrationChain([fakeV0ToV1, { ...fakeV1ToV2, from: 2, to: 3 }], 3), 'gap').toThrow(/gap/);
    expect(() => assertMigrationChain([{ ...fakeV0ToV1, to: 2 }], 2), 'step of two').toThrow(/exactly one/);
  });
});

describe('migrateSave', () => {
  it('returns a current save untouched and as a private copy', () => {
    const current = currentSave() as { state: { world: { tick: number } } };
    const migrated = migrateSave(current);
    expect(migrated, 'equal content').toEqual(current);
    expect(migrated, 'but a copy').not.toBe(current);
    (migrated.state as unknown as { world: { tick: number } }).world.tick = 99;
    expect(current.state.world.tick, 'mutating the result never touches the input').toBe(1);
  });

  it('migrates a fake v0 fixture to v1 without mutating the stored original', () => {
    const stored = fakeV0Save();
    const frozen = JSON.stringify(stored);
    const migrated = migrateSave(stored, { migrations: [fakeV0ToV1], latestVersion: 1 });
    expect(migrated.schemaVersion, 'now version 1').toBe(1);
    expect(migrated.savedAtTick, 'tick renamed').toBe(42);
    expect(migrated.app.clock, 'speed moved into a clock').toEqual({ speed: 2, simulationTimeMs: 0 });
    expect(JSON.stringify(stored), 'input untouched').toBe(frozen);
    expect(migrated.stateHash, 'the hash is recomputed for the migrated shape').toBe(hashState(migrated.state));
  });

  it('runs a chain in order through several versions', () => {
    const migrated = migrateSave(fakeV0Save(), { migrations: [fakeV0ToV1, fakeV1ToV2], latestVersion: 2 });
    expect(migrated.schemaVersion, 'reaches the latest').toBe(2);
    expect(migrated.contentVersion, 'second step applied after the first').toBe(1);
    expect(migrated.savedAtTick, 'first step applied').toBe(42);
  });

  it('refuses a save from a newer build and never downgrades', () => {
    const error = catchSaveError(() => migrateSave({ schemaVersion: SAVE_SCHEMA_VERSION + 1 }));
    expect(error.code, 'too-new').toBe('too-new');
    expect(error.message, 'message says what to do').toMatch(/newer version/);
  });

  it('reports no-migration-path when the chain has no step for the stored version', () => {
    expect(catchSaveError(() => migrateSave(fakeV0Save(), { migrations: [], latestVersion: 1 })).code, 'no path')
      .toBe('no-migration-path');
    expect(catchSaveError(() => migrateSave(fakeV0Save())).code, 'real chain has no v0 either').toBe('no-migration-path');
  });

  it('wraps a throwing migration and a migration that lies about its version', () => {
    const throwing: SaveMigration = { from: 0, to: 1, description: 'explodes', migrate: () => { throw new Error('boom'); } };
    const liar: SaveMigration = { from: 0, to: 1, description: 'lies', migrate: (save) => ({ ...save, schemaVersion: 0 }) };
    const thrown = catchSaveError(() => migrateSave(fakeV0Save(), { migrations: [throwing], latestVersion: 1 }));
    expect(thrown.code, 'migration-failed').toBe('migration-failed');
    expect(thrown.message, 'names the migration and cause').toMatch(/explodes.*boom/);
    expect(catchSaveError(() => migrateSave(fakeV0Save(), { migrations: [liar], latestVersion: 1 })).code, 'liar caught')
      .toBe('migration-failed');
  });

  it('rejects a save that is not plain data or lacks its envelope keys as corrupt', () => {
    expect(catchSaveError(() => migrateSave({ schemaVersion: 1, state: { f: () => 1 } })).code, 'function inside').toBe('corrupt');
    expect(catchSaveError(() => migrateSave({ schemaVersion: 1 })).code, 'missing keys').toBe('corrupt');
  });
});

describe('save integrity and envelope validation', () => {
  it('createParkSave stamps a hash that migrateSave verifies', () => {
    const state = { scenarioId: null, mode: 'sandbox', world: { tick: 5 }, guests: { guests: [1, 2, 3] } } as unknown as ParkSaveV7;
    const save = createParkSave(state, { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0);
    expect(save.stateHash, 'hash of the state').toBe(hashState(state));
    expect(() => migrateSave(JSON.parse(JSON.stringify(save))), 'a faithful copy passes').not.toThrow();
  });

  it('refuses a save from which an array element was removed, or whose hash is missing', () => {
    const state = { scenarioId: null, world: { tick: 5 }, guests: { guests: [1, 2, 3] } } as unknown as ParkSaveV7;
    const save = JSON.parse(JSON.stringify(createParkSave(state, { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 0))) as {
      state: { guests: { guests: number[] } };
      stateHash?: string;
    };
    save.state.guests.guests.pop();
    const truncated = catchSaveError(() => migrateSave(save));
    expect(truncated.code, 'a shorter array is damage, not a smaller park').toBe('corrupt');
    expect(truncated.message, 'says why').toMatch(/integrity/);
    delete save.stateHash;
    expect(catchSaveError(() => migrateSave(save)).code, 'no hash').toBe('corrupt');
  });

  it('validates the envelope fields the caller hands to the clock and the tour', () => {
    const bad: Array<[string, Record<string, unknown>]> = [
      ['unknown clock speed', { app: { clock: { speed: 'fast', simulationTimeMs: 0 }, tourNodeId: null } }],
      ['speed 3', { app: { clock: { speed: 3, simulationTimeMs: 0 }, tourNodeId: null } }],
      ['negative simulation time', { app: { clock: { speed: 1, simulationTimeMs: -5 }, tourNodeId: null } }],
      ['no clock', { app: { tourNodeId: null } }],
      ['unknown tour node', { app: { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: 'nowhere' } }],
      ['savedAtTick differs from the world tick', { savedAtTick: 2 }],
      ['scenario header differs from the state', { scenarioId: 'penny-lane' }],
      ['mode header differs from the state', { mode: 'scenario' }],
      ['mode header is not a mode', { mode: 'creative' }],
      ['no mode header', { mode: undefined }],
      ['contentVersion 0', { contentVersion: 0 }],
      ['contentVersion fractional', { contentVersion: 1.5 }],
      ['savedAtEpochMs NaN-like', { savedAtEpochMs: -1 }],
    ];
    for (const [label, overrides] of bad) {
      expect(catchSaveError(() => migrateSave(currentSave(overrides))).code, label).toBe('corrupt');
    }
    expect(() => migrateSave(currentSave({ app: { clock: { speed: 4, simulationTimeMs: 900 }, tourNodeId: 'finale' } })), 'a valid app part').not.toThrow();
  });

  it('re-checks plain data on the output of a migration', () => {
    const emitsUndefined: SaveMigration = {
      from: 0, to: 1, description: 'leaves an undefined behind',
      migrate: (save) => ({ ...save, schemaVersion: 1, savedAtTick: 42, app: { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, state: { world: { tick: 42 }, a: undefined } }),
    };
    const emitsNaN: SaveMigration = {
      from: 0, to: 1, description: 'emits NaN',
      migrate: (save) => ({ ...save, schemaVersion: 1, savedAtTick: Number.NaN, app: { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null } }),
    };
    expect(catchSaveError(() => migrateSave(fakeV0Save(), { migrations: [emitsUndefined], latestVersion: 1 })).code, 'undefined').toBe('corrupt');
    expect(catchSaveError(() => migrateSave(fakeV0Save(), { migrations: [emitsNaN], latestVersion: 1 })).code, 'NaN').toBe('corrupt');
  });

  it('parseSaveText turns unreadable text into a corrupt SaveError and passes valid JSON through', () => {
    expect(parseSaveText('{"a":1}'), 'valid JSON').toEqual({ a: 1 });
    const truncated = catchSaveError(() => parseSaveText('{"schemaVersion":1,"state":{"world":'));
    expect(truncated.code, 'truncated text').toBe('corrupt');
    expect(catchSaveError(() => parseSaveText('')).code, 'empty').toBe('corrupt');
  });

  it('reports content drift without refusing the save', () => {
    expect(contentDriftOf({ contentVersion: SAVE_CONTENT_VERSION }), 'same').toBe('none');
    expect(contentDriftOf({ contentVersion: SAVE_CONTENT_VERSION + 1 }), 'newer content').toBe('newer');
    expect(SAVE_CONTENT_VERSION, 'this build is above zero').toBeGreaterThan(0);
  });
});

describe('invalidState', () => {
  it('builds an invalid-state error naming the owner and the path', () => {
    const error = invalidState('GuestSimulation', 'guests[3].routeIndex', 'must be within the route');
    expect(error.code, 'code').toBe('invalid-state');
    expect(error.message, 'owner and path in the message').toBe(
      'GuestSimulation cannot restore: guests[3].routeIndex must be within the route',
    );
  });
});
