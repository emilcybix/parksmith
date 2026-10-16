import { describe, expect, it } from 'vitest';
import { MAPS } from '../../game/maps/content';
import { BIOME_BY_ID } from '../../game/biomes/content';
import { generateMap, recipeOf } from '../../game/maps/generator';
import { ParkSession } from '../../game/session/ParkSession';
import { biomeNameOf, mapMetaOf, mapNameOf, slotBiomeName, slotMapName } from './mapMeta';
import { parseSlotMeta } from './memorySaveStore';
import type { SaveSlotMeta } from './types';

const row = (overrides: Record<string, unknown> = {}): unknown => ({
  id: 'autosave', kind: 'auto', name: 'Autosave', scenarioId: null, scenarioName: 'Sandbox park', playtimeSeconds: 1, savedAt: 1,
  schemaVersion: 8, contentVersion: 2, savedAtTick: 1, guestCount: 0, cash: 0, rating: 0, sizeBytes: 1, revision: 1, writerTabId: 't',
  status: { state: 'ok' }, ...overrides,
});

describe('map names in slot metadata (Phase 24)', () => {
  it('names every shipped map and its biome from the saved map state', () => {
    for (const map of MAPS) {
      const state = new ParkSession(null, [], { mapId: map.id }).serialize().map;
      expect(mapMetaOf(state)).toEqual({ mapName: map.name, biomeName: BIOME_BY_ID.get(map.biome)!.name });
    }
  });

  it('calls a land that is not shipped "Custom map" and keeps its biome', () => {
    const state = { ...new ParkSession(null, [], { mapId: 'frosted-hollow' }).serialize().map, id: 'generated-12' };
    expect(mapNameOf(state)).toBe('Custom map');
    expect(biomeNameOf(state)).toBe('Winter');
  });

  it('names a generated map by its seed, a hand-edited id without a recipe stays Custom map', () => {
    const map = generateMap(recipeOf('seaside', 4321));
    const state = new ParkSession(null, [], { layout: map.layout }).serialize().map;
    expect(mapNameOf(state)).toBe('Generated · seed 4321');
    expect(mapMetaOf(state)).toEqual({ mapName: 'Generated · seed 4321', biomeName: 'Seaside' });
    expect(mapNameOf({ ...state, recipe: null })).toBe('Custom map');
  });

  it('a record from before Phase 24 reads as the Meadow Garden in the Meadow biome', () => {
    const old = { } as SaveSlotMeta;
    expect(slotMapName(old)).toBe('Meadow Garden');
    expect(slotBiomeName(old)).toBe('Meadow');
    expect(mapMetaOf(undefined)).toEqual({ mapName: 'Meadow Garden', biomeName: 'Meadow' });
    expect(slotMapName({ mapName: '   ' })).toBe('Meadow Garden');
    expect(slotMapName({ mapName: 'Red Rock Canyon' })).toBe('Red Rock Canyon');
  });

  it('the store reads the optional fields back, and drops a hostile value instead of listing the row as damaged', () => {
    expect(parseSlotMeta(row({ mapName: 'Red Rock Canyon', biomeName: 'Desert Canyon' }))).toMatchObject({ mapName: 'Red Rock Canyon', biomeName: 'Desert Canyon' });
    const legacy = parseSlotMeta(row());
    expect(legacy).not.toBeNull();
    expect(legacy).not.toHaveProperty('mapName');
    const hostile = parseSlotMeta(row({ mapName: { evil: true }, biomeName: 42 }));
    expect(hostile).not.toBeNull();
    expect(hostile).not.toHaveProperty('mapName');
    expect(hostile).not.toHaveProperty('biomeName');
  });
});
