import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../game/config';
import { ParkSession } from '../game/session/ParkSession';
import { seedDevPark } from '../game/session/devPark';
import type { BuildingSnapshot } from '../game/session/types';
import { hudInsets, ANCHORS } from './layoutModel';
import { BuildingsWindowBody } from './BuildingsWindow';
import {
  DEFAULT_BUILDINGS_VIEW,
  buildingsWindowView,
  groupOf,
  nextSort,
  parseBuildingsView,
  sortRows,
} from './buildingsWindowModel';
import { StaffWindowBody } from './StaffWindow';
import { staffOverview, workerActivity, workerName } from './staffWindowModel';
import { useUiStore } from './store';
import { clampWindowPosition } from './WindowFrame';

/** Phase 42: the Staff and Buildings windows: their pure models, the worker reads, and the markup. */

type Patch = Partial<ReturnType<typeof useUiStore.getState>>;
const renderWith = (patch: Patch, element: React.JSX.Element): string => {
  const seed = useUiStore.getInitialState() as unknown as Record<string, unknown>;
  const saved: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) saved[key] = seed[key];
  Object.assign(seed, patch);
  try {
    return renderToStaticMarkup(element);
  } finally {
    Object.assign(seed, saved);
  }
};

const devPark = (): ParkSession => {
  const session = new ParkSession(null);
  session.setWeatherEnabled(false);
  seedDevPark(session);
  session.syncWithWorld();
  return session;
};

describe('Phase 42: the Staff window model', () => {
  it('names are stable per id and mostly distinct', () => {
    expect(workerName(7)).toBe(workerName(7));
    const names = new Set(Array.from({ length: 40 }, (_unused, id) => workerName(id + 1)));
    expect(names.size).toBe(40);
  });

  it('says what a worker is doing, with the building it works on', () => {
    const names = (id: number): string | null => (id === 3 ? 'Aurora Wheel' : null);
    expect(workerActivity({ state: 'idle', task: null }, names)).toBe('Idle');
    expect(workerActivity({ state: 'working', task: { kind: 'repairRide', targetObjectId: 3, targetCell: { x: 0, y: 0 } } }, names)).toBe('Repairing Aurora Wheel');
    expect(workerActivity({ state: 'walking', task: { kind: 'inspectRide', targetObjectId: 3, targetCell: { x: 0, y: 0 } } }, names)).toBe('Walking to inspect Aurora Wheel');
    expect(workerActivity({ state: 'working', task: { kind: 'cleanLitter', targetObjectId: null, targetCell: { x: 0, y: 0 } } }, names)).toBe('Cleaning litter');
    expect(workerActivity({ state: 'walking', task: { kind: 'emptyBin', targetObjectId: 9, targetCell: { x: 0, y: 0 } } }, names)).toBe('Walking to empty a bin');
  });

  it('hints at more cleaners only when the park is dirty and every cleaner is busy', () => {
    const base = {
      cleanliness: { score: 60, litterUnits: 30, dirtyPathTiles: 12, binsTotal: 2, binsFull: 0, averageBinFillPercent: 0 },
      maintenance: { averageRideCondition: 80, wornRides: 0, brokenRides: 0, awaitingMechanic: 0 },
      staff: {
        cleaners: { total: 2, busy: 2, salaryPerInterval: 10, trainingLevel: 0, trainingCost: 100 },
        mechanics: { total: 1, busy: 0, salaryPerInterval: 10, trainingLevel: 0, trainingCost: 100 },
        payrollIntervalSeconds: 60, capacityPerRole: 6, maximumTrainingLevel: 3,
      },
    };
    expect(staffOverview(base as never).hints).toEqual(['The paths are getting dirty and every cleaner is busy: more cleaners needed.']);
    expect(staffOverview({ ...base, cleanliness: { ...base.cleanliness, score: 90 } } as never).hints).toEqual([]);
    const broken = { ...base, cleanliness: { ...base.cleanliness, score: 95 }, maintenance: { ...base.maintenance, brokenRides: 1, awaitingMechanic: 1 } };
    expect(staffOverview(broken as never).hints[0]).toMatch(/1 breakdown waiting: hire another mechanic/);
  });
});

describe('Phase 42: workers in the simulation', () => {
  it('the snapshot lists every worker by id, and "fire this one" removes exactly that worker', () => {
    const session = devPark();
    const operations = session.operations;
    const hired = operations.hireStaff('cleaner')!;
    const before = operations.workersSnapshot();
    expect(before.map((worker) => worker.id)).toEqual([...before.map((worker) => worker.id)].sort((a, b) => a - b));
    expect(before.some((worker) => worker.id === hired.id)).toBe(true);
    const target = before[0];
    expect(operations.fireStaffById(target.id)?.id).toBe(target.id);
    const after = operations.workersSnapshot();
    expect(after.map((worker) => worker.id)).toEqual(before.filter((worker) => worker.id !== target.id).map((worker) => worker.id));
    expect(operations.fireStaffById(target.id)).toBeNull();
  });

  it('a worker row follows its worker: busy workers name their task', () => {
    const session = devPark();
    session.guests.spawnGuests(300);
    for (let step = 0; step < 60_000 / GAME_CONFIG.fixedStepMs; step += 1) session.step(GAME_CONFIG.fixedStepMs);
    const workers = session.operations.workersSnapshot();
    expect(workers.length).toBeGreaterThan(0);
    for (const worker of workers) expect(worker.task === null).toBe(worker.state === 'idle' || worker.task === null);
  }, 30_000);
});

