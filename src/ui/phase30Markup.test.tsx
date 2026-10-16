import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { GuestSnapshot, ThoughtInsight } from '../game/guests/types';
import { GAME_CONFIG } from '../game/config';
import { BUILD_BY_ID } from '../game/content/catalog';
import { ParkSession } from '../game/session/ParkSession';
import { BuildDock, GuestInspector, INTENSE_RIDE_NOTE, ParkPulse, PULSE_LINE_BUDGET, RideInspector, ServiceInspector, Toast, TOAST_GLYPHS } from './Hud';
import { CAPACITY_INSIGHT } from './capacityModel';
import { rideBandOf } from './buildFilterModel';
import { DEFAULT_WEATHER_UI } from './weatherModel';
import { useUiStore } from './store';

/**
 * Phase 30: the HUD markup for guest life readability and the complaint links. No DOM: the markup is rendered on the
 * server from a patched initial store (the phase16Markup pattern). What is pinned: the souvenir stall's words and its
 * "Demand now" line; Park Pulse's three-line budget, its reserved thought slot, the "→ building" link and the card's
 * structure (no button inside a button); every ride's band line; the guest inspector; the toast glyph per class.
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

/** A fresh park with one object of `definitionId` at the first cell that takes it. */
const parkWith = (definitionId: string): { session: ParkSession; objectId: number } => {
  const session = new ParkSession(null);
  session.world.addMoney(200_000);
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

const insight = (text: string, count: number, objectId: number | null = null, objectName: string | null = null): ThoughtInsight => ({ text, count, objectId, objectName });

const GUEST: GuestSnapshot = {
  id: 42,
  state: 'queueing',
  doing: 'Queueing for Moonpetal Carousel',
  thought: 'This queue is taking forever.',
  thoughtObjectId: 7,
  thoughtObjectName: 'Moonpetal Carousel',
  destinationObjectId: 7,
  destinationName: 'Moonpetal Carousel',
  happiness: 61.4,
  money: 48,
  hunger: 30,
  thirst: 55.6,
  toiletNeed: 12,
  energy: 44,
  nausea: 60,
  warmth: 81,
  likes: 'family',
  souvenirs: ['Umbrella', 'Balloon'],
  tired: true,
  queasy: true,
  hot: true,
  cold: false,
  soaked: false,
  position: { x: 10.5, y: 12 },
  ageSeconds: 754,
};

describe('item 1: the souvenir stall inspector', () => {
  it('says SOUVENIR STALL / Souvenir stall (header and aria-label), labels the type and adds the Demand now line', () => {
    const { session, objectId } = parkWith('brolly-booth');
    const service = session.shops.snapshot(objectId)!;
    expect(service.kind).toBe('souvenir');
    const html = renderWith({ selectedService: service, weatherUi: { ...DEFAULT_WEATHER_UI, sellingSouvenirs: ['balloon', 'plush'] } }, <ServiceInspector />);
    expect(html).toContain(`aria-label="Souvenir stall inspector: ${service.name}"`);
    expect(html).toContain('<small>SOUVENIR STALL</small>');
    expect(html).not.toContain('DRINK STALL');
    expect(html).toContain('<div><dt>Service type</dt><dd>Souvenirs</dd></div><div><dt>Demand now</dt><dd>Umbrellas sell in the rain · dry now</dd></div>');
    const raining = renderWith({ selectedService: service, weatherUi: { ...DEFAULT_WEATHER_UI, sellingSouvenirs: ['umbrella', 'balloon', 'plush'] } }, <ServiceInspector />);
    expect(raining).toContain('<dd>Umbrellas sell in the rain · selling now</dd>');
  });

  it('the other kinds keep their words and get the type label; no Demand now line', () => {
    const drink = parkWith('fizz-foundry');
    const drinkHtml = renderWith({ selectedService: drink.session.shops.snapshot(drink.objectId)! }, <ServiceInspector />);
    expect(drinkHtml).toContain('<small>DRINK STALL</small>');
    expect(drinkHtml).toContain('<div><dt>Service type</dt><dd>Drinks</dd></div>');
    expect(drinkHtml).not.toContain('Demand now');
    const food = parkWith('picnic-pocket');
    const foodHtml = renderWith({ selectedService: food.session.shops.snapshot(food.objectId)! }, <ServiceInspector />);
    expect(foodHtml).toContain('<small>FOOD STALL</small>');
    expect(foodHtml).toContain('<dd>Food</dd>');
  });
});

describe('item 2: Park Pulse', () => {
  const insights = (html: string): string => html.slice(html.indexOf('<div class="pulse-insights">'), html.indexOf('</div>', html.indexOf('<div class="pulse-insights">')) + 6);
  const VIEW = { ceiling: 52, rideSeats: 38, rating: 61, crowdMultiplier: 1, hardMaximum: 1000, blocked: null };

  it('is a card of three siblings: the launcher button, the lines, the small report button; no button nests another', () => {
    const html = renderWith({ pulseInsights: [insight('guests are frustrated by a long queue.', 3, 7, 'Moonpetal Carousel')] }, <ParkPulse />);
    const open = html.indexOf('<button class="pulse-launcher"');
    const launcher = html.slice(html.indexOf('>', open) + 1, html.indexOf('</button>', open));
    expect(launcher).toContain('<div class="pulse-title">');
    expect(launcher).toContain('<div class="pulse-stats">');
    expect(launcher).not.toContain('pulse-insights');
    expect(launcher).not.toContain('<button');
    expect(html).toMatch(/<\/button><div class="pulse-insights">/);
    expect(html).toMatch(/<\/div><button class="pulse-open-report"[^>]*>Open management report <span aria-hidden="true">→<\/span><\/button>/);
    // The dashboard's focus return looks for `.pulse-launcher`, which the launcher keeps.
    expect(count(html, /class="pulse-launcher"/g)).toBe(1);
  });

  it('a complaint with a building renders "→ name" as a button that names the building; one without renders as before', () => {
    const html = renderWith({ pulseInsights: [insight('guests are frustrated by a long queue.', 3, 7, 'Moonpetal Carousel'), insight('guests are hungry', 2)] }, <ParkPulse />);
    expect(insights(html)).toContain('<p><span aria-hidden="true">✦</span><strong>3</strong> <span class="pulse-copy">guests are frustrated by a long queue. <button type="button" class="pulse-link" title="Show Moonpetal Carousel and open its inspector" aria-label="Show Moonpetal Carousel"><span aria-hidden="true">→ </span>Moonpetal Carousel</button></span></p>');
    expect(insights(html)).toContain('<p><span aria-hidden="true">✦</span><strong>2</strong> guests are hungry</p>');
    // Gone building: the simulation gives null for both fields and no link renders.
    const gone = renderWith({ pulseInsights: [insight('guests are frustrated by a long queue.', 3, null, null)] }, <ParkPulse />);
    expect(gone).not.toContain('pulse-link');
  });

  it('three-line budget: weather + capacity + one thought, and a thought slot is kept whenever a thought exists', () => {
    expect(PULSE_LINE_BUDGET).toBe(3);
    const rain = { ...DEFAULT_WEATHER_UI, weatherKind: 'rain' as const, arrivalDeltaPercent: -30 };
    const thoughts = [insight('guests want a drink', 4), insight('guests are hungry', 2)];
    const html = renderWith({ weatherUi: rain, guestCount: 52, guestCapacity: VIEW, atCapacity: true, pulseInsights: thoughts }, <ParkPulse />);
    const lines = insights(html);
    expect(count(lines, /<p/g)).toBe(3);
    expect(lines).toMatch(/^<div class="pulse-insights"><p class="pulse-weather">.*<p class="pulse-capacity">.*<\/p><p><span aria-hidden="true">✦<\/span><strong>4<\/strong> guests want a drink<\/p><\/div>$/);
    expect(lines).not.toContain('guests are hungry');
    // Hours + weather + capacity would fill all three: the thought keeps its slot and capacity waits.
    const closed = { ...rain, hoursEnabled: true, scheduleOpen: false };
    const full = insights(renderWith({ weatherUi: closed, guestCount: 52, guestCapacity: VIEW, atCapacity: true, pulseInsights: thoughts }, <ParkPulse />));
    expect(count(full, /<p/g)).toBe(3);
    expect(count(full, /pulse-weather/g)).toBe(2);
    expect(full).not.toContain(CAPACITY_INSIGHT);
    expect(full).toContain('guests want a drink');
    // With no thought at all the other lines may use the third slot.
    const none = insights(renderWith({ weatherUi: closed, guestCount: 52, guestCapacity: VIEW, atCapacity: true, pulseInsights: [] }, <ParkPulse />));
    expect(count(none, /<p/g)).toBe(3);
    expect(none).toContain(CAPACITY_INSIGHT);
  });

  it('the climate line is no longer a Pulse line (it stays in the clock popover)', () => {
    const winter = { ...DEFAULT_WEATHER_UI, biomeId: 'winter' as const, climate: 'cold' as const, climateLabel: 'Cold', weatherEnabled: false };
    const html = renderWith({ weatherUi: winter, pulseInsights: [insight('guests are hungry', 2)] }, <ParkPulse />);
    expect(html).not.toContain('Cold climate');
    expect(html).toContain('guests are hungry');
  });
});

describe('item 3: every ride says its band and numbers', () => {
  it('a gentle ride: band tag, Excitement · Intensity, no intense note', () => {
    const { session, objectId } = parkWith('moonpetal-carousel');
    const ride = session.rides.snapshot(objectId)!;
    const band = rideBandOf(BUILD_BY_ID.get(ride.definitionId)!)!;
    const html = renderWith({ selectedRide: ride }, <RideInspector />);
    expect(html).toMatch(new RegExp(`<p class="ride-band-line"><em class="build-intensity-tag ${band}">[A-Za-z]+</em><span>Excitement ${Math.round(ride.excitement)} · Intensity ${Math.round(ride.intensity)}</span></p>`));
    expect(ride.intensity).toBeLessThanOrEqual(GAME_CONFIG.guestLife.nausea.minimumIntensity);
    expect(html).not.toContain(INTENSE_RIDE_NOTE);
    // The band line sits under the state row (and the path note), before the price control.
    expect(html.indexOf('ride-band-line')).toBeGreaterThan(html.indexOf('ride-state-row'));
    expect(html.indexOf('ride-band-line')).toBeLessThan(html.indexOf('price-control'));
  });

  it('an intense ride adds the queasy note', () => {
    // The first ride above the nausea floor a fresh park accepts (some are research-locked at the start).
    const candidates = [...BUILD_BY_ID.values()].filter((definition) => definition.kind === 'ride' && !definition.custom && (definition.stats?.intensity ?? 0) > GAME_CONFIG.guestLife.nausea.minimumIntensity);
    expect(candidates.length, 'the catalog has rides above the nausea floor').toBeGreaterThan(0);
    const built = candidates.flatMap((definition) => { try { return [{ definition, ...parkWith(definition.id) }]; } catch { return []; } })[0];
    expect(built, 'one of them builds in a fresh park').toBeDefined();
    const ride = built!.session.rides.snapshot(built!.objectId)!;
    const html = renderWith({ selectedRide: ride }, <RideInspector />);
    expect(html).toContain(`<b class="ride-intense-note">${INTENSE_RIDE_NOTE}</b></p>`);
    expect(html).toContain(`<em class="build-intensity-tag ${rideBandOf(built!.definition)}">`);
  });
});

describe('item 4: the guest inspector', () => {
  it('renders nothing with no guest and the whole card with one', () => {
    expect(renderWith({ selectedGuest: null }, <GuestInspector />)).toBe('');
    const html = renderWith({ selectedGuest: GUEST }, <GuestInspector />);
    expect(html).toMatch(/^<aside class="ride-inspector guest-inspector" aria-label="Guest inspector: Guest #42">/);
    expect(html).toContain('<small>GUEST</small><strong role="heading" aria-level="2">Guest #42</strong>');
    expect(html).toContain('<button title="Close inspector (Esc)" aria-label="Close inspector"><span aria-hidden="true">×</span></button>');
    expect(html).toContain('<p class="guest-doing"><span aria-hidden="true">⌖</span>Queueing for Moonpetal Carousel</p>');
    // The thought, with the complaint link that calls focusBuilding.
    expect(html).toContain('<p class="guest-thought"><q>This queue is taking forever.</q><button type="button" class="inspector-link" title="Show Moonpetal Carousel and open its inspector" aria-label="Show Moonpetal Carousel"><span aria-hidden="true">→ </span>Moonpetal Carousel</button></p>');
    // The needs grid, rounded, with the warmth word.
    expect(html).toContain('<div class="ride-metrics guest-needs"><span><small>HAPPINESS</small><strong>61%</strong></span><span><small>MONEY</small><strong>$48.00</strong></span><span><small>HUNGER</small><strong>30%</strong></span><span><small>THIRST</small><strong>56%</strong></span><span><small>TOILET</small><strong>12%</strong></span><span><small>ENERGY</small><strong>44%</strong></span><span><small>NAUSEA</small><strong>60%</strong></span><span><small>WARMTH</small><strong>81<em> hot</em></strong></span></div>');
    // Flags in order, only the true ones.
    expect(html).toContain('<ul class="guest-flags" aria-label="Comfort"><li class="tired">Tired</li><li class="queasy">Queasy</li><li class="hot">Too hot</li></ul>');
    expect(html).not.toContain('Soaked');
    // Likes band, souvenirs, destination, time in the park.
    expect(html).toContain('<div><dt>Likes</dt><dd><em class="build-intensity-tag family">Family</em><span class="sr-only"> Likes family rides</span></dd></div>');
    expect(html).toContain('<div><dt>Souvenirs</dt><dd>Umbrella, Balloon</dd></div>');
    expect(html).toContain('<div><dt>Heading for</dt><dd>Moonpetal Carousel</dd></div>');
    expect(html).toContain('<div><dt>In the park</dt><dd>12 min</dd></div>');
    // No demolish control, no price control: a guest is not a building.
    expect(html).not.toContain('inspector-demolish');
    expect(html).not.toContain('price-control');
  });

  it('a content guest: no link, only the cold chip, cold word, no souvenirs, seconds under a minute', () => {
    const calm: GuestSnapshot = {
      ...GUEST, thought: 'What a lovely park!', thoughtObjectId: null, thoughtObjectName: null, destinationObjectId: null, destinationName: null,
      tired: false, queasy: false, hot: false, cold: true, souvenirs: [], likes: 'thrill', ageSeconds: 42.9, warmth: 18,
    };
    const html = renderWith({ selectedGuest: calm }, <GuestInspector />);
    expect(html).toContain('<p class="guest-thought"><q>What a lovely park!</q></p>');
    expect(html).not.toContain('inspector-link');
    expect(html).toContain('<ul class="guest-flags" aria-label="Comfort"><li class="cold">Cold</li></ul>');
    expect(html).toContain('<strong>18<em> cold</em></strong>');
    const content = renderWith({ selectedGuest: { ...calm, cold: false, warmth: 50 } }, <GuestInspector />);
    expect(content).not.toContain('guest-flags');
    expect(content).toContain('<strong>50<em> comfortable</em></strong>');
    expect(html).toContain('<dd>None</dd>');
    expect(html).toContain('<dd>—</dd>');
    expect(html).toContain('<dd>42 s</dd>');
    expect(html).toContain('<em class="build-intensity-tag thrill">Thrill</em>');
  });

  it('money reads as dollars and cents whatever the locale (review fix)', () => {
    expect(renderWith({ selectedGuest: { ...GUEST, money: 47.5 } }, <GuestInspector />)).toContain('<small>MONEY</small><strong>$47.50</strong>');
    expect(renderWith({ selectedGuest: { ...GUEST, money: 1234.5 } }, <GuestInspector />)).toContain('<small>MONEY</small><strong>$1234.50</strong>');
  });

  it('beside Park Pulse under the same rule as the other inspectors; the dock counts it as an open inspector', () => {
    const onboarding = { steps: [{ id: 'first-path', title: 'Lay a path', detail: '', target: 3, progress: 0, completed: false, skipped: false }], currentStepId: 'first-path', dismissed: false, completed: false, rewardGranted: false } as unknown as Patch['onboarding'];
    const html = renderWith({ selectedGuest: GUEST, onboarding }, <GuestInspector />);
    expect(html).toMatch(/^<aside class="ride-inspector guest-inspector beside-pulse"/);
    expect(renderWith({ tool: 'pointer', selectedDefinitionId: null }, <BuildDock />)).toContain('Select — click a ride, stall or guest to inspect it');
  });
});

describe('item 5: the toast glyph per class', () => {
  it('carries the class and shows "!" for an alert, the tick for the rest', () => {
    expect(TOAST_GLYPHS).toEqual({ routine: '✓', important: '✓', alert: '!' });
    expect(renderWith({ toast: 'Not enough cash', toastClass: 'alert', toastSeq: 1 }, <Toast />)).toContain('<div class="toast alert" aria-hidden="true"><span>!</span>Not enough cash</div>');
    expect(renderWith({ toast: 'Saved', toastClass: 'routine', toastSeq: 1 }, <Toast />)).toContain('<div class="toast routine" aria-hidden="true"><span>✓</span>Saved</div>');
    expect(renderWith({ toast: 'Milestone reached', toastClass: 'important', toastSeq: 1 }, <Toast />)).toContain('<div class="toast important" aria-hidden="true"><span>✓</span>Milestone reached</div>');
    expect(renderWith({ toast: null }, <Toast />)).not.toContain('class="toast');
  });
});
