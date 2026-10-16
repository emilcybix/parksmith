import { BIOME_BY_ID, DEFAULT_BIOME_ID } from '../../game/biomes/content';
import { DEFAULT_MAP_ID, MAP_BY_ID } from '../../game/maps/content';
import { generatedMapName } from '../../game/maps/recipe';
import type { MapId } from '../../game/maps/types';
import { isGameMode, legacyModeOf, type GameMode } from '../../game/modes/types';
import type { MapState } from '../../game/save/state';
import type { SaveSlotMeta } from './types';

/**
 * The map and biome names a slot's metadata carries (Phase 24). Pure text from the saved map state: a shipped map
 * id gives its name, a generated map "Generated · seed N", anything else (a hand-edited map) is "Custom map". Metadata written before this
 * phase has neither field and reads as the Meadow Garden map, which is exactly what every old park was.
 */

export const CUSTOM_MAP_NAME = 'Custom map';

const DEFAULT_MAP_NAME = MAP_BY_ID.get(DEFAULT_MAP_ID)?.name ?? 'Meadow Garden';
const DEFAULT_BIOME_NAME = BIOME_BY_ID.get(DEFAULT_BIOME_ID)?.name ?? 'Meadow';

/** A generated map reads "Generated · seed 1234" (the recipe the save carries); a shipped id gives its name. */
export const mapNameOf = (map: Pick<MapState, 'id'> & Partial<Pick<MapState, 'recipe'>>): string => (
  map.recipe ? generatedMapName(map.recipe) : MAP_BY_ID.get(map.id as MapId)?.name ?? CUSTOM_MAP_NAME
);

export const biomeNameOf = (map: Pick<MapState, 'biomeId'>): string => BIOME_BY_ID.get(map.biomeId)?.name ?? DEFAULT_BIOME_NAME;

/** The two optional metadata fields for a state about to be written. */
export const mapMetaOf = (map: MapState | undefined): { mapName: string; biomeName: string } => (
  map === undefined
    ? { mapName: DEFAULT_MAP_NAME, biomeName: DEFAULT_BIOME_NAME }
    : { mapName: mapNameOf(map), biomeName: biomeNameOf(map) }
);

/** What a row shows: the stored name, or the Meadow Garden default of a record that predates the field. */
export const slotMapName = (meta: Pick<SaveSlotMeta, 'mapName'>): string => (
  typeof meta.mapName === 'string' && meta.mapName.trim() !== '' ? meta.mapName : DEFAULT_MAP_NAME
);

export const slotBiomeName = (meta: Pick<SaveSlotMeta, 'biomeName'>): string => (
  typeof meta.biomeName === 'string' && meta.biomeName.trim() !== '' ? meta.biomeName : DEFAULT_BIOME_NAME
);

/**
 * Phase 22: how a slot's park was played. The stored mode when it is one of the three, else the schema 9 rule by
 * `scenarioId` (a record written before the field, or one with a hostile value, reads as Sandbox or Scenario).
 */
export const slotMode = (meta: Pick<SaveSlotMeta, 'mode' | 'scenarioId'>): GameMode => (
  isGameMode(meta.mode) ? meta.mode : legacyModeOf(meta.scenarioId)
);
