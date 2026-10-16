import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { SCENARIO_BY_ID } from '../scenarios/content';
import { hashState } from '../save/hash';
import { createWeatherView } from '../weather/types';
import { ParkSession } from './ParkSession';

/** A street and rides on both sides: one open-air ride (Comet Cups) and, optionally, a covered one. */
const buildPark = (options: { covered: boolean; openAir: boolean } = { covered: true, openAir: true }): ParkSession => {
  const session = new ParkSession(null);
  // Open-air rides are research unlocks; this test is about weather, not the research tree.
  session.world.setBuildAccessPolicy(null);
  const street = [];
  for (let y = 31; y >= 22; y -= 1) street.push({ x: 15, y });
  session.world.buildPaths(street);
  if (options.openAir) session.world.buildObject('comet-cups', { x: 12, y: 26 });
  if (options.covered) session.world.buildObject('petal-roundabout', { x: 16, y: 26 });
  session.syncWithWorld();
  return session;
};

const run = (session: ParkSession, ticks: number): void => {
  for (let tick = 0; tick < ticks; tick += 1) session.step(100);
};

const tickOfHour = (hour: number): number => Math.round(((hour - GAME_CONFIG.calendar.startHour) / 24) * 7_200);

describe('opening hours inside a park', () => {
  it('hold the gate shut until the open hour, then arrivals follow the curve', () => {
    const session = buildPark();
    session.setWeatherEnabled(false);
    expect(session.setOpeningHours(true, 8, 21)).toBe(true);
    run(session, tickOfHour(8) - 5);
    expect(session.guests.totalArrivals, 'nobody arrives before 08:00').toBe(0);
    expect(session.world.parkOpen, 'the manual switch is untouched').toBe(true);
    expect(session.world.gateOpen).toBe(false);
    run(session, 200);
    expect(session.world.gateOpen).toBe(true);
    expect(session.guests.totalArrivals).toBeGreaterThan(0);
  });

  it('send guests home at closing time ("The park is closing.") and keep the gate shut at night', () => {
    const session = buildPark();
    session.setWeatherEnabled(false);
    session.setOpeningHours(true, 8, 21);
    run(session, tickOfHour(21) - 20);
    expect(session.guests.guests.size).toBeGreaterThan(5);
    run(session, 60);
    expect(session.world.gateOpen).toBe(false);
    const arrivalsAtClose = session.guests.totalArrivals;
    const thoughts = [...session.guests.guests.values()].map((guest) => guest.currentThought);
    expect(thoughts.some((thought) => thought === 'The park is closing.')).toBe(true);
    run(session, 600);
    expect(session.guests.totalArrivals, 'no arrivals at night').toBe(arrivalsAtClose);
    expect(session.guests.guests.size, 'the park empties').toBeLessThan(3);
  });

  it('are on the raw clock: a pinned look never moves the gate', () => {
    const session = buildPark();
    session.setWeatherEnabled(false);
    session.calendar.setTimeLock('noon');
    session.setOpeningHours(true, 8, 21);
    run(session, 20);
    expect(session.calendarView().clockHour).toBe(6);
    expect(session.world.gateOpen, 'it is 06:00 on the raw clock').toBe(false);
  });

  it('the manual park switch still wins during open hours', () => {
    const session = buildPark();
    session.setOpeningHours(true, 6, 23);
    run(session, 10);
    expect(session.world.gateOpen).toBe(true);
    session.world.setParkOpen(false);
    expect(session.world.gateOpen).toBe(false);
  });

  it('are refused outside the configured ranges and in a scenario park', () => {
    const session = buildPark();
    expect(session.setOpeningHours(true, 4, 21)).toBe(false);
    expect(session.setOpeningHours(true, 8, 24)).toBe(false);
    expect(session.setOpeningHours(true, 12, 15)).toBe(false);
    expect(session.setOpeningHours(true, 8.5, 21)).toBe(false);
    expect(session.calendar.hoursEnabled).toBe(false);
    expect(new ParkSession(SCENARIO_BY_ID.get('penny-lane')!).setOpeningHours(true, 8, 21)).toBe(false);
  });

  it('with hours off the park keeps a thin night arrival floor above zero', () => {
    const session = buildPark();
    session.setWeatherEnabled(false);
    run(session, tickOfHour(24) - 50);
    const before = session.guests.totalArrivals;
    run(session, 1_200);
    expect(session.guests.totalArrivals, 'between 00:00 and 04:00').toBeGreaterThan(before);
  });
});

