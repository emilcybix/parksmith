import type { GameMode } from '../game/modes/types';
import { BONUS_BY_ID, type BonusId } from '../game/profile/bonuses';
import type { ProfileSnapshot, ScenarioRewardResult } from '../game/profile/types';
import type { ScenarioId } from '../game/scenarios/types';
import { MENU_MODE_ORDER, modeLabel } from './modeLabels';
import { formatClock } from './scenarioCopy';
import { bonusName, buildingName, scenarioName } from './unlockCopy';

/**
 * What the result overlay says about rewards and which actions it offers (Phase 22), as pure data. The overlay
 * renders it. Rewards are per scenario and once: the first clear (in Scenario mode) grants them, a repeat
 * clear says so and only the best time moves.
 */

export interface RewardLine {
  id: string;
  icon: string;
  text: string;
}

export interface RewardsSection {
  title: string;
  lines: RewardLine[];
  /** Quiet closing remark ("Unlocks apply to parks you start from now on."). */
  note: string | null;
}

export const NO_REWARDS_TEXT = "No rewards: this park's rules do not match a park started in this game.";
export const UNLOCK_NOTE = 'Unlocks and bonuses apply to parks you start from now on.';

const lowerFirst = (text: string): string => text.charAt(0).toLowerCase() + text.slice(1);

/** "Parks start with $500 more cash." -> "parks start with $500 more cash". */
const bonusPhrase = (summary: string): string => lowerFirst(summary.replace(/\.$/, ''));

/** "A", "A and B", "A, B and C". */
const joinNames = (names: readonly string[]): string => (
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
);

/** Where a bonus applies right now, given the profile's switches: "on in Scenario and The Map" or "switched off". */
export const bonusScope = (bonusId: BonusId, profile: ProfileSnapshot | null): string => {
  const definition = BONUS_BY_ID.get(bonusId);
  const switches = profile?.useBonuses ?? { sandbox: false, scenario: true, run: true };
  const modes = MENU_MODE_ORDER.filter((mode: GameMode) => (definition?.modes.includes(mode) ?? true) && switches[mode]);
  if (modes.length === 0) return 'switched off in every mode, change it in Collection';
  return `on in ${joinNames(modes.map(modeLabel))}`;
};

const bestLine = (result: ScenarioRewardResult, atSeconds: number | null): string | null => {
  if (result.outcome !== 'succeeded' || atSeconds === null) return null;
  if (result.previousBestSeconds === null) return `Best: ${formatClock(atSeconds)}`;
  return result.newBest
    ? `New best: ${formatClock(atSeconds)} (was ${formatClock(result.previousBestSeconds)})`
    : `Best: ${formatClock(result.previousBestSeconds)} · this run ${formatClock(atSeconds)}`;
};

/**
 * The rewards block of a result, or null when there is nothing to say (a failure, or no profile result yet).
 * `atSeconds` is when the objective was decided (the best-time line).
 */
export const buildRewardsSection = (
  result: ScenarioRewardResult | null,
  profile: ProfileSnapshot | null,
  atSeconds: number | null,
): RewardsSection | null => {
  if (result === null || result.outcome !== 'succeeded') return null;
  if (!result.eligible) {
    return { title: 'Rewards', lines: [{ id: 'ineligible', icon: '⚠', text: NO_REWARDS_TEXT }], note: null };
  }
  const best = bestLine(result, atSeconds);
  if (!result.firstClear) {
    const lines: RewardLine[] = [{ id: 'already', icon: '✓', text: 'Rewards already earned' }];
    if (best !== null) lines.push({ id: 'best', icon: '⏱', text: best });
    for (const id of result.newlyAvailableScenarioIds) {
      lines.push({ id: `scenario-${id}`, icon: '🔓', text: `New scenario available: ${scenarioName(id)}` });
    }
    return { title: 'Cleared again', lines, note: null };
  }
  const lines: RewardLine[] = [];
  for (const id of result.newlyUnlockedBuildingIds) {
    lines.push({ id: `building-${id}`, icon: '🏗', text: `${buildingName(id)} unlocked — build it in any new park` });
  }
  for (const id of result.newlyEarnedBonusIds) {
    const summary = BONUS_BY_ID.get(id)?.summary ?? '';
    lines.push({ id: `bonus-${id}`, icon: '★', text: `${bonusName(id)} — ${bonusPhrase(summary)} (${bonusScope(id, profile)})` });
  }
  for (const id of result.newlyAvailableScenarioIds) {
    lines.push({ id: `scenario-${id}`, icon: '🔓', text: `New scenario available: ${scenarioName(id)}` });
  }
  if (best !== null) lines.push({ id: 'best', icon: '⏱', text: best });
  const earnedSomething = result.newlyUnlockedBuildingIds.length + result.newlyEarnedBonusIds.length > 0;
  return {
    title: 'Rewards earned for good',
    lines: lines.length === 0 ? [{ id: 'first', icon: '✓', text: 'Cleared for the first time' }] : lines,
    note: earnedSomething ? UNLOCK_NOTE : null,
  };
};

export type ResultActionId =
  | 'back-to-scenarios'
  | 'next-scenario'
  | 'try-again'
  | 'quick-restart'
  | 'keep-exploring';

export interface ResultAction {
  id: ResultActionId;
  label: string;
  primary: boolean;
  /** The scenario a "Next" action opens. */
  scenarioId?: ScenarioId;
}

/**
 * The overlay's buttons for a Scenario park and the outcome; the first one is the primary action. The Map has its own
 * result screens (runResultModel), so this overlay is Scenario-only since Phase 23.
 */
export const buildResultActions = (
  succeeded: boolean,
  result: ScenarioRewardResult | null,
): ResultAction[] => {
  if (succeeded) {
    const next = result?.eligible ? result.newlyAvailableScenarioIds[0] : undefined;
    return [
      { id: 'back-to-scenarios', label: 'Back to scenarios', primary: true },
      ...(next === undefined ? [] : [{ id: 'next-scenario' as const, label: `Next: ${scenarioName(next)}`, primary: false, scenarioId: next }]),
      { id: 'keep-exploring', label: 'Keep exploring', primary: false },
    ];
  }
  return [
    { id: 'try-again', label: 'Try again (same seed)', primary: true },
    { id: 'quick-restart', label: 'Quick restart (same cards)', primary: false },
    { id: 'back-to-scenarios', label: 'Back to scenarios', primary: false },
    { id: 'keep-exploring', label: 'Keep exploring', primary: false },
  ];
};
