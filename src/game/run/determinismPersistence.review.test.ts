import { afterEach, describe, expect, it, vi } from 'vitest';
import { GAME_CONFIG } from '../config';
import { ProfileManager, type ProfileStorage } from '../profile/ProfileManager';
import { rewardEligible } from '../profile/eligibility';
import { SaveError } from '../save/version';
import { EMPTY_GRANT, ParkSession } from '../session/ParkSession';
import { hash32 } from '../weather/random';
import { abandonRun, acceptOffer, createRun, resolveStage, runHash, sortDeck, startStage } from './deck';
import { planRun } from './plan';
import { runRewardEligible } from './rewards';
import { buildStage } from './stage';
import { testRunAtLevel } from './testSupport';
import { readRunState } from './validate';
import type { RunState } from './types';

/**
 * Phase 23 adversarial review (determinism and persistence). Tests marked `it.fails` document a finding: they assert
 * the behaviour the spec asks for and currently fail; flip them to `it` once production code is fixed.
 */
const ok = (result: { ok: boolean; run?: RunState }): RunState => { if (!result.ok || !result.run) throw new Error('refused'); return result.run; };
const fakeStorage = (): ProfileStorage => {
  const entries = new Map<string, string>();
  return { getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value); }, removeItem: (key) => { entries.delete(key); } };
};

afterEach(() => { vi.restoreAllMocks(); });

describe('run determinism is independent of every other source of randomness', () => {
  it('createRun never calls Math.random, Date.now or performance.now', () => {
    const baseline = runHash(createRun({ seed: 99, difficulty: 'tough', grant: EMPTY_GRANT }));
    vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Math.random used'); });
    vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Date.now used'); });
    vi.spyOn(performance, 'now').mockImplementation(() => { throw new Error('performance.now used'); });
    expect(runHash(createRun({ seed: 99, difficulty: 'tough', grant: EMPTY_GRANT }))).toBe(baseline);
  });

  it('the plan of a seed does not depend on what was planned, generated or hashed before it (order independence)', () => {
    const seeds = [0, 1, 7, 4_294_967_295, 123_456, 2024];
    const forward = seeds.map((seed) => JSON.stringify(planRun({ seed, difficulty: 'standard' })));
    // Other RNG traffic in between: weather hashes and a stage park that steps (guest RNG).
    for (let i = 0; i < 1000; i += 1) hash32(i, i * 3, i * 7);
    const run = ok(acceptOffer(createRun({ seed: 5, difficulty: 'relaxed', grant: EMPTY_GRANT })));
    const started = ok(startStage(run, []));
    const { definition, layout } = buildStage(started, 0);
    const session = new ParkSession(definition, [], { mode: 'run', grant: started.grant, layout, run: started });
    for (let i = 0; i < 200; i += 1) session.step(GAME_CONFIG.fixedStepMs);
    const backward = [...seeds].reverse().map((seed) => JSON.stringify(planRun({ seed, difficulty: 'standard' }))).reverse();
    expect(backward).toEqual(forward);
  });

  it('a seed is the same run whatever grant the profile holds (the grant is not an input of the plan)', () => {
    const plain = createRun({ seed: 31337, difficulty: 'standard', grant: EMPTY_GRANT });
    const gifted = createRun({ seed: 31337, difficulty: 'standard', grant: { unlockedBuildingIds: [], bonusIds: ['spare-slot'] } });
    const { grant: _a, ...left } = plain;
    const { grant: _b, ...right } = gifted;
    void _a; void _b;
    expect(right).toEqual(left);
  });
});

describe('hostile run states the reader still accepts', () => {
  // Finding: under the `pick` offer rule the conservation law only bounds each card by "ever offered over the WHOLE run",
  // so a deck may hold a card that is offered only at a level not reached yet.
  it.fails('a pick-rule run holding a card from a future level offer is refused', () => {
    const base = createRun({ seed: 4242, difficulty: 'standard', grant: EMPTY_GRANT });
    const run: RunState = { ...structuredClone(base), offerRule: { kind: 'pick', pick: 1 } };
    const future = run.levels.slice(2).flatMap((level) => level.offer).find((id) => !run.levels[0].offer.includes(id) && !run.starterDeck.includes(id));
    expect(future).toBeDefined();
    const accepted = ok(acceptOffer(run, [run.levels[0].offer[0]]));
    // Swap the picked card for one that is only offered at level 3 or later.
    const forged: RunState = structuredClone(accepted);
    forged.deck.splice(forged.deck.indexOf(run.levels[0].offer[0]), 1);
    forged.deck.push(future!);
    forged.deck = sortDeck(forged.deck);
    // The forged state passes every other law (shape, counts, used pile): only the future-offer bound is missing.
    expect(() => readRunState(JSON.parse(JSON.stringify(forged)))).toThrow(SaveError);
  });

  // Finding: for a FAILED stage the reader allows offersSeen to stop before the failed level, i.e. a level that was
  // played and failed without its offer ever being accepted. The app cannot produce that state.
  it.fails('a run lost by a failed stage whose offer was never accepted is refused', () => {
    const atLoadout = testRunAtLevel(1, { seed: 777 });
    const started = ok(startStage(atLoadout, []));
    const failed = ok(resolveStage(started, { outcome: 'failed', atSeconds: 50, evidence: null }));
    const forged: RunState = structuredClone(failed);
    forged.offersSeen = [0];
    for (const id of failed.levels[1].offer) forged.deck.splice(forged.deck.indexOf(id), 1);
    expect(() => readRunState(JSON.parse(JSON.stringify(forged)))).toThrow(SaveError);
  });
});

