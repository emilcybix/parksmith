import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it } from 'vitest';
import { registerGameCommands, type GameCommands } from '../app/gameBridge';
import type { ThoughtInsight } from '../game/guests/types';
import type { ManagementSnapshot, OperationsComfort } from '../game/management/types';
import { ParkSession } from '../game/session/ParkSession';
import type { BuildingSnapshot } from '../game/session/types';
import { buildingRowDetail, InsightLine, ManagementDashboard } from './ManagementDashboard';
import { useUiStore } from './store';

/**
 * Phase 30 (MGMT package): the dashboard's comfort chip row, the SICK PILES cell, the souvenir estate row detail, the
 * "→ building" link on repeated thoughts (Overview and Activity) and the reworded Buildings advice. No DOM: markup is
 * rendered on the server from a patched initial store (the phase11Markup pattern); the link's click is reached by
 * walking the element tree (the cardPlay pattern).
 */

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

/** Every element in a tree of plain (hook-free) elements, function components expanded. */
const elementsOf = (node: ReactNode): ReactElement<Record<string, unknown>>[] => {
  if (Array.isArray(node)) return node.flatMap(elementsOf);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  if (typeof node.type === 'function') return elementsOf((node.type as (props: unknown) => ReactNode)(node.props));
  return [node, ...elementsOf(node.props.children as ReactNode)];
};

const baseManagement: ManagementSnapshot = new ParkSession(null).management.snapshot();
const COMFORT: OperationsComfort = { tired: 3, queasy: 0, hot: 1, cold: 0, soaked: 2, resting: 4, sickPiles: 2 };
const withComfort = (comfort: OperationsComfort | undefined): ManagementSnapshot => ({
  ...baseManagement,
  operations: comfort ? { ...baseManagement.operations, comfort } : baseManagement.operations,
});

const insight = (patch: Partial<ThoughtInsight> = {}): ThoughtInsight => ({
  text: 'guests are tired of queueing', count: 6, objectId: null, objectName: null, ...patch,
});
const LINKED = insight({ objectId: 12, objectName: 'Cloud Hopper' });
const PRICE = insight({ text: 'guests find prices too high', count: 2, objectId: 9, objectName: 'Fizz Foundry' });

const overview = (patch: Patch): string => renderWith({ managementOpen: true, managementTab: 'overview', management: withComfort(COMFORT), ...patch }, <ManagementDashboard />);
const activity = (patch: Patch): string => renderWith({ managementOpen: true, managementTab: 'activity', management: withComfort(COMFORT), ...patch }, <ManagementDashboard />);

afterEach(() => registerGameCommands(null));

describe('Overview: the comfort chip row', () => {
  it('renders the six chips after the need chips, attention only on the first five and only when someone is affected', () => {
    const html = overview({});
    const chips = html.slice(html.indexOf('<div class="need-chips comfort-chips"'), html.indexOf('</div>', html.indexOf('<div class="need-chips comfort-chips"')));
    expect(chips).toContain('role="group" aria-label="Guest comfort"');
    expect(chips).toContain('<span class="attention">Tired <b>3</b></span>');
    expect(chips).toContain('<span class="">Queasy <b>0</b></span>');
    expect(chips).toContain('<span class="attention">Too hot <b>1</b></span>');
    expect(chips).toContain('<span class="">Cold <b>0</b></span>');
    expect(chips).toContain('<span class="attention">Soaked <b>2</b></span>');
    // Resting is a good thing: never attention, even with four guests on benches.
    expect(chips).toContain('<span class="">Resting <b>4</b></span>');
    expect(chips.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()).toBe('Tired 3 Queasy 0 Too hot 1 Cold 0 Soaked 2 Resting 4');
    // Below the need chips, inside the same Flow and demand section.
    expect(html.indexOf('Need toilet')).toBeLessThan(html.indexOf('comfort-chips'));
    expect(html.indexOf('comfort-chips')).toBeLessThan(html.indexOf('Live signals'));
  });

  it('is absent when the snapshot carries no comfort counts (guest life switched off, older snapshots)', () => {
    const html = overview({ management: withComfort(undefined) });
    expect(html).not.toContain('comfort-chips');
    expect(html).not.toContain('Tired');
    expect(html).toContain('Need toilet');
  });
});

describe('Operations: sick piles', () => {
  const operations = (comfort: OperationsComfort | undefined): string => renderWith({ managementOpen: true, managementTab: 'operations', management: withComfort(comfort) }, <ManagementDashboard />);

  it('adds a SICK PILES cell to the Park care grid, warning when there are any', () => {
    expect(operations(COMFORT)).toContain('<span class="warning"><small>SICK PILES</small><strong>2</strong></span>');
    expect(operations({ ...COMFORT, sickPiles: 0 })).toContain('<span class=""><small>SICK PILES</small><strong>0</strong></span>');
    const html = operations(COMFORT);
    expect(html.indexOf('AVG. BIN FILL')).toBeLessThan(html.indexOf('SICK PILES'));
  });

  it('shows no cell without comfort counts', () => {
    expect(operations(undefined)).not.toContain('SICK PILES');
  });
});

