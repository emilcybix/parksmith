import { BIOME_BY_ID } from '../game/biomes/content';
import { CARD_BY_ID } from '../game/cards/content';
import type { CardKind, CardRarity, PulseCardId } from '../game/cards/types';
import type { RunLevelStatus, RunPhase, RunSnapshot, RunSnapshotLevel, RunSummary } from '../game/run/types';
import { RUN_FAMILY_COPY } from '../game/run/content';
import { cardCountText, daysText, difficultyLabel, money, objectiveShort, THE_MAP } from './runCopy';
import { formatClock, objectiveSentence } from './scenarioCopy';
import { carriedDebtNote, levelCardsText, startingCashAfterDebt } from './runResultModel';
import { plural } from './unlockCopy';

/**
 * The run map (the hub) as pure data: the level path, the selected level's detail, the summary row, the primary action
 * by phase and the drawers. Nothing here reads the store or the DOM.
 */

export type RunMapPrimaryId = 'see-offer' | 'choose-cards' | 'back-to-park' | 'none';

export interface RunMapNode {
  index: number;
  biomeIcon: string;
  biomeName: string;
  /** Five '#rrggbb' strips of the biome (decorative: the node is named by text). */
  swatches: string[];
  status: RunLevelStatus;
  /** "Cleared 6:52", "Next", "Ahead", "Failed", "Abandoned": never colour alone. */
  statusLabel: string;
  objective: string;
  conditionIcons: Array<{ id: string; icon: string; name: string }>;
  selected: boolean;
  /** The level the run is on now (also marks "Next" before it is played). */
  current: boolean;
  ariaLabel: string;
}

export interface RunMapDetail {
  index: number;
  heading: string;
  biomeName: string;
  climateLabel: string;
  tagline: string;
  objectiveSentence: string;
  deadline: string;
  startingCash: string;
  slots: string;
  offer: string;
  conditions: Array<{ id: string; icon: string; name: string; detail: string }>;
  /** A cleared or ended level: what it came to. */
  resultLines: string[];
}

export interface RunMapModel {
  kicker: string;
  heading: string;
  nodes: RunMapNode[];
  detail: RunMapDetail;
  summary: string;
  deckLabel: string;
  usedLabel: string;
  primary: { id: RunMapPrimaryId; label: string };
  canAbandon: boolean;
  /** The 1-based "Level 3 of 5". */
  levelText: string;
}

/** The level whose detail shows when nothing was picked: the level the run is on. */
export const defaultSelectedLevel = (run: RunSnapshot): number => Math.max(0, Math.min(run.levelIndex, run.levels.length - 1));

const statusLabelOf = (level: RunSnapshotLevel, phase: RunPhase): string => {
  switch (level.status) {
    case 'cleared': return level.result === null ? 'Cleared' : `Cleared ${formatClock(level.result.atSeconds)}`;
    case 'failed': return 'Failed';
    case 'abandoned': return 'Abandoned';
    case 'current': return phase === 'stage' ? 'In play' : 'Next';
    case 'ahead': return 'Ahead';
  }
};

const hexColour = (rgb: number): string => `#${(rgb & 0xffffff).toString(16).padStart(6, '0')}`;
const swatchesOf = (biomeId: RunSnapshotLevel['biomeId']): string[] => (BIOME_BY_ID.get(biomeId)?.swatches ?? []).map(hexColour);

export const runKicker = (run: Pick<RunSnapshot, 'difficulty' | 'seed'>): string => (
  `${THE_MAP} · ${difficultyLabel(run.difficulty)} · seed ${run.seed}`.toUpperCase()
);

export const runSummaryLine = (run: RunSnapshot): string => (
  `Levels cleared ${run.levelsCleared}/${run.levelCount} · Deck ${cardCountText(run.deckSize)} · Used ${run.usedPile.length}`
);

/** What the big button does in this phase. A run that has ended has no map action. */
export const primaryActionOf = (run: RunSnapshot): { id: RunMapPrimaryId; label: string } => {
  const number = run.levelIndex + 1;
  switch (run.phase) {
    case 'offer': return { id: 'see-offer', label: `See the offer for level ${number}` };
    case 'loadout': return { id: 'choose-cards', label: `Choose cards for level ${number}` };
    case 'stage': return { id: 'back-to-park', label: 'Back to the park' };
    default: return { id: 'none', label: '' };
  }
};

/** `run` gives the level its real starting cash: debt left by the level before comes off it (Phase 25). */
const detailOf = (run: RunSnapshot, level: RunSnapshotLevel): RunMapDetail => {
  const resultLines: string[] = [];
  if (level.result !== null) {
    if (level.result.evidence !== null && level.result.evidence !== '') resultLines.push(level.result.evidence);
    if (level.result.outcome === 'abandoned') resultLines.push('You abandoned the run here.');
    resultLines.push(`Cards used: ${levelCardsText(run, level)}`);
  }
  return {
    index: level.index,
    heading: `Level ${level.index + 1} · ${level.biomeName}`,
    biomeName: level.biomeName,
    climateLabel: level.climateLabel,
    tagline: RUN_FAMILY_COPY[level.family].name,
    objectiveSentence: objectiveSentence(level.objective),
    deadline: `Time limit ${daysText(level.timeLimitDays)}`,
    startingCash: `Starting cash ${money(startingCashAfterDebt(run, level.index))}${carriedDebtNote(run, level.index)}`,
    slots: plural(level.slots, 'card slot'),
    offer: level.offer.length === 0 ? 'No offer before this level' : `Offer before this level: ${cardCountText(level.offer.length)}`,
    conditions: level.conditions.map((condition) => ({ ...condition })),
    resultLines,
  };
};

