import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { scaledResearchPoints } from '../progression/content';
import { testStageSession } from '../run/testSupport';
import { researchCostScaleOf } from '../scenarios/rules';
import { EMPTY_GRANT, ParkSession } from '../session/ParkSession';
import { SCENARIOS } from '../scenarios/content';
import { hashState } from './hash';
import { stripGuestLife } from './schema14TestSupport';
import { SaveError, createParkSave, type ParkSave } from './version';
import { SAVE_MIGRATIONS, migrateSave } from './migrate';
import { sessionFromSave } from '../session/fromSave';

/**
 * Phase 22, schema 10: the game mode and the profile grant in the save. The four schema-9 fixtures are frozen files
 * captured from the schema-9 code BEFORE state.ts changed; they must never be regenerated.
 */
const fixtures = import.meta.glob<Record<string, unknown>>('./fixtures/park-v9-*.json', { import: 'default', eager: true });
const fixture = (name: string): Record<string, unknown> => structuredClone(fixtures[`./fixtures/${name}`] ?? {});

const NAMES = ['park-v9-sandbox-meadow.json', 'park-v9-sandbox-generated.json', 'park-v9-scenario.json', 'park-v9-tour.json'] as const;

/**
 * hashState of each park after 600 ticks on the SCHEMA-9 code (mode and grant stripped). Re-pinned once for Phase 29:
 * guest life changes how a loaded park plays on (the state at load is still the schema-9 one, Phase 29 keys stripped).
 */
const AFTER_600: Record<(typeof NAMES)[number], string> = {
  'park-v9-sandbox-meadow.json': 'd08825a25c8dc1c9',
  'park-v9-sandbox-generated.json': '87ecd304aa880b19',
  'park-v9-scenario.json': 'a5bf2ff319d26eae',
  'park-v9-tour.json': 'f8e743d9ac3fd38f',
};

const stripV10 = (state: unknown): unknown => {
  const copy = stripGuestLife(state) as Record<string, unknown>;
  delete copy.mode;
  delete copy.grant;
  return copy;
};

const step = (session: ParkSession, ticks: number): void => {
  for (let tick = 0; tick < ticks; tick += 1) session.step(GAME_CONFIG.fixedStepMs);
};

type Envelope = { schemaVersion: number; mode?: string; stateHash: string; scenarioId: string | null; state: Record<string, unknown> };

