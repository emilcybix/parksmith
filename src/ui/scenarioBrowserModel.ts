import type { SaveSlotMeta } from '../app/saves/types';
import { MAP_BY_ID, DEFAULT_MAP_ID } from '../game/maps/content';
import { layoutOfMapId } from '../game/maps/parse';
import { mapFactsOf, mapPreviewOf, type MapPreviewImage } from '../game/maps/preview';
import { BIOME_BY_ID } from '../game/biomes/content';
import { BONUS_BY_ID, type BonusId } from '../game/profile/bonuses';
import type { ProfileSnapshot, ScenarioRecord } from '../game/profile/types';
import { SCENARIOS } from '../game/scenarios/content';
import { compileParkRules } from '../game/scenarios/rules';
import {
  SCENARIO_DIFFICULTY_LABELS,
  type ScenarioDefinition,
  type ScenarioId,
} from '../game/scenarios/types';
import { describeUnlockCondition, isScenarioUnlocked } from '../game/scenarios/unlock';
import { slotModeOf } from './modeLabels';
import { formatClock, objectiveSentence } from './scenarioCopy';
import { timeLimitText } from './scenarioDeadlineModel';
import { buildingKind, buildingName, plural } from './unlockCopy';
import type { MapId } from '../game/maps/types';

/**
 * The Scenario browser as pure data (Phase 22): nine rows, the detail of the selected one, what Start means and how
 * the arrows move. The component renders it and moves focus. Locked scenarios stay listed with their condition; the
 * Start button of a locked one stays focusable (`aria-disabled`) and says why.
 */

export type ScenarioRowStatus = 'cleared' | 'new' | 'locked';

export interface ScenarioRowModel {
  id: ScenarioId;
  name: string;
  difficulty: 1 | 2 | 3 | 4;
  difficultyLabel: string;
  /** "●●○○" (decorative; `difficultyLabel` is the text). */
  dots: string;
  status: ScenarioRowStatus;
  statusLabel: string;
  /** "Clear Sunny Start first" for a locked row. */
  lockedReason: string | null;
  /** The save slot to resume when a Scenario-mode park of this scenario was saved. */
  savedSlotId: string | null;
  selected: boolean;
}

export interface ScenarioRewardLine {
  text: string;
  earned: boolean;
}

export interface ScenarioDetailModel {
  id: ScenarioId;
  name: string;
  tagline: string;
  /** "Seaside Cove · Seaside". */
  place: string;
  preview: MapPreviewImage | null;
  previewLabel: string;
  objective: string;
  /** "Deadline: 1.5 days · Starting cash: $9,500 · 2 card slots". */
  facts: string;
  /** "⚑ Dusty gears — ride running costs are 15% higher." or "No special conditions". */
  condition: string;
  best: string;
  rewards: ScenarioRewardLine[];
  lockedReason: string | null;
  canStart: boolean;
  startLabel: string;
  savedSlotId: string | null;
}

export interface ScenarioBrowserModel {
  rows: ScenarioRowModel[];
  detail: ScenarioDetailModel;
  clearedCount: number;
  total: number;
  selectedId: ScenarioId;
}

const DOTS = (difficulty: number): string => '●'.repeat(difficulty) + '○'.repeat(Math.max(0, 4 - difficulty));

const clearedSet = (profile: ProfileSnapshot | null): ReadonlySet<ScenarioId> => new Set(profile?.clearedScenarioIds ?? []);

export const isScenarioOpen = (definition: ScenarioDefinition, profile: ProfileSnapshot | null): boolean => (
  isScenarioUnlocked(definition, clearedSet(profile))
);

/** "Best: cleared at 14:32 of 18:00 · 3 clears", "Best try: 72% of the goal", "Cleared on the Park Tour" or "Not played yet". */
export const describeBest = (definition: ScenarioDefinition, record: ScenarioRecord | undefined): string => {
  if (record === undefined) return 'Not played yet';
  if (record.clears > 0) {
    if (record.bestClearSeconds === null) {
      return record.firstClearVia === 'tour-conversion' ? 'Cleared on the Park Tour' : `Cleared · ${plural(record.clears, 'clear')}`;
    }
    return `Best: cleared at ${formatClock(record.bestClearSeconds)} of ${formatClock(definition.timeLimitSeconds)} · ${plural(record.clears, 'clear')}`;
  }
  const percent = Math.max(0, Math.min(99, Math.round(record.bestProgressPercent)));
  return record.attempts > 0 && percent > 0 ? `Best try: ${percent}% of the goal` : 'Not played yet';
};

const bonusEarned = (profile: ProfileSnapshot | null, id: BonusId): boolean => profile?.bonusIds.includes(id) ?? false;

export const rewardLines = (definition: ScenarioDefinition, profile: ProfileSnapshot | null): ScenarioRewardLine[] => {
  const lines: ScenarioRewardLine[] = [];
  for (const id of definition.rewards.unlocks) {
    lines.push({
      text: `Reward: unlocks ${buildingName(id)} (${buildingKind(id).toLowerCase()}) for every new park`,
      earned: profile?.unlockedBuildingIds.includes(id) ?? false,
    });
  }
  for (const id of definition.rewards.bonuses) {
    const bonus = BONUS_BY_ID.get(id);
    if (bonus === undefined) continue;
    lines.push({ text: `Reward: permanent bonus ${bonus.name} · ${bonus.summary}`, earned: bonusEarned(profile, id) });
  }
  if (lines.length === 0) lines.push({ text: 'Reward: a new Pulse Card draft', earned: false });
  return lines;
};