describe('Buildings: the souvenir row detail', () => {
  it('derives the keepsake line from the definition and keeps every other row detail as the snapshot wrote it', () => {
    expect(buildingRowDetail({ definitionId: 'brolly-booth', detail: '2.2s per guest · relieves 0' })).toBe('Umbrellas · sell in the rain');
    expect(buildingRowDetail({ definitionId: 'glow-cart', detail: '1.8s per guest · relieves 0' })).toBe('Glow wands · sell at night');
    expect(buildingRowDetail({ definitionId: 'picnic-pocket', detail: '2.5s per guest · relieves 40' })).toBe('2.5s per guest · relieves 40');
    expect(buildingRowDetail({ definitionId: 'no-such-thing', detail: 'as saved' })).toBe('as saved');
  });

  it('every souvenir stall in the catalog has its own line, and no estate row of theirs says "relieves 0"', () => {
    const session = new ParkSession(null);
    const stalls: BuildingSnapshot[] = [];
    for (const definitionId of ['brolly-booth', 'hat-hutch', 'balloon-bouquet', 'plushie-parlour', 'glow-cart']) {
      let placed = false;
      for (let y = 2; y < 40 && !placed; y += 1) {
        for (let x = 2; x < 40 && !placed; x += 1) {
          if (session.world.buildObject(definitionId, { x, y })) placed = true;
        }
      }
    }
    session.shops.syncWithWorld();
    session.rides.syncWithWorld();
    stalls.push(...session.buildingsSnapshot().filter((row) => row.group === 'souvenir'));
    expect(stalls.length).toBe(5);
    // The saved snapshot string is untouched (it is in the determinism observables).
    for (const row of stalls) expect(row.detail).toContain('relieves 0');
    const html = renderWith({ managementOpen: true, managementTab: 'buildings', management: session.management.snapshot(), buildings: stalls, noPathAccessIds: [] }, <ManagementDashboard />);
    expect(html).not.toContain('relieves 0');
    for (const line of ['Umbrellas · sell in the rain', 'Sun hats · sell in the heat', 'Balloons · sell any time', 'Plush toys · sell any time', 'Glow wands · sell at night']) {
      expect(html).toContain(`<small>${line}</small>`);
    }
    expect(html).toContain('Select a row to centre the camera on it. Rides, stalls and facilities also open their inspector.');
  });
});

describe('the "→ building" link on repeated thoughts', () => {
  it('Overview Live signals: a linked insight carries a native button inside its text cell; an unlinked one does not', () => {
    const html = overview({ pulseInsights: [LINKED, insight({ text: 'guests want a drink', count: 4 })] });
    const signals = html.slice(html.indexOf('Live signals'));
    expect(signals).toContain('<p><i aria-hidden="true">✦</i><strong>6</strong><span>guests are tired of queueing <button type="button" class="insight-link" title="Show Cloud Hopper and open its inspector" aria-label="Show Cloud Hopper"><span aria-hidden="true">→ </span>Cloud Hopper</button></span></p>');
    expect(signals).toContain('<p><i aria-hidden="true">✦</i><strong>4</strong><span>guests want a drink</span></p>');
    expect((signals.match(/insight-link/g) ?? []).length).toBe(1);
  });

  it('Activity Repeated thoughts: every insight renders, linked ones with the button', () => {
    const html = activity({ pulseInsights: [LINKED, PRICE, insight({ text: 'guests are hungry', count: 1 })] });
    const thoughts = html.slice(html.indexOf('Repeated thoughts'));
    expect(thoughts).toContain('<span aria-hidden="true">→ </span>Cloud Hopper</button>');
    expect(thoughts).toContain('<strong>2</strong><span>guests find prices too high <button type="button" class="insight-link" title="Show Fizz Foundry and open its inspector" aria-label="Show Fizz Foundry"><span aria-hidden="true">→ </span>Fizz Foundry</button></span>');
    expect(thoughts).toContain('<strong>1</strong><span>guests are hungry</span>');
    expect((thoughts.match(/insight-link/g) ?? []).length).toBe(2);
  });

  it('an insight whose object is gone (objectName null) renders no link even if an id lingers', () => {
    const html = activity({ pulseInsights: [insight({ objectId: 12, objectName: null })] });
    expect(html).not.toContain('insight-link');
  });

  it('pressing the link calls gameBridge.focusBuilding with the object id', () => {
    const calls: number[] = [];
    registerGameCommands({ focusBuilding: (objectId: number) => calls.push(objectId) } as unknown as GameCommands);
    const button = elementsOf(<InsightLine insight={PRICE} />).find((element) => element.type === 'button');
    expect(button).toBeDefined();
    (button!.props.onClick as () => void)();
    expect(calls).toEqual([9]);
  });

  it('the link is a plain button, never nested in another control (the line is a paragraph)', () => {
    const elements = elementsOf(<InsightLine insight={LINKED} />).filter((element) => typeof element.type === 'string');
    expect(elements.map((element) => element.type)).toEqual(['p', 'i', 'strong', 'span', 'button', 'span']);
  });
});
