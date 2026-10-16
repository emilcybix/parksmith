import { describe, expect, it } from 'vitest';
import { BIOME_BY_ID } from '../game/biomes/content';
import { CARD_BY_ID, kindOf, slotCostOf } from '../game/cards/content';
import { compileBonusLayer } from '../game/profile/bonuses';
import { buildStage, RUN_CONDITION_BY_ID } from '../game/run';
import { compileParkRules } from '../game/scenarios/rules';
import { buildRunLoadout, sanitiseLoadout, toggleLoadoutCard } from './runLoadoutModel';
import { describeEffectiveModifiers } from './scenarioCopy';
import { runAt, snapshotAt } from './runTestSupport';
import { runSnapshotOf } from '../game/run';

describe('run loadout model', () => {
  it('shows the level brief, the whole deck once per card with its count, and the slot counter', () => {
    const run = snapshotAt(3, 'loadout');
    const model = buildRunLoadout(run, [], []);
    expect(model).not.toBeNull();
    if (model === null) return;
    expect(model.heading).toBe('Choose cards for level 4');
    expect(model.slots).toBe(2);
    expect(model.deck.reduce((sum, card) => sum + card.count, 0)).toBe(run.deckSize);
    expect(new Set(model.deck.map((card) => card.cardId)).size).toBe(model.deck.length);
    expect(model.counter).toBe('0 of 2 slots chosen · these cards are used up when the level starts');
    expect(model.note).toBe('No cards: this level plays with the conditions only.');
    expect(model.startLabel).toBe('Start level 4 without cards');
    expect(model.afterLine).toBe(`After this level: ${run.deckSize} cards left in your deck.`);
    expect(model.startEnabled).toBe(true);
    expect(model.conditions.length).toBeGreaterThan(0);
  });

  it('a chosen card shows in the counter, the label and the cards left, and blocks the rest when the slots are full', () => {
    const run = snapshotAt(3, 'loadout');
    const [a, b, c] = run.deck.map((row) => row.cardId);
    const one = buildRunLoadout(run, [a], []);
    expect(one?.counter.startsWith('1 of 2 slots chosen')).toBe(true);
    expect(one?.note).toBeNull();
    expect(one?.startLabel).toBe('Start level 4');
    expect(one?.afterLine).toBe(`After this level: ${run.deckSize - 1} cards left in your deck.`);
    expect(one?.deck.some((card) => card.blocked)).toBe(false);
    const full = buildRunLoadout(run, [a, b], []);
    expect(full?.deck.find((card) => card.cardId === c)?.blocked).toBe(true);
    expect(full?.deck.find((card) => card.cardId === a)?.blocked).toBe(false);
    expect(full?.deck.find((card) => card.cardId === a)?.selected).toBe(true);
  });

  it('sanitises a selection: only deck cards, distinct, within the slots', () => {
    const run = snapshotAt(0, 'loadout');
    const [first] = run.deck.map((row) => row.cardId);
    expect(run.slotsNow).toBe(1);
    expect(sanitiseLoadout(run, [first, first])).toEqual([first]);
    expect(sanitiseLoadout(run, ['not-a-card', first])).toEqual([first]);
    expect(sanitiseLoadout(run, run.deck.map((row) => row.cardId))).toHaveLength(1);
    expect(sanitiseLoadout(run, [])).toEqual([]);
  });

  it('toggling adds up to the slots and always removes', () => {
    const run = snapshotAt(3, 'loadout');
    const [a, b, c] = run.deck.map((row) => row.cardId);
    let selected: string[] = [];
    selected = toggleLoadoutCard(run, selected, a);
    selected = toggleLoadoutCard(run, selected, b);
    expect(selected).toEqual([a, b]);
    expect(toggleLoadoutCard(run, selected, c)).toEqual([a, b]);
    expect(toggleLoadoutCard(run, selected, a)).toEqual([b]);
  });

  it('computes the same effective rules as the stage session compiles (no drift: conditions, biome, cards, grant)', () => {
    for (const level of [1, 3, 4]) {
      for (const bonusIds of [[] as string[], ['nest-egg', 'spare-slot']]) {
        const state = runAt(level, 'loadout');
        const snapshot = runSnapshotOf(state);
        // What the bridge would send (slot cost included: a rare takes both slots).
        const cards = sanitiseLoadout(snapshot, [...new Set(snapshot.deck.map((row) => row.cardId))].slice(0, Math.min(2, snapshot.slotsNow)));
        const model = buildRunLoadout(snapshot, cards, bonusIds);
        const stage = buildStage(state, state.levelIndex);
        const layer = compileBonusLayer(bonusIds, 'run', stage.definition.rules.startingCash ?? 0);
        const expected = compileParkRules(
          stage.definition.rules,
          cards.map((id) => CARD_BY_ID.get(id)?.modifiers ?? {}),
          BIOME_BY_ID.get(state.levels[state.levelIndex].biomeId)?.rules,
          layer,
        );
        expect(model?.effective, `level ${level + 1}`).toEqual(describeEffectiveModifiers(expected));
        expect(model?.startingCash).toBe(`Starting cash $${expected.startingCash.toLocaleString('en-US')}`);
      }
    }
  });

  it('a condition changes the effective rules and a bonus adds its line', () => {
    const run = snapshotAt(3, 'loadout');
    const withCondition = buildRunLoadout(run, [], []);
    expect(withCondition?.effective.length).toBeGreaterThan(0);
    for (const condition of run.levels[3].conditions) expect(RUN_CONDITION_BY_ID.has(condition.id)).toBe(true);
    expect(withCondition?.bonusLine).toBeNull();
    const bonus = buildRunLoadout(run, [], ['nest-egg']);
    expect(bonus?.bonusLine).toMatch(/^Permanent bonuses \(The Map\): Nest egg \+\$/);
    expect(bonus?.startingCash).not.toBe(withCondition?.startingCash);
  });

  it('a stage-clear run says the cards are used up when the level is cleared', () => {
    const run = { ...snapshotAt(1, 'loadout'), consumeAt: 'stage-clear' as const };
    expect(buildRunLoadout(run, [], [])?.counter).toContain('used up when the level is cleared');
  });

  it('cannot start outside the loadout phase', () => {
    expect(buildRunLoadout(snapshotAt(1, 'stage'), [], [])?.startEnabled).toBe(false);
  });

  it('an empty deck is a legal loadout of nothing', () => {
    const run = { ...snapshotAt(1, 'loadout'), deck: [], deckSize: 0 };
    const model = buildRunLoadout(run, ['grand-opening'], []);
    expect(model?.deck).toEqual([]);
    expect(model?.note).not.toBeNull();
    expect(model?.afterLine).toBe('After this level: 0 cards left in your deck.');
  });
});

