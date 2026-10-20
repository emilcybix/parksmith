import { describe, expect, it } from 'vitest';
import { GAME_CONFIG } from '../config';
import { INITIAL_CLEANER_LOAD, stepCleanerLoad } from '../../app/cleanerLoad';
import { ParkSession } from '../session/ParkSession';
import type { Cell } from '../types';

/**
 * Phase 49 measurement: litter made against what a full cleaner crew clears, at 250, 500 and 1,000 guests, with no
 * bins, one bin per path row and a bin beside every fourth path tile. Off by default (a minute of wall clock);
 * `LITTER_REPORT=1 yarn vitest run src/game/balance/litterThroughput.review.test.ts` prints the table recorded in
 * BALANCE_NOTES.md ("Phase 49: litter against cleaners").
 */
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const enabled = env.LITTER_REPORT === '1';
const MINUTES = Number(env.LITTER_MINUTES ?? '10');

type BinPlan = 'none' | 'few' | 'dense';

const buildPark = (bins: BinPlan): ParkSession => {
  const session = new ParkSession(null);
  const world = session.world;
  world.addMoney(500_000, 'litter measurement funding');
  const paths: Cell[] = [];
  for (let y = 30; y >= 6; y -= 4) {
    for (let x = 1; x <= 30; x += 1) paths.push({ x, y });
  }
  for (let y = 30; y >= 7; y -= 1) paths.push({ x: 15, y });
  world.buildPaths(paths);
  const rideAnchors = [
    { x: 2, y: 27 }, { x: 6, y: 27 }, { x: 10, y: 27 }, { x: 20, y: 27 }, { x: 24, y: 27 },
    { x: 2, y: 23 }, { x: 6, y: 23 }, { x: 20, y: 23 }, { x: 24, y: 23 }, { x: 28, y: 23 },
  ];
  for (const anchor of rideAnchors) world.buildObject('petal-roundabout', anchor);
  // Food, drink and toilets on the three rows between the path rows 18, 14, 10 and 6 (2x2 stalls at y 16, 12 and 8).
  const stalls = ['picnic-pocket', 'fizz-foundry', 'picnic-pocket', 'fizz-foundry', 'comfort-cabin'];
  let built = 0;
  for (const y of [16, 12, 8]) {
    for (const [index, x] of [2, 5, 8, 11, 18, 21, 24, 27].entries()) {
      if (world.buildObject(stalls[index % stalls.length], { x, y })) built += 1;
    }
  }
  if (built < 24) throw new Error(`only ${built} of 24 stalls fit`);
  if (bins === 'few') {
    // One bin per path row, at the spine.
    for (let y = 30; y >= 6; y -= 4) {
      if (!world.buildObject('tidy-totem', { x: 14, y: y - 1 })) world.buildObject('tidy-totem', { x: 16, y: y - 1 });
    }
  }
  if (bins === 'dense') {
    // A bin on free ground beside every fourth tile of every row, wherever it fits.
    for (let y = 30; y >= 6; y -= 4) {
      for (let x = 1; x <= 30; x += 4) {
        if (!world.buildObject('tidy-totem', { x, y: y - 1 })) world.buildObject('tidy-totem', { x, y: y + 1 });
      }
    }
  }
  return session;
};

interface Row {
  guests: number;
  bins: BinPlan;
  binCount: number;
  cleaners: number;
  wastePerMinute: number;
  intoBinsPerMinute: number;
  sickUnitsPerMinute: number;
  groundUnitsPerMinute: number;
  clearedUnitsPerMinute: number;
  standingStart: number;
  standingEnd: number;
  busyShare: number;
  /** Ticks of the measured window the Pulse's cleaner load called the crew swamped, as a share. */
  swampedShare: number;
  cleanliness: number;
}

