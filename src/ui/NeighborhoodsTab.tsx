import { gameBridge } from '../app/gameBridge';
import {
  BAND_WORDS,
  coverageChips,
  NEIGHBORHOODS_ADVICE,
  NEIGHBORHOODS_EMPTY,
  NEIGHBORHOODS_KICKER,
  NEIGHBORHOODS_NOTICED_EMPTY,
  NEIGHBORHOODS_NOTICED_KICKER,
  NEIGHBORHOODS_TITLE,
  neighborhoodKpis,
  neighborhoodMetricCells,
  unreachedLine,
} from './neighborhoodModel';
import type { NeighborhoodRow as Row } from './neighborhoodTypes';
import { useUiStore } from './store';

/**
 * Phase 14: switch the crowd heatmap on or off from the UI (the rail toggle and a bottleneck row). The two ground heatmaps
 * are exclusive, so turning the crowd one on turns the scenery one off, in the store and through the bridge (GameApp
 * enforces the same; the calls are idempotent). With the classic renderer the store keeps it off and the bridge call
 * only lets GameApp say why (its toast).
 */
export const setCrowdHeatmap = (visible: boolean): void => {
  const state = useUiStore.getState();
  if (!state.crowdHeatmapSupported) {
    gameBridge.setCrowdHeatmapVisible(visible);
    return;
  }
  if (visible && state.showSceneryInfluence) {
    state.setSceneryInfluenceVisible(false);
    gameBridge.setSceneryInfluenceVisible(false);
  }
  state.setCrowdHeatmapVisible(visible);
  gameBridge.setCrowdHeatmapVisible(visible);
};

const focusRow = (row: Row): void => {
  // Owner default (design Q12.7): a bottleneck row lights the crowd heatmap so the jam is visible where the camera lands.
  if (row.bottleneck !== null && useUiStore.getState().crowdHeatmapSupported && !useUiStore.getState().showCrowdHeatmap) setCrowdHeatmap(true);
  gameBridge.focusNeighborhood(row.key);
};

const NeighborhoodRowButton = ({ row }: { row: Row }): React.JSX.Element => (
  <button
    className={`neighborhood-row band-${row.band}${row.bottleneck !== null ? ' has-bottleneck' : ''}`}
    onClick={() => focusRow(row)}
    title={`Show ${row.name} on the map`}
  >
    <span className="neighborhood-identity">
      <strong>{row.name}</strong>
      <small>{row.subtitle}</small>
    </span>
    <span className={`neighborhood-band band-${row.band}`}>
      <small>CROWD</small>
      <strong>{row.bandWord}</strong>
    </span>
    <span className="neighborhood-metrics">
      {neighborhoodMetricCells(row).map((cell) => (
        <span key={cell.label} className="neighborhood-metric" title={cell.title}>
          <small>{cell.label}</small><strong>{cell.value}</strong>
        </span>
      ))}
    </span>
    <span className="neighborhood-coverage">
      {coverageChips(row.coverage).map((chip) => (
        <span key={chip.kind} className={`coverage-chip ${chip.tone}`} title={chip.title}>{chip.text}</span>
      ))}
    </span>
  </button>
);

export const NeighborhoodsTab = (): React.JSX.Element => {
  const crowd = useUiStore((state) => state.crowd);
  const rows = crowd?.rows ?? null;
  const lines = crowd?.noticed ?? crowd?.lines ?? [];
  const kpis = neighborhoodKpis(rows ?? []);
  const unreached = unreachedLine(crowd?.unreachedCount ?? 0);
  return (
    <div className="management-tab-panel" role="tabpanel" id="management-neighborhoods" aria-labelledby="management-tab-neighborhoods">
      <div className="management-kpis">
        <span><small>NEIGHBORHOODS</small><strong>{rows === null ? '—' : kpis.count}</strong></span>
        <span><small>BUSIEST</small><strong className="kpi-name">{kpis.busiest ?? '—'}</strong></span>
        <span className={kpis.bottlenecks > 0 ? 'warning' : ''}><small>BOTTLENECKS</small><strong>{rows === null ? '—' : kpis.bottlenecks}</strong></span>
        <span><small>GUESTS WALKING</small><strong>{rows === null ? '—' : kpis.walking}</strong></span>
      </div>

      <section className="management-section">
        <header><span><small>{NEIGHBORHOODS_NOTICED_KICKER}</small><strong>Park Pulse</strong></span></header>
        <div className="dashboard-insights crowd-lines">
          {lines.length > 0
            ? lines.map((line) => <p key={line}><i aria-hidden="true">≋</i><span>{line}</span></p>)
            : <p className="empty-copy">{NEIGHBORHOODS_NOTICED_EMPTY}</p>}
        </div>
      </section>

      <section className="management-section neighborhoods-section">
        <header>
          <span><small>{NEIGHBORHOODS_KICKER}</small><strong>{NEIGHBORHOODS_TITLE}</strong></span>
        </header>
        <ul className="crowd-legend" aria-label="Crowd flow heatmap colours">
          {BAND_WORDS.map((word, band) => (
            <li key={word} className={`band-${band}`}><i aria-hidden="true" />{word}</li>
          ))}
        </ul>
        <div className="neighborhood-list" role="group" aria-label="Neighborhoods, gate first">
          {rows === null
            ? <p className="management-loading">Collecting park data…</p>
            : rows.length > 0
              ? rows.map((row) => <NeighborhoodRowButton key={row.key} row={row} />)
              : <p className="empty-copy">{NEIGHBORHOODS_EMPTY}</p>}
        </div>
        {unreached !== null && <p className="neighborhoods-unreached" role="note">{unreached}</p>}
        {rows !== null && rows.length > 0 && <p className="operations-advice">{NEIGHBORHOODS_ADVICE}</p>}
      </section>
    </div>
  );
};
