import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { rewardEligible } from '../profile/eligibility';
import { BONUSES } from '../profile/bonuses';
import { ParkSession } from '../session/ParkSession';
import { hashState } from './hash';
import { TO_SCHEMA_14 } from './schema14TestSupport';
import { SAVE_SCHEMA_VERSION, SaveError } from './version';
import { SAVE_MIGRATIONS, migrateSave } from './migrate';
import { sessionFromSave } from '../session/fromSave';

/**
 * Phase 23, schema 11: the run state in the save. The five schema-10 fixtures are frozen files captured from the schema-10
 * code BEFORE state.ts or version.ts changed; they must never be regenerated. Migration 10 -> 11 keeps every Sandbox and
 * Scenario park byte for byte, drops a hand-edited `run` key, and turns the interim Park Tour `run` park into a Scenario
 * park.
 */
const fixtures = import.meta.glob<Record<string, unknown>>('./fixtures/park-v10-*.json', { import: 'default', eager: true });
const fixture = (name: string): Record<string, any> => structuredClone(fixtures[`./fixtures/${name}`] ?? {}) as Record<string, any>;

const NAMES = [
  'park-v10-sandbox-meadow.json',
  'park-v10-sandbox-generated.json',
  'park-v10-scenario.json',
  'park-v10-run-tour.json',
  'park-v10-scenario-biome.json',
] as const;

/** hashState of each park after 600 ticks on the SCHEMA-10 code (a run-tour park with mode `run`). */
// Phase 29: re-pinned once (guest life — benches, pauses, nausea, warmth — changes how a loaded park plays on).
const AFTER_600: Record<(typeof NAMES)[number], string> = {
  'park-v10-sandbox-meadow.json': '0f418cd51724c334',
  'park-v10-sandbox-generated.json': 'b8294dafa0d57e58',
  'park-v10-scenario.json': 'f550874c839f2943',
  'park-v10-run-tour.json': '5bc474c8b4871626',
  'park-v10-scenario-biome.json': 'b17b13f11dcef104',
};

const step = (session: ParkSession, ticks: number): void => { for (let tick = 0; tick < ticks; tick += 1) session.step(GAME_CONFIG.fixedStepMs); };

describe('migration 10 -> 11 (the run state)', () => {
  it('the fixtures really are schema 10: a mode and a grant, no run', () => {
    for (const name of NAMES) {
      const save = fixture(name);
      expect(save.schemaVersion, name).toBe(10);
      expect(typeof save.mode, name).toBe('string');
      expect('run' in save.state, name).toBe(false);
      expect('grant' in save.state, name).toBe(true);
    }
    expect(fixture('park-v10-run-tour.json').mode).toBe('run');
    expect(fixture('park-v10-run-tour.json').app.tourNodeId).toBe('opener');
    expect(fixture('park-v10-scenario.json').state.grant.bonusIds).toEqual(['nest-egg', 'spare-slot']);
  });

  it('is a link of the chain, followed by 11 -> 12 (the one-shot ledger, see v11Fixtures.test.ts) and 12 -> 13 (Phase 14)', () => {
    expect(SAVE_SCHEMA_VERSION).toBe(17);
    expect(SAVE_MIGRATIONS.at(-7)).toMatchObject({ from: 10, to: 11 });
    expect(SAVE_MIGRATIONS.at(-6)).toMatchObject({ from: 11, to: 12 });
  });

  it('keeps every Sandbox and Scenario park byte for byte, and turns the interim Map park into a Scenario park', () => {
    for (const name of NAMES) {
      const stored = fixture(name);
      const frozen = JSON.stringify(stored);
      const migrated = migrateSave(stored, TO_SCHEMA_14);
      expect(migrated.schemaVersion, name).toBe(14);
      const expectedMode = name === 'park-v10-run-tour.json' ? 'scenario' : stored.mode;
      expect(migrated.mode, name).toBe(expectedMode);
      expect(migrated.state.mode, name).toBe(expectedMode);
      expect('run' in migrated.state, name).toBe(false);
      expect(migrated.stateHash, name).toBe(hashState(migrated.state));
      expect(JSON.stringify(stored), 'input untouched').toBe(frozen);
      if (name !== 'park-v10-run-tour.json') {
        expect(JSON.stringify(migrated.state), `${name} state byte for byte`).toBe(JSON.stringify(stored.state));
        expect(migrated.stateHash, name).toBe(stored.stateHash);
      } else {
        expect(JSON.stringify({ ...migrated.state, mode: 'run' }), name).toBe(JSON.stringify(stored.state));
        expect(Object.keys(migrated.state), 'the key order is kept').toEqual(Object.keys(stored.state));
      }
    }
  });

  it('keeps the grant of the interim Map park: every bonus that applies in run also applies in scenario', () => {
    const migrated = migrateSave(fixture('park-v10-run-tour.json'));
    expect(migrated.state.grant).toEqual({ unlockedBuildingIds: [], bonusIds: ['nest-egg'] });
    for (const bonus of BONUSES) if (bonus.modes.includes('run')) expect(bonus.modes, bonus.id).toContain('scenario');
    expect(rewardEligible(sessionFromSave(fixture('park-v10-run-tour.json')).session)).toBe(true);
  });

  it('every fixture loads through fromSave and plays 600 ticks on the pre-change (schema 10) hashes', () => {
    for (const name of NAMES) {
      const stored = fixture(name);
      const { session, save } = sessionFromSave(stored);
      expect(hashState(session.serialize()), `${name} at load`).toBe(save.stateHash);
      step(session, 600);
      const state = JSON.parse(JSON.stringify(session.serialize()));
      if (name === 'park-v10-run-tour.json') {
        expect(session.mode).toBe('scenario');
        state.mode = 'run';
      }
      expect(hashState(state), `${name} after 600 ticks`).toBe(AFTER_600[name]);
    }
  });

  it('keeps the legacy tour node of the interim Map save (validated, ignored on load by the app)', () => {
    const migrated = migrateSave(fixture('park-v10-run-tour.json'));
    expect((migrated.app as { tourNodeId: string }).tourNodeId).toBe('opener');
  });

  it('drops a hand-edited run key from a v10 save (a schema 10 save cannot carry a run)', () => {
    const stored = fixture('park-v10-sandbox-meadow.json');
    stored.state.run = { version: 1 };
    stored.stateHash = hashState(stored.state);
    const migrated = migrateSave(stored);
    expect('run' in migrated.state).toBe(false);
    expect(sessionFromSave(stored).session.mode).toBe('sandbox');
  });

  it('a tampered v10 save is refused by its integrity hash before any migration runs', () => {
    const stored = fixture('park-v10-scenario.json');
    stored.state.world.cash += 1;
    expect(() => migrateSave(stored)).toThrow(SaveError);
  });

  it('a save one schema newer than this build is too new', () => {
    const stored = fixture('park-v10-scenario.json');
    stored.schemaVersion = SAVE_SCHEMA_VERSION + 1;
    expect(() => migrateSave(stored)).toThrow(/newer version/);
  });
});