const measure = (target: number, bins: BinPlan): Row => {
  const session = buildPark(bins);
  const operations = session.operations;
  let sick = 0;
  const drainSick = session.guests.drainSickCells.bind(session.guests);
  session.guests.drainSickCells = () => {
    const cells = drainSick();
    sick += cells.length * GAME_CONFIG.operations.litter.sickUnits;
    return cells;
  };
  const standing = (): number => [...operations.litter.values()].reduce((total, pile) => total + pile.units, 0);
  const topUp = (): void => {
    if (session.guests.guests.size < target) session.guests.spawnGuests(target - session.guests.guests.size);
  };
  const crew = (): { cleaners: number; busy: number } => {
    let cleaners = 0;
    let busy = 0;
    for (const worker of operations.staff.values()) {
      if (worker.role !== 'cleaner') continue;
      cleaners += 1;
      if (worker.task) busy += 1;
    }
    return { cleaners, busy };
  };
  // Fill the park, let the staff room grow with the crowd, then hire every cleaner the cap allows.
  topUp();
  for (let tick = 0; tick < 10; tick += 1) session.step(100);
  while (operations.hireStaff('cleaner')) { /* to the cap */ }
  for (let i = 0; i < 4; i += 1) operations.hireStaff('mechanic');
  // Warm-up: two simulated minutes, so guests are hungry and the crew has spread out.
  let load = INITIAL_CLEANER_LOAD;
  for (let tick = 0; tick < 1_200; tick += 1) {
    if (tick % 10 === 0) topUp();
    session.step(100);
    // The app samples at 4 Hz; every 2.5 ticks at 1x, so every other tick here is close enough.
    if (tick % 2 === 0) load = stepCleanerLoad(load, { tick: session.world.tick, tally: operations.wasteTally(), ...crew() }).state;
  }
  sick = 0;
  const before = operations.wasteTally();
  const standingStart = standing();
  let busy = 0;
  let samples = 0;
  let swamped = 0;
  let loadSamples = 0;
  for (let tick = 0; tick < MINUTES * 600; tick += 1) {
    if (tick % 10 === 0) topUp();
    session.step(100);
    const now = crew();
    busy += now.busy;
    samples += now.cleaners;
    if (tick % 2 === 0) {
      const step = stepCleanerLoad(load, { tick: session.world.tick, tally: operations.wasteTally(), ...now });
      load = step.state;
      loadSamples += 1;
      if (step.load.swamped) swamped += 1;
    }
  }
  const after = operations.wasteTally();
  const perMinute = (value: number): number => Math.round(value / MINUTES * 10) / 10;
  return {
    guests: target,
    bins,
    binCount: operations.bins.size,
    cleaners: crew().cleaners,
    wastePerMinute: perMinute(after.made - before.made),
    intoBinsPerMinute: perMinute(after.binned - before.binned),
    sickUnitsPerMinute: perMinute(sick),
    groundUnitsPerMinute: perMinute(after.dropped - before.dropped),
    clearedUnitsPerMinute: perMinute(after.cleared - before.cleared),
    standingStart,
    standingEnd: standing(),
    busyShare: Math.round(busy / Math.max(1, samples) * 100),
    swampedShare: Math.round(swamped / Math.max(1, loadSamples) * 100),
    cleanliness: operations.snapshot().cleanliness.score,
  };
};

describe.skipIf(!enabled)('Phase 49: litter against cleaners', () => {
  it('prints litter made against litter cleared', () => {
    const rows: Row[] = [];
    for (const guests of [250, 500, 1_000]) {
      for (const bins of ['none', 'few', 'dense'] as const) rows.push(measure(guests, bins));
    }
    const header = '| guests | bins | cleaners | waste/min | into bins/min | sick units/min | onto paths/min | swept/min | standing (start -> end) | cleaners busy | swamped | cleanliness |';
    console.log([
      header,
      header.replace(/[^|]/g, '-'),
      ...rows.map((row) => `| ${row.guests} | ${row.bins} (${row.binCount}) | ${row.cleaners} | ${row.wastePerMinute} | ${row.intoBinsPerMinute} | ${row.sickUnitsPerMinute} | ${row.groundUnitsPerMinute} | ${row.clearedUnitsPerMinute} | ${row.standingStart} -> ${row.standingEnd} | ${row.busyShare}% | ${row.swampedShare}% | ${row.cleanliness} |`),
    ].join('\n'));
    expect(rows).toHaveLength(9);
  }, 600_000);
});
