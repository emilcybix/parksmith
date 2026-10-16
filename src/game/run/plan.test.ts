import { describe, expect, it } from 'vitest';
import { BIOME_IDS } from '../biomes/types';
import { CARD_BY_ID, PULSE_CARD_IDS, PULSE_CARDS } from '../cards/content';
import type { PulseCardId } from '../cards/types';
import { GAME_CONFIG } from '../config';
import { generateMap } from '../maps/generator';
import { hashState } from '../save/hash';
import { EMPTY_GRANT } from '../session/ParkSession';
import { OPPOSING_CARD_PAIRS, RUN_CONDITION_BY_ID, allowedConditionsFor, deadCardIdsIn } from './content';
import { createRun } from './deck';
import { biomesOf, deadlineDaysAt, familiesAt, mapIsAcceptable, mapSeedFor, objectiveOf, offerWeightOf, planLevelForTest, planRun, startingCashAt, starterDeckOf } from './plan';
import { cardKey32, keyedWeightedDraw, runHash32, runRandom } from './rng';
import { createDigestOf, planDigestOf } from './testSupport';
import { RUN_DIFFICULTIES, RUN_PLAN_VERSION, type RunObjectiveFamily } from './types';

/**
 * Phase 23, step 1: the plan is a pure function of (seed, difficulty). Determinism (same process, a second process),
 * the plan rules (biomes, families, conditions, starter deck, offers) and the difficulty tables.
 */
const CONFIG = GAME_CONFIG.run;
const LEVELS = CONFIG.levelCount;

describe('the plan version and its golden digests', () => {
  it('RUN_PLAN_VERSION and the digests of planRun (1,000 seeds x 3 difficulties) and createRun (50 runs, maps included) are pinned', () => {
    // Any change that moves these bumps RUN_PLAN_VERSION in the same commit (like GENERATOR_VERSION).
    // Plan version 4 (Phase 25, wave 3: the difficulty retune of design 7.1, deadlines and cash per difficulty).
    // Plan version 3 (Phase 25, wave 1: the 48-card pool, rarity, the keyed weighted draw, pairs kept out of offers) was
    // 1cf67a41b36d48da / 25bbe28d1cd4254d (the createRun digest moved in wave 2 with the run format, not the plan);
    // the v2 digests were 9441f66641fed3bc / 27c2bf90bab92bea.
    expect(RUN_PLAN_VERSION).toBe(4);
    expect(planDigestOf(1_000)).toBe('9da64c5166af4751');
    expect(createDigestOf(50)).toBe('9570e3da66a5cb8a');
  }, 120_000);

  it('planRun and createRun are pure: the same input gives the same output twice, in any order', () => {
    const a = planRun({ seed: 7, difficulty: 'standard' });
    planRun({ seed: 8, difficulty: 'tough' });
    expect(hashState(planRun({ seed: 7, difficulty: 'standard' }))).toBe(hashState(a));
    const run = createRun({ seed: 7, difficulty: 'standard', grant: EMPTY_GRANT });
    expect(hashState(createRun({ seed: 7, difficulty: 'standard', grant: EMPTY_GRANT }))).toBe(hashState(run));
  });

  it('the streams are stateless: a draw does not depend on other draws, and streams never share values', () => {
    const first = runRandom(5, 'offer', 2);
    const values = [first(), first(), first()];
    runRandom(5, 'family', 2)();
    const again = runRandom(5, 'offer', 2);
    expect([again(), again(), again()]).toEqual(values);
    expect(runHash32(5, 'offer', 2)).not.toBe(runHash32(5, 'family', 2));
    expect(runHash32(5, 'map', 2, 0)).not.toBe(runHash32(5, 'map', 2, 1));
    for (const value of values) expect(value).toBeGreaterThanOrEqual(0);
  });

  it('a different seed is a different run, the difficulty keeps the story (biomes, offers, starter deck) and changes the numbers', () => {
    const standard = planRun({ seed: 99, difficulty: 'standard' });
    const tough = planRun({ seed: 99, difficulty: 'tough' });
    expect(tough.levels.map((level) => level.biomeId)).toEqual(standard.levels.map((level) => level.biomeId));
    expect(tough.levels.map((level) => level.offer)).toEqual(standard.levels.map((level) => level.offer));
    expect(tough.starterDeck).toEqual(standard.starterDeck);
    expect(hashState(planRun({ seed: 100, difficulty: 'standard' }))).not.toBe(hashState(standard));
    expect(tough.levels.some((level, index) => level.startingCash !== standard.levels[index].startingCash)).toBe(true);
  });

  it('rejects a bad seed or difficulty with a RangeError', () => {
    for (const seed of [-1, 1.5, 4_294_967_296, Number.NaN, '5' as never]) expect(() => planRun({ seed, difficulty: 'standard' }), String(seed)).toThrow(RangeError);
    expect(() => planRun({ seed: 1, difficulty: 'brutal' as never })).toThrow(RangeError);
    expect(planRun({ seed: 0, difficulty: 'relaxed' }).levels).toHaveLength(LEVELS);
    expect(planRun({ seed: 4_294_967_295, difficulty: 'tough' }).levels).toHaveLength(LEVELS);
  });
});