describe('profile rewards: once per run, and every run counts', () => {
  const keyOf = (run: RunState): string => `${run.seed}-${run.difficulty}-${runHash(run)}`;

  // Finding: the app's run key is (seed, difficulty, final run hash). Two separate attempts that end the same way
  // (here: "Try this seed again" after giving up at the first offer, twice) have the same key, so the second loss is
  // dropped as "already recorded".
  it.fails('two separate attempts of the same seed are two results', () => {
    const first = ok(abandonRun(createRun({ seed: 11, difficulty: 'standard', grant: EMPTY_GRANT })));
    const second = ok(abandonRun(createRun({ seed: 11, difficulty: 'standard', grant: EMPTY_GRANT })));
    const profile = new ProfileManager(fakeStorage());
    const input = (run: RunState) => ({ runKey: keyOf(run), difficulty: run.difficulty, outcome: 'lost' as const, levelsCleared: 0, deckCardIds: [] });
    profile.recordRunResult(input(first), true);
    const again = profile.recordRunResult(input(second), true);
    expect(again.alreadyRecorded).toBe(false);
    expect(profile.snapshot().runs.losses.standard).toBe(2);
  });

  // Finding: idempotency is a window of the last 32 keys. adoptRunPark records the end of a finished run on EVERY load,
  // so a manual save of a won run, loaded again after 32 other run endings, counts its victory a second time.
  it.fails('a finished run loaded again after many other runs is not counted twice', () => {
    const profile = new ProfileManager(fakeStorage());
    const won = { runKey: '1-standard-aaaaaaaaaaaaaaaa', difficulty: 'standard' as const, outcome: 'won' as const, levelsCleared: 5, deckCardIds: [] };
    profile.recordRunResult(won, true);
    for (let i = 0; i < 32; i += 1) {
      profile.recordRunResult({ runKey: `${i + 2}-relaxed-bbbb`, difficulty: 'relaxed', outcome: 'lost', levelsCleared: 0, deckCardIds: [] }, true);
    }
    const reload = profile.recordRunResult(won, true);
    expect(reload.alreadyRecorded).toBe(true);
    expect(profile.snapshot().runs.victories.standard).toBe(1);
  });
});

describe('a stage result written into a save is settled on load (adoptRunPark) but never rewarded', () => {
  // Fixed finding: adoptRunPark resolves a stage whose saved scenario status is not `running` and records the run end.
  // The reward checks used to look at the PLAN and the RULES only, so an edited `scenario.status` earned the victory.
  // ParkSession.fromState now marks a session whose scenario had already ended (resultFromSave) and rewardEligible
  // refuses it, so only a result reached live pays out (as in Scenario mode).
  it('a last-level stage save whose scenario status was edited to succeeded is not a rewarded victory', () => {
    const atLoadout = testRunAtLevel(4, { seed: 2024 });
    const started = ok(startStage(atLoadout, []));
    const { definition, layout } = buildStage(started, 4);
    const session = new ParkSession(definition, [], { mode: 'run', grant: started.grant, layout, run: started });
    for (let i = 0; i < 50; i += 1) session.step(GAME_CONFIG.fixedStepMs);
    session.syncWithWorld();
    const state = JSON.parse(JSON.stringify(session.serialize()));
    state.scenario.status = 'succeeded';
    state.scenario.completedAtSeconds = state.scenario.elapsedSeconds;
    state.scenario.resultEvidence = 'edited';
    let loaded: ParkSession | null;
    try { loaded = ParkSession.fromState(state); } catch { loaded = null; }
    if (loaded === null) return; // refused: the finding is fixed
    const snapshot = loaded.scenarioSnapshot()!;
    const resolved = ok(resolveStage(loaded.run!, { outcome: 'succeeded', atSeconds: snapshot.completedAtSeconds ?? 0, evidence: snapshot.resultEvidence }));
    expect(resolved.phase).toBe('won');
    // What GameApp.recordRunEnd asks before it pays out:
    expect(runRewardEligible(resolved) && rewardEligible(loaded)).toBe(false);
    expect(loaded.resultFromSave).toBe(true);
  });

  it('the same stage saved while still running loads eligible, and a live result there still pays out', () => {
    const atLoadout = testRunAtLevel(4, { seed: 2024 });
    const started = ok(startStage(atLoadout, []));
    const { definition, layout } = buildStage(started, 4);
    const session = new ParkSession(definition, [], { mode: 'run', grant: started.grant, layout, run: started });
    for (let i = 0; i < 50; i += 1) session.step(GAME_CONFIG.fixedStepMs);
    session.syncWithWorld();
    const loaded = ParkSession.fromState(JSON.parse(JSON.stringify(session.serialize())));
    expect(loaded.resultFromSave).toBe(false);
    expect(rewardEligible(loaded)).toBe(true);
    expect(rewardEligible(session)).toBe(true);
  });
});
