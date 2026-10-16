import { CARD_BY_ID } from '../game/cards/content';
import type { RunRewardResult } from '../game/profile/types';
import type { PulseCardId } from '../game/cards/types';
import type { RunSnapshot, RunSnapshotLevel } from '../game/run/types';
import { difficultyLabel, money, objectiveShort, THE_MAP } from './runCopy';
import { formatClock } from './scenarioCopy';
import { plural } from './unlockCopy';

/**
 * The stage result, the victory and the run-over screens as pure data. The rewards come from the profile's
 * `recordRunResult` (discovered cards, an unlocked difficulty, the best level): never raw power.
 */

// --- One-shots and debt (Phase 25) -------------------------------------------------------------------------

/**
 * The cards a finished level played, as words: "Grand Opening · Coach Party (played) · Bridging Loan (unplayed, back in
 * your deck)". Whether an unplayed one-shot went back to the deck is read from the used pile (it holds the card for that
 * level only when it was used up), so the line follows the run's own policy. "none" for an empty loadout.
 */
export const levelCardsText = (run: Pick<RunSnapshot, 'usedPile'>, level: Pick<RunSnapshotLevel, 'index' | 'result'>): string => {
  const result = level.result;
  if (result === null || result.cardIds.length === 0) return 'none';
  const played = new Set<PulseCardId>(result.playedCardIds ?? []);
  return result.cardIds.map((id) => {
    const card = CARD_BY_ID.get(id);
    const name = card?.name ?? id;
    if (card?.kind !== 'one-shot') return name;
    if (played.has(id)) return `${name} (played)`;
    const usedUp = run.usedPile.some((used) => used.cardId === id && used.levelIndex === level.index);
    return `${name} (unplayed, ${usedUp ? 'used up' : 'back in your deck'})`;
  }).join(' · ');
};

/** One-shot costs still unpaid when the level before `levelIndex` resolved (design 3.6); 0 for the first level. */
export const carriedDebtOf = (run: Pick<RunSnapshot, 'levels'>, levelIndex: number): number => (
  levelIndex > 0 ? run.levels[levelIndex - 1]?.result?.unpaidDebt ?? 0 : 0
);

/** A level's real starting cash: the planned cash minus the debt carried into it, never below 0 (`run/stage.ts`). */
export const startingCashAfterDebt = (run: Pick<RunSnapshot, 'levels'>, levelIndex: number): number => (
  Math.max(0, (run.levels[levelIndex]?.startingCash ?? 0) - carriedDebtOf(run, levelIndex))
);

/** " (−$2,400 unpaid from level 2)" after a starting cash that debt reduced; '' otherwise. */
export const carriedDebtNote = (run: Pick<RunSnapshot, 'levels'>, levelIndex: number): string => {
  const debt = carriedDebtOf(run, levelIndex);
  return debt > 0 ? ` (−${money(debt)} unpaid from level ${levelIndex})` : '';
};

// --- A cleared level ----------------------------------------------------------------------------------

export interface StageResultModel {
  heading: string;
  evidence: string | null;
  parkTime: string;
  cardsUsed: string;
  /** "Unpaid: $2,400 comes off level 3's starting cash", or null when nothing was left unpaid. */
  debt: string | null;
  /** "Level 4 · Winter — spirits ≥ 70 for 6:00 · 2 conditions", or null after the last level. */
  next: string | null;
  primaryLabel: string;
}

/** The result of the level just cleared (the newest history entry), or null when there is none to show. */
/** Evidence strings are written as clauses ("operating profit $2,310 of $3,500 when time ran out"); a screen shows them as a sentence. */
export const sentence = (text: string | null): string | null => (
  text === null || text.trim() === '' ? null : text.trim().replace(/^./, (letter) => letter.toUpperCase())
);

export const buildStageResult = (run: RunSnapshot): StageResultModel | null => {
  const level = [...run.levels].reverse().find((entry) => entry.status === 'cleared');
  if (level === undefined || level.result === null) return null;
  const next = run.levels[level.index + 1];
  return {
    heading: `Level ${level.index + 1} cleared`,
    evidence: sentence(level.result.evidence),
    parkTime: `Park time ${formatClock(level.result.atSeconds)}`,
    cardsUsed: `Cards used: ${levelCardsText(run, level)}`,
    debt: level.result.unpaidDebt > 0
      ? next === undefined
        ? `Unpaid at the end: ${money(level.result.unpaidDebt)}`
        : `Unpaid: ${money(level.result.unpaidDebt)} comes off level ${next.index + 1}'s starting cash`
      : null,
    next: next === undefined ? null : `Level ${next.index + 1} · ${next.biomeName} — ${objectiveShort(next.objective)}${next.conditions.length === 0 ? '' : ` · ${plural(next.conditions.length, 'condition')}`}`,
    primaryLabel: 'Continue to The Map',
  };
};

// --- The end of a run -----------------------------------------------------------------------------------

export interface EndRow {
  index: number;
  level: string;
  biome: string;
  objective: string;
  outcome: string;
  cards: string;
}

