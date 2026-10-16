import { describe, expect, it } from 'vitest';
import type { RunSnapshot } from '../game/run';
import { CARD_BY_ID, PULSE_CARDS } from '../game/cards/content';
import { buildRunOffer, canAcceptOffer, NIGHT_START_TEXT, offerNotesOf, offerPayload, ONE_SHOT_OFFER_LINE, togglePick } from './runOfferModel';
import { snapshotAt } from './runTestSupport';

const withRule = (run: RunSnapshot, rule: RunSnapshot['offerRule']): RunSnapshot => ({ ...run, offerRule: rule });

describe('run offer model', () => {
  it('shows the offered cards with upside and downside and what the deck becomes', () => {
    const run = snapshotAt(2, 'offer');
    const offer = buildRunOffer(run);
    expect(offer).not.toBeNull();
    expect(offer?.heading).toBe('Before level 3: new cards');
    expect(offer?.intro.startsWith('These cards join your deck.')).toBe(true);
    expect(offer?.intro.includes(ONE_SHOT_OFFER_LINE)).toBe(offer?.cards.some((card) => card.kind === 'one-shot'));
    expect(offer?.cards.map((card) => card.cardId)).toEqual(run.pendingOffer);
    for (const card of offer?.cards ?? []) {
      expect(card.upside.length).toBeGreaterThan(0);
      expect(card.downside.length).toBeGreaterThan(0);
    }
    expect(offer?.deckAfter).toBe(`Your deck will have ${run.deckSize + (run.pendingOffer?.length ?? 0)} cards.`);
    expect(offer?.mode).toBe('all');
    expect(offer?.actionLabel).toBe('Add to deck');
  });

  it('counts the copies the deck already holds', () => {
    const run = snapshotAt(2, 'offer');
    const offer = buildRunOffer(run);
    for (const card of offer?.cards ?? []) expect(card.inDeck).toBe(run.deck.find((row) => row.cardId === card.cardId)?.count ?? 0);
  });

  it('has no offer outside the offer phase', () => {
    expect(buildRunOffer(snapshotAt(2, 'loadout'))).toBeNull();
    expect(buildRunOffer(snapshotAt(2, 'stage'))).toBeNull();
    expect(buildRunOffer(snapshotAt(0, 'won'))).toBeNull();
  });

  it('all: always acceptable, nothing sent', () => {
    const offer = buildRunOffer(snapshotAt(1, 'offer'));
    expect(offer).not.toBeNull();
    if (offer === null) return;
    expect(canAcceptOffer(offer, [])).toBe(true);
    expect(offerPayload(offer, ['x'])).toBeUndefined();
  });

  it('pick N of M: needs exactly N distinct offered cards and sends them', () => {
    const run = withRule(snapshotAt(1, 'offer'), { kind: 'pick', pick: 1 });
    const offer = buildRunOffer(run, []);
    expect(offer?.mode).toBe('pick');
    expect(offer?.pick).toBe(1);
    expect(offer?.intro).toBe('Pick 1 of 2. The picked cards join your deck.');
    if (offer === null) return;
    const [first, second] = offer.cards.map((card) => card.cardId);
    expect(canAcceptOffer(offer, [])).toBe(false);
    expect(canAcceptOffer(offer, [first])).toBe(true);
    expect(canAcceptOffer(offer, [first, second])).toBe(false);
    expect(canAcceptOffer(offer, ['not-offered'])).toBe(false);
    expect(canAcceptOffer(offer, [first, first])).toBe(false);
    expect(offerPayload(offer, [second])).toEqual([second]);
    expect(buildRunOffer(run, [first])?.deckAfter).toBe(`Your deck will have ${run.deckSize + 1} cards.`);
    expect(buildRunOffer(run, [first])?.actionLabel).toBe('Add 1 card to deck');
    expect(buildRunOffer(run, [])?.actionLabel).toBe('Pick 1 more');
  });

  it('toggling picks never exceeds N and never takes a card that is not offered', () => {
    const run = withRule(snapshotAt(1, 'offer'), { kind: 'pick', pick: 1 });
    const offer = buildRunOffer(run);
    if (offer === null) return;
    const [first, second] = offer.cards.map((card) => card.cardId);
    expect(togglePick(offer, [], first)).toEqual([first]);
    expect(togglePick(offer, [first], first)).toEqual([]);
    expect(togglePick(offer, [first], second)).toEqual([first]);
    expect(togglePick(offer, [], 'velvet-ropes-or-not')).toEqual([]);
  });

  it('a pick rule larger than the offer is capped at the offer', () => {
    const offer = buildRunOffer(withRule(snapshotAt(1, 'offer'), { kind: 'pick', pick: 9 }));
    expect(offer?.pick).toBe(offer?.cards.length);
  });
});

