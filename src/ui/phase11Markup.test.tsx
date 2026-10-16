import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GuestCapacityView } from '../game/guests/GuestSimulation';
import type { ManagementSnapshot } from '../game/management/types';
import { ParkSession } from '../game/session/ParkSession';
import { BuildDock, CursorReadout, ParkPulse, RideInspector, ServiceInspector, TopBar, ViewRotateButtons } from './Hud';
import { ManagementDashboard } from './ManagementDashboard';
import { CAPACITY_BLOCKED_TEXT, CAPACITY_INSIGHT } from './capacityModel';
import { FACTOR_SORT_NOTE, ratingFactorRows } from './ratingFactorModel';
import { NO_PATH_ACCESS_NOTE } from './pathAccessModel';
import { useUiStore } from './store';

/**
 * Phase 11 (design PA-009, PA-016, PA-015, PA-022, PA-021, PA-024): the HUD and dashboard markup for park capacity, the
 * sorted rating factors, inspector demolition, the Rotate badge, the recentre button and the no-path-access copy. No
 * DOM: the markup is rendered on the server from a patched initial store (the phase16Markup pattern), so the focus
 * moves of the demolish confirmation are checked in the browser audit, not here.
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

const count = (html: string, pattern: RegExp): number => (html.match(pattern) ?? []).length;

const VIEW: GuestCapacityView = { ceiling: 52, rideSeats: 38, rating: 61, crowdMultiplier: 1, hardMaximum: 1000, blocked: null };

/** A fresh park with one object of `definitionId` at the first cell that takes it (no path: it has no access). */
const parkWith = (definitionId: string): { session: ParkSession; objectId: number } => {
  const session = new ParkSession(null);
  for (let y = 2; y < 40; y += 1) {
    for (let x = 2; x < 40; x += 1) {
      const object = session.world.buildObject(definitionId, { x, y });
      if (!object) continue;
      session.rides.syncWithWorld();
      session.shops.syncWithWorld();
      return { session, objectId: object.id };
    }
  }
  throw new Error(`${definitionId} found no free cell`);
};

describe('PA-009: Park Pulse capacity', () => {
  const pulseStats = (html: string): string => html.slice(html.indexOf('<div class="pulse-stats">'), html.indexOf('<div class="pulse-insights">'));

  it('labels the guest count with the ceiling; the number stays the count', () => {
    const html = renderWith({ guestCount: 41, guestCapacity: VIEW }, <ParkPulse />);
    expect(pulseStats(html)).toContain('<span class="pulse-guests"><strong>41</strong><small>of 52 guests</small></span>');
    expect(html).not.toContain('at-capacity');
  });

  it('says just "guests" before a view is published and while blocked', () => {
    expect(pulseStats(renderWith({ guestCount: 0 }, <ParkPulse />))).toContain('<strong>0</strong><small>guests</small>');
    const blocked = renderWith({ guestCount: 3, guestCapacity: { ...VIEW, ceiling: 0, blocked: 'park-closed' } }, <ParkPulse />);
    expect(pulseStats(blocked)).toContain('<strong>3</strong><small>guests</small>');
  });

  it('at capacity: the amber number and the insight line, below weather and above guest thoughts', () => {
    const thoughts = [{ text: 'guests want a drink', count: 4, objectId: null, objectName: null }, { text: 'guests are hungry', count: 2, objectId: null, objectName: null }, { text: 'guests want a bin', count: 2, objectId: null, objectName: null }];
    const html = renderWith({ guestCount: 52, guestCapacity: VIEW, atCapacity: true, pulseInsights: thoughts }, <ParkPulse />);
    expect(pulseStats(html)).toContain('<strong class="at-capacity">52</strong><small>of 52 guests</small>');
    const insights = html.slice(html.indexOf('<div class="pulse-insights">'));
    // Phase 30 revised the budget to three lines: capacity, then the two most common thoughts; the third thought waits.
    expect(insights).toMatch(new RegExp(`^<div class="pulse-insights"><p class="pulse-capacity"><span aria-hidden="true">◍</span>${CAPACITY_INSIGHT}</p><p><span aria-hidden="true">✦</span><strong>4</strong> guests want a drink</p><p><span aria-hidden="true">✦</span><strong>2</strong> guests are hungry</p></div>`));
    expect(count(insights.slice(0, insights.indexOf('</div>')), /<p/g)).toBe(3);
    expect(insights).not.toContain('guests want a bin');
  });

  it('the 1000 / of 1000 guests label renders unbroken (the layout audit measures its width)', () => {
    const html = renderWith({ guestCount: 1000, guestCapacity: { ...VIEW, ceiling: 1000 } }, <ParkPulse />);
    expect(pulseStats(html)).toContain('<strong>1000</strong><small>of 1000 guests</small>');
  });
});