describe('the plan rules (1,000 seeds x 3 difficulties)', () => {
  const plans = RUN_DIFFICULTIES.flatMap((difficulty) => Array.from({ length: 1_000 }, (_, seed) => planRun({ seed, difficulty })));

  it('level 1 is Meadow and no biome repeats', () => {
    for (const plan of plans) {
      expect(plan.levels[0].biomeId).toBe(CONFIG.firstBiome);
      expect(new Set(plan.levels.map((level) => level.biomeId)).size).toBe(LEVELS);
    }
  });

  it('level 1 draws visitors or crowd, no family repeats on consecutive levels, and a family only appears where the table has its target', () => {
    for (const plan of plans) {
      expect(['visitors', 'crowd']).toContain(plan.levels[0].family);
      plan.levels.forEach((level, index) => {
        expect(familiesAt(index), `${plan.seed} L${index + 1}`).toContain(level.family);
        if (index > 0) expect(level.family).not.toBe(plan.levels[index - 1].family);
        expect(level.objective.id).toBe(`run-${level.family}`);
      });
    }
  });

  it('condition counts follow the table and the difficulty, with no excluded biome, family or early level', () => {
    for (const plan of plans) {
      plan.levels.forEach((level, index) => {
        const wanted = Math.min(CONFIG.maxConditionsPerLevel, Math.max(0, CONFIG.levels[index].conditions + CONFIG.difficulties[plan.difficulty].conditionDelta));
        expect(level.conditionIds.length, `${plan.seed} ${plan.difficulty} L${index + 1}`).toBeLessThanOrEqual(wanted);
        expect(new Set(level.conditionIds).size).toBe(level.conditionIds.length);
        for (const id of level.conditionIds) {
          const condition = RUN_CONDITION_BY_ID.get(id)!;
          expect(condition.minLevel).toBeLessThanOrEqual(index + 1);
          expect(condition.excludedBiomes).not.toContain(level.biomeId);
          expect(condition.excludedFamilies).not.toContain(level.family);
        }
      });
    }
    // The table is met exactly whenever enough conditions are allowed (level 1 has none: every condition starts at level 2).
    for (const plan of plans) plan.levels.forEach((level, index) => {
      const wanted = Math.min(CONFIG.maxConditionsPerLevel, Math.max(0, CONFIG.levels[index].conditions + CONFIG.difficulties[plan.difficulty].conditionDelta));
      expect(level.conditionIds.length).toBe(Math.min(wanted, allowedConditionsFor(index, level.biomeId, level.family).length));
    });
  });

  it('the starter deck is 3 distinct commons, never both halves of an opposing pair', () => {
    for (const plan of plans) {
      expect(plan.starterDeck).toHaveLength(CONFIG.starterDeckSize);
      for (const id of plan.starterDeck) expect(CARD_BY_ID.get(id)!.rarity, id).toBe('common');
      expect(new Set(plan.starterDeck).size).toBe(CONFIG.starterDeckSize);
      for (const [a, b] of OPPOSING_CARD_PAIRS) expect(plan.starterDeck.includes(a) && plan.starterDeck.includes(b)).toBe(false);
    }
  });

  it('every offer is distinct, in canonical order, of the configured size, and no card is ever added more than copyCap times', () => {
    const order = PULSE_CARDS.map((card) => card.id);
    for (const plan of plans) {
      const added = new Map<PulseCardId, number>();
      for (const id of plan.starterDeck) added.set(id, (added.get(id) ?? 0) + 1);
      for (const level of plan.levels) {
        expect(level.offer).toHaveLength(CONFIG.offerSize);
        expect(new Set(level.offer).size).toBe(level.offer.length);
        expect(level.offer.map((id) => order.indexOf(id))).toEqual([...level.offer.map((id) => order.indexOf(id))].sort((a, b) => a - b));
        for (const [a, b] of OPPOSING_CARD_PAIRS) expect(level.offer.includes(a) && level.offer.includes(b), `${plan.seed} L${level.index + 1} ${a}/${b}`).toBe(false);
        for (const id of level.offer) added.set(id, (added.get(id) ?? 0) + 1);
      }
      for (const count of added.values()) expect(count).toBeLessThanOrEqual(CONFIG.copyCap);
    }
  });

  it('slots, deadlines and cash follow the tables; park seeds are u32', () => {
    for (const plan of plans) {
      plan.levels.forEach((level, index) => {
        expect(level.slots).toBe(CONFIG.slotsByLevel[index]);
        expect(level.timeLimitDays).toBe(CONFIG.difficulties[plan.difficulty].deadlineDays[index]);
        expect(level.timeLimitDays).toBe(deadlineDaysAt(index, plan.difficulty));
        expect(level.startingCash).toBe(CONFIG.levels[index].startingCash + CONFIG.difficulties[plan.difficulty].cashDelta[index]);
        expect(Number.isInteger(level.parkSeed) && level.parkSeed >= 0 && level.parkSeed <= 0xffff_ffff).toBe(true);
      });
    }
  });
});

