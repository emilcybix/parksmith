import { describe, expect, it } from 'vitest';
import { COASTER_TYPE_BY_ID } from '../coaster/content';
import { coasterBaseCost, coasterSpeedTrace, type CoasterPiece } from '../coaster/design';
import { isClimbingSegment, liftRuns, toggleLiftRun } from '../coaster/lift';
import { creepSpeedMilli } from '../coaster/speedModel';
import {
  hillDipLayout, longestLayout, ovalLayout, randomCircuit, tallLayout, withFreeLifts, zigzagLayout,
} from '../coaster/testLayouts';
import { GAME_CONFIG } from '../config';
import { compileParkRules, RULE_CLAMPS } from '../scenarios/rules';
import { ParkSession } from '../session/ParkSession';
import { DETERMINISM_FIXTURES } from './determinismFixtures';
import { runReference } from './determinismHarness';
import { hashState } from './hash';
import { stripGuestLife } from './schema14TestSupport';
import type { ParkSaveV7 } from './state';
import { SaveError, createParkSave, type ParkSaveAppState } from './version';
import { migrateSave } from './migrate';
import { sessionFromSave } from '../session/fromSave';

/**
 * Adversarial review of Phase 27 step 4 (lift hills: chain or free), determinism and persistence.
 *
 * The pinned hashes below were produced by the PRE-CHANGE code (the archived src/game of the step 3
 * review, schema 4, no lift flags) running the same inputs, and then compared with this build after
 * removing the one new key (`rules.chainLiftCostMultiplier`). They prove that a chained park plays
 * bit for bit as it did before the change. A LATER deliberate gameplay change may re-pin them;
 * this step must not.
 */

const fixtures = import.meta.glob<Record<string, unknown>>('./fixtures/*.json', { import: 'default', eager: true });
const fixture = (name: string): Record<string, unknown> => structuredClone(fixtures[`./fixtures/${name}`] ?? {});

/**
 * The state hash without the schema-5 rule key, i.e. the shape the schema-4 code hashed. Phase 28
 * colours (schema 6, written only for a recoloured object) and the schema-7 `rules.recolourCostMultiplier` and
 * `world.gateColours` are stripped too: the dev park fixture now
 * recolours some rides, and the pins below must keep proving that the simulation itself is unchanged.
 */
const preChangeHash = (state: unknown): string => {
  // Phase 29 (schema 15): the guest fields, a sick pile's flag and the souvenir total are new keys too.
  const copy = JSON.parse(JSON.stringify(stripGuestLife(state))) as { map?: unknown; rules?: Record<string, unknown>; world?: { objects?: Array<Record<string, unknown>>; gateColours?: unknown } };
  if (copy.rules) {
    delete copy.rules.chainLiftCostMultiplier;
    delete copy.rules.recolourCostMultiplier;
    // Phase 24: the biome rule layer is only ever written for a non-Meadow biome.
    delete copy.rules.hungerRateMultiplier;
    delete copy.rules.thirstRateMultiplier;
    // Phase 16 (content version 3): the two base-layer keys a new park now stores. Their EFFECT on play is re-pinned below.
    delete copy.rules.themeAffinity;
    delete copy.rules.researchCostScale;
    // Phase 14 (content version 4): the crowd feedback rule a new park now stores.
    delete copy.rules.crowdFeedback;
  }
  // Phase 24 (schema 8): the land layer is a new top-level key.
  delete copy.map;
  // Phase 14 (schema 13): the crowd field, written exactly when rules.crowdFeedback is. Below the lane capacity it never
  // reaches play (the factor is the literal 1), so with both keys removed every pin below holds unchanged.
  delete (copy as Record<string, unknown>).crowd;
  // Phase 22 (schema 10): the game mode and the profile grant are new top-level keys; the ruleset's bonus keys exist only with a bonus.
  delete (copy as Record<string, unknown>).mode;
  delete (copy as Record<string, unknown>).grant;
  if (copy.world) delete copy.world.gateColours;
  for (const object of copy.world?.objects ?? []) delete object.colours;
  return hashState(copy);
};

