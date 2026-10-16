import { useRef, useState } from 'react';
import { gameBridge } from '../app/gameBridge';
import { BUILD_BY_ID } from '../game/content/catalog';
import type { BuildingSnapshot } from '../game/session/types';
import {
  COLUMN_LABELS,
  GROUP_FILTERS,
  STATE_FILTERS,
  buildingsWindowView,
  columnsFor,
  nextSort,
  type BuildingColumn,
} from './buildingsWindowModel';
import { formatMoney } from './format';
import { lacksPathAccess } from './pathAccessModel';
import { useUiStore } from './store';
import { WindowFrame } from './WindowFrame';
import { reducedMotion } from '../settings/motion';

/**
 * Phase 42: the Buildings window (a lazy chunk): every placed building, filtered by group and state and searched by
 * name (the filters combine; the counts are what each would show), sorted by any column in both directions. A row
 * centres the camera; its actions open the inspector, open or close it, and change its price. Selected rows can be
 * opened or closed together. The rows are the 250 ms `buildingsSnapshot`, refreshed only while the window is open.
 */
const cell = (row: BuildingSnapshot, column: BuildingColumn): string => {
  switch (column) {
    case 'name': return row.name;
    case 'price': return row.price === null ? '—' : `$${row.price.toFixed(2)}`;
    case 'queue': return row.queueLength === null ? '—' : String(row.queueLength);
    case 'wait': return row.waitSeconds === null ? '—' : `${Math.round(row.waitSeconds)}s`;
    case 'served': return row.served === null ? '—' : String(row.served);
    case 'throughput': return row.throughputPerHour === null ? '—' : String(Math.round(row.throughputPerHour));
    case 'revenue': return row.revenue === null ? '—' : formatMoney(row.revenue);
    case 'satisfaction': return row.satisfaction === null ? '—' : `${Math.round(row.satisfaction)}%`;
    case 'condition': return row.condition === null ? '—' : `${Math.round(row.condition)}%`;
    default: return row.sceneryScore === null ? '—' : String(Math.round(row.sceneryScore));
  }
};

const stateKey = (row: BuildingSnapshot): string => `${row.open}|${row.status}`;

export const BuildingsWindowBody = (): React.JSX.Element => {
  const buildings = useUiStore((state) => state.buildings);
  const noPathAccessIds = useUiStore((state) => state.noPathAccessIds);
  const view = useUiStore((state) => state.buildingsView);
  const setView = useUiStore((state) => state.setBuildingsView);
  const [selected, setSelected] = useState<ReadonlySet<number>>(new Set());
  const lastState = useRef(new Map<number, string>());
  const close = (): void => useUiStore.getState().closeWindow('buildings');
  const shown = buildingsWindowView(buildings, view, (id) => lacksPathAccess(noPathAccessIds, id));
  const columns = columnsFor(view.group);
  const reduced = reducedMotion();
  // A row whose open state or status changed since the last refresh flashes once (not with reduced motion).
  const changed = new Set<number>();
  for (const row of buildings) {
    const key = stateKey(row);
    const before = lastState.current.get(row.objectId);
    if (before !== undefined && before !== key && !reduced) changed.add(row.objectId);
    lastState.current.set(row.objectId, key);
  }
  const selectedIds = shown.rows.filter((row) => selected.has(row.objectId)).map((row) => row.objectId);
  const toggle = (id: number): void => setSelected((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  return (
    <WindowFrame id="buildings" title="Buildings" dockOffset={24} onClose={close}>
      <input
        className="window-search"
        type="search"
        placeholder="Search by name"
        aria-label="Search buildings by name"
        value={view.search}
        maxLength={40}
        onChange={(event) => setView({ search: event.target.value })}
      />
      <div className="window-chips" role="group" aria-label="Filter by group">
        {GROUP_FILTERS.map((filter) => (
          <button key={filter.id} className={view.group === filter.id ? 'active' : ''} aria-pressed={view.group === filter.id}
            onClick={() => setView({ group: filter.id })}>{filter.label} <b>{shown.groupCounts[filter.id]}</b></button>
        ))}
      </div>
      <div className="window-chips" role="group" aria-label="Filter by state">
        {STATE_FILTERS.map((filter) => (
          <button key={filter.id} className={view.state === filter.id ? 'active' : ''} aria-pressed={view.state === filter.id}
            onClick={() => setView({ state: filter.id })}>{filter.label} <b>{shown.stateCounts[filter.id]}</b></button>
        ))}
      </div>
      <div className="window-bulk" role="group" aria-label="Selected buildings">
        <span>{selectedIds.length} selected</span>
        <button disabled={selectedIds.length === 0} onClick={() => gameBridge.setObjectsOpen(selectedIds, true)}>Open</button>
        <button disabled={selectedIds.length === 0} onClick={() => gameBridge.setObjectsOpen(selectedIds, false)}>Close</button>
        <button disabled={selectedIds.length === 0} onClick={() => setSelected(new Set())}>Clear</button>
      </div>
      <table className="buildings-table">
        <thead>
          <tr>
            <th scope="col"><span className="sr-only">Select</span></th>
            {columns.map((column) => (
              <th key={column} scope="col" aria-sort={view.sort === column ? (view.descending ? 'descending' : 'ascending') : 'none'}>
                <button onClick={() => setView(nextSort(view, column))}>
                  {COLUMN_LABELS[column]}{view.sort === column ? (view.descending ? ' ▾' : ' ▴') : ''}
                </button>
              </th>
            ))}
            <th scope="col">Actions</th>
          </tr>
        </thead>
        <tbody>
          {shown.rows.map((row) => {
            const definition = BUILD_BY_ID.get(row.definitionId);
            const inspectable = definition?.kind === 'ride' || definition?.stats?.serviceType !== undefined;
            return (
              <tr key={row.objectId} className={`${changed.has(row.objectId) ? 'flash ' : ''}${lacksPathAccess(noPathAccessIds, row.objectId) ? 'no-access' : ''}`}>
                <td>
                  <input type="checkbox" checked={selected.has(row.objectId)} onChange={() => toggle(row.objectId)} aria-label={`Select ${row.name}`} disabled={row.open === null} />
                </td>
                {columns.map((column) => (
                  <td key={column}>
                    {column === 'name'
                      ? <button className="row-name" onClick={() => gameBridge.centreBuilding(row.objectId)} title={`Show ${row.name}`}>{row.icon} {row.name}</button>
                      : cell(row, column)}
                  </td>
                ))}
                <td className="row-actions">
                  {inspectable && <button onClick={() => gameBridge.focusBuilding(row.objectId)} aria-label={`Inspect ${row.name}`} title="Inspect">ⓘ</button>}
                  {row.open !== null && (
                    <button onClick={() => gameBridge.setObjectsOpen([row.objectId], !row.open)} aria-label={`${row.open ? 'Close' : 'Open'} ${row.name}`}>
                      {row.open ? 'Close' : 'Open'}
                    </button>
                  )}
                  {row.price !== null && (
                    <>
                      <button onClick={() => gameBridge.adjustObjectPrice(row.objectId, -0.5)} aria-label={`Lower the price of ${row.name}`}>−</button>
                      <button onClick={() => gameBridge.adjustObjectPrice(row.objectId, 0.5)} aria-label={`Raise the price of ${row.name}`}>+</button>
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {shown.rows.length === 0 && <p className="empty-copy">{buildings.length === 0 ? 'Nothing built yet.' : 'No building matches these filters.'}</p>}
    </WindowFrame>
  );
};