describe('offers: duplicate and dead-card protection (with cards that do not exist yet)', () => {
  const fake = (count: number): PulseCardId[] => Array.from({ length: count }, (_, index) => `fake-${index}` as PulseCardId);

  it('a small pool shrinks the offer instead of padding it, and respects the copy cap', () => {
    const plan = planRun({ seed: 3, difficulty: 'standard' }, { pool: fake(3) });
    const added = new Map<string, number>();
    for (const id of plan.starterDeck) added.set(id, (added.get(id) ?? 0) + 1);
    for (const level of plan.levels) for (const id of level.offer) added.set(id, (added.get(id) ?? 0) + 1);
    expect([...added.values()].every((count) => count <= CONFIG.copyCap)).toBe(true);
    expect(plan.levels.reduce((sum, level) => sum + level.offer.length, 0)).toBe(3 * CONFIG.copyCap - plan.starterDeck.length);
    expect(plan.levels.at(-1)!.offer.length).toBeLessThan(CONFIG.offerSize);
  });

  it('a card that is dead in every biome still to come is not offered; one that is dead only in some biomes is', () => {
    const pool = fake(6);
    const deadEverywhere = pool[0];
    const deadInWinter = pool[1];
    for (let seed = 0; seed < 50; seed += 1) {
      const plan = planRun({ seed, difficulty: 'standard' }, {
        pool,
        deadCardIds: (biomeId) => (biomeId === 'winter' ? [deadEverywhere, deadInWinter] : [deadEverywhere]),
      });
      for (const level of plan.levels) expect(level.offer, `seed ${seed}`).not.toContain(deadEverywhere);
    }
    const winterOnly = Array.from({ length: 200 }, (_, seed) => planRun({ seed, difficulty: 'standard' }, { pool, deadCardIds: (biomeId) => (biomeId === 'winter' ? [deadInWinter] : []) }));
    expect(winterOnly.some((plan) => plan.levels.some((level) => level.offer.includes(deadInWinter)))).toBe(true);
  });

  it('the shipped pool\'s dead cards are derived from the weather chain: the two wet-only cards, in the Desert Canyon only', () => {
    for (const biomeId of BIOME_IDS) expect(deadCardIdsIn(biomeId)).toEqual(biomeId === 'desert-canyon' ? ['dry-spell', 'farmers-almanac'] : []);
  });

  it('with the copy cap at 1 and a pool of 6, the starter deck and offers hold each card at most once', () => {
    const config = GAME_CONFIG.run as { copyCap: number; levelCount: number };
    const saved = config.copyCap;
    config.copyCap = 1;
    try {
      const plan = planRun({ seed: 5, difficulty: 'standard' });
      const all = [...plan.starterDeck, ...plan.levels.flatMap((level) => level.offer)];
      expect(new Set(all).size).toBe(all.length);
    } finally {
      config.copyCap = saved;
    }
  });
});