describe('PA-009 and PA-016: the Overview', () => {
  const management: ManagementSnapshot = new ParkSession(null).management.snapshot();
  const overview = (patch: Patch): string => renderWith({ managementOpen: true, managementTab: 'overview', management, ...patch }, <ManagementDashboard />);

  it('the GUESTS KPI shows "of N"; nothing while blocked or unknown', () => {
    expect(overview({ guestCapacity: VIEW })).toContain(`<small>GUESTS</small><strong>${management.guestCount} <small class="kpi-of">of 52</small></strong>`);
    expect(overview({})).toContain(`<small>GUESTS</small><strong>${management.guestCount}</strong>`);
    expect(overview({ guestCapacity: { ...VIEW, blocked: 'after-hours', ceiling: 0 } })).not.toContain('kpi-of');
  });

  it('the Park capacity section follows the rating section', () => {
    const html = overview({ guestCapacity: { ...VIEW, crowdMultiplier: 1.5 }, atCapacity: false });
    const rating = html.indexOf('rating-section');
    const capacity = html.indexOf('<section class="management-section capacity-section">');
    expect(rating).toBeGreaterThan(0);
    expect(capacity).toBeGreaterThan(rating);
    expect(html.indexOf('LIVE OPERATIONS')).toBeGreaterThan(capacity);
    expect(html).toContain(`<header><span><small>PARK CAPACITY</small><strong>Guest ceiling</strong></span><b>${management.guestCount}/52</b></header>`);
    expect(html).toContain('<p class="capacity-text">Open rides seat 38 guests at a time and the park rating is 61. More ride seats or a higher rating raise the ceiling. Active cards scale it ×1.5.</p>');
  });

  it('each blocked reason is the paragraph; at capacity the ratio takes the warning tone', () => {
    for (const blocked of ['park-closed', 'after-hours', 'too-few-paths', 'no-open-ride'] as const) {
      const html = overview({ guestCapacity: { ...VIEW, ceiling: 0, blocked } });
      expect(html).toContain(`<p class="capacity-text">${CAPACITY_BLOCKED_TEXT[blocked]}</p>`);
      expect(html).toContain(`<b>${management.guestCount}/0</b>`);
    }
    const full = overview({ guestCapacity: VIEW, atCapacity: true });
    expect(full).toContain('<b class="warning">');
    expect(full).toContain('The park is full: no new guests arrive until someone leaves.');
    expect(overview({})).not.toContain('capacity-section');
  });

  it('factor rows are sorted biggest gain first, each with its weight line, under the sort note', () => {
    const html = overview({});
    const rows = ratingFactorRows(management.rating.factors);
    const labels = [...html.matchAll(/<div class="rating-factor"><span><strong>([^<]+)<\/strong>/g)].map((match) => match[1]);
    expect(labels).toEqual(rows.map((row) => row.factor.label));
    expect(rows[0].gain).toBeGreaterThanOrEqual(rows[rows.length - 1].gain);
    expect(count(html, /<em class="factor-weight">\d+% of the rating · (?:\d+ pts? to gain|full marks)<\/em>/g)).toBe(rows.length);
    expect(html).toContain(`<em class="factor-weight">${rows[0].weightLine}</em></span><div aria-hidden="true">`);
    expect(html).toMatch(new RegExp(`<p class="factor-sort-note">${FACTOR_SORT_NOTE}</p><div class="rating-factors">`));
  });
});