/**
 * Hash at load, then every 500 ticks up to 3000, from the schema-4 code. Re-pinned 2026-10-15, Phase 29: the coaster
 * sandbox's guests now live (benches, pauses, nausea on the coaster), so its play moved from tick 500 on; its hash at load
 * (Phase 29 keys stripped) and the whole scenario run are unchanged.
 */
const PRE_CHANGE_SAVE_RUNS: Record<string, readonly string[]> = {
  'park-v4-sandbox-coaster.json': ['fdc0567879213f99', '5d7cff896c29a3cc', '3808cf655c541723', '63c3825ac673b55f', '82053eae7fbcb2e5', '9b6ccc4ae3144b3f', 'c2264e12eca77785'],
  'park-v4-scenario.json': ['3b85f771e65be0ca', 'bfccb36a4730662d', 'f6ecb42c0a216dea', '842045d0fe3f23d0', 'b207436982b92981', 'd9dc78a0f775954a', 'c1d24fa7882cc35e'],
};

/**
 * finalState (minus the new key), event stream, fingerprints and observables of each pre-change fixture.
 *
 * Re-pinned 2026-10-13, Phase 16 (content version 3), the deliberate gameplay change the header allows: a fresh fixture
 * park now compiles themeAffinity 0.2 and researchCostScale 10. With both neutral every value below is the pre-Phase-16
 * pin again (checked in the Phase 16 W2 scratch probe). The scale alone moves the observables (the progression snapshot
 * shows effective RP costs) and the events of the parks that buy research (researchPointsSpent); final states do not move
 * (the fixtures' grants keep the leftover RP identical). The affinity moves the final state and fingerprints of the parks
 * with same-theme scenery beside a themed ride or stall. Old values: P/impl/W2-P/repins.md in the Phase 16 scratchpad and
 * BALANCE_NOTES Phase 16.
 *
 * Re-pinned 2026-10-14, Phase 14 (content version 4): a new park compiles crowdFeedback 1 and saves its crowd field; both
 * keys are stripped by `preChangeHash`. Eight parks never reach the lane capacity (400 guests a minute) and keep every
 * value above. Three walk above it, so the congestion feedback really slows guests and the pins below moved (old -> new;
 * with GAME_CONFIG.crowd.feedback mocked to 0 every old value is reproduced exactly, final, events, fingerprints and
 * observables; Phase 14 scratch impl/6/repins.md and BALANCE_NOTES Phase 14):
 * - dev park, 1,000 guests, coaster: final 25dd66db96977cfe -> 254e7501ac0fae2e, events 0f1fb7ff344ea558 ->
 *   c2c55cd72e7d0a8d, fingerprints cfbe8b8222e35185 -> 2d49ee89e7fe5125, observables 37c1e53eff752903 -> cf3aa8955256aeb2.
 * - scenario latched success: final c3c9ad9e05f9dd62 -> d4ef22e43440bbc2, observables 9271120420e6d33d -> e105225732848376.
 * - scenario mid sustain streak: final 6a705be23903b303 -> 1e4ebf326333c689, observables 9ac108b4107dc253 ->
 *   289667545c3b32c7.
 *
 * Re-pinned 2026-10-15, Phase 29 (schema 15, content version 5), a deliberate gameplay change: guest life (benches,
 * pauses, nausea and sickness, warmth, souvenirs) moves the play of the parks below. The Phase 29 save keys are stripped
 * by `preChangeHash` (and their neutral values from the observables, determinismHarness.ts). Unmoved: all of 'scenario
 * mid sustain streak', and the event streams of 'scenario latched failure' and 'pre-first-step and right after
 * removeAll'. That the switched-off code is bit-identical to the code before Phase 29 is proven by
 * session/defaultIdentity.review.test.ts, which runs with `guestLife.enabled` off and keeps its pins.
 */
