import { describe, expect, it } from 'vitest';
import { BIOMES } from '../game/biomes/content';
import { MAPS, mapsOfBiome } from '../game/maps/content';
import {
  DEFAULT_GENERATOR_DRAFT,
  DEFAULT_NEW_PARK_SELECTION,
  GENERATE_CHOICE,
  SEED_HELP,
  generatedFor,
  recipeOfDraft,
  rerolledSeedText,
  buildNewParkPicker,
  gateEdgeOf,
  hex,
  mapBelongsTo,
  mapFacts,
  moveRadio,
  normaliseSelection,
  selectBiome,
  selectMap,
} from './newParkModel';

describe('the New park picker model', () => {
  it('lists the six biomes in data order with a five-colour swatch strip, a climate chip and a tagline', () => {
    const picker = buildNewParkPicker(DEFAULT_NEW_PARK_SELECTION);
    expect(picker.biomes.map((card) => card.id)).toEqual(BIOMES.map((biome) => biome.id));
    expect(picker.biomes).toHaveLength(6);
    for (const card of picker.biomes) {
      expect(card.swatches, card.id).toHaveLength(5);
      for (const swatch of card.swatches) expect(swatch).toMatch(/^#[0-9a-f]{6}$/);
      expect(card.name).not.toBe('');
      expect(card.climateLabel).not.toBe('');
      expect(card.tagline.length).toBeLessThanOrEqual(48);
      expect(card.mapCount, `${card.id} has at least one map`).toBeGreaterThanOrEqual(1);
    }
    expect(hex(0x92d47f)).toBe('#92d47f');
    expect(hex(0x000001)).toBe('#000001');
  });

  it('preselects Meadow Garden: New park then Enter is today\'s sandbox', () => {
    const picker = buildNewParkPicker(DEFAULT_NEW_PARK_SELECTION);
    expect(DEFAULT_NEW_PARK_SELECTION).toEqual({ biomeId: 'meadow', mapId: 'meadow' });
    expect(picker.biomes.filter((card) => card.selected).map((card) => card.id)).toEqual(['meadow']);
    expect(picker.maps.filter((row) => row.selected).map((row) => row.id)).toEqual(['meadow']);
    expect(picker.startLabel).toBe('Start Meadow Garden');
    expect(picker.maps[0].name).toBe('Meadow Garden');
  });

  it('lists the maps of the selected biome only, every shipped map under exactly one biome', () => {
    const seen = new Set<string>();
    for (const biome of BIOMES) {
      const picker = buildNewParkPicker({ biomeId: biome.id, mapId: mapsOfBiome(biome.id)[0].id });
      expect(picker.maps.map((row) => row.id)).toEqual(mapsOfBiome(biome.id).map((map) => map.id));
      for (const row of picker.maps) {
        expect(seen.has(row.id), `${row.id} listed once`).toBe(false);
        seen.add(row.id);
        expect(row.blurb).not.toBe('');
        expect(row.facts).toMatch(/^Gate: (north|east|south|west) edge · \d+ obstacles?/);
      }
    }
    expect([...seen].sort()).toEqual(MAPS.map((map) => map.id).sort());
  });

  it('selecting a biome selects its first map; selecting a map keeps the biome', () => {
    const winter = selectBiome(DEFAULT_NEW_PARK_SELECTION, 'winter');
    expect(winter).toEqual({ biomeId: 'winter', mapId: 'frosted-hollow' });
    expect(buildNewParkPicker(winter).startLabel).toBe('Start Frosted Hollow');
    const meadow2 = selectMap(DEFAULT_NEW_PARK_SELECTION, 'brookside-meadow');
    expect(meadow2).toEqual({ biomeId: 'meadow', mapId: 'brookside-meadow' });
    // Re-selecting the selected biome keeps the chosen map instead of resetting to the first.
    expect(selectBiome(meadow2, 'meadow')).toBe(meadow2);
  });

  it('refuses a selection that mixes biomes or names something that does not exist', () => {
    expect(selectMap(DEFAULT_NEW_PARK_SELECTION, 'red-rock-canyon')).toBe(DEFAULT_NEW_PARK_SELECTION);
    expect(selectBiome(DEFAULT_NEW_PARK_SELECTION, 'moon' as never)).toBe(DEFAULT_NEW_PARK_SELECTION);
    expect(selectMap(DEFAULT_NEW_PARK_SELECTION, 'nowhere' as never)).toBe(DEFAULT_NEW_PARK_SELECTION);
    expect(normaliseSelection({ biomeId: 'winter', mapId: 'meadow' })).toEqual(DEFAULT_NEW_PARK_SELECTION);
    expect(normaliseSelection({ biomeId: 'moon' as never, mapId: 'meadow' })).toEqual(DEFAULT_NEW_PARK_SELECTION);
    expect(buildNewParkPicker({ biomeId: 'desert-canyon', mapId: 'frosted-hollow' }).selection).toEqual(DEFAULT_NEW_PARK_SELECTION);
    expect(mapBelongsTo('winter', 'frosted-hollow')).toBe(true);
    expect(mapBelongsTo('winter', 'meadow')).toBe(false);
  });

  it('the facts line counts what is on the land and says where the gate is', () => {
    expect(mapFacts('meadow')).toBe('Gate: south edge · 0 obstacles');
    expect(mapFacts('red-rock-canyon')).toMatch(/^Gate: north edge · \d+ obstacles$/);
    expect(mapFacts('seaside-cove')).toMatch(/^Gate: west edge · \d+ obstacles · \d+ water tiles$/);
    expect(mapFacts('emerald-ruins')).toMatch(/^Gate: east edge/);
    expect(mapFacts('maple-ridge')).toMatch(/^Gate: south edge/);
    expect(gateEdgeOf({ x: 0, y: 5 }, 32, 32)).toBe('west');
    expect(gateEdgeOf({ x: 31, y: 5 }, 32, 32)).toBe('east');
    expect(gateEdgeOf({ x: 5, y: 0 }, 32, 32)).toBe('north');
    expect(gateEdgeOf({ x: 5, y: 31 }, 32, 32)).toBe('south');
  });

  it('moves in a radio group with arrows, Home and End, wrapping, and ignores other keys', () => {
    const ids = ['a', 'b', 'c'];
    expect(moveRadio(ids, 'a', 'ArrowRight')).toBe('b');
    expect(moveRadio(ids, 'c', 'ArrowRight')).toBe('a');
    expect(moveRadio(ids, 'a', 'ArrowLeft')).toBe('c');
    expect(moveRadio(ids, 'b', 'ArrowDown')).toBe('c');
    expect(moveRadio(ids, 'b', 'ArrowUp')).toBe('a');
    expect(moveRadio(ids, 'b', 'Home')).toBe('a');
    expect(moveRadio(ids, 'a', 'End')).toBe('c');
    expect(moveRadio(ids, 'b', 'x')).toBeNull();
    expect(moveRadio(ids, 'b', 'Enter')).toBeNull();
    expect(moveRadio([], 'a', 'ArrowRight')).toBeNull();
    expect(moveRadio(ids, 'zzz', 'ArrowRight'), 'an unknown current starts from the first').toBe('b');
  });
});

describe('the Generate choice of the New park picker', () => {
  const generating = (biomeId: 'meadow' | 'desert-canyon' | 'seaside' = 'meadow') => ({ biomeId, mapId: GENERATE_CHOICE });

  it('is selectable in every biome and never mixes with a shipped map', () => {
    for (const biome of BIOMES) {
      expect(mapBelongsTo(biome.id, GENERATE_CHOICE)).toBe(true);
      const picked = selectMap({ biomeId: biome.id, mapId: mapsOfBiome(biome.id)[0].id }, GENERATE_CHOICE);
      expect(picked.mapId).toBe(GENERATE_CHOICE);
      // Changing biome keeps Generate (a player who chose to generate wants to try the other biomes the same way) ...
      const other = biome.id === 'meadow' ? 'winter' : 'meadow';
      expect(selectBiome(picked, other)).toEqual({ biomeId: other, mapId: GENERATE_CHOICE });
      // ... and picking a shipped map in the new biome leaves it.
      expect(selectMap(selectBiome(picked, other), mapsOfBiome(other)[0].id).mapId).toBe(mapsOfBiome(other)[0].id);
    }
    expect(DEFAULT_NEW_PARK_SELECTION.mapId).toBe('meadow');
  });

  it('shows controls, a preview and a named start only when Generate is selected', () => {
    const plain = buildNewParkPicker(DEFAULT_NEW_PARK_SELECTION);
    expect(plain.controls).toBeNull();
    expect(plain.preview).not.toBeNull();
    expect(plain.generate.selected).toBe(false);
    const picker = buildNewParkPicker(generating(), { ...DEFAULT_GENERATOR_DRAFT, seedText: ' 1234 ' });
    expect(picker.controls?.seedError).toBeNull();
    expect(picker.controls?.recipe).toMatchObject({ biomeId: 'meadow', seed: 1234, density: 'normal', water: true });
    expect(picker.startLabel).toBe('Start Generated · seed 1234');
    expect(picker.canStart).toBe(true);
    expect(picker.preview?.width).toBe(128);
    expect(picker.generate.facts).toMatch(/^Gate: (north|east|south|west) edge · \d+ obstacles?/);
    expect(picker.maps.every((row) => !row.selected)).toBe(true);
  });

  it('validates the seed: digits only, 0..4294967295; an invalid seed has no preview and cannot start', () => {
    for (const bad of ['', 'abc', '-1', '1.5', '1e3', '4294967296', '0x10', '12 34', '١٢٣']) {
      const picker = buildNewParkPicker(generating(), { ...DEFAULT_GENERATOR_DRAFT, seedText: bad });
      expect(picker.controls?.seedError, bad).toBe(SEED_HELP);
      expect(picker.preview, bad).toBeNull();
      expect(picker.canStart, bad).toBe(false);
      expect(picker.generate.facts).toBe(SEED_HELP);
    }
    for (const good of ['0', '4294967295', '007']) {
      expect(recipeOfDraft('meadow', { ...DEFAULT_GENERATOR_DRAFT, seedText: good }).error, good).toBeNull();
    }
  });

  it('offers the water switch with the biome label, and none for Desert Canyon (water forced off)', () => {
    expect(buildNewParkPicker(generating('seaside')).controls?.water).toEqual({ label: 'Sea', on: true });
    expect(buildNewParkPicker(generating('desert-canyon')).controls?.water).toBeNull();
    const desert = recipeOfDraft('desert-canyon', DEFAULT_GENERATOR_DRAFT);
    expect(desert.recipe?.water).toBe(false);
    const dry = buildNewParkPicker(generating('seaside'), { ...DEFAULT_GENERATOR_DRAFT, water: false });
    expect(dry.controls?.recipe?.water).toBe(false);
    expect(dry.controls?.water?.on).toBe(false);
  });

  it('the preview is the same pixels for the same recipe and changes with the seed', () => {
    const a = buildNewParkPicker(generating(), DEFAULT_GENERATOR_DRAFT).preview!;
    const b = buildNewParkPicker(generating(), DEFAULT_GENERATOR_DRAFT).preview!;
    const c = buildNewParkPicker(generating(), { ...DEFAULT_GENERATOR_DRAFT, seedText: '2' }).preview!;
    expect(b.hash).toBe(a.hash);
    expect(c.hash).not.toBe(a.hash);
    expect(generatedFor(recipeOfDraft('meadow', DEFAULT_GENERATOR_DRAFT).recipe!)).toBe(generatedFor(recipeOfDraft('meadow', DEFAULT_GENERATOR_DRAFT).recipe!));
  });

  it('Reroll gives a valid uint32 seed text at both ends of the random range', () => {
    expect(rerolledSeedText(() => 0)).toBe('0');
    expect(rerolledSeedText(() => 0.999999999999)).toBe('4294967295');
    expect(rerolledSeedText(() => 1)).toBe('4294967295');
    expect(recipeOfDraft('meadow', { ...DEFAULT_GENERATOR_DRAFT, seedText: rerolledSeedText(() => 0.5) }).error).toBeNull();
  });

  it('moveRadio walks the map ids with Generate last and wraps', () => {
    const ids = [...mapsOfBiome('meadow').map((map) => map.id), GENERATE_CHOICE];
    expect(moveRadio(ids, 'meadow', 'End')).toBe(GENERATE_CHOICE);
    expect(moveRadio(ids, GENERATE_CHOICE, 'ArrowDown')).toBe(ids[0]);
  });

  it('every shipped map has a preview of the full map size', () => {
    for (const biome of BIOMES) {
      for (const map of mapsOfBiome(biome.id)) {
        const picker = buildNewParkPicker({ biomeId: biome.id, mapId: map.id });
        expect(picker.preview?.width, map.id).toBe(128);
        expect(picker.previewLabel).toContain(map.name);
      }
    }
  });
});

describe('the estate switch of Generate (Phase 21)', () => {
  it('makes a 64 x 64 recipe and preview; off is the classic recipe', async () => {
    const { recipeOfDraft, generatedFor, DEFAULT_GENERATOR_DRAFT } = await import('./newParkModel');
    const classic = recipeOfDraft('meadow', DEFAULT_GENERATOR_DRAFT);
    const estate = recipeOfDraft('meadow', { ...DEFAULT_GENERATOR_DRAFT, estate: true });
    expect(classic.recipe && 'size' in classic.recipe).toBe(false);
    expect(estate.recipe?.size).toBe(64);
    const map = generatedFor(estate.recipe!);
    expect(map.layout.width).toBe(64);
    expect(map.layout.ownedArea).toBeDefined();
    expect(generatedFor(classic.recipe!).layout.width).toBe(32);
  });
});