describe('biomes for a longer run (config only)', () => {
  it('after the five biomes the list repeats as a fresh shuffle and never puts a biome on two adjacent levels', () => {
    for (let seed = 0; seed < 200; seed += 1) {
      const biomes = biomesOf(seed, 8);
      expect(biomes).toHaveLength(8);
      expect(biomes[0]).toBe('meadow');
      for (let index = 1; index < biomes.length; index += 1) expect(biomes[index]).not.toBe(biomes[index - 1]);
      expect(new Set(biomes.slice(0, 6)).size).toBe(6);
    }
  });
});

describe('difficulty tables', () => {
  const target = (family: RunObjectiveFamily, level: number, difficulty: (typeof RUN_DIFFICULTIES)[number]): number => objectiveOf(family, level, difficulty).target;

  it('targets and cash never fall from one level to the next, per family', () => {
    for (const difficulty of RUN_DIFFICULTIES) {
      for (const family of ['visitors', 'profit', 'crowd', 'spirits'] as const) {
        const present = Array.from({ length: LEVELS }, (_, level) => level).filter((level) => familiesAt(level).includes(family));
        for (let index = 1; index < present.length; index += 1) {
          expect(target(family, present[index], difficulty), `${difficulty} ${family}`).toBeGreaterThanOrEqual(target(family, present[index - 1], difficulty));
        }
      }
    }
    for (let level = 1; level < LEVELS; level += 1) expect(CONFIG.levels[level].startingCash).toBeGreaterThanOrEqual(CONFIG.levels[level - 1].startingCash);
    for (const difficulty of RUN_DIFFICULTIES) {
      for (let level = 1; level < LEVELS; level += 1) {
        expect(deadlineDaysAt(level, difficulty), difficulty).toBeGreaterThanOrEqual(deadlineDaysAt(level - 1, difficulty));
        expect(startingCashAt(level, difficulty), difficulty).toBeGreaterThanOrEqual(startingCashAt(level - 1, difficulty));
      }
    }
  });

  it('Relaxed <= Standard <= Tough in every target, and the reverse in cash', () => {
    for (let level = 0; level < LEVELS; level += 1) {
      for (const family of familiesAt(level)) {
        expect(target(family, level, 'relaxed')).toBeLessThanOrEqual(target(family, level, 'standard'));
        expect(target(family, level, 'standard')).toBeLessThanOrEqual(target(family, level, 'tough'));
      }
      const cash = (difficulty: (typeof RUN_DIFFICULTIES)[number]): number => planLevelForTest(1, level, 'meadow', familiesAt(level)[0], difficulty).startingCash;
      expect(cash('relaxed')).toBeGreaterThan(cash('standard'));
      expect(cash('standard')).toBeGreaterThan(cash('tough'));
    }
  });

  it('scaled targets are rounded to the table steps and sit inside the ranges a saved run is allowed to hold', () => {
    for (const difficulty of RUN_DIFFICULTIES) {
      for (let level = 0; level < LEVELS; level += 1) {
        for (const family of familiesAt(level)) {
          const objective = objectiveOf(family, level, difficulty);
          if (family === 'visitors') expect(objective.target % CONFIG.rounding.visitors).toBe(0);
          if (family === 'profit') expect(objective.target % CONFIG.rounding.profit).toBe(0);
          if (family === 'crowd') expect(objective.target % CONFIG.rounding.crowd).toBe(0);
          if (family === 'spirits') {
            expect(objective.kind).toBe('sustain');
            expect(objective.target).toBeGreaterThan(0);
            expect(objective.target).toBeLessThanOrEqual(100);
          }
          expect(objective.target).toBeGreaterThan(0);
        }
      }
    }
  });

  it('the crowd targets stay below what a three-ride park can hold (about 115), even at Tough', () => {
    for (let level = 0; level < LEVELS; level += 1) {
      if (familiesAt(level).includes('crowd')) expect(target('crowd', level, 'tough')).toBeLessThanOrEqual(110);
    }
  });

  it('the curve is set by the level: the spirits hold grows with the level and the difficulty, crowd opens the run only, level 5 scales', () => {
    const hold = (level: number, difficulty: (typeof RUN_DIFFICULTIES)[number]): number => {
      const objective = objectiveOf('spirits', level, difficulty);
      return objective.kind === 'sustain' ? objective.durationSeconds : 0;
    };
    const spiritsLevels = Array.from({ length: LEVELS }, (_, level) => level).filter((level) => familiesAt(level).includes('spirits'));
    expect(spiritsLevels.length).toBeGreaterThan(1);
    for (const difficulty of RUN_DIFFICULTIES) {
      for (let index = 1; index < spiritsLevels.length; index += 1) {
        expect(hold(spiritsLevels[index], difficulty), `${difficulty} L${spiritsLevels[index] + 1}`).toBeGreaterThan(hold(spiritsLevels[index - 1], difficulty));
      }
    }
    for (const level of spiritsLevels) {
      expect(hold(level, 'relaxed')).toBeLessThan(hold(level, 'standard'));
      expect(hold(level, 'standard')).toBeLessThan(hold(level, 'tough'));
      expect(hold(level, 'standard') % CONFIG.rounding.spiritsSeconds).toBe(0);
      // A hold that is a third or more of the deadline: the lever is real, and the Tough hold still leaves room for a dip.
      // Against THAT difficulty's deadline (design 7.1: the deadline is a difficulty column).
      const deadline = (difficulty: (typeof RUN_DIFFICULTIES)[number]): number => deadlineDaysAt(level, difficulty) * GAME_CONFIG.calendar.defaultDayLengthSeconds;
      expect(hold(level, 'standard') / deadline('standard')).toBeGreaterThanOrEqual(0.3);
      expect(hold(level, 'tough') / deadline('tough')).toBeLessThanOrEqual(0.55);
    }
    // Crowd is a park-size goal (a three-ride park fills it at any level): it opens the run and is never drawn late.
    for (let level = 2; level < LEVELS; level += 1) expect(familiesAt(level)).not.toContain('crowd');
    // The last level draws only the families whose targets scale with the difficulty.
    expect(familiesAt(LEVELS - 1)).toEqual(['visitors', 'profit']);
  });

  it('the deadlines are whole quarter days and a run is about two hours of park time at every difficulty', () => {
    for (const difficulty of RUN_DIFFICULTIES) {
      const days = Array.from({ length: LEVELS }, (_, level) => deadlineDaysAt(level, difficulty));
      for (const day of days) expect((day * 4) % 1, difficulty).toBe(0);
      const sum = days.reduce((total, day) => total + day, 0);
      expect(sum, difficulty).toBeGreaterThan(9);
      expect(sum, difficulty).toBeLessThan(12);
    }
  });

  it('the Phase 25 retune (design 7.1): Relaxed is the Phase 23 Standard; Standard and Tough are harder, not longer', () => {
    const days = (difficulty: (typeof RUN_DIFFICULTIES)[number]): number[] => Array.from({ length: LEVELS }, (_, level) => deadlineDaysAt(level, difficulty));
    const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
    expect(days('relaxed')).toEqual([1.5, 2, 2, 2.5, 2.5]);
    expect(sum(days('relaxed'))).toBe(10.5);
    expect(sum(days('standard'))).toBe(9.25);
    expect(sum(days('tough'))).toBe(9.25);
    for (let level = 0; level < LEVELS; level += 1) {
      expect(deadlineDaysAt(level, 'standard')).toBeLessThan(deadlineDaysAt(level, 'relaxed'));
      expect(deadlineDaysAt(level, 'tough')).toBeLessThanOrEqual(deadlineDaysAt(level, 'standard'));
    }
    // Relaxed: the Phase 23 Standard numbers (scale 1, no shift, no condition or density step).
    const relaxed = CONFIG.difficulties.relaxed;
    expect([relaxed.targetScale, relaxed.spiritsSecondsScale, relaxed.spiritsBarDelta, relaxed.conditionDelta, relaxed.densityStep]).toEqual([1, 1, 0, 0, 0]);
    expect(relaxed.cashDelta.every((delta) => delta === 0)).toBe(true);
    // The resulting level-5 targets and cash (visitors and profit, R / S / T). Tough's targetScale is 1.10, not the design's
    // 1.15: the first step of the design 7.2 ladder, because a plausible deck missed 0.90 at Tough level 5 (BALANCE_NOTES).
    expect(RUN_DIFFICULTIES.map((difficulty) => target('visitors', LEVELS - 1, difficulty))).toEqual([380, 420, 420]);
    expect(RUN_DIFFICULTIES.map((difficulty) => target('profit', LEVELS - 1, difficulty))).toEqual([6_500, 7_200, 7_200]);
    expect(RUN_DIFFICULTIES.map((difficulty) => startingCashAt(LEVELS - 1, difficulty))).toEqual([14_000, 13_000, 11_500]);
    // Tough adds a condition from level 2 on (no condition is allowed on level 1).
    expect(CONFIG.difficulties.tough.conditionDelta).toBe(1);
    // The proof margins: the no-card bot per difficulty and the plausible deck.
    expect(RUN_DIFFICULTIES.map((difficulty) => CONFIG.difficulties[difficulty].botMargin)).toEqual([0.85, 0.9, 1]);
    for (const difficulty of RUN_DIFFICULTIES) {
      expect(CONFIG.difficulties[difficulty].deadlineDays.length, difficulty).toBe(LEVELS);
      expect(CONFIG.difficulties[difficulty].cashDelta.length, difficulty).toBe(LEVELS);
      expect(CONFIG.difficulties[difficulty].deckMargin, difficulty).toBeLessThanOrEqual(CONFIG.difficulties[difficulty].botMargin);
    }
  });
});