const PRE_CHANGE_FIXTURES: Record<string, { final: string; events: string; fingerprints: string; observables: string }> = {
  'dev park, 1,000 guests, coaster': { final: 'e7426a1460e9c532', events: '434357e733752ff5', fingerprints: '0c091d5c29dd207d', observables: '54d113d6d027070f' },
  'scenario with Pulse Cards and a rules-locked id': { final: '61979b25761df373', events: '5d9b00c22adcfee6', fingerprints: 'e02f287bea932338', observables: '0b01b67198677831' },
  'scenario latched success': { final: 'e5c36d65bc70dee2', events: '9030f462ddf66049', fingerprints: '28065ad7d491be07', observables: '07e11b8f39c612d6' },
  'scenario latched failure': { final: '13f46a1213a0c5d9', events: '6ace405e46b8ecc5', fingerprints: 'b3e95127fb35fc41', observables: '83c0c8b337a916ea' },
  'scenario mid sustain streak': { final: '1e4ebf326333c689', events: '008be93323b5a50d', fingerprints: '257c3bc00aee79d5', observables: '289667545c3b32c7' },
  'player-built coaster with loop and boost, bulldozed later': { final: 'b763cf8dc108dd3d', events: '006aba6e0edb64d2', fingerprints: '99c95c29dd5d96dd', observables: '2f03a5712350c52b' },
  'hand-driven park: breakdown, repair, litter, closure, research': { final: '47e98c509914e8f2', events: 'e7164638c7e0e06f', fingerprints: '150ab2e0ccb4a712', observables: '44e2483fdccf586b' },
  'first day: sandbox progression latching, skip and dismiss': { final: 'c538ab72587fd479', events: '9edf55db86116ffb', fingerprints: 'a8194581755b9e05', observables: '10db11263bf5f717' },
  'pre-first-step and right after removeAll': { final: '62f86010c6d2a219', events: 'bf28cd9330b85580', fingerprints: '0ae8926bcf542f2d', observables: '139fdb1f1033dabb' },
  'park calendar: short days, a length change and a time lock': { final: '1906767a12d1429a', events: '48e3543b50ee22ac', fingerprints: '6e66ee2c190a20f9', observables: 'd3e06f3416265a6a' },
  'weather: a stormy afternoon with a storm-closed ride, a player-closed ride and opening hours': { final: 'd3c460c30e208ba0', events: '7211ebd9cb3cf3c1', fingerprints: 'd24163be0630ad08', observables: 'be5ad71b5e28f279' },
};

describe('lift review: a chained park is bit-identical to the pre-change code', () => {
  it.each(Object.keys(PRE_CHANGE_SAVE_RUNS))('%s migrates and plays 3000 ticks on the old hashes', (name) => {
    const { session } = sessionFromSave(fixture(name));
    expect(session.rules.chainLiftCostMultiplier).toBe(1);
    for (const record of session.world.coasters.values()) {
      expect(record.pieces.some((piece) => 'freeClimb' in piece), 'every migrated piece is chained').toBe(false);
    }
    const hashes = [preChangeHash(session.serialize())];
    for (let tick = 1; tick <= 3000; tick += 1) {
      session.step(GAME_CONFIG.fixedStepMs);
      if (tick % 500 === 0) hashes.push(preChangeHash(session.serialize()));
    }
    expect(hashes).toEqual(PRE_CHANGE_SAVE_RUNS[name]);
  });

  const preChange = DETERMINISM_FIXTURES.filter((candidate) => candidate.name in PRE_CHANGE_FIXTURES);
  it('every pre-change determinism fixture still exists', () => {
    expect(preChange.length).toBe(Object.keys(PRE_CHANGE_FIXTURES).length);
  });

  it.each(preChange.map((candidate) => [candidate.name, candidate] as const))('%s: same final state, events and observables as before', (name, subject) => {
    const trace = runReference({
      build: subject.build,
      act: subject.act,
      total: subject.total,
      checkpointTicks: new Set(),
      checkpoints: false,
      observeAtEnd: true,
    });
    expect({
      final: preChangeHash(trace.finalState),
      events: hashState(trace.eventHashes),
      fingerprints: hashState(trace.fingerprints),
      observables: hashState(trace.observables),
    }).toEqual(PRE_CHANGE_FIXTURES[name]);
  });
});

