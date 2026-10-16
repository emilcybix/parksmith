import { GAME_CONFIG } from '../game/config';
import { BUILD_BY_ID } from '../game/content/catalog';
import type { BuildingSnapshot } from '../game/session/types';

/**
 * Phase 42: the Buildings window's pure model: group and state filters that combine with a name search, the counts
 * beside each filter, and a sort on any column in both directions (missing values always last). No store, no DOM.
 */

export type BuildingGroupFilter = 'all' | 'rides' | 'coasters' | 'food' | 'drink' | 'souvenirs' | 'facilities' | 'comforts' | 'scenery';
export type BuildingStateFilter = 'any' | 'open' | 'closed' | 'broken' | 'noAccess' | 'worn';
export type BuildingColumn = 'name' | 'price' | 'queue' | 'wait' | 'served' | 'throughput' | 'revenue' | 'satisfaction' | 'condition' | 'scenery';

export const GROUP_FILTERS: readonly { id: BuildingGroupFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'rides', label: 'Rides' },
  { id: 'coasters', label: 'Coasters' },
  { id: 'food', label: 'Food' },
  { id: 'drink', label: 'Drink' },
  { id: 'souvenirs', label: 'Souvenirs' },
  { id: 'facilities', label: 'Facilities' },
  { id: 'comforts', label: 'Comforts' },
  { id: 'scenery', label: 'Scenery' },
];

export const STATE_FILTERS: readonly { id: BuildingStateFilter; label: string }[] = [
  { id: 'any', label: 'Any state' },
  { id: 'open', label: 'Open' },
  { id: 'closed', label: 'Closed' },
  { id: 'broken', label: 'Broken down' },
  { id: 'noAccess', label: 'No path access' },
  { id: 'worn', label: 'Needs inspection' },
];

/** A ride whose condition is at or below this is worn: the threshold the Operations tab's "worn rides" counts. */
export const WORN_CONDITION: number = GAME_CONFIG.operations.maintenance.preventiveConditionThreshold;

export interface BuildingsView {
  group: BuildingGroupFilter;
  state: BuildingStateFilter;
  search: string;
  sort: BuildingColumn;
  descending: boolean;
}

export const DEFAULT_BUILDINGS_VIEW: BuildingsView = Object.freeze({ group: 'all', state: 'any', search: '', sort: 'revenue', descending: true });

export const groupOf = (row: Pick<BuildingSnapshot, 'group' | 'definitionId'>): Exclude<BuildingGroupFilter, 'all'> => {
  switch (row.group) {
    case 'ride': return BUILD_BY_ID.get(row.definitionId)?.custom === 'coaster' ? 'coasters' : 'rides';
    case 'food': return 'food';
    case 'drink': return 'drink';
    case 'souvenir': return 'souvenirs';
    case 'toilet': return 'facilities';
    case 'scenery': return 'scenery';
    default: return 'comforts';
  }
};

export const matchesState = (row: BuildingSnapshot, state: BuildingStateFilter, noAccess: (objectId: number) => boolean): boolean => {
  switch (state) {
    case 'any': return true;
    case 'open': return row.open === true;
    case 'closed': return row.open === false;
    case 'broken': return row.status === 'broken' || row.status === 'maintenance';
    case 'noAccess': return noAccess(row.objectId);
    default: return row.condition !== null && row.condition <= WORN_CONDITION;
  }
};

const matchesSearch = (row: BuildingSnapshot, search: string): boolean => {
  const needle = search.trim().toLowerCase();
  return needle === '' || row.name.toLowerCase().includes(needle);
};

const valueOf = (row: BuildingSnapshot, column: BuildingColumn): number | string | null => {
  switch (column) {
    case 'name': return row.name;
    case 'price': return row.price;
    case 'queue': return row.queueLength;
    case 'wait': return row.waitSeconds;
    case 'served': return row.served;
    case 'throughput': return row.throughputPerHour;
    case 'revenue': return row.revenue;
    case 'satisfaction': return row.satisfaction;
    case 'condition': return row.condition;
    default: return row.sceneryScore;
  }
};