describe('storms inside a park', () => {
  it('pause arrivals while every available ride is storm-closed, and not while a covered ride runs', () => {
    const openAirOnly = buildPark({ covered: false, openAir: true });
    run(openAirOnly, 300);
    expect(openAirOnly.guests.totalArrivals).toBeGreaterThan(0);
    openAirOnly.weather.forceCurrentSlot('storm', 1);
    const before = openAirOnly.guests.totalArrivals;
    run(openAirOnly, 600);
    expect(openAirOnly.guests.totalArrivals, 'nothing is running, nobody comes').toBe(before);

    const withCovered = buildPark();
    run(withCovered, 100);
    withCovered.weather.forceCurrentSlot('storm', 1);
    const arrivals = withCovered.guests.totalArrivals;
    run(withCovered, 600);
    expect(withCovered.guests.totalArrivals).toBeGreaterThan(arrivals);
  });

  it('the open ride count excludes storm-closed rides but the rating does not change for it', () => {
    const session = buildPark();
    run(session, 50);
    session.refreshManagement();
    const calm = session.management.snapshot();
    expect(calm.operations.rides).toMatchObject({ open: 2, total: 2 });
    session.weather.forceCurrentSlot('storm', 1);
    session.refreshManagement();
    const instant = session.management.snapshot();
    expect(instant.operations.rides.open).toBe(1);
    expect(instant.rating.score, 'a storm never dents the rating: reliability counts the ride as open').toBe(calm.rating.score);
    run(session, 1);
    session.refreshManagement();
    const storm = session.management.snapshot();
    expect(storm.operations.rides).toMatchObject({ open: 1, total: 2 });
    expect(session.rides.stormClosedCount()).toBe(1);
    const rows = session.buildingsSnapshot().filter((row) => row.group === 'ride');
    expect(rows.filter((row) => row.status === 'closed')).toHaveLength(1);
    expect(rows.filter((row) => row.status !== 'closed')).toHaveLength(1);
  });

  it('end by themselves: the ride reopens when the storm slot passes', () => {
    const session = buildPark();
    session.weather.forceCurrentSlot('storm', 1);
    run(session, 2);
    const cups = [...session.rides.rides.values()].find((ride) => session.world.objects.get(ride.objectId)!.definitionId === 'comet-cups')!;
    expect(cups.status).toBe('closed');
    session.weather.forceCurrentSlot('cloudy', 0.5);
    run(session, 2);
    expect(cups.status).not.toBe('closed');
    expect(cups.open).toBe(true);
  });

  it('switching weather off in the Sandbox mid-storm reopens at once', () => {
    const session = buildPark();
    session.weather.forceCurrentSlot('storm', 1);
    run(session, 2);
    expect(session.rides.stormClosedCount()).toBe(1);
    session.setWeatherEnabled(false);
    expect(session.rides.stormClosedCount()).toBe(0);
    run(session, 2);
    expect(session.rides.stormClosedCount()).toBe(0);
  });
});