describe('run offer: badges and notes (Phase 25)', () => {
  const card = (id: string) => {
    const found = CARD_BY_ID.get(id as never);
    if (found === undefined) throw new Error(id);
    return found;
  };
  /** The offer phase of level 1 with every level in the Meadow, except the given ones in the Desert Canyon. */
  const roadWithDesertAt = (desert: readonly number[]): RunSnapshot => {
    const run = snapshotAt(0, 'offer');
    return {
      ...run,
      levels: run.levels.map((level) => (desert.includes(level.index)
        ? { ...level, biomeId: 'desert-canyon', biomeName: 'Desert Canyon' }
        : { ...level, biomeId: 'meadow', biomeName: 'Meadow' })),
    };
  };

  it('every offered card carries its kind, rarity and slot cost from the pool', () => {
    const run = snapshotAt(2, 'offer');
    for (const offered of buildRunOffer(run)?.cards ?? []) {
      expect(offered).toMatchObject({ kind: card(offered.cardId).kind, rarity: card(offered.cardId).rarity, slotCost: card(offered.cardId).slotCost });
    }
  });

  it('says where a wet-weather card does nothing on the road ahead, never about a level already played', () => {
    expect(offerNotesOf(card('dry-spell'), roadWithDesertAt([3, 4]))).toContain('Does nothing in the Desert Canyon (levels 4 and 5)');
    expect(offerNotesOf(card('dry-spell'), roadWithDesertAt([2]))).toContain('Does nothing in the Desert Canyon (level 3)');
    expect(offerNotesOf(card('dry-spell'), { ...roadWithDesertAt([0]), levelIndex: 1 })).toEqual([]);
    expect(offerNotesOf(card('grand-opening'), roadWithDesertAt([0, 1, 2]))).toEqual([]);
  });

  it('names what a coaster or night card waits for, and the second slot of a rare', () => {
    const road = roadWithDesertAt([]);
    expect(offerNotesOf(card('chain-gang'), road)).toEqual(['Only helps once you build a coaster']);
    expect(offerNotesOf(card('master-builders'), road)).toEqual(['Saves more once you build a coaster', 'Takes 2 slots']);
    expect(NIGHT_START_TEXT).toBe('21:30');
    expect(offerNotesOf(card('night-market'), road)).toEqual(['Only helps after 21:30']);
    expect(offerNotesOf(card('lamplighters'), road)).toEqual(['The night part helps only after 21:30']);
    expect(offerNotesOf(card('weather-station'), road)).toEqual(['Takes 2 slots']);
    for (const pooled of PULSE_CARDS.filter((entry) => entry.rarity === 'rare')) expect(offerNotesOf(pooled, road)).toContain('Takes 2 slots');
  });

  it('the intro explains one-shots only when one is offered, and the offered card gets its notes', () => {
    const base = roadWithDesertAt([3]);
    const withOneShot = buildRunOffer({ ...base, pendingOffer: ['coach-party', 'dry-spell'] as never });
    expect(withOneShot?.intro).toBe(`These cards join your deck. ${ONE_SHOT_OFFER_LINE}`);
    expect(ONE_SHOT_OFFER_LINE).toBe('A one-shot is played from Park Pulse during a level; if you never play it, it comes back.');
    expect(withOneShot?.cards.find((offered) => offered.cardId === 'dry-spell')?.notes).toEqual(['Does nothing in the Desert Canyon (level 4)']);
    expect(withOneShot?.cards.find((offered) => offered.cardId === 'coach-party')?.kind).toBe('one-shot');
    expect(buildRunOffer({ ...base, pendingOffer: ['grand-opening', 'velvet-ropes'] as never })?.intro).toBe('These cards join your deck.');
  });
});
