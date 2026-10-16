import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { ParkSession } from '../session/ParkSession';
import { hashState } from './hash';
import { SAVE_SCHEMA_VERSION } from './version';
import { migrateSave } from './migrate';
import { TO_SCHEMA_14 } from './schema14TestSupport';
import { sessionFromSave } from '../session/fromSave';

/**
 * Phase 25, wave 0 (extended in wave 2 to the 11 -> 12 migration): the six schema-11 fixtures, captured from the schema-11 code BEFORE any Phase 25 change (the card
 * pool, the one-shot ledger and schema 12). They must never be regenerated. Each one loads through `fromSave` on its own
 * integrity hash and, after 600 more ticks, matches the hash the schema-11 code produced.
 */
const fixtures = import.meta.glob<Record<string, unknown>>('./fixtures/park-v11-*.json', { import: 'default', eager: true });
const fixture = (name: string): Record<string, any> => structuredClone(fixtures[`./fixtures/${name}`] ?? {}) as Record<string, any>;

const NAMES = [
  'park-v11-sandbox-meadow.json',
  'park-v11-scenario-cards.json',
  'park-v11-scenario-biome.json',
  'park-v11-run-stage.json',
  'park-v11-run-backdrop.json',
  'park-v11-run-won.json',
] as const;
type FixtureName = (typeof NAMES)[number];

/** hashState of each park after 600 ticks on the SCHEMA-11 code. */
// Phase 29: re-pinned once (guest life — benches, pauses, nausea, warmth — changes how a loaded park plays on).
const AFTER_600: Record<FixtureName, string> = {
  'park-v11-sandbox-meadow.json': '0f418cd51724c334',
  'park-v11-scenario-cards.json': '89a59f74e5337ae7',
  'park-v11-scenario-biome.json': '6b62139df1f96cf9',
  'park-v11-run-stage.json': 'cb63bc3e915e6e5a',
  'park-v11-run-backdrop.json': '315d0acdec158f61',
  'park-v11-run-won.json': 'cd071353597218ba',
};

const EXPECTED: Record<FixtureName, { mode: string; tick: number; scenarioId: string | null; cards: string[]; bonusIds: string[]; run: { phase: string; levelIndex: number; parkLevelIndex: number } | null }> = {
  'park-v11-sandbox-meadow.json': { mode: 'sandbox', tick: 500, scenarioId: null, cards: [], bonusIds: [], run: null },
  'park-v11-scenario-cards.json': { mode: 'scenario', tick: 600, scenarioId: 'garden-gala', cards: ['grand-opening', 'velvet-ropes', 'lean-crew'], bonusIds: ['nest-egg', 'spare-slot'], run: null },
  'park-v11-scenario-biome.json': { mode: 'scenario', tick: 300, scenarioId: 'frost-fair', cards: ['lean-crew'], bonusIds: [], run: null },
  'park-v11-run-stage.json': { mode: 'run', tick: 450, scenarioId: 'the-map-stage', cards: ['velvet-ropes'], bonusIds: ['spare-slot'], run: { phase: 'stage', levelIndex: 1, parkLevelIndex: 1 } },
  'park-v11-run-backdrop.json': { mode: 'run', tick: 451, scenarioId: 'the-map-stage', cards: ['velvet-ropes'], bonusIds: ['spare-slot'], run: { phase: 'offer', levelIndex: 2, parkLevelIndex: 1 } },
  'park-v11-run-won.json': { mode: 'run', tick: 121, scenarioId: 'the-map-stage', cards: ['grand-opening'], bonusIds: ['spare-slot'], run: { phase: 'won', levelIndex: 4, parkLevelIndex: 4 } },
};

const step = (session: ParkSession, ticks: number): void => { for (let tick = 0; tick < ticks; tick += 1) session.step(GAME_CONFIG.fixedStepMs); };

