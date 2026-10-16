import type { CardModifiableRule, CardModifiers } from '../scenarios/rules';
import type { PULSE_CARD_TABLE } from './table';

/**
 * Phase 25 card model. A Pulse Card is pure data (src/game/cards/table.ts): a `stage` card is a set of run-scoped rule
 * multipliers compiled once when a park starts; a `one-shot` card is played once from the stage HUD and calls owner
 * methods (effects.ts). Every card carries at least one player-positive and one player-negative axis (verified against
 * MULTIPLIER_DIRECTION and the authored one-shot vectors) - cards change decisions, they are never raw upgrades.
 */

/** Derived from the table: adding a row adds an id, a typo in a lookup is a compile error. */
export type PulseCardId = (typeof PULSE_CARD_TABLE)[number]['id'];

export type CardKind = 'stage' | 'one-shot';
export type CardRarity = 'common' | 'uncommon' | 'rare';
export type CardFamily = 'weather' | 'day-night' | 'arrivals' | 'staff' | 'rides' | 'economy' | 'scenery' | 'build';
/**
 * Declared interactions and synergy labels. Only `wet` and `night` have an interaction rule (interaction.ts); a test
 * requires every tag to touch its axis and every axis to carry its tag.
 */
export type CardTag = 'wet' | 'weather' | 'night' | 'crowd' | 'litter' | 'repair' | 'coaster' | 'scenery' | 'cash' | 'research';

export const CARD_KINDS: readonly CardKind[] = ['stage', 'one-shot'];
export const CARD_RARITIES: readonly CardRarity[] = ['common', 'uncommon', 'rare'];
export const CARD_FAMILIES: readonly CardFamily[] = ['weather', 'day-night', 'arrivals', 'staff', 'rides', 'economy', 'scenery', 'build'];

export type OneShotEffect =
  /** Grant `amount` now ('grant'); `repay` taken back `afterSeconds` later ('other'). */
  | { kind: 'loan'; amount: number; repay: number; afterSeconds: number }
  /** `points` research points now; `fee` paid now ('research'). */
  | { kind: 'research'; points: number; fee: number }
  /** Repair every broken ride (or service every idle ride); `perRide` in 'maintenance', now (`null`) or later. */
  | { kind: 'repair'; scope: 'broken' | 'all'; perRide: number; afterSeconds: number | null }
  /** Clear every litter pile and empty every bin; `fee` now ('staff-salaries'). */
  | { kind: 'sweep'; fee: number }
  /** The next `slots` weather slots turn `weather` at `intensity`; `fee` now ('other'). */
  | { kind: 'forecast'; weather: 'sunny'; slots: number; intensity: number; fee: number }
  /** `guests` arrive at once; `bill` due `afterSeconds` later ('other'). */
  | { kind: 'surge'; guests: number; bill: number; afterSeconds: number }
  /** Every guest's happiness moves by `happiness` (may be negative); `fee` now, negative = cash in ('grant'). */
  | { kind: 'cheer'; happiness: number; fee: number };

export type OneShotEffectKind = OneShotEffect['kind'];

export type OneShotAxis = 'cashNow' | 'cashLater' | 'research' | 'repair' | 'condition' | 'queues'
  | 'litter' | 'forecast' | 'visitors' | 'spirits';
export const ONE_SHOT_AXES: readonly OneShotAxis[] = [
  'cashNow', 'cashLater', 'research', 'repair', 'condition', 'queues', 'litter', 'forecast', 'visitors', 'spirits',
];
/**
 * A one-shot's authored effect vector (positive = good for the player): cash in thousands of dollars, research in tens
 * of RP, visitors in tens of guests, spirits in tens of happiness points, the booleans as +1 (`queues` -1). A test
 * cross-checks it against the effect numbers.
 */
export type OneShotVector = Partial<Record<OneShotAxis, number>>;

/** Every axis an effect vector may carry: the card-modifiable rules (stage cards, derived) and the one-shot axes. */
export type EffectAxis = CardModifiableRule | OneShotAxis;
export type EffectVector = Partial<Record<EffectAxis, number>>;

interface CardRowBase {
  id: string;
  name: string;
  icon: string;
  tagline: string;
  family: CardFamily;
  rarity: CardRarity;
  tags: readonly CardTag[];
}

/** One row of the table: data only. Copy and slot cost are derived (content.ts). */
export type PulseCardRow =
  | (CardRowBase & { kind: 'stage'; modifiers: CardModifiers })
  | (CardRowBase & { kind: 'one-shot'; effect: OneShotEffect; vector: OneShotVector });

export type StageCardRow = Extract<PulseCardRow, { kind: 'stage' }>;
export type OneShotCardRow = Extract<PulseCardRow, { kind: 'one-shot' }>;

/**
 * What the game reads. Both kinds carry `modifiers` (`{}` for a one-shot, so the session compile and rewardEligible need
 * no branch) and generated copy.
 */
export type PulseCardDefinition = (PulseCardRow & { id: PulseCardId }) & {
  modifiers: CardModifiers;
  upside: string;
  downside: string;
  slotCost: 1 | 2;
};

export type StageCardDefinition = Extract<PulseCardDefinition, { kind: 'stage' }>;
export type OneShotCardDefinition = Extract<PulseCardDefinition, { kind: 'one-shot' }>;

/** What the UI needs to show an active card during a park (ParkSession.cardsSnapshot(), read every 250 ms). */
export interface ActiveCardSnapshot {
  id: PulseCardId;
  name: string;
  icon: string;
  upside: string;
  downside: string;
  /* Phase 25 fields (filled by ParkSession.cardsSnapshot). */
  kind: CardKind;
  rarity: CardRarity;
  slotCost: 1 | 2;
  /** 'stage' for a stage card; a one-shot is 'ready' until played, then 'played'. */
  playState: 'stage' | 'ready' | 'played';
  playedAtSeconds: number | null;
  /** One-shots only: canPlay now, and why not ("No ride is broken", "Not enough cash ($600)", "The level is over"). */
  playable: boolean;
  hint: string | null;
  /** One-shots only: a scheduled cost not yet applied. */
  pending: { amount: number; dueInSeconds: number; label: string } | null;
}