const placeOf = (definition: ScenarioDefinition): { place: string; mapId: MapId } => {
  const mapId = (definition.mapId ?? DEFAULT_MAP_ID) as MapId;
  const map = MAP_BY_ID.get(mapId);
  const biome = map === undefined ? undefined : BIOME_BY_ID.get(map.biome);
  return { place: `${map?.name ?? 'Unknown map'} · ${biome?.name ?? 'Meadow'}`, mapId };
};

/** The newest readable Scenario-mode save per scenario (the "Saved park" chip and `menuLoadSlot`). */
export const latestScenarioSaves = (slots: readonly SaveSlotMeta[]): ReadonlyMap<string, string> => {
  const byScenario = new Map<string, SaveSlotMeta>();
  const readable = slots.filter((slot) => slot.status.state === 'ok' && Number.isFinite(slot.savedAt));
  for (const slot of readable) {
    if (slot.scenarioId === null || slotModeOf(slot) !== 'scenario') continue;
    const previous = byScenario.get(slot.scenarioId);
    if (previous === undefined || slot.savedAt > previous.savedAt) byScenario.set(slot.scenarioId, slot);
  }
  return new Map([...byScenario].map(([scenarioId, slot]) => [scenarioId, slot.id]));
};

export const DEFAULT_SCENARIO_SELECTION: ScenarioId = SCENARIOS[0].id;

/** The first open scenario that is not cleared yet, else the first one: where the browser's selection starts. */
export const initialScenarioSelection = (profile: ProfileSnapshot | null): ScenarioId => {
  const cleared = clearedSet(profile);
  const next = SCENARIOS.find((definition) => isScenarioUnlocked(definition, cleared) && !cleared.has(definition.id));
  return (next ?? SCENARIOS[0]).id;
};

const conditionText = (definition: ScenarioDefinition): string => {
  const constraint = definition.constraint;
  return constraint === null ? 'No special conditions' : `⚑ ${constraint.name} — ${constraint.detail}`;
};

export const buildScenarioBrowser = (
  profile: ProfileSnapshot | null,
  selectedId: ScenarioId,
  slots: readonly SaveSlotMeta[] = [],
): ScenarioBrowserModel => {
  const cleared = clearedSet(profile);
  const saved = latestScenarioSaves(slots);
  const selected = SCENARIOS.find((definition) => definition.id === selectedId) ?? SCENARIOS[0];
  const rows: ScenarioRowModel[] = SCENARIOS.map((definition) => {
    const open = isScenarioUnlocked(definition, cleared);
    const status: ScenarioRowStatus = !open ? 'locked' : cleared.has(definition.id) ? 'cleared' : 'new';
    return {
      id: definition.id,
      name: definition.name,
      difficulty: definition.difficulty,
      difficultyLabel: SCENARIO_DIFFICULTY_LABELS[definition.difficulty],
      dots: DOTS(definition.difficulty),
      status,
      statusLabel: status === 'cleared' ? 'Cleared ✓' : status === 'new' ? 'New' : '🔒 Locked',
      lockedReason: open ? null : describeUnlockCondition(definition),
      savedSlotId: saved.get(definition.id) ?? null,
      selected: definition.id === selected.id,
    };
  });
  const open = isScenarioUnlocked(selected, cleared);
  const { place, mapId } = placeOf(selected);
  const mapName = MAP_BY_ID.get(mapId)?.name ?? 'the map';
  let preview: MapPreviewImage | null;
  let previewLabel = `Map preview: ${mapName}`;
  try {
    const layout = layoutOfMapId(mapId);
    preview = mapPreviewOf(layout);
    previewLabel = `Map preview: ${mapName}, gate on the ${mapFactsOf(layout).gateEdge} edge`;
  } catch {
    preview = null;
  }
  const rules = compileParkRules(selected.rules);
  const lockedReason = open ? null : describeUnlockCondition(selected);
  return {
    rows,
    detail: {
      id: selected.id,
      name: selected.name,
      tagline: selected.tagline,
      place,
      preview,
      previewLabel,
      objective: objectiveSentence(selected.objective),
      facts: `Deadline: ${timeLimitText(selected)} · Starting cash: $${rules.startingCash.toLocaleString('en-US')} · ${plural(selected.cardSlots, 'card slot')}`,
      condition: conditionText(selected),
      best: describeBest(selected, profile?.records[selected.id]),
      rewards: rewardLines(selected, profile),
      lockedReason: lockedReason === null ? null : `🔒 ${lockedReason}.`,
      canStart: open,
      startLabel: 'Choose cards and start',
      savedSlotId: saved.get(selected.id) ?? null,
    },
    clearedCount: rows.filter((row) => row.status === 'cleared').length,
    total: rows.length,
    selectedId: selected.id,
  };
};

/** Arrows select as they move (a radio group): the id the key moves to, or null when the key is not ours. */
export const moveScenarioSelection = (current: ScenarioId, key: string): ScenarioId | null => {
  const ids = SCENARIOS.map((definition) => definition.id);
  const index = ids.indexOf(current);
  switch (key) {
    case 'ArrowDown':
    case 'ArrowRight':
      return ids[(index + 1) % ids.length];
    case 'ArrowUp':
    case 'ArrowLeft':
      return ids[(index - 1 + ids.length) % ids.length];
    case 'Home':
      return ids[0];
    case 'End':
      return ids[ids.length - 1];
    default:
      return null;
  }
};

/** What the start menu says about the browser: "2 of 9 cleared". */
export const clearedSummary = (profile: ProfileSnapshot | null): string => `${profile?.clearedScenarioIds.length ?? 0} of ${SCENARIOS.length} cleared`;