describe('run loadout: slot cost, one-shots and the pocket (Phase 25)', () => {
  /** Level 4 (two slots) with a hand-made deck: a common, a rare (2 slots) and two one-shots. */
  const withDeck = (ids: readonly string[], slotsNow = 2) => ({
    ...snapshotAt(3, 'loadout'),
    deck: ids.map((cardId) => ({ cardId: cardId as never, count: 1 })),
    deckSize: ids.length,
    slotsNow,
  });
  const DECK = ['grand-opening', 'master-builders', 'coach-party', 'bridging-loan'];

  it('the pool says what a card costs: the rare takes 2 slots', () => {
    expect(slotCostOf('master-builders')).toBe(2);
    expect(kindOf('coach-party')).toBe('one-shot');
    const model = buildRunLoadout(withDeck(DECK), [], []);
    expect(model?.deck.map((card) => [card.cardId, card.kind, card.rarity, card.slotCost])).toEqual(
      DECK.map((id) => [id, kindOf(id as never), CARD_BY_ID.get(id as never)?.rarity, slotCostOf(id as never)]),
    );
  });

  it('the counter counts slots, not cards, and a rare fills two', () => {
    const run = withDeck(DECK);
    const model = buildRunLoadout(run, ['master-builders'], []);
    expect(model?.slotsUsed).toBe(2);
    expect(model?.counter.startsWith('2 of 2 slots chosen')).toBe(true);
    expect(model?.deck.filter((card) => card.blocked).map((card) => card.cardId)).toEqual(['grand-opening', 'coach-party', 'bridging-loan']);
    expect(model?.deck.find((card) => card.cardId === 'grand-opening')?.blockedReason).toBe('No free slot');
    expect(model?.afterLine).toBe('After this level: 3 cards left in your deck.');
  });

  it('a rare that does not fit is aria-disabled with "Needs 2 free slots", and is never sent', () => {
    const run = withDeck(DECK);
    const one = buildRunLoadout(run, ['grand-opening'], []);
    const rare = one?.deck.find((card) => card.cardId === 'master-builders');
    expect(rare).toMatchObject({ blocked: true, blockedReason: 'Needs 2 free slots' });
    expect(one?.deck.find((card) => card.cardId === 'coach-party')?.blocked).toBe(false);
    expect(sanitiseLoadout(run, ['grand-opening', 'master-builders', 'coach-party'])).toEqual(['grand-opening', 'coach-party']);
    expect(toggleLoadoutCard(run, ['grand-opening'], 'master-builders')).toEqual(['grand-opening']);
    expect(toggleLoadoutCard(run, [], 'master-builders')).toEqual(['master-builders']);
    expect(sanitiseLoadout(withDeck(DECK, 1), ['master-builders'])).toEqual([]);
    expect(buildRunLoadout(withDeck(DECK, 1), [], [])?.deck.find((card) => card.cardId === 'master-builders')?.blockedReason).toBe('Needs 2 free slots');
  });

  it('one-shots change no park rule and are listed as the pocket', () => {
    const run = withDeck(DECK);
    const none = buildRunLoadout(run, [], []);
    const pocket = buildRunLoadout(run, ['coach-party', 'bridging-loan'], []);
    expect(pocket?.effective).toEqual(none?.effective);
    expect(pocket?.startingCash).toBe(none?.startingCash);
    expect(pocket?.pocketLine).toBe('Pocket: Coach Party, Bridging Loan');
    expect(none?.pocketLine).toBeNull();
    expect(pocket?.counter).toMatch(/used up when the level starts, except a one-shot you do not play, which comes back$/);
    expect(none?.counter).toMatch(/used up when the level starts$/);
    expect(buildRunLoadout(run, ['grand-opening', 'coach-party'], [])?.pocketLine).toBe('Pocket: Coach Party');
    expect(buildRunLoadout(run, ['grand-opening'], [])?.pocketLine).toBeNull();
  });
});