/**
 * A schema-12 state as the schema-11 code would have written it (the `modes.test.ts` stripV10 precedent): no `plays`, run
 * format 1 (no `unplayedOneShots`, no `playedCardIds` / `unpaidDebt` in the history). Only legal while nothing was played.
 */
const stripV12 = (state: Record<string, any>): Record<string, any> => {
  const copy = JSON.parse(JSON.stringify(state)) as Record<string, any>;
  if (copy.mode !== 'run') return copy;
  expect(copy.plays).toEqual({ played: [], pending: [] });
  delete copy.plays;
  copy.run.version = 1;
  expect(copy.run.unplayedOneShots).toBe('return');
  delete copy.run.unplayedOneShots;
  for (const entry of copy.run.history) {
    expect(entry.playedCardIds).toEqual([]);
    expect(entry.unpaidDebt).toBe(0);
    delete entry.playedCardIds;
    delete entry.unpaidDebt;
  }
  return copy;
};

describe('the frozen schema-11 fixtures (Phase 25 wave 0)', () => {
  it('are all present', () => {
    expect(Object.keys(fixtures).map((path) => path.replace('./fixtures/', '')).sort()).toEqual([...NAMES].sort());
  });

  it('really are schema 11: the header, the modes, the keys and the run phases', () => {
    expect(SAVE_SCHEMA_VERSION).toBeGreaterThanOrEqual(11);
    for (const name of NAMES) {
      const save = fixture(name);
      const expected = EXPECTED[name];
      expect(save.schemaVersion, name).toBe(11);
      expect(save.contentVersion, name).toBe(2);
      expect(save.savedAtEpochMs, name).toBe(1_760_000_000_000);
      expect(save.savedAtTick, name).toBe(expected.tick);
      expect(save.state.world.tick, name).toBe(expected.tick);
      expect(save.app, name).toEqual({ clock: { speed: 1, simulationTimeMs: expected.tick * 100 }, tourNodeId: null });
      expect(save.mode, name).toBe(expected.mode);
      expect(save.state.mode, name).toBe(expected.mode);
      expect(save.scenarioId, name).toBe(expected.scenarioId);
      expect(save.state.activeCardIds, name).toEqual(expected.cards);
      expect(save.state.grant, name).toEqual({ unlockedBuildingIds: [], bonusIds: expected.bonusIds });
      expect(save.stateHash, name).toBe(hashState(save.state));
      const keys = Object.keys(save.state);
      expect('plays' in save.state, name).toBe(false);
      if (expected.run === null) {
        expect('run' in save.state, name).toBe(false);
        expect(keys.at(-1), name).toBe('grant');
      } else {
        expect(keys.at(-1), name).toBe('run');
        expect(keys.at(-2), name).toBe('grant');
        expect(save.state.run.version, name).toBe(1);
        expect(save.state.run.seed, name).toBe(1234);
        expect(save.state.run.difficulty, name).toBe('standard');
        expect(save.state.run.phase, name).toBe(expected.run.phase);
        expect(save.state.run.levelIndex, name).toBe(expected.run.levelIndex);
        expect(save.state.run.parkLevelIndex, name).toBe(expected.run.parkLevelIndex);
        expect(save.state.run.loadout, name).toEqual(expected.cards);
      }
    }
    expect(fixture('park-v11-run-stage.json').state.run.usedPile.length).toBeGreaterThan(0);
    expect(fixture('park-v11-run-stage.json').state.scenario.status).toBe('running');
    expect(fixture('park-v11-run-backdrop.json').state.scenario.status).toBe('succeeded');
    expect(fixture('park-v11-run-won.json').state.run.history).toHaveLength(GAME_CONFIG.run.levelCount);
  });

  it('every fixture loads through fromSave on its own hash and plays 600 ticks to the schema-11 hash (run parks after stripping the schema-12 keys)', () => {
    for (const name of NAMES) {
      const { session, save } = sessionFromSave(fixture(name));
      expect(session.mode, name).toBe(EXPECTED[name].mode);
      expect(save.schemaVersion, name).toBe(SAVE_SCHEMA_VERSION);
      expect(hashState(session.serialize()), `${name} at load`).toBe(save.stateHash);
      step(session, 600);
      expect(hashState(stripV12(session.serialize())), `${name} after 600 ticks`).toBe(AFTER_600[name]);
    }
  });
});