/** A schema-5 park with a free-climb coaster: the determinism fixture at its tick-250 save point. */
const freeParkState = (): ParkSaveV7 => {
  const subject = DETERMINISM_FIXTURES.find((candidate) => candidate.name.includes('free-climb'));
  if (!subject) throw new Error('the free-climb determinism fixture is missing');
  const session = subject.build();
  for (let tick = 0; tick < 250; tick += 1) {
    subject.act(session, tick);
    session.step(GAME_CONFIG.fixedStepMs);
  }
  return JSON.parse(JSON.stringify(session.serialize())) as ParkSaveV7;
};

type PieceRecord = Record<string, unknown> & { height: number };
const freeCoasterPieces = (state: ParkSaveV7): PieceRecord[] => {
  const record = state.world.coasters.find((candidate) => candidate.pieces.some((piece) => piece.freeClimb === true));
  if (!record) throw new Error('no free coaster in the state');
  return record.pieces as unknown as PieceRecord[];
};

const APP: ParkSaveAppState = { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null };

/** Loads through the full path a stored file takes (envelope, integrity hash, migration, restore). */
const loadOutcome = (state: ParkSaveV7): string => {
  const save = createParkSave(state, APP, 0);
  const started = performance.now();
  try {
    sessionFromSave(save);
    return 'accepted';
  } catch (error) {
    expect(performance.now() - started, 'a hostile flag must be refused quickly, not after a hang').toBeLessThan(2_000);
    if (!(error instanceof SaveError)) return `NOT A SaveError: ${String(error)}`;
    return error.message;
  }
};

describe('lift review: hostile lift flags in a schema-5 save', () => {
  const base = freeParkState();
  const pieces = freeCoasterPieces(base);
  const climbing = pieces.map((_piece, index) => isClimbingSegment(pieces as unknown as CoasterPiece[], index));
  const freeIndex = pieces.findIndex((piece) => piece.freeClimb === true);
  const flatIndex = climbing.findIndex((climbs, index) => !climbs && index > 2 && pieces[(index + 1) % pieces.length].height === pieces[index].height);
  const downIndex = pieces.findIndex((piece, index) => pieces[(index + 1) % pieces.length].height < piece.height);
  const editing = (edit: (target: PieceRecord[]) => void): ParkSaveV7 => {
    const state = structuredClone(base);
    edit(freeCoasterPieces(state));
    return state;
  };

  it('the untouched free park loads via fromSave and round trips to the same hash', () => {
    expect(freeIndex).toBeGreaterThan(0);
    const { session } = sessionFromSave(createParkSave(structuredClone(base), APP, 0));
    expect(hashState(session.serialize())).toBe(hashState(base));
  });

  it.each([
    ['the string "true"', 'true'],
    ['the number 1', 1],
    ['false', false],
    ['null', null],
    ['an object', {}],
    ['an array', [true]],
  ] as const)('a freeClimb of %s is refused with a SaveError', (_label, value) => {
    const state = editing((target) => { target[freeIndex].freeClimb = value; });
    expect(loadOutcome(state)).toMatch(/freeClimb/);
  });

  it('NaN and undefined values never reach a session (fromState refuses NaN; undefined is not plain data)', () => {
    const nan = editing((target) => { target[freeIndex].freeClimb = Number.NaN; });
    expect(() => ParkSession.fromState(nan)).toThrow(SaveError);
  });

  it('a flag on a flat segment, a downhill segment or the station is refused', () => {
    expect(flatIndex).toBeGreaterThan(0);
    expect(downIndex).toBeGreaterThan(0);
    for (const index of [flatIndex, downIndex, 0]) {
      expect(loadOutcome(editing((target) => { target[index].freeClimb = true; })), `piece ${index}`).toContain('lift-flag-not-climbing');
    }
  });

  it('a run that is only partly free is refused, whichever segment carries the odd mode', () => {
    for (const run of liftRuns(pieces as unknown as CoasterPiece[]).filter((candidate) => candidate.length > 1)) {
      for (let offset = 0; offset < run.length; offset += 1) {
        const outcome = loadOutcome(editing((target) => {
          const index = (run.start + offset) % target.length;
          if (target[index].freeClimb === true) delete target[index].freeClimb;
          else target[index].freeClimb = true;
        }));
        expect(outcome, `run ${run.start} offset ${offset}`).toMatch(/lift-run-mixed/);
      }
    }
  });

  it('a travelSeconds array of the wrong length is refused', () => {
    const state = structuredClone(base);
    const record = state.world.coasters.find((candidate) => candidate.pieces.some((piece) => piece.freeClimb === true))!;
    record.stats.travelSeconds = record.stats.travelSeconds.slice(1);
    expect(loadOutcome(state)).toContain('travelSeconds');
  });

  it('flipping a flag without re-stamping the hash is caught by the integrity check', () => {
    const save = createParkSave(structuredClone(base), APP, 0) as unknown as { state: ParkSaveV7 };
    delete (freeCoasterPieces(save.state)[freeIndex] as Record<string, unknown>).freeClimb;
    expect(() => sessionFromSave(save)).toThrow(/integrity/);
  });
});

