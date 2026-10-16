import { describe, expect, it } from 'vitest';
import { BIOMES } from '../biomes/content';
import { PROJECT_BY_BUILD_ID } from '../progression/content';
import { SCENERY_THEME_IDS, type BuildDefinition, type SceneryThemeId } from '../types';
import { BUILD_BY_ID, BUILD_CATALOG } from './catalog';

/**
 * Phase 16 (design 3.2 and 9): the theme vocabulary, the theme profiles and the 12 appended entries, exactly as
 * designed. The entries are appended (every older id keeps its index) and reuse existing catalog colours, so the voxel
 * palette does not grow.
 */

const FIRST_APPENDED = BUILD_CATALOG.findIndex((definition) => definition.id === 'puddle-jumpers');
const OLDER = BUILD_CATALOG.slice(0, FIRST_APPENDED);
/** Phase 16's entries only: Phase 29 appended its own after them (catalog.ts PHASE29_DEFINITION_IDS). */
const APPENDED = BUILD_CATALOG.slice(FIRST_APPENDED, BUILD_CATALOG.findIndex((definition) => definition.id === 'brolly-booth'));

/** Design 3.2, column for column. */
const RIDES = [
  // id, theme, footprint, cost, capacity, duration, excitement, intensity, running, ticket, reliability, covered, unlock, colour, accent
  ['puddle-jumpers', 'garden', [2, 2], 650, 8, 30, 20, 6, 3, 2.5, 99, false, null, 0x52b788, 0xffcf56],
  ['rocket-pendulum', 'futuristic', [3, 3], 2_400, 12, 36, 64, 70, 15, 7, 80, false, null, 0x7048c9, 0x61e7d3],
  ['temple-trek', 'adventure', [4, 3], 2_600, 20, 60, 42, 24, 11, 5.5, 93, true, 'temple-expeditions', 0xb96748, 0xffd166],
] as const;

const STALLS = [
  // id, theme, need, footprint, cost, service s, relief, price, serves, unlock, colour, accent
  ['pretzel-pram', 'carnival', 'food', [2, 1], 360, 2.4, 48, 3.5, 'warm', null, 0xb9743c, 0xffe2a8],
  ['coconut-cove', 'seaside', 'drink', [2, 2], 640, 3.0, 85, 6.0, 'cold', 'refreshment-lab', 0x3aa7a3, 0xbde0fe],
] as const;

const SCENERY = [
  // id, theme, footprint, cost, appeal, radius, unlock, colour, accent
  ['bunting-mast', 'carnival', [1, 1], 32, 7, 4, null, 0xef6f8f, 0xffd166],
  ['shell-planter', 'seaside', [1, 1], 45, 12, 3, 'seaside-styling', 0x7fc8e8, 0xfff0f5],
  ['harbor-lighthouse', 'seaside', [2, 2], 520, 30, 7, 'seaside-styling', 0x4c9fd4, 0xfff0c8],
  ['tiki-torch', 'adventure', [1, 1], 38, 9, 4, 'adventure-styling', 0xe4572e, 0xffd166],
  ['jungle-idol', 'adventure', [1, 1], 80, 20, 3, 'adventure-styling', 0x48786b, 0x8ee3c5],
  ['neon-pylon', 'futuristic', [1, 1], 55, 6, 6, 'future-styling', 0x1b7f79, 0x61e7d3],
  ['orbit-globe', 'futuristic', [2, 2], 600, 40, 5, 'future-styling', 0x8f7cf7, 0x61e7d3],
] as const;

/** Design 3.2 "Theme metadata on existing entries". */
const EXISTING_THEMES: Record<string, SceneryThemeId> = {
  'petal-roundabout': 'garden', 'bumble-coach': 'garden',
  'moonpetal-carousel': 'carnival', 'comet-cups': 'carnival', 'thunder-drum': 'carnival',
  'harbor-swings': 'seaside', 'splash-rings': 'seaside',
  'tiki-tumbler': 'adventure',
  'cloud-hopper': 'futuristic', 'aurora-wheel': 'futuristic', 'gale-spinner': 'futuristic',
  'picnic-pocket': 'garden', 'waffle-windmill': 'garden',
  'fizz-foundry': 'carnival', 'snack-sprint': 'carnival', 'cocoa-chalet': 'carnival',
  'glacier-scoop': 'seaside', 'lemon-light': 'seaside',
  'cactus-cooler': 'adventure',
  'sunburst-flowers': 'garden', 'confetti-tree': 'garden', 'ripple-fountain': 'garden',
  'lollipop-lamp': 'carnival', 'lantern-maple': 'carnival',
};

const get = (id: string): BuildDefinition => {
  const definition = BUILD_BY_ID.get(id);
  if (!definition) throw new Error(`missing ${id}`);
  return definition;
};