describe('maps (50 runs)', () => {
  it('every accepted map holds the acceptance rules and the generator caps, and its recipe is the planned biome', () => {
    for (let index = 0; index < 50; index += 1) {
      const run = createRun({ seed: (index * 7_919) >>> 0, difficulty: RUN_DIFFICULTIES[index % 3], grant: EMPTY_GRANT });
      run.levels.forEach((level) => {
        expect(level.recipe.biomeId).toBe(level.biomeId);
        const map = generateMap(level.recipe);
        expect(mapIsAcceptable(map), `${run.seed} L${level.index + 1}`).toBe(true);
        expect(map.stats.cleared).toBeGreaterThanOrEqual(CONFIG.map.minimumClearedArea);
        expect(map.stats.maxChunkWeight).toBeLessThanOrEqual(GAME_CONFIG.maps.generator.chunkPropWeightCap);
        expect(map.stats.totalWeight).toBeLessThanOrEqual(GAME_CONFIG.maps.generator.mapPropWeightCap);
        expect(map.stats.maxPropCellsPerChunk).toBeLessThanOrEqual(GAME_CONFIG.maps.maxPropCellsPerChunk);
      });
    }
  }, 30_000); // 50 runs of generated maps: about 4 s alone, past vitest's 5 s default under full-suite load.

  it('the map seed of an attempt is a stateless function of (run seed, level, attempt)', () => {
    expect(mapSeedFor(5, 2, 0)).toBe(mapSeedFor(5, 2, 0));
    expect(mapSeedFor(5, 2, 0)).not.toBe(mapSeedFor(5, 2, 1));
    expect(mapSeedFor(5, 2, 0)).not.toBe(mapSeedFor(5, 3, 0));
  });
});