describe('lift review: migration 4 -> 5 on hostile schema-4 shapes', () => {
  /** A schema-4 fixture edited by `edit`, re-stamped so it passes its own integrity check. */
  const v4 = (edit: (state: Record<string, unknown>) => void): Record<string, unknown> => {
    const save = fixture('park-v4-sandbox-coaster.json') as { state: Record<string, unknown>; stateHash: string };
    edit(save.state);
    save.stateHash = hashState(save.state);
    return save;
  };
  const outcome = (raw: Record<string, unknown>): string => {
    try { sessionFromSave(raw); return 'accepted'; } catch (error) {
      return error instanceof SaveError ? `SaveError ${error.code}` : `NOT A SaveError: ${String(error)}`;
    }
  };

  it('a missing world, a non-array coasters, a non-object piece or a null rules block is a SaveError, never a TypeError', () => {
    const cases: Array<(state: Record<string, unknown>) => void> = [
      (state) => { delete state.world; },
      (state) => { (state.world as Record<string, unknown>).coasters = 'none'; },
      (state) => { ((state.world as { coasters: Array<{ pieces: unknown[] }> }).coasters[0].pieces)[3] = null; },
      (state) => { ((state.world as { coasters: Array<{ pieces: unknown }> }).coasters[0]).pieces = 7; },
      (state) => { state.rules = null; },
    ];
    for (const [index, edit] of cases.entries()) expect(outcome(v4(edit)), `case ${index}`).toMatch(/^SaveError/);
  });

  it('a v4 piece carrying any freeClimb value (true, false, "x", {}) loads as chained', () => {
    for (const value of [true, false, 'x', {}]) {
      const migrated = migrateSave(v4((state) => {
        for (const record of (state.world as { coasters: Array<{ pieces: Array<Record<string, unknown>> }> }).coasters) {
          for (const piece of record.pieces) piece.freeClimb = value;
        }
      }));
      expect(JSON.stringify(migrated.state)).not.toContain('freeClimb');
      expect(outcome(migrated as unknown as Record<string, unknown>)).toBe('accepted');
    }
  });
});