describe('Phase 16 themes', () => {
  it('the vocabulary is the five themes, and every theme in the catalog is one of them', () => {
    expect([...SCENERY_THEME_IDS].sort()).toEqual(['adventure', 'carnival', 'futuristic', 'garden', 'seaside']);
    for (const definition of BUILD_CATALOG) {
      if (definition.theme !== undefined) expect(SCENERY_THEME_IDS, definition.id).toContain(definition.theme);
    }
  });

  it('each theme has at least two scenery pieces and at least one ride', () => {
    for (const theme of SCENERY_THEME_IDS) {
      const pieces = BUILD_CATALOG.filter((definition) => definition.kind === 'scenery' && definition.theme === theme);
      const rides = BUILD_CATALOG.filter((definition) => definition.kind === 'ride' && definition.theme === theme);
      expect(pieces.length, theme).toBeGreaterThanOrEqual(2);
      expect(rides.length, theme).toBeGreaterThanOrEqual(1);
    }
  });

  it('the existing entries carry the designed themes (metadata only)', () => {
    const themed = OLDER.filter((definition) => definition.theme !== undefined);
    expect(Object.fromEntries(themed.map((definition) => [definition.id, definition.theme]))).toEqual(EXISTING_THEMES);
  });

  it('a first park has free garden and carnival scenery; the other three themes are decoration research', () => {
    for (const theme of SCENERY_THEME_IDS) {
      const free = BUILD_CATALOG.filter((definition) => definition.kind === 'scenery' && definition.theme === theme
        && !definition.profileGate && !PROJECT_BY_BUILD_ID.has(definition.id));
      expect(free.length > 0, theme).toBe(theme === 'garden' || theme === 'carnival');
    }
  });

  it('every biome\'s local style is a valid theme', () => {
    for (const biome of BIOMES) {
      expect(biome.sceneryThemes.length, biome.id).toBeGreaterThan(0);
      for (const theme of biome.sceneryThemes) expect(SCENERY_THEME_IDS, biome.id).toContain(theme);
    }
  });
});

describe('Phase 16 appended entries', () => {
  it('are the 12 designed ids, appended in order after every older entry', () => {
    expect(APPENDED.map((definition) => definition.id)).toEqual([
      ...RIDES.map((row) => row[0]), ...STALLS.map((row) => row[0]), ...SCENERY.map((row) => row[0]),
    ]);
    expect(OLDER.length).toBe(32);
  });

  it('rides: exactly the designed numbers', () => {
    for (const [id, theme, footprint, cost, capacity, duration, excitement, intensity, running, ticket, reliability, covered, unlock, colour, accent] of RIDES) {
      const definition = get(id);
      expect({ kind: definition.kind, category: definition.category, theme: definition.theme, footprint: definition.footprint, cost: definition.buildCost, colour: definition.color, accent: definition.accent }, id)
        .toEqual({ kind: 'ride', category: 'rides', theme, footprint, cost, colour, accent });
      expect(definition.stats, id).toEqual({ capacity, duration, excitement, intensity, runningCost: running, ticketPrice: ticket, reliability });
      expect(definition.openAir === false, id).toBe(covered);
      expect(PROJECT_BY_BUILD_ID.get(id) ?? null, id).toBe(unlock);
    }
  });

  it('stalls: exactly the designed numbers', () => {
    for (const [id, theme, need, footprint, cost, service, relief, price, serves, unlock, colour, accent] of STALLS) {
      const definition = get(id);
      expect({ kind: definition.kind, category: definition.category, theme: definition.theme, footprint: definition.footprint, cost: definition.buildCost, serves: definition.serves, colour: definition.color, accent: definition.accent }, id)
        .toEqual({ kind: 'shop', category: 'shops', theme, footprint, cost, serves, colour, accent });
      expect(definition.stats, id).toEqual({ serviceType: need, serviceDuration: service, needRelief: relief, itemPrice: price });
      expect(PROJECT_BY_BUILD_ID.get(id) ?? null, id).toBe(unlock);
    }
  });

  it('scenery: exactly the designed numbers', () => {
    for (const [id, theme, footprint, cost, appeal, radius, unlock, colour, accent] of SCENERY) {
      const definition = get(id);
      expect({ kind: definition.kind, category: definition.category, theme: definition.theme, footprint: definition.footprint, cost: definition.buildCost, colour: definition.color, accent: definition.accent }, id)
        .toEqual({ kind: 'scenery', category: 'scenery', theme, footprint, cost, colour, accent });
      expect(definition.stats, id).toEqual({ sceneryAppeal: appeal, sceneryRadius: radius });
      expect(PROJECT_BY_BUILD_ID.get(id) ?? null, id).toBe(unlock);
    }
  });

  it('none is profile-gated or custom; each has a one-line description and one new glyph', () => {
    const olderIcons = new Set(OLDER.map((definition) => definition.icon));
    const icons = new Set<string>();
    for (const definition of APPENDED) {
      expect(definition.profileGate, definition.id).toBeUndefined();
      expect(definition.custom, definition.id).toBeUndefined();
      expect(definition.description, definition.id).not.toMatch(/\n/);
      expect(definition.description.length, definition.id).toBeLessThanOrEqual(60);
      expect([...definition.icon].length, definition.id).toBe(1);
      expect(olderIcons.has(definition.icon), definition.id).toBe(false);
      expect(icons.has(definition.icon), definition.id).toBe(false);
      icons.add(definition.icon);
    }
  });

  it('reuse existing catalog colours only (the voxel palette does not grow)', () => {
    const colours = new Set(OLDER.flatMap((definition) => [definition.color, definition.accent]));
    for (const definition of APPENDED) {
      expect(colours.has(definition.color), `${definition.id} colour`).toBe(true);
      expect(colours.has(definition.accent), `${definition.id} accent`).toBe(true);
    }
  });
});
