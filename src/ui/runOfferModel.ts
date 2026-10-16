import { CARD_BY_ID } from '../game/cards/content';
import { cardBiomeInteraction } from '../game/cards/interaction';
import type { CardKind, CardRarity, EffectAxis, PulseCardDefinition, PulseCardId } from '../game/cards/types';
import { effectVectorOf, upsideAxesOf } from '../game/cards/vector';
import { GAME_CONFIG } from '../game/config';
import type { RunSnapshot } from '../game/run/types';
import { cardCountText, slotText } from './runCopy';

/** The offer view as pure data: the offered cards, what the deck becomes and what Add to deck needs. */

export interface OfferCard {
  cardId: PulseCardId;
  icon: string;
  name: string;
  tagline: string;
  upside: string;
  downside: string;
  kind: CardKind;
  rarity: CardRarity;
  slotCost: 1 | 2;
  /** Explain it (design 5.3): where the card does nothing, what it waits for, what it costs in slots. */
  notes: string[];
  /** How many copies the deck already holds. */
  inDeck: number;
}

/** "21:30": when night starts (the night arrivals of a night card count only from then). */
const clockOfHour = (hour: number): string => `${Math.floor(hour)}:${String(Math.round((hour % 1) * 60)).padStart(2, '0')}`;
export const NIGHT_START_TEXT = clockOfHour(GAME_CONFIG.calendar.phaseHours.nightStart);

const NIGHT_AXES: ReadonlySet<EffectAxis> = new Set<EffectAxis>(['nightArrivalMultiplier']);
const COASTER_AXES: ReadonlySet<EffectAxis> = new Set<EffectAxis>(['chainLiftCostMultiplier']);

/** "levels 4 and 5", "level 4". */
const levelsText = (numbers: readonly number[]): string => (
  numbers.length === 1 ? `level ${numbers[0]}` : `levels ${numbers.slice(0, -1).join(', ')} and ${numbers[numbers.length - 1]}`
);

/**
 * The notes of an offered card. A card dead in every remaining biome is never offered (the plan's rule), so the dead
 * note is always about some of the road. The night and coaster notes say "only" when every upside of the card waits on
 * it, and say which part waits otherwise.
 */
export const offerNotesOf = (card: PulseCardDefinition, run: Pick<RunSnapshot, 'levels' | 'levelIndex'>): string[] => {
  const notes: string[] = [];
  const dead = new Map<string, number[]>();
  for (const level of run.levels) {
    if (level.index < run.levelIndex || cardBiomeInteraction(card, level.biomeId) !== 'dead') continue;
    dead.set(level.biomeName, [...(dead.get(level.biomeName) ?? []), level.index + 1]);
  }
  for (const [biome, numbers] of dead) notes.push(`Does nothing in the ${biome} (${levelsText(numbers)})`);
  const upsides = upsideAxesOf(effectVectorOf(card));
  const waitsOn = (axes: ReadonlySet<EffectAxis>): 'all' | 'some' | 'none' => {
    const hits = upsides.filter((axis) => axes.has(axis)).length;
    return hits === 0 ? 'none' : hits === upsides.length ? 'all' : 'some';
  };
  const coaster = card.tags.includes('coaster') ? waitsOn(COASTER_AXES) : 'none';
  if (coaster === 'all') notes.push('Only helps once you build a coaster');
  else if (coaster === 'some') notes.push('Saves more once you build a coaster');
  const night = card.tags.includes('night') ? waitsOn(NIGHT_AXES) : 'none';
  if (night === 'all') notes.push(`Only helps after ${NIGHT_START_TEXT}`);
  else if (night === 'some') notes.push(`The night part helps only after ${NIGHT_START_TEXT}`);
  if (card.slotCost > 1) notes.push(`Takes ${slotText(card.slotCost)}`);
  return notes;
};

/** The offer intro's line about one-shots (only when the offer holds one). */
export const ONE_SHOT_OFFER_LINE = GAME_CONFIG.run.unplayedOneShots === 'return'
  ? 'A one-shot is played from Park Pulse during a level; if you never play it, it comes back.'
  : 'A one-shot is played from Park Pulse during a level; if you never play it, it is used up anyway.';

export interface RunOfferModel {
  heading: string;
  intro: string;
  cards: OfferCard[];
  /** `all`: every card joins. `pick`: choose `pick` of them. */
  mode: 'all' | 'pick';
  pick: number;
  /** "Your deck will have 9 cards." (for `pick`, once the pick is complete). */
  deckAfter: string;
  actionLabel: string;
}

export const buildRunOffer = (run: RunSnapshot, picked: readonly string[] = []): RunOfferModel | null => {
  if (run.pendingOffer === null) return null;
  const countOf = (cardId: PulseCardId): number => run.deck.find((row) => row.cardId === cardId)?.count ?? 0;
  const cards: OfferCard[] = run.pendingOffer.flatMap((cardId) => {
    const card = CARD_BY_ID.get(cardId);
    return card === undefined ? [] : [{
      cardId, icon: card.icon, name: card.name, tagline: card.tagline, upside: card.upside, downside: card.downside,
      kind: card.kind, rarity: card.rarity, slotCost: card.slotCost, notes: offerNotesOf(card, run), inDeck: countOf(cardId),
    }];
  });
  const oneShotLine = cards.some((card) => card.kind === 'one-shot') ? ` ${ONE_SHOT_OFFER_LINE}` : '';
  const pick = run.offerRule.kind === 'pick' ? Math.min(run.offerRule.pick, cards.length) : cards.length;
  const mode = run.offerRule.kind === 'pick' ? 'pick' : 'all';
  const adding = mode === 'all' ? cards.length : Math.min(pick, picked.length);
  return {
    heading: `Before level ${run.levelIndex + 1}: new cards`,
    intro: (mode === 'all' ? 'These cards join your deck.' : `Pick ${pick} of ${cards.length}. The picked cards join your deck.`) + oneShotLine,
    cards,
    mode,
    pick,
    deckAfter: `Your deck will have ${cardCountText(run.deckSize + adding)}.`,
    actionLabel: mode === 'all' ? 'Add to deck' : picked.length === pick ? `Add ${cardCountText(pick)} to deck` : `Pick ${pick - picked.length} more`,
  };
};

/** Toggling a card in `pick` mode: never more than `pick`, never a card that is not offered. */
export const togglePick = (offer: RunOfferModel, picked: readonly string[], cardId: string): string[] => {
  if (!offer.cards.some((card) => card.cardId === cardId)) return [...picked];
  if (picked.includes(cardId)) return picked.filter((id) => id !== cardId);
  if (picked.length >= offer.pick) return [...picked];
  return [...picked, cardId];
};

/** Whether Add to deck may be pressed: `all` always; `pick` exactly `pick` distinct offered cards. */
export const canAcceptOffer = (offer: RunOfferModel, picked: readonly string[]): boolean => {
  if (offer.mode === 'all') return offer.cards.length > 0;
  return picked.length === offer.pick && new Set(picked).size === picked.length && picked.every((id) => offer.cards.some((card) => card.cardId === id));
};

/** What the bridge receives: `all` sends nothing (the run model adds the whole offer), `pick` sends the picked ids. */
export const offerPayload = (offer: RunOfferModel, picked: readonly string[]): readonly string[] | undefined => (
  offer.mode === 'all' ? undefined : [...picked]
);
