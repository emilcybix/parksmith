import { PULSE_CARDS } from '../game/cards/content';
import { CARD_FAMILIES, type CardFamily, type CardKind, type CardRarity, type PulseCardId } from '../game/cards/types';
import { GAME_CONFIG } from '../game/config';
import type { GameMode } from '../game/modes/types';
import { BONUSES } from '../game/profile/bonuses';
import { PROFILE_GATED_IDS } from '../game/profile/unlocks';
import type { ProfileSnapshot } from '../game/profile/types';
import { RUN_DIFFICULTIES, type RunDifficulty } from '../game/run/types';
import { MENU_MODE_ORDER, modeLabel } from './modeLabels';
import { CARD_FAMILY_LABELS, RARITY_LABELS, difficultyLabel } from './runCopy';
import { bonusSourceName, buildingIcon, buildingKind, buildingName, unlockSourceName } from './unlockCopy';

/**
 * The Collection screen as pure data (Phase 22): what the profile has unlocked, which cards were discovered, which
 * bonuses are earned (and the per-mode switch), and the per-mode stats. The component renders it.
 */

export type CollectionTabId = 'buildings' | 'cards' | 'bonuses' | 'stats';

export const COLLECTION_TABS: readonly { id: CollectionTabId; label: string }[] = [
  { id: 'buildings', label: 'Buildings' },
  { id: 'cards', label: 'Pulse Cards' },
  { id: 'bonuses', label: 'Bonuses' },
  { id: 'stats', label: 'Stats' },
];

export interface CollectionBuildingRow {
  id: string;
  name: string;
  kind: string;
  icon: string;
  unlocked: boolean;
  /** "Ride · from Boardwalk Breeze" or "Clear Canyon Caravan to unlock". */
  detail: string;
  /** The screen-reader sentence ("Tiki Tumbler, ride, unlocked" / "... locked: Clear X to unlock"). */
  label: string;
}

export interface CollectionCardRow {
  id: PulseCardId | string;
  owned: boolean;
  name: string;
  icon: string;
  upside: string | null;
  downside: string | null;
  tagline: string | null;
  /** Shown for every card, discovered or not (the group it sits in). */
  family: CardFamily;
  /** Shown for every card, discovered or not. */
  rarity: CardRarity;
  /** Null for an undiscovered card: what it does stays hidden. */
  kind: CardKind | null;
  slotCost: 1 | 2;
  /** The line under an undiscovered card's name: "Undiscovered · Uncommon". */
  undiscoveredLine: string | null;
}

/** One family of cards in the Collection (an `h3` per family inside the tabpanel). */
export interface CollectionCardFamily {
  family: CardFamily;
  label: string;
  cards: CollectionCardRow[];
  /** "2 of 7 discovered". */
  summary: string;
}

export interface CollectionBonusRow {
  id: string;
  name: string;
  icon: string;
  summary: string;
  earned: boolean;
  /** "from Sunny Start" or "Clear Starlight Finale to earn it". */
  detail: string;
}

export interface BonusSwitchRow {
  mode: GameMode;
  label: string;
  checked: boolean;
}

export interface StatsRow {
  mode: GameMode;
  label: string;
  parksStarted: number;
  wins: number;
  losses: number;
}

/** One difficulty of The Map: the best run in levels cleared, and how many runs were won and lost (Phase 23). */
export interface RunStatsRow {
  difficulty: RunDifficulty;
  label: string;
  /** "3/5": levels cleared in the best run, of the run's length. */
  best: string;
  victories: number;
  losses: number;
}

export interface CollectionModel {
  buildings: CollectionBuildingRow[];
  buildingsNote: string;
  buildingsSummary: string;
  cards: CollectionCardRow[];
  /** The same cards grouped by family, in the family order of the pool; an empty family is left out. */
  cardFamilies: CollectionCardFamily[];
  cardsNote: string;
  cardsSummary: string;
  bonuses: CollectionBonusRow[];
  bonusSwitches: BonusSwitchRow[];
  bonusNote: string;
  bonusesSummary: string;
  stats: StatsRow[];
  /** The runs on The Map: started, and the best / won / lost per difficulty. */
  runs: { started: number; rows: RunStatsRow[] };
  /** A line about storage, or null when progress is saved. */
  persistenceNote: string | null;
}

export const PERSISTENCE_NOTE: Readonly<Record<'unavailable' | 'read-only', string>> = {
  unavailable: 'Progress is not saved in this browser (storage is blocked or full).',
  'read-only': 'This profile was written by a newer Parksmith; progress made here will not be kept.',
};

