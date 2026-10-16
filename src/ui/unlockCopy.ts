import { BUILD_BY_ID } from '../game/content/catalog';
import { BONUS_BY_ID, type BonusId } from '../game/profile/bonuses';
import { SCENARIO_BY_ID } from '../game/scenarios/content';
import type { ScenarioId } from '../game/scenarios/types';
import { unlockSourceOf } from '../game/profile/unlocks';

/** Names and one-word kinds for the gated catalog entries and the bonuses, used by every Phase 22 screen. */

const KIND_LABEL: Readonly<Record<string, string>> = {
  ride: 'Ride',
  shop: 'Stall',
  scenery: 'Scenery',
  amenity: 'Amenity',
  path: 'Path',
  staff: 'Staff',
};

export const buildingName = (definitionId: string): string => BUILD_BY_ID.get(definitionId)?.name ?? definitionId;

export const buildingKind = (definitionId: string): string => KIND_LABEL[BUILD_BY_ID.get(definitionId)?.kind ?? ''] ?? 'Building';

/** The category glyph of the dock tab (Rides ✦, Shops ◒, Scenery ✿): the catalog's own icons are not in every system font. */
const KIND_ICON: Readonly<Record<string, string>> = { ride: '✦', shop: '◒', scenery: '✿', amenity: '▣' };

export const buildingIcon = (definitionId: string): string => KIND_ICON[BUILD_BY_ID.get(definitionId)?.kind ?? ''] ?? '▣';

export const bonusName = (bonusId: BonusId): string => BONUS_BY_ID.get(bonusId)?.name ?? bonusId;

export const bonusSummary = (bonusId: BonusId): string => BONUS_BY_ID.get(bonusId)?.summary ?? '';

export const scenarioName = (scenarioId: ScenarioId): string => SCENARIO_BY_ID.get(scenarioId)?.name ?? scenarioId;

/** The scenario whose first clear grants a building, by name ("Boardwalk Breeze"), or null. */
export const unlockSourceName = (definitionId: string): string | null => {
  const source = unlockSourceOf(definitionId);
  return source === undefined ? null : scenarioName(source);
};

/** The scenario whose first clear grants a bonus, by name, or null. */
export const bonusSourceName = (bonusId: BonusId): string | null => {
  for (const scenario of SCENARIO_BY_ID.values()) if (scenario.rewards.bonuses.includes(bonusId)) return scenario.name;
  return null;
};

export const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** "Clear Frost Fair" out of the long lock text ("Clear Frost Fair in Scenario mode"). */
export const shortenUnlockCondition = (text: string): string => text.replace(/ in Scenario mode( or on The Map)?$/, '');

/** "Unlock by clearing Frost Fair in Scenario mode". */
export const unlockHint = (text: string): string => {
  const trimmed = text.replace(/^Clear /, '');
  return text.startsWith('Clear ') ? `Unlock by clearing ${trimmed}` : text;
};