/** Null for a snapshot with no levels (never a real run; a hostile or half-written one reads as nothing to show). */
export const buildRunMap = (run: RunSnapshot, selectedIndex: number | null): RunMapModel | null => {
  if (run.levels.length === 0) return null;
  const selected = selectedIndex !== null && Number.isInteger(selectedIndex) && selectedIndex >= 0 && selectedIndex < run.levels.length ? selectedIndex : defaultSelectedLevel(run);
  const nodes: RunMapNode[] = run.levels.map((level) => {
    const current = level.index === run.levelIndex && run.phase !== 'won' && run.phase !== 'lost';
    const statusLabel = statusLabelOf(level, run.phase);
    const objective = objectiveShort(level.objective);
    return {
      index: level.index,
      biomeIcon: level.biomeIcon,
      biomeName: level.biomeName,
      swatches: swatchesOf(level.biomeId),
      status: level.status,
      statusLabel,
      objective,
      conditionIcons: level.conditions.map((condition) => ({ id: condition.id, icon: condition.icon, name: condition.name })),
      selected: level.index === selected,
      current,
      ariaLabel: `Level ${level.index + 1}, ${level.biomeName}: ${statusLabel}. ${objective}.`
        + (level.conditions.length === 0 ? '' : ` ${plural(level.conditions.length, 'condition')}: ${level.conditions.map((condition) => condition.name).join(', ')}.`),
    };
  });
  return {
    kicker: runKicker(run),
    heading: run.phase === 'won' || run.phase === 'lost' ? `Level ${Math.min(run.levelIndex + 1, run.levelCount)} of ${run.levelCount}` : `Level ${run.levelIndex + 1} of ${run.levelCount}`,
    levelText: `Level ${run.levelIndex + 1} of ${run.levelCount}`,
    nodes,
    detail: detailOf(run, run.levels[selected]),
    summary: runSummaryLine(run),
    deckLabel: `Deck (${run.deckSize})`,
    usedLabel: `Used (${run.usedPile.length})`,
    primary: primaryActionOf(run),
    canAbandon: run.phase !== 'won' && run.phase !== 'lost',
  };
};

// --- Drawers ---------------------------------------------------------------------------------------

export interface DeckRow {
  cardId: PulseCardId;
  icon: string;
  name: string;
  count: number;
  tagline: string;
  upside: string;
  downside: string;
  kind: CardKind;
  rarity: CardRarity;
  slotCost: 1 | 2;
}

export const deckRowsOf = (run: RunSnapshot): DeckRow[] => run.deck.flatMap(({ cardId, count }) => {
  const card = CARD_BY_ID.get(cardId);
  return card === undefined ? [] : [{
    cardId, icon: card.icon, name: card.name, count, tagline: card.tagline, upside: card.upside, downside: card.downside,
    kind: card.kind, rarity: card.rarity, slotCost: card.slotCost,
  }];
});

export interface UsedRow {
  cardId: PulseCardId;
  icon: string;
  name: string;
  kind: CardKind;
  rarity: CardRarity;
  slotCost: 1 | 2;
  levelNumber: number;
  /** A one-shot taken into the level being played and not played yet: it is in the player's pocket, not spent. */
  inPocket: boolean;
  /** "Level 3 · Desert Canyon", "Level 3 · Desert Canyon · in your pocket this level". */
  where: string;
}

export const IN_POCKET_TEXT = 'in your pocket this level';

/**
 * The used pile. During a stage the loadout's one-shots already sit in the pile (the deck moves at stage start); the ones
 * not played yet are marked "in your pocket this level". `playedCardIds` are the one-shots played so far (the park's
 * card snapshot); without it every one-shot of the current stage reads as in the pocket.
 */
export const usedRowsOf = (run: RunSnapshot, playedCardIds: readonly string[] = []): UsedRow[] => run.usedPile.flatMap((used) => {
  const card = CARD_BY_ID.get(used.cardId);
  const level = run.levels[used.levelIndex];
  if (card === undefined) return [];
  const inPocket = run.phase === 'stage' && used.levelIndex === run.levelIndex && card.kind === 'one-shot' && !playedCardIds.includes(used.cardId);
  const where = level === undefined ? `Level ${used.levelIndex + 1}` : `Level ${used.levelIndex + 1} · ${level.biomeName}`;
  return [{
    cardId: used.cardId,
    icon: card.icon,
    name: card.name,
    kind: card.kind,
    rarity: card.rarity,
    slotCost: card.slotCost,
    levelNumber: used.levelIndex + 1,
    inPocket,
    where: inPocket ? `${where} · ${IN_POCKET_TEXT}` : where,
  }];
});

export const DECK_EMPTY_TEXT = 'The deck is empty. Cards come in before every level.';
export const USED_EMPTY_TEXT = 'No card has been used yet.';

/** Roving focus over the level path: arrows move along it and wrap like any radio group, Home and End reach the ends. */
export const moveLevelFocus = (count: number, current: number, key: string): number | null => {
  if (count <= 0) return null;
  const index = Math.min(count - 1, Math.max(0, current));
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (index + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (index - 1 + count) % count;
    case 'Home': return 0;
    case 'End': return count - 1;
    default: return null;
  }
};

/** The `RunSummary` (what a save header carries) of a run snapshot: the pause menu and the HUD name the run with it. */
export const summaryOfSnapshot = (run: RunSnapshot): RunSummary => ({
  seed: run.seed,
  difficulty: run.difficulty,
  levelNumber: Math.min(run.levelIndex + 1, run.levelCount),
  levelCount: run.levelCount,
  biomeId: (run.levels[Math.min(run.levelIndex, run.levelCount - 1)] ?? run.levels[0]).biomeId,
  phase: run.phase,
  levelsCleared: run.levelsCleared,
});
