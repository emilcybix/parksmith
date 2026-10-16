import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { entranceFrame } from '../maps/frame';
import { rewardEligible } from '../profile/eligibility';
import { hashState } from '../save/hash';
import { SaveError, createParkSave } from '../save/version';
import { migrateSave } from '../save/migrate';
import { ParkSession } from '../session/ParkSession';
import { SCENARIOS } from '../scenarios/content';
import { acceptOffer, abandonRun, createRun, resolveStage, runHash, startStage } from './deck';
import { forceStageOutcomeForDevelopment } from './dev';
import { buildStage, stageDefinitionOf } from './stage';
import { testStageSession } from './testSupport';
import { RUN_STAGE_SCENARIO_ID, type RunState } from './types';
import { sessionFromSave } from '../session/fromSave';

/**
 * Phase 23: a stage is a ParkSession in mode `run`. Construction rules, the schema-11 `run` key, the advanceRun guard,
 * undo inside a stage, the backdrop between stages, and a save round trip with hash proofs at every phase.
 */
const step = (session: ParkSession, ticks: number): void => { for (let i = 0; i < ticks; i += 1) session.step(GAME_CONFIG.fixedStepMs); };
const ok = (result: { ok: boolean; run?: RunState }): RunState => { if (!result.ok || !result.run) throw new Error('refused'); return result.run; };
const SPARE = { unlockedBuildingIds: [], bonusIds: ['spare-slot' as const] };

/** The park route of the capture fixtures, in the entrance frame: works on any generated map. */
const build = (session: ParkSession): void => {
  const w = session.world;
  const frame = entranceFrame({ ...w.entrance, facing: w.entranceFacing });
  w.buildPaths(Array.from({ length: 10 }, (_, depth) => frame.toWorld(0, depth + 1)));
  for (const [id, l, d] of [['moonpetal-carousel', 1, 3], ['picnic-pocket', 1, 1], ['fizz-foundry', -2, 1]] as const) {
    const footprint = id === 'moonpetal-carousel' ? [3, 3] : [1, 1];
    const anchor = frame.rectToWorld(l, d, footprint[0], footprint[1]);
    w.buildObject(id, anchor, frame.rotation);
  }
  session.syncWithWorld();
};