export interface RunEndAction {
  id: 'same-seed' | 'new-run' | 'main-menu';
  label: string;
  primary: boolean;
}

export interface RunEndModel {
  kind: 'won' | 'lost' | 'abandoned';
  heading: string;
  evidence: string | null;
  rows: EndRow[];
  totals: string;
  /** "Unpaid at the end: $2,400": one-shot costs still pending when the run ended (forgiven), or null. */
  debt: string | null;
  rewardLines: Array<{ id: string; icon: string; text: string }>;
  /** A quiet closing remark, or null. */
  note: string | null;
  actions: RunEndAction[];
}

const rowOutcome = (level: RunSnapshotLevel): string => {
  switch (level.status) {
    case 'cleared': return level.result === null ? 'Cleared' : `Cleared ${formatClock(level.result.atSeconds)}`;
    case 'failed': return 'Failed';
    case 'abandoned': return 'Abandoned';
    default: return 'Not reached';
  }
};

const rewardLinesOf = (run: RunSnapshot, rewards: RunRewardResult | null): Array<{ id: string; icon: string; text: string }> => {
  if (rewards === null) return [];
  const lines: Array<{ id: string; icon: string; text: string }> = [];
  if (!rewards.eligible) {
    lines.push({ id: 'ineligible', icon: '⚠', text: 'No rewards: this run does not match the run the game plans for its seed.' });
    return lines;
  }
  if (rewards.alreadyRecorded) lines.push({ id: 'recorded', icon: '✓', text: 'This run was already recorded.' });
  if (rewards.outcome === 'won') {
    if (rewards.newlyDiscoveredCardIds.length > 0) {
      lines.push({ id: 'cards', icon: '🂠', text: `New cards discovered: ${rewards.newlyDiscoveredCardIds.map((id) => CARD_BY_ID.get(id)?.name ?? id).join(', ')}` });
    } else if (!rewards.alreadyRecorded) {
      lines.push({ id: 'cards', icon: '🂠', text: 'Every card was already in your collection.' });
    }
    for (const difficulty of rewards.newlyUnlockedDifficulties) {
      lines.push({ id: `difficulty-${difficulty}`, icon: '🔓', text: `${difficultyLabel(difficulty)} difficulty unlocked` });
    }
  }
  const label = difficultyLabel(run.difficulty);
  if (rewards.bestLevel > 0 || rewards.outcome === 'lost') {
    lines.push({
      id: 'best',
      icon: '⏱',
      text: rewards.newBestLevel
        ? `New best on ${label}: ${rewards.bestLevel}/${run.levelCount} levels`
        : `Best on ${label}: ${rewards.bestLevel}/${run.levelCount} levels`,
    });
  }
  return lines;
};

/** The victory or run-over screen. `rewards` is what the profile answered at the end of the run (null: not known). */
export const buildRunEnd = (run: RunSnapshot, rewards: RunRewardResult | null): RunEndModel | null => {
  if (run.phase !== 'won' && run.phase !== 'lost') return null;
  const reached = Math.min(run.levelIndex + 1, run.levelCount);
  const last = run.levels.find((level) => level.index === run.levelIndex) ?? null;
  const abandoned = last?.status === 'abandoned';
  const kind: RunEndModel['kind'] = run.phase === 'won' ? 'won' : abandoned ? 'abandoned' : 'lost';
  const rows: EndRow[] = run.levels.filter((level) => level.status !== 'ahead' && level.status !== 'current').map((level) => ({
    index: level.index,
    level: `Level ${level.index + 1}`,
    biome: level.biomeName,
    objective: objectiveShort(level.objective),
    outcome: rowOutcome(level),
    cards: level.result === null ? '' : levelCardsText(run, level),
  }));
  const parkSeconds = run.levels.reduce((sum, level) => sum + (level.result?.atSeconds ?? 0), 0);
  const cardsPlayed = run.usedPile.length;
  const evidence = kind === 'abandoned' ? 'You abandoned the run.' : sentence(last?.result?.evidence ?? null);
  const totals = `Park time ${formatClock(parkSeconds)} · ${plural(cardsPlayed, 'card')} played`;
  const finalDebt = last?.result?.unpaidDebt ?? 0;
  const debt = finalDebt > 0 ? `Unpaid at the end: ${money(finalDebt)}` : null;
  const common: RunEndAction[] = [
    { id: 'new-run', label: 'New run', primary: false },
    { id: 'main-menu', label: 'Main menu', primary: false },
  ];
  if (kind === 'won') {
    return {
      kind,
      heading: `${THE_MAP} is yours!`,
      evidence: null,
      rows,
      totals,
      debt,
      rewardLines: rewardLinesOf(run, rewards),
      note: null,
      actions: [{ id: 'same-seed', label: 'New run with this seed', primary: true }, ...common],
    };
  }
  return {
    kind,
    heading: `Run over — level ${reached} of ${run.levelCount}`,
    evidence,
    rows,
    totals,
    debt,
    rewardLines: rewardLinesOf(run, rewards),
    note: 'Cards are discovered when you win a run.',
    actions: [{ id: 'same-seed', label: 'Try this seed again', primary: true }, ...common],
  };
};
