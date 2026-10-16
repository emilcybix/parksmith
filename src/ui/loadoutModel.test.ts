import { describe, expect, it } from 'vitest';
import { PULSE_CARDS, STARTING_CARD_IDS } from '../game/cards/content';
import { BONUSES } from '../game/profile/bonuses';
import { SCENARIO_BY_ID } from '../game/scenarios/content';
import { bonusEffectShort, buildLoadout, ONE_SHOTS_ON_THE_MAP } from './loadoutModel';
import { useUiStore } from './store';
import { profileAfter } from './profileTestSupport';

const sunny = SCENARIO_BY_ID.get('sunny-start')!;

describe('loadout model', () => {
  it('a fresh profile gets the plain scenario slots, no bonus line and the starting cards', () => {
    const model = buildLoadout(sunny, 'scenario', profileAfter([]).snapshot, [], []);
    expect(model.slots).toBe(sunny.cardSlots);
    expect(model.bonusLine).toBeNull();
    expect(model.poolCardIds).toEqual(STARTING_CARD_IDS);
    expect(model.appliedBonusIds).toEqual([]);
  });

  it('lists the earned bonuses of the mode and adds the Spare card slot to the slots', () => {
    const { manager } = profileAfter(['sunny-start', 'garden-gala', 'penny-lane']);
    const snapshot = profileAfter(['sunny-start', 'penny-lane', 'garden-gala', 'starlight-finale']).snapshot;
    expect(manager.snapshot().bonusIds).toContain('nest-egg');
    const model = buildLoadout(sunny, 'scenario', snapshot, [], []);
    expect(model.bonusLine).toMatch(/^Permanent bonuses \(Scenario\): Nest egg \+\$500 · /);
    expect(model.bonusLine).toContain('Spare card slot +1 slot');
    expect(model.slots).toBe(sunny.cardSlots + 1);
    expect(model.startingCash).toBeGreaterThan(buildLoadout(sunny, 'scenario', profileAfter([]).snapshot, [], []).startingCash);
  });

  it('with the switch off it says so instead of applying anything, and changes nothing', () => {
    const { manager } = profileAfter(['sunny-start']);
    manager.setUseBonuses('scenario', false);
    const off = buildLoadout(sunny, 'scenario', manager.snapshot(), [], []);
    expect(off.bonusLine).toBe('Permanent bonuses are off for Scenario parks · change in Collection');
    expect(off.appliedBonusIds).toEqual([]);
    expect(off.startingCash).toBe(buildLoadout(sunny, 'scenario', profileAfter([]).snapshot, [], []).startingCash);
  });

  it('Sandbox default is off (no line when nothing applies there) and The Map uses the fallback pool it is given', () => {
    const snapshot = profileAfter(['sunny-start']).snapshot;
    expect(snapshot.useBonuses.sandbox).toBe(false);
    const map = buildLoadout(sunny, 'run', snapshot, [], ['bonus-card' as never]);
    expect(map.poolCardIds).toEqual(['bonus-card']);
    expect(map.bonusLine).toMatch(/^Permanent bonuses \(The Map\): Nest egg/);
  });

  it('puts card modifiers into the effective rules', () => {
    const snapshot = profileAfter([]).snapshot;
    const none = buildLoadout(sunny, 'scenario', snapshot, [], []);
    const withCard = buildLoadout(sunny, 'scenario', snapshot, [STARTING_CARD_IDS[0]], []);
    expect(withCard.effective.length).toBeGreaterThanOrEqual(none.effective.length);
  });

  it('formats every bonus effect shortly', () => {
    for (const bonus of BONUSES) expect(bonusEffectShort(bonus), bonus.id).toMatch(/^[+−]\$?\d+(%| RP| slot)?$/);
    expect(bonusEffectShort(BONUSES.find((bonus) => bonus.id === 'builders-discount')!)).toBe('−3%');
  });
});

describe('Scenario loadout: stage cards only, slot cost counted (Phase 25)', () => {
  const owning = (ids: readonly string[]) => ({ ...profileAfter([]).snapshot, collectionCardIds: [...ids] as never[] });

  it('the pool leaves one-shots out (they are played on The Map) and says so', () => {
    const model = buildLoadout(sunny, 'scenario', owning(['grand-opening', 'coach-party', 'master-builders', 'bridging-loan']), [], []);
    expect(model.poolCardIds).toEqual(['grand-opening', 'master-builders']);
    expect(model.oneShotNote).toBe(ONE_SHOTS_ON_THE_MAP);
    expect(ONE_SHOTS_ON_THE_MAP).toBe('One-shot cards are played on The Map.');
    expect(buildLoadout(sunny, 'scenario', profileAfter([]).snapshot, [], []).oneShotNote).toBeNull();
    const all = buildLoadout(sunny, 'scenario', owning(PULSE_CARDS.map((card) => card.id)), [], []);
    expect(all.poolCardIds).toEqual(PULSE_CARDS.filter((card) => card.kind === 'stage').map((card) => card.id));
  });

  it('a selected one-shot changes nothing, and the slots used count a rare twice', () => {
    const profile = owning(['grand-opening', 'master-builders']);
    const plain = buildLoadout(sunny, 'scenario', profile, [], []);
    expect(buildLoadout(sunny, 'scenario', profile, ['coach-party'], []).effective).toEqual(plain.effective);
    expect(buildLoadout(sunny, 'scenario', profile, ['coach-party'], []).slotsUsed).toBe(0);
    expect(buildLoadout(sunny, 'scenario', profile, ['master-builders'], []).slotsUsed).toBe(2);
    expect(buildLoadout(sunny, 'scenario', profile, ['grand-opening', 'master-builders'], []).slotsUsed).toBe(3);
  });

  it('the store adds a card only when its slot cost fits', () => {
    const reset = (): void => useUiStore.setState({ loadoutCardIds: [] });
    reset();
    const { toggleLoadoutCard } = useUiStore.getState();
    toggleLoadoutCard('grand-opening', 2);
    toggleLoadoutCard('master-builders', 2);
    expect(useUiStore.getState().loadoutCardIds).toEqual(['grand-opening']);
    toggleLoadoutCard('velvet-ropes', 2);
    expect(useUiStore.getState().loadoutCardIds).toEqual(['grand-opening', 'velvet-ropes']);
    toggleLoadoutCard('grand-opening', 2);
    toggleLoadoutCard('velvet-ropes', 2);
    toggleLoadoutCard('master-builders', 2);
    expect(useUiStore.getState().loadoutCardIds).toEqual(['master-builders']);
    toggleLoadoutCard('master-builders', 1);
    toggleLoadoutCard('master-builders', 1);
    expect(useUiStore.getState().loadoutCardIds).toEqual([]);
    reset();
  });
});