export const buildCollection = (profile: ProfileSnapshot | null): CollectionModel => {
  const unlocked = new Set(profile?.unlockedBuildingIds ?? []);
  const owned = new Set<string>(profile?.collectionCardIds ?? []);
  const earned = new Set<string>(profile?.bonusIds ?? []);
  const buildings = PROFILE_GATED_IDS.map((id): CollectionBuildingRow => {
    const isUnlocked = unlocked.has(id);
    const source = unlockSourceName(id);
    const kind = buildingKind(id);
    const detail = isUnlocked
      ? `${kind}${source === null ? '' : ` · from ${source}`}`
      : source === null ? 'Unlock it by playing scenarios' : `Clear ${source} to unlock`;
    return {
      id,
      name: buildingName(id),
      kind,
      icon: buildingIcon(id),
      unlocked: isUnlocked,
      detail,
      label: `${buildingName(id)}, ${kind.toLowerCase()}, ${isUnlocked ? 'unlocked' : `locked: ${detail}`}`,
    };
  });
  const cards = PULSE_CARDS.map((card): CollectionCardRow => {
    const shared = { id: card.id, family: card.family, rarity: card.rarity, slotCost: card.slotCost };
    return owned.has(card.id)
      ? { ...shared, owned: true, name: card.name, icon: card.icon, upside: card.upside, downside: card.downside, tagline: card.tagline, kind: card.kind, undiscoveredLine: null }
      : { ...shared, owned: false, name: '???', icon: '❔', upside: null, downside: null, tagline: null, kind: null, undiscoveredLine: `Undiscovered · ${RARITY_LABELS[card.rarity]}` };
  });
  const cardFamilies = CARD_FAMILIES.flatMap((family): CollectionCardFamily[] => {
    const rows = cards.filter((card) => card.family === family);
    return rows.length === 0 ? [] : [{
      family,
      label: CARD_FAMILY_LABELS[family],
      cards: rows,
      summary: `${rows.filter((card) => card.owned).length} of ${rows.length} discovered`,
    }];
  });
  const bonuses = BONUSES.map((bonus): CollectionBonusRow => {
    const isEarned = earned.has(bonus.id);
    const source = bonusSourceName(bonus.id);
    return {
      id: bonus.id,
      name: bonus.name,
      icon: bonus.icon,
      summary: bonus.summary,
      earned: isEarned,
      detail: isEarned
        ? (source === null ? 'Earned' : `from ${source}`)
        : (source === null ? 'Not earned yet' : `Clear ${source} to earn it`),
    };
  });
  const persistence = profile?.persistence ?? 'ok';
  return {
    buildings,
    buildingsNote: 'Unlocked buildings are in every new park, in every mode.',
    buildingsSummary: `${buildings.filter((row) => row.unlocked).length} of ${buildings.length} unlocked`,
    cards,
    cardFamilies,
    cardsNote: cards.some((card) => !card.owned) ? 'Clear scenarios or win a run on The Map to discover more cards.' : 'Every card is discovered.',
    cardsSummary: `${cards.filter((card) => card.owned).length} of ${cards.length} discovered`,
    bonuses,
    bonusSwitches: MENU_MODE_ORDER.map((mode) => ({ mode, label: modeLabel(mode), checked: profile?.useBonuses[mode] ?? mode !== 'sandbox' })),
    bonusNote: 'A change applies to parks you start afterwards. Bonuses are never lost.',
    bonusesSummary: `${bonuses.filter((row) => row.earned).length} of ${bonuses.length} earned`,
    stats: MENU_MODE_ORDER.map((mode) => ({
      mode,
      label: modeLabel(mode),
      parksStarted: profile?.stats[mode].parksStarted ?? 0,
      wins: profile?.stats[mode].wins ?? 0,
      losses: profile?.stats[mode].losses ?? 0,
    })),
    runs: {
      started: profile?.runs.started ?? 0,
      rows: RUN_DIFFICULTIES.map((difficulty) => ({
        difficulty,
        label: difficultyLabel(difficulty),
        best: `${profile?.runs.bestLevel[difficulty] ?? 0}/${GAME_CONFIG.run.levelCount}`,
        victories: profile?.runs.victories[difficulty] ?? 0,
        losses: profile?.runs.losses[difficulty] ?? 0,
      })),
    },
    persistenceNote: persistence === 'ok' ? null : PERSISTENCE_NOTE[persistence],
  };
};

/** Tabs with automatic activation: arrows (and Home/End) move and select. Null when the key is not ours. */
export const moveCollectionTab = (current: CollectionTabId, key: string): CollectionTabId | null => {
  const ids = COLLECTION_TABS.map((tab) => tab.id);
  const index = ids.indexOf(current);
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return ids[(index + 1) % ids.length];
    case 'ArrowLeft':
    case 'ArrowUp':
      return ids[(index - 1 + ids.length) % ids.length];
    case 'Home':
      return ids[0];
    case 'End':
      return ids[ids.length - 1];
    default:
      return null;
  }
};
