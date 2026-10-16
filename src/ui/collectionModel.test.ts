import { describe, expect, it } from 'vitest';
import { PULSE_CARDS, STARTING_CARD_IDS } from '../game/cards/content';
import { BONUSES } from '../game/profile/bonuses';
import { PROFILE_GATED_IDS } from '../game/profile/unlocks';
import { SCENARIOS } from '../game/scenarios/content';
import { CARD_FAMILIES } from '../game/cards/types';
import { COLLECTION_TABS, buildCollection, moveCollectionTab, PERSISTENCE_NOTE } from './collectionModel';
import { CARD_FAMILY_LABELS } from './runCopy';
import { profileAfter } from './profileTestSupport';

describe('collection model', () => {
  it('lists the four gated buildings, all locked with their unlock condition, for a fresh profile', () => {
    const model = buildCollection(profileAfter([]).snapshot);
    expect(model.buildings.map((row) => row.id)).toEqual([...PROFILE_GATED_IDS]);
    expect(PROFILE_GATED_IDS.length).toBeGreaterThanOrEqual(3);
    for (const row of model.buildings) {
      expect(row.unlocked).toBe(false);
      expect(row.detail).toMatch(/^Clear .+ to unlock$/);
      expect(row.label).toContain('locked: Clear ');
    }
    expect(model.buildingsSummary).toBe(`0 of ${PROFILE_GATED_IDS.length} unlocked`);
    expect(model.buildingsNote).toBe('Unlocked buildings are in every new park, in every mode.');
  });

  it('shows an unlocked building with its source scenario', () => {
    const model = buildCollection(profileAfter(['sunny-start', 'boardwalk-breeze']).snapshot);
    const tiki = model.buildings.find((row) => row.id === 'tiki-tumbler')!;
    expect(tiki).toMatchObject({ unlocked: true, name: 'Tiki Tumbler', kind: 'Ride', detail: 'Ride · from Boardwalk Breeze' });
    expect(tiki.label).toBe('Tiki Tumbler, ride, unlocked');
    expect(model.buildingsSummary).toBe(`1 of ${PROFILE_GATED_IDS.length} unlocked`);
  });

  it('hides undiscovered cards and shows owned ones with both consequences', () => {
    const model = buildCollection(profileAfter([]).snapshot);
    expect(model.cards).toHaveLength(PULSE_CARDS.length);
    const owned = model.cards.filter((card) => card.owned);
    expect(owned.map((card) => card.id).sort()).toEqual([...STARTING_CARD_IDS].sort());
    for (const card of owned) {
      expect(card.upside).not.toBeNull();
      expect(card.downside).not.toBeNull();
    }
    for (const card of model.cards.filter((candidate) => !candidate.owned)) {
      expect(card).toMatchObject({ name: '???', upside: null, downside: null });
    }
    expect(model.cardsNote).toBe('Clear scenarios or win a run on The Map to discover more cards.');
  });

  it('lists every bonus: earned with its source, unearned with the scenario to clear', () => {
    const model = buildCollection(profileAfter(['sunny-start']).snapshot);
    expect(model.bonuses.map((row) => row.id)).toEqual(BONUSES.map((bonus) => bonus.id));
    expect(model.bonuses.find((row) => row.id === 'nest-egg')).toMatchObject({ earned: true, detail: 'from Sunny Start' });
    const other = model.bonuses.find((row) => row.id === 'research-grant')!;
    expect(other.earned).toBe(false);
    expect(other.detail).toBe('Clear Penny Lane to earn it');
    expect(model.bonusesSummary).toBe(`1 of ${BONUSES.length} earned`);
  });

  it('puts the three bonus switches in menu order with the designed defaults', () => {
    const model = buildCollection(profileAfter([]).snapshot);
    expect(model.bonusSwitches).toEqual([
      { mode: 'run', label: 'The Map', checked: true },
      { mode: 'scenario', label: 'Scenario', checked: true },
      { mode: 'sandbox', label: 'Sandbox', checked: false },
    ]);
    expect(model.bonusNote).toBe('A change applies to parks you start afterwards. Bonuses are never lost.');
    expect(buildCollection(null).bonusSwitches.map((row) => row.checked)).toEqual([true, true, false]);
  });

  it('follows a switch change in the profile', () => {
    const { manager } = profileAfter([]);
    manager.setUseBonuses('sandbox', true);
    manager.setUseBonuses('run', false);
    expect(buildCollection(manager.snapshot()).bonusSwitches.map((row) => row.checked)).toEqual([false, true, true]);
  });

  it('counts parks per mode', () => {
    const { manager } = profileAfter([]);
    manager.recordParkStarted('scenario');
    manager.recordParkStarted('scenario');
    const rows = buildCollection(manager.snapshot()).stats;
    expect(rows.map((row) => row.label)).toEqual(['The Map', 'Scenario', 'Sandbox']);
    expect(rows.find((row) => row.mode === 'scenario')).toMatchObject({ parksStarted: 2, wins: 0, losses: 0 });
  });

  it('says when progress cannot be kept, and only then', () => {
    const snapshot = profileAfter([]).snapshot;
    expect(buildCollection(snapshot).persistenceNote).toBeNull();
    expect(buildCollection({ ...snapshot, persistence: 'unavailable' }).persistenceNote).toBe(PERSISTENCE_NOTE.unavailable);
    expect(buildCollection({ ...snapshot, persistence: 'read-only' }).persistenceNote).toBe(PERSISTENCE_NOTE['read-only']);
    expect(PERSISTENCE_NOTE.unavailable).toBe('Progress is not saved in this browser (storage is blocked or full).');
  });

  it('every scenario that grants something is findable in the collection (rewards and collection agree)', () => {
    const everything = buildCollection(profileAfter(SCENARIOS.map((definition) => definition.id)).snapshot);
    expect(everything.buildings.every((row) => row.unlocked)).toBe(true);
    expect(everything.bonuses.every((row) => row.earned)).toBe(true);
  });
});

