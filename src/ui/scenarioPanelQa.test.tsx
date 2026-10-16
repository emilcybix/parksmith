import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ParkSession } from '../game/session/ParkSession';
import { SCENARIO_BY_ID } from '../game/scenarios/content';
import { ScenarioPanel } from './ScenarioHud';
import { useUiStore } from './store';

/** QA findings (2026-10-14): the sustain hold reads its real time, and a "reach" objective shows no straight-line pace. */
const panelFor = (scenarioId: 'frost-fair' | 'room-to-grow', ticks: number): string => {
  const session = new ParkSession(SCENARIO_BY_ID.get(scenarioId)!);
  for (let tick = 0; tick < ticks; tick += 1) session.step(100);
  // Server rendering reads the store's initial state (as in cardPlay.test.tsx): patch it for one render.
  const seed = useUiStore.getInitialState() as unknown as Record<string, unknown>;
  const saved = { scenario: seed.scenario, sessionMode: seed.sessionMode };
  Object.assign(seed, { scenario: session.scenarioSnapshot(), sessionMode: 'scenario' });
  try {
    return renderToStaticMarkup(<ScenarioPanel />);
  } finally {
    Object.assign(seed, saved);
  }
};


describe('scenario panel copy', () => {
  it('a sustain objective says how long to hold', () => {
    const html = panelFor('frost-fair', 10);
    expect(html).toMatch(/for 6:00\./);
    expect(html).not.toMatch(/for 0:00/);
  });

  it('a reach objective (owned parcels) shows progress but no pace extrapolation', () => {
    const html = panelFor('room-to-grow', 30);
    expect(html).toContain('12 of 20');
    expect(html).not.toContain('pace →');
  });
});
