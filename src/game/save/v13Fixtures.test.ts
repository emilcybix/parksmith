import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { ParkSession } from '../session/ParkSession';
import { hashState } from './hash';
import { stripGuestLife } from './schema14TestSupport';
import { SAVE_SCHEMA_VERSION } from './version';
import { sessionFromSave } from '../session/fromSave';

/**
 * Phase 14, wave 3: the three schema-13, content-version-4 fixtures, captured once from the Phase 14 code (calibrated
 * thresholds: lane capacity 400, bands 80/270/450) through `createParkSave` after `syncWithWorld`, never regenerated
 * (capture script: Phase 14 scratch probe/w3a6-capture.probe.ts):
 *
 * - the dev park (Meadow sandbox) with 450 guests spawned, 300 ticks: busy, severe and bottleneck tiles, the congestion
 *   feedback really slowing walkers;
 * - the Frost Fair scenario after the opening of its winning plan, 900 ticks;
 * - The Map, Standard seed 1, level 1 stage (no card) after the opening of `richPlan`, 600 ticks.
 *
 * They live in `fixtures/v13/` so the older fixture sweeps (`fixtures/*.json`: "no pre-Phase-14/16 save carries these
 * rule keys") keep meaning exactly v1 to v12. Each one carries `rules.crowdFeedback` 1 and its `crowd` field, loads through
 * `fromSave` on its own integrity hash with the field restored exactly, and after 600 more ticks matches its pin.
 * A later deliberate change to the crowd numbers moves AFTER_600 of the crowded park (its walkers are slowed); re-pin then
 * with attribution, never regenerate the files.
 */
const fixtures = import.meta.glob<Record<string, unknown>>('./fixtures/v13/park-v13-*.json', { import: 'default', eager: true });
const fixture = (name: string): Record<string, any> => structuredClone(fixtures[`./fixtures/v13/${name}`] ?? {}) as Record<string, any>;

const NAMES = [
  'park-v13-sandbox-crowded.json',
  'park-v13-scenario.json',
  'park-v13-run-stage.json',
] as const;
type FixtureName = (typeof NAMES)[number];

/** hashState of each park after 600 more ticks, at capture. */
// Phase 29: re-pinned once (guest life — benches, pauses, nausea, warmth — changes how a loaded park plays on).
// Phase 30 (2026-10-15): the crowded park and the scenario re-pinned for the optional `thoughtObjectId` key a complaining
// guest now carries. Only the key moves them: with it stripped each state hashes exactly its Phase 29 pin
// (BEFORE_PHASE30), so the Phase 30 gameplay rules change nothing in these three parks.
const AFTER_600: Record<FixtureName, string> = {
  // Phase 30 (MGMT): OperationsSimulation writes the litter thought through setThought, so a stale complaint link no
  // longer survives under it; key only, BEFORE_PHASE30 unchanged (10b2c16d6deb80dc).
  'park-v13-sandbox-crowded.json': 'fafebe35454a1ffc',
  'park-v13-scenario.json': '4aa2dd1ed3ebc474',
  'park-v13-run-stage.json': '8a2e6990d84bc126',
};
const BEFORE_PHASE30: Record<FixtureName, string> = {
  'park-v13-sandbox-crowded.json': '10b2c16d6deb80dc',
  'park-v13-scenario.json': '8521900710e8f8b6',
  'park-v13-run-stage.json': '8a2e6990d84bc126',
};
const withoutComplaintLinks = (state: ReturnType<ParkSession['serialize']>): unknown => {
  const copy = JSON.parse(JSON.stringify(state)) as Record<string, any>;
  for (const guest of copy.guests.guests) delete guest.thoughtObjectId;
  return copy;
};

const EXPECTED: Record<FixtureName, { mode: string; tick: number; scenarioId: string | null; run: boolean; stateHash: string }> = {
  'park-v13-sandbox-crowded.json': { mode: 'sandbox', tick: 300, scenarioId: null, run: false, stateHash: '2076d60ac3aa544f' },
  'park-v13-scenario.json': { mode: 'scenario', tick: 900, scenarioId: 'frost-fair', run: false, stateHash: 'e19819f91c568c5a' },
  'park-v13-run-stage.json': { mode: 'run', tick: 600, scenarioId: 'the-map-stage', run: true, stateHash: '6036d518656cb783' },
};