describe('lift review: the chain lift rule in a save and in the compiler', () => {
  const base = freeParkState();
  const withRule = (value: unknown): ParkSaveV7 => {
    const state = structuredClone(base);
    (state.rules as unknown as Record<string, unknown>).chainLiftCostMultiplier = value;
    return state;
  };

  it.each([['missing', undefined], ['NaN', Number.NaN], ['zero', 0], ['negative', -1], ['huge', 1e9], ['a string', '1']] as const)(
    'a saved rule that is %s is refused',
    (_label, value) => {
      const state = withRule(value);
      if (value === undefined) delete (state.rules as unknown as Record<string, unknown>).chainLiftCostMultiplier;
      expect(() => ParkSession.fromState(state)).toThrow(SaveError);
    },
  );

  it('an in-range saved rule is used verbatim and survives a round trip', () => {
    for (const value of [0.01, 0.25, 4, 100]) {
      const session = ParkSession.fromState(withRule(value));
      expect(session.rules.chainLiftCostMultiplier).toBe(value);
      expect(session.serialize().rules.chainLiftCostMultiplier).toBe(value);
    }
  });

  it('cards compose by product and the result clamps to the rule bounds', () => {
    const rule = (cards: Array<Record<string, number>>, scenario?: number): number =>
      compileParkRules(scenario === undefined ? undefined : { chainLiftCostMultiplier: scenario }, cards).chainLiftCostMultiplier;
    expect(rule([])).toBe(1);
    expect(rule([{ chainLiftCostMultiplier: 3 }, { chainLiftCostMultiplier: 3 }])).toBe(RULE_CLAMPS.maximumMultiplier);
    expect(rule([{ chainLiftCostMultiplier: 0.5 }, { chainLiftCostMultiplier: 0.4 }])).toBe(RULE_CLAMPS.minimumMultiplier);
    expect(rule([{ chainLiftCostMultiplier: 2 }, { chainLiftCostMultiplier: 0.5 }])).toBe(1);
    expect(rule([{ chainLiftCostMultiplier: Number.NaN }, { chainLiftCostMultiplier: -2 }, { chainLiftCostMultiplier: 0 }])).toBe(1);
    expect(rule([], 0)).toBe(1);
    expect(rule([], Number.POSITIVE_INFINITY)).toBe(1);
    expect(rule([{ chainLiftCostMultiplier: 1.5 }], 2)).toBe(3);
    // Other rules are untouched by a chain card.
    expect(compileParkRules(undefined, [{ chainLiftCostMultiplier: 2 }]).constructionCostMultiplier).toBe(1);
  });

  it('cost: multiplier 1 is the pre-change price; other multipliers move only the chained share', () => {
    const type = COASTER_TYPE_BY_ID.get('skyline-serpent')!;
    const legacy = (pieces: CoasterPiece[]): number => type.stationCost
      + pieces.length * type.pieceCost
      + pieces.reduce((total, piece) => total + piece.height, 0) * type.heightCostPerLevel
      + pieces.reduce((total, piece) => total + (piece.special ? GAME_CONFIG.coaster.specials[piece.special].cost : 0), 0);
    for (const pieces of [ovalLayout(), zigzagLayout(), hillDipLayout(), tallLayout(), longestLayout()]) {
      expect(Object.is(coasterBaseCost(pieces, type), legacy(pieces))).toBe(true);
      expect(coasterBaseCost(pieces, type, 1)).toBe(legacy(pieces));
      const climbing = pieces.filter((_piece, index) => isClimbingSegment(pieces, index)).length;
      for (const multiplier of [RULE_CLAMPS.minimumMultiplier, 0.333, 2, RULE_CLAMPS.maximumMultiplier]) {
        const cost = coasterBaseCost(pieces, type, multiplier);
        expect(Number.isInteger(cost)).toBe(true);
        expect(cost).toBe(legacy(pieces) + climbing * (Math.round(GAME_CONFIG.coaster.lift.chainCostPerPiece * multiplier) - GAME_CONFIG.coaster.lift.chainCostPerPiece));
      }
      // A fully free layout pays no chain at all, whatever the rule.
      const free = withFreeLifts(structuredClone(pieces));
      expect(coasterBaseCost(free, type, 4)).toBe(coasterBaseCost(free, type, 0.25));
    }
  });
});

