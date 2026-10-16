import type { BuildCategory, BuildDefinition } from '../game/types';
import { SCENERY_THEME_IDS } from '../game/types';
import { THEME_LABELS } from './themeCopy';

/**
 * Phase 29: the filter rail of the build dock. Categories with many cards get a short list of filters — rides by kind
 * (coasters, gentle, family, thrill), shops by what they sell (food, drinks, souvenirs) and scenery by theme — and the
 * card strip shows only the cards the chosen filter matches. "All" is always first and is the default. Pure: the dock
 * renders what this says, and the tests read it without React.
 */

export type RideBand = 'coaster' | 'gentle' | 'family' | 'thrill';

/** Intensity below this is gentle, below `FAMILY_BELOW` family, the rest thrill (the dock's ride tags). */
export const GENTLE_BELOW = 25;
export const FAMILY_BELOW = 60;

/** The band a ride card shows and filters under; null for anything that is not a ride. */
export const rideBandOf = (definition: BuildDefinition): RideBand | null => {
  if (definition.kind !== 'ride') return null;
  if (definition.custom === 'coaster') return 'coaster';
  const intensity = definition.stats?.intensity ?? 0;
  if (intensity < GENTLE_BELOW) return 'gentle';
  if (intensity < FAMILY_BELOW) return 'family';
  return 'thrill';
};

export interface BuildFilter {
  /** Stable id, unique within its category ('all' in every category that has filters). */
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly matches: (definition: BuildDefinition) => boolean;
}

export const ALL_FILTER_ID = 'all';

const ALL: BuildFilter = { id: ALL_FILTER_ID, label: 'All', icon: '✱', matches: () => true };

const RIDE_FILTERS: readonly BuildFilter[] = [
  ALL,
  { id: 'coasters', label: 'Coasters', icon: '∿', matches: (definition) => rideBandOf(definition) === 'coaster' },
  { id: 'gentle', label: 'Gentle', icon: '❀', matches: (definition) => rideBandOf(definition) === 'gentle' },
  { id: 'family', label: 'Family', icon: '◎', matches: (definition) => rideBandOf(definition) === 'family' },
  { id: 'thrill', label: 'Thrill', icon: '↯', matches: (definition) => rideBandOf(definition) === 'thrill' },
];

const SHOP_FILTERS: readonly BuildFilter[] = [
  ALL,
  { id: 'food', label: 'Food', icon: '▰', matches: (definition) => definition.stats?.serviceType === 'food' },
  { id: 'drinks', label: 'Drinks', icon: '◒', matches: (definition) => definition.stats?.serviceType === 'drink' },
  { id: 'souvenirs', label: 'Souvenirs', icon: '☂', matches: (definition) => definition.stats?.serviceType === 'souvenir' },
];

const SCENERY_FILTERS: readonly BuildFilter[] = [
  ALL,
  ...SCENERY_THEME_IDS.map((theme): BuildFilter => ({
    id: theme,
    label: THEME_LABELS[theme],
    icon: '✿',
    matches: (definition) => definition.theme === theme,
  })),
];

/** The filters of each category; an empty list means the category shows no rail (it has few cards). */
export const BUILD_FILTERS: Readonly<Record<BuildCategory, readonly BuildFilter[]>> = {
  paths: [],
  rides: RIDE_FILTERS,
  shops: SHOP_FILTERS,
  facilities: [],
  comforts: [],
  scenery: SCENERY_FILTERS,
};

export interface BuildFilterChip {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  /** Cards in the category this filter shows. */
  readonly count: number;
  readonly active: boolean;
}

export interface BuildFilterView {
  /** The chips to render, in order; empty when the category has no rail. Filters that match nothing are left out. */
  readonly chips: readonly BuildFilterChip[];
  /** The filter in effect (falls back to 'all' when the stored one matches nothing or does not exist). */
  readonly activeId: string;
  /** The category's cards the active filter shows, in catalog order. */
  readonly definitions: readonly BuildDefinition[];
}

/** What the dock shows for `category` with the stored filter `filterId` (undefined = never chosen = all). */
export const buildFilterView = (
  catalog: readonly BuildDefinition[],
  category: BuildCategory,
  filterId: string | undefined,
): BuildFilterView => {
  const inCategory = catalog.filter((definition) => definition.category === category);
  const filters = BUILD_FILTERS[category];
  if (filters.length === 0) return { chips: [], activeId: ALL_FILTER_ID, definitions: inCategory };
  const counted = filters
    .map((filter) => ({ filter, count: inCategory.filter(filter.matches).length }))
    .filter(({ filter, count }) => filter.id === ALL_FILTER_ID || count > 0);
  const chosen = counted.find(({ filter }) => filter.id === filterId)?.filter ?? ALL;
  return {
    chips: counted.map(({ filter, count }) => ({ id: filter.id, label: filter.label, icon: filter.icon, count, active: filter.id === chosen.id })),
    activeId: chosen.id,
    definitions: inCategory.filter(chosen.matches),
  };
};