describe('migration 9 -> 10 (game modes and the profile grant)', () => {
  it('the fixtures really are schema 9: no mode, no grant', () => {
    for (const name of NAMES) {
      const save = fixture(name) as unknown as Envelope;
      expect(save.schemaVersion, name).toBe(9);
      expect('mode' in save, name).toBe(false);
      expect('mode' in save.state, name).toBe(false);
      expect('grant' in save.state, name).toBe(false);
    }
  });

  it('is the last link of the chain', () => {
    expect(SAVE_MIGRATIONS.find((step) => step.from === 9)).toMatchObject({ from: 9, to: 10 });
  });

  it('maps every old park to sandbox or scenario by scenarioId (a tour park too), appends mode and grant last, keeps the rest byte for byte', () => {
    const expectedMode: Record<(typeof NAMES)[number], string> = {
      'park-v9-sandbox-meadow.json': 'sandbox',
      'park-v9-sandbox-generated.json': 'sandbox',
      'park-v9-scenario.json': 'scenario',
      'park-v9-tour.json': 'scenario',
    };
    for (const name of NAMES) {
      const stored = fixture(name) as unknown as Envelope;
      const frozen = JSON.stringify(stored);
      const migrated = migrateSave(stored, { latestVersion: 10, migrations: SAVE_MIGRATIONS.slice(0, -1) });
      expect(migrated.schemaVersion, name).toBe(10);
      expect(migrated.mode, name).toBe(expectedMode[name]);
      expect(migrated.state.mode, name).toBe(expectedMode[name]);
      expect(migrated.state.grant, name).toEqual({ unlockedBuildingIds: [], bonusIds: [] });
      expect(Object.keys(migrated.state).slice(-3), name).toEqual(['map', 'mode', 'grant']);
      expect(JSON.stringify(stripV10(migrated.state)), name).toBe(JSON.stringify(stored.state));
      expect(migrated.stateHash, name).toBe(hashState(migrated.state));
      expect(JSON.stringify(stored), 'input untouched').toBe(frozen);
    }
  });

  it('keeps the tour node of an old tour save (the app restores it; the park is a Scenario)', () => {
    const migrated = migrateSave(fixture('park-v9-tour.json'));
    expect((migrated.app as { tourNodeId: string }).tourNodeId).toBe('branch-profit');
    expect(migrated.mode).toBe('scenario');
  });

  it('drops a hand-edited mode or grant from a v9 save (state and header): a v9 save cannot carry them', () => {
    const stored = fixture('park-v9-sandbox-meadow.json') as unknown as Envelope;
    stored.mode = 'run';
    stored.state.mode = 'run';
    stored.state.grant = { unlockedBuildingIds: ['tiki-tumbler'], bonusIds: ['nest-egg'] };
    stored.stateHash = hashState(stored.state);
    const migrated = migrateSave(stored);
    expect(migrated.mode).toBe('sandbox');
    expect(migrated.state.grant).toEqual({ unlockedBuildingIds: [], bonusIds: [] });
    const { session } = sessionFromSave(stored);
    expect(session.mode).toBe('sandbox');
    expect(session.grant.unlockedBuildingIds).toEqual([]);
  });

  it('loads through fromSave and plays 600 ticks on the pre-change (schema 9) hashes', () => {
    for (const name of NAMES) {
      const stored = fixture(name) as unknown as Envelope;
      const { session, save } = sessionFromSave(stored);
      expect(hashState(stripV10(session.serialize())), `${name} at load`).toBe(stored.stateHash);
      expect(hashState(session.serialize()), name).toBe(save.stateHash);
      step(session, 600);
      expect(hashState(stripV10(session.serialize())), `${name} after 600 ticks`).toBe(AFTER_600[name]);
    }
  });

  it('a tampered v9 save is refused by its integrity hash before any migration runs', () => {
    const stored = fixture('park-v9-scenario.json') as unknown as Envelope & { state: { world: { cash: number } } };
    stored.state.world.cash += 1;
    expect(() => migrateSave(stored)).toThrow(SaveError);
  });
});

