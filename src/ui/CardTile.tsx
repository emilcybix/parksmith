import type { ReactNode } from 'react';
import type { CardKind, CardRarity } from '../game/cards/types';
import { cardBadgeLabels } from './runCopy';

/**
 * The one Pulse Card tile (Phase 25, design 10.1): the offer, the loadout, the drawers, the Collection and (wave 3) the
 * Scenario loadout, the reward draft and the park's active cards all draw a card with these pieces, so a card reads the
 * same everywhere. The pinned hooks stay: `pulse-card-head`, the `aria-hidden` icon, the `<strong>` name, `b.run-count`
 * "×n", the sr-only "Upside: " / "Downside: " prefixes, and whatever `data-*` attribute the caller passes. Badges are
 * text ("One-shot", "Uncommon", "Rare · 2 slots"), never colour alone. Everything inside is phrasing content, so a tile
 * may be a `<button>`.
 */

export interface CardTileCard {
  icon: string;
  name: string;
  tagline?: string | null;
  /** Both are needed for the facts; the used pile, which shows no facts, may leave them out. */
  upside?: string;
  downside?: string;
  /** Optional so an older snapshot still draws: missing reads as a common stage card (no badge). */
  kind?: CardKind;
  rarity?: CardRarity;
  slotCost?: number;
}

/** The text badges of a card; nothing for a common stage card. */
export const CardBadges = ({ card }: { card: Pick<CardTileCard, 'kind' | 'rarity' | 'slotCost'> }): React.JSX.Element | null => {
  const labels = cardBadgeLabels(card);
  if (labels.length === 0) return null;
  return (
    <span className="card-badges">
      {labels.map((label) => <span key={label} className="card-badge">{label}</span>)}
    </span>
  );
};

/** The tagline (when given), the upside and the downside. */
export const CardFacts = ({ card }: { card: { tagline?: string | null; upside: string; downside: string } }): React.JSX.Element => (
  <>
    {card.tagline !== undefined && card.tagline !== null && card.tagline !== '' && <small>{card.tagline}</small>}
    <em className="card-upside"><span aria-hidden="true">▲</span><span className="sr-only">Upside: </span> {card.upside}</em>
    <em className="card-downside"><span aria-hidden="true">▼</span><span className="sr-only">Downside: </span> {card.downside}</em>
  </>
);

/** The icon, the name and an optional "×n" count. */
export const CardHead = ({ card, count }: { card: Pick<CardTileCard, 'icon' | 'name'>; count?: number }): React.JSX.Element => (
  <span className="pulse-card-head">
    <span aria-hidden="true">{card.icon}</span> <strong>{card.name}</strong>
    {count !== undefined && <> <b className="run-count">×{count}</b></>}
  </span>
);

/** Short explanations under the facts ("Takes 2 slots", "Needs 2 free slots"). */
export const CardNotes = ({ notes }: { notes: readonly string[] }): React.JSX.Element | null => (
  notes.length === 0 ? null : (
    <span className="card-notes">
      {notes.map((note) => <span key={note} className="card-note">{note}</span>)}
    </span>
  )
);

type DataAttributes = Record<`data-${string}`, string | undefined>;

interface CardTileProps {
  card: CardTileCard;
  /** The element: a static `article` (default), a toggle `button`, or a list item. */
  as?: 'article' | 'button' | 'li' | 'div';
  /** The whole class list (default `pulse-card-tile`; '' for none). */
  className?: string;
  count?: number;
  notes?: readonly string[];
  /** Hide the upside and downside (the used pile names the card and where it went). */
  facts?: boolean;
  /** Buttons only. */
  pressed?: boolean;
  /** Buttons only: `aria-disabled` (stays focusable); the click is not passed on. */
  disabled?: boolean;
  onClick?: () => void;
  data?: DataAttributes;
  children?: ReactNode;
}

export const CardTile = ({
  card, as = 'article', className = 'pulse-card-tile', count, notes = [], facts = true, pressed, disabled, onClick, data = {}, children,
}: CardTileProps): React.JSX.Element => {
  const body = (
    <>
      <CardHead card={card} count={count} />
      <CardBadges card={card} />
      {facts && card.upside !== undefined && card.downside !== undefined && <CardFacts card={{ tagline: card.tagline, upside: card.upside, downside: card.downside }} />}
      <CardNotes notes={notes} />
      {children}
    </>
  );
  if (as === 'button') {
    return (
      <button
        type="button"
        className={className === '' ? undefined : className}
        aria-pressed={pressed}
        aria-disabled={disabled}
        onClick={() => { if (disabled !== true) onClick?.(); }}
        {...data}
      >
        {body}
      </button>
    );
  }
  const Element = as;
  return <Element className={className === '' ? undefined : className} {...data}>{body}</Element>;
};
