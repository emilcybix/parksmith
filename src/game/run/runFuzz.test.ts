import { describe, expect, it } from 'vitest';
import { BIOME_IDS } from '../biomes/types';
import { GAME_CONFIG } from '../config';
import { entranceFrame } from '../maps/frame';
import { firstDifference, liveGraphDifference, viaJson } from '../save/determinismHarness';
import { hashState } from '../save/hash';
import { ParkSession } from '../session/ParkSession';
import { acceptedRecipeOf, planLevelForTest } from './plan';
import { slotsOf, sortDeck, startStage } from './deck';
import { slotCostTotal } from '../cards/content';
import type { PulseCardId } from '../cards/types';
import { buildStage } from './stage';
import { runHash } from './deck';
import { testRunAtLevel, withLevel } from './testSupport';

/**
 * Randomised save/restore for run saves (extends save/fuzz.test.ts): a stage of every biome, played with a scripted build,
 * runs two ways: pure (never serialized) and twin (serialize, JSON round trip and restore into a FRESH session every 75
 * ticks, so restores are chained). Their state hashes and live graphs must agree at every save point, the run must be the
 * same byte for byte, and a rewind to any earlier image keeps the run. Phase 25: the loadout holds the one-shot Coach Party,
 * played at tick 0 (20 guests now, a $900 bill due at tick 600, inside the window), so the ledger and a pending cost cross
 * every chained restore.
 */
const ONE_SHOT: PulseCardId = 'coach-party';
const TICKS = 600;
const EVERY = 75;

const stageOf = (biomeIndex: number): ParkSession => {
  const biomeId = BIOME_IDS[biomeIndex];
  const seed = 500 + biomeIndex;
  const base = testRunAtLevel(3, { seed, difficulty: 'standard', grant: { unlockedBuildingIds: [], bonusIds: ['nest-egg', 'spare-slot'] } });
  const planned = planLevelForTest(seed, 3, biomeId, 'visitors', 'standard');
  const { density: _density, ...rest } = planned;
  void _density;
  // The one-shot joins level 4's offer (and so the deck), keeping the deck laws.
  const has = base.deck.includes(ONE_SHOT);
  const offer = has ? base.levels[3].offer : sortDeck([...base.levels[3].offer, ONE_SHOT]);
  const run = { ...withLevel(base, { ...rest, recipe: acceptedRecipeOf(seed, planned).recipe, offer }), deck: has ? base.deck : sortDeck([...base.deck, ONE_SHOT]) };
  const cards: PulseCardId[] = [ONE_SHOT];
  for (const id of run.deck.filter((card, index, all) => all.indexOf(card) === index && card !== ONE_SHOT)) {
    if (slotCostTotal([...cards, id]) <= slotsOf(run, 3)) cards.push(id);
  }
  const started = startStage(run, cards);
  if (!started.ok) throw new Error(started.reason);
  const { definition, layout } = buildStage(started.run, 3);
  return new ParkSession(definition, cards, { mode: 'run', grant: started.run.grant, layout, run: started.run });
};

const act = (session: ParkSession, tick: number): void => {
  const w = session.world;
  const frame = entranceFrame({ ...w.entrance, facing: w.entranceFacing });
  if (tick === 0) {
    w.buildPaths(Array.from({ length: 10 }, (_, depth) => frame.toWorld(0, depth + 1)));
    session.syncWithWorld();
  }
  const placements: Record<number, [string, number, number, number, number]> = {
    5: ['picnic-pocket', 1, 1, 1, 1], 10: ['fizz-foundry', -2, 1, 1, 1], 20: ['moonpetal-carousel', 1, 3, 3, 3], 150: ['petal-roundabout', 1, 7, 3, 3],
  };
  const placement = placements[tick];
  if (placement) {
    const [id, l, d, width, height] = placement;
    w.buildObject(id, frame.rectToWorld(l, d, width, height), frame.rotation);
    session.syncWithWorld();
  }
  if (tick === 30) { session.operations.hireStaff('cleaner'); session.operations.hireStaff('mechanic'); }
  if (tick === 0) expect(session.playCard(ONE_SHOT)).toMatchObject({ ok: true });
};

describe.each(BIOME_IDS.map((id, index) => [id, index] as const))('run save fuzz: a stage in %s', (_biome, index) => {
  it(`chained restores every ${EVERY} ticks keep the state, the live graph and the run identical to a never-saved twin`, () => {
    const pure = stageOf(index);
    let twin = stageOf(index);
    const expectedRun = runHash(pure.run!);
    const images: ReturnType<ParkSession['serialize']>[] = [];
    for (let tick = 0; tick < TICKS; tick += 1) {
      act(pure, tick);
      act(twin, tick);
      if (tick % EVERY === EVERY - 1) {
        const pureState = pure.serialize();
        const twinState = twin.serialize();
        expect(hashState(twinState), `tick ${tick}`).toBe(hashState(pureState));
        images.push(viaJson(twinState));
        twin = ParkSession.fromState(viaJson(twinState));
        expect(hashState(twin.serialize()), `tick ${tick}: re-serializing changed it`).toBe(hashState(pureState));
        expect(liveGraphDifference(pure, twin), `tick ${tick}: live graph after restore`).toBeNull();
        expect(runHash(twin.run!)).toBe(expectedRun);
      }
      pure.step(GAME_CONFIG.fixedStepMs);
      twin.step(GAME_CONFIG.fixedStepMs);
    }
    expect(firstDifference(pure.serialize(), twin.serialize())).toBeNull();
    expect(pure.plays!.unpaidTotal(), 'the bill fell due inside the window').toBe(0);
    expect(pure.world.transactions.some((entry) => entry.amount === -900 && entry.tick === 600)).toBe(true);
    expect(images[3].plays!.pending, 'an image holds the pending bill').toHaveLength(1);
    // A rewind to any image keeps the run and replays to the same end.
    const rewound = ParkSession.fromState(viaJson(images[2]));
    expect(runHash(rewound.run!)).toBe(expectedRun);
    expect(images.every((image) => runHash(image.run!) === expectedRun)).toBe(true);
  }, 120_000);
});