describe('lift review: the free-climb model under hostile and random input', () => {
  const creep = creepSpeedMilli();
  const subjects: CoasterPiece[][] = [];
  for (let seed = 1; subjects.length < 300 && seed < 5000; seed += 1) {
    const pieces = randomCircuit(seed, 12 + 2 * (seed % 10), 7);
    if (pieces) subjects.push(withFreeLifts(pieces));
  }
  subjects.push(withFreeLifts(tallLayout()), withFreeLifts(longestLayout()), withFreeLifts(zigzagLayout()));

  it('every free segment is at or above the creep floor, finite, on whole milli-cells, and never faster than it entered unless lifted to the floor', () => {
    expect(subjects.length).toBeGreaterThan(200);
    for (const pieces of subjects) {
      const trace = coasterSpeedTrace(pieces);
      pieces.forEach((piece, index) => {
        expect(Number.isFinite(trace.travelSeconds[index]) && trace.travelSeconds[index] > 0).toBe(true);
        if (piece.freeClimb !== true) return;
        const exitMilli = trace.exitSpeeds[index] * GAME_CONFIG.coaster.lift.speedScale;
        const heldMilli = trace.segmentSpeeds[index] * GAME_CONFIG.coaster.lift.speedScale;
        expect(Math.abs(exitMilli - Math.round(exitMilli))).toBeLessThan(1e-6);
        expect(Math.abs(heldMilli - Math.round(heldMilli))).toBeLessThan(1e-6);
        expect(Math.round(exitMilli)).toBeGreaterThanOrEqual(creep);
        expect(Math.round(heldMilli)).toBeGreaterThanOrEqual(creep);
        expect(trace.creepHits[index]).toBe(Math.round(exitMilli) === creep || trace.creepHits[index]);
        const before = trace.exitSpeeds[(index - 1 + pieces.length) % pieces.length];
        // A loop on the same piece scrubs speed first; compare against the floor in that case too.
        expect(trace.exitSpeeds[index]).toBeLessThanOrEqual(Math.max(before, creep / GAME_CONFIG.coaster.lift.speedScale) + 1e-9);
      });
    }
  });

  it('a long free climb from a standstill-like entry never stalls: travel time stays bounded by the floor', () => {
    const pieces = withFreeLifts(tallLayout());
    const trace = coasterSpeedTrace(pieces);
    const ceiling = 1 / (creep / GAME_CONFIG.coaster.lift.speedScale);
    pieces.forEach((piece, index) => {
      if (piece.freeClimb === true) expect(trace.travelSeconds[index]).toBeLessThanOrEqual(ceiling + 1e-12);
    });
  });

  it('is bit-identical across 1000 sweeps of random hostile circuits (Object.is on every number)', () => {
    const sample = subjects.slice(0, 40);
    const reference = sample.map((pieces) => coasterSpeedTrace(pieces));
    for (let run = 0; run < 1000; run += 1) {
      sample.forEach((pieces, subject) => {
        const again = coasterSpeedTrace(pieces);
        for (const key of ['travelSeconds', 'segmentSpeeds', 'exitSpeeds'] as const) {
          again[key].forEach((value, index) => {
            if (!Object.is(value, reference[subject][key][index])) throw new Error(`run ${run} subject ${subject} ${key}[${index}]`);
          });
        }
      });
    }
  });
});

describe('lift review: a toggle and its undo leave no trace in the saved shape', () => {
  it('toggle twice restores the exact JSON of every piece (no freeClimb: false or undefined key left behind)', () => {
    for (const make of [ovalLayout, zigzagLayout, hillDipLayout, tallLayout]) {
      const pieces = make();
      const before = JSON.stringify(pieces);
      for (const run of liftRuns(pieces)) {
        toggleLiftRun(pieces, run.start);
        expect(JSON.stringify(pieces)).not.toBe(before);
        toggleLiftRun(pieces, run.start);
        expect(JSON.stringify(pieces)).toBe(before);
        expect(pieces.every((piece) => !('freeClimb' in piece))).toBe(true);
      }
    }
  });
});
