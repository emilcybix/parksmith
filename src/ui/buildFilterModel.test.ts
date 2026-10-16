import { describe, expect, it } from 'vitest';
import { BUILD_CATALOG } from '../game/content/catalog';
import type { BuildCategory } from '../game/types';
import { ALL_FILTER_ID, BUILD_FILTERS, buildFilterView, rideBandOf } from './buildFilterModel';

const ids = (category: BuildCategory, filter?: string): string[] =>
  buildFilterView(BUILD_CATALOG, category, filter).definitions.map((definition) => definition.id);

describe('the build dock filter rail (Phase 29)', () => {
  it('offers filters for rides, shops and scenery, and none for the short categories', () => {
    expect(BUILD_FILTERS.rides.map((filter) => filter.id)).toEqual(['all', 'coasters', 'gentle', 'family', 'thrill']);
    expect(BUILD_FILTERS.shops.map((filter) => filter.id)).toEqual(['all', 'food', 'drinks', 'souvenirs']);
    expect(BUILD_FILTERS.scenery[0].id).toBe(ALL_FILTER_ID);
    for (const category of ['paths', 'facilities', 'comforts'] as const) {
      expect(buildFilterView(BUILD_CATALOG, category, undefined).chips, category).toEqual([]);
      expect(ids(category), category).toEqual(BUILD_CATALOG.filter((definition) => definition.category === category).map((definition) => definition.id));
    }
  });

  it('puts every coaster under Coasters and splits the flat rides into gentle, family and thrill', () => {
    expect(ids('rides', 'coasters')).toEqual(['comet-trail', 'star-chaser', 'skyline-serpent', 'whisker-mouse', 'timber-twister', 'thunder-launch', 'bat-wing', 'titan-hyper']);
    expect(ids('rides', 'gentle')).toContain('moonpetal-carousel');
    expect(ids('rides', 'family')).toContain('comet-cups');
    expect(ids('rides', 'thrill')).toContain('thunder-drum');
    const rides = ids('rides');
    const banded = [...ids('rides', 'coasters'), ...ids('rides', 'gentle'), ...ids('rides', 'family'), ...ids('rides', 'thrill')];
    expect(banded.sort(), 'every ride is in exactly one band').toEqual([...rides].sort());
  });

  it('splits the shops into food, drinks and souvenirs', () => {
    expect(ids('shops', 'souvenirs')).toEqual(['brolly-booth', 'hat-hutch', 'balloon-bouquet', 'plushie-parlour', 'glow-cart']);
    expect(ids('shops', 'drinks')).toContain('bean-barrow');
    expect(ids('shops', 'food')).toContain('picnic-pocket');
    const all = ids('shops');
    expect([...ids('shops', 'food'), ...ids('shops', 'drinks'), ...ids('shops', 'souvenirs')].sort()).toEqual([...all].sort());
  });

  it('filters scenery by theme', () => {
    expect(ids('scenery', 'seaside')).toEqual(['shell-planter', 'harbor-lighthouse']);
    for (const id of ids('scenery', 'garden')) expect(BUILD_CATALOG.find((definition) => definition.id === id)?.theme).toBe('garden');
  });

  it('counts each chip, marks the active one and falls back to All for an unknown or emptied filter', () => {
    const view = buildFilterView(BUILD_CATALOG, 'rides', 'thrill');
    expect(view.activeId).toBe('thrill');
    expect(view.chips.filter((chip) => chip.active).map((chip) => chip.id)).toEqual(['thrill']);
    expect(view.chips.find((chip) => chip.id === 'all')?.count).toBe(ids('rides').length);
    expect(view.chips.find((chip) => chip.id === 'coasters')?.count).toBe(8);
    expect(buildFilterView(BUILD_CATALOG, 'rides', 'no-such-filter').activeId).toBe(ALL_FILTER_ID);
    expect(buildFilterView(BUILD_CATALOG, 'rides', 'souvenirs').activeId, "another category's filter").toBe(ALL_FILTER_ID);
    // A filter that matches nothing in this catalog is not offered (and so cannot be stuck on).
    const noCoasters = BUILD_CATALOG.filter((definition) => definition.custom !== 'coaster');
    const view2 = buildFilterView(noCoasters, 'rides', 'coasters');
    expect(view2.chips.map((chip) => chip.id)).not.toContain('coasters');
    expect(view2.activeId).toBe(ALL_FILTER_ID);
  });

  it('bands rides exactly like the cards tag them', () => {
    expect(rideBandOf(BUILD_CATALOG.find((definition) => definition.id === 'comet-trail')!)).toBe('coaster');
    expect(rideBandOf(BUILD_CATALOG.find((definition) => definition.id === 'picnic-pocket')!)).toBeNull();
  });
});