describe('migration 11 -> 12 (the one-shot ledger, run format 2) on the frozen schema-11 fixtures', () => {
  it('is a link of the chain (12 -> 13 follows, Phase 14)', () => {
    expect(SAVE_SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
  });

  it('keeps every Sandbox and Scenario park byte for byte (state and hash)', () => {
    for (const name of NAMES.filter((candidate) => EXPECTED[candidate].run === null)) {
      const stored = fixture(name);
      const frozen = JSON.stringify(stored);
      const migrated = migrateSave(stored, TO_SCHEMA_14);
      expect(migrated.schemaVersion, name).toBe(14);
      expect(JSON.stringify(migrated.state), `${name} state byte for byte`).toBe(JSON.stringify(stored.state));
      expect(migrated.stateHash, name).toBe(stored.stateHash);
      expect(JSON.stringify(stored), 'input untouched').toBe(frozen);
    }
  });

  it('gives a run park an empty ledger before `run` and run format 2, and nothing else changes', () => {
    for (const name of NAMES.filter((candidate) => EXPECTED[candidate].run !== null)) {
      const stored = fixture(name);
      const migrated = migrateSave(stored, TO_SCHEMA_14) as unknown as { schemaVersion: number; stateHash: string; state: Record<string, any> };
      const keys = Object.keys(migrated.state);
      expect(keys.slice(-3), name).toEqual(['grant', 'plays', 'run']);
      expect(migrated.state.plays, name).toEqual({ played: [], pending: [] });
      expect(migrated.state.run.version, name).toBe(2);
      const runKeys = Object.keys(migrated.state.run);
      expect(runKeys[runKeys.indexOf('offerRule') + 1], `${name}: the plan key sits after offerRule`).toBe('unplayedOneShots');
      expect(migrated.stateHash, name).toBe(hashState(migrated.state));
      expect(JSON.stringify(stripV12(migrated.state)), `${name}: stripped, the state is the schema-11 state byte for byte`).toBe(JSON.stringify(stored.state));
    }
  });

  it('drops a hand-edited plays key from a v11 Sandbox save and replaces one in a v11 run save', () => {
    const sandbox = fixture('park-v11-sandbox-meadow.json');
    sandbox.state.plays = { played: [{ cardId: 'bridging-loan', tick: 1 }], pending: [] };
    sandbox.stateHash = hashState(sandbox.state);
    expect('plays' in migrateSave(sandbox).state).toBe(false);
    expect(sessionFromSave(sandbox).session.mode).toBe('sandbox');
    const run = fixture('park-v11-run-stage.json');
    run.state.plays = { played: [{ cardId: 'bridging-loan', tick: 1 }], pending: [] };
    run.state.run.history[0].playedCardIds = ['bridging-loan'];
    run.stateHash = hashState(run.state);
    const migrated = migrateSave(run);
    expect(migrated.state.plays).toEqual({ played: [], pending: [] });
    expect(migrated.state.run?.history[0].playedCardIds).toEqual([]);
    expect(() => sessionFromSave(run)).not.toThrow();
  });

  it('every loaded run fixture is a format-2 run whose settled stages carry no plays and no debt', () => {
    for (const name of NAMES.filter((candidate) => EXPECTED[candidate].run !== null)) {
      const { session } = sessionFromSave(fixture(name));
      expect(session.plays, name).not.toBeNull();
      expect(session.plays?.unpaidTotal(), name).toBe(0);
      expect(session.run?.unplayedOneShots, name).toBe('return');
      expect(session.run?.history.every((entry) => entry.playedCardIds.length === 0 && entry.unpaidDebt === 0), name).toBe(true);
    }
  });
});