describe('PA-015: demolish from the inspector', () => {
  it('a ride inspector ends with the Demolish button (before the DEV action) and its refund', () => {
    const { session, objectId } = parkWith('moonpetal-carousel');
    const ride = session.rides.snapshot(objectId)!;
    const refund = session.world.demolitionRefund(objectId)!;
    const html = renderWith({ selectedRide: ride, selectedDemolitionRefund: refund }, <RideInspector />);
    expect(html).toContain(`>Demolish · refund $${refund.toLocaleString('en-US')}</button></div>`);
    expect(html).toMatch(/<\/dl><div class="inspector-demolish"><button class="demolish-button" aria-keyshortcuts="Delete Backspace" title="Demolish [^"]+ \(Delete \/ Backspace\)">/);
    expect(html).not.toContain('role="group" aria-label="Confirm demolition"');
  });

  it('with the confirmation open, the group replaces the button: question, Keep it, then Demolish', () => {
    const { session, objectId } = parkWith('moonpetal-carousel');
    const ride = session.rides.snapshot(objectId)!;
    const html = renderWith({ selectedRide: ride, selectedDemolitionRefund: 340, demolishConfirmId: objectId }, <RideInspector />);
    expect(html).toContain(`<div class="demolish-confirm" role="group" aria-label="Confirm demolition"><p>Demolish ${ride.name}? You get $340 back.</p><div class="demolish-confirm-actions"><button class="demolish-keep">Keep it</button><button class="demolish-confirm-button">Demolish</button></div></div>`);
    expect(html).not.toContain('demolish-button');
    // Another object's open confirmation is not this inspector's.
    expect(renderWith({ selectedRide: ride, demolishConfirmId: objectId + 1 }, <RideInspector />)).toContain('>Demolish</button>');
  });

  it('a service inspector has the same control, last', () => {
    const { session, objectId } = parkWith('fizz-foundry');
    const service = session.shops.snapshot(objectId)!;
    const html = renderWith({ selectedService: service, selectedDemolitionRefund: 12 }, <ServiceInspector />);
    expect(html).toMatch(/<\/dl><div class="inspector-demolish"><button class="demolish-button"[^>]*>Demolish · refund \$12<\/button><\/div><\/aside>$/);
    const open = renderWith({ selectedService: service, selectedDemolitionRefund: 12, demolishConfirmId: objectId }, <ServiceInspector />);
    expect(open).toContain(`<p>Demolish ${service.name}? You get $12 back.</p>`);
  });
});

describe('PA-015: the armed coaster readout', () => {
  it('says the armed text once (title); the small line keeps the cell', () => {
    const armed = 'Click again to demolish Comet Coaster (the whole coaster) · refund $340';
    const html = renderWith({ hoveredCell: { x: 7, y: 9 }, tool: 'bulldoze', previewValid: false, previewTitle: armed, previewBlock: armed }, <CursorReadout />);
    expect(count(html, /Click again to demolish/g)).toBe(1);
    expect(html).toContain(`<strong>${armed}</strong><small>7, 9</small>`);
    // Another block (a refusal reason) still replaces the cell.
    const other = renderWith({ hoveredCell: { x: 7, y: 9 }, tool: 'bulldoze', previewTitle: 'Clear', previewBlock: 'Nothing to clear here' }, <CursorReadout />);
    expect(other).toContain('<small>Nothing to clear here</small>');
  });
});

