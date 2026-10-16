import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { ParkSession } from '../session/ParkSession';
import { hashState } from './hash';
import { SAVE_SCHEMA_VERSION } from './version';
import { sessionFromSave } from '../session/fromSave';

/**
 * Phase 16, wave 0: the three schema-12, content-version-2 fixtures, captured before any Phase 16 change, never
 * regenerated. They were written from today's code through `createParkSave` after `syncWithWorld`:
 *
 * - a Meadow sandbox: the First Day route plus a lollipop lamp beside the carousel and sunburst flowers beside the
 *   roundabout (pieces that "match" those rides under Phase 16 theme affinity), a mechanic, 1,200 ticks;
 * - the Frost Fair scenario after the opening of its winning plan (`WINNING_PLANS`), 900 ticks;
 * - The Map, Standard seed 1, level 1 stage (no card) after the opening of `richPlan`, 600 ticks.
 *
 * Each one loads through `fromSave` on its own integrity hash and, after 600 more ticks, matches the hash the pre-Phase-16
 * code produced. Their rulesets carry neither `themeAffinity` nor `researchCostScale`, and a loaded park never gains
 * them: a pre-Phase-16 save keeps no affinity and its old research scale.
 */
const fixtures = import.meta.glob<Record<string, unknown>>('./fixtures/park-v12-*.json', { import: 'default', eager: true });
const fixture = (name: string): Record<string, any> => structuredClone(fixtures[`./fixtures/${name}`] ?? {}) as Record<string, any>;

const NAMES = [
  'park-v12-sandbox-themed.json',
  'park-v12-scenario.json',
  'park-v12-run-stage.json',
] as const;
type FixtureName = (typeof NAMES)[number];

/** hashState of each park after 600 ticks on the pre-Phase-16 code. */
// Phase 29: re-pinned once (guest life — benches, pauses, nausea, warmth — changes how a loaded park plays on).
// Phase 30 (2026-10-15): the themed sandbox and the scenario re-pinned for the optional `thoughtObjectId` key a
// complaining guest now carries. Only the key moves them: with it stripped each state hashes exactly its Phase 29 pin
// (BEFORE_PHASE30), so the Phase 30 gameplay rules change nothing in these three parks.
const AFTER_600: Record<FixtureName, string> = {
  'park-v12-sandbox-themed.json': 'e6614440afc70a1f',
  'park-v12-scenario.json': '744b50ddbd2f275d',
  'park-v12-run-stage.json': '097619ccad31e186',
};
const BEFORE_PHASE30: Record<FixtureName, string> = {
  'park-v12-sandbox-themed.json': 'dbffa88f98740e81',
  'park-v12-scenario.json': 'c660d81ab2c187f7',
  'park-v12-run-stage.json': '097619ccad31e186',
};
const withoutComplaintLinks = (state: ReturnType<ParkSession['serialize']>): unknown => {
  const copy = JSON.parse(JSON.stringify(state)) as Record<string, any>;
  for (const guest of copy.guests.guests) delete guest.thoughtObjectId;
  return copy;
};

const EXPECTED: Record<FixtureName, { mode: string; tick: number; scenarioId: string | null; run: boolean }> = {
  'park-v12-sandbox-themed.json': { mode: 'sandbox', tick: 1200, scenarioId: null, run: false },
  'park-v12-scenario.json': { mode: 'scenario', tick: 900, scenarioId: 'frost-fair', run: false },
  'park-v12-run-stage.json': { mode: 'run', tick: 600, scenarioId: 'the-map-stage', run: true },
};

const PHASE_16_RULE_KEYS = ['themeAffinity', 'researchCostScale'] as const;

const step = (session: ParkSession, ticks: number): void => { for (let tick = 0; tick < ticks; tick += 1) session.step(GAME_CONFIG.fixedStepMs); };

describe('the frozen schema-12 fixtures (Phase 16 wave 0)', () => {
  it('are all present', () => {
    expect(Object.keys(fixtures).map((path) => path.replace('./fixtures/', '')).sort()).toEqual([...NAMES].sort());
  });

  it('really are schema 12, content version 2: the header, the modes and the parks', () => {
    expect(SAVE_SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
    for (const name of NAMES) {
      const save = fixture(name);
      const expected = EXPECTED[name];
      expect(save.schemaVersion, name).toBe(12);
      expect(save.contentVersion, name).toBe(2);
      expect(save.savedAtEpochMs, name).toBe(1_760_000_000_000);
      expect(save.savedAtTick, name).toBe(expected.tick);
      expect(save.state.world.tick, name).toBe(expected.tick);
      expect(save.app, name).toEqual({ clock: { speed: 1, simulationTimeMs: expected.tick * 100 }, tourNodeId: null });
      expect(save.mode, name).toBe(expected.mode);
      expect(save.state.mode, name).toBe(expected.mode);
      expect(save.scenarioId, name).toBe(expected.scenarioId);
      expect(save.state.activeCardIds, name).toEqual([]);
      expect(save.state.grant, name).toEqual({ unlockedBuildingIds: [], bonusIds: [] });
      expect(save.stateHash, name).toBe(hashState(save.state));
      for (const key of PHASE_16_RULE_KEYS) expect(key in save.state.rules, `${name}: ${key}`).toBe(false);
      expect('run' in save.state, name).toBe(expected.run);
      expect(save.state.operations.staff.some((worker: { role: string }) => worker.role === 'mechanic'), name).toBe(true);
    }
    const sandboxIds = fixture('park-v12-sandbox-themed.json').state.world.objects.map((object: { definitionId: string }) => object.definitionId);
    expect(sandboxIds.filter((id: string) => id === 'lollipop-lamp')).toHaveLength(3);
    expect(sandboxIds.filter((id: string) => id === 'sunburst-flowers')).toHaveLength(2);
    expect(fixture('park-v12-scenario.json').state.scenario.status).toBe('running');
    const run = fixture('park-v12-run-stage.json').state.run;
    expect([run.version, run.seed, run.difficulty, run.phase, run.levelIndex, run.parkLevelIndex]).toEqual([2, 1, 'standard', 'stage', 0, 0]);
  });

  it('every fixture loads through fromSave on its own hash and plays 600 ticks to the pre-Phase-16 hash, never gaining a Phase 16 rule key', () => {
    for (const name of NAMES) {
      const { session, save } = sessionFromSave(fixture(name));
      expect(session.mode, name).toBe(EXPECTED[name].mode);
      expect(save.schemaVersion, name).toBe(SAVE_SCHEMA_VERSION);
      expect(hashState(session.serialize()), `${name} at load`).toBe(save.stateHash);
      step(session, 600);
      const state = session.serialize();
      for (const key of PHASE_16_RULE_KEYS) expect(key in state.rules, `${name}: ${key} after 600 ticks`).toBe(false);
      expect(hashState(state), `${name} after 600 ticks`).toBe(AFTER_600[name]);
      expect(hashState(withoutComplaintLinks(state)), `${name} after 600 ticks, without the Phase 30 key`).toBe(BEFORE_PHASE30[name]);
    }
  });
});