/** Sorts by `column`; missing values last in both directions; ties by placement order (object id). */
export const sortRows = (rows: readonly BuildingSnapshot[], column: BuildingColumn, descending: boolean): BuildingSnapshot[] => (
  [...rows].sort((left, right) => {
    const a = valueOf(left, column);
    const b = valueOf(right, column);
    if (a === null && b === null) return left.objectId - right.objectId;
    if (a === null) return 1;
    if (b === null) return -1;
    const order = typeof a === 'string' && typeof b === 'string' ? a.localeCompare(b) : (a as number) - (b as number);
    return (descending ? -order : order) || left.objectId - right.objectId;
  })
);

export interface BuildingsWindowView {
  rows: BuildingSnapshot[];
  /** Per group filter: how many rows it would show with the current state and search. */
  groupCounts: Readonly<Record<BuildingGroupFilter, number>>;
  /** Per state filter: how many rows it would show with the current group and search. */
  stateCounts: Readonly<Record<BuildingStateFilter, number>>;
}

export const buildingsWindowView = (
  rows: readonly BuildingSnapshot[],
  view: BuildingsView,
  noAccess: (objectId: number) => boolean,
): BuildingsWindowView => {
  const searched = rows.filter((row) => matchesSearch(row, view.search));
  const groupCounts = Object.fromEntries(GROUP_FILTERS.map((filter) => [filter.id,
    searched.filter((row) => (filter.id === 'all' || groupOf(row) === filter.id) && matchesState(row, view.state, noAccess)).length])) as Record<BuildingGroupFilter, number>;
  const stateCounts = Object.fromEntries(STATE_FILTERS.map((filter) => [filter.id,
    searched.filter((row) => (view.group === 'all' || groupOf(row) === view.group) && matchesState(row, filter.id, noAccess)).length])) as Record<BuildingStateFilter, number>;
  const shown = searched.filter((row) => (view.group === 'all' || groupOf(row) === view.group) && matchesState(row, view.state, noAccess));
  return { rows: sortRows(shown, view.sort, view.descending), groupCounts, stateCounts };
};

/** Clicking a column header: the same column flips the direction, a new one starts descending (names ascending). */
export const nextSort = (view: BuildingsView, column: BuildingColumn): Pick<BuildingsView, 'sort' | 'descending'> => (
  view.sort === column ? { sort: column, descending: !view.descending } : { sort: column, descending: column !== 'name' }
);

/** The columns a group shows (a scenery row shows appeal, not a queue). */
export const columnsFor = (group: BuildingGroupFilter): readonly BuildingColumn[] => {
  switch (group) {
    case 'scenery': return ['name', 'scenery'];
    case 'comforts': return ['name'];
    case 'food': case 'drink': case 'souvenirs': case 'facilities':
      return ['name', 'price', 'queue', 'served', 'revenue', 'satisfaction'];
    default: return ['name', 'price', 'queue', 'wait', 'throughput', 'revenue', 'satisfaction', 'condition'];
  }
};

export const COLUMN_LABELS: Readonly<Record<BuildingColumn, string>> = {
  name: 'Name', price: 'Price', queue: 'Queue', wait: 'Wait', served: 'Served', throughput: 'Per hour',
  revenue: 'Revenue', satisfaction: 'Satisfied', condition: 'Condition', scenery: 'Appeal',
};

/** Reads a stored view, keeping only valid values (a bad or old record falls back field by field). */
export const parseBuildingsView = (raw: unknown): BuildingsView => {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {};
  const group = GROUP_FILTERS.some((filter) => filter.id === record.group) ? record.group as BuildingGroupFilter : DEFAULT_BUILDINGS_VIEW.group;
  const state = STATE_FILTERS.some((filter) => filter.id === record.state) ? record.state as BuildingStateFilter : DEFAULT_BUILDINGS_VIEW.state;
  const sort = Object.hasOwn(COLUMN_LABELS, String(record.sort)) ? record.sort as BuildingColumn : DEFAULT_BUILDINGS_VIEW.sort;
  return {
    group,
    state,
    search: typeof record.search === 'string' ? record.search.slice(0, 40) : '',
    sort,
    descending: typeof record.descending === 'boolean' ? record.descending : DEFAULT_BUILDINGS_VIEW.descending,
  };
};