describe('PA-022: the Rotate badge', () => {
  const rotateButton = (html: string): string => html.slice(html.indexOf('<button class="rotate-tab'), html.indexOf('</button>', html.indexOf('<button class="rotate-tab')) + 9);

  it('no badge at 0°; 90° and 270° add the state and the rotated class, the name starts with "Rotate"', () => {
    expect(rotateButton(renderWith({ buildRotation: 0 }, <BuildDock />))).toMatch(/^<button class="rotate-tab"[^>]*><span aria-hidden="true">⟳<\/span>Rotate<\/button>$/);
    for (const [rotation, degrees] of [[1, 90], [3, 270]] as const) {
      const button = rotateButton(renderWith({ buildRotation: rotation }, <BuildDock />));
      expect(button).toMatch(new RegExp(`^<button class="rotate-tab rotated"[^>]*><span aria-hidden="true">⟳</span>Rotate<b class="rotate-state"><span class="sr-only">, now turned </span>${degrees}°</b></button>$`));
      expect(button).toContain(`aria-label="Rotate, now turned ${degrees}°"`);
      // The accessible name (aria-hidden text dropped): "Rotate, now turned 90°".
      expect(button.replace(/<span aria-hidden="true">[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '')).toBe(`Rotate, now turned ${degrees}°`);
    }
  });

  it('the cursor readout carries the same angle', () => {
    const base: Patch = { hoveredCell: { x: 4, y: 5 }, tool: 'build', selectedDefinitionId: 'fizz-foundry' };
    expect(renderWith({ ...base, buildRotation: 1 }, <CursorReadout />)).toMatch(/<em class="cursor-rotation">⟳ 90° · \d+×\d+ · R to rotate<\/em>/);
    expect(renderWith({ ...base, buildRotation: 0 }, <CursorReadout />)).toMatch(/<em class="cursor-rotation">⟳ \d+×\d+ · R to rotate<\/em>/);
  });
});

describe('PA-021: recentre', () => {
  it('the Map view group ends with ⌂ after a hairline, named from the registry', () => {
    const html = renderWith({}, <ViewRotateButtons />);
    expect(html).toMatch(/^<div class="view-rotate" role="group" aria-label="Map view">/);
    expect(html).toMatch(/<span aria-hidden="true">↻<\/span><\/button><i class="view-divider" aria-hidden="true"><\/i><button class="view-recentre" aria-label="Recentre view · V" aria-keyshortcuts="v" title="Recentre on the park entrance \(V\)"><span aria-hidden="true">⌂<\/span><\/button><\/div>$/);
  });

  it('the brand button keeps its title', () => {
    expect(renderWith({}, <TopBar />)).toContain('title="Center camera on the park entrance"');
  });
});

describe('PA-024: no path access', () => {
  it('the inspector note sits under the state row, for rides and services', () => {
    const ride = parkWith('moonpetal-carousel');
    const rideSnapshot = ride.session.rides.snapshot(ride.objectId)!;
    const html = renderWith({ selectedRide: rideSnapshot, noPathAccessIds: [ride.objectId] }, <RideInspector />);
    expect(html).toMatch(new RegExp(`</button></div><p class="inspector-warning" role="note">${NO_PATH_ACCESS_NOTE}</p>`));
    expect(renderWith({ selectedRide: rideSnapshot, noPathAccessIds: [] }, <RideInspector />)).not.toContain('inspector-warning');
    const shop = parkWith('fizz-foundry');
    const shopHtml = renderWith({ selectedService: shop.session.shops.snapshot(shop.objectId)!, noPathAccessIds: [shop.objectId] }, <ServiceInspector />);
    expect(shopHtml).toContain(`<p class="inspector-warning" role="note">${NO_PATH_ACCESS_NOTE}</p>`);
  });

  it('the estate row appends " · no path access" and takes the no-access class', () => {
    const { session, objectId } = parkWith('moonpetal-carousel');
    const buildings = session.buildingsSnapshot();
    const html = renderWith({ managementOpen: true, managementTab: 'buildings', management: session.management.snapshot(), buildings, noPathAccessIds: [objectId] }, <ManagementDashboard />);
    expect(count(html, /<button class="building-row no-access"/g)).toBe(1);
    expect(html).toMatch(/<em>[^<]+ · no path access<\/em>/);
    const plain = renderWith({ managementOpen: true, managementTab: 'buildings', management: session.management.snapshot(), buildings, noPathAccessIds: [] }, <ManagementDashboard />);
    expect(plain).not.toContain('no-access');
    expect(plain).not.toContain('no path access');
  });
});
