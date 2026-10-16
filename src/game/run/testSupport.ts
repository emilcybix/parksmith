import type { PulseCardId } from '../cards/types';
import type { ParkGrant } from '../session/ParkSession';
import { EMPTY_GRANT, ParkSession } from '../session/ParkSession';
import { hashState } from '../save/hash';
import { acceptOffer, createRun, resolveStage, runHash, sortDeck, startStage } from './deck';
import { acceptedRecipeOf, familiesAt, planLevelForTest, planRun } from './plan';
import { buildStage } from './stage';
import { RUN_DIFFICULTIES, type RunDifficulty, type RunObjectiveFamily, type RunState } from './types';
import type { BiomeId } from '../biomes/types';
import { GAME_CONFIG } from '../config';

/**
 * Test support (not imported by the app): a run at the loadout phase of level `levelIndex` (offers accepted, nothing
 * played earlier), and the stage park of it. The cards are the first `cardCount` of the deck unless named.
 */
export interface TestRunOptions {
  seed?: number;
  difficulty?: RunDifficulty;
  grant?: ParkGrant;
  cardIds?: readonly PulseCardId[];
  cardCount?: number;
}

export const testRunAtLoadout = (options: TestRunOptions = {}): RunState => {
  const run = createRun({ seed: options.seed ?? 1234, difficulty: options.difficulty ?? 'standard', grant: options.grant ?? EMPTY_GRANT });
  const step = acceptOffer(run);
  if (!step.ok) throw new Error(`test run: ${step.reason}`);
  return step.run;
};

/** The stage session of level 1 of a test run, with `cardIds` (default: `cardCount` cards from the deck, 0 by default). */
export const testStageSession = (options: TestRunOptions = {}): { session: ParkSession; run: RunState } => {
  const loadoutRun = testRunAtLoadout(options);
  const cardIds = options.cardIds ?? loadoutRun.deck.filter((id, index, all) => all.indexOf(id) === index).slice(0, options.cardCount ?? 0);
  const started = startStage(loadoutRun, cardIds);
  if (!started.ok) throw new Error(`test run: ${started.reason}`);
  const { definition, layout } = buildStage(started.run, 0);
  const session = new ParkSession(definition, cardIds, { mode: 'run', grant: started.run.grant, layout, run: started.run });
  return { session, run: started.run };
};

/**
 * A run at the loadout phase of `levelIndex`: every earlier level cleared with an empty loadout (so the deck holds the
 * starter cards and every accepted offer). The grant is `EMPTY_GRANT` unless given.
 */
export const testRunAtLevel = (levelIndex: number, options: TestRunOptions = {}): RunState => {
  let run = testRunAtLoadout(options);
  while (run.levelIndex < levelIndex) {
    const started = startStage(run, []);
    if (!started.ok) throw new Error(`test run: ${started.reason}`);
    const resolved = resolveStage(started.run, { outcome: 'succeeded', atSeconds: 100, evidence: null });
    if (!resolved.ok) throw new Error(`test run: ${resolved.reason}`);
    const accepted = acceptOffer(resolved.run);
    if (!accepted.ok) throw new Error(`test run: ${accepted.reason}`);
    run = accepted.run;
  }
  return run;
};

/** The level of `run` at `levelIndex`, replaced (the biome x family stress test) with a re-accepted map. */
export const withLevel = (run: RunState, level: RunState['levels'][number]): RunState => ({
  ...run,
  levels: run.levels.map((existing, index) => (index === level.index ? level : existing)),
});

/** A hash of `planRun` over seeds `0..count-1` at every difficulty (the golden digest of the plan version). */
export const planDigestOf = (count: number): string => {
  const hashes: string[] = [];
  for (let seed = 0; seed < count; seed += 1) for (const difficulty of RUN_DIFFICULTIES) hashes.push(hashState(planRun({ seed, difficulty })));
  return hashState(hashes);
};

/** A hash of `createRun` (maps included) over `count` spread seeds, difficulty by index (the golden digest of the whole run). */
export const createDigestOf = (count: number): string => {
  const hashes: string[] = [];
  for (let index = 0; index < count; index += 1) {
    hashes.push(runHash(createRun({ seed: (index * 85_899_347) >>> 0, difficulty: RUN_DIFFICULTIES[index % 3], grant: EMPTY_GRANT })));
  }
  return hashState(hashes);
};

/** The last level whose table row draws `family` (where that family is hardest): the binding cell of the balance proofs. */
export const hardestLevelOf = (family: RunObjectiveFamily): number => {
  for (let level = GAME_CONFIG.run.levelCount - 1; level >= 0; level -= 1) if (familiesAt(level).includes(family)) return level;
  throw new RangeError(`no level draws ${family}`);
};

/** The grant with the Spare card slot (a 2-slot rare fits a 1-slot level with it). */
export const SPARE_SLOT_GRANT: ParkGrant = { unlockedBuildingIds: [], bonusIds: ['spare-slot'] };

/**
 * A run at the loadout phase of `levelIndex` whose level is forced to `biomeId` and `family` (conditions, cash, deadline
 * and density as `planRun` gives them for that level, with an accepted map): the binding cells of the balance proofs.
 */
export const testRunWithForcedLevel = (
  levelIndex: number,
  biomeId: BiomeId,
  family: RunObjectiveFamily,
  options: TestRunOptions & { seed: number; difficulty: RunDifficulty },
): RunState => {
  const base = testRunAtLevel(levelIndex, options);
  const planned = planLevelForTest(options.seed, levelIndex, biomeId, family, options.difficulty);
  const { density: _density, ...rest } = planned;
  void _density;
  return withLevel(base, { ...rest, recipe: acceptedRecipeOf(options.seed, planned).recipe, offer: base.levels[levelIndex].offer });
};

/** `run` with only `cardIds` in its deck (a card alone, whatever the seed dealt). */
export const withDeck = (run: RunState, cardIds: readonly PulseCardId[]): RunState => ({ ...run, deck: sortDeck(cardIds) });