describe('the mode in a park and its save', () => {
  const scenario = SCENARIOS[0];

  it('derives the mode from the scenario by default (every existing caller builds what it built before)', () => {
    expect(new ParkSession(null).mode).toBe('sandbox');
    expect(new ParkSession(scenario).mode).toBe('scenario');
    expect(new ParkSession(null).grant).toEqual({ unlockedBuildingIds: [], bonusIds: [] });
  });

  it('enforces: sandbox if and only if there is no scenario (RangeError)', () => {
    expect(() => new ParkSession(null, [], { mode: 'scenario' })).toThrow(RangeError);
    expect(() => new ParkSession(null, [], { mode: 'run' })).toThrow(RangeError);
    expect(() => new ParkSession(scenario, [], { mode: 'sandbox' })).toThrow(RangeError);
    expect(() => new ParkSession(scenario, [], { mode: 'creative' as never })).toThrow(RangeError);
    expect(() => new ParkSession(scenario, [], { mode: 'run' }), 'a run park needs a run').toThrow(RangeError);
    expect(testStageSession().session.mode).toBe('run');
  });

  it('round trips each mode through serialize, the envelope, JSON and fromSave', () => {
    const parks: Array<[string, () => ParkSession]> = [
      ['sandbox', () => new ParkSession(null, [], { mode: 'sandbox' })],
      ['scenario', () => new ParkSession(scenario, ['grand-opening'], { mode: 'scenario' })],
      ['run', () => testStageSession({ cardCount: 1 }).session],
    ];
    for (const [mode, make] of parks) {
      const session = make();
      step(session, 50);
      session.syncWithWorld();
      const state = session.serialize();
      expect(state.mode, mode).toBe(mode);
      const envelope = createParkSave(state, { clock: { speed: 1, simulationTimeMs: 5000 }, tourNodeId: null }, 1);
      expect(envelope.mode, mode).toBe(mode);
      const loaded = sessionFromSave(JSON.parse(JSON.stringify(envelope)));
      expect(loaded.session.mode, mode).toBe(mode);
      expect(hashState(loaded.session.serialize()), mode).toBe(hashState(state));
    }
  });

  it('the grant round trips and a restored park never reads a live profile', () => {
    const session = new ParkSession(scenario, [], {
      mode: 'scenario',
      grant: { unlockedBuildingIds: ['tiki-tumbler', 'lantern-maple'], bonusIds: ['nest-egg', 'research-grant'] },
    });
    session.syncWithWorld();
    const state = session.serialize();
    expect(state.grant).toEqual({ unlockedBuildingIds: ['tiki-tumbler', 'lantern-maple'], bonusIds: ['nest-egg', 'research-grant'] });
    expect(state.rules.startingResearchPoints).toBe(15);
    const restored = ParkSession.fromState(JSON.parse(JSON.stringify(state)));
    expect(restored.grant).toEqual(session.grant);
    expect(restored.rules).toEqual(session.rules);
    // The restore did not add the research grant a second time. Phase 16: the saved bonus stays 15 base RP and is granted
    // scaled by the park's research cost scale (150 at the content-version-3 default of 10).
    expect(restored.progression.snapshot().researchPoints).toBe(scaledResearchPoints(15, researchCostScaleOf(state.rules)));
  });

  it('restoreState (the undo path) keeps the mode and the grant, and refuses a different one', () => {
    const grant = { unlockedBuildingIds: ['tiki-tumbler'], bonusIds: ['nest-egg' as const] };
    const session = testStageSession({ grant }).session;
    session.syncWithWorld();
    const before = JSON.parse(JSON.stringify(session.serialize()));
    step(session, 40);
    session.restoreState(JSON.parse(JSON.stringify(before)));
    session.syncWithWorld();
    expect(session.mode).toBe('run');
    expect(session.serialize().grant).toEqual(grant);
    const other = JSON.parse(JSON.stringify(before));
    other.mode = 'scenario';
    expect(() => session.restoreState(other)).toThrow(SaveError);
    const otherGrant = JSON.parse(JSON.stringify(before));
    otherGrant.grant = EMPTY_GRANT;
    expect(() => session.restoreState(otherGrant)).toThrow(SaveError);
  });

  it('a mode-scenario mismatch in the header is a corrupt envelope', () => {
    const state = new ParkSession(null).serialize();
    const envelope = JSON.parse(JSON.stringify(createParkSave(state, { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 1))) as ParkSave;
    expect(() => migrateSave({ ...envelope, mode: 'scenario' })).toThrow(/mode differs/);
  });
});

describe('hostile mode, grant and bonus-rule values are refused on restore', () => {
  const base = (): Record<string, any> => {
    const session = new ParkSession(SCENARIOS[1], ['grand-opening'], {
      mode: 'scenario',
      grant: { unlockedBuildingIds: ['tiki-tumbler'], bonusIds: ['research-grant'] },
    });
    session.syncWithWorld();
    return JSON.parse(JSON.stringify(session.serialize()));
  };
  const codeOf = (mutate: (state: Record<string, any>) => void): string => {
    const state = base();
    mutate(state);
    try {
      ParkSession.fromState(state as never);
      return 'loaded';
    } catch (error) {
      return error instanceof SaveError ? error.code : `other: ${String(error)}`;
    }
  };

  it('a valid state loads', () => {
    expect(codeOf(() => undefined)).toBe('loaded');
  });

  it.each([
    ['mode is not a mode', (s: Record<string, any>) => { s.mode = 'creative'; }, 'invalid-state'],
    ['mode is missing', (s: Record<string, any>) => { delete s.mode; }, 'invalid-state'],
    ['mode is a number', (s: Record<string, any>) => { s.mode = 1; }, 'invalid-state'],
    ['sandbox mode with a scenario', (s: Record<string, any>) => { s.mode = 'sandbox'; }, 'invalid-state'],
    ['grant is missing', (s: Record<string, any>) => { delete s.grant; }, 'invalid-state'],
    ['grant is a string', (s: Record<string, any>) => { s.grant = 'tiki-tumbler'; }, 'invalid-state'],
    ['grant is an array', (s: Record<string, any>) => { s.grant = []; }, 'invalid-state'],
    ['grant lists are not arrays', (s: Record<string, any>) => { s.grant = { unlockedBuildingIds: 'x', bonusIds: {} }; }, 'invalid-state'],
    ['a grant list is huge (checked before walking)', (s: Record<string, any>) => { s.grant.unlockedBuildingIds = new Array(65).fill('tiki-tumbler'); }, 'invalid-state'],
    ['non-string ids', (s: Record<string, any>) => { s.grant.bonusIds = [7]; }, 'invalid-state'],
    ['duplicate unlock ids', (s: Record<string, any>) => { s.grant.unlockedBuildingIds = ['tiki-tumbler', 'tiki-tumbler']; }, 'invalid-state'],
    ['duplicate bonus ids', (s: Record<string, any>) => { s.grant.bonusIds = ['research-grant', 'research-grant']; }, 'invalid-state'],
    ['unlocks out of catalog order', (s: Record<string, any>) => { s.grant.unlockedBuildingIds = ['lantern-maple', 'tiki-tumbler']; }, 'invalid-state'],
    ['bonuses out of canonical order', (s: Record<string, any>) => { s.grant.bonusIds = ['word-of-mouth', 'nest-egg']; }, 'invalid-state'],
    ['an unknown building id', (s: Record<string, any>) => { s.grant.unlockedBuildingIds = ['no-such-building']; }, 'content-mismatch'],
    ['an unknown bonus id', (s: Record<string, any>) => { s.grant.bonusIds = ['mega-bonus']; }, 'content-mismatch'],
    ['a known but non-gated building', (s: Record<string, any>) => { s.grant.unlockedBuildingIds = ['comet-cups']; }, 'invalid-state'],
    ['rules.startingResearchPoints is a string', (s: Record<string, any>) => { s.rules.startingResearchPoints = '15'; }, 'invalid-state'],
    ['rules.startingResearchPoints is 0', (s: Record<string, any>) => { s.rules.startingResearchPoints = 0; }, 'invalid-state'],
    ['rules.startingResearchPoints is 31', (s: Record<string, any>) => { s.rules.startingResearchPoints = 31; }, 'invalid-state'],
    ['rules.startingResearchPoints is fractional', (s: Record<string, any>) => { s.rules.startingResearchPoints = 1.5; }, 'invalid-state'],
    ['rules.extraCardSlots is 2', (s: Record<string, any>) => { s.rules.extraCardSlots = 2; }, 'invalid-state'],
    ['rules.extraCardSlots is true', (s: Record<string, any>) => { s.rules.extraCardSlots = true; }, 'invalid-state'],
    ['more active cards than slots plus bonus slots', (s: Record<string, any>) => { s.activeCardIds = ['grand-opening', 'velvet-ropes', 'local-contractors']; }, 'invalid-state'],
  ])('%s', (_label, mutate, expected) => {
    expect(codeOf(mutate)).toBe(expected);
  });

  it('a sandbox cannot carry a scenario-only bonus', () => {
    const session = new ParkSession(null, [], { grant: { unlockedBuildingIds: [], bonusIds: [] } });
    session.syncWithWorld();
    const state = JSON.parse(JSON.stringify(session.serialize()));
    state.grant.bonusIds = ['spare-slot'];
    expect(() => ParkSession.fromState(state)).toThrow(/does not apply in sandbox mode/);
  });

  it('three cards load with the spare slot bonus (the rules say so) and the loadout is kept', () => {
    const session = new ParkSession(SCENARIOS[0], ['grand-opening', 'velvet-ropes', 'local-contractors'], {
      mode: 'scenario',
      grant: { unlockedBuildingIds: [], bonusIds: ['spare-slot'] },
    });
    expect(session.activeCards).toHaveLength(3);
    session.syncWithWorld();
    const restored = ParkSession.fromState(JSON.parse(JSON.stringify(session.serialize())));
    expect(restored.activeCards).toHaveLength(3);
  });
});