describe('collection tabs', () => {
  it('has the four tabs and moves like an automatic-activation tablist', () => {
    expect(COLLECTION_TABS.map((tab) => tab.label)).toEqual(['Buildings', 'Pulse Cards', 'Bonuses', 'Stats']);
    expect(moveCollectionTab('buildings', 'ArrowRight')).toBe('cards');
    expect(moveCollectionTab('stats', 'ArrowRight')).toBe('buildings');
    expect(moveCollectionTab('buildings', 'ArrowLeft')).toBe('stats');
    expect(moveCollectionTab('cards', 'Home')).toBe('buildings');
    expect(moveCollectionTab('cards', 'End')).toBe('stats');
    for (const key of ['Enter', ' ', 'Tab', 'x']) expect(moveCollectionTab('cards', key)).toBeNull();
  });
});

describe('run stats in the Collection (Phase 23)', () => {
  it('start at zero for every difficulty, with the run length in the best-run text', () => {
    const model = buildCollection(profileAfter([]).snapshot);
    expect(model.runs.started).toBe(0);
    expect(model.runs.rows.map((row) => row.difficulty)).toEqual(['relaxed', 'standard', 'tough']);
    expect(model.runs.rows.map((row) => row.best)).toEqual(['0/5', '0/5', '0/5']);
    expect(model.runs.rows.every((row) => row.victories === 0 && row.losses === 0)).toBe(true);
  });

  it('follow the profile: a started run, a loss at level 3 and a Standard victory', () => {
    const { manager } = profileAfter([]);
    manager.recordRunStarted('standard');
    manager.recordRunResult({ runKey: 'a', difficulty: 'relaxed', outcome: 'lost', levelsCleared: 2, deckCardIds: [] }, true);
    manager.recordRunResult({ runKey: 'b', difficulty: 'standard', outcome: 'won', levelsCleared: 5, deckCardIds: [] }, true);
    const model = buildCollection(manager.snapshot());
    expect(model.runs.started).toBe(1);
    expect(model.runs.rows.find((row) => row.difficulty === 'relaxed')).toMatchObject({ best: '2/5', victories: 0, losses: 1 });
    expect(model.runs.rows.find((row) => row.difficulty === 'standard')).toMatchObject({ best: '5/5', victories: 1, losses: 0 });
  });

  it('a missing profile reads as zeros and the cards note names the run reward', () => {
    expect(buildCollection(null).runs.rows.every((row) => row.best === '0/5')).toBe(true);
    expect(buildCollection(profileAfter([]).snapshot).cardsNote).toBe('Clear scenarios or win a run on The Map to discover more cards.');
  });
});

describe('collection: cards grouped by family (Phase 25)', () => {
  it('lists all 48 cards once, grouped by family in the pool order, each group counted', () => {
    const model = buildCollection(profileAfter([]).snapshot);
    expect(PULSE_CARDS).toHaveLength(48);
    expect(model.cards).toHaveLength(48);
    expect(model.cardFamilies.map((group) => group.family)).toEqual([...CARD_FAMILIES]);
    expect(model.cardFamilies.flatMap((group) => group.cards.map((card) => card.id)).sort()).toEqual(PULSE_CARDS.map((card) => card.id).sort());
    for (const group of model.cardFamilies) {
      expect(group.label).toBe(CARD_FAMILY_LABELS[group.family]);
      expect(group.cards.every((card) => card.family === group.family)).toBe(true);
      expect(group.summary).toBe(`${group.cards.filter((card) => card.owned).length} of ${group.cards.length} discovered`);
    }
    expect(model.cardFamilies.find((group) => group.family === 'day-night')?.label).toBe('Day and night');
  });

  it('an undiscovered card keeps ??? and shows its family and rarity, never its kind or numbers', () => {
    const model = buildCollection(profileAfter([]).snapshot);
    const rare = model.cards.find((card) => card.id === 'master-builders');
    expect(rare).toMatchObject({ owned: false, name: '???', family: 'build', rarity: 'rare', kind: null, upside: null, undiscoveredLine: 'Undiscovered · Rare' });
    expect(model.cards.find((card) => card.id === 'coach-party')).toMatchObject({ owned: false, kind: null, undiscoveredLine: 'Undiscovered · Common' });
    const owned = model.cards.find((card) => card.id === 'grand-opening');
    expect(owned).toMatchObject({ owned: true, kind: 'stage', rarity: 'common', slotCost: 1, undiscoveredLine: null });
  });
});