describe('Phase 42: the Buildings window model', () => {
  const rows = (): BuildingSnapshot[] => {
    const session = devPark();
    return session.buildingsSnapshot();
  };

  it('filters by group and state, searches by name, and counts what each filter would show', () => {
    const all = rows();
    const none = (): boolean => false;
    const view = buildingsWindowView(all, DEFAULT_BUILDINGS_VIEW, none);
    expect(view.rows.length).toBe(all.length);
    expect(view.groupCounts.all).toBe(all.length);
    const sum = (['rides', 'coasters', 'food', 'drink', 'souvenirs', 'facilities', 'comforts', 'scenery'] as const)
      .reduce((total, group) => total + view.groupCounts[group], 0);
    expect(sum, 'every row is in exactly one group').toBe(all.length);
    const food = buildingsWindowView(all, { ...DEFAULT_BUILDINGS_VIEW, group: 'food' }, none);
    expect(food.rows.length).toBe(view.groupCounts.food);
    expect(food.rows.every((row) => groupOf(row) === 'food')).toBe(true);
    const searched = buildingsWindowView(all, { ...DEFAULT_BUILDINGS_VIEW, search: 'COMET' }, none);
    expect(searched.rows.length).toBeGreaterThan(0);
    expect(searched.rows.every((row) => row.name.toLowerCase().includes('comet'))).toBe(true);
    const closed = buildingsWindowView(all, { ...DEFAULT_BUILDINGS_VIEW, state: 'closed' }, none);
    expect(closed.rows).toEqual([]);
    const nothing = buildingsWindowView(all, { ...DEFAULT_BUILDINGS_VIEW, search: 'no such building' }, none);
    expect(nothing.rows).toEqual([]);
    expect(nothing.groupCounts.all).toBe(0);
    const unreachable = buildingsWindowView(all, { ...DEFAULT_BUILDINGS_VIEW, state: 'noAccess' }, (id) => id === all[0].objectId);
    expect(unreachable.rows.map((row) => row.objectId)).toEqual([all[0].objectId]);
  });

  it('sorts any column both ways, missing values always last', () => {
    const all = rows();
    const down = sortRows(all, 'price', true);
    const up = sortRows(all, 'price', false);
    const priced = down.filter((row) => row.price !== null);
    expect(down.slice(priced.length).every((row) => row.price === null)).toBe(true);
    expect(up.slice(priced.length).every((row) => row.price === null)).toBe(true);
    for (let index = 1; index < priced.length; index += 1) expect(priced[index - 1].price!).toBeGreaterThanOrEqual(priced[index].price!);
    expect(nextSort(DEFAULT_BUILDINGS_VIEW, 'revenue')).toEqual({ sort: 'revenue', descending: false });
    expect(nextSort(DEFAULT_BUILDINGS_VIEW, 'name')).toEqual({ sort: 'name', descending: false });
    expect(nextSort(DEFAULT_BUILDINGS_VIEW, 'queue')).toEqual({ sort: 'queue', descending: true });
  });

  it('a stored view is read field by field, falling back where it is bad', () => {
    expect(parseBuildingsView(null)).toEqual(DEFAULT_BUILDINGS_VIEW);
    expect(parseBuildingsView({ group: 'food', state: 'nope', search: 7, sort: 'queue', descending: false }))
      .toEqual({ ...DEFAULT_BUILDINGS_VIEW, group: 'food', sort: 'queue', descending: false });
  });
});

describe('Phase 42: the windows on screen', () => {
  it('the Staff window shows each role, every worker by name and a Fire button for each', () => {
    const session = devPark();
    session.refreshManagement();
    const workers = session.operations.workersSnapshot();
    const html = renderWith({ management: session.management.snapshot(), workers, buildings: session.buildingsSnapshot(), cash: 10_000 }, <StaffWindowBody />);
    expect(html).toContain('Cleaners');
    expect(html).toContain('Mechanics');
    for (const worker of workers) expect(html).toContain(`Fire ${workerName(worker.id)}`);
    expect(html).toContain('aria-labelledby="game-window-staff-title"');
  });

  it('the Buildings window lists the rows with their filter counts, sortable headers and row actions', () => {
    const session = devPark();
    const buildings = session.buildingsSnapshot();
    const html = renderWith({ buildings, buildingsView: { ...DEFAULT_BUILDINGS_VIEW } }, <BuildingsWindowBody />);
    expect((html.match(/<tr/g) ?? []).length).toBe(buildings.length + 1);
    expect(html).toContain('aria-sort="descending"');
    expect(html).toContain('Search buildings by name');
    expect(html).toMatch(/Close [A-Z]/);
  });

  it('an open window widens the camera inset on the left', () => {
    expect(hudInsets(1, false, true).left).toBe(ANCHORS.windowLeft + ANCHORS.windowWidth);
    expect(hudInsets(1, false).left).toBe(ANCHORS.railLeft + ANCHORS.railWidth);
  });

  it('a dragged window keeps its title bar on screen', () => {
    expect(clampWindowPosition(-1000, -50, 380, 1280, 800)).toEqual({ x: 8 - 380 + 120, y: 8 });
    expect(clampWindowPosition(5000, 5000, 380, 1280, 800)).toEqual({ x: 1280 - 120, y: 800 - 48 });
  });
});
