import { describe, expect, it } from 'vitest';
import { ParkSession } from '../session/ParkSession';
import { MAPS } from '../maps/content';
import { CARD_BY_ID } from '../cards/content';
import { SCENARIO_BY_ID } from '../scenarios/content';
import { buildFuzzPark, fuzzAct, mulberry32, planFor, planOnMap, situationsIn, type FuzzPlan } from './fuzzSupport';
import { firstDifference, liveGraphDifference, observe, stepOnce, viaJson } from './determinismHarness';
import { hashState } from './hash';

/**
 * Randomised save/restore: for each seed, a random park under random player edits runs three ways.
 *   pure  - never serialized;
 *   ref   - serialized at every save point (proves saving does not change the run);
 *   twin  - serialize, JSON round trip and restore into a FRESH session at every save point, so
 *           restores are chained (a restored session is itself saved and restored again).
 * Save points are aimed at tagged situations (a ride mid-cycle, a broken ride, a staff member
 * walking, litter, a pending breakdown...) plus a few random ticks. At each one the live object
 * graphs of pure and twin are compared field by field (what the state hash cannot see), and every
 * so often the state hashes and the public observables are compared too.
 *
 * Failures print the seed; set START to it and SEEDS to 1 below to replay just that park.
 */

// Edit these to replay a seed or to run a longer soak locally (no environment access in the browser build's types).
const TICKS = 900;
const SEEDS = 12;
const START = 1;

const savePointsFor = (seed: number, plan: FuzzPlan = planFor(seed)): number[] => {
  const act = fuzzAct(plan);
  const random = mulberry32(seed * 977);
  const scout = buildFuzzPark(plan);
  const taggedTicks = new Map<string, number>();
  for (let tick = 0; tick < TICKS; tick += 1) {
    act(scout, tick);
    for (const situation of situationsIn(scout)) {
      if (!taggedTicks.has(situation) && random() < 0.5) taggedTicks.set(situation, tick);
    }
    stepOnce(scout);
  }
  const points = new Set<number>(taggedTicks.values());
  for (let extra = 0; extra < 4; extra += 1) points.add(1 + Math.floor(random() * (TICKS - 2)));
  return [...points].sort((left, right) => left - right);
};

/** One seeded run of a plan: pure / ref / twin, chained restores at every save point (see the file comment). */
const runPlan = (seed: number, plan: FuzzPlan): void => {
  const act = fuzzAct(plan);
  const points = new Set(savePointsFor(seed, plan));
  const pure = buildFuzzPark(plan);
  const ref = buildFuzzPark(plan);
  let twin = buildFuzzPark(plan);
  for (let tick = 0; tick < TICKS; tick += 1) {
    for (const session of [pure, twin, ref]) act(session, tick);
    if (points.has(tick)) {
      const referenceState = ref.serialize();
      const twinState = twin.serialize();
      expect(hashState(twinState), `seed ${seed} tick ${tick}: twin state differs from the reference before saving`).toBe(hashState(referenceState));
      twin = ParkSession.fromState(viaJson(twinState));
      expect(hashState(twin.serialize()), `seed ${seed} tick ${tick}: re-serializing a restored session changed it`).toBe(hashState(referenceState));
      expect(liveGraphDifference(pure, twin), `seed ${seed} tick ${tick}: live graph right after restore`).toBeNull();
    }
    for (const session of [pure, twin, ref]) session.step(100);
    if (tick % 350 === 0 || tick === TICKS - 1 || points.has(tick)) {
      const pureHash = hashState(pure.serialize());
      expect(hashState(ref.serialize()), `seed ${seed} tick ${tick}: serializing changed the run`).toBe(pureHash);
      expect(hashState(twin.serialize()), `seed ${seed} tick ${tick}: twin diverged at ${firstDifference(pure.serialize(), twin.serialize())}`).toBe(pureHash);
      expect(liveGraphDifference(pure, twin), `seed ${seed} tick ${tick}: live graph`).toBeNull();
    }
  }
  const pureView = JSON.parse(JSON.stringify(observe(pure))) as unknown;
  const twinView = JSON.parse(JSON.stringify(observe(twin))) as unknown;
  expect(firstDifference(pureView, twinView), `seed ${seed}: public observables after the run`).toBeNull();
};

/**
 * Phase 25: a Scenario park takes stage cards only (one-shots are run-only), and no more than its slots by slot cost (a
 * rare takes two). The random draw itself is unchanged: the first six cards are drawn exactly as before the pool grew.
 */
const scenarioLegal = (plan: FuzzPlan): FuzzPlan => {
  const definition = plan.kind && plan.kind !== 'dev' ? SCENARIO_BY_ID.get(plan.kind) : undefined;
  if (!definition) return plan;
  const cardIds: FuzzPlan['cardIds'] = [];
  let cost = 0;
  for (const id of plan.cardIds) {
    const card = CARD_BY_ID.get(id);
    if (!card || card.kind !== 'stage' || cost + card.slotCost > definition.cardSlots) continue;
    cardIds.push(id);
    cost += card.slotCost;
  }
  return { ...plan, cardIds };
};

describe('fuzz: random parks, random edits, chained restores', () => {
  for (let seed = START; seed < START + SEEDS; seed += 1) {
    it(`seed ${seed}`, () => {
      runPlan(seed, scenarioLegal(planFor(seed)));
    }, 120_000);
  }
});

/**
 * Phase 24: the same fuzz on every shipped map (Meadow, and six with props, water, other gates and a climate).
 * Random bulldoze strokes clear props for money, random builds are refused by obstruction, and every save
 * point restores the remaining props, the cleared land and the biome ruleset into a fresh session.
 */
describe('fuzz: every shipped map', () => {
  for (const map of MAPS) {
    it(`${map.id}`, () => {
      runPlan(101 + MAPS.indexOf(map), planOnMap(101 + MAPS.indexOf(map), map.id));
    }, 120_000);
  }
});