const step = (session: ParkSession, ticks: number): void => { for (let tick = 0; tick < ticks; tick += 1) session.step(GAME_CONFIG.fixedStepMs); };

const engagement = (session: ParkSession): { slowed: number; severe: number } => {
  const { width } = session.world;
  let slowed = 0;
  let severe = 0;
  for (const index of session.crowd.shape().cells) {
    const cell = { x: index % width, y: Math.floor(index / width) };
    if (session.crowd.speedFactorAt(cell) < 1) slowed += 1;
    if (session.crowd.isSevereAt(cell)) severe += 1;
  }
  return { slowed, severe };
};

describe('the frozen schema-13 fixtures (Phase 14 wave 3)', () => {
  it('are all present', () => {
    expect(Object.keys(fixtures).map((path) => path.replace('./fixtures/v13/', '')).sort()).toEqual([...NAMES].sort());
  });

  it('really are schema 13, content version 4, with the crowd rule and its field', () => {
    expect(SAVE_SCHEMA_VERSION).toBeGreaterThanOrEqual(13);
    for (const name of NAMES) {
      const save = fixture(name);
      const expected = EXPECTED[name];
      expect(save.schemaVersion, name).toBe(13);
      expect(save.contentVersion, name).toBe(4);
      expect(save.savedAtEpochMs, name).toBe(1_760_000_000_000);
      expect(save.savedAtTick, name).toBe(expected.tick);
      expect(save.state.world.tick, name).toBe(expected.tick);
      expect(save.mode, name).toBe(expected.mode);
      expect(save.scenarioId, name).toBe(expected.scenarioId);
      expect(save.stateHash, name).toBe(expected.stateHash);
      expect(save.stateHash, name).toBe(hashState(save.state));
      expect('run' in save.state, name).toBe(expected.run);
      const ruleKeys = Object.keys(save.state.rules);
      expect(ruleKeys[ruleKeys.length - 1], `${name}: the base-layer key is written last`).toBe('crowdFeedback');
      expect(save.state.rules.crowdFeedback, name).toBe(1);
      expect(save.state.crowd.version, name).toBe(1);
      const pairs = save.state.crowd.pressure as Array<[number, number]>;
      expect(pairs.length, name).toBeGreaterThan(0);
      pairs.forEach(([cell, value], index) => {
        expect(Number.isInteger(cell) && Number.isInteger(value) && value > 0, `${name} pair ${index}`).toBe(true);
        if (index > 0) expect(cell, `${name}: ascending`).toBeGreaterThan(pairs[index - 1][0]);
      });
    }
  });

  it('every fixture loads through fromSave on its own hash with its field, and plays 600 ticks to its pin', () => {
    for (const name of NAMES) {
      const stored = fixture(name);
      const { session, save } = sessionFromSave(fixture(name));
      expect(session.mode, name).toBe(EXPECTED[name].mode);
      expect(save.schemaVersion, name).toBe(SAVE_SCHEMA_VERSION);
      expect(session.crowd.feedback, name).toBe(true);
      expect(session.crowd.serialize(), `${name}: the field restores exactly`).toEqual(stored.state.crowd);
      // Byte for byte but for what Phase 29 (schema 15) adds to every guest on load.
      expect(JSON.stringify(stripGuestLife(session.serialize())), `${name}: re-serialized byte for byte`).toBe(JSON.stringify(stored.state));
      step(session, 600);
      const state = session.serialize();
      expect(state.rules.crowdFeedback, name).toBe(1);
      expect(hashState(state), `${name} after 600 ticks`).toBe(AFTER_600[name]);
      expect(hashState(withoutComplaintLinks(state)), `${name} after 600 ticks, without the Phase 30 key`).toBe(BEFORE_PHASE30[name]);
    }
  });

  it('the crowded park is crowded at load: slowed, severe and bottleneck tiles over several neighborhoods', () => {
    const { session } = sessionFromSave(fixture('park-v13-sandbox-crowded.json'));
    const { slowed, severe } = engagement(session);
    expect(slowed).toBeGreaterThan(0);
    expect(severe).toBeGreaterThan(0);
    const view = session.crowdView();
    expect(view.feedback).toBe(true);
    expect(view.bottlenecks.length).toBeGreaterThan(0);
    expect(view.neighborhoods.length).toBeGreaterThanOrEqual(3);
    expect(session.guests.guests.size).toBeGreaterThanOrEqual(400);
  });
});