const roundTrip = (session: ParkSession): ParkSession => {
  session.syncWithWorld();
  const save = createParkSave(session.serialize(), { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 1);
  return sessionFromSave(JSON.parse(JSON.stringify(save))).session;
};

describe('a run stage session', () => {
  it('is a Scenario-like park in mode run: stage definition, loadout cards, run grant, generated map, level seed', () => {
    const { session, run } = testStageSession({ grant: SPARE, cardCount: 2 });
    expect(session.mode).toBe('run');
    expect(session.run).toEqual(run);
    expect(session.scenarioDefinition?.id).toBe(RUN_STAGE_SCENARIO_ID);
    expect(session.scenarioDefinition?.name).toBe(`Level 1 · Meadow`);
    expect(session.activeCards.map((card) => card.id)).toEqual(run.loadout);
    expect(session.grant).toEqual(run.grant);
    expect(session.seed).toBe(run.levels[0].parkSeed);
    expect(session.map.recipe).toEqual(run.levels[0].recipe);
    expect(session.world.cash).toBe(run.levels[0].startingCash);
    expect(session.onboarding).toBeNull();
    expect(session.scenarioSnapshot()?.objective.target).toBe(run.levels[0].objective.target);
    expect(session.scenarioSnapshot()?.cardSlots).toBe(1);
  });

  it('compiles the ruleset layers: level cash and conditions, the run grant, then the loadout cards', () => {
    const run = ok(acceptOffer(createRun({ seed: 1234, difficulty: 'tough', grant: { unlockedBuildingIds: [], bonusIds: ['nest-egg', 'word-of-mouth'] } })));
    const staged = (() => { let current = run; while (current.levelIndex < 3) current = ok(acceptOffer(ok(resolveStage(ok(startStage(current, [])), { outcome: 'succeeded', atSeconds: 9, evidence: null })))); return current; })();
    const card = staged.deck[0];
    const started = ok(startStage(staged, [card]));
    const { definition, layout } = buildStage(started, 3);
    const session = new ParkSession(definition, [card], { mode: 'run', grant: started.grant, layout, run: started });
    expect(definition.rules.startingCash).toBe(started.levels[3].startingCash);
    expect(session.rules.startingCash).toBe(started.levels[3].startingCash + 500);
    const plain = new ParkSession(definition, [], { mode: 'run', grant: started.grant, layout, run: { ...started, loadout: [] } });
    expect(session.rules).not.toEqual(plain.rules);
    expect(rewardEligible(session)).toBe(true);
  });

  it('refuses every construction that does not fit a run (RangeError)', () => {
    const { session, run } = testStageSession({ cardCount: 1 });
    const { definition, layout } = buildStage(run, 0);
    const make = (options: Record<string, unknown>, cards = run.loadout): ParkSession => new ParkSession(definition, cards, { layout, ...options });
    expect(() => make({ mode: 'run', grant: run.grant })).toThrow(RangeError);
    expect(() => make({ mode: 'scenario', grant: run.grant, run })).toThrow(RangeError);
    expect(() => new ParkSession(SCENARIOS[0], [], { mode: 'run', run })).toThrow(RangeError);
    expect(() => make({ mode: 'scenario', grant: run.grant })).toThrow(RangeError);
    expect(() => make({ mode: 'run', grant: run.grant, run }, [])).toThrow(RangeError);
    expect(() => make({ mode: 'run', grant: { unlockedBuildingIds: ['tiki-tumbler'], bonusIds: [] }, run })).toThrow(RangeError);
    expect(() => new ParkSession(null, [], { mode: 'run', run })).toThrow(RangeError);
    expect(() => new ParkSession(null, [], { run })).toThrow(RangeError);
    expect(session.mode).toBe('run');
  });

  it('serializes `plays` then `run` as the LAST keys, and only in mode run (Sandbox and Scenario states keep the schema 10 keys)', () => {
    const { session } = testStageSession({ cardCount: 1 });
    const keys = Object.keys(session.serialize());
    expect(keys.at(-1)).toBe('run');
    expect(keys.at(-2)).toBe('plays');
    expect(keys.at(-3)).toBe('grant');
    expect(Object.keys(new ParkSession(null).serialize())).not.toContain('run');
    expect(Object.keys(new ParkSession(SCENARIOS[0], []).serialize())).not.toContain('run');
    expect(Object.keys(new ParkSession(SCENARIOS[0], []).serialize())).not.toContain('plays');
    expect(new ParkSession(SCENARIOS[0], []).plays).toBeNull();
    expect(Object.keys(new ParkSession(null).serialize()).at(-1)).toBe('grant');
  });

  it('the stage definition is a pure function of the run: the same for a new park and for a restore', () => {
    const { run } = testStageSession({ cardCount: 1 });
    const first = buildStage(run, 0);
    const again = stageDefinitionOf(run, 0, first.layout.entrance);
    expect(hashState(again)).toBe(hashState(first.definition));
    expect(first.definition.setup.paths).toHaveLength(3);
    expect(first.definition.rewards).toEqual({ cardDraftChoices: 0, unlocks: [], bonuses: [] });
  });

  it('a recipe of another generator version cannot be built: a content-mismatch the app shows', () => {
    const { run } = testStageSession({ cardCount: 1 });
    const old = { ...run, levels: run.levels.map((level, index) => (index === 0 ? { ...level, recipe: { ...level.recipe, generatorVersion: 1 } } : level)) };
    expect(() => buildStage(old, 0)).toThrow(SaveError);
    try { buildStage(old, 0); } catch (error) { expect((error as SaveError).code).toBe('content-mismatch'); }
  });
});

describe('advanceRun', () => {
  it('takes the result of acceptOffer, resolveStage or abandonRun, and refuses everything else (RangeError)', () => {
    const { session, run } = testStageSession({ cardCount: 1 });
    const before = runHash(run);
    expect(() => session.advanceRun(run)).toThrow(RangeError);
    expect(() => session.advanceRun({ ...run, deck: [] })).toThrow(RangeError);
    expect(() => session.advanceRun({ ...run, phase: 'won' })).toThrow(RangeError);
    expect(runHash(session.run!)).toBe(before);
    const cleared = ok(resolveStage(run, { outcome: 'succeeded', atSeconds: 90, evidence: 'e' }));
    session.advanceRun(cleared);
    expect(session.run).toEqual(cleared);
    expect(session.run).not.toBe(cleared);
    expect(session.run?.parkLevelIndex).toBe(0);
    expect(() => session.advanceRun(cleared)).toThrow(RangeError);
    expect(() => new ParkSession(null).advanceRun(cleared)).toThrow(RangeError);
  });
});

describe('inside a stage the run is constant: undo cannot cross it', () => {
  it('rewinding to any earlier image keeps the run byte for byte (50 random edits and rewinds)', () => {
    const { session, run } = testStageSession({ cardCount: 1 });
    const frame = entranceFrame({ ...session.world.entrance, facing: session.world.entranceFacing });
    const expected = runHash(run);
    let state = 7;
    const next = (): number => { state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0; return state / 4_294_967_296; };
    session.syncWithWorld();
    const images: ReturnType<ParkSession['serialize']>[] = [JSON.parse(JSON.stringify(session.serialize()))];
    for (let index = 0; index < 50; index += 1) {
      if (next() < 0.6) {
        const cell = frame.toWorld(Math.floor(next() * 5) - 2, 1 + Math.floor(next() * 8));
        session.world.buildPaths([cell]);
        session.syncWithWorld();
        step(session, 3);
        images.push(JSON.parse(JSON.stringify(session.serialize())));
      } else {
        const image = images[Math.floor(next() * images.length)];
        const restored = ParkSession.fromState(JSON.parse(JSON.stringify(image)));
        expect(runHash(restored.run!), `rewind ${index}`).toBe(expected);
        expect(hashState(restored.serialize())).toBe(hashState(image));
        session.restoreState(JSON.parse(JSON.stringify(image)));
        session.syncWithWorld();
        expect(runHash(session.run!)).toBe(expected);
      }
    }
    for (const image of images) expect(runHash(image.run!)).toBe(expected);
  });

  it('restoreState refuses an image of another run state', () => {
    const { session } = testStageSession({ cardCount: 1 });
    session.syncWithWorld();
    const other = JSON.parse(JSON.stringify(session.serialize()));
    other.run.history = [{ levelIndex: 0, outcome: 'failed', atSeconds: 1, evidence: null, cardIds: other.run.loadout }];
    other.run.phase = 'lost';
    expect(() => session.restoreState(other)).toThrow(SaveError);
  });
});

describe('save and load of a run, at every phase (hash proofs)', () => {
  const stageRun = (): { session: ParkSession; run: RunState } => testStageSession({ grant: SPARE, cardCount: 2 });

  it('mid-stage: serialize, envelope, JSON, fromSave gives the same state hash, the same later hashes and the same run', () => {
    const { session } = stageRun();
    build(session);
    step(session, 300);
    const restored = roundTrip(session);
    expect(hashState(restored.serialize())).toBe(hashState(session.serialize()));
    expect(restored.run).toEqual(session.run);
    step(session, 200);
    step(restored, 200);
    expect(hashState(restored.serialize())).toBe(hashState(session.serialize()));
  });

  it('at every phase of a run: the backdrop of the first offer, the loadout, a cleared stage, the next offer, a failure, a victory and an abandon', () => {
    const fresh = createRun({ seed: 2024, difficulty: 'standard', grant: SPARE });
    const backdrop = (run: RunState, atLevel = run.parkLevelIndex): ParkSession => {
      const { definition, layout } = buildStage(run, atLevel);
      return new ParkSession(definition, run.loadout, { mode: 'run', grant: run.grant, layout, run });
    };
    const phases: Array<[string, ParkSession]> = [];
    phases.push(['first offer', backdrop(fresh)]);
    const loadout = ok(acceptOffer(fresh));
    phases.push(['first loadout', backdrop(loadout)]);
    const started = ok(startStage(loadout, [loadout.deck[0]]));
    const stage = backdrop(started);
    build(stage);
    step(stage, 50);
    phases.push(['stage', stage]);
    // A cleared stage: the park keeps its finished scenario, the run moves on.
    const won = backdrop(started);
    build(won);
    forceStageOutcomeForDevelopment(won, 'succeeded');
    const events = won.step(GAME_CONFIG.fixedStepMs);
    expect(events.scenario.map((event) => event.kind)).toEqual(['scenarioSucceeded']);
    won.advanceRun(ok(resolveStage(started, { outcome: 'succeeded', atSeconds: events.scenario[0].atSeconds, evidence: events.scenario[0].evidence })));
    phases.push(['after a clear (offer of level 2)', won]);
    const lost = backdrop(started);
    forceStageOutcomeForDevelopment(lost, 'failed');
    const lostEvents = lost.step(GAME_CONFIG.fixedStepMs);
    lost.advanceRun(ok(resolveStage(started, { outcome: 'failed', atSeconds: lostEvents.scenario[0].atSeconds, evidence: lostEvents.scenario[0].evidence })));
    phases.push(['after a failure', lost]);
    const abandoned = backdrop(started);
    abandoned.advanceRun(ok(abandonRun(started, 0)));
    phases.push(['abandoned in a stage', abandoned]);
    const abandonedBetween = backdrop(fresh);
    abandonedBetween.advanceRun(ok(abandonRun(fresh)));
    phases.push(['abandoned at the first offer', abandonedBetween]);
    for (const [label, session] of phases) {
      const restored = roundTrip(session);
      expect(hashState(restored.serialize()), label).toBe(hashState(session.serialize()));
      expect(restored.run, label).toEqual(session.run);
      expect(runHash(restored.run!), label).toBe(runHash(session.run!));
    }
  });

  it('the stage is eligible for rewards, before and after a save', () => {
    const { session } = stageRun();
    expect(rewardEligible(session)).toBe(true);
    expect(rewardEligible(roundTrip(session))).toBe(true);
  });
});

describe('hostile run parks (refused as invalid-state or content-mismatch, never half-loaded)', () => {
  const state = (): Record<string, any> => {
    const { session } = testStageSession({ grant: SPARE, cardCount: 2 });
    session.syncWithWorld();
    return JSON.parse(JSON.stringify(session.serialize()));
  };
  const refuses = (edit: (value: Record<string, any>) => void, code?: string): void => {
    const value = state();
    edit(value);
    let thrown: unknown;
    try { ParkSession.fromState(value as never); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(SaveError);
    if (code) expect((thrown as SaveError).code).toBe(code);
  };

  it('a run key outside mode run, and mode run without a run key', () => {
    refuses((value) => { value.mode = 'scenario'; value.grant.bonusIds = ['spare-slot']; });
    refuses((value) => { delete value.run; });
    const sandbox = JSON.parse(JSON.stringify(new ParkSession(null).serialize()));
    sandbox.run = state().run;
    expect(() => ParkSession.fromState(sandbox)).toThrow(SaveError);
  });

  it('a stage that is not the run stage scenario, and the run stage scenario outside mode run', () => {
    refuses((value) => { value.scenarioId = 'sunny-start'; value.scenario.scenarioId = 'sunny-start'; });
    const scenario = JSON.parse(JSON.stringify(new ParkSession(SCENARIOS[0], []).serialize()));
    scenario.scenarioId = RUN_STAGE_SCENARIO_ID;
    expect(() => ParkSession.fromState(scenario)).toThrow(SaveError);
  });

  it('active cards, grant, seed and recipe that disagree with the run', () => {
    refuses((value) => { value.activeCardIds = []; });
    refuses((value) => { value.activeCardIds = [...value.activeCardIds].reverse(); });
    refuses((value) => { value.grant = { unlockedBuildingIds: ['tiki-tumbler'], bonusIds: ['spare-slot'] }; });
    refuses((value) => { value.seed += 1; });
    refuses((value) => { value.map.recipe = { ...value.map.recipe, seed: value.map.recipe.seed + 1 }; });
    refuses((value) => { value.map.recipe = null; });
  });

  it('a hostile run state inside a park is refused by the run reader', () => {
    refuses((value) => { value.run.deck.push('lean-crew'); }, 'invalid-state');
    refuses((value) => { value.run.levels[0].biomeId = 'moon'; value.run.levels[0].recipe.biomeId = 'moon'; }, 'content-mismatch');
    refuses((value) => { value.run.phase = 'nonsense'; }, 'invalid-state');
    refuses((value) => { value.run.extra = true; }, 'invalid-state');
  });

  it('a malformed entrance cannot crash the stage definition', () => {
    refuses((value) => { value.map.entrance = { x: 1, y: 2, facing: 'up' }; });
    refuses((value) => { value.map = null; });
  });

  it('the run park and its run must agree about the finished park: a won run whose scenario still runs, or a fresh park with time on the clock', () => {
    const { run } = testStageSession({ cardCount: 1 });
    const cleared = ok(resolveStage(run, { outcome: 'succeeded', atSeconds: 90, evidence: null }));
    const value = state();
    value.run = JSON.parse(JSON.stringify({ ...cleared, grant: value.run.grant, loadout: value.run.loadout, history: [{ ...cleared.history[0], cardIds: value.run.loadout }], usedPile: value.run.usedPile, deck: value.run.deck }));
    // The scenario is still running, but the run says the stage was cleared.
    expect(() => ParkSession.fromState(value as never)).toThrow(SaveError);
  });
});

describe('envelope of schema 12', () => {
  it('the header mode, the run key and the plays key agree (an envelope with a run or a ledger in a Scenario park is corrupt)', () => {
    const { session } = testStageSession({ cardCount: 1 });
    session.syncWithWorld();
    const save = JSON.parse(JSON.stringify(createParkSave(session.serialize(), { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 1)));
    expect(save.schemaVersion).toBe(15);
    expect(save.mode).toBe('run');
    expect(() => migrateSave(save)).not.toThrow();
    const noRun = JSON.parse(JSON.stringify(save));
    delete noRun.state.run;
    noRun.stateHash = hashState(noRun.state);
    expect(() => migrateSave(noRun)).toThrow(SaveError);
    const noPlays = JSON.parse(JSON.stringify(save));
    delete noPlays.state.plays;
    noPlays.stateHash = hashState(noPlays.state);
    expect(() => migrateSave(noPlays)).toThrow(SaveError);
    const scenario = new ParkSession(SCENARIOS[0], []);
    const scenarioSave = JSON.parse(JSON.stringify(createParkSave(scenario.serialize(), { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 1)));
    scenarioSave.state.plays = { played: [], pending: [] };
    scenarioSave.stateHash = hashState(scenarioSave.state);
    expect(() => migrateSave(scenarioSave)).toThrow(SaveError);
  });

  it('a run save written through the real save path survives the integrity hash', () => {
    const { session } = testStageSession({ cardCount: 1 });
    session.syncWithWorld();
    const save = JSON.parse(JSON.stringify(createParkSave(session.serialize(), { clock: { speed: 1, simulationTimeMs: 0 }, tourNodeId: null }, 1)));
    save.state.run.seed += 1;
    expect(() => migrateSave(save), 'edited after it was written: the integrity hash covers the run').toThrow(SaveError);
  });
});

describe('one-shot cards in a run stage (Phase 25, design 3)', () => {
  // Seed 2, level 1: the deck holds hungry-tourists (stage) and bridging-loan (one-shot: +$2,000 now, $2,400 repaid 240 s later).
  const LOAN = 'bridging-loan' as const;
  const loanStage = (): { session: ParkSession; run: RunState } => testStageSession({ seed: 2, grant: SPARE, cardIds: ['hungry-tourists', LOAN] });
  const TICKS_PER_SECOND = 1000 / GAME_CONFIG.fixedStepMs;

  it('plays a one-shot once: the effect, the ledger, the snapshot, and nothing else moves (rules, cards, run, world version)', () => {
    const { session, run } = loanStage();
    build(session);
    step(session, 30);
    const before = { cash: session.world.cash, version: session.world.version, rules: JSON.stringify(session.rules), run: runHash(session.run!), cards: session.activeCards.map((card) => card.id) };
    const [stageCard, loanCard] = session.cardsSnapshot();
    expect(stageCard).toMatchObject({ id: 'hungry-tourists', kind: 'stage', playState: 'stage', playable: false, hint: null, pending: null, slotCost: 1, rarity: 'common' });
    expect(loanCard).toMatchObject({ id: LOAN, kind: 'one-shot', playState: 'ready', playable: true, hint: null, playedAtSeconds: null, pending: null });
    const played = session.playCard(LOAN);
    expect(played).toEqual({ ok: true, summary: expect.stringContaining('+$2,000 now') });
    expect(session.world.cash).toBe(before.cash + 2_000);
    expect(session.world.transactions[0]).toMatchObject({ amount: 2_000, category: 'grant' });
    expect(session.world.version, 'a play never bumps the world version').toBe(before.version);
    expect(JSON.stringify(session.rules)).toBe(before.rules);
    expect(runHash(session.run!)).toBe(before.run);
    expect(runHash(session.run!)).toBe(runHash(run));
    expect(session.activeCards.map((card) => card.id)).toEqual(before.cards);
    expect(session.plays!.playedIds(run.loadout)).toEqual([LOAN]);
    expect(session.plays!.unpaidTotal()).toBe(2_400);
    const after = session.cardsSnapshot()[1];
    expect(after).toMatchObject({ playState: 'played', playable: false, playedAtSeconds: session.world.tick / TICKS_PER_SECOND });
    expect(after.pending).toEqual({ amount: -2_400, dueInSeconds: 240, label: expect.any(String) });
    expect(session.playCard(LOAN)).toEqual({ ok: false, reason: 'already-played' });
  });

  it('refuses what is not a playable one-shot of this stage, with a reason', () => {
    const { session } = loanStage();
    expect(session.playCard('nope')).toEqual({ ok: false, reason: 'unknown' });
    expect(session.playCard('coach-party')).toEqual({ ok: false, reason: 'not-in-loadout' });
    expect(session.playCard('hungry-tourists')).toEqual({ ok: false, reason: 'not-one-shot' });
    expect(new ParkSession(null).playCard(LOAN)).toEqual({ ok: false, reason: 'not-a-run' });
    expect(new ParkSession(SCENARIOS[0], []).playCard(LOAN)).toEqual({ ok: false, reason: 'not-a-run' });
    const sweep = testStageSession({ seed: 7, cardIds: ['sweep-the-park'] }).session;
    expect(sweep.playCard('sweep-the-park')).toEqual({ ok: false, reason: 'not-playable', hint: 'The park is clean' });
    expect(sweep.cardsSnapshot()[0]).toMatchObject({ playState: 'ready', playable: false, hint: 'The park is clean' });
    forceStageOutcomeForDevelopment(session, 'succeeded');
    session.step(GAME_CONFIG.fixedStepMs);
    expect(session.playCard(LOAN)).toEqual({ ok: false, reason: 'not-playable', hint: 'The level is over' });
  });

  it('the deferred cost falls due at the start of its tick, in its category, exactly once', () => {
    const { session } = loanStage();
    build(session);
    step(session, 10);
    session.playCard(LOAN);
    const due = session.world.tick + 240 * TICKS_PER_SECOND;
    step(session, due - session.world.tick - 1);
    expect(session.plays!.unpaidTotal()).toBe(2_400);
    const cash = session.world.cash;
    const transactions = session.world.transactions.length;
    session.step(GAME_CONFIG.fixedStepMs);
    expect(session.world.tick).toBe(due);
    expect(session.plays!.unpaidTotal()).toBe(0);
    expect(session.world.transactions.find((entry) => entry.amount === -2_400)).toMatchObject({ category: 'other', tick: due });
    expect(session.world.transactions.length).toBeGreaterThan(transactions - 1);
    expect(session.world.cash).toBeLessThan(cash);
    expect(session.cardsSnapshot()[1]).toMatchObject({ playState: 'played', pending: null });
  });

  it('save and reload with a pending cost: the same hash, and the cost fires at the same tick in both', () => {
    const { session } = loanStage();
    build(session);
    step(session, 20);
    session.playCard(LOAN);
    step(session, 100);
    const restored = roundTrip(session);
    expect(hashState(restored.serialize())).toBe(hashState(session.serialize()));
    expect(restored.plays!.unpaidTotal()).toBe(2_400);
    step(session, 2_400);
    step(restored, 2_400);
    expect(session.plays!.unpaidTotal()).toBe(0);
    expect(hashState(restored.serialize())).toBe(hashState(session.serialize()));
  });

  it('undo past a play (a rewind to an image before it) brings the card back ready and keeps the run byte for byte', () => {
    const { session } = loanStage();
    build(session);
    step(session, 20);
    session.syncWithWorld();
    const image = JSON.parse(JSON.stringify(session.serialize()));
    session.playCard(LOAN);
    step(session, 5);
    const rewound = ParkSession.fromState(image);
    expect(runHash(rewound.run!)).toBe(runHash(session.run!));
    expect(rewound.cardsSnapshot()[1]).toMatchObject({ playState: 'ready', playable: true });
    expect(rewound.plays!.unpaidTotal()).toBe(0);
    expect(rewound.playCard(LOAN)).toMatchObject({ ok: true });
  });

  it('settles a stage with its plays and debt: the backdrop saves and loads, the debt comes off the next level, and advanceRun pins the ledger', () => {
    const { session, run } = loanStage();
    build(session);
    step(session, 20);
    session.playCard(LOAN);
    step(session, 30);
    forceStageOutcomeForDevelopment(session, 'succeeded');
    const event = session.step(GAME_CONFIG.fixedStepMs).scenario[0];
    const result = { outcome: 'succeeded' as const, atSeconds: event.atSeconds, evidence: event.evidence };
    // The app must pass the ledger's plays and debt: anything else is refused.
    expect(() => session.advanceRun(ok(resolveStage(run, result)))).toThrow(RangeError);
    expect(() => session.advanceRun(ok(resolveStage(run, { ...result, playedCardIds: [LOAN], unpaidDebt: 100 })))).toThrow(RangeError);
    const settled = ok(resolveStage(run, { ...result, playedCardIds: session.plays!.playedIds(run.loadout), unpaidDebt: session.plays!.unpaidTotal() }));
    expect(settled.history[0]).toMatchObject({ playedCardIds: [LOAN], unpaidDebt: 2_400 });
    session.advanceRun(settled);
    // The backdrop: its ledger never steps, its save loads (the ledger agrees with the history), a disagreeing one is refused.
    const restored = roundTrip(session);
    expect(hashState(restored.serialize())).toBe(hashState(session.serialize()));
    session.syncWithWorld();
    const tampered = JSON.parse(JSON.stringify(session.serialize()));
    tampered.plays.pending[0].amount = -100;
    expect(() => ParkSession.fromState(tampered)).toThrow(SaveError);
    const unplayed = JSON.parse(JSON.stringify(session.serialize()));
    unplayed.plays = { played: [], pending: [] };
    expect(() => ParkSession.fromState(unplayed)).toThrow(SaveError);
    // The next level starts $2,400 poorer, and that park is still rewardable (its definition is a function of the run).
    const next = ok(acceptOffer(settled));
    const started = ok(startStage(next, []));
    const { definition, layout } = buildStage(started, 1);
    const level2 = new ParkSession(definition, [], { mode: 'run', grant: started.grant, layout, run: started });
    expect(level2.world.cash).toBe(Math.max(0, started.levels[1].startingCash - 2_400));
    expect(rewardEligible(level2)).toBe(true);
    expect(rewardEligible(roundTrip(level2))).toBe(true);
    expect(level2.plays!.unpaidTotal()).toBe(0);
  });

  it('abandoning a stage with a play records it, and the abandoned backdrop loads', () => {
    const { session, run } = loanStage();
    session.playCard(LOAN);
    session.advanceRun(ok(abandonRun(run, 5, session.plays!.playedIds(run.loadout), session.plays!.unpaidTotal())));
    expect(session.run!.history[0]).toMatchObject({ outcome: 'abandoned', playedCardIds: [LOAN], unpaidDebt: 2_400 });
    expect(session.run!.usedPile.map((used) => used.cardId)).toEqual(['hungry-tourists', LOAN]);
    const restored = roundTrip(session);
    expect(hashState(restored.serialize())).toBe(hashState(session.serialize()));
  });
});

describe('hostile one-shot ledgers (design 9.3: refused, never normalised)', () => {
  const LOAN = 'bridging-loan' as const;
  const playedState = (): Record<string, any> => {
    const { session } = testStageSession({ seed: 2, grant: SPARE, cardIds: ['hungry-tourists', LOAN] });
    step(session, 20);
    session.playCard(LOAN);
    step(session, 10);
    session.syncWithWorld();
    return JSON.parse(JSON.stringify(session.serialize()));
  };
  const refused = (edit: (state: Record<string, any>) => void, code = 'invalid-state'): void => {
    const state = playedState();
    expect(() => ParkSession.fromState(structuredClone(state) as never), 'the base loads').not.toThrow();
    edit(state);
    let thrown: unknown;
    try { ParkSession.fromState(state as never); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(SaveError);
    expect((thrown as SaveError).code).toBe(code);
  };

  it.each([
    ['plays absent in a run save', (s: Record<string, any>) => { delete s.plays; }],
    ['plays that is not an object', (s: Record<string, any>) => { s.plays = []; }],
    ['plays with an unknown key', (s: Record<string, any>) => { s.plays.extra = 1; }],
    ['a played stage card', (s: Record<string, any>) => { s.plays.played.push({ cardId: 'hungry-tourists', tick: 1 }); }],
    ['a played card outside the loadout', (s: Record<string, any>) => { s.plays.played.push({ cardId: 'coach-party', tick: 1 }); }],
    ['a card played twice', (s: Record<string, any>) => { s.plays.played.push({ ...s.plays.played[0] }); }],
    ['a play after the world tick', (s: Record<string, any>) => { s.plays.played[0].tick = s.world.tick + 1; }],
    ['a fractional play tick', (s: Record<string, any>) => { s.plays.played[0].tick = 1.5; }],
    ['six plays', (s: Record<string, any>) => { s.plays.played = Array.from({ length: 6 }, () => s.plays.played[0]); }],
    ['a pending cost due now', (s: Record<string, any>) => { s.plays.pending[0].dueTick = s.world.tick; }],
    ['a pending cost due in the past', (s: Record<string, any>) => { s.plays.pending[0].dueTick = 1; }],
    ['a pending cost too far ahead', (s: Record<string, any>) => { s.plays.pending[0].dueTick = s.world.tick + 1_000_001; }],
    ['a positive pending amount', (s: Record<string, any>) => { s.plays.pending[0].amount = 2_400; }],
    ['a zero pending amount', (s: Record<string, any>) => { s.plays.pending[0].amount = 0; }],
    ['a NaN pending amount', (s: Record<string, any>) => { s.plays.pending[0].amount = Number.NaN; }],
    ['a huge pending amount', (s: Record<string, any>) => { s.plays.pending[0].amount = -1e13; }],
    ['a label of 81 characters', (s: Record<string, any>) => { s.plays.pending[0].label = 'x'.repeat(81); }],
    ['an empty label', (s: Record<string, any>) => { s.plays.pending[0].label = ''; }],
    ['an unknown category', (s: Record<string, any>) => { s.plays.pending[0].category = 'grant'; }],
    ['pending out of order', (s: Record<string, any>) => { s.plays.pending.unshift({ ...s.plays.pending[0], dueTick: s.plays.pending[0].dueTick + 5 }); }],
    ['a pending cost of a card not played', (s: Record<string, any>) => { s.plays.pending[0].cardId = 'hungry-tourists'; }],
    ['a pending entry with an extra key', (s: Record<string, any>) => { s.plays.pending[0].note = 'x'; }],
    ['nine pending costs', (s: Record<string, any>) => { s.plays.pending = Array.from({ length: 9 }, () => s.plays.pending[0]); }],
  ] as const)('%s', (_name, edit) => {
    refused(edit);
  });

  it('an unknown played card is a content-mismatch', () => {
    refused((s) => { s.plays.played[0].cardId = 'loaded-dice'; }, 'content-mismatch');
  });

  it('a Scenario save with a ledger is refused', () => {
    const scenario = new ParkSession(SCENARIOS[0], []);
    const state = JSON.parse(JSON.stringify(scenario.serialize()));
    state.plays = { played: [], pending: [] };
    expect(() => ParkSession.fromState(state)).toThrow(SaveError);
    expect(() => scenario.restoreState(state)).toThrow(SaveError);
  });

  it('the slot cost of the active cards is checked on restore (a rare takes two slots)', () => {
    const { session } = testStageSession({ seed: 2, cardIds: [LOAN] });
    session.syncWithWorld();
    const state = JSON.parse(JSON.stringify(session.serialize()));
    state.activeCardIds = ['big-loan'];
    state.run.loadout = ['big-loan'];
    expect(() => ParkSession.fromState(state)).toThrow(SaveError);
  });
});