describe('starter deck', () => {
  it('covers every common over many seeds, so no common is a permanent outsider (uncommons and rares come from offers)', () => {
    const seen = new Set<PulseCardId>();
    for (let seed = 0; seed < 300; seed += 1) for (const id of starterDeckOf(seed)) seen.add(id);
    expect(seen.size).toBe(PULSE_CARDS.filter((card) => card.rarity === 'common').length);
  });

  it('a pool too small to avoid an opposing pair still fills the deck (never with the shipped pool)', () => {
    const [a, b] = OPPOSING_CARD_PAIRS[0];
    expect(starterDeckOf(1, [a, b, 'lean-crew'])).toHaveLength(3);
  });
});

describe('rarity, the keyed weighted draw and offer stability (Phase 25)', () => {
  it('cardKey32 is FNV-1a over UTF-16 code units', () => {
    expect(cardKey32('')).toBe(0x811c9dc5);
    expect(cardKey32('a')).toBe(0xe40c292c);
    expect(cardKey32('foobar')).toBe(0xbf9cf968);
    expect(cardKey32('grand-opening')).toBe(cardKey32('grand-opening'));
    expect(cardKey32('grand-opening')).not.toBe(cardKey32('velvet-ropes'));
  });

  it('the first pick of the keyed draw has probability w / sum(w) (20,000 bases, within 1 point)', () => {
    const candidates = [{ id: 'a', weight: 6 }, { id: 'b', weight: 3 }, { id: 'c', weight: 2 }, { id: 'd', weight: 0 }, { id: 'e', weight: 1 }];
    const tally = new Map<string, number>();
    const draws = 20_000;
    for (let base = 0; base < draws; base += 1) {
      const [first] = keyedWeightedDraw(runHash32(base, 'offer', 0), candidates, 1);
      tally.set(first, (tally.get(first) ?? 0) + 1);
    }
    expect(tally.has('d')).toBe(false);
    for (const { id, weight } of candidates) expect(Math.abs((tally.get(id) ?? 0) / draws - weight / 12), id).toBeLessThanOrEqual(0.01);
    expect(() => keyedWeightedDraw(1, [{ id: 'x', weight: 1.5 }], 1)).toThrow(RangeError);
    // Acceptance: a refused card is skipped, the walk goes on.
    expect(keyedWeightedDraw(7, [{ id: 'a', weight: 1 }, { id: 'b', weight: 1 }], 2, (id) => id !== 'a')).toEqual(['b']);
  });

  it('no uncommon before level 2 and no rare before level 3 (2,000 seeds); every offer is exactly 2', () => {
    const tierCounts = { common: 0, uncommon: 0, rare: 0 };
    for (let seed = 0; seed < 2_000; seed += 1) {
      const plan = planRun({ seed: (seed * 2_654_435_761) >>> 0, difficulty: 'standard' });
      plan.levels.forEach((level, index) => {
        expect(level.offer).toHaveLength(CONFIG.offerSize);
        for (const id of level.offer) {
          const rarity = CARD_BY_ID.get(id)!.rarity;
          expect(index + 1 >= CONFIG.rarity[rarity].firstLevel, `${plan.seed} L${index + 1} ${id} (${rarity})`).toBe(true);
          if (index >= 2) tierCounts[rarity] += 1;
        }
      });
    }
    // From level 3 on every tier is drawn; the shares follow the weights (6 x 28 : 3 x 16 : 2 x 4 before caps and pairs).
    const total = tierCounts.common + tierCounts.uncommon + tierCounts.rare;
    expect(tierCounts.rare / total).toBeGreaterThan(0.02);
    expect(tierCounts.rare / total).toBeLessThan(0.07);
    expect(tierCounts.uncommon / total).toBeGreaterThan(0.15);
    expect(tierCounts.uncommon / total).toBeLessThan(0.3);
  });

  it('offerWeightOf: 0 when capped, too early or dead in every biome still to come, else the tier weight', () => {
    expect(offerWeightOf('grand-opening', 0, 0, ['meadow'])).toBe(CONFIG.rarity.common.weight);
    expect(offerWeightOf('grand-opening', 0, CONFIG.copyCap, ['meadow'])).toBe(0);
    expect(offerWeightOf('night-market', 0, 0, ['meadow'])).toBe(0);
    expect(offerWeightOf('night-market', 1, 0, ['meadow'])).toBe(CONFIG.rarity.uncommon.weight);
    expect(offerWeightOf('weather-station', 1, 0, ['meadow'])).toBe(0);
    expect(offerWeightOf('weather-station', 2, 0, ['meadow'])).toBe(CONFIG.rarity.rare.weight);
    expect(offerWeightOf('dry-spell', 3, 0, ['desert-canyon'])).toBe(0);
    expect(offerWeightOf('dry-spell', 3, 0, ['desert-canyon', 'jungle'])).toBe(CONFIG.rarity.uncommon.weight);
  });

  it('is stable: adding a card changes an old seed\'s plan only from where the new card itself takes a place', () => {
    const fake = 'fake-newcomer' as PulseCardId;
    const pool = [...PULSE_CARD_IDS, fake];
    let touched = 0;
    for (let seed = 0; seed < 300; seed += 1) {
      const before = planRun({ seed, difficulty: 'standard' });
      const after = planRun({ seed, difficulty: 'standard' }, { pool });
      if (after.starterDeck.includes(fake)) {
        touched += 1;
        continue;
      }
      expect(after.starterDeck, `seed ${seed}`).toEqual(before.starterDeck);
      const first = after.levels.findIndex((level) => level.offer.includes(fake));
      if (first >= 0) touched += 1;
      const same = first < 0 ? after.levels.length : first;
      for (let index = 0; index < same; index += 1) expect(after.levels[index].offer, `seed ${seed} L${index + 1}`).toEqual(before.levels[index].offer);
    }
    expect(touched).toBeGreaterThan(0);
    expect(touched).toBeLessThan(300);
  });
});