describe('weather in the saved state', () => {
  it('round trips with a storm active and continues exactly like the unsaved run', () => {
    const session = buildPark();
    session.guests.spawnGuests(30);
    run(session, 200);
    session.weather.forceCurrentSlot('storm', 0.9);
    run(session, 100);
    session.setWeatherSeverity('high');
    const state = JSON.parse(JSON.stringify(session.serialize())) as ReturnType<ParkSession['serialize']>;
    const loaded = ParkSession.fromState(state);
    expect(hashState(loaded.serialize())).toBe(hashState(session.serialize()));
    expect(loaded.weather.conditions).toEqual(session.weather.conditions);
    expect(loaded.rides.stormClosedCount()).toBe(session.rides.stormClosedCount());
    run(session, 400);
    run(loaded, 400);
    expect(hashState(loaded.serialize())).toBe(hashState(session.serialize()));
  });

  it('is part of the hash: the weather days, the switches and the stream all change it', () => {
    const base = buildPark();
    const hash = (session: ParkSession): string => hashState(session.serialize());
    const reference = hash(base);
    const switched = buildPark();
    switched.setWeatherSeverity('low');
    expect(hash(switched)).not.toBe(reference);
    const forced = buildPark();
    forced.weather.forceCurrentSlot('storm', 0.5);
    expect(hash(forced)).not.toBe(reference);
    expect(hash(buildPark())).toBe(reference);
  });

  it('a long run past several days restores exactly (days drawn, trimmed and saved)', () => {
    const session = buildPark();
    run(session, 7_200 * 3 + 500);
    const view = session.weatherViewInto(createWeatherView());
    expect(view.day).toBe(4);
    const loaded = ParkSession.fromState(JSON.parse(JSON.stringify(session.serialize())) as ReturnType<ParkSession['serialize']>);
    expect(loaded.weather.serialize()).toEqual(session.weather.serialize());
    expect(loaded.weatherForecast()).toEqual(session.weatherForecast());
  });

  it('a sandbox park with the same seed always has the same weather, a scenario its own', () => {
    expect(new ParkSession(null).weather.serialize()).toEqual(new ParkSession(null).weather.serialize());
    const gala = new ParkSession(SCENARIO_BY_ID.get('garden-gala')!).weather.serialize();
    expect(gala).not.toEqual(new ParkSession(null).weather.serialize());
    expect(gala.rngState).not.toBe(new ParkSession(SCENARIO_BY_ID.get('penny-lane')!).weather.serialize().rngState);
  });
});

describe('undo and settings', () => {
  it('rewinds the drawn weather with the park and keeps the settings chosen after the snapshot', () => {
    const live = buildPark();
    run(live, 50);
    const snapshot = JSON.parse(JSON.stringify(live.serialize())) as ReturnType<ParkSession['serialize']>;
    const drawnThen = JSON.stringify(live.weather.serialize().days);
    run(live, 7_200 * 2);
    expect(JSON.stringify(live.weather.serialize().days)).not.toBe(drawnThen);
    live.setWeatherSeverity('high');
    live.setOpeningHours(true, 6, 23);
    live.calendar.setTimeLock('dusk');
    const rewound = ParkSession.fromState(snapshot);
    rewound.adoptSettings(live.settings());
    expect(rewound.world.tick).toBe(50);
    expect(JSON.stringify(rewound.weather.serialize().days), 'the forecast the player saw is back').toBe(drawnThen);
    expect(rewound.weather.rngStateForTest()).toBe(JSON.parse(JSON.stringify(snapshot.weather)).rngState);
    expect(rewound.weather.severity).toBe('high');
    expect(rewound.calendar).toMatchObject({ hoursEnabled: true, openHour: 6, closeHour: 23, timeLock: 'dusk' });
  });

  it('a scenario park adopts nothing', () => {
    const scenario = new ParkSession(SCENARIO_BY_ID.get('sunny-start')!);
    const sandbox = buildPark();
    sandbox.setWeatherSeverity('high');
    sandbox.setWeatherEnabled(false);
    sandbox.setOpeningHours(true, 8, 21);
    sandbox.calendar.setDayLength(360);
    const before = JSON.stringify(scenario.serialize());
    scenario.adoptSettings(sandbox.settings());
    expect(JSON.stringify(scenario.serialize())).toBe(before);
  });
});
